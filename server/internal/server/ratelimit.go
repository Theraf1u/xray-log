package server

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// tokenBucket is a single client's allowance. tokens refills at rate per second
// up to burst.
type tokenBucket struct {
	tokens float64
	last   time.Time
}

// rateLimiter is a per-key token-bucket limiter with no external dependencies.
// Keys are client IPs. Buckets are created lazily and swept periodically.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*tokenBucket
	rate    float64 // tokens added per second
	burst   float64 // bucket capacity
}

func newRateLimiter(rate, burst float64) *rateLimiter {
	return &rateLimiter{
		buckets: make(map[string]*tokenBucket),
		rate:    rate,
		burst:   burst,
	}
}

// allow consumes one token for key, refilling first. Returns false when the
// bucket is empty (request should be rejected).
func (rl *rateLimiter) allow(key string, now time.Time) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b, ok := rl.buckets[key]
	if !ok {
		// New client starts full, then immediately spends one token.
		rl.buckets[key] = &tokenBucket{tokens: rl.burst - 1, last: now}
		return true
	}
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * rl.rate
		if b.tokens > rl.burst {
			b.tokens = rl.burst
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false
}

// sweep evicts buckets that have been idle long enough to have fully refilled,
// keeping memory bounded under churny client populations.
func (rl *rateLimiter) sweep(now time.Time, idle time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for k, b := range rl.buckets {
		if now.Sub(b.last) > idle {
			delete(rl.buckets, k)
		}
	}
}

// startRateLimitJanitor periodically sweeps stale buckets from both limiters.
func (s *Server) startRateLimitJanitor(ctx context.Context) {
	t := time.NewTicker(5 * time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			if s.apiLimiter != nil {
				s.apiLimiter.sweep(now, 10*time.Minute)
			}
			if s.aiLimiter != nil {
				s.aiLimiter.sweep(now, 30*time.Minute)
			}
		}
	}
}

// rateLimit throttles abusive callers by client IP. Health checks, WebSocket
// upgrades and same-host (SSR / cache-warmup) traffic are exempt. The AI
// endpoints get a much stricter bucket because each call drives a paid LLM
// request.
func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if path == "/health" || strings.HasPrefix(path, "/ws") || isLocalRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		limiter := s.apiLimiter
		if strings.HasPrefix(path, "/api/ai/") {
			limiter = s.aiLimiter
		}
		if limiter != nil && !limiter.allow(clientIP(r), time.Now()) {
			w.Header().Set("Retry-After", "1")
			http.Error(w, "Too Many Requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP extracts the real client address, honouring the reverse proxy's
// forwarding headers (the direct RemoteAddr is the proxy, not the client).
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.IndexByte(xff, ','); i >= 0 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return strings.TrimSpace(xr)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
