package geoip

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/oschwald/maxminddb-golang"
)

// Service resolves IPs to city/country/coordinates from a local DB-IP City
// Lite database (https://db-ip.com/db/download/ip-to-city-lite), refreshed
// once a day. Doing this locally instead of calling an external geo-IP API
// on every lookup removes both the latency (a lookup here is sub-millisecond,
// no network round trip) and the dependency on that API being reachable at
// all: this network's DNS silently rewrites several external domains
// (github.com, ip-api.com, db-ip.com among them observed so far) to a
// black-holed IP, so the downloader below resolves via DNS-over-HTTPS and
// dials the real IP directly instead of trusting the local resolver.
type Service struct {
	dataDir string
	reader  atomic.Pointer[maxminddb.Reader]
}

func NewService(dataDir string) *Service {
	return &Service{dataDir: dataDir}
}

// Info is the subset of a DB-IP City Lite record this app renders. The free
// tier has no ISP/org/ASN/mobile/proxy/hosting fields (that data isn't in
// the Lite tier at all) - callers merging this into the richer ipinfo.IPInfo
// struct leave those fields blank, which the frontend already renders as
// simply absent rather than broken.
type Info struct {
	Country     string
	CountryCode string
	City        string
	Region      string
	Lat         float64
	Lon         float64
}

// ErrNotLoaded means the database hasn't finished its first download yet
// (e.g. right after a fresh deploy, before the background updater's first
// run completes). Callers should fall back to another source.
var ErrNotLoaded = fmt.Errorf("geoip: database not loaded yet")

func (s *Service) Lookup(ip string) (*Info, error) {
	r := s.reader.Load()
	if r == nil {
		return nil, ErrNotLoaded
	}
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return nil, fmt.Errorf("geoip: invalid ip %q", ip)
	}

	var record struct {
		Country struct {
			IsoCode string            `maxminddb:"iso_code"`
			Names   map[string]string `maxminddb:"names"`
		} `maxminddb:"country"`
		City struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"city"`
		Subdivisions []struct {
			Names map[string]string `maxminddb:"names"`
		} `maxminddb:"subdivisions"`
		Location struct {
			Latitude  float64 `maxminddb:"latitude"`
			Longitude float64 `maxminddb:"longitude"`
		} `maxminddb:"location"`
	}
	if err := r.Lookup(parsed, &record); err != nil {
		return nil, err
	}
	if record.Country.IsoCode == "" {
		return nil, fmt.Errorf("geoip: no record for %s", ip)
	}

	info := &Info{
		CountryCode: record.Country.IsoCode,
		Country:     pickName(record.Country.Names),
		City:        pickName(record.City.Names),
		Lat:         record.Location.Latitude,
		Lon:         record.Location.Longitude,
	}
	if len(record.Subdivisions) > 0 {
		info.Region = pickName(record.Subdivisions[0].Names)
	}
	return info, nil
}

func pickName(names map[string]string) string {
	if n, ok := names["ru"]; ok && n != "" {
		return n
	}
	return names["en"]
}

// Start loads whatever database is already on disk (if any) synchronously so
// Lookup works immediately on a warm restart, then updates in the
// background: once right away if nothing loaded, then once every 24h.
func (s *Service) Start(ctx context.Context) {
	existing := filepath.Join(s.dataDir, "dbip-city-lite.mmdb")
	if r, err := maxminddb.Open(existing); err == nil {
		s.reader.Store(r)
		log.Printf("geoip: loaded existing database from %s", existing)
	}

	go func() {
		if s.reader.Load() == nil {
			s.update(ctx)
		}
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.update(ctx)
			}
		}
	}()
}

func (s *Service) update(ctx context.Context) {
	url := fmt.Sprintf("https://download.db-ip.com/free/dbip-city-lite-%s.mmdb.gz", time.Now().Format("2006-01"))
	log.Printf("geoip: checking for update: %s", url)

	client, err := httpClientForHost(ctx, "download.db-ip.com")
	if err != nil {
		log.Printf("geoip: DoH resolve failed, skipping update: %v", err)
		return
	}

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("geoip: download failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		log.Printf("geoip: download returned %s", resp.Status)
		return
	}

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		log.Printf("geoip: gzip error: %v", err)
		return
	}
	defer gz.Close()

	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		log.Printf("geoip: mkdir failed: %v", err)
		return
	}
	tmpPath := filepath.Join(s.dataDir, "dbip-city-lite.mmdb.tmp")
	finalPath := filepath.Join(s.dataDir, "dbip-city-lite.mmdb")

	f, err := os.Create(tmpPath)
	if err != nil {
		log.Printf("geoip: create tmp file failed: %v", err)
		return
	}
	written, err := io.Copy(f, gz)
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		log.Printf("geoip: write failed: %v", err)
		return
	}

	r, err := maxminddb.Open(tmpPath)
	if err != nil {
		os.Remove(tmpPath)
		log.Printf("geoip: opening downloaded database failed: %v", err)
		return
	}

	if err := os.Rename(tmpPath, finalPath); err != nil {
		r.Close()
		log.Printf("geoip: rename failed: %v", err)
		return
	}

	old := s.reader.Swap(r)
	if old != nil {
		old.Close()
	}
	log.Printf("geoip: database updated (%d bytes written)", written)
}

// httpClientForHost resolves host via Cloudflare's DNS-over-HTTPS endpoint
// (an ordinary HTTPS request on port 443, not a UDP:53 packet, so it isn't
// subject to whatever is silently rewriting plain DNS answers for this
// domain on this network) and returns an *http.Client whose transport dials
// that resolved IP directly while still presenting the correct SNI/Host, so
// TLS and the origin server both see the hostname they expect.
func httpClientForHost(ctx context.Context, host string) (*http.Client, error) {
	ip, err := resolveViaDoH(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, err := net.SplitHostPort(addr)
			if err != nil {
				port = "443"
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ip, port))
		},
		TLSClientConfig: &tls.Config{ServerName: host},
	}
	return &http.Client{Transport: transport, Timeout: 5 * time.Minute}, nil
}

func resolveViaDoH(ctx context.Context, host string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET",
		fmt.Sprintf("https://1.1.1.1/dns-query?name=%s&type=A", host), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/dns-json")
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var result struct {
		Answer []struct {
			Data string `json:"data"`
		} `json:"Answer"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	for _, a := range result.Answer {
		if ip := net.ParseIP(a.Data); ip != nil && ip.To4() != nil {
			return a.Data, nil
		}
	}
	return "", fmt.Errorf("no A record for %s", host)
}
