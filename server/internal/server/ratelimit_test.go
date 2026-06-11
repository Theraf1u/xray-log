package server

import (
	"testing"
	"time"
)

// TestRateLimiter_BurstThenBlock: a fresh key may spend its full burst, then
// the next request is denied until tokens refill.
func TestRateLimiter_BurstThenBlock(t *testing.T) {
	rl := newRateLimiter(1, 3) // 1 tok/s, capacity 3
	now := time.Unix(0, 0)

	for i := 0; i < 3; i++ {
		if !rl.allow("1.2.3.4", now) {
			t.Fatalf("burst token %d denied, want allowed", i+1)
		}
	}
	if rl.allow("1.2.3.4", now) {
		t.Fatal("4th request within burst should be denied")
	}
	// After 1s, exactly one token refills.
	if !rl.allow("1.2.3.4", now.Add(time.Second)) {
		t.Fatal("request after 1s refill should be allowed")
	}
	if rl.allow("1.2.3.4", now.Add(time.Second)) {
		t.Fatal("only one token should have refilled")
	}
}

// TestRateLimiter_PerKeyIsolation: separate IPs get independent buckets.
func TestRateLimiter_PerKeyIsolation(t *testing.T) {
	rl := newRateLimiter(1, 1)
	now := time.Unix(0, 0)
	if !rl.allow("a", now) {
		t.Fatal("a first request should pass")
	}
	if !rl.allow("b", now) {
		t.Fatal("b must not be throttled by a's usage")
	}
	if rl.allow("a", now) {
		t.Fatal("a is out of tokens")
	}
}

// TestRateLimiter_Sweep: idle buckets are evicted.
func TestRateLimiter_Sweep(t *testing.T) {
	rl := newRateLimiter(1, 1)
	now := time.Unix(0, 0)
	rl.allow("stale", now)
	rl.sweep(now.Add(time.Hour), 10*time.Minute)
	rl.mu.Lock()
	_, present := rl.buckets["stale"]
	rl.mu.Unlock()
	if present {
		t.Fatal("idle bucket should have been swept")
	}
}
