package storage

import (
	"context"
	"database/sql"
	"time"
)

// AppSettings mirrors the app_settings table — the small set of integration
// credentials and intervals the admin panel can edit live. Plain data, no
// masking: masking is a presentation concern and happens in the HTTP layer.
type AppSettings struct {
	RemnawaveEnabled             bool
	RemnawaveURL                 string
	RemnawaveAPIToken            string
	RemnawaveSyncIntervalSeconds int
	TelegramEnabled              bool
	TelegramToken                string
	TelegramChatID               string
	TelegramTopicID              string
	UpdatedAt                    time.Time
}

// GetAppSettings returns the stored settings row, or (nil, nil) if the admin
// panel has never saved anything yet — callers should fall back to the env-
// var defaults from config.Load() in that case, not treat it as an error.
func (s *Storage) GetAppSettings(ctx context.Context) (*AppSettings, error) {
	var a AppSettings
	err := s.db.QueryRowContext(ctx, `
		SELECT remnawave_enabled, remnawave_url, remnawave_api_token, remnawave_sync_interval_seconds,
		       telegram_enabled, telegram_token, telegram_chat_id, telegram_topic_id, updated_at
		FROM app_settings WHERE id = 1
	`).Scan(
		&a.RemnawaveEnabled, &a.RemnawaveURL, &a.RemnawaveAPIToken, &a.RemnawaveSyncIntervalSeconds,
		&a.TelegramEnabled, &a.TelegramToken, &a.TelegramChatID, &a.TelegramTopicID, &a.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

// UpsertAppSettings writes the full settings row. Callers (the admin HTTP
// handler) are responsible for merging in unchanged fields first — this is
// a full replace, not a patch, to keep the single-row invariant simple.
func (s *Storage) UpsertAppSettings(ctx context.Context, a *AppSettings) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO app_settings (
			id, remnawave_enabled, remnawave_url, remnawave_api_token, remnawave_sync_interval_seconds,
			telegram_enabled, telegram_token, telegram_chat_id, telegram_topic_id, updated_at
		) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, now())
		ON CONFLICT (id) DO UPDATE SET
			remnawave_enabled = EXCLUDED.remnawave_enabled,
			remnawave_url = EXCLUDED.remnawave_url,
			remnawave_api_token = EXCLUDED.remnawave_api_token,
			remnawave_sync_interval_seconds = EXCLUDED.remnawave_sync_interval_seconds,
			telegram_enabled = EXCLUDED.telegram_enabled,
			telegram_token = EXCLUDED.telegram_token,
			telegram_chat_id = EXCLUDED.telegram_chat_id,
			telegram_topic_id = EXCLUDED.telegram_topic_id,
			updated_at = now()
	`,
		a.RemnawaveEnabled, a.RemnawaveURL, a.RemnawaveAPIToken, a.RemnawaveSyncIntervalSeconds,
		a.TelegramEnabled, a.TelegramToken, a.TelegramChatID, a.TelegramTopicID,
	)
	return err
}
