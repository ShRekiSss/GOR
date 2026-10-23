package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/argon2"
	_ "modernc.org/sqlite"
)

type Message struct {
	ID          int    `json:"id,omitempty"`
	ChatID      int64  `json:"chatId"`
	UserID      int64  `json:"userId,omitempty"`
	Username    string `json:"username"`
	Text        string `json:"text"`
	Timestamp   string `json:"timestamp"`
	Type        string `json:"type,omitempty"`
	StickerID   string `json:"stickerId,omitempty"`
	StickerURL  string `json:"stickerUrl,omitempty"`
	StickerPack string `json:"stickerPack,omitempty"`
	FileURL     string `json:"fileUrl,omitempty"`
	FileName    string `json:"fileName,omitempty"`
	FileSize    int64  `json:"fileSize,omitempty"`
	FileType    string `json:"fileType,omitempty"` // image, audio, video, document
}

type Chat struct {
	ID         int64  `json:"id"`
	Type       string `json:"type"` // direct | group
	Title      string `json:"title"`
	Peer       string `json:"peer,omitempty"`
	PeerID     int64  `json:"peerId,omitempty"`
	Unread     int    `json:"unread"`
	LastText   string `json:"lastText,omitempty"`
	LastSender string `json:"lastSender,omitempty"`
	LastTime   string `json:"lastTime,omitempty"`
}

type User struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
}

type Database struct {
	db *sql.DB
	mu sync.Mutex
}

type Hub struct {
	clients    map[*Client]bool
	broadcast  chan *Message
	register   chan *Client
	unregister chan *Client
	db         *Database
	mu         sync.RWMutex
}

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan any // сообщения и служебные события (presence, звонки)
	userID   int64
	username string
}

// Config — настройки сервера из переменных окружения (флаги — как резерв).
type Config struct {
	Port      string
	DBPath    string
	UploadDir string
	StaticDir string
	Origins   []string
	MaxUpload int64
	StartTime time.Time

	// GOR_TRUSTED_PROXIES: IP или CIDR, от которых доверяем X-Real-IP /
	// X-Forwarded-For (rate-limit по реальному клиенту). По умолчанию —
	// только loopback.
	TrustedIPs  []net.IP
	TrustedNets []*net.IPNet

	// GOR_GIPHY_KEY: проксируем поиск GIF через сервер, ключ не светится в бандле.
	GiphyKey string
}

var (
	hub      *Hub
	db       *Database
	config   Config
	upgrader websocket.Upgrader
	version  = "dev"
)

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func buildConfig() Config {
	port := flag.String("port", getenv("GOR_PORT", "8080"), "HTTP/WebSocket port")
	flag.Parse()

	staticDir := getenv("GOR_STATIC", "./frontend/build")
	if _, err := os.Stat(staticDir); err != nil {
		if _, err2 := os.Stat("./build"); err2 == nil {
			staticDir = "./build"
		}
	}

	var origins []string
	if raw := strings.TrimSpace(os.Getenv("GOR_ORIGINS")); raw != "" {
		for _, o := range strings.Split(raw, ",") {
			if o = strings.TrimSpace(o); o != "" {
				origins = append(origins, o)
			}
		}
	}

	proxies := os.Getenv("GOR_TRUSTED_PROXIES")
	if strings.TrimSpace(proxies) == "" {
		proxies = "127.0.0.1,::1"
	}
	var trustedIPs []net.IP
	var trustedNets []*net.IPNet
	for _, p := range strings.Split(proxies, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if ip := net.ParseIP(p); ip != nil {
			trustedIPs = append(trustedIPs, ip)
			continue
		}
		if _, ipnet, err := net.ParseCIDR(p); err == nil {
			trustedNets = append(trustedNets, ipnet)
			continue
		}
		log.Printf("GOR_TRUSTED_PROXIES: элемент %q не IP и не CIDR — пропущен", p)
	}

	return Config{
		Port:        *port,
		DBPath:      getenv("GOR_DB", "./chat.db"),
		UploadDir:   getenv("GOR_UPLOADS", "./uploads"),
		StaticDir:   staticDir,
		Origins:     origins,
		MaxUpload:   50 * 1024 * 1024,
		StartTime:   time.Now(),
		TrustedIPs:  trustedIPs,
		TrustedNets: trustedNets,
		GiphyKey:    getenv("GOR_GIPHY_KEY", ""),
	}
}

// isAllowedOrigin разрешает свой origin, адреса из GOR_ORIGINS и desktop-клиент
// (Tauri). Не-браузерные клиенты не присылают Origin — им разрешено.
func isAllowedOrigin(origin, host string) bool {
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	// Tauri 2: tauri://localhost (Linux/macOS) и http(s)://tauri.localhost (Windows)
	if u.Scheme == "tauri" && u.Host == "localhost" {
		return true
	}
	if (u.Scheme == "http" || u.Scheme == "https") && u.Host == "tauri.localhost" {
		return true
	}
	if u.Host == host {
		return true
	}
	for _, allowed := range config.Origins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func checkOrigin(r *http.Request) bool {
	return isAllowedOrigin(r.Header.Get("Origin"), r.Host)
}

// cors добавляет заголовки для desktop-клиента (Tauri) и внешних origin
// из GOR_ORIGINS. Для обычного браузера на том же домене ничего не меняется.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && isAllowedOrigin(origin, r.Host) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------- Database ----------

func NewDatabase(dbPath string) (*Database, error) {
	sqlDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, err
	}
	if _, err := sqlDB.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`); err != nil {
		return nil, err
	}

	d := &Database{db: sqlDB}
	if err := d.init(); err != nil {
		return nil, err
	}
	return d, nil
}

func (d *Database) init() error {
	d.mu.Lock()
	defer d.mu.Unlock()

	schema := `
	CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		text TEXT NOT NULL,
		timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
		message_type TEXT,
		sticker_id TEXT,
		sticker_url TEXT,
		sticker_pack TEXT,
		file_url TEXT,
		file_name TEXT,
		file_size INTEGER,
		file_type TEXT
	);
	`
	if _, err := d.db.Exec(schema); err != nil {
		return err
	}

	authSchema := `
	CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS sessions (
		token TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		expires_at INTEGER NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
	CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

	CREATE TABLE IF NOT EXISTS chats (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
		title TEXT NOT NULL DEFAULT '',
		created_by INTEGER,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS chat_members (
		chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		last_read_message_id INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (chat_id, user_id)
	);
	CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);
	`
	if _, err := d.db.Exec(authSchema); err != nil {
		return err
	}

	return d.ensureColumns()
}

// ensureColumns добавляет недостающие колонки в старые базы.
func (d *Database) ensureColumns() error {
	rows, err := d.db.Query(`PRAGMA table_info(messages)`)
	if err != nil {
		return err
	}
	defer rows.Close()

	existing := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull int
		var dfltValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			return err
		}
		existing[name] = true
	}
	if err := rows.Err(); err != nil {
		return err
	}

	columns := map[string]string{
		"message_type": "TEXT",
		"sticker_id":   "TEXT",
		"sticker_url":  "TEXT",
		"sticker_pack": "TEXT",
		"file_url":     "TEXT",
		"file_name":    "TEXT",
		"file_size":    "INTEGER",
		"file_type":    "TEXT",
		"chat_id":      "INTEGER",
		"user_id":      "INTEGER",
	}
	for col, typ := range columns {
		if !existing[col] {
			if _, err := d.db.Exec(fmt.Sprintf("ALTER TABLE messages ADD COLUMN %s %s", col, typ)); err != nil {
				return err
			}
		}
	}

	if _, err := d.db.Exec(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id)`); err != nil {
		return err
	}

	// Общий чат существует всегда: в него попадают старые сообщения и все пользователи.
	if _, err := d.db.Exec(`INSERT INTO chats (id, type, title)
		SELECT 1, 'group', 'Общий чат'
		WHERE NOT EXISTS (SELECT 1 FROM chats WHERE id = 1)`); err != nil {
		return err
	}
	if _, err := d.db.Exec(`UPDATE messages SET chat_id = 1 WHERE chat_id IS NULL`); err != nil {
		return err
	}
	if _, err := d.db.Exec(`UPDATE messages SET user_id = (
		SELECT id FROM users WHERE users.username = messages.username
	) WHERE user_id IS NULL`); err != nil {
		return err
	}
	if _, err := d.db.Exec(`INSERT OR IGNORE INTO chat_members (chat_id, user_id) SELECT 1, id FROM users`); err != nil {
		return err
	}
	return nil
}

func (d *Database) SaveMessage(msg *Message) error {
	if msg.ChatID == 0 {
		msg.ChatID = 1
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	query := `INSERT INTO messages (chat_id, user_id, username, text, timestamp, message_type, sticker_id, sticker_url, sticker_pack, file_url, file_name, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	result, err := d.db.Exec(query, msg.ChatID, msg.UserID, msg.Username, msg.Text, msg.Timestamp, msg.Type, msg.StickerID, msg.StickerURL, msg.StickerPack, msg.FileURL, msg.FileName, msg.FileSize, msg.FileType)
	if err != nil {
		return err
	}
	id, _ := result.LastInsertId()
	msg.ID = int(id)
	return nil
}

// GetMessages — последняя страница истории (для легаси-эндпоинта).
func (d *Database) GetMessages(chatID int64, limit int) ([]Message, error) {
	msgs, _, err := d.GetMessagesPage(chatID, limit, 0, 0)
	return msgs, err
}

// GetMessagesPage — история с пагинацией:
//
//	after  > 0  → сообщения с id > after по возрастанию (догон после реконнекта),
//	before > 0  → страница СТАРЫХ сообщений, заканчивающаяся id < before,
//	иначе       → последние limit (в порядке возрастания).
//
// hasMore=true — есть ещё сообщения в запрошенном направлении.
func (d *Database) GetMessagesPage(chatID int64, limit int, after, before int64) ([]Message, bool, error) {
	if limit <= 0 || limit > 300 {
		limit = 100
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	const cols = `id, COALESCE(chat_id, 1), COALESCE(user_id, 0), username, text, timestamp,
		COALESCE(message_type, ''), COALESCE(sticker_id, ''), COALESCE(sticker_url, ''),
		COALESCE(sticker_pack, ''), COALESCE(file_url, ''), COALESCE(file_name, ''),
		COALESCE(file_size, 0), COALESCE(file_type, '')`

	var query string
	var args []any
	var scanOrder func([]Message) []Message
	switch {
	case after > 0:
		query = `SELECT ` + cols + ` FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?`
		args = []any{chatID, after, limit}
		scanOrder = func(in []Message) []Message { return in } // уже по возрастанию
	case before > 0:
		query = `SELECT ` + cols + ` FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?`
		args = []any{chatID, before, limit}
		scanOrder = func(in []Message) []Message { // наоборот: старые сначала
			for i, j := 0, len(in)-1; i < j; i, j = i+1, j-1 {
				in[i], in[j] = in[j], in[i]
			}
			return in
		}
	default:
		query = `SELECT ` + cols + ` FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?`
		args = []any{chatID, limit}
		scanOrder = func(in []Message) []Message {
			// старые сначала
			for i, j := 0, len(in)-1; i < j; i, j = i+1, j-1 {
				in[i], in[j] = in[j], in[i]
			}
			return in
		}
	}

	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()

	var count int
	var messages []Message
	for rows.Next() {
		count++
		var msg Message
		if err := rows.Scan(&msg.ID, &msg.ChatID, &msg.UserID, &msg.Username, &msg.Text, &msg.Timestamp,
			&msg.Type, &msg.StickerID, &msg.StickerURL, &msg.StickerPack,
			&msg.FileURL, &msg.FileName, &msg.FileSize, &msg.FileType); err != nil {
			return nil, false, err
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return scanOrder(messages), count == limit, nil
}

// ---------- Chats ----------

// EnsureGeneralChat добавляет пользователя в общий чат (идемпотентно).
func (d *Database) EnsureGeneralChat(userID int64) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.db.Exec(`INSERT OR IGNORE INTO chat_members (chat_id, user_id) VALUES (1, ?)`, userID)
	return err
}

func (d *Database) IsMember(chatID, userID int64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	var one int
	err := d.db.QueryRow(`SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?`, chatID, userID).Scan(&one)
	return err == nil
}

func (d *Database) FindUser(username string) (*User, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	var user User
	err := d.db.QueryRow(`SELECT id, username FROM users WHERE username = ?`, username).Scan(&user.ID, &user.Username)
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (d *Database) SearchUsers(query string, excludeID int64, limit int) ([]User, error) {
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	pattern := "%" + strings.TrimSpace(query) + "%"

	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.db.Query(`SELECT id, username FROM users WHERE id != ? AND username LIKE ? ORDER BY username LIMIT ?`,
		excludeID, pattern, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Username); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (d *Database) ChatMembers(chatID int64) ([]User, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.db.Query(`SELECT u.id, u.username FROM chat_members cm
		JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY u.username`, chatID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []User
	for rows.Next() {
		var user User
		if err := rows.Scan(&user.ID, &user.Username); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

// FindDirectChat ищет существующий личный чат двух пользователей.
func (d *Database) FindDirectChat(a, b int64) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	var chatID int64
	err := d.db.QueryRow(`
		SELECT cm1.chat_id FROM chat_members cm1
		JOIN chat_members cm2 ON cm2.chat_id = cm1.chat_id
		JOIN chats c ON c.id = cm1.chat_id
		WHERE c.type = 'direct' AND cm1.user_id = ? AND cm2.user_id = ?
		LIMIT 1`, a, b).Scan(&chatID)
	return chatID, err
}

func (d *Database) CreateDirectChat(a, b int64) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	tx, err := d.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	result, err := tx.Exec(`INSERT INTO chats (type, title, created_by) VALUES ('direct', '', ?)`, a)
	if err != nil {
		return 0, err
	}
	chatID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?), (?, ?)`, chatID, a, chatID, b); err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return chatID, nil
}

func (d *Database) CreateGroupChat(title string, creatorID int64, memberIDs []int64) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	tx, err := d.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	result, err := tx.Exec(`INSERT INTO chats (type, title, created_by) VALUES ('group', ?, ?)`, title, creatorID)
	if err != nil {
		return 0, err
	}
	chatID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}

	seen := map[int64]bool{creatorID: true}
	if _, err := tx.Exec(`INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)`, chatID, creatorID); err != nil {
		return 0, err
	}
	for _, id := range memberIDs {
		if id == 0 || seen[id] {
			continue
		}
		seen[id] = true
		if _, err := tx.Exec(`INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)`, chatID, id); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return chatID, nil
}

func (d *Database) MarkRead(chatID, userID, messageID int64) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.db.Exec(`UPDATE chat_members
		SET last_read_message_id = MAX(last_read_message_id, ?)
		WHERE chat_id = ? AND user_id = ?`, messageID, chatID, userID)
	return err
}

// ListChats возвращает чаты пользователя с последним сообщением и числом непрочитанных.
func (d *Database) ListChats(userID int64) ([]Chat, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	rows, err := d.db.Query(`SELECT c.id, c.type, c.title, cm.last_read_message_id
		FROM chats c JOIN chat_members cm ON cm.chat_id = c.id
		WHERE cm.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	type rowData struct {
		chat   Chat
		lastID int64
	}
	var items []rowData

	for rows.Next() {
		var item rowData
		var lastRead int64
		if err := rows.Scan(&item.chat.ID, &item.chat.Type, &item.chat.Title, &lastRead); err != nil {
			return nil, err
		}

		// последнее сообщение
		var text, sender, ts sql.NullString
		var lastID sql.NullInt64
		err := d.db.QueryRow(`SELECT id, text, username, timestamp FROM messages
			WHERE chat_id = ? ORDER BY id DESC LIMIT 1`, item.chat.ID).
			Scan(&lastID, &text, &sender, &ts)
		if err == nil {
			item.lastID = lastID.Int64
			item.chat.LastText = text.String
			item.chat.LastSender = sender.String
			item.chat.LastTime = ts.String
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}

		// непрочитанные
		if err := d.db.QueryRow(`SELECT COUNT(*) FROM messages
			WHERE chat_id = ? AND id > ? AND COALESCE(user_id, 0) != ?`,
			item.chat.ID, lastRead, userID).Scan(&item.chat.Unread); err != nil {
			return nil, err
		}

		// для личного чата показываем собеседника
		if item.chat.Type == "direct" {
			err := d.db.QueryRow(`SELECT u.id, u.username FROM chat_members cm
				JOIN users u ON u.id = cm.user_id
				WHERE cm.chat_id = ? AND cm.user_id != ? LIMIT 1`, item.chat.ID, userID).
				Scan(&item.chat.PeerID, &item.chat.Peer)
			if err == nil {
				item.chat.Title = item.chat.Peer
			}
		}

		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// новые сверху
	for i := 0; i < len(items); i++ {
		for j := i + 1; j < len(items); j++ {
			if items[j].lastID > items[i].lastID {
				items[i], items[j] = items[j], items[i]
			}
		}
	}

	chats := make([]Chat, 0, len(items))
	for _, item := range items {
		chats = append(chats, item.chat)
	}
	return chats, nil
}

func (d *Database) Close() error {
	return d.db.Close()
}

// ---------- Auth ----------

const (
	argonMemory  = 19456 // 19 MiB
	argonTime    = 2
	argonThreads = 1
	argonKeyLen  = 32
	sessionTTL   = 30 * 24 * time.Hour
)

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 5 || parts[0] != "argon2id" {
		return false
	}
	var memory, iterations uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[2], "m=%d,t=%d,p=%d", &memory, &iterations, &threads); err != nil {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	actual := argon2.IDKey([]byte(password), salt, iterations, memory, threads, uint32(len(expected)))
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

func (d *Database) CreateUser(username, password string) (*User, error) {
	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	result, err := d.db.Exec(`INSERT INTO users (username, password_hash) VALUES (?, ?)`, username, hash)
	if err != nil {
		return nil, err
	}
	id, _ := result.LastInsertId()
	return &User{ID: id, Username: username}, nil
}

func (d *Database) Authenticate(username, password string) (*User, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	var user User
	var hash string
	err := d.db.QueryRow(`SELECT id, username, password_hash FROM users WHERE username = ?`, username).
		Scan(&user.ID, &user.Username, &hash)
	if err != nil {
		return nil, err
	}
	if !verifyPassword(hash, password) {
		return nil, errors.New("invalid credentials")
	}
	return &user, nil
}

func (d *Database) CreateSession(userID int64) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	d.mu.Lock()
	defer d.mu.Unlock()

	expires := time.Now().Add(sessionTTL).Unix()
	_, err := d.db.Exec(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
		token, userID, expires)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (d *Database) UserByToken(token string) (*User, error) {
	if token == "" {
		return nil, errors.New("empty token")
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	var user User
	err := d.db.QueryRow(`
		SELECT u.id, u.username
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token = ? AND s.expires_at > ?`,
		token, time.Now().Unix()).Scan(&user.ID, &user.Username)
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (d *Database) DeleteSession(token string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, err := d.db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

func (d *Database) CleanupSessions() {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, err := d.db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, time.Now().Unix()); err != nil {
		log.Printf("session cleanup: %v", err)
	}
}

// ---------- Hub ----------

func newHub() *Hub {
	return &Hub{
		broadcast:  make(chan *Message, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]bool),
		db:         db,
	}
}

func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[client]; ok {
		delete(h.clients, client)
		close(client.send)
	}
}

func (h *Hub) stop() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		close(client.send)
		client.conn.Close()
		delete(h.clients, client)
	}
}

// writeISO — единый формат времени для БД и WS: UTC RFC3339.
// Старые записи (только ЧЧ:ММ:СС) клиент показывает как есть.
func writeISO(t time.Time) string {
	return t.UTC().Format(time.RFC3339)
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			clientCount := len(h.clients)
			h.mu.Unlock()

			log.Printf("[%s] подключился. Online: %d\n", client.username, clientCount)

			// Присутствие — это событие, а не сообщение в общем чате.
			h.sendToAll(map[string]any{
				"type":     "presence",
				"event":    "join",
				"username": client.username,
				"online":   clientCount,
			})

		case client := <-h.unregister:
			h.mu.RLock()
			_, ok := h.clients[client]
			h.mu.RUnlock()
			if ok {
				h.removeClient(client)
				log.Printf("[%s] отключился\n", client.username)
				h.sendToAll(map[string]any{
					"type":     "presence",
					"event":    "leave",
					"username": client.username,
					"online":   len(h.clients),
				})
			}

		case message := <-h.broadcast:
			if message.ChatID == 0 {
				message.ChatID = 1
			}
			if message.Username != "System" {
				if message.Timestamp == "" {
					message.Timestamp = writeISO(time.Now())
				}
				if err := h.db.SaveMessage(message); err != nil {
					log.Printf("Failed to save message: %v\n", err)
				}
			}

			var dead []*Client
			h.mu.RLock()
			for client := range h.clients {
				// сообщение уходит только участникам чата
				if !h.db.IsMember(message.ChatID, client.userID) {
					continue
				}
				select {
				case client.send <- message:
				default:
					dead = append(dead, client)
				}
			}
			h.mu.RUnlock()
			for _, client := range dead {
				h.removeClient(client)
				client.conn.Close()
			}
		}
	}
}

// sendToAll рассылает событие всем подключённым клиентам без записи в БД
// (presence, звонки и т.п.). Медленные клиенты отключаются, как и с сообщениями.
func (h *Hub) sendToAll(v any) {
	var dead []*Client
	h.mu.RLock()
	for client := range h.clients {
		select {
		case client.send <- v:
		default:
			dead = append(dead, client)
		}
	}
	h.mu.RUnlock()
	for _, client := range dead {
		h.removeClient(client)
		client.conn.Close()
	}
}

// ---------- Звонки (сигналинг WebRTC через WS) ----------
// Сервер — тупой релей: берёт поле "to" (username адресата), добавляет
// подлинные from/fromName и доставляет только ему. Ни БД, ни чаты не трогаем.
// Типы: call_offer | call_answer | call_ice | call_decline | call_hangup |
//       call_busy | call_ping… — любые call_*, клиент сам решает.
const (
	callMaxPayload = 64 << 10 // SDP/ICE не бывают больше 64 KiB
)

type callEnvelope struct {
	Type string `json:"type"`
	To   string `json:"to"`
}

// relayCall доставляет кадр call_* конкретному пользователю (по username).
// Ответ "call_offline" уходит отправителю, если адресат не в сети.
func (h *Hub) relayCall(from *Client, raw []byte) {
	if len(raw) > callMaxPayload {
		log.Printf("[%s] call-кадр слишком большой (%d байт)", from.username, len(raw))
		return
	}
	var env callEnvelope
	if err := json.Unmarshal(raw, &env); err != nil || env.Type == "" {
		return
	}
	to := strings.TrimSpace(env.To)
	if to == "" || to == from.username {
		return
	}

	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	delete(payload, "to")
	delete(payload, "chatId") // звонки не привязаны к чату
	payload["from"] = from.userID
	payload["fromName"] = from.username
	payload["type"] = env.Type

	var target *Client
	h.mu.RLock()
	for client := range h.clients {
		if client.username == to {
			target = client
			break
		}
	}
	h.mu.RUnlock()

	if target == nil {
		// Адресат не в сети — явно скажем об этом вызывающему.
		select {
		case from.send <- map[string]any{"type": "call_offline", "to": from.username, "fromName": to}:
		default:
		}
		return
	}

	// Мульти-логин: доставим всем сокетам адресата (телефон + комп).
	h.mu.RLock()
	for client := range h.clients {
		if client.username != to {
			continue
		}
		select {
		case client.send <- payload:
		default:
			// Медленный сокет пропускаем кадр — рингтон важнее вечности.
		}
	}
	h.mu.RUnlock()
}

// ---------- Websocket ----------

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 1 << 20 // 1 MiB
)

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		var raw json.RawMessage
		if err := c.conn.ReadJSON(&raw); err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			return
		}
		// Сигналинг звонков: точечная доставка, мимо чатов и БД.
		if c.isCallFrame(raw) {
			c.hub.relayCall(c, raw)
			continue
		}
		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			log.Printf("[%s] битый кадр: %v", c.username, err)
			continue
		}
		if msg.ChatID == 0 || !c.hub.db.IsMember(msg.ChatID, c.userID) {
			log.Printf("[%s] попытка писать в чужой чат %d", c.username, msg.ChatID)
			continue
		}
		msg.UserID = c.userID
		msg.Username = c.username
		msg.Timestamp = writeISO(time.Now())
		c.hub.broadcast <- &msg
	}
}

// isCallFrame быстро определяет, начинается ли кадр на call_ (SDP/ICE/управление).
func (c *Client) isCallFrame(raw []byte) bool {
	var probe struct {
		Type string `json:"type"`
		ChatID int64 `json:"chatId"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	return strings.HasPrefix(probe.Type, "call_") && probe.ChatID == 0
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteJSON(msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	// Апгрейд соединения делаем сразу, а авторизацию — первым кадром:
	// токен больше не передаётся в query-строке, чтобы не попадать в логи прокси.
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	authMsg := struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}{}
	if err := conn.ReadJSON(&authMsg); err != nil || authMsg.Type != "auth" {
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "auth required"),
			time.Now().Add(time.Second))
		conn.Close()
		return
	}

	user, err := db.UserByToken(authMsg.Token)
	if err != nil {
		_ = conn.WriteJSON(map[string]string{"type": "auth_error"})
		conn.Close()
		return
	}
	_ = conn.WriteJSON(map[string]string{"type": "auth_ok"})
	// Токен подтверждён — снимаем жёсткий дедлайн (далее им управляет readPump).
	_ = conn.SetReadDeadline(time.Time{})

	client := &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan any, 256),
		userID:   user.ID,
		username: user.Username,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump()
}

// ---------- Auth HTTP ----------

var (
	usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,32}$`)
	dummyHash  = func() string {
		h, _ := hashPassword("gor-dummy-password-for-timing")
		return h
	}()
	authLimiter  = newRateLimiter(20, 5*time.Minute)
	giphyLimiter = newRateLimiter(120, time.Minute)
)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type authResponse struct {
	Token string `json:"token"`
	User  *User  `json:"user"`
}

type rateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
	limit    int
	window   time.Duration
}

func newRateLimiter(limit int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		attempts: make(map[string][]time.Time),
		limit:    limit,
		window:   window,
	}
}

func (l *rateLimiter) Allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	recent := l.attempts[key][:0]
	for _, t := range l.attempts[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.limit {
		l.attempts[key] = recent
		return false
	}
	l.attempts[key] = append(recent, now)
	return true
}

func isTrustedProxy(host string) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, trusted := range config.TrustedIPs {
		if trusted.Equal(ip) {
			return true
		}
	}
	for _, ipnet := range config.TrustedNets {
		if ipnet.Contains(ip) {
			return true
		}
	}
	return false
}

// clientIP определяет адрес клиента. Заголовки X-Real-IP / X-Forwarded-For
// учитываются только от доверенных прокси (GOR_TRUSTED_PROXIES, по умолчанию
// loopback). Прямой пользователь с подделанным заголовком свой IP подменить не сможет.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if isTrustedProxy(host) {
		if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
			return real
		}
		if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
			return strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	return host
}

func tokenFromRequest(r *http.Request) string {
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	}
	// Медиа-теги (<img>/<video>/<audio>) не умеют заголовки, поэтому файлы
	// можно тянуть с токеном в параметре ?t= — только для путей файлов.
	if strings.HasPrefix(r.URL.Path, "/uploads/") || r.URL.Path == "/api/download" {
		if token := r.URL.Query().Get("t"); token != "" {
			return token
		}
	}
	if cookie, err := r.Cookie("gor_session"); err == nil {
		return cookie.Value
	}
	return ""
}

func authenticate(r *http.Request) (*User, error) {
	return db.UserByToken(tokenFromRequest(r))
}

func requireUser(w http.ResponseWriter, r *http.Request) (*User, bool) {
	user, err := authenticate(r)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	return user, true
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

func handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !authLimiter.Allow(clientIP(r)) {
		http.Error(w, "Слишком много попыток, попробуйте позже", http.StatusTooManyRequests)
		return
	}

	var creds credentials
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&creds); err != nil {
		http.Error(w, "Некорректный запрос", http.StatusBadRequest)
		return
	}
	creds.Username = strings.TrimSpace(creds.Username)

	if !usernameRe.MatchString(creds.Username) {
		http.Error(w, "Имя: 3-32 символа, латиница, цифры, _ . -", http.StatusBadRequest)
		return
	}
	if len(creds.Password) < 8 {
		http.Error(w, "Пароль должен быть не короче 8 символов", http.StatusBadRequest)
		return
	}
	if len(creds.Password) > 256 {
		http.Error(w, "Пароль слишком длинный", http.StatusBadRequest)
		return
	}

	user, err := db.CreateUser(creds.Username, creds.Password)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			http.Error(w, "Это имя уже занято", http.StatusConflict)
			return
		}
		log.Printf("register: %v", err)
		http.Error(w, "Не удалось создать аккаунт", http.StatusInternalServerError)
		return
	}

	token, err := db.CreateSession(user.ID)
	if err != nil {
		log.Printf("create session: %v", err)
		http.Error(w, "Не удалось создать сессию", http.StatusInternalServerError)
		return
	}

	db.EnsureGeneralChat(user.ID)

	log.Printf("Новый аккаунт: %s", user.Username)
	writeJSON(w, http.StatusCreated, authResponse{Token: token, User: user})
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !authLimiter.Allow(clientIP(r)) {
		http.Error(w, "Слишком много попыток, попробуйте позже", http.StatusTooManyRequests)
		return
	}

	var creds credentials
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&creds); err != nil {
		http.Error(w, "Некорректный запрос", http.StatusBadRequest)
		return
	}
	creds.Username = strings.TrimSpace(creds.Username)

	user, err := db.Authenticate(creds.Username, creds.Password)
	if err != nil {
		// Выравниваем время ответа, чтобы нельзя было перебрать имена.
		if errors.Is(err, sql.ErrNoRows) {
			verifyPassword(dummyHash, creds.Password)
		}
		http.Error(w, "Неверное имя или пароль", http.StatusUnauthorized)
		return
	}

	db.EnsureGeneralChat(user.ID)

	token, err := db.CreateSession(user.ID)
	if err != nil {
		log.Printf("create session: %v", err)
		http.Error(w, "Не удалось создать сессию", http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, authResponse{Token: token, User: user})
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if token := tokenFromRequest(r); token != "" {
		db.DeleteSession(token)
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"user": user})
}

// ---------- HTTP ----------

func handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	hub.mu.RLock()
	count := len(hub.clients)
	hub.mu.RUnlock()
	json.NewEncoder(w).Encode(map[string]int{"online": count})
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	status := "ok"
	if err := db.db.Ping(); err != nil {
		status = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  status,
		"uptime":  time.Since(config.StartTime).Round(time.Second).String(),
		"version": version,
	})
}

func handleUsers(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	users, err := db.SearchUsers(r.URL.Query().Get("q"), user.ID, 20)
	if err != nil {
		log.Printf("search users: %v", err)
		http.Error(w, "Не удалось найти пользователей", http.StatusInternalServerError)
		return
	}
	if users == nil {
		users = []User{}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"users": users})
}

type createChatRequest struct {
	Type      string   `json:"type"`
	Username  string   `json:"username"`
	Title     string   `json:"title"`
	Usernames []string `json:"usernames"`
}

func chatByID(userID, chatID int64) (*Chat, error) {
	chats, err := db.ListChats(userID)
	if err != nil {
		return nil, err
	}
	for i := range chats {
		if chats[i].ID == chatID {
			return &chats[i], nil
		}
	}
	return nil, sql.ErrNoRows
}

func handleChats(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	switch r.Method {
	case http.MethodGet:
		chats, err := db.ListChats(user.ID)
		if err != nil {
			log.Printf("list chats: %v", err)
			http.Error(w, "Не удалось загрузить чаты", http.StatusInternalServerError)
			return
		}
		if chats == nil {
			chats = []Chat{}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"chats": chats})

	case http.MethodPost:
		var req createChatRequest
		if err := json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req); err != nil {
			http.Error(w, "Некорректный запрос", http.StatusBadRequest)
			return
		}

		switch req.Type {
		case "direct":
			peer, err := db.FindUser(strings.TrimSpace(req.Username))
			if err != nil {
				http.Error(w, "Пользователь не найден", http.StatusNotFound)
				return
			}
			if peer.ID == user.ID {
				http.Error(w, "Нельзя начать чат с самим собой", http.StatusBadRequest)
				return
			}

			chatID, err := db.FindDirectChat(user.ID, peer.ID)
			if errors.Is(err, sql.ErrNoRows) {
				chatID, err = db.CreateDirectChat(user.ID, peer.ID)
			}
			if err != nil {
				log.Printf("create direct chat: %v", err)
				http.Error(w, "Не удалось создать чат", http.StatusInternalServerError)
				return
			}

			chat, err := chatByID(user.ID, chatID)
			if err != nil {
				http.Error(w, "Чат создан, но не найден", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]interface{}{"chat": chat})

		case "group":
			title := strings.TrimSpace(req.Title)
			if len([]rune(title)) < 1 || len([]rune(title)) > 64 {
				http.Error(w, "Название группы: от 1 до 64 символов", http.StatusBadRequest)
				return
			}
			if len(req.Usernames) == 0 {
				http.Error(w, "Добавьте хотя бы одного участника", http.StatusBadRequest)
				return
			}
			if len(req.Usernames) > 50 {
				http.Error(w, "Слишком много участников (максимум 50)", http.StatusBadRequest)
				return
			}

			var memberIDs []int64
			for _, name := range req.Usernames {
				member, err := db.FindUser(strings.TrimSpace(name))
				if err != nil {
					http.Error(w, fmt.Sprintf("Пользователь %q не найден", name), http.StatusNotFound)
					return
				}
				memberIDs = append(memberIDs, member.ID)
			}

			chatID, err := db.CreateGroupChat(title, user.ID, memberIDs)
			if err != nil {
				log.Printf("create group: %v", err)
				http.Error(w, "Не удалось создать группу", http.StatusInternalServerError)
				return
			}
			chat, err := chatByID(user.ID, chatID)
			if err != nil {
				http.Error(w, "Группа создана, но не найдена", http.StatusInternalServerError)
				return
			}
			writeJSON(w, http.StatusCreated, map[string]interface{}{"chat": chat})

		default:
			http.Error(w, "Тип чата: direct или group", http.StatusBadRequest)
		}

	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleChatSubroutes обслуживает /api/chats/{id}/messages и /api/chats/{id}/read.
func handleChatSubroutes(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	rest := strings.TrimPrefix(r.URL.Path, "/api/chats/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	chatID, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || chatID <= 0 {
		http.NotFound(w, r)
		return
	}
	if !db.IsMember(chatID, user.ID) {
		http.Error(w, "Нет доступа к чату", http.StatusForbidden)
		return
	}

	switch {
	case parts[1] == "messages" && r.Method == http.MethodGet:
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
		before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
		messages, hasMore, err := db.GetMessagesPage(chatID, limit, after, before)
		if err != nil {
			log.Printf("get chat messages: %v", err)
			http.Error(w, "Не удалось загрузить сообщения", http.StatusInternalServerError)
			return
		}
		if messages == nil {
			messages = []Message{}
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"messages": messages, "hasMore": hasMore})

	case parts[1] == "read" && r.Method == http.MethodPost:
		var body struct {
			MessageID int64 `json:"messageId"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1024)).Decode(&body); err != nil {
			http.Error(w, "Некорректный запрос", http.StatusBadRequest)
			return
		}
		if err := db.MarkRead(chatID, user.ID, body.MessageID); err != nil {
			log.Printf("mark read: %v", err)
			http.Error(w, "Не удалось отметить прочитанным", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.NotFound(w, r)
	}
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	chatID, _ := strconv.ParseInt(r.URL.Query().Get("chatId"), 10, 64)
	if chatID == 0 {
		chatID = 1
	}
	if !db.IsMember(chatID, user.ID) {
		http.Error(w, "Нет доступа к чату", http.StatusForbidden)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	messages, err := db.GetMessages(chatID, 100)
	if err != nil {
		http.Error(w, "Failed to get messages", http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(messages)
}

func getFileType(filename string) string {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg":
		return "image"
	case ".mp3", ".wav", ".ogg", ".flac", ".aac":
		return "audio"
	case ".mp4", ".webm", ".avi", ".mov", ".mkv":
		return "video"
	default:
		return "document"
	}
}

// safeUploadName делает имя файла безопасным (без путей и управляющих символов).
func safeUploadName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(r rune) rune {
		if r < 32 || r == '/' || r == '\\' {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "file"
	}
	if len(name) > 128 {
		ext := filepath.Ext(name)
		name = name[:120] + ext
	}
	return name
}

// handleGiphy — прокси поиска GIF. Ключ живёт в GOR_GIPHY_KEY на сервере,
// а не в бандле клиента; поисковые запросы не уходят на GIPHY напрямую от юзера.
func handleGiphy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if _, ok := requireUser(w, r); !ok {
		return
	}
	if !giphyLimiter.Allow(clientIP(r)) {
		http.Error(w, "Слишком много запросов, попробуйте позже", http.StatusTooManyRequests)
		return
	}
	if config.GiphyKey == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
			"error": "GIPHY отключён: задайте GOR_GIPHY_KEY на сервере",
		})
		return
	}

	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		http.Error(w, "Укажите поисковый запрос ?q=", http.StatusBadRequest)
		return
	}
	apiURL := fmt.Sprintf("https://api.giphy.com/v1/gifs/search?api_key=%s&q=%s&limit=12&rating=pg-13",
		url.QueryEscape(config.GiphyKey), url.QueryEscape(query))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(apiURL)
	if err != nil {
		log.Printf("giphy: %v", err)
		http.Error(w, "Не удалось выполнить поиск GIF", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	var payload struct {
		Data []struct {
			ID     string `json:"id"`
			Title  string `json:"title"`
			Images struct {
				FixedWidthDownsampled struct {
					URL string `json:"url"`
				} `json:"fixed_width_downsampled"`
			} `json:"images"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&payload); err != nil {
		http.Error(w, "От GIPHY пришёл некорректный ответ", http.StatusBadGateway)
		return
	}

	gifs := make([]map[string]string, 0, len(payload.Data))
	for _, item := range payload.Data {
		if item.ID == "" || item.Images.FixedWidthDownsampled.URL == "" {
			continue
		}
		gifs = append(gifs, map[string]string{
			"id":    item.ID,
			"url":   item.Images.FixedWidthDownsampled.URL,
			"title": item.Title,
		})
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"data": gifs})
}

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	if err := os.MkdirAll(config.UploadDir, 0755); err != nil {
		http.Error(w, "Failed to create uploads directory", http.StatusInternalServerError)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, config.MaxUpload+1024*1024)
	if err := r.ParseMultipartForm(config.MaxUpload); err != nil {
		http.Error(w, "File too large (max 50MB)", http.StatusBadRequest)
		return
	}

	file, fileHeader, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to get file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if fileHeader.Size > config.MaxUpload {
		http.Error(w, "File too large (max 50MB)", http.StatusBadRequest)
		return
	}

	username := user.Username

	chatID, _ := strconv.ParseInt(r.FormValue("chatId"), 10, 64)
	if chatID == 0 {
		chatID = 1
	}
	if !db.IsMember(chatID, user.ID) {
		http.Error(w, "Нет доступа к чату", http.StatusForbidden)
		return
	}

	originalName := safeUploadName(fileHeader.Filename)
	filename := filepath.Join(config.UploadDir, fmt.Sprintf("%d_%s", time.Now().UnixNano(), originalName))

	dst, err := os.Create(filename)
	if err != nil {
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	size, err := io.Copy(dst, file)
	if err != nil {
		os.Remove(filename)
		http.Error(w, "Failed to copy file", http.StatusInternalServerError)
		return
	}

	msg := &Message{
		ChatID:    chatID,
		UserID:    user.ID,
		Username:  username,
		Text:      "📎 Отправил файл",
		Type:      "file",
		Timestamp: writeISO(time.Now()),
		FileURL:   fmt.Sprintf("/uploads/%s", filepath.Base(filename)),
		FileName:  originalName,
		FileSize:  size,
		FileType:  getFileType(originalName),
	}

	// hub сам сохранит сообщение в БД и разошлёт всем
	hub.broadcast <- msg

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success":  true,
		"fileUrl":  msg.FileURL,
		"fileName": msg.FileName,
		"fileSize": msg.FileSize,
		"fileType": msg.FileType,
	})
}

// ---------- Раздача файлов: только участникам чата ----------

// ChatIDByUpload возвращает chat_id сообщения, к которому прикреплён файл.
func (d *Database) ChatIDByUpload(fileURL string) (int64, error) {
	var chatID int64
	err := d.db.QueryRow(`SELECT COALESCE(chat_id, 1) FROM messages WHERE file_url = ? ORDER BY id LIMIT 1`, fileURL).Scan(&chatID)
	return chatID, err
}

// resolveUploadPath возвращает путь внутри uploads или ошибку.
func resolveUploadPath(name string) (string, error) {
	uploadsDir, err := filepath.Abs(config.UploadDir)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(uploadsDir, filepath.Base(filepath.Clean("/"+name)))
	rel, err := filepath.Rel(uploadsDir, candidate)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", errors.New("path outside uploads")
	}
	return candidate, nil
}

// handleUploadsRead отдаёт файлы из /uploads только участникам чата,
// к которому файл прикреплён сообщением.
func handleUploadsRead(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	name := filepath.Base(r.URL.Path) // Base отсекает path traversal
	path, err := resolveUploadPath(name)
	if err != nil {
		http.Error(w, "Bad request", http.StatusBadRequest)
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}

	// Привязка к чату — по сообщению с этим file_url.
	chatID, chatErr := db.ChatIDByUpload("/uploads/" + name)
	if chatErr != nil && !db.IsMember(1, user.ID) {
		// Файл без привязки к сообщению (старые релизы): разрешаем только
		// участникам «Общего чата», куда входят все пользователи.
		http.Error(w, "Нет доступа к файлу", http.StatusForbidden)
		return
	}
	if chatErr == nil && !db.IsMember(chatID, user.ID) {
		http.Error(w, "Нет доступа к файлу", http.StatusForbidden)
		return
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, path)
}

func handleDownload(w http.ResponseWriter, r *http.Request) {
	user, ok := requireUser(w, r)
	if !ok {
		return
	}

	filePath, err := resolveUploadPath(r.URL.Query().Get("file"))
	if err != nil {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	// Та же проверка доступа, что и у /uploads/: файл = сообщение = чат.
	name := filepath.Base(filePath)
	chatID, chatErr := db.ChatIDByUpload("/uploads/" + name)
	if chatErr != nil && !db.IsMember(1, user.ID) {
		http.Error(w, "Нет доступа к файлу", http.StatusForbidden)
		return
	}
	if chatErr == nil && !db.IsMember(chatID, user.ID) {
		http.Error(w, "Нет доступа к файлу", http.StatusForbidden)
		return
	}

	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filePath)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" || strings.HasPrefix(r.URL.Path, "/api/stats") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}

func main() {
	config = buildConfig()
	upgrader = websocket.Upgrader{
		CheckOrigin:      checkOrigin,
		HandshakeTimeout: 10 * time.Second,
	}

	var err error
	db, err = NewDatabase(config.DBPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v\n", err)
	}
	defer db.Close()

	if err := os.MkdirAll(config.UploadDir, 0755); err != nil {
		log.Fatalf("Failed to create uploads directory: %v\n", err)
	}

	hub = newHub()
	go hub.run()

	db.CleanupSessions()
	go func() {
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			db.CleanupSessions()
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/api/stats", handleStats)
	mux.HandleFunc("/api/health", handleHealth)
	mux.HandleFunc("/api/auth/register", handleRegister)
	mux.HandleFunc("/api/auth/login", handleLogin)
	mux.HandleFunc("/api/auth/logout", handleLogout)
	mux.HandleFunc("/api/auth/me", handleMe)
	mux.HandleFunc("/api/messages", handleMessages)
	mux.HandleFunc("/api/users", handleUsers)
	mux.HandleFunc("/api/chats", handleChats)
	mux.HandleFunc("/api/chats/", handleChatSubroutes)
	mux.HandleFunc("/api/upload", handleUpload)
	mux.HandleFunc("/api/download", handleDownload)
	mux.HandleFunc("/api/giphy", handleGiphy)
	mux.HandleFunc("/uploads/", handleUploadsRead)

	if _, err := os.Stat(config.StaticDir); err == nil {
		mux.Handle("/", http.FileServer(http.Dir(config.StaticDir)))
	} else {
		log.Printf("ВНИМАНИЕ: каталог фронтенда %q не найден", config.StaticDir)
		log.Printf("Соберите клиент: cd frontend && npm ci && npm run build")
	}

	srv := &http.Server{
		Addr:              ":" + config.Port,
		Handler:           logRequests(cors(mux)),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	log.Printf("GOR %s запущен", version)
	log.Printf("WebSocket: ws://localhost:%s/ws", config.Port)
	log.Printf("HTTP:      http://localhost:%s", config.Port)
	log.Printf("Database:  %s", config.DBPath)
	log.Printf("Uploads:   %s", config.UploadDir)
	log.Printf("Static:    %s", config.StaticDir)

	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Println("Останавливаюсь, закрываю соединения...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("ошибка завершения HTTP: %v", err)
	}
	hub.stop()
	log.Println("Готово.")
}
