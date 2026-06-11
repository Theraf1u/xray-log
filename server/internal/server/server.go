package server

import (
	"context"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/xray-log-analyzer/server/internal/aleria"
	"github.com/xray-log-analyzer/server/internal/analyzer"
	"github.com/xray-log-analyzer/server/internal/blacklist"
	"github.com/xray-log-analyzer/server/internal/correlation"
	"github.com/xray-log-analyzer/server/internal/ipinfo"
	"github.com/xray-log-analyzer/server/internal/rediscache"
	"github.com/xray-log-analyzer/server/internal/remnawave"
	"github.com/xray-log-analyzer/server/internal/storage"
	"github.com/xray-log-analyzer/server/internal/storage/partitions"
	"github.com/xray-log-analyzer/server/internal/threatintel"
)

// Server handles WebSocket connections from agents and HTTP API
type Server struct {
	addr           string
	allowedOrigins []string
	apiToken       string // Bearer token for API/dashboard (empty = no auth)
	agentToken     string // Token for agent WebSocket (empty = no auth)
	analyzer       *analyzer.Analyzer
	storage        *storage.Storage
	blacklist      *blacklist.Blacklist
	threatIntel    *threatintel.Service
	remnawave      *remnawave.SyncService
	correlation    *correlation.Service
	ipInfo         *ipinfo.Service
	aleria         *aleria.Service
	redis          *rediscache.Client
	cacheTTL       time.Duration
	apiLimiter     *rateLimiter
	aiLimiter      *rateLimiter
	pm             *partitions.Manager
	clients        map[string]*Client
	clientsMu      sync.RWMutex

	// Dashboard WebSocket clients
	dashboardClients   map[*DashboardClient]bool
	dashboardClientsMu sync.RWMutex
	broadcastChan      chan *DashboardUpdate
}

// DashboardClient wraps websocket connection with mutex for thread-safe writes
type DashboardClient struct {
	Conn *websocket.Conn
	mu   sync.Mutex
}

// WriteJSON writes JSON to websocket with mutex protection
func (c *DashboardClient) WriteJSON(v interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Conn.WriteJSON(v)
}

// Client represents a connected agent
type Client struct {
	NodeID      string
	Conn        *websocket.Conn
	ConnectedAt time.Time
	LastBatch   time.Time
	mu          sync.Mutex
}

// DashboardUpdate represents an update to send to dashboard clients
type DashboardUpdate struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// New creates a new Server
func New(addr string, allowedOrigins []string, apiToken, agentToken string, analyzer *analyzer.Analyzer, storage *storage.Storage, bl *blacklist.Blacklist) *Server {
	s := &Server{
		addr:             addr,
		allowedOrigins:   allowedOrigins,
		apiToken:         apiToken,
		agentToken:       agentToken,
		analyzer:         analyzer,
		storage:          storage,
		blacklist:        bl,
		ipInfo:           ipinfo.NewService(),
		clients:          make(map[string]*Client),
		dashboardClients: make(map[*DashboardClient]bool),
		broadcastChan:    make(chan *DashboardUpdate, 100),
		// API: generous per-IP bucket (dashboard fans out to many endpoints on
		// load). AI: strict — each call drives a paid LLM request.
		apiLimiter: newRateLimiter(20, 40),
		aiLimiter:  newRateLimiter(0.2, 5),
	}
	return s
}

// SetThreatIntel sets the threat intelligence service
func (s *Server) SetThreatIntel(ti *threatintel.Service) {
	s.threatIntel = ti
}

// SetRemnawave sets the Remnawave sync service
func (s *Server) SetRemnawave(rw *remnawave.SyncService) {
	s.remnawave = rw
}

// SetCorrelation sets the correlation service
func (s *Server) SetCorrelation(c *correlation.Service) {
	s.correlation = c
}

// SetAleria sets the Aleria AI service
func (s *Server) SetAleria(a *aleria.Service) {
	s.aleria = a
}

// SetPartitionManager wires the partition manager so /health can report
// unhealthy if today's partitions are missing.
func (s *Server) SetPartitionManager(pm *partitions.Manager) {
	s.pm = pm
}

// SetRedis attaches a Redis client used for HTTP response caching. Nil
// disables the cache (handlers fall through to live SQL).
func (s *Server) SetRedis(r *rediscache.Client, ttl time.Duration) {
	s.redis = r
	if ttl <= 0 {
		ttl = 10 * time.Second
	}
	s.cacheTTL = ttl
}

// requireAPIToken wraps a handler with Bearer token authentication
func (s *Server) requireAPIToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.apiToken == "" {
			next(w, r)
			return
		}
		// Trust requests from localhost (Next.js SSR in same container)
		if isLocalRequest(r) {
			next(w, r)
			return
		}
		token := extractToken(r)
		if token != s.apiToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// isLocalRequest reports whether the request originates from the same host
// (the Next.js SSR / cache-warmup path), which is trusted to skip the API
// token. A loopback RemoteAddr alone is not sufficient: if a reverse proxy is
// co-located on the same host it would make every forwarded request appear
// loopback. We therefore additionally require the absence of any proxy
// forwarding headers — a genuine same-host caller never sets them.
func isLocalRequest(r *http.Request) bool {
	if r.Header.Get("X-Forwarded-For") != "" ||
		r.Header.Get("X-Real-IP") != "" ||
		r.Header.Get("Forwarded") != "" {
		return false
	}
	host := r.RemoteAddr
	return strings.HasPrefix(host, "127.0.0.1:") || strings.HasPrefix(host, "[::1]:") || strings.HasPrefix(host, "localhost:")
}

// requireAgentToken wraps a handler with agent token authentication
func (s *Server) requireAgentToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.agentToken == "" {
			next(w, r)
			return
		}
		token := extractToken(r)
		if token != s.agentToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r)
	}
}

// extractToken gets token from Authorization header or query param
func extractToken(r *http.Request) string {
	// Check Authorization: Bearer <token>
	if auth := r.Header.Get("Authorization"); auth != "" {
		const prefix = "Bearer "
		if len(auth) > len(prefix) && auth[:len(prefix)] == prefix {
			return auth[len(prefix):]
		}
	}
	// Check ?token=<token> query param (for WebSocket connections from browser)
	if token := r.URL.Query().Get("token"); token != "" {
		return token
	}
	return ""
}

// securityHeaders sets baseline hardening headers on every response and caps
// the request body size. It deliberately does NOT wrap the ResponseWriter so
// that handlers which type-assert http.Flusher (SSE streaming) or
// http.Hijacker (WebSocket upgrades) keep working.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		// The API serves JSON/SSE only — nothing should embed it as a page or
		// load sub-resources from it, so the strictest CSP applies.
		h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		// Cap request bodies. WebSocket upgrades and SSE GETs carry no body;
		// the only POSTs (AI chat, node delete) send tiny JSON payloads.
		if r.Body != nil {
			r.Body = http.MaxBytesReader(w, r.Body, 8<<20) // 8 MiB
		}
		next.ServeHTTP(w, r)
	})
}

// Start starts the HTTP server
func (s *Server) Start(ctx context.Context) error {
	mux := http.NewServeMux()

	// WebSocket endpoints
	mux.HandleFunc("/ws", s.requireAgentToken(s.handleWebSocket))
	mux.HandleFunc("/ws/dashboard", s.requireAPIToken(s.handleDashboardWebSocket))

	// Health (no auth)
	mux.HandleFunc("/health", s.handleHealth)

	// API endpoints (require API token)
	mux.HandleFunc("/api/stats", s.requireAPIToken(s.cached(5*time.Second, s.handleStats)))
	mux.HandleFunc("/api/nodes", s.requireAPIToken(s.cached(10*time.Second, s.handleNodes)))
	mux.HandleFunc("/api/nodes/delete", s.requireAPIToken(s.handleDeleteNode))
	mux.HandleFunc("/api/users", s.requireAPIToken(s.cached(30*time.Second, s.handleUsers)))
	mux.HandleFunc("/api/users/all", s.requireAPIToken(s.cached(30*time.Second, s.handleAllUsers)))
	mux.HandleFunc("/api/hourly", s.requireAPIToken(s.cached(60*time.Second, s.handleHourlyStats)))
	mux.HandleFunc("/api/online-history", s.requireAPIToken(s.cached(30*time.Second, s.handleOnlineHistory)))
	mux.HandleFunc("/api/anomalies", s.requireAPIToken(s.cached(30*time.Second, s.handleAnomalies)))
	mux.HandleFunc("/api/bridged-flows", s.requireAPIToken(s.cached(30*time.Second, s.handleBridgedFlows)))
	mux.HandleFunc("/api/bridge-users", s.requireAPIToken(s.cached(15*time.Second, s.handleBridgeUsers)))
	mux.HandleFunc("/api/alerts", s.requireAPIToken(s.cached(30*time.Second, s.handleAlerts)))
	mux.HandleFunc("/api/blacklist/stats", s.requireAPIToken(s.cached(60*time.Second, s.handleBlacklistStats)))
	mux.HandleFunc("/api/blacklist/analytics", s.requireAPIToken(s.cached(60*time.Second, s.handleBlacklistAnalytics)))
	mux.HandleFunc("/api/blacklist/abuse", s.requireAPIToken(s.cached(60*time.Second, s.handleSubscriptionAbuse)))
	mux.HandleFunc("/api/threatintel/stats", s.requireAPIToken(s.cached(60*time.Second, s.handleThreatIntelStats)))
	mux.HandleFunc("/api/threatintel/matches", s.requireAPIToken(s.cached(30*time.Second, s.handleThreatIntelMatches)))
	mux.HandleFunc("/api/threatintel/feeds", s.requireAPIToken(s.cached(300*time.Second, s.handleThreatIntelFeeds)))
	mux.HandleFunc("/api/threatintel/top-users", s.requireAPIToken(s.cached(60*time.Second, s.handleThreatIntelTopUsers)))
	mux.HandleFunc("/api/threatintel/time-stats", s.requireAPIToken(s.cached(60*time.Second, s.handleThreatIntelTimeStats)))
	mux.HandleFunc("/api/threatintel/geo-stats", s.requireAPIToken(s.cached(60*time.Second, s.handleThreatIntelGeoStats)))
	mux.HandleFunc("/api/threatintel/anomalies", s.requireAPIToken(s.cached(30*time.Second, s.handleThreatIntelAnomalies)))
	mux.HandleFunc("/api/threatintel/attacks", s.requireAPIToken(s.cached(30*time.Second, s.handleAttackAnomalies)))
	mux.HandleFunc("/api/threatintel/risk-profiles", s.requireAPIToken(s.cached(60*time.Second, s.handleUserRiskProfiles)))
	mux.HandleFunc("/api/threatintel/dns-analysis", s.requireAPIToken(s.cached(60*time.Second, s.handleDNSAnalysis)))
	mux.HandleFunc("/api/threatintel/reports", s.requireAPIToken(s.cached(120*time.Second, s.handleReports)))
	mux.HandleFunc("/api/threatintel/clear", s.requireAPIToken(s.handleThreatIntelClear))
	mux.HandleFunc("/api/ipinfo", s.requireAPIToken(s.cached(300*time.Second, s.handleIPInfo)))

	// Remnawave API endpoints
	mux.HandleFunc("/api/remnawave/stats", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveStats)))
	mux.HandleFunc("/api/remnawave/users", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveUsers)))
	mux.HandleFunc("/api/remnawave/user/", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveUser)))
	mux.HandleFunc("/api/remnawave/hwid/", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveHwid)))
	mux.HandleFunc("/api/remnawave/hwid-top", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveHwidTop)))
	mux.HandleFunc("/api/remnawave/hwid-clear", s.requireAPIToken(s.handleRemnawavelClearHwid))
	mux.HandleFunc("/api/remnawave/abuse", s.requireAPIToken(s.cached(60*time.Second, s.handleRemnawaveAbuse)))
	mux.HandleFunc("/api/remnawave/online", s.requireAPIToken(s.cached(30*time.Second, s.handleRemnawaveOnline)))
	mux.HandleFunc("/api/remnawave/sync", s.requireAPIToken(s.handleRemnawaveSync))

	// Correlation API endpoints
	mux.HandleFunc("/api/correlation/stats", s.requireAPIToken(s.cached(60*time.Second, s.handleCorrelationStats)))
	mux.HandleFunc("/api/correlation/profiles", s.requireAPIToken(s.cached(60*time.Second, s.handleCorrelationProfiles)))
	mux.HandleFunc("/api/correlation/user/", s.requireAPIToken(s.cached(60*time.Second, s.handleCorrelationUser)))
	mux.HandleFunc("/api/correlation/shared-ips", s.requireAPIToken(s.cached(60*time.Second, s.handleCorrelationSharedIPs)))
	mux.HandleFunc("/api/correlation/shared-hwids", s.requireAPIToken(s.cached(60*time.Second, s.handleCorrelationSharedHWIDs)))

	// AI Chat endpoints
	mux.HandleFunc("/api/ai/chat", s.requireAPIToken(s.handleAIChat))
	mux.HandleFunc("/api/ai/chat/stream", s.requireAPIToken(s.handleAIChatStream))
	mux.HandleFunc("/api/ai/sessions", s.requireAPIToken(s.handleAIChatSessions))
	mux.HandleFunc("/api/ai/sessions/", s.requireAPIToken(s.handleAIChatSession))

	// Debug endpoints
	mux.HandleFunc("/api/debug/users", s.requireAPIToken(s.handleDebugUsers))

	// User-specific endpoints (must be registered before /api/users/)
	mux.HandleFunc("/api/users/", s.requireAPIToken(s.cached(30*time.Second, s.handleUserRouter)))

	// Start background jobs
	go s.startCleanupJob(ctx)
	go s.startBroadcastLoop(ctx)
	go s.startOnlineSnapshotJob(ctx)
	go s.startCacheWarmupJob(ctx)
	go s.startRateLimitJanitor(ctx)

	// Middleware chain (outermost first): rate limit → security headers → mux.
	// Rate limiting rejects abuse cheaply before any work; the security layer
	// sets hardening headers and caps request bodies without wrapping the
	// ResponseWriter, so streaming (SSE) and WebSocket handlers keep working.
	var handler http.Handler = mux
	handler = s.securityHeaders(handler)
	handler = s.rateLimit(handler)

	server := &http.Server{
		Addr:    s.addr,
		Handler: handler,
		// ReadHeaderTimeout bounds slow-header (Slowloris) attacks. We avoid
		// ReadTimeout/WriteTimeout because /api/ai/chat/stream is a long-lived
		// SSE stream and the /ws* endpoints are hijacked WebSockets — an
		// absolute deadline would truncate both.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		<-ctx.Done()
		log.Println("server: shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	return server.ListenAndServe()
}

// startCleanupJob runs periodic cleanup of inactive nodes and old data
func (s *Server) startCleanupJob(ctx context.Context) {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	// Run cleanup on startup
	s.storage.CleanupOldData(context.Background(), 30) // 30 days retention

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.storage.CleanupInactiveNodes(context.Background(), 24*time.Hour)
			s.storage.CleanupOldData(context.Background(), 30) // 30 days retention
		}
	}
}
