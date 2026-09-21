package main

import (
	"context"
	"errors"
	"log"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/xray-log-analyzer/server/internal/aleria"
	"github.com/xray-log-analyzer/server/internal/analyzer"
	"github.com/xray-log-analyzer/server/internal/blacklist"
	"github.com/xray-log-analyzer/server/internal/config"
	"github.com/xray-log-analyzer/server/internal/correlation"
	"github.com/xray-log-analyzer/server/internal/geoip"
	"github.com/xray-log-analyzer/server/internal/ipinfo"
	"github.com/xray-log-analyzer/server/internal/models"
	"github.com/xray-log-analyzer/server/internal/rediscache"
	"github.com/xray-log-analyzer/server/internal/remnawave"
	"github.com/xray-log-analyzer/server/internal/server"
	"github.com/xray-log-analyzer/server/internal/storage"
	"github.com/xray-log-analyzer/server/internal/storage/partitions"
	"github.com/xray-log-analyzer/server/internal/telegram"
	"github.com/xray-log-analyzer/server/internal/threatintel"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.Println("xray-log-analyzer server starting...")

	// Load configuration
	cfg := config.Load()
	log.Printf("config: listen=%s, db=%s, blacklist=%s",
		cfg.ListenAddr, sanitizeDSN(cfg.PostgresURL), cfg.BlacklistPath)

	// Create context with cancellation
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Initialize storage
	store, err := storage.New(ctx, cfg.PostgresURL)
	if err != nil {
		log.Fatalf("failed to initialize storage: %v", err)
	}
	defer store.Close()
	log.Println("storage: initialized")

	// Admin-panel overrides, if any were ever saved, take precedence over the
	// env-var bootstrap defaults. A nil result (table empty — nobody has used
	// the admin panel yet) leaves cfg exactly as config.Load() produced it.
	if dbSettings, err := store.GetAppSettings(ctx); err != nil {
		log.Printf("app_settings: could not read admin overrides, using env defaults: %v", err)
	} else if dbSettings != nil {
		cfg.RemnawaveEnabled = dbSettings.RemnawaveEnabled
		cfg.RemnawaveURL = dbSettings.RemnawaveURL
		cfg.RemnawaveAPIToken = dbSettings.RemnawaveAPIToken
		if dbSettings.RemnawaveSyncIntervalSeconds > 0 {
			cfg.RemnawaveSyncInterval = time.Duration(dbSettings.RemnawaveSyncIntervalSeconds) * time.Second
		}
		cfg.TelegramEnabled = dbSettings.TelegramEnabled
		cfg.TelegramToken = dbSettings.TelegramToken
		cfg.TelegramChatID = dbSettings.TelegramChatID
		cfg.TelegramTopicID = dbSettings.TelegramTopicID
		log.Println("app_settings: applied admin panel overrides")
	}

	// Start partition manager — creates today+2 future partitions and drops
	// expired ones on startup, then re-runs every 6 hours.
	pm := partitions.NewManager(store.Pool(), []partitions.Table{
		{Name: "request_events", RetentionDays: 0},
		{Name: "bridged_flows", RetentionDays: 0},
		{Name: "alerts", RetentionDays: 0},
		{Name: "blacklist_matches", RetentionDays: 0},
		{Name: "threat_matches", RetentionDays: 0},
		{Name: "anomalies", RetentionDays: 0},
	})
	if err := pm.Tick(ctx); err != nil {
		log.Fatalf("partition manager initial tick: %v", err)
	}
	go func() {
		if err := pm.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("partition manager: %v", err)
		}
	}()
	log.Println("partition manager: started")

	// Wire agent→Remnawave node-name mapping so /api/nodes can surface live
	// XTLS-tracked online counts instead of the access-log heuristic.
	if len(cfg.NodeRemnaMap) > 0 {
		store.SetNodeRemnaMap(cfg.NodeRemnaMap)
		log.Printf("storage: node remna map loaded (%d pairs)", len(cfg.NodeRemnaMap))
	}

	// Initialize Redis (L2 persistent cache). Optional — if it fails or the
	// address is empty, everything still works with only the in-process L1.
	var redisClient *rediscache.Client
	if cfg.RedisAddr != "" {
		rc, err := rediscache.New(cfg.RedisAddr, cfg.RedisPassword, cfg.RedisKeyPrefix)
		if err != nil {
			log.Printf("redis: disabled (connect %s failed: %v)", cfg.RedisAddr, err)
		} else {
			redisClient = rc
			log.Printf("redis: connected at %s (prefix=%q)", cfg.RedisAddr, cfg.RedisKeyPrefix)
			defer redisClient.Close()
		}
	} else {
		log.Println("redis: not configured (REDIS_ADDR empty)")
	}

	// Initialize blacklist
	bl := blacklist.New(cfg.BlacklistPath, cfg.BlacklistReload)
	if cfg.BlacklistRemoteURL != "" {
		bl.SetRemoteURL(cfg.BlacklistRemoteURL)
		log.Printf("blacklist: remote URL configured: %s", cfg.BlacklistRemoteURL)
	}
	if err := bl.Start(ctx); err != nil {
		log.Fatalf("failed to load blacklist: %v", err)
	}
	log.Printf("blacklist: loaded %d rules", bl.Count())

	// Create alert channel
	alertCh := make(chan *models.Alert, 100)

	// Initialize analyzer
	anal := analyzer.New(
		bl,
		store,
		alertCh,
		cfg.SuspiciousRequestCount,
		cfg.SuspiciousTimeWindow,
	)
	if err := anal.SetBridgeInboundPattern(cfg.BridgeInboundPattern); err != nil {
		log.Fatalf("invalid BRIDGE_INBOUND_PATTERN %q: %v", cfg.BridgeInboundPattern, err)
	}
	if cfg.BridgeInboundPattern != "" {
		log.Printf("analyzer: bridge inbound filter active: %q", cfg.BridgeInboundPattern)
	}
	if len(cfg.BridgeNodeIDs) > 0 {
		anal.SetBridgeCorrelation(cfg.BridgeNodeIDs, cfg.BridgeCorrelationWindow)
		log.Printf("analyzer: bridge correlation active: nodes=%v window=%s", cfg.BridgeNodeIDs, cfg.BridgeCorrelationWindow)
	}

	// Local offline geo-IP database (DB-IP City Lite), refreshed daily in the
	// background — see internal/geoip for why this exists instead of calling
	// an external API per lookup.
	geoSvc := geoip.NewService("/app/data/geoip")
	geoSvc.Start(ctx)

	// Initialize IP info service for geo lookups
	ipInfoSvc := ipinfo.NewService()
	ipInfoSvc.SetGeoIP(geoSvc)
	anal.SetIPInfo(ipInfoSvc)

	// Initialize threat intelligence service
	threatIntelSvc := threatintel.NewService(store, ipInfoSvc)
	if err := threatIntelSvc.Start(ctx); err != nil {
		log.Printf("threatintel: failed to start (continuing without): %v", err)
	} else {
		anal.SetThreatIntel(threatIntelSvc)
		log.Printf("threatintel: started with %d indicators", threatIntelSvc.GetIndicatorCount())
	}

	// The bot is always constructed and started, configured or not: the
	// admin panel can supply credentials and flip it on later, and Start's
	// own loop already handles "disabled or unconfigured" by dropping
	// alerts — so there is no separate drain goroutine to maintain anymore.
	telegramBot := telegram.New(cfg.TelegramToken, cfg.TelegramChatID, cfg.TelegramTopicID, alertCh)
	telegramBot.SetEnabled(cfg.TelegramEnabled)
	go telegramBot.Start(ctx)
	if cfg.TelegramEnabled && telegramBot.IsConfigured() {
		if err := telegramBot.SendTestMessage(); err != nil {
			log.Printf("telegram: failed to send test message: %v", err)
		}
	} else {
		log.Println("telegram: disabled or not configured (set it up from the admin panel)")
	}

	// Start cleanup goroutine
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Cleanup analyzer alert cache
				anal.CleanupAlertCache()
			}
		}
	}()

	// Initialize and start server
	srv := server.New(cfg.ListenAddr, cfg.AllowedOrigins, cfg.APIToken, cfg.AgentToken, anal, store, bl, ipInfoSvc)
	srv.SetTelegramBot(telegramBot)
	srv.SetThreatIntel(threatIntelSvc)
	srv.SetPartitionManager(pm)
	if redisClient != nil {
		srv.SetRedis(redisClient, 10*time.Second)
		log.Println("server: HTTP response cache enabled (Redis L2, TTL=10s)")
	}

	// Authentication is mandatory in normal operation. Running wide-open used
	// to be a silent warning; it now aborts startup so a missing token can
	// never silently expose the API or the agent channel. Set ALLOW_NO_AUTH=1
	// to intentionally run without auth (local development only).
	allowNoAuth := os.Getenv("ALLOW_NO_AUTH") == "1" || strings.EqualFold(os.Getenv("ALLOW_NO_AUTH"), "true")
	if cfg.APIToken != "" {
		log.Println("auth: API token authentication enabled")
	} else if allowNoAuth {
		log.Println("auth: WARNING - no API_TOKEN set, API is UNPROTECTED (ALLOW_NO_AUTH override)")
	} else {
		log.Fatalln("auth: refusing to start — API_TOKEN is not set. Set API_TOKEN, or ALLOW_NO_AUTH=1 for local dev only.")
	}
	if cfg.AgentToken != "" {
		log.Println("auth: agent token authentication enabled")
	} else if allowNoAuth {
		log.Println("auth: WARNING - no AGENT_TOKEN set, agent WebSocket is UNPROTECTED (ALLOW_NO_AUTH override)")
	} else {
		log.Fatalln("auth: refusing to start — AGENT_TOKEN is not set. Set AGENT_TOKEN, or ALLOW_NO_AUTH=1 for local dev only.")
	}

	// Same reasoning as the Telegram bot above: always construct and start,
	// so enabling Remnawave from the admin panel later needs no restart.
	// Start's loop polls harmlessly while unconfigured (see sync.go).
	remnaClient := remnawave.NewClient(cfg.RemnawaveURL, cfg.RemnawaveAPIToken)
	remnaSvc := remnawave.NewSyncService(remnaClient, cfg.RemnawaveSyncInterval)
	remnaSvc.SetEnabled(cfg.RemnawaveEnabled)
	remnaSvc.SetIDCacheRedis(redisClient)
	remnaSvc.SetStorage(store) // Persist data to Postgres
	// Warm cache after each sync for fast page loads
	remnaSvc.OnSyncComplete(func() {
		store.WarmCache(ctx)
	})
	srv.SetRemnawave(remnaSvc)
	go remnaSvc.Start(ctx)
	if cfg.RemnawaveEnabled && remnaClient.IsConfigured() {
		log.Printf("remnawave: enabled, sync interval: %v, storage: enabled", cfg.RemnawaveSyncInterval)
	} else {
		log.Println("remnawave: disabled or not configured (set it up from the admin panel)")
	}

	// Initial cache warm-up
	go store.WarmCache(ctx)

	// Initialize correlation service for user analysis
	correlationSvc := correlation.NewService(store, remnaSvc)
	anal.SetCorrelation(correlationSvc)
	srv.SetCorrelation(correlationSvc)
	log.Println("correlation: service initialized")

	// Initialize Aleria AI service
	if cfg.OpenAIAPIKey != "" {
		aleriaSvc := aleria.NewService(cfg.OpenAIAPIKey, cfg.OpenAIBaseURL, cfg.OpenAIModel, store)
		// Give AI access to Remnawave API for real-time data
		if remnaClient != nil {
			aleriaSvc.SetRemnaClient(remnaClient)
		}
		srv.SetAleria(aleriaSvc)
		log.Println("aleria: AI service initialized")
	} else {
		log.Println("aleria: disabled (no API key configured)")
	}

	// Start periodic profile refresh (every 6 hours)
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				correlationSvc.RefreshAllProfiles(ctx)
			}
		}
	}()

	// Anomaly detection — runs every 10 minutes.
	// Detects activity spikes, night activity, threat bursts, multi-country access, etc.
	go func() {
		ticker := time.NewTicker(10 * time.Minute)
		defer ticker.Stop()
		// Run once shortly after startup so dashboard isn't empty
		time.AfterFunc(60*time.Second, func() {
			if found, err := store.DetectAnomalies(ctx); err == nil && len(found) > 0 {
				log.Printf("anomaly: detected %d anomalies", len(found))
			}
		})
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if found, err := store.DetectAnomalies(ctx); err != nil {
					log.Printf("anomaly: detection error: %v", err)
				} else if len(found) > 0 {
					log.Printf("anomaly: detected %d anomalies", len(found))
				}
			}
		}
	}()

	// User risk profile recalculation — runs every 30 minutes.
	// Aggregates threat matches, anomalies, geo, and activity into a per-user risk score.
	go func() {
		ticker := time.NewTicker(30 * time.Minute)
		defer ticker.Stop()
		// Initial run after 2 minutes (let threat matches accumulate)
		time.AfterFunc(2*time.Minute, func() {
			if err := store.RecalculateAllUserRiskProfiles(ctx); err != nil {
				log.Printf("risk: recalculation error: %v", err)
			}
		})
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := store.RecalculateAllUserRiskProfiles(ctx); err != nil {
					log.Printf("risk: recalculation error: %v", err)
				}
			}
		}
	}()

	go func() {
		if err := srv.Start(ctx); err != nil {
			log.Printf("server error: %v", err)
			cancel()
		}
	}()

	log.Println("server started, press Ctrl+C to stop")

	// Wait for shutdown signal
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("shutting down...")
	cancel()

	// Stop threat intelligence service
	threatIntelSvc.Stop()

	// Give goroutines time to cleanup
	time.Sleep(2 * time.Second)
	log.Println("server stopped")
}

// sanitizeDSN strips the password from a postgres DSN for safe logging.
// postgres://user:pass@host/db → postgres://user@host/db
func sanitizeDSN(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil || u.User == nil {
		return dsn
	}
	if _, hasPW := u.User.Password(); hasPW {
		u.User = url.User(u.User.Username())
	}
	return u.String()
}
