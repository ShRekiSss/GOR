-- v1.0.4: истории (ТГ/ТТ-стиль, живут 24 ч).
-- Прогон (одним заходом с миграцией приватности):
--   npx wrangler d1 execute vaksa-db --remote --file migrations/20261026_searchable.sql
--   npx wrangler d1 execute vaksa-db --remote --file migrations/20261027_stories.sql
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',          -- text | image | video
  caption TEXT NOT NULL DEFAULT '',
  file_key TEXT NOT NULL DEFAULT '',          -- ключ в files/file_chunks (префикс story_)
  duration_ms INTEGER NOT NULL DEFAULT 0,     -- для видео: длительность
  gradient INTEGER NOT NULL DEFAULT 0,        -- фон текстовой истории (0..7)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_user ON stories (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_stories_exp ON stories (expires_at);

CREATE TABLE IF NOT EXISTS story_views (
  story_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (story_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_views_story ON story_views (story_id);
