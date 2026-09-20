package server

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/xray-log-analyzer/server/internal/storage"
)

// maskSecret shows just enough of a token to recognise it without exposing
// it: "eyJhbGci...V6m4" rather than the full JWT/bot token. Short values
// (under 10 chars) are fully starred instead, since a 4+4 window would leak
// most or all of a short secret.
func maskSecret(v string) string {
	if v == "" {
		return ""
	}
	if len(v) <= 10 {
		return strings.Repeat("•", len(v))
	}
	return v[:4] + "…" + v[len(v)-4:]
}

// adminIntegrationView is one integration's settings as the admin panel
// renders them: never the raw secret, only whether one is set and a masked
// preview, alongside the plain (non-secret) fields.
type adminIntegrationView struct {
	Enabled         bool   `json:"enabled"`
	URL             string `json:"url,omitempty"`
	TokenSet        bool   `json:"token_set"`
	TokenMasked     string `json:"token_masked,omitempty"`
	ChatID          string `json:"chat_id,omitempty"`
	TopicID         string `json:"topic_id,omitempty"`
	SyncIntervalSec int    `json:"sync_interval_seconds,omitempty"`
	Live            bool   `json:"live"` // true if this process can apply changes without a restart
}

// AdminSettingsResponse is GET/PUT /api/admin/settings.
type AdminSettingsResponse struct {
	Remnawave      adminIntegrationView `json:"remnawave"`
	Telegram       adminIntegrationView `json:"telegram"`
	UpdatedAt      string               `json:"updated_at,omitempty"`
	RestartNeeded  bool                 `json:"restart_needed"`
	RestartMessage string               `json:"restart_message,omitempty"`
}

// currentAppSettings reads the DB row, falling back to whatever the running
// process was actually booted with (env vars) if the admin panel has never
// saved anything. Without this fallback, the very first load after a fresh
// deploy showed every field blank/disabled even when Remnawave and Telegram
// were both live and working straight from .env — the accessors this reads
// (Client.Credentials, Bot.Credentials, ...) exist for exactly this case.
func (s *Server) currentAppSettings(r *http.Request) *storage.AppSettings {
	if s.storage != nil {
		if db, err := s.storage.GetAppSettings(r.Context()); err == nil && db != nil {
			return db
		}
	}
	a := &storage.AppSettings{RemnawaveSyncIntervalSeconds: 60}
	if s.remnawave != nil {
		url, token := s.remnawave.Credentials()
		a.RemnawaveURL = url
		a.RemnawaveAPIToken = token
		a.RemnawaveEnabled = s.remnawave.IsEnabled() && s.remnawave.Health().Configured
		a.RemnawaveSyncIntervalSeconds = int(s.remnawave.Interval().Seconds())
	}
	if s.telegramBot != nil {
		token, chatID, topicID := s.telegramBot.Credentials()
		a.TelegramToken = token
		a.TelegramChatID = chatID
		a.TelegramTopicID = topicID
		a.TelegramEnabled = s.telegramBot.IsEnabled() && s.telegramBot.IsConfigured()
	}
	return a
}

func (s *Server) handleAdminSettingsGet(w http.ResponseWriter, r *http.Request) {
	a := s.currentAppSettings(r)

	resp := AdminSettingsResponse{
		Remnawave: adminIntegrationView{
			Enabled:         a.RemnawaveEnabled,
			URL:             a.RemnawaveURL,
			TokenSet:        a.RemnawaveAPIToken != "",
			TokenMasked:     maskSecret(a.RemnawaveAPIToken),
			SyncIntervalSec: a.RemnawaveSyncIntervalSeconds,
			Live:            s.remnawave != nil,
		},
		Telegram: adminIntegrationView{
			Enabled:     a.TelegramEnabled,
			TokenSet:    a.TelegramToken != "",
			TokenMasked: maskSecret(a.TelegramToken),
			ChatID:      a.TelegramChatID,
			TopicID:     a.TelegramTopicID,
			Live:        s.telegramBot != nil,
		},
	}
	if !a.UpdatedAt.IsZero() {
		resp.UpdatedAt = a.UpdatedAt.Format(time.RFC3339)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// adminSettingsPatch is the PUT body. Every field is a pointer/omittable:
// a field the client leaves out is left exactly as it was, and in
// particular an omitted token is NEVER overwritten with blank — the admin
// panel never re-sends a secret it only has the masked form of. To send a
// real change, the field must be present and non-empty.
type adminSettingsPatch struct {
	Remnawave *struct {
		Enabled        *bool   `json:"enabled"`
		URL            *string `json:"url"`
		APIToken       *string `json:"api_token"`
		SyncIntervalMs *int    `json:"sync_interval_seconds"`
	} `json:"remnawave"`
	Telegram *struct {
		Enabled *bool   `json:"enabled"`
		Token   *string `json:"token"`
		ChatID  *string `json:"chat_id"`
		TopicID *string `json:"topic_id"`
	} `json:"telegram"`
	// SendTestMessage, if true, fires a Telegram test message using whatever
	// the Telegram section resolves to after this same patch is applied —
	// so a token/chat/topic change can be verified in the same request.
	SendTestMessage bool `json:"send_test_message"`
}

func (s *Server) handleAdminSettingsPut(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.storage == nil {
		http.Error(w, "storage not available", http.StatusServiceUnavailable)
		return
	}

	var patch adminSettingsPatch
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		http.Error(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	ctx := r.Context()
	current := s.currentAppSettings(r)

	restartNeeded := false

	if patch.Remnawave != nil {
		if patch.Remnawave.Enabled != nil {
			current.RemnawaveEnabled = *patch.Remnawave.Enabled
		}
		if patch.Remnawave.URL != nil {
			current.RemnawaveURL = *patch.Remnawave.URL
		}
		if patch.Remnawave.APIToken != nil && *patch.Remnawave.APIToken != "" {
			current.RemnawaveAPIToken = *patch.Remnawave.APIToken
		}
		if patch.Remnawave.SyncIntervalMs != nil && *patch.Remnawave.SyncIntervalMs > 0 {
			current.RemnawaveSyncIntervalSeconds = *patch.Remnawave.SyncIntervalMs
		}

		if s.remnawave != nil {
			s.remnawave.SetCredentials(current.RemnawaveURL, current.RemnawaveAPIToken)
			s.remnawave.SetInterval(time.Duration(current.RemnawaveSyncIntervalSeconds) * time.Second)
			s.remnawave.SetEnabled(current.RemnawaveEnabled)
			log.Printf("admin: remnawave settings updated live (enabled=%v)", current.RemnawaveEnabled)
		} else if current.RemnawaveEnabled {
			restartNeeded = true
		}
	}

	if patch.Telegram != nil {
		if patch.Telegram.Enabled != nil {
			current.TelegramEnabled = *patch.Telegram.Enabled
		}
		if patch.Telegram.Token != nil && *patch.Telegram.Token != "" {
			current.TelegramToken = *patch.Telegram.Token
		}
		if patch.Telegram.ChatID != nil {
			current.TelegramChatID = *patch.Telegram.ChatID
		}
		if patch.Telegram.TopicID != nil {
			current.TelegramTopicID = *patch.Telegram.TopicID
		}

		if s.telegramBot != nil {
			s.telegramBot.SetCredentials(current.TelegramToken, current.TelegramChatID, current.TelegramTopicID)
			s.telegramBot.SetEnabled(current.TelegramEnabled)
			log.Printf("admin: telegram settings updated live (enabled=%v)", current.TelegramEnabled)
		} else if current.TelegramEnabled {
			restartNeeded = true
		}
	}

	if err := s.storage.UpsertAppSettings(ctx, current); err != nil {
		http.Error(w, "failed to save settings: "+err.Error(), http.StatusInternalServerError)
		return
	}

	var testErr string
	if patch.SendTestMessage {
		if s.telegramBot == nil {
			testErr = "telegram bot not running in this process"
		} else if err := s.telegramBot.SendTestMessage(); err != nil {
			testErr = err.Error()
		}
	}

	resp := AdminSettingsResponse{
		Remnawave: adminIntegrationView{
			Enabled:         current.RemnawaveEnabled,
			URL:             current.RemnawaveURL,
			TokenSet:        current.RemnawaveAPIToken != "",
			TokenMasked:     maskSecret(current.RemnawaveAPIToken),
			SyncIntervalSec: current.RemnawaveSyncIntervalSeconds,
			Live:            s.remnawave != nil,
		},
		Telegram: adminIntegrationView{
			Enabled:     current.TelegramEnabled,
			TokenSet:    current.TelegramToken != "",
			TokenMasked: maskSecret(current.TelegramToken),
			ChatID:      current.TelegramChatID,
			TopicID:     current.TelegramTopicID,
			Live:        s.telegramBot != nil,
		},
		RestartNeeded: restartNeeded,
	}
	if restartNeeded {
		resp.RestartMessage = "Сохранено. Эта интеграция была выключена при запуске сервера — изменения вступят в силу после перезапуска контейнера."
	}
	if testErr != "" {
		w.Header().Set("X-Test-Message-Error", testErr)
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

// handleAdminSettings dispatches by method: net/http's mux registers one
// handler per path, so GET and PUT/POST share this entry point.
func (s *Server) handleAdminSettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleAdminSettingsGet(w, r)
	case http.MethodPut, http.MethodPost:
		s.handleAdminSettingsPut(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}
