package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

// serviceState is one row of the header status strip. Status is the only field
// the UI branches on; the rest is context for the tooltip.
type serviceState struct {
	Status     string `json:"status"` // online | offline | warning | loading | disabled
	Detail     string `json:"detail,omitempty"`
	Indicators int    `json:"indicators,omitempty"`
	TotalUsers int    `json:"total_users,omitempty"`
	LastSync   string `json:"last_sync,omitempty"`
}

// ServicesHealthResponse backs the status tiles in the header.
//
// WebSocket state is deliberately absent: only the browser knows whether its
// own dashboard socket is up, so the client fills that tile in itself.
type ServicesHealthResponse struct {
	Remnawave   serviceState `json:"remnawave"`
	ThreatIntel serviceState `json:"threat_intel"`
	Database    serviceState `json:"database"`
}

// handleServicesHealth reports live subsystem health for the header tiles.
// It is intentionally uncached: a stale "online" during an outage is exactly
// the failure this endpoint exists to make visible.
func (s *Server) handleServicesHealth(w http.ResponseWriter, r *http.Request) {
	var resp ServicesHealthResponse

	// Remnawave — "loading" until the first sync completes, never a false offline.
	if s.remnawave == nil {
		resp.Remnawave.Status = "disabled"
	} else {
		h := s.remnawave.Health()
		resp.Remnawave.Status = h.Status
		resp.Remnawave.TotalUsers = h.TotalUsers
		if !h.LastSync.IsZero() {
			resp.Remnawave.LastSync = h.LastSync.Format(time.RFC3339)
		}
	}

	// Threat intel — zero indicators means the feeds are configured but empty,
	// which is a warning rather than an outage.
	if s.threatIntel == nil {
		resp.ThreatIntel.Status = "disabled"
	} else {
		count := s.threatIntel.GetIndicatorCount()
		resp.ThreatIntel.Indicators = count
		if count > 0 {
			resp.ThreatIntel.Status = "online"
		} else {
			resp.ThreatIntel.Status = "warning"
		}
	}

	// Database — an actual round-trip, so the tile reflects the pool right now.
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if s.storage == nil || s.storage.Pool() == nil {
		resp.Database.Status = "offline"
		resp.Database.Detail = "not configured"
	} else if err := s.storage.Pool().Ping(ctx); err != nil {
		resp.Database.Status = "offline"
		resp.Database.Detail = "ping failed"
	} else {
		resp.Database.Status = "online"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}
