package storage

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/xray-log-analyzer/server/internal/models"
)

// RequestEvent is one immutable Xray access-log entry. It is intentionally
// separate from user_stats/user_destinations so the existing aggregation path
// and dashboard behaviour remain unchanged.
type RequestEvent struct {
	Timestamp   time.Time `json:"timestamp"`
	NodeID      string    `json:"node_id"`
	UserEmail   string    `json:"user_email"`
	SourceIP    string    `json:"source_ip"`
	SourcePort  int       `json:"source_port"`
	Protocol    string    `json:"protocol"`
	Destination string    `json:"destination"`
	Inbound     string    `json:"inbound"`
	Outbound    string    `json:"outbound"`
	Status      string    `json:"status"`
}

// RecordRequestEvents appends every entry from an agent batch to the dedicated
// chronology table. User and node identifiers are resolved once per batch.
func (s *Storage) RecordRequestEvents(ctx context.Context, nodeID string, entries []models.LogEntry) error {
	if len(entries) == 0 {
		return nil
	}
	nid, err := s.LookupNodeID(ctx, nodeID, "exit")
	if err != nil {
		return fmt.Errorf("resolve request-event node: %w", err)
	}

	resolved := make(map[string]uuid.UUID)
	rows := make([][]any, 0, len(entries))
	for _, entry := range entries {
		uid, ok := resolved[entry.UserEmail]
		if !ok {
			uid, err = s.ResolveUserEmailToUUID(ctx, entry.UserEmail)
			if err != nil {
				return fmt.Errorf("resolve request-event user: %w", err)
			}
			resolved[entry.UserEmail] = uid
		}
		ts := entry.Timestamp
		if ts.IsZero() {
			ts = time.Now().UTC()
		}
		rows = append(rows, []any{
			int16(nid), uid, nilIfEmpty(entry.SourceIP), entry.SourcePort,
			entry.Protocol, entry.Destination, entry.Inbound, entry.Outbound,
			entry.Status, ts.UTC(),
		})
	}

	_, err = s.pool.CopyFrom(ctx, pgx.Identifier{"request_events"}, []string{
		"node_id", "user_email", "source_ip", "source_port", "protocol",
		"destination", "inbound", "outbound", "status", "ts",
	}, pgx.CopyFromRows(rows))
	if err != nil {
		return fmt.Errorf("copy request events: %w", err)
	}
	return nil
}

func nilIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}

// GetRequestEvents returns newest-first chronology for the selected user.
func (s *Storage) GetRequestEvents(ctx context.Context, user string, since time.Time, limit int) ([]RequestEvent, error) {
	uid, err := s.ResolveUserEmailToUUID(ctx, user)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.ts, n.node_id, e.user_email::text, COALESCE(e.source_ip::text,''),
		       COALESCE(e.source_port,0), COALESCE(e.protocol,''), e.destination,
		       COALESCE(e.inbound,''), COALESCE(e.outbound,''), COALESCE(e.status,'')
		FROM request_events e
		JOIN nodes n ON n.id = e.node_id
		WHERE e.user_email = $1 AND e.ts >= $2
		ORDER BY e.ts DESC
		LIMIT $3`, uid, since.UTC(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make([]RequestEvent, 0, limit)
	for rows.Next() {
		var event RequestEvent
		if err := rows.Scan(&event.Timestamp, &event.NodeID, &event.UserEmail,
			&event.SourceIP, &event.SourcePort, &event.Protocol, &event.Destination,
			&event.Inbound, &event.Outbound, &event.Status); err != nil {
			return nil, err
		}
		result = append(result, event)
	}
	return result, rows.Err()
}

// StreamRequestEvents iterates oldest-first for stable CSV export without
// loading a potentially large 30-day result into server memory.
func (s *Storage) StreamRequestEvents(ctx context.Context, user string, since time.Time, fn func(RequestEvent) error) error {
	uid, err := s.ResolveUserEmailToUUID(ctx, user)
	if err != nil {
		return err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.ts, n.node_id, e.user_email::text, COALESCE(e.source_ip::text,''),
		       COALESCE(e.source_port,0), COALESCE(e.protocol,''), e.destination,
		       COALESCE(e.inbound,''), COALESCE(e.outbound,''), COALESCE(e.status,'')
		FROM request_events e
		JOIN nodes n ON n.id = e.node_id
		WHERE e.user_email = $1 AND e.ts >= $2
		ORDER BY e.ts ASC`, uid, since.UTC())
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var event RequestEvent
		if err := rows.Scan(&event.Timestamp, &event.NodeID, &event.UserEmail,
			&event.SourceIP, &event.SourcePort, &event.Protocol, &event.Destination,
			&event.Inbound, &event.Outbound, &event.Status); err != nil {
			return err
		}
		if err := fn(event); err != nil {
			return err
		}
	}
	return rows.Err()
}
