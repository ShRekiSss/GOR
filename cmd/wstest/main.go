// Мини-клиент для проверки WS-протокола VAKSA:
// 1) коннект без токена, 2) auth первым кадром, 3) ждём auth_ok.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: wstest <ws-url> <token>")
		os.Exit(1)
	}
	url, token := os.Args[1], os.Args[2]

	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		fmt.Println("dial:", err)
		os.Exit(1)
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))

	if err := conn.WriteJSON(map[string]string{"type": "auth", "token": token}); err != nil {
		fmt.Println("send auth:", err)
		os.Exit(1)
	}

	var reply map[string]interface{}
	if err := conn.ReadJSON(&reply); err != nil {
		fmt.Println("read reply:", err)
		os.Exit(1)
	}
	if reply["type"] != "auth_ok" {
		b, _ := json.Marshal(reply)
		fmt.Println("ожидаем auth_ok, получили:", string(b))
		os.Exit(1)
	}
	fmt.Println("WS auth: OK (первым кадром)")
}
