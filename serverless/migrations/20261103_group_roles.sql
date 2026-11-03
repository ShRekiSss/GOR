-- v1.0.9: групповое управление — роли участников и ссылки-приглашения.
-- Прогон:
--   npx wrangler d1 execute vaksa-db --remote --file migrations/20261103_group_roles.sql
ALTER TABLE chat_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member';

-- Создатель существующей группы становится её владельцем.
UPDATE chat_members SET role = 'owner'
WHERE EXISTS (
  SELECT 1 FROM chats c
  WHERE c.id = chat_members.chat_id AND c.type = 'group'
    AND c.created_by = chat_members.user_id
);

-- Ссылки-приглашения в группу (токен живёт 7 дней, счётчик входов — для статистики).
CREATE TABLE IF NOT EXISTS chat_invites (
  token TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_chat_invites_chat ON chat_invites(chat_id);
