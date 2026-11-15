-- Удаление системы ботов: аккаунт VAKSA-бот и его приветственные чаты bot:<id>.
-- Применяется вручную: wrangler d1 migrations apply <db> --remote

DELETE FROM reactions WHERE message_id IN (
  SELECT id FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE type = 'direct' AND title LIKE 'bot:%')
);
DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE username = 'VAKSA-бот');
DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE type = 'direct' AND title LIKE 'bot:%');
DELETE FROM chat_members WHERE chat_id IN (SELECT id FROM chats WHERE type = 'direct' AND title LIKE 'bot:%');
DELETE FROM chats WHERE type = 'direct' AND title LIKE 'bot:%';
DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE username = 'VAKSA-бот');
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = 'VAKSA-бот');
DELETE FROM users WHERE username = 'VAKSA-бот';
