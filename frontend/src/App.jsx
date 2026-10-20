import React, { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import {
  apiUrl,
  getServer,
  isDesktop,
  normalizeServer,
  resolveUrl,
  serverWsUrl,
  setServer,
} from './server';
import { authFetch, clearToken, getToken, setToken } from './auth';

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
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
  const [server, setServerState] = useState(getServer());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [serverDraft, setServerDraft] = useState(getServer());
  const [serverError, setServerError] = useState('');
  const [showServerSetup, setShowServerSetup] = useState(false);
  const wsRef = useRef(null);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesSetRef = useRef(new Set()); // Track message IDs to avoid duplicates
  const activeChatRef = useRef(null);
  const chatsRef = useRef([]);

  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [modal, setModal] = useState(null); // 'direct' | 'group'
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [chatError, setChatError] = useState('');
  const [autostart, setAutostart] = useState(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const GIPHY_API_KEY = process.env.REACT_APP_GIPHY_API_KEY || 'dc6zaTOxFJmzC';
  const username = user ? user.username : '';
  const activeChat = chats.find((chat) => chat.id === activeChatId) || null;

  const loadChats = useCallback(async (selectId) => {
    setChatsLoading(true);
    try {
      const response = await authFetch('/api/chats');
      if (!response.ok) {
        throw new Error('Не удалось загрузить чаты');
      }
      const data = await response.json();
      const list = data.chats || [];
      setChats(list);
      setActiveChatId((current) => {
        const wanted = selectId || current;
        if (wanted && list.some((chat) => chat.id === wanted)) {
          return wanted;
        }
        const general = list.find((chat) => chat.id === 1);
        if (general) {
          return general.id;
        }
        return list.length ? list[0].id : null;
      });
    } catch (error) {
      console.error('load chats:', error);
    } finally {
      setChatsLoading(false);
    }
  }, []);

  const markRead = useCallback(async (chatId, messageId) => {
    if (!chatId || !messageId) return;
    setChats((prev) => prev.map((chat) => (chat.id === chatId ? { ...chat, unread: 0 } : chat)));
    try {
      await authFetch(`/api/chats/${chatId}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId }),
      });
    } catch (error) {
      console.error('mark read:', error);
    }
  }, []);

  const notify = useCallback(async (message) => {
    if (!user || message.userId === user.id) return;
    const title = message.username || 'GOR';
    const body = message.text || 'Новое сообщение';

    try {
      if (isDesktop()) {
        const plugin = await import('@tauri-apps/plugin-notification');
        let granted = await plugin.isPermissionGranted();
        if (!granted) {
          granted = (await plugin.requestPermission()) === 'granted';
        }
        if (granted) {
          plugin.sendNotification({ title, body });
          return;
        }
      }
      if (typeof Notification !== 'undefined') {
        if (Notification.permission === 'default') {
          await Notification.requestPermission();
        }
        if (Notification.permission === 'granted') {
          new Notification(title, { body });
        }
      }
    } catch (error) {
      console.warn('notification:', error);
    }
  }, [user]);

  // Проверяем сохранённый токен при запуске и при смене сервера.
  useEffect(() => {
    let cancelled = false;

    const checkAuth = async () => {
      setAuthChecking(true);
      if (!getToken()) {
        if (!cancelled) {
          setUser(null);
          setAuthChecking(false);
        }
        return;
      }

      try {
        const response = await authFetch('/api/auth/me');
        if (!response.ok) {
          throw new Error('unauthorized');
        }
        const data = await response.json();
        if (!cancelled) {
          setUser(data.user);
        }
      } catch (error) {
        clearToken();
        if (!cancelled) {
          setUser(null);
        }
      } finally {
        if (!cancelled) {
          setAuthChecking(false);
        }
      }
    };

    if (!isDesktop() || server) {
      checkAuth();
    } else {
      setAuthChecking(false);
    }

    return () => {
      cancelled = true;
    };
  }, [server]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    // Без входа и без адреса сервера подключаться некуда.
    if (!user || (isDesktop() && !server)) {
      return undefined;
    }

    const ws = new WebSocket(serverWsUrl(getToken()));

    ws.onopen = () => {
      console.log('Connected to WebSocket');
      setIsConnected(true);
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.chatId) {
        message.chatId = 1;
      }

      const isActive = message.chatId === activeChatRef.current;

      if (isActive) {
        const messageKey = `${message.chatId}-${message.id || message.timestamp}-${message.username}-${message.text}`;
        if (!messagesSetRef.current.has(messageKey)) {
          messagesSetRef.current.add(messageKey);
          setMessages((prev) => [...prev, message]);
        }
        if (message.userId !== user.id && message.id) {
          markRead(message.chatId, message.id);
        }
      }

      setChats((prev) => {
        const index = prev.findIndex((chat) => chat.id === message.chatId);
        if (index === -1) {
          return prev;
        }
        const current = prev[index];
        const updated = {
          ...current,
          lastText: message.text,
          lastSender: message.username,
          lastTime: message.timestamp,
          unread: isActive
            ? 0
            : (message.userId === user.id ? current.unread : (current.unread || 0) + 1),
        };
        const rest = prev.filter((_, i) => i !== index);
        return [updated, ...rest];
      });

      if (!chatsRef.current.some((chat) => chat.id === message.chatId)) {
        loadChats();
      }

      if ((!isActive || document.hidden) && message.username !== 'System') {
        notify(message);
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
  }, [user, server, markRead, notify, loadChats]);

  useEffect(() => {
    if (!user || (isDesktop() && !server)) {
      return undefined;
    }

    const fetchStats = async () => {
      try {
        const response = await authFetch('/api/stats');
        const data = await response.json();
        setOnlineCount(data.online);
      } catch (error) {
        console.error('Failed to fetch stats:', error);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 2000);
    return () => clearInterval(interval);
  }, [user, server]);

  // Список чатов при входе.
  useEffect(() => {
    if (!user) {
      setChats([]);
      setActiveChatId(null);
      return;
    }
    loadChats();
  }, [user, loadChats]);

  useEffect(() => {
    chatsRef.current = chats;
  }, [chats]);

  // Сообщения выбранного чата.
  useEffect(() => {
    activeChatRef.current = activeChatId;

    if (!user || !activeChatId) {
      setMessages([]);
      return undefined;
    }

    let cancelled = false;
    const load = async () => {
      setMessages([]);
      messagesSetRef.current = new Set();
      try {
        const response = await authFetch(`/api/chats/${activeChatId}/messages`);
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (cancelled) {
          return;
        }
        const list = data.messages || [];
        setMessages(list);
        messagesSetRef.current = new Set(list.map((m) => `${m.chatId}-${m.id}`));
        if (list.length) {
          markRead(activeChatId, list[list.length - 1].id);
        }
      } catch (error) {
        console.error('load messages:', error);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [user, activeChatId, markRead]);

  // Поиск пользователей для нового чата.
  useEffect(() => {
    if (!modal) {
      return undefined;
    }
    const query = searchQuery.trim();
    if (!query) {
      setSearchResults([]);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await authFetch(`/api/users?q=${encodeURIComponent(query)}`);
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (!cancelled) {
          setSearchResults(data.users || []);
        }
      } catch (error) {
        console.error('search users:', error);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modal, searchQuery]);

  // Разрешение на уведомления.
  useEffect(() => {
    if (!user) {
      return;
    }
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    if (isDesktop()) {
      import('@tauri-apps/plugin-notification')
        .then((plugin) => plugin.isPermissionGranted().then((granted) => {
          if (!granted) {
            plugin.requestPermission();
          }
        }))
        .catch(() => {});
    }
  }, [user]);

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
    
    if (!inputValue.trim() || !activeChatId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const message = {
      chatId: activeChatId,
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
    if (!activeChatId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    const stickerUrl = sticker.url || `/stickers/${sticker.file}`;
    const message = {
      chatId: activeChatId,
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
    formData.append('chatId', String(activeChatId));

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

      xhr.open('POST', apiUrl('/api/upload'));
      xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
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
    formData.append('chatId', String(activeChatId));

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

      xhr.open('POST', apiUrl('/api/upload'));
      xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);
      xhr.send(formData);
    } catch (error) {
      console.error('Failed to upload file:', error);
      setIsUploading(false);
    }
  };

  const applyServer = (value) => {
    const normalized = normalizeServer(value);
    if (!normalized) {
      setServerError('Укажите адрес сервера');
      return;
    }
    try {
      // проверяем, что это корректный URL
      new URL(normalized);
    } catch (e) {
      setServerError('Некорректный адрес. Пример: https://chat.example.com');
      return;
    }

    setServer(normalized);
    setServerState(normalized);
    setServerDraft(normalized);
    setServerError('');
    setSettingsOpen(false);
    setShowServerSetup(false);

    // токен и история относились к другому серверу
    clearToken();
    setUser(null);
    setAuthChecking(false);
    setIsConnected(false);
    setMessages([]);
    messagesSetRef.current.clear();
    setChats([]);
    setActiveChatId(null);
  };

  const handleAuthSubmit = async (e) => {
    e.preventDefault();
    if (authBusy) return;

    setAuthBusy(true);
    setAuthError('');

    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const response = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: authForm.username.trim(),
          password: authForm.password,
        }),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new Error(text.trim() || 'Не удалось выполнить запрос');
      }

      const data = JSON.parse(text);
      setToken(data.token);
      setUser(data.user);
      setAuthForm({ username: '', password: '' });
      setMessages([]);
      messagesSetRef.current.clear();
    } catch (error) {
      setAuthError(error.message || 'Ошибка подключения к серверу');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch (error) {
      console.error('Logout error:', error);
    }
    clearToken();
    setUser(null);
    setMessages([]);
    messagesSetRef.current.clear();
    setIsConnected(false);
    setOnlineCount(0);
    setChats([]);
    setActiveChatId(null);
    setSidebarOpen(false);
  };

  const selectChat = (chatId) => {
    setActiveChatId(chatId);
    setSidebarOpen(false);
  };

  const openModal = (mode) => {
    setModal(mode);
    setChatError('');
    setSearchQuery('');
    setSearchResults([]);
    setGroupTitle('');
    setGroupMembers([]);
  };

  const closeModal = () => {
    setModal(null);
    setChatError('');
  };

  const createDirect = async (peerName) => {
    setChatError('');
    try {
      const response = await authFetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'direct', username: peerName }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text.trim() || 'Не удалось создать чат');
      }
      const data = JSON.parse(text);
      await loadChats(data.chat.id);
      setModal(null);
    } catch (error) {
      setChatError(error.message || 'Не удалось создать чат');
    }
  };

  const toggleMember = (name) => {
    setGroupMembers((prev) => (
      prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]
    ));
  };

  const createGroup = async () => {
    setChatError('');
    if (!groupTitle.trim()) {
      setChatError('Введите название группы');
      return;
    }
    if (!groupMembers.length) {
      setChatError('Выберите хотя бы одного участника');
      return;
    }

    try {
      const response = await authFetch('/api/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group', title: groupTitle.trim(), usernames: groupMembers }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(text.trim() || 'Не удалось создать группу');
      }
      const data = JSON.parse(text);
      await loadChats(data.chat.id);
      setModal(null);
    } catch (error) {
      setChatError(error.message || 'Не удалось создать группу');
    }
  };

  const openSettings = async () => {
    setServerDraft(server);
    setServerError('');
    setSettingsOpen(true);
    if (isDesktop()) {
      try {
        const plugin = await import('@tauri-apps/plugin-autostart');
        setAutostart(await plugin.isEnabled());
      } catch (error) {
        console.warn('autostart:', error);
      }
    }
  };

  const toggleAutostart = async () => {
    try {
      const plugin = await import('@tauri-apps/plugin-autostart');
      if (autostart) {
        await plugin.disable();
        setAutostart(false);
      } else {
        await plugin.enable();
        setAutostart(true);
      }
    } catch (error) {
      console.error('autostart toggle:', error);
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

    const fileUrl = resolveUrl(msg.fileUrl);

    switch (msg.fileType) {
      case 'image':
        return (
          <div className="file-attachment image-attachment">
            <img 
              src={fileUrl} 
              alt={msg.fileName} 
              className="image-preview"
              onClick={() => openLightbox(fileUrl)}
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
              <source src={fileUrl} type={`audio/${msg.fileName.split('.').pop()}`} />
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
              <source src={fileUrl} type={`video/${msg.fileName.split('.').pop()}`} />
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
            <a href={fileUrl} download={msg.fileName} className="download-link">
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
            src={resolveUrl(msg.stickerUrl)}
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

  if (isDesktop() && (!server || showServerSetup)) {
    return (
      <div className="setup-screen">
        <form
          className="setup-card"
          onSubmit={(e) => {
            e.preventDefault();
            applyServer(serverDraft);
          }}
        >
          <h1>GOR</h1>
          <p className="setup-subtitle">Подключение к серверу</p>
          <input
            type="text"
            className="setup-input"
            value={serverDraft}
            onChange={(e) => setServerDraft(e.target.value)}
            placeholder="https://chat.example.com"
            autoFocus
          />
          {serverError && <div className="setup-error">{serverError}</div>}
          <button type="submit" className="setup-button">ПОДКЛЮЧИТЬСЯ</button>
          <p className="setup-hint">
            Например: http://192.168.0.103:8080 или https://ваш-домен
          </p>
        </form>
      </div>
    );
  }

  if (authChecking) {
    return (
      <div className="setup-screen">
        <div className="setup-card auth-checking">
          <h1>GOR</h1>
          <p className="setup-subtitle">Подключение…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="setup-screen">
        <form className="setup-card" onSubmit={handleAuthSubmit}>
          <h1>GOR</h1>
          <p className="setup-subtitle">
            {authMode === 'login' ? 'Вход в аккаунт' : 'Создание аккаунта'}
          </p>

          <input
            type="text"
            className="setup-input"
            value={authForm.username}
            onChange={(e) => setAuthForm((prev) => ({ ...prev, username: e.target.value }))}
            placeholder="Имя пользователя"
            autoComplete="username"
            autoFocus
          />
          <input
            type="password"
            className="setup-input"
            value={authForm.password}
            onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
            placeholder={authMode === 'login' ? 'Пароль' : 'Пароль (минимум 8 символов)'}
            autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
          />

          {authError && <div className="setup-error">{authError}</div>}

          <button type="submit" className="setup-button" disabled={authBusy}>
            {authBusy ? '…' : authMode === 'login' ? 'ВОЙТИ' : 'СОЗДАТЬ АККАУНТ'}
          </button>

          <button
            type="button"
            className="auth-switch"
            onClick={() => {
              setAuthMode((mode) => (mode === 'login' ? 'register' : 'login'));
              setAuthError('');
            }}
          >
            {authMode === 'login'
              ? 'Нет аккаунта? Зарегистрироваться'
              : 'Уже есть аккаунт? Войти'}
          </button>

          {isDesktop() && (
            <button
              type="button"
              className="auth-switch"
              onClick={() => setShowServerSetup(true)}
            >
              Сменить сервер: {server}
            </button>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div>
            <div className="brand">GOR<span>CHAT</span></div>
            <div className="sidebar-me">@{username}</div>
          </div>
          <span className={`indicator ${isConnected ? 'connected' : 'disconnected'}`} title={isConnected ? 'На связи' : 'Нет связи'}></span>
        </div>

        <div className="sidebar-actions">
          <button type="button" className="new-chat-button" onClick={() => openModal('direct')}>＋ ЧАТ</button>
          <button type="button" className="new-group-button" onClick={() => openModal('group')}>＋ ГРУППА</button>
        </div>

        <div className="chat-list">
          {chatsLoading && chats.length === 0 && <div className="chat-list-hint">Загрузка…</div>}
          {!chatsLoading && chats.length === 0 && <div className="chat-list-hint">Пока нет чатов</div>}
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`chat-item ${chat.id === activeChatId ? 'active' : ''}`}
              onClick={() => selectChat(chat.id)}
            >
              <div className="chat-item-top">
                <span className="chat-item-title">
                  {chat.type === 'group' ? '# ' : '@ '}{chat.title || chat.peer || 'Чат'}
                </span>
                {chat.lastTime && <span className="chat-item-time">{chat.lastTime.slice(0, 5)}</span>}
              </div>
              <div className="chat-item-bottom">
                <span className="chat-item-preview">
                  {chat.lastSender ? `${chat.lastSender}: ` : ''}{chat.lastText || 'Нет сообщений'}
                </span>
                {chat.unread > 0 && (
                  <span className="unread-badge">{chat.unread > 99 ? '99+' : chat.unread}</span>
                )}
              </div>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="online-info">
            <span className={`indicator ${isConnected ? 'connected' : 'disconnected'}`}></span>
            {isConnected ? 'ONLINE' : 'OFFLINE'} · {onlineCount}
          </span>
          {isDesktop() && (
            <button type="button" className="icon-button" title="Настройки" onClick={openSettings}>⚙</button>
          )}
          <button type="button" className="icon-button" title="Выйти из аккаунта" onClick={handleLogout}>⏻</button>
        </div>
      </aside>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <main className="chat-main">
        <header className="chat-header">
          <button type="button" className="menu-button" onClick={() => setSidebarOpen((open) => !open)} title="Чаты">
            ☰
          </button>
          <div className="chat-heading">
            <h2>
              {activeChat
                ? `${activeChat.type === 'group' ? '# ' : '@ '}${activeChat.title || activeChat.peer || 'Чат'}`
                : 'GOR CHAT'}
            </h2>
            <span className="chat-sub">
              {activeChat
                ? (activeChat.type === 'group' ? 'групповой чат' : 'личный чат')
                : 'выберите чат или создайте новый'}
            </span>
          </div>
          {isDesktop() && server && (
            <span className="server-label" title={server}>
              {server.replace(/^https?:\/\//, '')}
            </span>
          )}
        </header>

        <div
          className={`messages-container ${isDragOver ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {!activeChat && (
            <div className="welcome-message">
              &gt; Добро пожаловать в GOR CHAT<br />
              &gt; Выберите чат в списке слева<br />
              &gt; Или создайте личный диалог / группу<br />
              &gt; Файлы и сообщения сохраняются в истории
            </div>
          )}
          {activeChat && messages.length === 0 && (
            <div className="welcome-message">
              &gt; Начало диалога {activeChat.type === 'group' ? 'в группе' : 'с пользователем'} {activeChat.title || activeChat.peer}<br />
              &gt; Напишите первое сообщение
            </div>
          )}
          {messages.map((msg, idx) => (
            <div
              key={`${msg.chatId}-${msg.id}-${idx}`}
              className={`message ${msg.username === 'System' ? 'system' : 'user'} ${msg.userId && user && msg.userId === user.id ? 'own' : ''}`}
            >
              <span className="username-label">[{msg.username}]</span>
              &nbsp;
              <span className="timestamp">{msg.timestamp}</span>
              <br />
              {msg.text && <span className="message-text">&gt; {msg.text}</span>}
              {renderMessageContent(msg)}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {stickerPanelOpen && activeChat && (
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
          <div className="input-prompt">&gt; {username}:</div>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={activeChat ? '_' : 'Сначала выберите чат'}
            className="input-field"
            disabled={!isConnected || isUploading || !activeChatId}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!isConnected || isUploading || !activeChatId}
            className="file-button"
            title="Прикрепить файл"
          >
            📎 FILE
          </button>
          <button
            type="button"
            onClick={handleStickerButtonClick}
            disabled={!isConnected || isUploading || !activeChatId}
            className={`sticker-button ${stickerPanelOpen ? 'active' : ''}`}
            title="Стикеры"
          >
            🎨
          </button>
          <input
            ref={fileInputRef}
            type="file"
            onChange={handleFileSelect}
            style={{ display: 'none' }}
            disabled={isUploading || !activeChatId}
          />
          <button
            type="submit"
            disabled={!isConnected || isUploading || !activeChatId}
            className="send-button"
          >
            SEND [ENTER]
          </button>
        </form>
      </main>

      {modal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2>{modal === 'direct' ? 'Новый личный чат' : 'Новая группа'}</h2>

            {modal === 'group' && (
              <input
                type="text"
                className="setup-input"
                value={groupTitle}
                onChange={(e) => setGroupTitle(e.target.value)}
                placeholder="Название группы"
                maxLength={64}
                autoFocus
              />
            )}

            <input
              type="text"
              className="setup-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск пользователя по имени"
              autoFocus={modal === 'direct'}
            />

            {modal === 'group' && groupMembers.length > 0 && (
              <div className="selected-members">
                {groupMembers.map((name) => (
                  <button key={name} type="button" className="member-chip" onClick={() => toggleMember(name)}>
                    {name} ×
                  </button>
                ))}
              </div>
            )}

            {chatError && <div className="setup-error">{chatError}</div>}

            <div className="user-results">
              {searchResults.map((item) => {
                const selected = groupMembers.includes(item.username);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`user-result ${selected ? 'selected' : ''}`}
                    onClick={() => (modal === 'direct' ? createDirect(item.username) : toggleMember(item.username))}
                  >
                    <span className="user-avatar">{(item.username[0] || '?').toUpperCase()}</span>
                    <span className="user-name">@{item.username}</span>
                    {modal === 'group' && <span className="user-check">{selected ? '✓' : '+'}</span>}
                  </button>
                );
              })}
              {!searchQuery.trim() && <div className="muted">Введите имя пользователя</div>}
              {searchQuery.trim() && searchResults.length === 0 && <div className="muted">Никого не нашлось</div>}
            </div>

            <div className="modal-actions">
              <button type="button" className="settings-cancel" onClick={closeModal}>ОТМЕНА</button>
              {modal === 'group' && (
                <button type="button" className="settings-save" onClick={createGroup}>СОЗДАТЬ</button>
              )}
            </div>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-overlay" onClick={() => setSettingsOpen(false)}>
          <form
            className="settings-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              applyServer(serverDraft);
            }}
          >
            <h2>Настройки</h2>

            <label className="settings-label" htmlFor="server-input">Адрес сервера</label>
            <input
              id="server-input"
              type="text"
              className="setup-input"
              value={serverDraft}
              onChange={(e) => setServerDraft(e.target.value)}
              placeholder="https://chat.example.com"
            />
            {serverError && <div className="setup-error">{serverError}</div>}

            {isDesktop() && (
              <label className="settings-check">
                <input type="checkbox" checked={autostart} onChange={toggleAutostart} />
                Запускать при входе в систему
              </label>
            )}

            <div className="settings-actions">
              <button
                type="button"
                className="settings-cancel"
                onClick={() => setSettingsOpen(false)}
              >
                ОТМЕНА
              </button>
              <button type="submit" className="settings-save">СОХРАНИТЬ</button>
            </div>
          </form>
        </div>
      )}

      {lightboxImage && (
        <div className="lightbox" onClick={closeLightbox}>
          <div className="lightbox-content">
            <img src={lightboxImage} alt="Full size" />
            <button type="button" className="lightbox-close" onClick={closeLightbox}>×</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
