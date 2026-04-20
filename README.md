# GOR
Retro-style messenger with WebSocket chat

## Features
- 🎮 Retro terminal-style UI (green on black)
- 💬 Real-time WebSocket chat
- 👥 Multiple concurrent users
- 🔔 System notifications for user joins/leaves
- 📱 Mobile-responsive design
- 🎨 Стикеры и GIPHY поиск

## Installation & Setup

### Prerequisites
- Go 1.16+
- Node.js 14+
- npm

### Build & Run

1. **Install frontend dependencies:**
```bash
cd frontend
npm install
```

2. **Build frontend:**
```bash
npm run build
cd ..
```

3. **Run the server:**
```bash
go run main.go
```

The chat will be available at `http://localhost:8080`

> Для GIPHY поиска можно задать ключ в переменной среды `REACT_APP_GIPHY_API_KEY`. Без ключа используется общий демонстрационный ключ.

### Development

For development with hot reload:

1. **Terminal 1 - Start React dev server:**
```bash
cd frontend
npm start
```

2. **Terminal 2 - Run Go server:**
```bash
go run main.go -port 3001
```

Then navigate to `http://localhost:3000` (React dev server will proxy WebSocket to port 3001)

## Architecture

- **Backend**: Go with gorilla/websocket
  - WebSocket server for real-time messaging
  - Hub for managing clients and broadcasting messages
  - Simple HTTP server for serving frontend

- **Frontend**: React with plain CSS
  - React hooks for state management
  - WebSocket client for real-time updates
  - Retro terminal-style CSS

## Testing

Open multiple browser windows/tabs and send messages between them. Each window gets a unique random username.
