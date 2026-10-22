// Релей-клиент VAKSA: держит исходящее WebSocket-соединение с
// Cloudflare Worker (vaksa-relay) и проксирует его каналы в наш
// сервер GOR (http://127.0.0.1:8080). WS-кадры и HTTP-запросы
// мультиплексируются по channelId в едином соединении.
package main

import (
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Frame — кадр протокола между Worker'ом и этим клиентом (рус. комментарии).
type Frame struct {
	C     int           `json:"c"`
	Req   *RequestMeta  `json:"req,omitempty"`
	Resp  *ResponseMeta `json:"resp,omitempty"`
	D     string        `json:"d,omitempty"` // base64 чанк тела
	T     string        `json:"t,omitempty"` // текст WS-канала
	Fin   *bool         `json:"fin,omitempty"`
	Close bool          `json:"close,omitempty"`
	Err   string        `json:"err,omitempty"`
	Ping  bool          `json:"ping,omitempty"`
	OK    bool          `json:"ok,omitempty"`
}

type RequestMeta struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	WS      bool              `json:"ws"`
}

type ResponseMeta struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
}

// RelayClient — одно соединение с Worker'ом.
type RelayClient struct {
	url     string
	key     string
	backend string
	ws      *websocket.Conn
	wmu     sync.Mutex // gorilla не потокобезопасна на запись

	// каналы в обработке
	mu       sync.Mutex
	channels map[int]*chanInfo
}

type chanInfo struct {
	meta         *RequestMeta
	body         []byte          // накопленное тело запроса (http-режим)
	ws           *websocket.Conn // бекенд-WS (ws-режим)
	body_started bool
	done         bool
}

var busySem chan struct{} // ограничитель параллелизма исходящих запросов

func main() {
	relayURL := flag.String("relay", "wss://vaksa.space/__relay/home", "адрес Worker-релея")
	key := flag.String("key", "", "секрет X-Relay-Key (совпадает с wrangler secret)")
	backend := flag.String("backend", "http://127.0.0.1:8080", "адрес GOR")
	flag.Parse()
	if *key == "" {
		if env := os.Getenv("RELAY_KEY"); env != "" {
			*key = env
		} else {
			log.Fatal("нет ключа: --key или RELAY_KEY")
		}
	}
	// Бекенд на localhost — редкий случай передачи через прокси-переменные.
	os.Unsetenv("HTTP_PROXY")
	os.Unsetenv("HTTPS_PROXY")
	os.Unsetenv("ALL_PROXY")
	os.Unsetenv("http_proxy")
	os.Unsetenv("https_proxy")
	os.Unsetenv("all_proxy")

	busySem = make(chan struct{}, 64)

	c := &RelayClient{url: *relayURL, key: *key, backend: *backend}
	for {
		err := c.connectAndRun()
		log.Printf("релей-клиент: соединение закрыто (%v); переподключение через 5с", err)
		time.Sleep(5 * time.Second)
	}
}

func (c *RelayClient) connectAndRun() error {
	log.Printf("релей-клиент: подключаемся к %s", c.url)
	dialer := &websocket.Dialer{
		TLSClientConfig:  &tls.Config{ServerName: urlHostname(c.url)},
		HandshakeTimeout: 20 * time.Second,
	}
	hdr := http.Header{"X-Relay-Key": []string{c.key}}
	ws, _, err := dialer.Dial(c.url, hdr)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	c.ws = ws
	c.channels = make(map[int]*chanInfo)
	defer ws.Close()

	// Периодический ping (контрольный кадр gorilla), чтобы соединение не рвалось.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				c.write(func() error {
					return ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second))
				})
			}
		}
	}()

	for {
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		c.handleFrame(raw)
	}
}

func (c *RelayClient) write(fn func() error) {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_ = fn()
}

// handleFrame — разбор кадра. Читает входящее сообщение.
func (c *RelayClient) handleFrame(raw []byte) {
	var f Frame
	if err := json.Unmarshal(raw, &f); err != nil {
		log.Printf("релей-клиент: мусор кадра: %v", err)
		return
	}
	if f.Ping || f.OK {
		return
	}

	c.mu.Lock()
	ch := c.channels[f.C]
	if ch == nil && f.Req != nil {
		ch = &chanInfo{meta: f.Req}
		c.channels[f.C] = ch
	}
	c.mu.Unlock()
	if ch == nil {
		return
	}

	if f.D != "" {
		b, _ := base64.StdEncoding.DecodeString(f.D)
		ch.body = append(ch.body, b...)
	}
	if f.T != "" && ch.ws != nil {
		// ws-канал: пересылаем текст в бекенд
		c.write(func() error { return ch.ws.WriteMessage(websocket.TextMessage, []byte(f.T)) })
	}
	if f.Close {
		if ch.ws != nil {
			c.write(func() error {
				return ch.ws.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "eof"))
			})
		}
		c.mu.Lock()
		ch.done = true
		delete(c.channels, f.C)
		c.mu.Unlock()
		return
	}
	// req уже получили, ждём fin — тело пришло полностью.
	if f.Fin != nil && *f.Fin && ch.meta != nil && !ch.meta.WS && !ch.body_started {
		ch.body_started = true
		go c.serveHTTP(f.C, ch)
	}
}

// serveHTTP выполняет HTTP-запрос к GOR и отправляет ответ релею.
func (c *RelayClient) serveHTTP(chID int, ch *chanInfo) {
	busySem <- struct{}{}
	defer func() { <-busySem }()

	meta := ch.meta
	target := c.backend + meta.Path
	req, err := http.NewRequest(meta.Method, target, strings.NewReader(string(ch.body)))
	if err != nil {
		c.frame(chID, Frame{Resp: &ResponseMeta{Status: 502, Headers: map[string]string{"Content-Type": "text/plain"}}, Fin: boolPtr(true)})
		return
	}
	for k, v := range meta.Headers {
		// Заголовки клиента до origin: передаём почти всё.
		switch strings.ToLower(k) {
		case "x-relay-key", "x-relay-channel":
			continue
		}
		req.Header.Set(k, v)
	}

	// WS-канал (браузерный апгрейд) — отдельный тракт.
	if meta.WS {
		c.serveWS(chID, ch, req)
		return
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.frame(chID, Frame{Resp: &ResponseMeta{Status: 502, Headers: map[string]string{"Content-Type": "text/plain; charset=utf-8"}},
			D: base64.StdEncoding.EncodeToString([]byte("релей: бекенд недоступен")), Fin: boolPtr(true)})
		return
	}
	defer resp.Body.Close()

	hdrs := map[string]string{}
	for k, vals := range resp.Header {
		// Transfer-Encoding не дублируем — worker сам соберёт тело.
		if strings.EqualFold(k, "Transfer-Encoding") || strings.EqualFold(k, "Connection") {
			continue
		}
		if len(vals) > 0 {
			hdrs[k] = strings.Join(vals, ", ")
		}
	}
	c.frame(chID, Frame{Resp: &ResponseMeta{Status: resp.StatusCode, Headers: hdrs}})

	// Чанки ответа по 512 КиБ.
	buf := make([]byte, 512*1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			c.frame(chID, Frame{D: base64.StdEncoding.EncodeToString(chunk)})
		}
		if rerr != nil {
			break
		}
	}
	c.frame(chID, Frame{Fin: boolPtr(true)})

	// Канал завершён - чистим.
	c.mu.Lock()
	delete(c.channels, chID)
	c.mu.Unlock()
}

// serveWS проксирует WS-канал: браузер <-> GOR /ws.
func (c *RelayClient) serveWS(chID int, ch *chanInfo, req *http.Request) {
	// Своё dial-подключение к GOR /ws без прокси.
	dialer := &websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	hdr := http.Header{}
	for k, vals := range req.Header {
		v := strings.Join(vals, ", ")
		if strings.HasPrefix(strings.ToLower(k), "sec-websocket-") || strings.EqualFold(k, "connection") || strings.EqualFold(k, "upgrade") {
			continue // gorilla проставит всё сама
		}
		hdr.Set(k, v)
	}
	// ws:// вместо http://
	wsURL := "ws://127.0.0.1:8080" + req.URL.RequestURI()
	backend, resp, err := dialer.Dial(wsURL, hdr)
	if err != nil {
		msg := "gor-relay: не удалось открыть WS к бекенду"
		c.frame(chID, Frame{Close: true, Err: msg})
		return
	}
	defer backend.Close()
	_ = resp

	c.mu.Lock()
	ch.ws = backend
	c.mu.Unlock()

	// backend -> worker
	go func() {
		for {
			mt, data, err := backend.ReadMessage()
			if err != nil {
				c.frame(chID, Frame{Close: true})
				return
			}
			switch mt {
			case websocket.TextMessage:
				c.frame(chID, Frame{T: string(data)})
			case websocket.BinaryMessage:
				c.frame(chID, Frame{D: base64.StdEncoding.EncodeToString(data)})
			default:
				// управляющие кадры gorilla сам хэндлит хендлерами ниже
			}
		}
	}()
	backend.SetPingHandler(func(appdata string) error {
		// Отвечаем PONG и одновременно тегаем жизнь канала для релея.
		c.frame(chID, Frame{Ping: true})
		c.write(func() error {
			return backend.WriteControl(websocket.PongMessage, []byte(appdata), time.Now().Add(5*time.Second))
		})
		return nil
	})
	backend.SetPongHandler(func(string) error { return nil })
	backend.SetCloseHandler(func(code int, text string) error {
		c.frame(chID, Frame{Close: true})
		return nil
	})

	// сообщение от worker (браузера) приходит в главном readLoop через handleFrame.
	// Пока канал жив — просто держим соединение.
	for {
		c.mu.Lock()
		gone := !c.hasChannel(chID)
		c.mu.Unlock()
		if gone {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func (c *RelayClient) hasChannel(chID int) bool {
	_, ok := c.channels[chID]
	return ok
}

func (c *RelayClient) frame(chID int, f Frame) {
	f.C = chID
	raw, err := json.Marshal(f)
	if err != nil {
		return
	}
	c.write(func() error { return c.ws.WriteMessage(websocket.TextMessage, raw) })
}

func boolPtr(b bool) *bool { return &b }

func urlHostname(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}
