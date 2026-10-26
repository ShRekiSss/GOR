-- v1.0.3: приватность поиска.
-- Прогон вручную (эта колонка не появится сама: CREATE TABLE IF NOT EXISTS
-- существующую таблицу не достраивает).
--   npx wrangler d1 execute vaksa-db --remote --file migrations/20261026_searchable.sql
--   (--local для локальной разработки)
-- ПРИМЕЧАНИЕ: без миграции код работает по-старому (fallback «no such column»
-- = всех видно), тумблер в настройках вернёт честную ошибку.
ALTER TABLE users ADD COLUMN searchable INTEGER NOT NULL DEFAULT 1;
