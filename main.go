package main

import (
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
)

type Message struct {
	ID         int    `json:"id,omitempty"`
	Username   string `json:"username"`
	Text       string `json:"text"`
	Timestamp  string `json:"timestamp"`
	Type       string `json:"type,omitempty"`
	StickerID  string `json:"stickerId,omitempty"`
	StickerURL string `json:"stickerUrl,omitempty"`
	StickerPack string `json:"stickerPack,omitempty"`
	FileURL    string `json:"fileUrl,omitempty"`
	FileName   string `json:"fileName,omitempty"`
	FileSize   int64  `json:"fileSize,omitempty"`
	FileType   string `json:"fileType,omitempty"` // image, audio, video, document
}

type Database struct {
	db *sql.DB
	mu sync.Mutex
}

type Hub struct {
	clients    map[*Client]bool
	broadcast chan *Message
	register   chan *Client
	unregister chan *Client
	db         *Database
	mu         sync.RWMutex
}

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan *Message
	username string
}

var hub *Hub
var db *Database

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Database methods
func NewDatabase(dbPath string) (*Database, error) {
	sqlDB, err := sql.Open("sqlite3", dbPath)
	if err != nil {
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
	_, err := d.db.Exec(schema)
	if err != nil {
		return err
	}
	return d.ensureColumns()
}

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

	columns := []string{"message_type", "sticker_id", "sticker_url", "sticker_pack"}
	for _, col := range columns {
		if !existing[col] {
			if _, err := d.db.Exec(fmt.Sprintf("ALTER TABLE messages ADD COLUMN %s TEXT", col)); err != nil {
				return err
			}
		}
	}

	return nil
}

func (d *Database) SaveMessage(msg *Message) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	query := `INSERT INTO messages (username, text, timestamp, message_type, sticker_id, sticker_url, sticker_pack, file_url, file_name, file_size, file_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	result, err := d.db.Exec(query, msg.Username, msg.Text, msg.Timestamp, msg.Type, msg.StickerID, msg.StickerURL, msg.StickerPack, msg.FileURL, msg.FileName, msg.FileSize, msg.FileType)
	if err != nil {
		return err
	}
	id, _ := result.LastInsertId()
	msg.ID = int(id)
	return nil
}

func (d *Database) GetRecentMessages(limit int) ([]Message, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	query := `SELECT id, username, text, timestamp, COALESCE(message_type, ''), COALESCE(sticker_id, ''), COALESCE(sticker_url, ''), COALESCE(sticker_pack, ''), COALESCE(file_url, ''), COALESCE(file_name, ''), COALESCE(file_size, 0), COALESCE(file_type, '') FROM messages ORDER BY id DESC LIMIT ?`
	rows, err := d.db.Query(query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var msg Message
		if err := rows.Scan(&msg.ID, &msg.Username, &msg.Text, &msg.Timestamp, &msg.Type, &msg.StickerID, &msg.StickerURL, &msg.StickerPack, &msg.FileURL, &msg.FileName, &msg.FileSize, &msg.FileType); err != nil {
			return nil, err
		}
		messages = append(messages, msg)
	}

	// Reverse to show oldest first
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}

	return messages, nil
}

func (d *Database) Close() error {
	return d.db.Close()
}

// Hub constructor
func newHub() *Hub {
	return &Hub{
		broadcast:  make(chan *Message, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		clients:    make(map[*Client]bool),
		db:         db,
	}
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

			// Load chat history
			history, err := h.db.GetRecentMessages(50)
			if err != nil {
				log.Printf("Failed to load history: %v\n", err)
			} else if len(history) > 0 {
				// Send history to new client
				for _, msg := range history {
					select {
					case client.send <- &msg:
					default:
						log.Println("History send failed - client buffer full")
					}
				}
			}

			// Notify others
			systemMsg := &Message{
				Username:  "System",
				Text:      fmt.Sprintf("[%s] присоединился к чату", client.username),
				Timestamp: time.Now().Format("15:04:05"),
			}
			h.broadcast <- systemMsg

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				h.mu.Unlock()
				log.Printf("[%s] отключился\n", client.username)

				// Notify others
				systemMsg := &Message{
					Username:  "System",
					Text:      fmt.Sprintf("[%s] покинул чат", client.username),
					Timestamp: time.Now().Format("15:04:05"),
				}
				h.broadcast <- systemMsg
			} else {
				h.mu.Unlock()
			}

		case message := <-h.broadcast:
			// Save message to database if it's not a system message
			if message.Username != "System" {
				if message.Timestamp == "" {
					message.Timestamp = time.Now().Format("15:04:05")
				}
				if err := h.db.SaveMessage(message); err != nil {
					log.Printf("Failed to save message: %v\n", err)
				}
			}

			// Broadcast to all clients
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetPongHandler(func(string) error {
		return nil
	})

	for {
		var msg Message
		err := c.conn.ReadJSON(&msg)
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("error: %v", err)
			}
			return
		}
		msg.Username = c.username
		msg.Timestamp = time.Now().Format("15:04:05")
		c.hub.broadcast <- &msg
	}
}

func (c *Client) writePump() {
	for {
		msg, ok := <-c.send
		if !ok {
			return
		}
		err := c.conn.WriteJSON(msg)
		if err != nil {
			return
		}
	}
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	username := r.URL.Query().Get("username")
	if username == "" {
		username = "Anonymous"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println(err)
		return
	}

	client := &Client{
		hub:      hub,
		conn:     conn,
		send:     make(chan *Message, 256),
		username: username,
	}

	hub.register <- client

	go client.writePump()
	go client.readPump()
}

func handleStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	hub.mu.RLock()
	count := len(hub.clients)
	hub.mu.RUnlock()
	json.NewEncoder(w).Encode(map[string]int{
		"online": count,
	})
}

func handleMessages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	messages, err := db.GetRecentMessages(100)
	if err != nil {
		http.Error(w, "Failed to get messages", http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(messages)
}

// getFileType determines file type based on extension
func getFileType(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))

	switch ext {
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

func handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Create uploads directory if it doesn't exist
	if err := os.MkdirAll("./uploads", 0755); err != nil {
		http.Error(w, "Failed to create uploads directory", http.StatusInternalServerError)
		return
	}

	// Parse form with max 50MB
	maxSize := int64(50 * 1024 * 1024) // 50MB
	if err := r.ParseMultipartForm(maxSize); err != nil {
		http.Error(w, "File too large (max 50MB)", http.StatusBadRequest)
		return
	}

	file, fileHeader, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Failed to get file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	// Check file size
	if fileHeader.Size > maxSize {
		http.Error(w, "File too large (max 50MB)", http.StatusBadRequest)
		return
	}

	username := r.FormValue("username")
	if username == "" {
		username = "Anonymous"
	}

	// Generate unique filename
	timestamp := time.Now().Unix()
	filename := filepath.Join("./uploads", fmt.Sprintf("%d_%s", timestamp, fileHeader.Filename))

	// Create destination file
	dst, err := os.Create(filename)
	if err != nil {
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	// Copy file
	size, err := io.Copy(dst, file)
	if err != nil {
		http.Error(w, "Failed to copy file", http.StatusInternalServerError)
		return
	}

	// Determine file type
	fileType := getFileType(fileHeader.Filename)

	// Create message with file info
	msg := &Message{
		Username:   username,
		Text:       "📎 Отправил файл",
		Type:       "file",
		Timestamp:  time.Now().Format("15:04:05"),
		FileURL:    fmt.Sprintf("/uploads/%s", filepath.Base(filename)),
		FileName:   fileHeader.Filename,
		FileSize:   size,
		FileType:   fileType,
	}

	// Save to database
	if err := db.SaveMessage(msg); err != nil {
		log.Printf("Failed to save file message: %v\n", err)
	}

	// Broadcast to all clients
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

func handleDownload(w http.ResponseWriter, r *http.Request) {
	filePath := filepath.Join("./uploads", r.URL.Query().Get("file"))
	
	// Prevent directory traversal
	absPath, _ := filepath.Abs(filePath)
	uploadsDir, _ := filepath.Abs("./uploads")
	if !strings.HasPrefix(absPath, uploadsDir) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	info, err := os.Stat(filePath)
	if err != nil || info.IsDir() {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	http.ServeFile(w, r, filePath)
}

func main() {
	port := flag.String("port", "8080", "WebSocket server port")
	flag.Parse()

	// Initialize database
	var err error
	db, err = NewDatabase("./chat.db")
	if err != nil {
		log.Fatalf("Failed to initialize database: %v\n", err)
	}
	defer db.Close()

	// Create uploads directory
	os.MkdirAll("./uploads", 0755)

	hub = newHub()
	go hub.run()

	http.HandleFunc("/ws", handleWS)
	http.HandleFunc("/api/stats", handleStats)
	http.HandleFunc("/api/messages", handleMessages)
	http.HandleFunc("/api/upload", handleUpload)
	http.HandleFunc("/api/download", handleDownload)
	http.Handle("/uploads/", http.StripPrefix("/uploads/", http.FileServer(http.Dir("./uploads"))))
	http.Handle("/", http.FileServer(http.Dir("./frontend/build")))

	addr := ":" + *port
	log.Printf("WebSocket server running on ws://localhost%s/ws\n", addr)
	log.Printf("HTTP server running on http://localhost%s\n", addr)
	log.Printf("Database: ./chat.db\n")
	log.Printf("Uploads directory: ./uploads\n")
	log.Fatal(http.ListenAndServe(addr, nil))
}
