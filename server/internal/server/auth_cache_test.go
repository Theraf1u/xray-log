package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestAuthBeforeCache is a regression guard for the unauthenticated data leak.
//
// The HTTP cache layer must sit INSIDE requireAPIToken — i.e. the production
// composition is requireAPIToken(cached(h)), never cached(requireAPIToken(h)).
// Otherwise an entry primed by the localhost cache-warmup job (which has no
// Authorization header and therefore lands under the empty-auth cache key) is
// replayed verbatim to any anonymous remote caller, because a cache HIT returns
// before the wrapped handler — including its auth check — ever runs.
//
// If the composition is ever flipped back, step (2) below starts returning the
// cached secret body with status 200 and this test fails.
func TestAuthBeforeCache(t *testing.T) {
	s, _ := newCacheTestServer(t)
	s.apiToken = "secret"

	var calls int32
	handler := func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret_users":922}`))
	}
	// EXACT production composition: auth wraps cache.
	composed := s.requireAPIToken(s.cached(time.Minute, handler))

	// 1) Warmup primes the cache exactly as startCacheWarmupJob does: loopback
	//    RemoteAddr, no Authorization header → isLocalRequest bypass → handler
	//    runs and the body is stored under the empty-auth cache key.
	warm := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	warm.RemoteAddr = "127.0.0.1:0"
	ww := httptest.NewRecorder()
	composed(ww, warm)
	if ww.Code != http.StatusOK {
		t.Fatalf("warmup priming: status=%d, want 200", ww.Code)
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("warmup should have run handler once, got %d", got)
	}

	// 2) Anonymous REMOTE request to the warmed path must be rejected with 401
	//    and must NOT receive the cached body.
	anon := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	anon.RemoteAddr = "203.0.113.7:54321" // public, non-loopback
	aw := httptest.NewRecorder()
	composed(aw, anon)
	if aw.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous remote request: status=%d, want 401 (DATA LEAK)", aw.Code)
	}
	if strings.Contains(aw.Body.String(), "secret_users") {
		t.Fatalf("cached secret body leaked to anonymous caller: %q", aw.Body.String())
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("anon request must not invoke handler; calls=%d", got)
	}

	// 3) A correctly authenticated remote request is still served the data.
	authed := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	authed.RemoteAddr = "203.0.113.7:54321"
	authed.Header.Set("Authorization", "Bearer secret")
	rw := httptest.NewRecorder()
	composed(rw, authed)
	if rw.Code != http.StatusOK {
		t.Fatalf("authed request: status=%d, want 200", rw.Code)
	}
	if !strings.Contains(rw.Body.String(), "secret_users") {
		t.Fatalf("authed body=%q, want data", rw.Body.String())
	}
}

// TestAuthRejectsBadToken confirms a wrong/empty bearer token never reaches the
// cache or handler for a remote caller.
func TestAuthRejectsBadToken(t *testing.T) {
	s, _ := newCacheTestServer(t)
	s.apiToken = "secret"

	var calls int32
	composed := s.requireAPIToken(s.cached(time.Minute, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusOK)
	}))

	for _, tok := range []string{"", "Bearer wrong", "Bearer "} {
		req := httptest.NewRequest(http.MethodGet, "/api/users", nil)
		req.RemoteAddr = "203.0.113.9:5555"
		if tok != "" {
			req.Header.Set("Authorization", tok)
		}
		w := httptest.NewRecorder()
		composed(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("token=%q: status=%d, want 401", tok, w.Code)
		}
	}
	if got := atomic.LoadInt32(&calls); got != 0 {
		t.Fatalf("handler ran %d times for unauthorized requests, want 0", got)
	}
}

// TestLoopbackWithProxyHeaderNotTrusted verifies the isLocalRequest hardening:
// a loopback RemoteAddr is trusted (SSR / warmup bypass) only when NO proxy
// forwarding header is present. A co-located reverse proxy forwarding to
// loopback — the exact vector behind the original leak — sets one of
// X-Forwarded-For / X-Real-IP / Forwarded, so such a request must NOT bypass
// auth, even to a warmed cache entry.
func TestLoopbackWithProxyHeaderNotTrusted(t *testing.T) {
	s, _ := newCacheTestServer(t)
	s.apiToken = "secret"

	var calls int32
	composed := s.requireAPIToken(s.cached(time.Minute, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"secret":1}`))
	}))

	// Prime the cache via the genuine warmup path (loopback, no proxy header).
	warm := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	warm.RemoteAddr = "127.0.0.1:0"
	composed(httptest.NewRecorder(), warm)
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("warmup should have primed once, calls=%d", got)
	}

	for _, hdr := range []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"} {
		req := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
		req.RemoteAddr = "127.0.0.1:0" // forged loopback
		req.Header.Set(hdr, "203.0.113.50")
		w := httptest.NewRecorder()
		composed(w, req)
		if w.Code != http.StatusUnauthorized {
			t.Errorf("loopback + %s: status=%d, want 401 (proxy-forwarded request must not be trusted)", hdr, w.Code)
		}
		if strings.Contains(w.Body.String(), "secret") {
			t.Errorf("loopback + %s leaked cached body", hdr)
		}
	}

	// Sanity: genuine loopback with NO proxy header IS still trusted (SSR path).
	ssr := httptest.NewRequest(http.MethodGet, "/api/stats", nil)
	ssr.RemoteAddr = "127.0.0.1:0"
	w := httptest.NewRecorder()
	composed(w, ssr)
	if w.Code != http.StatusOK {
		t.Fatalf("genuine loopback SSR request: status=%d, want 200", w.Code)
	}
}
