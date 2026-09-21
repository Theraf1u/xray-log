package server

import (
	"encoding/json"
	"net/http"
	"os"
	"syscall"
	"time"
)

type storageMetrics struct {
	DatabaseBytes   int64   `json:"database_bytes"`
	WALBytes        int64   `json:"wal_bytes"`
	ChronologyBytes int64   `json:"chronology_bytes"`
	AnalyzerBytes   int64   `json:"analyzer_bytes"`
	DiskTotalBytes  uint64  `json:"disk_total_bytes"`
	DiskFreeBytes   uint64  `json:"disk_free_bytes"`
	Percent         float64 `json:"percent"` // AnalyzerBytes as a share of the disk — this app's own footprint
	DiskUsedPercent float64 `json:"disk_used_percent"` // the whole filesystem's actual fill level, everything on it
	UptimeSeconds   int64   `json:"uptime_seconds"`
}

// handleStorageMetrics reports Analyzer's PostgreSQL footprint and capacity
// of the filesystem that holds it. The mounted monitor path contains no data;
// it is only used for statfs, keeping the actual database mount private.
func (s *Server) handleStorageMetrics(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	var m storageMetrics
	if err := s.storage.Pool().QueryRow(ctx, `SELECT pg_database_size(current_database())`).Scan(&m.DatabaseBytes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := s.storage.Pool().QueryRow(ctx, `SELECT COALESCE(sum(size),0)::bigint FROM pg_ls_waldir()`).Scan(&m.WALBytes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := s.storage.Pool().QueryRow(ctx, `
		SELECT COALESCE(sum(pg_total_relation_size(inhrelid)),0)::bigint
		FROM pg_inherits WHERE inhparent = 'request_events'::regclass
	`).Scan(&m.ChronologyBytes); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	m.AnalyzerBytes = m.DatabaseBytes + m.WALBytes

	path := os.Getenv("STORAGE_MONITOR_PATH")
	if path == "" {
		path = "/storage-monitor"
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	m.DiskTotalBytes = fs.Blocks * uint64(fs.Bsize)
	m.DiskFreeBytes = fs.Bavail * uint64(fs.Bsize)
	if m.DiskTotalBytes > 0 {
		m.Percent = float64(m.AnalyzerBytes) / float64(m.DiskTotalBytes) * 100
		diskUsed := m.DiskTotalBytes - m.DiskFreeBytes
		m.DiskUsedPercent = float64(diskUsed) / float64(m.DiskTotalBytes) * 100
	}
	m.UptimeSeconds = int64(time.Since(s.startTime).Seconds())
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=60")
	json.NewEncoder(w).Encode(m)
}
