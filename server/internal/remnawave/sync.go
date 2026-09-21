package remnawave

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/xray-log-analyzer/server/internal/rediscache"
	"github.com/google/uuid"
)

// StorageWriter interface for writing Remnawave data to storage
type StorageWriter interface {
	UpsertRemnaUser(ctx context.Context, user *RemnaUserData) error
	UpsertRemnaHwidDevice(ctx context.Context, device *RemnaHwidData) error
	UpsertRemnaUsers(ctx context.Context, users []*RemnaUserData) error
	UpsertRemnaHwidDevices(ctx context.Context, devices []*RemnaHwidData) error
	UpsertRemnaNode(ctx context.Context, node *RemnaNodeData) error
	UpdateRemnaNodeLive(ctx context.Context, live *RemnaNodeLiveData) error
	UpdateRemnaUserHwidCounts(ctx context.Context) error
	// PruneRemnaUsers removes rows whose uuid is not in liveUUIDs. Called
	// at the end of a successful syncUsers() so that users deleted on the
	// Remnawave panel disappear from analyzer counts. Returns the number
	// of rows deleted.
	PruneRemnaUsers(ctx context.Context, liveUUIDs []string) (int, error)
}

// RemnaUserData represents user data for storage
type RemnaUserData struct {
	UUID                 string
	ID                   int64
	ShortUUID            string
	Username             string
	Email                *string
	Status               string
	TrafficLimitBytes    int64
	UsedTrafficBytes     int64
	LifetimeTrafficBytes int64
	TrafficLimitStrategy string
	ExpireAt             *time.Time
	OnlineAt             *time.Time
	FirstConnectedAt     *time.Time
	HwidDeviceLimit      *int
	HwidDeviceCount      int
	TelegramID           *int64
	Description          *string
	Tag                  *string
	CreatedAt            time.Time
	UpdatedAt            time.Time
	SyncedAt             time.Time
	RealName             *string
	Phone                *string
	TelegramUser         *string
	PaymentInfo          *string
	Plan                 *string
	USID                 *string // Xray log user ID from US_ID: <number> in description
}

// RemnaHwidData represents HWID device data for storage
type RemnaHwidData struct {
	Hwid         string
	UserUUID     string
	Username     string
	Platform     *string
	OSVersion    *string
	DeviceModel  *string
	AppVersion   *string
	FirstSeenAt  time.Time
	LastActiveAt *time.Time
	SyncedAt     time.Time
}

// RemnaNodeData represents node data for storage
type RemnaNodeData struct {
	UUID           string
	Name           string
	Address        string
	Port           int
	IsConnected    bool
	IsDisabled     bool
	IsTrafficTrack bool
	TrafficTotal   int64
	TrafficUsed    int64
	UsersOnline    int
	CountryCode    string
	Tags           []string
	SyncedAt       time.Time
}

// RemnaNodeLiveData is the fast-changing subset of a node's state, written
// by syncLive on its own 1s cadence rather than the full sync interval.
type RemnaNodeLiveData struct {
	UUID          string
	IsConnected   bool
	UsersOnline   int
	XrayUptime    float64
	RxBytesPerSec float64
	TxBytesPerSec float64
}

// SyncService handles periodic synchronization with Remnawave API
type SyncService struct {
	client  *Client
	storage StorageWriter
	syncMu  sync.Mutex

	// intervalMu guards syncInterval and enabled: the admin panel can change
	// both while Start's loop is running, live, without a restart.
	intervalMu   sync.RWMutex
	syncInterval time.Duration
	enabled      bool

	// ID Cache for resolving numeric IDs to usernames
	idCache *IDCache

	// Cached data
	mu              sync.RWMutex
	users           map[string]*User        // by UUID
	usersByEmail    map[string]*User        // by email (lowercase)
	usersByUsername map[string]*User        // by username
	usersByID       map[int64]*User         // by numeric ID
	hwidDevices     map[string][]HwidDevice // by user UUID
	lastSync        time.Time

	// Callbacks for external consumers
	onSyncComplete func()
}

// NewSyncService creates a new sync service
func NewSyncService(client *Client, syncInterval time.Duration) *SyncService {
	svc := &SyncService{
		client:          client,
		syncInterval:    syncInterval,
		enabled:         true,
		users:           make(map[string]*User),
		usersByEmail:    make(map[string]*User),
		usersByUsername: make(map[string]*User),
		usersByID:       make(map[int64]*User),
		hwidDevices:     make(map[string][]HwidDevice),
	}
	svc.idCache = NewIDCache(client)
	return svc
}

// SetStorage sets the storage writer for persisting data
func (s *SyncService) SetStorage(storage StorageWriter) {
	s.storage = storage
}

// SetCredentials proxies to the underlying client. Takes effect on the next
// poll/sync cycle; Start's loop re-reads the client's IsConfigured() state
// every cycle rather than caching it, so this needs no extra plumbing.
func (s *SyncService) SetCredentials(baseURL, apiToken string) {
	s.client.SetCredentials(baseURL, apiToken)
}

// SetInterval changes the sync cadence live. Takes effect on the next cycle.
func (s *SyncService) SetInterval(d time.Duration) {
	if d <= 0 {
		return
	}
	s.intervalMu.Lock()
	s.syncInterval = d
	s.intervalMu.Unlock()
}

func (s *SyncService) interval() time.Duration {
	s.intervalMu.RLock()
	defer s.intervalMu.RUnlock()
	return s.syncInterval
}

// Credentials proxies to the underlying client (see Client.Credentials).
func (s *SyncService) Credentials() (baseURL, apiToken string) {
	return s.client.Credentials()
}

// Interval returns the current sync cadence.
func (s *SyncService) Interval() time.Duration {
	return s.interval()
}

// IsEnabled reports whether the sync loop is paused via the admin panel.
func (s *SyncService) IsEnabled() bool {
	return s.isEnabled()
}

// SetEnabled pauses or resumes the sync loop without touching credentials —
// distinct from IsConfigured(), which only asks whether credentials exist.
func (s *SyncService) SetEnabled(enabled bool) {
	s.intervalMu.Lock()
	s.enabled = enabled
	s.intervalMu.Unlock()
}

func (s *SyncService) isEnabled() bool {
	s.intervalMu.RLock()
	defer s.intervalMu.RUnlock()
	return s.enabled
}

// pollInterval is how often Start checks back while unconfigured or paused —
// short, so enabling Remnawave from the admin panel takes effect quickly
// rather than waiting out whatever the full sync interval happens to be.
const pollInterval = 10 * time.Second

// SetIDCacheRedis wires the persistent L2 cache into the id cache. Nil is
// allowed and disables L2 (the L1 map keeps working).
func (s *SyncService) SetIDCacheRedis(r *rediscache.Client) {
	if s.idCache != nil {
		s.idCache.SetRedis(r)
	}
}

// OnSyncComplete sets a callback to be called when sync completes
func (s *SyncService) OnSyncComplete(fn func()) {
	s.onSyncComplete = fn
}

// ForceSync triggers an immediate synchronization
func (s *SyncService) ForceSync(ctx context.Context) error {
	if !s.client.IsConfigured() {
		return fmt.Errorf("client not configured")
	}
	if !s.sync(ctx) {
		return fmt.Errorf("synchronization already in progress")
	}
	return nil
}

// Start begins the periodic synchronization.
//
// It no longer exits for good when Remnawave is unconfigured at boot: the
// admin panel can supply credentials and flip enabled=true later, and this
// loop needs to notice and start syncing without a process restart. While
// unconfigured or paused it just polls at pollInterval and does nothing.
// liveInterval is how often the lightweight live-telemetry poll runs
// (speed, xray uptime, online count) — independent of and much faster than
// the admin-configured full sync interval, since it costs one GET /api/nodes
// call and a handful of single-column UPDATEs rather than a full
// user/hwid/node resync.
const liveInterval = 1 * time.Second

func (s *SyncService) Start(ctx context.Context) {
	go s.liveLoop(ctx)

	if s.client.IsConfigured() && s.isEnabled() {
		// Complete the initial sync before starting the timer so large
		// datasets cannot create two overlapping full syncs after a restart.
		s.sync(ctx)
	} else {
		log.Println("[remnawave] not configured or disabled — waiting for admin configuration")
	}

	for {
		wait := pollInterval
		if s.client.IsConfigured() && s.isEnabled() {
			wait = s.interval()
		}
		// Start the interval after the previous full sync has finished. A ticker
		// would leave a pending tick while a large sync is running and start the
		// next one immediately, keeping PostgreSQL busy continuously.
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
			if s.client.IsConfigured() && s.isEnabled() {
				s.sync(ctx)
			}
		}
	}
}

// liveLoop refreshes fast-changing per-node telemetry (throughput, xray
// uptime, live online count) on its own tight interval, decoupled from the
// slower admin-configured full sync. It never touches users/hwid/traffic
// totals — those still come from sync() — and it silently does nothing
// while Remnawave is unconfigured or disabled, same as sync().
func (s *SyncService) liveLoop(ctx context.Context) {
	ticker := time.NewTicker(liveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if s.client.IsConfigured() && s.isEnabled() {
				s.syncLive(ctx)
			}
		}
	}
}

// syncLive fetches the current node list and writes just the live columns.
// Runs far more often than sync(), so it deliberately skips the mutex that
// guards the full sync — a live tick overlapping a full sync is harmless
// (both only ever move data forward) and serializing them would make live
// updates stall for the duration of a full sync.
func (s *SyncService) syncLive(ctx context.Context) {
	nodes, err := s.client.GetNodes(ctx)
	if err != nil {
		// Transient failures are expected (panel restart, network blip) and
		// happen every second's worth of ticks if the panel is down; logging
		// each one would flood the log, so this fails silently and the next
		// tick tries again.
		return
	}
	for _, node := range nodes {
		live := &RemnaNodeLiveData{
			UUID:        node.UUID,
			IsConnected: node.IsConnected,
			UsersOnline: node.GetOnlineUsers(),
			XrayUptime:  node.XrayUptime,
		}
		if node.System != nil && node.System.Stats.Interface != nil {
			live.RxBytesPerSec = node.System.Stats.Interface.RxBytesPerSec
			live.TxBytesPerSec = node.System.Stats.Interface.TxBytesPerSec
		}
		if err := s.storage.UpdateRemnaNodeLive(ctx, live); err != nil {
			log.Printf("[remnawave] failed to update live telemetry for node %s: %v", node.Name, err)
		}
	}
}

// sync performs a full synchronization
func (s *SyncService) sync(ctx context.Context) bool {
	if !s.syncMu.TryLock() {
		log.Println("[remnawave] sync skipped: another synchronization is already in progress")
		return false
	}
	defer s.syncMu.Unlock()

	log.Println("[remnawave] starting sync...")
	start := time.Now()

	// Sync users
	if err := s.syncUsers(ctx); err != nil {
		log.Printf("[remnawave] failed to sync users: %v", err)
	}

	// Sync HWID devices
	if err := s.syncHwidDevices(ctx); err != nil {
		log.Printf("[remnawave] failed to sync HWID devices: %v", err)
	}

	// Update HWID counts in user table after syncing devices
	if s.storage != nil {
		if err := s.storage.UpdateRemnaUserHwidCounts(ctx); err != nil {
			log.Printf("[remnawave] failed to update HWID counts: %v", err)
		}
	}

	// Sync nodes
	if err := s.syncNodes(ctx); err != nil {
		log.Printf("[remnawave] failed to sync nodes: %v", err)
	}

	s.mu.Lock()
	s.lastSync = time.Now()
	s.mu.Unlock()

	log.Printf("[remnawave] sync completed in %v, users: %d, hwid records: %d",
		time.Since(start), len(s.users), s.countHwidDevices())

	if s.onSyncComplete != nil {
		s.onSyncComplete()
	}
	return true
}

// syncUsers fetches and caches all users
func (s *SyncService) syncUsers(ctx context.Context) error {
	resp, err := s.client.GetUsers(ctx)
	if err != nil {
		return err
	}

	users := make(map[string]*User)
	usersByEmail := make(map[string]*User)
	usersByUsername := make(map[string]*User)
	usersByID := make(map[int64]*User)
	userBatch := make([]*RemnaUserData, 0, len(resp.Users))
	now := time.Now()

	for i := range resp.Users {
		user := &resp.Users[i]
		// Remnawave v2 may omit the legacy UUID and expose only numeric ID.
		// Keep the database UUID contract with a deterministic internal UUID.
		if user.UUID == "" && user.ID > 0 {
			user.UUID = uuid.NewSHA1(uuid.NameSpaceURL, []byte(fmt.Sprintf("remnawave:user:%d", user.ID))).String()
		}

		// Populate legacy fields from nested UserTraffic (API v2.3.x)
		user.PopulateFromTraffic()

		// Parse Note/Description field
		if user.Description != nil && *user.Description != "" {
			user.ParsedNote = ParseNote(*user.Description)
		}

		users[user.UUID] = user

		if user.Email != nil && *user.Email != "" {
			usersByEmail[normalizeEmail(*user.Email)] = user
		}
		if user.Username != "" {
			usersByUsername[user.Username] = user
		}
		if user.ID > 0 {
			usersByID[user.ID] = user
		}

		// Build a batch for one transactional write after parsing all users.
		if s.storage != nil {
			userData := &RemnaUserData{
				UUID:                 user.UUID,
				ID:                   user.ID,
				ShortUUID:            user.ShortUUID,
				Username:             user.Username,
				Email:                user.Email,
				Status:               user.Status,
				TrafficLimitBytes:    user.TrafficLimitBytes,
				UsedTrafficBytes:     user.UsedTrafficBytes,
				LifetimeTrafficBytes: user.LifetimeUsedTraffic,
				TrafficLimitStrategy: user.TrafficLimitStrategy,
				ExpireAt:             &user.ExpireAt,
				OnlineAt:             user.OnlineAt,
				FirstConnectedAt:     user.FirstConnectedAt,
				HwidDeviceLimit:      user.HwidDeviceLimit,
				HwidDeviceCount:      0, // Updated after HWID sync
				TelegramID:           user.TelegramID,
				Description:          user.Description,
				Tag:                  user.Tag,
				CreatedAt:            user.CreatedAt,
				UpdatedAt:            user.UpdatedAt,
				SyncedAt:             now,
			}

			// Add parsed note fields
			if user.ParsedNote != nil {
				if user.ParsedNote.RealName != "" {
					userData.RealName = &user.ParsedNote.RealName
				}
				if user.ParsedNote.Phone != "" {
					userData.Phone = &user.ParsedNote.Phone
				}
				if user.ParsedNote.TelegramUser != "" {
					userData.TelegramUser = &user.ParsedNote.TelegramUser
				}
				if user.ParsedNote.PaymentInfo != "" {
					userData.PaymentInfo = &user.ParsedNote.PaymentInfo
				}
				if user.ParsedNote.Plan != "" {
					userData.Plan = &user.ParsedNote.Plan
				}
				if user.ParsedNote.USID != "" {
					userData.USID = &user.ParsedNote.USID
				}
			}

			// Same transactional caveat as HWID: a row without a valid uuid
			// would abort the whole user snapshot.
			if _, err := uuid.Parse(userData.UUID); err != nil {
				log.Printf("[remnawave] skipping user %q: invalid uuid %q", user.Username, userData.UUID)
			} else {
				userBatch = append(userBatch, userData)
			}
		}
	}
	if s.storage != nil {
		if err := s.storage.UpsertRemnaUsers(ctx, userBatch); err != nil {
			return fmt.Errorf("persist users batch: %w", err)
		}
	}

	s.mu.Lock()
	s.users = users
	s.usersByEmail = usersByEmail
	s.usersByUsername = usersByUsername
	s.usersByID = usersByID
	s.mu.Unlock()

	// Prune storage rows for users that no longer exist in Remnawave.
	// Skipped if no users were fetched — guards against pruning
	// everything when GetUsers returns empty due to a transient error
	// that didn't surface as an err.
	if s.storage != nil && len(users) > 0 {
		liveUUIDs := make([]string, 0, len(users))
		for u := range users {
			liveUUIDs = append(liveUUIDs, u)
		}
		if deleted, perr := s.storage.PruneRemnaUsers(ctx, liveUUIDs); perr != nil {
			log.Printf("[remnawave] prune remna_users failed: %v", perr)
		} else if deleted > 0 {
			log.Printf("[remnawave] pruned %d stale remna_users rows", deleted)
		}
	}

	return nil
}

// syncHwidDevices fetches and caches HWID devices
func (s *SyncService) syncHwidDevices(ctx context.Context) error {
	devices := make(map[string][]HwidDevice)
	start := 0
	pageSize := 1000
	now := time.Now()

	// Track device count per user for updating user records
	userDeviceCounts := make(map[string]int)
	hwidBatch := make([]*RemnaHwidData, 0)

	for {
		resp, err := s.client.GetAllHwidDevices(ctx, start, pageSize)
		if err != nil {
			return err
		}

		for _, d := range resp.Devices {
			// New Remnawave responses identify the owner by numeric ID.
			// Translate it to the canonical internal UUID before caching/persisting.
			ownerKey := d.UserUUID
			if ownerKey == "" && d.UserID > 0 { ownerKey = strconv.FormatInt(d.UserID, 10) }
			if n, err := strconv.ParseInt(ownerKey, 10, 64); err == nil {
				s.mu.RLock()
				if user, ok := s.usersByID[n]; ok { ownerKey = user.UUID }
				s.mu.RUnlock()
			}
			if ownerKey == "" {
				log.Printf("[remnawave] skipping HWID %s with empty user id", d.Hwid)
				continue
			}
			// remna_hwid_devices.user_uuid is a real uuid column and the whole
			// snapshot is now written in a single transaction: one unresolvable
			// owner would abort the batch and drop every device. Skip it instead.
			if _, err := uuid.Parse(ownerKey); err != nil {
				log.Printf("[remnawave] skipping HWID %s: unresolved owner %q", d.Hwid, ownerKey)
				continue
			}
			d.UserUUID = ownerKey
			devices[ownerKey] = append(devices[ownerKey], d)
			userDeviceCounts[ownerKey]++

			// Build a batch for one transactional write after all pages arrive.
			if s.storage != nil {
				// Get username from cached users
				username := ""
				s.mu.RLock()
				if user, ok := s.users[d.UserUUID]; ok {
					username = user.Username
				}
				s.mu.RUnlock()

				hwidData := &RemnaHwidData{
					Hwid:         d.Hwid,
					UserUUID:     d.UserUUID,
					Username:     username,
					Platform:     d.Platform,
					OSVersion:    d.OSVersion,
					DeviceModel:  d.DeviceModel,
					AppVersion:   nil, // Not in API response
					FirstSeenAt:  d.CreatedAt,
					LastActiveAt: &d.UpdatedAt,
					SyncedAt:     now,
				}

				hwidBatch = append(hwidBatch, hwidData)
			}
		}

		if len(resp.Devices) < pageSize {
			break
		}
		start += pageSize
	}
	if s.storage != nil {
		if err := s.storage.UpsertRemnaHwidDevices(ctx, hwidBatch); err != nil {
			return fmt.Errorf("persist hwid batch: %w", err)
		}
	}

	s.mu.Lock()
	s.hwidDevices = devices
	s.mu.Unlock()

	return nil
}

// syncNodes fetches and persists node data
func (s *SyncService) syncNodes(ctx context.Context) error {
	if s.storage == nil {
		return nil // Skip if no storage configured
	}

	nodes, err := s.client.GetNodes(ctx)
	if err != nil {
		return err
	}

	now := time.Now()
	for _, node := range nodes {
		var port int
		var trafficTotal, trafficUsed int64
		var usersOnline int
		if node.Port != nil {
			port = *node.Port
		}
		if node.TrafficLimitBytes != nil {
			trafficTotal = *node.TrafficLimitBytes
		}
		if node.TrafficUsedBytes != nil {
			trafficUsed = *node.TrafficUsedBytes
		}
		if node.UsersOnline != nil {
			usersOnline = *node.UsersOnline
		}

		nodeData := &RemnaNodeData{
			UUID:           node.UUID,
			Name:           node.Name,
			Address:        node.Address,
			Port:           port,
			IsConnected:    node.IsConnected,
			IsDisabled:     node.IsDisabled,
			IsTrafficTrack: false, // Поля нет в API
			TrafficTotal:   trafficTotal,
			TrafficUsed:    trafficUsed,
			UsersOnline:    usersOnline,
			CountryCode:    node.CountryCode,
			Tags:           node.Tags,
			SyncedAt:       now,
		}

		if err := s.storage.UpsertRemnaNode(ctx, nodeData); err != nil {
			log.Printf("[remnawave] failed to persist node %s: %v", node.Name, err)
		}
	}

	return nil
}

// countHwidDevices returns total number of HWID devices
func (s *SyncService) countHwidDevices() int {
	s.mu.RLock()
	defer s.mu.RUnlock()

	count := 0
	for _, devices := range s.hwidDevices {
		count += len(devices)
	}
	return count
}

// GetUserByUUID returns a cached user by UUID
func (s *SyncService) GetUserByUUID(uuid string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.users[uuid]
}

// GetUserByEmail returns a cached user by email
func (s *SyncService) GetUserByEmail(email string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.usersByEmail[normalizeEmail(email)]
}

// GetUserByUsername returns a cached user by username
func (s *SyncService) GetUserByUsername(username string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.usersByUsername[username]
}

// GetUserByID returns a cached user by numeric ID
func (s *SyncService) GetUserByID(id int64) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.usersByID[id]
}

// GetUserByIDOrUsername returns a user by UUID, numeric ID, or username.
// After the schema v2 refactor, storage tables hold user_email as a real
// Remnawave UUID (resolved via remna_users.id/us_id at write time), so the
// UUID lookup path is the common case.
func (s *SyncService) GetUserByIDOrUsername(idOrUsername string) *User {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Try as UUID first (post-v2 storage path)
	if user := s.users[idOrUsername]; user != nil {
		return user
	}

	// Try as numeric ID
	if id, err := strconv.ParseInt(idOrUsername, 10, 64); err == nil {
		if user := s.usersByID[id]; user != nil {
			return user
		}
	}

	// Try as username
	return s.usersByUsername[idOrUsername]
}

// ResolveUsername resolves a numeric ID or username to the actual username
// If the input is a numeric ID, it looks up the username via Remnawave API
// If the input already looks like a username, returns it as-is
func (s *SyncService) ResolveUsername(ctx context.Context, idOrUsername string) string {
	// Try local cache first (usersByID)
	if user := s.GetUserByIDOrUsername(idOrUsername); user != nil {
		return user.Username
	}

	// Fallback to idCache (makes API calls if needed)
	if s.idCache != nil {
		return s.idCache.GetUsername(ctx, idOrUsername)
	}
	return idOrUsername
}

// ResolveUsernames resolves multiple IDs/usernames at once
func (s *SyncService) ResolveUsernames(ctx context.Context, ids []string) map[string]string {
	result := make(map[string]string)

	for _, id := range ids {
		// Try local cache first
		if user := s.GetUserByIDOrUsername(id); user != nil {
			result[id] = user.Username
		} else if s.idCache != nil {
			result[id] = s.idCache.GetUsername(ctx, id)
		} else {
			result[id] = id
		}
	}

	return result
}

// GetIDCacheStats returns ID cache statistics
func (s *SyncService) GetIDCacheStats() (cached, notFound int) {
	if s.idCache == nil {
		return 0, 0
	}
	return s.idCache.Stats()
}

// GetUserHwidDevices returns cached HWID devices for a user
func (s *SyncService) GetUserHwidDevices(userUUID string) []HwidDevice {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hwidDevices[userUUID]
}

// ClearUserHwidDevices deletes all HWID devices for a user via API and updates cache
func (s *SyncService) ClearUserHwidDevices(ctx context.Context, userUUID string) error {
	log.Printf("[remnawave] ClearUserHwidDevices called for user %s", userUUID)

	// Call API to delete all HWID devices
	resp, err := s.client.DeleteAllUserHwidDevices(ctx, userUUID)
	if err != nil {
		log.Printf("[remnawave] ERROR clearing HWID devices for user %s: %v", userUUID, err)
		return err
	}

	log.Printf("[remnawave] API response: total=%d devices remaining", resp.Total)

	// Update local cache
	s.mu.Lock()
	delete(s.hwidDevices, userUUID)
	s.mu.Unlock()

	log.Printf("[remnawave] cleared all HWID devices for user %s", userUUID)
	return nil
}

// GetAllUsers returns all cached users
func (s *SyncService) GetAllUsers() []*User {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*User, 0, len(s.users))
	for _, u := range s.users {
		result = append(result, u)
	}
	return result
}

// GetLastSyncTime returns the time of the last successful sync
func (s *SyncService) GetLastSyncTime() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastSync
}

// SyncHealth describes whether the Remnawave integration is actually working,
// as opposed to merely being configured.
type SyncHealth struct {
	Configured bool      `json:"configured"`
	Status     string    `json:"status"` // disabled | loading | online | offline
	LastSync   time.Time `json:"last_sync"`
	TotalUsers int       `json:"total_users"`
}

// staleAfter is how long the integration may go without a successful sync
// before it counts as offline: three intervals, floored at five minutes so a
// short interval cannot make the indicator flap.
func (s *SyncService) staleAfter() time.Duration {
	d := 3 * s.syncInterval
	if d < 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

// Health reports integration health.
//
// An empty user cache is NOT evidence that the panel is unreachable: right
// after a restart the first sync has simply not finished yet. Treating that as
// "offline" is what made the dashboard announce a dead Remnawave API on every
// restart, so the two cases are kept apart here — "loading" until the first
// sync lands, "offline" only once a sync is genuinely overdue.
func (s *SyncService) Health() SyncHealth {
	s.mu.RLock()
	lastSync := s.lastSync
	users := len(s.users)
	s.mu.RUnlock()

	h := SyncHealth{
		Configured: s.client.IsConfigured(),
		LastSync:   lastSync,
		TotalUsers: users,
	}
	switch {
	case !h.Configured || !s.isEnabled():
		h.Status = "disabled"
	case lastSync.IsZero():
		h.Status = "loading"
	case time.Since(lastSync) > s.staleAfter():
		h.Status = "offline"
	default:
		h.Status = "online"
	}
	return h
}

// GetStats returns sync service statistics
func (s *SyncService) GetStats() SyncStats {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return SyncStats{
		TotalUsers:       len(s.users),
		TotalHwidDevices: s.countHwidDevicesUnsafe(),
		LastSync:         s.lastSync,
		IsConfigured:     s.client.IsConfigured(),
	}
}

func (s *SyncService) countHwidDevicesUnsafe() int {
	count := 0
	for _, devices := range s.hwidDevices {
		count += len(devices)
	}
	return count
}

// UserHwidCount represents a user with their HWID device count
type UserHwidCount struct {
	User        *User
	DeviceCount int
	Devices     []HwidDevice
}

// GetTopUsersByHwid returns users sorted by HWID device count (descending)
func (s *SyncService) GetTopUsersByHwid(limit int) []UserHwidCount {
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Build list of users with their device counts
	var result []UserHwidCount
	for userUUID, devices := range s.hwidDevices {
		if len(devices) == 0 {
			continue
		}
		user := s.users[userUUID]
		if user == nil {
			continue
		}
		result = append(result, UserHwidCount{
			User:        user,
			DeviceCount: len(devices),
			Devices:     devices,
		})
	}

	// Sort by device count descending
	for i := 0; i < len(result)-1; i++ {
		for j := i + 1; j < len(result); j++ {
			if result[j].DeviceCount > result[i].DeviceCount {
				result[i], result[j] = result[j], result[i]
			}
		}
	}

	// Limit results
	if limit > 0 && len(result) > limit {
		result = result[:limit]
	}

	return result
}

// SyncStats represents sync service statistics
type SyncStats struct {
	TotalUsers       int       `json:"total_users"`
	TotalHwidDevices int       `json:"total_hwid_devices"`
	LastSync         time.Time `json:"last_sync"`
	IsConfigured     bool      `json:"is_configured"`
}

// normalizeEmail converts email to lowercase for comparison
func normalizeEmail(email string) string {
	return email
}
