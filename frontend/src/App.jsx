import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [username, setUsername] = useState('User' + Math.floor(Math.random() * 10000));
  const [isConnected, setIsConnected] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesSetRef = useRef(new Set()); // Track message IDs to avoid duplicates

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?username=${encodeURIComponent(username)}`;
    
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to WebSocket');
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      // Avoid duplicate messages
      const messageKey = `${message.id || message.timestamp}-${message.username}`;
      if (!messagesSetRef.current.has(messageKey)) {
        messagesSetRef.current.add(messageKey);
        setMessages((prev) => [...prev, message]);
      }
    };

    ws.onclose = () => {
      console.log('Disconnected from WebSocket');
      setIsConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    wsRef.current = ws;

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [username]);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await fetch('/api/stats');
        const data = await response.json();
        setOnlineCount(data.online);
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    };

    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSendMessage = (e) => {
    e.preventDefault();
    
    if (!inputValue.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      username: username,
      text: inputValue,
      timestamp: new Date().toLocaleTimeString(),
    };

    wsRef.current.send(JSON.stringify(message));
    setInputValue('');
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('username', username);

    try {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100);
          setUploadProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
          console.log('File uploaded successfully');
          setUploadProgress(0);
          setIsUploading(false);
        } else {
          console.error('Upload failed');
          setIsUploading(false);
        }
      });

      xhr.addEventListener('error', () => {
        console.error('Upload error');
        setIsUploading(false);
      });

      xhr.open('POST', '/api/upload');
      xhr.send(formData);
    } catch (error) {
      console.error('Failed to upload file:', error);
      setIsUploading(false);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  };

  return (
    <div className="app">
      <div className="header">
        <h1>GOR CHAT</h1>
        <div className="status">
          <span className={`indicator ${isConnected ? 'connected' : 'disconnected'}`}></span>
          <span className="status-text">
            {isConnected ? 'ONLINE' : 'OFFLINE'} | 
            <span className="username"> {username} </span>
            | <span className="online-count">{onlineCount} ONLINE</span>
          </span>
        </div>
      </div>

      <div className="messages-container">
        {messages.length === 0 && (
          <div className="welcome-message">
            > WELCOME TO GOR CHAT<br />
            > Type your message to start chatting<br />
            > Use FILE button to share files<br />
            > Messages and files are saved and loaded from history<br />
            > Open multiple windows to test messaging
          </div>
        )}
        {messages.map((msg, idx) => (
          <div key={`${msg.id}-${idx}`} className={`message ${msg.username === 'System' ? 'system' : 'user'}`}>
            <span className="username-label">[{msg.username}]</span>
            &nbsp;
            <span className="timestamp">{msg.timestamp}</span>
            <br />
            <span className="message-text">> {msg.text}</span>
            {msg.fileUrl && (
              <div className="file-attachment">
                <div className="file-info">
                  📎 {msg.fileName}
                </div>
                <div className="file-size">
                  {msg.fileSize ? formatFileSize(msg.fileSize) : 'Unknown size'}
                </div>
                <a href={msg.fileUrl} download={msg.fileName} className="download-link">
                  ⬇ DOWNLOAD
                </a>
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {isUploading && (
        <div className="upload-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${uploadProgress}%` }}></div>
          </div>
          <div className="progress-text">{uploadProgress}%</div>
        </div>
      )}

      <form className="input-form" onSubmit={handleSendMessage}>
        <div className="input-prompt">
          > {username}:
        </div>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="_"
          className="input-field"
          disabled={!isConnected || isUploading}
        />
        <button 
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!isConnected || isUploading}
          className="file-button"
          title="Attach file"
        >
          📎 FILE
        </button>
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          disabled={isUploading}
        />
        <button type="submit" disabled={!isConnected || isUploading} className="send-button">
          SEND [ENTER]
        </button>
      </form>
    </div>
  );
}

export default App;
