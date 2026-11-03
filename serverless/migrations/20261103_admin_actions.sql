-- v1.0.7: журнал действий админа (кто, кого, что и когда).
-- Прогон:
--   npx wrangler d1 execute vaksa-db --remote --file migrations/20261103_admin_actions.sql
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  admin_name TEXT NOT NULL DEFAULT '',
  target_id INTEGER,
  target_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,              -- ban | unban | rename | admin_on | admin_off | logout | delete
  details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
