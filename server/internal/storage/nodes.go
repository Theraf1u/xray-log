package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/xray-log-analyzer/server/internal/models"
	"strings"
)

// LookupNodeID resolves a text node_id (e.g. "ru-bridge") to its smallint
// primary key in the nodes table, inserting a new row if it does not yet exist.
// The returned NodeID is always non-zero on success.
//
// Memoized via Storage.nodeIDCache: a hit avoids hitting the database
// entirely. Cache misses do a plain SELECT first; only genuinely new nodes
// take the INSERT path. Avoiding ON CONFLICT keeps the smallint identity
// sequence from burning under high call rates (one batch from agents
// triggers many LookupNodeID calls).
func (s *Storage) LookupNodeID(ctx context.Context, nodeID, role string) (NodeID, error) {
	if nodeID == "" {
		return 0, fmt.Errorf("empty node_id")
	}
	if role == "" {
		role = "exit"
	}

	// Cache lookup.
	s.nodeIDCacheMu.RLock()
	if id, ok := s.nodeIDCache[nodeID]; ok {
		s.nodeIDCacheMu.RUnlock()
		return id, nil
	}
	s.nodeIDCacheMu.RUnlock()

	// Cache miss — SELECT to check whether the row already exists.
	var id int16
	err := s.pool.QueryRow(ctx, `SELECT id FROM nodes WHERE node_id = $1`, nodeID).Scan(&id)
	if err == nil {
		s.cacheNodeID(nodeID, NodeID(id))
		return NodeID(id), nil
	}
	// Unexpected SELECT errors (other than no rows) bubble up as lookup
	// failures. pgx returns ErrNoRows for missing rows.
	if err.Error() != "no rows in result set" {
		// Continue to INSERT — likely just a fresh node. If INSERT
		// itself fails we'll surface that error.
	}

	// Genuinely new node — INSERT once. Don't UPDATE on conflict (avoids
	// burning the identity sequence under repeated calls with the same
	// node_id during a race).
	err = s.pool.QueryRow(ctx, `
		INSERT INTO nodes (node_id, role)
		VALUES ($1, $2)
		ON CONFLICT (node_id) DO NOTHING
		RETURNING id
	`, nodeID, role).Scan(&id)
	if err != nil {
		// Conflict path: the row was inserted by a concurrent caller
		// between our SELECT and INSERT. Re-SELECT to fetch it.
		if err.Error() == "no rows in result set" {
			if serr := s.pool.QueryRow(ctx, `SELECT id FROM nodes WHERE node_id = $1`, nodeID).Scan(&id); serr == nil {
				s.cacheNodeID(nodeID, NodeID(id))
				return NodeID(id), nil
			} else {
				return 0, fmt.Errorf("lookup node %s after conflict: %w", nodeID, serr)
			}
		}
		return 0, fmt.Errorf("lookup node %s: %w", nodeID, err)
	}
	s.cacheNodeID(nodeID, NodeID(id))
	return NodeID(id), nil
}

func (s *Storage) cacheNodeID(nodeID string, id NodeID) {
	s.nodeIDCacheMu.Lock()
	s.nodeIDCache[nodeID] = id
	s.nodeIDCacheMu.Unlock()
}

// evictNodeID drops a node_id from the in-memory smallint-id cache. Called
// on delete so that if the same node_id is ever re-added, LookupNodeID does
// a fresh SELECT/INSERT instead of serving a stale id for a row that no
// longer exists.
func (s *Storage) evictNodeID(nodeID string) {
	s.nodeIDCacheMu.Lock()
	delete(s.nodeIDCache, nodeID)
	s.nodeIDCacheMu.Unlock()
}

// UpdateNodeStats updates statistics for a node
func (s *Storage) UpdateNodeStats(ctx context.Context, nodeID string, requests int, blacklistHits int, batchCount int) error {
	if nodeID == "" {
		return fmt.Errorf("empty node_id")
	}
	now := time.Now().UTC()
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO node_stats (node_id, total_requests, blacklist_hits, last_seen, last_batch_time, last_batch_count)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (node_id) DO UPDATE SET
			total_requests = node_stats.total_requests + EXCLUDED.total_requests,
			blacklist_hits = node_stats.blacklist_hits + EXCLUDED.blacklist_hits,
			last_seen = EXCLUDED.last_seen,
			last_batch_time = EXCLUDED.last_batch_time,
			last_batch_count = EXCLUDED.last_batch_count
	`, nodeID, requests, blacklistHits, now, now, batchCount)
	return err
}

// UpdateNodeUniqueUsers updates unique users count for a node
func (s *Storage) UpdateNodeUniqueUsers(ctx context.Context, nodeID string) error {
	// user_stats.node_id is smallint FK; resolve text → id first.
	nid, err := s.LookupNodeID(ctx, nodeID, "exit")
	if err != nil {
		return nil // node not registered yet — nothing to update
	}
	_, err = s.pool.Exec(ctx, `
		UPDATE node_stats
		SET unique_users = (SELECT COUNT(DISTINCT user_email) FROM user_stats WHERE node_id = $1)
		WHERE node_id = $2
	`, int16(nid), nodeID)
	return err
}

// GetNodeStats gets statistics for all nodes (cached)
func (s *Storage) GetNodeStats(ctx context.Context) ([]*models.NodeStats, error) {
	cacheKey := "node_stats"

	if cached, found := s.cache.Get(cacheKey); found {
		return cached.([]*models.NodeStats), nil
	}

	// Access-log fallback window: 5 min tolerates WS flaps (30-60s) and
	// is used when the node has no Remnawave mapping or Remnawave isn't
	// synced yet.
	windowAgo := time.Now().UTC().Add(-5 * time.Minute)

	// user_stats.node_id is a smallint FK into nodes(id), while node_stats.node_id is text.
	// Bridge through the nodes table so the types are compatible.
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			ns.node_id,
			ns.total_requests,
			ns.blacklist_hits,
			ns.unique_users,
			COALESCE(online.cnt, 0) AS online_users,
			ns.last_seen,
			ns.last_batch_time,
			ns.last_batch_count,
			rn.name,
			rn.address,
			rn.port,
			rn.country_code,
			rn.traffic_used,
			rn.traffic_total,
			rn.is_disabled,
			rn.is_connected,
			COALESCE(rn.tags::text, '{}')
		FROM node_stats ns
		LEFT JOIN (
			SELECT nd.node_id AS node_text_id, COUNT(DISTINCT us.user_email) AS cnt
			FROM user_stats us
			JOIN nodes nd ON nd.id = us.node_id
			WHERE us.last_seen > $1
			GROUP BY nd.node_id
		) online ON online.node_text_id = ns.node_id
		LEFT JOIN node_remna_map m ON m.node_id = ns.node_id
		LEFT JOIN remna_nodes rn ON rn.uuid = m.remna_uuid
		ORDER BY ns.total_requests DESC
	`, windowAgo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var nodes []*models.NodeStats
	for rows.Next() {
		n := &models.NodeStats{}
		var lastSeen, lastBatch *time.Time
		var remnaIsDisabledInt, remnaIsConnectedInt *int
		var tagsRaw string
		err := rows.Scan(
			&n.NodeID, &n.TotalRequests, &n.BlacklistHits, &n.UniqueUsers, &n.OnlineUsers,
			&lastSeen, &lastBatch, &n.LastBatchCount,
			&n.RemnaName, &n.RemnaAddress, &n.RemnaPort, &n.RemnaCountryCode,
			&n.RemnaTrafficUsed, &n.RemnaTrafficTotal, &remnaIsDisabledInt, &remnaIsConnectedInt, &tagsRaw,
		)
		if err != nil {
			return nil, err
		}
		if lastSeen != nil {
			n.LastSeen = *lastSeen
		}
		if lastBatch != nil {
			n.LastBatchTime = *lastBatch
		}
		if remnaIsDisabledInt != nil {
			disabled := *remnaIsDisabledInt != 0
			n.RemnaIsDisabled = &disabled
		}
		if remnaIsConnectedInt != nil {
			connected := *remnaIsConnectedInt != 0
			n.RemnaIsConnected = &connected
		}
		n.RemnaTags = parsePGTextArray(tagsRaw)
		nodes = append(nodes, n)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Enrich with Remnawave's XTLS-level online count. Prefer it over the
	// access-log heuristic: Xray reports real active sessions, the log
	// approach undercounts whenever an agent's WebSocket flaps.
	if len(s.nodeRemnaMap) > 0 {
		remna, err := s.remnaOnlineCounts(ctx)
		if err == nil {
			for _, n := range nodes {
				if name, ok := s.nodeRemnaMap[n.NodeID]; ok {
					if cnt, ok := remna[name]; ok {
						n.OnlineUsers = cnt
					}
				}
			}
		}
	}

	s.cache.Set(cacheKey, nodes, CacheTTLShort)
	return nodes, nil
}

// remnaOnlineCounts returns a map of remnawave-node-name → users_online
// from the synced remna_nodes table. Fast, indexed, read-only.
func (s *Storage) remnaOnlineCounts(ctx context.Context) (map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT name, users_online FROM remna_nodes`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]int)
	for rows.Next() {
		var name string
		var cnt int
		if err := rows.Scan(&name, &cnt); err == nil {
			out[name] = cnt
		}
	}
	return out, nil
}

// DeleteNode removes a node and all its related data
func (s *Storage) DeleteNode(ctx context.Context, nodeID string) error {
	// Resolve text node_id to the smallint FK used in child tables.
	// If the node doesn't exist in nodes table yet, nothing to cascade.
	var nid int16
	_ = s.pool.QueryRow(ctx, `SELECT id FROM nodes WHERE node_id = $1`, nodeID).Scan(&nid)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	// Tables that reference nodes(id) as smallint FK — use resolved id.
	if nid > 0 {
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_stats WHERE node_id = $1", nid); err != nil {
			tx.Rollback()
			return fmt.Errorf("delete user_stats: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM blacklist_matches WHERE node_id = $1", nid); err != nil {
			tx.Rollback()
			return fmt.Errorf("delete blacklist_matches: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM alerts WHERE node_id = $1", nid); err != nil {
			tx.Rollback()
			return fmt.Errorf("delete alerts: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM hourly_stats WHERE node_id = $1", nid); err != nil {
			tx.Rollback()
			return fmt.Errorf("delete hourly_stats: %w", err)
		}
	}

	// node_stats uses text node_id as PK.
	if _, err := tx.ExecContext(ctx, "DELETE FROM node_stats WHERE node_id = $1", nodeID); err != nil {
		tx.Rollback()
		return fmt.Errorf("delete node_stats: %w", err)
	}

	// A "deleted" node must actually stay gone: also drop the panel link
	// (node_remna_map) and tombstone the node_id. Without the tombstone, an agent that's still running just
	// reconnects with the same node_id and UpdateNodeStats's upsert
	// resurrects the row within seconds — this was reported as "delete
	// does nothing". The WS handshake (handleWebSocket) checks the
	// tombstone and refuses the connection, so even a still-running agent
	// can't repopulate it. Re-adding the same node_id via any of the three
	// add-node flows removes the tombstone (see UnlinkNodeRemna / LinkNodeRemna).
	if _, err := tx.ExecContext(ctx, "DELETE FROM node_remna_map WHERE node_id = $1", nodeID); err != nil {
		tx.Rollback()
		return fmt.Errorf("delete node_remna_map: %w", err)
	}
	// Deliberately NOT deleting the nodes row itself: a dozen+ tables
	// (bridged_flows, request_events, threat_matches, user_destinations,
	// etc.) carry FK REFERENCES nodes(id), and this list grows over time.
	// Trying to cascade all of them here is exactly the kind of thing that
	// silently breaks again the next time someone adds a table. The
	// tombstone below is what actually blocks the node from coming back;
	// the orphaned nodes/smallint-id row is harmless historical metadata.
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO deleted_node_ids (node_id) VALUES ($1)
		ON CONFLICT (node_id) DO UPDATE SET deleted_at = now()
	`, nodeID); err != nil {
		tx.Rollback()
		return fmt.Errorf("tombstone node_id: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	s.evictNodeID(nodeID)
	return nil
}

// NodeIsDeleted reports whether nodeID was tombstoned by DeleteNode. Used by
// the WS handshake to refuse connections from a node_id that was explicitly
// deleted — otherwise a still-running agent reconnects on its own and its
// next batch resurrects the "deleted" node within seconds.
func (s *Storage) NodeIsDeleted(ctx context.Context, nodeID string) (bool, error) {
	var deleted bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM deleted_node_ids WHERE node_id = $1)`, nodeID).Scan(&deleted)
	return deleted, err
}

// ClearNodeTombstone removes nodeID from deleted_node_ids, if present.
// Called whenever a node_id is (re-)linked to a panel node — via
// LinkNodeRemna or ApprovePairingRequest — so re-adding a previously-deleted
// node_id under the same name works immediately instead of the agent being
// silently refused forever by the WS handshake's tombstone check.
func (s *Storage) ClearNodeTombstone(ctx context.Context, nodeID string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM deleted_node_ids WHERE node_id = $1", nodeID)
	return err
}

// CleanupInactiveNodes removes only the transient dashboard status for nodes
// that haven't been seen for a while. Historical traffic, alerts, matches and
// aggregates must remain available even when a node is retired or offline.
func (s *Storage) CleanupInactiveNodes(ctx context.Context, olderThan time.Duration) (int, error) {
	cutoff := time.Now().Add(-olderThan)
	result, err := s.db.ExecContext(ctx, `
		DELETE FROM node_stats WHERE last_seen < $1
	`, cutoff)
	if err != nil {
		return 0, err
	}
	removed, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(removed), nil
}

// RemnaNodeOption is a lightweight projection of remna_nodes for the
// node-linking picker in the admin UI.
type RemnaNodeOption struct {
	UUID         string   `json:"uuid"`
	Name         string   `json:"name"`
	Address      string   `json:"address"`
	Port         int      `json:"port"`
	CountryCode  string   `json:"country_code"`
	IsDisabled   bool     `json:"is_disabled"`
	IsConnected  bool     `json:"is_connected"` // panel's own view of this node's health
	TrafficUsed  int64    `json:"traffic_used"`
	TrafficTotal int64    `json:"traffic_total"` // 0 means unlimited
	UsersOnline  int      `json:"users_online"`
	Tags         []string `json:"tags"`
	LinkedTo     *string  `json:"linked_to,omitempty"` // node_id this uuid is already linked to, if any
}

// ListRemnaNodeOptions returns every synced Remnawave panel node for the
// manual link picker, including which analyzer node_id (if any) it's
// already linked to so the UI can show that instead of offering a second
// link to the same panel node. Whether that linked agent is *actually*
// connected right now is filled in by the caller (handleRemnaNodesList),
// which has access to the live WebSocket client map — this layer only
// knows what's in Postgres.
func (s *Storage) ListRemnaNodeOptions(ctx context.Context) ([]*RemnaNodeOption, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT rn.uuid, rn.name, rn.address, rn.port, rn.country_code, rn.is_disabled,
		       rn.is_connected, rn.traffic_used, rn.traffic_total, rn.users_online, rn.tags,
		       m.node_id
		FROM remna_nodes rn
		LEFT JOIN node_remna_map m ON m.remna_uuid = rn.uuid
		ORDER BY rn.name
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// See ListPendingPairingRequests for why this is []*T{} and not a nil
	// var: nil encodes to JSON null, and both callers of this endpoint
	// (LinkNodeSheet and AddNodeDialog) call .filter()/array methods on
	// the response with no null guard.
	out := []*RemnaNodeOption{}
	for rows.Next() {
		o := &RemnaNodeOption{}
		var isDisabledInt, isConnectedInt int
		var tagsRaw string
		var linkedNodeID *string
		if err := rows.Scan(
			&o.UUID, &o.Name, &o.Address, &o.Port, &o.CountryCode, &isDisabledInt,
			&isConnectedInt, &o.TrafficUsed, &o.TrafficTotal, &o.UsersOnline, &tagsRaw,
			&linkedNodeID,
		); err != nil {
			return nil, err
		}
		o.IsDisabled = isDisabledInt != 0
		o.IsConnected = isConnectedInt != 0
		o.Tags = parsePGTextArray(tagsRaw)
		o.LinkedTo = linkedNodeID
		out = append(out, o)
	}
	return out, rows.Err()
}

// parsePGTextArray decodes Postgres's text[] wire literal ("{a,b,c}") as
// returned by a plain database/sql Scan into a []string. The pgx stdlib
// driver used here (via s.db, a *sql.DB) hands back array columns as this
// raw literal string rather than a Go slice when scanned through the
// generic database/sql path — going through lib/pq's pq.Array() wrapper
// just for one column wasn't worth a new dependency, so this parses the
// simple case directly. Tag names are plain identifiers with no commas,
// braces, or quotes, so no escaping/quoting logic is needed.
func parsePGTextArray(raw string) []string {
	raw = strings.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '{' || raw[len(raw)-1] != '}' {
		return nil
	}
	inner := raw[1 : len(raw)-1]
	if inner == "" {
		return nil
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.Trim(p, `" `)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// LinkNodeRemna records an admin-approved link from an agent node_id to a
// Remnawave panel node uuid. One node_id maps to at most one panel node
// (PRIMARY KEY on node_id); re-linking overwrites the previous choice.
func (s *Storage) LinkNodeRemna(ctx context.Context, nodeID, remnaUUID string) error {
	if nodeID == "" || remnaUUID == "" {
		return fmt.Errorf("node_id and remna_uuid are required")
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO node_remna_map (node_id, remna_uuid, linked_at)
		VALUES ($1, $2, now())
		ON CONFLICT (node_id) DO UPDATE SET
			remna_uuid = EXCLUDED.remna_uuid,
			linked_at = EXCLUDED.linked_at
	`, nodeID, remnaUUID); err != nil {
		return err
	}
	return s.ClearNodeTombstone(ctx, nodeID)
}

// UnlinkNodeRemna removes a previously approved node_id -> panel node link.
func (s *Storage) UnlinkNodeRemna(ctx context.Context, nodeID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM node_remna_map WHERE node_id = $1`, nodeID)
	return err
}

// UpdateNodeConnectIP records the real source IP of an agent's latest
// WebSocket handshake (see nodes.last_connect_ip in schema.sql). Best-effort:
// callers log but don't fail the connection on error.
func (s *Storage) UpdateNodeConnectIP(ctx context.Context, nodeID, ip string) error {
	if nodeID == "" || ip == "" {
		return nil
	}
	nid, err := s.LookupNodeID(ctx, nodeID, "exit")
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `UPDATE nodes SET last_connect_ip = $1 WHERE id = $2`, ip, int16(nid))
	return err
}

// NodeLiveView is the fast-changing subset of a node's Remnawave telemetry,
// for the ~1s poll used by the nodes page (see UpdateRemnaNodeLive for the
// write side). Deliberately excludes everything that doesn't change every
// second (name, address, tags) so this query and its payload stay tiny.
type NodeLiveView struct {
	NodeID           string  `json:"node_id"`
	RemnaIsConnected bool    `json:"remna_is_connected"`
	RemnaIsDisabled  bool    `json:"remna_is_disabled"`
	UsersOnline      int     `json:"remna_users_online"`
	XrayUptime       float64 `json:"xray_uptime_seconds"`
	RxBytesPerSec    float64 `json:"rx_bytes_per_sec"`
	TxBytesPerSec    float64 `json:"tx_bytes_per_sec"`
}

// GetNodesLive returns live telemetry for every agent node_id that's
// linked to a Remnawave panel node, keyed for the frontend's 1s poll.
// Deliberately uncached (unlike GetNodeStats) — a 10s cache would defeat
// the point of polling every second.
func (s *Storage) GetNodesLive(ctx context.Context) ([]*NodeLiveView, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.node_id, rn.is_connected, rn.is_disabled, rn.users_online,
		       rn.xray_uptime_seconds, rn.rx_bytes_per_sec, rn.tx_bytes_per_sec
		FROM node_remna_map m
		JOIN remna_nodes rn ON rn.uuid = m.remna_uuid
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Same reasoning as ListRemnaNodeOptions/ListPendingPairingRequests:
	// nodes-table.tsx does `new Map(data.map(...))` on this response with
	// no null guard, so an empty result must stay a JSON array, not null.
	out := []*NodeLiveView{}
	for rows.Next() {
		v := &NodeLiveView{}
		var isConnectedInt, isDisabledInt int
		if err := rows.Scan(
			&v.NodeID, &isConnectedInt, &isDisabledInt, &v.UsersOnline,
			&v.XrayUptime, &v.RxBytesPerSec, &v.TxBytesPerSec,
		); err != nil {
			return nil, err
		}
		v.RemnaIsConnected = isConnectedInt != 0
		v.RemnaIsDisabled = isDisabledInt != 0
		out = append(out, v)
	}
	return out, rows.Err()
}

// NodeIDForRemnaUUID returns the node_id already linked to this Remnawave
// panel node, if any. Used by the "add node from panel" flow to make
// picking the same panel tile twice idempotent (reuse the existing link
// and command) instead of creating a second, orphaned node_id.
func (s *Storage) NodeIDForRemnaUUID(ctx context.Context, remnaUUID string) (string, error) {
	var nodeID string
	err := s.db.QueryRowContext(ctx, `SELECT node_id FROM node_remna_map WHERE remna_uuid = $1`, remnaUUID).Scan(&nodeID)
	return nodeID, err
}

// NodeIDTaken checks both places a node_id could already exist: linked
// (node_remna_map) or previously seen from a live agent (nodes) — a
// generated slug must avoid both, not just one, or "add node from panel"
// could silently steal an ID some other already-connected agent is using.
func (s *Storage) NodeIDTaken(ctx context.Context, nodeID string) (bool, error) {
	var taken bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM node_remna_map WHERE node_id = $1)
		    OR EXISTS(SELECT 1 FROM nodes WHERE node_id = $1)
	`, nodeID).Scan(&taken)
	return taken, err
}

// RemnaNodeBasic is the minimal projection needed to derive a node_id slug
// from a panel node's name.
type RemnaNodeBasic struct {
	Name       string
	IsDisabled bool
}

// GetRemnaNodeBasic looks up a single panel node by uuid.
func (s *Storage) GetRemnaNodeBasic(ctx context.Context, remnaUUID string) (*RemnaNodeBasic, error) {
	b := &RemnaNodeBasic{}
	var isDisabledInt int
	err := s.db.QueryRowContext(ctx, `SELECT name, is_disabled FROM remna_nodes WHERE uuid = $1`, remnaUUID).
		Scan(&b.Name, &isDisabledInt)
	if err != nil {
		return nil, err
	}
	b.IsDisabled = isDisabledInt != 0
	return b, nil
}

// PairingRequest is one row of node_pairing_requests — see schema.sql for
// the full flow (a fresh node requests a code before it has credentials,
// the admin approves it against a panel node, the node polls until
// approved).
type PairingRequest struct {
	Code      string
	Hint      string
	NodeID    *string
	Approved  bool
	CreatedAt time.Time
	ExpiresAt time.Time
}

// CreatePairingRequest inserts a new pending code. Caller (the HTTP
// handler) is responsible for generating a code that doesn't collide —
// this just does the INSERT.
func (s *Storage) CreatePairingRequest(ctx context.Context, code, hint string, expiresAt time.Time) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO node_pairing_requests (code, hint, expires_at) VALUES ($1, $2, $3)
	`, code, hint, expiresAt)
	return err
}

// GetPairingRequest fetches one code's current state, or nil if it doesn't
// exist. Expiry is checked by the caller (still returning an expired row
// lets the admin's "pending" list explain *why* a code stopped working
// instead of it just silently vanishing).
func (s *Storage) GetPairingRequest(ctx context.Context, code string) (*PairingRequest, error) {
	p := &PairingRequest{}
	var approvedInt int
	err := s.db.QueryRowContext(ctx, `
		SELECT code, hint, node_id, approved, created_at, expires_at
		FROM node_pairing_requests WHERE code = $1
	`, code).Scan(&p.Code, &p.Hint, &p.NodeID, &approvedInt, &p.CreatedAt, &p.ExpiresAt)
	if err != nil {
		return nil, err
	}
	p.Approved = approvedInt != 0
	return p, nil
}

// ListPendingPairingRequests returns not-yet-approved, not-yet-expired
// codes for the admin's "Add node" picker.
func (s *Storage) ListPendingPairingRequests(ctx context.Context) ([]*PairingRequest, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT code, hint, node_id, approved, created_at, expires_at
		FROM node_pairing_requests
		WHERE approved = 0 AND expires_at > now()
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Initialized, not nil: encoding/json turns a nil slice into JSON
	// null, and the frontend does `.length` on this straight off the
	// response — an empty *array* is a valid state here (no pending
	// codes), a null response isn't something that call site expects.
	out := []*PairingRequest{}
	for rows.Next() {
		p := &PairingRequest{}
		var approvedInt int
		if err := rows.Scan(&p.Code, &p.Hint, &p.NodeID, &approvedInt, &p.CreatedAt, &p.ExpiresAt); err != nil {
			return nil, err
		}
		p.Approved = approvedInt != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

// ApprovePairingRequest stamps a code with the node_id the admin picked
// for it. The waiting node's next poll (GetPairingRequest) sees Approved
// and NodeID set and writes its own .env from that.
func (s *Storage) ApprovePairingRequest(ctx context.Context, code, nodeID string) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE node_pairing_requests SET node_id = $1, approved = 1
		WHERE code = $2 AND expires_at > now() AND approved = 0
	`, nodeID, code)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("pairing code not found, expired, or already approved")
	}
	return nil
}
