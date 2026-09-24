package remnawave

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/xray-log-analyzer/server/internal/rediscache"
)

// IDCache caches numeric ID → username mappings. L1 is an in-process map;
// if a Redis client is attached it's used as L2 so lookups survive restarts
// (a warm-start analyzer doesn't have to re-call Remnawave for every ID).
type IDCache struct {
	client     *Client
	redis      *rediscache.Client
	cache      map[string]string // id -> username
	notFound   map[string]bool   // ids that returned 404
	mu         sync.RWMutex
	ttl        time.Duration
	notFoundTTL time.Duration
	lastSync   time.Time
	syncPeriod time.Duration
}

// NewIDCache creates a new ID cache. Pass nil for redis to disable L2.
func NewIDCache(client *Client) *IDCache {
	return &IDCache{
		client:      client,
		cache:       make(map[string]string),
		notFound:    make(map[string]bool),
		ttl:         24 * time.Hour,
		notFoundTTL: 1 * time.Hour,
		syncPeriod:  5 * time.Minute,
	}
}

// SetRedis attaches a Redis client for L2 caching. Nil disables L2.
func (c *IDCache) SetRedis(r *rediscache.Client) {
	c.redis = r
}

// redisKey / redisNFKey namespace Redis entries so a single Redis instance
// can host multiple cache kinds without collision.
func (c *IDCache) redisKey(id string) string   { return "remna:id:" + id }
func (c *IDCache) redisNFKey(id string) string { return "remna:id:nf:" + id }

// GetUsername returns the username for a numeric ID. Non-numeric inputs are
// already usernames and pass through. Lookup order: L1 → L2 (Redis) → API.
// Found values are backfilled into both caches on the way up.
func (c *IDCache) GetUsername(ctx context.Context, id string) string {
	if !isNumericID(id) {
		return id
	}

	// L1 hit.
	c.mu.RLock()
	if username, ok := c.cache[id]; ok {
		c.mu.RUnlock()
		return username
	}
	if c.notFound[id] {
		c.mu.RUnlock()
		return id
	}
	c.mu.RUnlock()

	// L2 hit (Redis).
	if c.redis != nil {
		var username string
		if ok, err := c.redis.GetJSON(ctx, c.redisKey(id), &username); err == nil && ok {
			c.mu.Lock()
			c.cache[id] = username
			c.mu.Unlock()
			return username
		}
		var nf bool
		if ok, err := c.redis.GetJSON(ctx, c.redisNFKey(id), &nf); err == nil && ok && nf {
			c.mu.Lock()
			c.notFound[id] = true
			c.mu.Unlock()
			return id
		}
	}

	return c.fetchAndCache(ctx, id)
}

// fetchAndCache pulls the username from the Remnawave API and seeds both
// cache layers. Not-found results are cached too, with a shorter TTL, so a
// parade of requests for a deleted user doesn't batter the API.
func (c *IDCache) fetchAndCache(ctx context.Context, id string) string {
	if c.client == nil || !c.client.IsConfigured() {
		return id
	}

	// GetUsername is called in tight per-item loops (e.g. resolving display
	// names for the dashboard's top-500 user list, or every category's top
	// users) from the single-threaded WebSocket broadcast loop, which serves
	// every connected dashboard client. Without a bound here, a slow or
	// degraded Remnawave backend turns one cache-miss ID into a multi-second
	// stall, and a handful of them in the same batch can block that shared
	// loop — and therefore every client's live updates, including data that
	// has nothing to do with usernames — for the duration. Capping each
	// lookup means a bad Remnawave day degrades to "shows the raw ID" rather
	// than "the whole dashboard stops updating".
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	user, err := c.client.GetUserByID(ctx, id)
	if err != nil {
		// A timeout means "Remnawave didn't answer in time", not "this user
		// doesn't exist" — caching it as not-found would keep serving the
		// raw ID for a full notFoundTTL even once Remnawave recovers.
		if !errors.Is(err, context.DeadlineExceeded) {
			c.mu.Lock()
			c.notFound[id] = true
			c.mu.Unlock()
			if c.redis != nil {
				_ = c.redis.SetJSON(context.Background(), c.redisNFKey(id), true, c.notFoundTTL)
			}
		}
		return id
	}

	if user != nil && user.Username != "" {
		c.mu.Lock()
		c.cache[id] = user.Username
		c.mu.Unlock()
		if c.redis != nil {
			_ = c.redis.SetJSON(ctx, c.redisKey(id), user.Username, c.ttl)
		}
		return user.Username
	}

	return id
}

// PreloadFromUsers clears and optionally warms the cache. Redis is left
// alone — stale Redis entries fall off on their own TTL.
func (c *IDCache) PreloadFromUsers(users []User) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.cache = make(map[string]string)
	c.notFound = make(map[string]bool)

	log.Printf("idcache: preloaded %d users", len(users))
}

// ResolveMultiple resolves many IDs. It's a simple loop — the L1 map plus
// Redis roundtrip keeps individual calls cheap enough that batching
// wouldn't win much for the typical tens-of-ids use case.
func (c *IDCache) ResolveMultiple(ctx context.Context, ids []string) map[string]string {
	result := make(map[string]string, len(ids))
	for _, id := range ids {
		result[id] = c.GetUsername(ctx, id)
	}
	return result
}

// Clear wipes both layers so a full resync can start clean.
func (c *IDCache) Clear() {
	c.mu.Lock()
	c.cache = make(map[string]string)
	c.notFound = make(map[string]bool)
	c.mu.Unlock()
	if c.redis != nil {
		_ = c.redis.DeletePrefix(context.Background(), "remna:id:")
	}
}

// Stats returns L1 counters. Redis stats are out of scope here — use
// redis-cli INFO for that.
func (c *IDCache) Stats() (cached int, notFound int) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.cache), len(c.notFound)
}

func isNumericID(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
