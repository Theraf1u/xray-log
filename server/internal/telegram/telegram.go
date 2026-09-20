package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/xray-log-analyzer/server/internal/models"
)

// Bot sends alerts to Telegram.
//
// Credentials and enabled state are mutex-guarded so the admin panel can
// change them live (new token, chat, forum topic, or a pause) without a
// process restart.
type Bot struct {
	mu      sync.RWMutex
	token   string
	chatID  string
	topicID string // optional: Telegram forum "message_thread_id"
	enabled bool

	alertCh chan *models.Alert
	client  *http.Client
}

// New creates a new Telegram bot. topicID may be empty — most chats are not
// forums and do not use it.
func New(token, chatID, topicID string, alertCh chan *models.Alert) *Bot {
	return &Bot{
		token:   token,
		chatID:  chatID,
		topicID: topicID,
		enabled: true,
		alertCh: alertCh,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// SetCredentials updates token/chat/topic live. An empty topicID clears
// threading (messages post to the chat's General topic).
func (b *Bot) SetCredentials(token, chatID, topicID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.token = token
	b.chatID = chatID
	b.topicID = topicID
}

// SetEnabled pauses or resumes delivery without discarding credentials.
// While disabled, Start still drains alertCh so producers never block — it
// just does not call the Telegram API.
func (b *Bot) SetEnabled(enabled bool) {
	b.mu.Lock()
	b.enabled = enabled
	b.mu.Unlock()
}

// IsConfigured reports whether there is enough to attempt delivery.
func (b *Bot) IsConfigured() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.token != "" && b.chatID != ""
}

// Credentials returns the live token/chatID/topicID. Used only by the admin
// settings endpoint (see remnawave.Client.Credentials for why).
func (b *Bot) Credentials() (token, chatID, topicID string) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.token, b.chatID, b.topicID
}

// IsEnabled reports whether delivery is paused via the admin panel.
func (b *Bot) IsEnabled() bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.enabled
}

// snapshot is a consistent, lock-free-to-use copy of the mutable fields,
// taken once per call so a send is never split across two configurations.
type snapshot struct {
	token, chatID, topicID string
	enabled                bool
}

func (b *Bot) snapshot() snapshot {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return snapshot{token: b.token, chatID: b.chatID, topicID: b.topicID, enabled: b.enabled}
}

// minSendInterval paces outgoing messages. Telegram's documented safe rate
// for a bot posting into one group/channel is ~20 messages/minute — the
// per-second "~1 msg/sec" figure is the ceiling for a burst, not a sustained
// rate, and this deployment's alert volume is sustained (the "ads"/
// "tracking" categories fire constantly on ordinary browsing). 1.2s of
// spacing still 429'd under real load; 3s keeps the sustained rate under
// Telegram's group limit with headroom. The fix is pacing on the sender, not
// deciding which alerts are "worth" sending — that is a policy call for
// whoever tunes threatintel confidence thresholds, not something to change
// here.
const minSendInterval = 3 * time.Second

// Start begins processing alerts. It always runs — main starts it
// unconditionally at boot — so admin-panel changes to credentials or the
// enabled flag take effect on the very next alert without a restart.
func (b *Bot) Start(ctx context.Context) {
	log.Println("telegram: bot started")

	var lastSend time.Time
	coalesced := 0

	for {
		select {
		case <-ctx.Done():
			return
		case alert := <-b.alertCh:
			cfg := b.snapshot()
			if !cfg.enabled || cfg.token == "" || cfg.chatID == "" {
				continue // disabled or unconfigured: drop silently, same as before
			}

			// Pace to at most one send per minSendInterval, staying responsive
			// to shutdown while waiting.
			if wait := minSendInterval - time.Since(lastSend); wait > 0 {
				timer := time.NewTimer(wait)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}

			retryAfter, err := b.sendMessage(cfg, alert.Message)
			lastSend = time.Now()
			if err != nil {
				log.Printf("telegram: failed to send message: %v", err)
				if retryAfter > 0 {
					// Telegram told us exactly how long to back off; honour it
					// so the next send doesn't immediately re-trigger the same
					// 429 instead of the fixed minSendInterval pace.
					lastSend = lastSend.Add(retryAfter - minSendInterval)
					coalesced++
				}
				continue
			}
			if coalesced > 0 {
				log.Printf("telegram: resumed delivery after rate-limit backoff (%d message(s) affected)", coalesced)
				coalesced = 0
			}
		}
	}
}

// sendMessage sends a message to the Telegram chat, threaded into the
// configured forum topic when one is set. On a 429 it also returns how long
// Telegram asked the caller to wait, parsed from the response body's
// `parameters.retry_after` (falls back to 0 — meaning "use the default pace"
// — if Telegram didn't include one).
func (b *Bot) sendMessage(cfg snapshot, text string) (retryAfter time.Duration, err error) {
	url := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", cfg.token)

	payload := map[string]interface{}{
		"chat_id":    cfg.chatID,
		"text":       text,
		"parse_mode": "HTML",
	}
	if cfg.topicID != "" {
		if threadID, convErr := strconv.Atoi(cfg.topicID); convErr == nil {
			payload["message_thread_id"] = threadID
		}
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return 0, err
	}

	resp, err := b.client.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusTooManyRequests {
		var body struct {
			Parameters struct {
				RetryAfter int `json:"retry_after"`
			} `json:"parameters"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&body)
		if body.Parameters.RetryAfter > 0 {
			retryAfter = time.Duration(body.Parameters.RetryAfter) * time.Second
		}
		return retryAfter, fmt.Errorf("telegram API returned status %d (retry after %s)", resp.StatusCode, retryAfter)
	}

	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("telegram API returned status %d", resp.StatusCode)
	}

	return 0, nil
}

// SendTestMessage sends a test message using the current configuration —
// used both at boot and by the admin panel's "test" action after a change.
func (b *Bot) SendTestMessage() error {
	cfg := b.snapshot()
	if cfg.token == "" || cfg.chatID == "" {
		return fmt.Errorf("telegram not configured")
	}
	_, err := b.sendMessage(cfg, "✅ Xray Log Analyzer подключен к Telegram!")
	return err
}
