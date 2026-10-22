-- Схема VAKSA в D1 — 1:1 с SQLite-схемой main.go (только сессии/случаи выровнены).
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
    title TEXT NOT NULL DEFAULT '',
    created_by INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_read_message_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL DEFAULT 1,
    user_id INTEGER,
    username TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    timestamp TEXT,
    message_type TEXT,
    sticker_id TEXT,
    sticker_url TEXT,
    sticker_pack TEXT,
    file_url TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);

-- Общий чат существует всегда.
INSERT INTO chats (id, type, title)
SELECT 1, 'group', 'Общий чат'
WHERE NOT EXISTS (SELECT 1 FROM chats WHERE id = 1);

-- Файлы вместо R2: D1-чанки по ~900 КиБ ( uploading 50 МБ = ~57 строк).
CREATE TABLE IF NOT EXISTS file_chunks (
    name TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (name, seq)
);
CREATE TABLE IF NOT EXISTS files (
    name TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
