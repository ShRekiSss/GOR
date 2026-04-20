import React, { useState, useEffect, useRef } from 'react';
import './App.css';

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [username] = useState('User' + Math.floor(Math.random() * 10000));
  const [isConnected, setIsConnected] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [lightboxImage, setLightboxImage] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [stickerPanelOpen, setStickerPanelOpen] = useState(false);
  const [stickerPacks, setStickerPacks] = useState([]);
  const [activePack, setActivePack] = useState('');
  const [giphyQuery, setGiphyQuery] = useState('');
  const [giphyResults, setGiphyResults] = useState([]);
  const [isGiphyLoading, setIsGiphyLoading] = useState(false);
  const [giphyError, setGiphyError] = useState('');
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesSetRef = useRef(new Set()); // Track message IDs to avoid duplicates

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const GIPHY_API_KEY = process.env.REACT_APP_GIPHY_API_KEY || 'dc6zaTOxFJmzC';

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

  useEffect(() => {
    const loadStickerManifest = async () => {
      try {
        const response = await fetch('/stickers/manifest.json');
        if (!response.ok) {
          throw new Error('Failed to load sticker manifest');
        }
        const data = await response.json();
        setStickerPacks(data.packs || []);
        if (data.packs?.length) {
          setActivePack(data.packs[0].id);
        }
      } catch (error) {
        console.error('Sticker manifest load error:', error);
      }
    };

    loadStickerManifest();
  }, []);

  const activeStickerPack = stickerPacks.find((pack) => pack.id === activePack);

  const handleSendMessage = (e) => {
    e.preventDefault();
    
    if (!inputValue.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      username: username,
      text: inputValue,
      timestamp: new Date().toLocaleTimeString(),
      type: 'text',
    };

    wsRef.current.send(JSON.stringify(message));
    setInputValue('');
  };

  const handleStickerButtonClick = () => {
    setStickerPanelOpen((prev) => !prev);
  };

  const selectSticker = (sticker) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const stickerUrl = sticker.url || `/stickers/${sticker.file}`;
    const message = {
      username: username,
      text: '🎨 Sticker',
      timestamp: new Date().toLocaleTimeString(),
      type: 'sticker',
      stickerId: sticker.id,
      stickerUrl: stickerUrl,
      stickerPack: sticker.pack || activePack || 'local',
    };

    wsRef.current.send(JSON.stringify(message));
    setStickerPanelOpen(false);
    setGiphyResults([]);
    setGiphyQuery('');
  };

  const searchGiphy = async () => {
    if (!giphyQuery.trim()) {
      return;
    }

    setIsGiphyLoading(true);
    setGiphyError('');
    setGiphyResults([]);

    try {
      const response = await fetch(
        `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(
          giphyQuery,
        )}&limit=12&rating=pg-13`,
      );

      if (!response.ok) {
        throw new Error('GIPHY search failed');
      }

      const data = await response.json();
      setGiphyResults(
        (data.data || []).map((item) => ({
          id: item.id,
          url: item.images.fixed_width_downsampled.url,
          title: item.title,
        })),
      );
    } catch (error) {
      console.error('GIPHY error:', error);
      setGiphyError('Не удалось загрузить GIF. Попробуйте позже.');
    } finally {
      setIsGiphyLoading(false);
    }
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

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  const handleFileUpload = async (file) => {
    if (!file) return;

    // Check file size (50MB limit)
    if (file.size > 50 * 1024 * 1024) {
      alert('File too large! Maximum size is 50MB.');
      return;
    }

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
  };

  const openLightbox = (fileUrl) => {
    setLightboxImage(fileUrl);
  };

  const closeLightbox = () => {
    setLightboxImage(null);
  };

  const renderFileAttachment = (msg) => {
    if (!msg.fileUrl) return null;

    switch (msg.fileType) {
      case 'image':
        return (
          <div className="file-attachment image-attachment">
            <img 
              src={msg.fileUrl} 
              alt={msg.fileName} 
              className="image-preview"
              onClick={() => openLightbox(msg.fileUrl)}
              style={{ cursor: 'pointer' }}
            />
            <div className="file-info">
              <span className="file-name">{msg.fileName}</span>
              <span className="file-size">{formatFileSize(msg.fileSize)}</span>
            </div>
          </div>
        );
      
      case 'audio':
        return (
          <div className="file-attachment audio-attachment">
            <audio controls className="audio-player">
              <source src={msg.fileUrl} type={`audio/${msg.fileName.split('.').pop()}`} />
              Your browser does not support the audio element.
            </audio>
            <div className="file-info">
              <span className="file-name">{msg.fileName}</span>
              <span className="file-size">{formatFileSize(msg.fileSize)}</span>
            </div>
          </div>
        );
      
      case 'video':
        return (
          <div className="file-attachment video-attachment">
            <video controls className="video-player" style={{ maxWidth: '300px', maxHeight: '200px' }}>
              <source src={msg.fileUrl} type={`video/${msg.fileName.split('.').pop()}`} />
              Your browser does not support the video element.
            </video>
            <div className="file-info">
              <span className="file-name">{msg.fileName}</span>
              <span className="file-size">{formatFileSize(msg.fileSize)}</span>
            </div>
          </div>
        );
      
      default:
        return (
          <div className="file-attachment document-attachment">
            <div className="file-info">
              📄 {msg.fileName}
            </div>
            <div className="file-size">
              {formatFileSize(msg.fileSize)}
            </div>
            <a href={msg.fileUrl} download={msg.fileName} className="download-link">
              ⬇ DOWNLOAD
            </a>
          </div>
        );
    }
  };

  const renderMessageContent = (msg) => {
    if (msg.type === 'sticker' && msg.stickerUrl) {
      return (
        <div className="sticker-message">
          <img
            src={msg.stickerUrl}
            alt={msg.stickerId || 'Sticker'}
            className="sticker-preview"
          />
          <div className="file-info">
            <span className="file-name">Sticker</span>
            <span className="file-size">{msg.stickerPack || 'GIPHY'}</span>
          </div>
        </div>
      );
    }

    if (msg.fileUrl) {
      return renderFileAttachment(msg);
    }

    return null;
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

      <div 
        className={`messages-container ${isDragOver ? 'drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
            {msg.text && <span className="message-text">> {msg.text}</span>}
            {renderMessageContent(msg)}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {stickerPanelOpen && (
        <div className="sticker-panel">
          <div className="sticker-panel-header">
            <div className="sticker-tabs">
              {stickerPacks.map((pack) => (
                <button
                  key={pack.id}
                  type="button"
                  className={`sticker-tab ${pack.id === activePack ? 'active' : ''}`}
                  onClick={() => setActivePack(pack.id)}
                >
                  {pack.name}
                </button>
              ))}
            </div>
            <div className="giphy-search">
              <input
                type="text"
                value={giphyQuery}
                onChange={(e) => setGiphyQuery(e.target.value)}
                placeholder="Search GIPHY..."
                className="giphy-input"
              />
              <button type="button" onClick={searchGiphy} className="giphy-search-btn">
                🔍
              </button>
            </div>
          </div>

          {giphyError && <div className="giphy-error">{giphyError}</div>}
          {isGiphyLoading && <div className="giphy-loading">Loading GIFs...</div>}

          <div className="sticker-grid">
            {activeStickerPack?.stickers?.map((sticker) => (
              <button
                key={sticker.id}
                type="button"
                className="sticker-card"
                onClick={() => selectSticker({ ...sticker, pack: activeStickerPack.id })}
              >
                <img src={`/stickers/${sticker.file}`} alt={sticker.name} />
              </button>
            ))}
          </div>

          {giphyResults.length > 0 && (
            <div className="giphy-grid">
              {giphyResults.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  className="sticker-card"
                  onClick={() => selectSticker({ id: gif.id, url: gif.url, pack: 'giphy' })}
                >
                  <img src={gif.url} alt={gif.title} />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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
        <button
          type="button"
          onClick={handleStickerButtonClick}
          disabled={!isConnected || isUploading}
          className={`sticker-button ${stickerPanelOpen ? 'active' : ''}`}
          title="Stickers"
        >
          🎨
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

      {lightboxImage && (
        <div className="lightbox" onClick={closeLightbox}>
          <div className="lightbox-content">
            <img src={lightboxImage} alt="Full size" />
            <button className="lightbox-close" onClick={closeLightbox}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
