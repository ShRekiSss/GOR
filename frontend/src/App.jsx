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

// Порог мобильной (Android/PWA) раскладки — совпадает с CSS @media.
const MOBILE_MQ = '(max-width: 820px)';

// --- Время сообщений ---
// Новый формат — ISO UTC от сервера ("2026-10-22T09:41:00Z"):
// сегодня → «12:41», вчера → «вчера 12:41», иначе «22.10, 12:41» — в локальном времени.
// Старые записи (только «12:41:02») показываем как есть.
function parseTs(ts) {
  if (!ts || typeof ts !== 'string') return null;
  if (ts.indexOf('T') === -1 && ts.indexOf('Z') === -1) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function localTime(ts) {
  const date = parseTs(ts);
  if (!date) return ts || '';
  const hm = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return hm;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `вчера ${hm}`;
  return `${date.toLocaleDateString([], { day: '2-digit', month: '2-digit' })}, ${hm}`;
}

function dayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(date) {
  const now = new Date();
  if (dayKey(date) === dayKey(now)) return 'Сегодня';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return 'Вчера';
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function App() {
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [user, setUser] = useState(null);
  // ТГ-стиль: ответ на сообщение, редактирование, меню по долгому тапу, «печатает…».
  const [replyTo, setReplyTo] = useState(null);
  const [editingMsg, setEditingMsg] = useState(null);
  const [msgMenu, setMsgMenu] = useState(null);
  const [typingUser, setTypingUser] = useState('');
  // Реакции: { [msgId]: [{emoji, count, usernames}] }.
  const [reactions, setReactions] = useState({});
  // До какого id чужие участники дочитали чат: { [chatId]: maxId } — для ✓✓.
  const [readMarks, setReadMarks] = useState({});
  // Аватарки профиля по username (из чат-листа, /api/users, /api/auth/me).
  const [avatars, setAvatars] = useState({});
  const typingSentRef = useRef(0);   // троттлинг outgoing typing
  const typingClearRef = useRef(null); // таймер скрытия индикатора
  const [authChecking, setAuthChecking] = useState(true);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ username: '', password: '', pass2: '' });
  const [authShowPass, setAuthShowPass] = useState(false);
  const [authCaps, setAuthCaps] = useState(false);
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
  const avatarInputRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const messagesSetRef = useRef(new Set()); // Track message IDs to avoid duplicates
  const activeChatRef = useRef(null);
  const chatsRef = useRef([]);

  // Пагинация «вглубь истории» и догон после реконнекта (Android рвёт WS в фоне).
  const oldestIdRef = useRef(0); // id первого (самого старого) загруженного сообщения
  const lastIdRef = useRef(0); // id последнего загруженного сообщения чата
  const loadingOlderRef = useRef(false);
  const canLoadOlderRef = useRef(false);
  const skipScrollRef = useRef(false);
  const viewportRef = useRef(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [canLoadOlder, setCanLoadOlder] = useState(false);
  const setCanLoadOlderBoth = (value) => {
    canLoadOlderRef.current = value;
    setCanLoadOlder(value);
  };

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

  // --- Мобильный режим (Android/PWA): жесты в стиле Signal-Android ---
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(MOBILE_MQ).matches);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileSwipe, setMobileSwipe] = useState(0);
  const [mobileSwiping, setMobileSwiping] = useState(false);
  const [pullPx, setPullPx] = useState(0);
  const [pulling, setPulling] = useState(false);
  const [contextChat, setContextChat] = useState(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [toast, setToast] = useState('');
  const isMobileRef = useRef(isMobile);
  const layersRef = useRef([]); // стек «слоёв» для системной кнопки «назад»
  const gestureRef = useRef(null);
  const pullRef = useRef(null);
  const pullPxRef = useRef(0);
  const listScrollRef = useRef(null);
  const pressTimerRef = useRef(null);
  const longPressRef = useRef(false);
  const toastTimerRef = useRef(null);

  const username = user ? user.username : '';
  const activeChat = chats.find((chat) => chat.id === activeChatId) || null;

  // Реакции: влить данные истории (агрегаты) в состояние.
  const mergeReactions = (map) => {
    if (!map) return;
    setReactions((prev) => ({ ...prev, ...map }));
  };

  // Применить событие реакции (из WS или оптимистично для себя).
  const applyReaction = (ev) => {
    const key = String(ev.messageId);
    setReactions((prev) => {
      const next = { ...prev };
      const list = [...(next[key] || [])];
      const agg = list.find((x) => x.emoji === ev.emoji);
      if (ev.remove) {
        if (!agg) return next;
        const usernames = agg.usernames.filter((n) => n !== ev.username);
        const count = usernames.length;
        if (count <= 0) {
          next[key] = list.filter((x) => x.emoji !== ev.emoji);
        } else {
          next[key] = list.map((x) => (x.emoji === ev.emoji ? { ...agg, count, usernames } : x));
        }
      } else {
        if (!agg) {
          next[key] = [...list, { emoji: ev.emoji, count: 1, usernames: [ev.username] }];
        } else if (!agg.usernames.includes(ev.username)) {
          next[key] = list.map((x) => (x.emoji === ev.emoji
            ? { ...agg, count: agg.count + 1, usernames: [...agg.usernames, ev.username] }
            : x));
        }
      }
      return next;
    });
  };

  // Запомнить аватарку юзера (data URL) для пузырей и списков.
  const rememberAvatar = (name, avatar) => {
    if (!name || !avatar) {
      return;
    }
    setAvatars((prev) => (prev[name] === avatar ? prev : { ...prev, [name]: avatar }));
  };

  const sendReaction = (msg, emoji) => {
    const agg = (reactions[String(msg.id)] || []).find((x) => x.emoji === emoji);
    const mine = agg?.usernames.includes(username);
    wsRef.current?.send(JSON.stringify({ type: 'react', messageId: msg.id, emoji, remove: !!mine }));
    applyReaction({ messageId: msg.id, emoji, remove: !!mine, username, userId: user?.id });
  };

  // Догон пропущенных сообщений активного чата после реконнекта WS.
  const catchUpRef = useRef(null);
  catchUpRef.current = async (chatId) => {
    if (!chatId) return;
    try {
      const response = await authFetch(`/api/chats/${chatId}/messages?after=${lastIdRef.current}`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.reactions) mergeReactions(data.reactions);
      const fresh = data.messages || [];
      if (!fresh.length) return;
      const freshKeys = fresh.filter((m) => m.id && !messagesSetRef.current.has(`${m.chatId}-${m.id}`));
      freshKeys.forEach((m) => messagesSetRef.current.add(`${m.chatId}-${m.id}`));
      if (freshKeys.length) {
        skipScrollRef.current = true;
        setMessages((prev) => [...prev, ...freshKeys]);
      }
      const last = fresh[fresh.length - 1];
      if (last?.id) {
        lastIdRef.current = Math.max(lastIdRef.current, last.id);
        if (activeChatRef.current === chatId) {
          markRead(chatId, last.id);
        }
      }
    } catch (error) {
      console.error('catch up messages:', error);
    }
  };

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
      const known = {};
      for (const c of list) {
        if (c.type === 'direct' && c.avatar && c.peer) {
          known[c.peer] = c.avatar;
        }
      }
      if (Object.keys(known).length) setAvatars((prev) => ({ ...prev, ...known }));
      setActiveChatId((current) => {
        const wanted = selectId || current;
        if (wanted && list.some((chat) => chat.id === wanted)) {
          return wanted;
        }
        // На мобильном список чатов — первый экран: ничего не открываем автоматически.
        if (isMobileRef.current) {
          return null;
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
    const title = message.username || 'VAKSA';
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
          if (data.user?.avatar) {
            setAvatars((prev) => ({ ...prev, [data.user.username]: data.user.avatar }));
          }
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
    // После вставки «старых» сообщений в начало не прыгаем вниз —
    // возвращаем пользователю тот же кусок истории, что он смотрел.
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      const container = messagesContainerRef.current;
      if (container && viewportRef.current != null) {
        container.scrollTop = container.scrollHeight - viewportRef.current;
        viewportRef.current = null;
        return;
      }
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Сообщения с разделителями дней (Сегодня / Вчера / дата), как в мессенджерах.
  const renderedMessages = [];
  if (messages.length) {
    let lastDay = null;
    let fallbackKey = 0;
    messages.forEach((msg) => {
      const date = parseTs(msg.timestamp);
      if (date) {
        const key = dayKey(date);
        if (key !== lastDay) {
          lastDay = key;
          renderedMessages.push({
            divider: true,
            label: dayLabel(date),
            key: `day-${msg.chatId || activeChatId || 1}-${msg.id || (msg.timestamp || '')}`,
          });
        }
      } else if (lastDay !== null) {
        lastDay = null; // после современных сообщений старые (время без даты) отдельно
      }
      fallbackKey += 1;
      renderedMessages.push({ divider: false, msg, key: fallbackKey });
    });
  }

  useEffect(() => {
    // Без входа и без адреса сервера подключаться некуда.
    if (!user || (isDesktop() && !server)) {
      return undefined;
    }

    let closed = false;
    let retry = 0;
    let reconnectTimer = null;
    let connectedOnce = false;

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(serverWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        // Авторизация первым кадром — токен не светится в URL/логах прокси.
        ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
      };

      ws.onmessage = (event) => {
        const incoming = JSON.parse(event.data);

        if (incoming.type === 'auth_ok') {
          console.log('WS авторизован');
          setIsConnected(true);
          if (connectedOnce) {
            // Реконнект (Android рвёт сокет при уходе приложения в фон):
            // дотягиваем пропущенные сообщения и обновляем список чатов.
            retry = 0;
            loadChats();
            catchUpRef.current?.(activeChatRef.current);
          }
          connectedOnce = true;
          return;
        }
        if (incoming.type === 'auth_error') {
          console.warn('WS: токен отклонён');
          setIsConnected(false);
          return;
        }
        if (incoming.type === 'presence') {
          // Вход/выход пользователей — событие, не сообщение в чат.
          if (typeof incoming.online === 'number') {
            setOnlineCount(incoming.online);
          }
          return;
        }

        if (incoming.type === 'reaction') {
          applyReaction(incoming);
          return;
        }
        if (incoming.type === 'read') {
          // Чужой дочитал до messageId → мои сообщения в чате выше этого id = ✓✓.
          if (incoming.userId !== user.id) {
            setReadMarks((prev) => ({
              ...prev,
              [incoming.chatId]: Math.max(prev[incoming.chatId] || 0, incoming.messageId || 0),
            }));
          }
          return;
        }
        if (incoming.type === 'typing') {
          // «X печатает…» — только для открытого чата и не от себя.
          if (incoming.chatId === activeChatRef.current && incoming.userId !== user.id) {
            setTypingUser(incoming.username || 'Кто-то');
            clearTimeout(typingClearRef.current);
            typingClearRef.current = setTimeout(() => setTypingUser(''), 3500);
          }
          return;
        }
        if (incoming.type === 'edit') {
          setMessages((prev) => prev.map((m) => (m.id === incoming.id ? { ...m, text: incoming.text, edited: 1 } : m)));
          return;
        }
        if (incoming.type === 'delete') {
          setMessages((prev) => prev.map((m) => (m.id === incoming.id
            ? { ...m, text: incoming.text || 'Сообщение удалено', type: 'deleted', edited: 0, replyTo: 0 }
            : m)));
          return;
        }

        const message = incoming;
        if (!message.chatId) {
          message.chatId = 1;
        }

        const isActive = message.chatId === activeChatRef.current;

        if (isActive) {
          const messageKey = message.id
            ? `${message.chatId}-${message.id}`
            : `${message.chatId}-${message.timestamp}-${message.username}-${message.text}`;
          if (!messagesSetRef.current.has(messageKey)) {
            messagesSetRef.current.add(messageKey);
            setMessages((prev) => [...prev, message]);
            if (message.id) {
              lastIdRef.current = Math.max(lastIdRef.current, message.id);
            }
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
            lastTime: message.timestamp || current.lastTime,
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

        if (!isActive || document.hidden) {
          notify(message);
        }
      };

      ws.onclose = () => {
        console.log('Disconnected from WebSocket');
        setIsConnected(false);
        if (closed) return;
        // Реконнект с нарастающей паузой: 0.5 c, 1 c, 2 c, 4 c … максимум 10 c.
        const delay = Math.min(10000, 500 * (2 ** retry));
        retry = Math.min(retry + 1, 5);
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
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
    const interval = setInterval(fetchStats, 10000); // онлайны приходят и через WS presence
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
      skipScrollRef.current = false;
      viewportRef.current = null;
      try {
        const response = await authFetch(`/api/chats/${activeChatId}/messages`);
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (cancelled) {
          return;
        }
        if (data.reactions) mergeReactions(data.reactions);
        if (typeof data.foreignRead === 'number') {
          setReadMarks((prev) => ({
            ...prev,
            [activeChatId]: Math.max(prev[activeChatId] || 0, data.foreignRead),
          }));
        }
        const list = data.messages || [];
        setMessages(list);
        messagesSetRef.current = new Set(list.filter((m) => m.id).map((m) => `${m.chatId}-${m.id}`));
        oldestIdRef.current = list.length ? list[0].id : 0;
        lastIdRef.current = list.length ? list[list.length - 1].id : 0;
        setCanLoadOlderBoth(typeof data.hasMore === 'boolean' ? data.hasMore : list.length >= 100);
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

  // Дозагрузка «старой» истории: тянем страницу сообщений перед самым старым
  // загруженным и сохраняем положение экрана при прокрутке (Android/PWA-жест).
  const loadOlder = async () => {
    const chatId = activeChatRef.current;
    const container = messagesContainerRef.current;
    if (!chatId || !container) return;
    if (loadingOlderRef.current || !canLoadOlderRef.current || !oldestIdRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const response = await authFetch(`/api/chats/${chatId}/messages?before=${oldestIdRef.current}&limit=100`);
      if (!response.ok) return;
      const data = await response.json();
      if (data.reactions) mergeReactions(data.reactions);
      const older = data.messages || [];
      if (!older.length) {
        setCanLoadOlderBoth(false);
        return;
      }
      older.forEach((m) => {
        if (m.id) messagesSetRef.current.add(`${m.chatId}-${m.id}`);
      });
      // запоминаем, что сейчас видно, чтобы после вставки оставаться на месте
      skipScrollRef.current = true;
      viewportRef.current = container.scrollHeight - container.scrollTop;
      oldestIdRef.current = older[0].id;
      setCanLoadOlderBoth(typeof data.hasMore === 'boolean' ? data.hasMore : older.length >= 100);
      setMessages((prev) => [...older, ...prev]);
    } catch (error) {
      console.error('load older:', error);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  const onMessagesScroll = () => {
    const container = messagesContainerRef.current;
    if (container && container.scrollTop < 60) {
      loadOlder();
    }
  };

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

  // Синхронизация мобильного режима.
  useEffect(() => {
    isMobileRef.current = isMobile;
  }, [isMobile]);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const handler = (event) => setIsMobile(event.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  // Системная кнопка «назад» (Android): закрывает верхний слой
  // (открытый чат → модалка → нижний лист), как в Signal.
  useEffect(() => {
    if (!isMobile) {
      return undefined;
    }
    const onPop = () => {
      const layer = layersRef.current.pop();
      if (layer === 'chat') {
        setMobileChatOpen(false);
      } else if (layer === 'modal') {
        setModal(null);
        setChatError('');
      } else if (layer === 'compose') {
        setComposeOpen(false);
      } else if (layer === 'settings') {
        setSettingsOpen(false);
      } else if (layer === 'context') {
        setContextChat(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [isMobile]);

  const activeStickerPack = stickerPacks.find((pack) => pack.id === activePack);

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
    // «Печатает…» — не чаще раза в 2.5 секунды.
    const now = Date.now();
    if (
      activeChatId
      && wsRef.current?.readyState === WebSocket.OPEN
      && now - typingSentRef.current > 2500
    ) {
      typingSentRef.current = now;
      wsRef.current.send(JSON.stringify({ type: 'typing', chatId: activeChatId }));
    }
  };

  const handleSendMessage = (e) => {
    e.preventDefault();

    if (!inputValue.trim() || !activeChatId || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    // Режим правки: не создаём новое сообщение, а обновляем своё.
    if (editingMsg) {
      wsRef.current.send(JSON.stringify({ type: 'edit', messageId: editingMsg.id, text: inputValue }));
      setEditingMsg(null);
      setInputValue('');
      return;
    }

    const message = {
      chatId: activeChatId,
      username: username,
      text: inputValue,
      type: 'text',
    };
    if (replyTo?.id) {
      message.replyTo = replyTo.id;
    }

    wsRef.current.send(JSON.stringify(message));
    setInputValue('');
    setReplyTo(null);
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
      // Поиск через свой сервер: ключ GIPHY живёт в GOR_GIPHY_KEY на сервере.
      const response = await authFetch(`/api/giphy?q=${encodeURIComponent(giphyQuery)}`);

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'GIPHY search failed');
      }

      setGiphyResults(data.data || []);
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
    if (isMobileRef.current && layersRef.current[layersRef.current.length - 1] === 'settings') {
      window.history.back();
    } else {
      setSettingsOpen(false);
    }
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

    // Валидация на клиенте — те же правила, что приняты сервером.
    const username = authForm.username.trim();
    const regex = /^[a-zA-Z0-9_.-]{3,32}$/;
    if (!regex.test(username)) {
      setAuthError('Имя: 3-32 символа, латиница, цифры, _ . -');
      return;
    }
    if (authMode === 'register') {
      if (authForm.password.length < 8) {
        setAuthError('Пароль должен быть не короче 8 символов');
        return;
      }
      if (authForm.password !== authForm.pass2) {
        setAuthError('Пароли не совпадают');
        return;
      }
    }

    setAuthBusy(true);
    setAuthError('');

    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const response = await fetch(apiUrl(endpoint), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
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
      setAuthForm({ username: '', password: '', pass2: '' });
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
    setMobileChatOpen(false);
    setContextChat(null);
    setComposeOpen(false);
    layersRef.current = [];
  };

  const selectChat = (chatId) => {
    setActiveChatId(chatId);
    setSidebarOpen(false);
    if (isMobileRef.current) {
      // Мобильный UX: чат открывается отдельным экраном поверх списка.
      setContextChat(null);
      setComposeOpen(false);
      setModal(null);
      setChatError('');
      if (layersRef.current.length) {
        layersRef.current[layersRef.current.length - 1] = 'chat';
        window.history.replaceState({ gorLayer: 'chat' }, '');
      } else {
        pushLayer('chat');
      }
      setMobileChatOpen(true);
    }
  };

  const closeChatMobile = () => {
    if (layersRef.current[layersRef.current.length - 1] === 'chat') {
      window.history.back();
      return;
    }
    setMobileChatOpen(false);
  };

  const openModal = (mode) => {
    setModal(mode);
    setChatError('');
    setSearchQuery('');
    setSearchResults([]);
    setGroupTitle('');
    setGroupMembers([]);
    if (isMobileRef.current) {
      const top = layersRef.current[layersRef.current.length - 1];
      if (top === 'compose' || top === 'context') {
        // Один слой истории заменяем другим, чтобы «назад» не зависал.
        layersRef.current[layersRef.current.length - 1] = 'modal';
        window.history.replaceState({ gorLayer: 'modal' }, '');
      } else {
        pushLayer('modal');
      }
    }
  };

  const closeModal = () => {
    if (isMobileRef.current && layersRef.current[layersRef.current.length - 1] === 'modal') {
      window.history.back();
      return;
    }
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
      closeModal();
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
      closeModal();
    } catch (error) {
      setChatError(error.message || 'Не удалось создать группу');
    }
  };

  const openSettings = async () => {
    setServerDraft(server);
    setServerError('');
    setSettingsOpen(true);
    if (isMobileRef.current) {
      pushLayer('settings');
    }
    if (isDesktop()) {
      try {
        const plugin = await import('@tauri-apps/plugin-autostart');
        setAutostart(await plugin.isEnabled());
      } catch (error) {
        console.warn('autostart:', error);
      }
    }
  };

  // Смена аватара: файл → canvas 128×128 → data URL → POST /api/me/avatar.
  const handleAvatarFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      showToast('Это не картинка');
      return;
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('read error'));
        reader.readAsDataURL(file);
      });
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
      const side = Math.min(img.width, img.height);
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
      const cropped = canvas.toDataURL('image/jpeg', 0.85);
      const response = await authFetch('/api/me/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: cropped }),
      });
      if (!response.ok) {
        throw new Error((await response.text()).trim() || 'не удалось загрузить');
      }
      const data = await response.json();
      if (data.user) {
        setUser(data.user);
        rememberAvatar(data.user.username, data.user.avatar);
      }
      showToast('Аватар обновлён');
    } catch (error) {
      showToast(`Не удалось сменить аватар: ${error.message}`);
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

  // --- Мобильные жесты и слои интерфейса ---
  const pushLayer = (key) => {
    layersRef.current.push(key);
    window.history.pushState({ gorLayer: key }, '');
  };

  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 1800);
  };

  const openCompose = () => {
    setComposeOpen(true);
    if (isMobileRef.current) {
      pushLayer('compose');
    }
  };

  const closeCompose = () => {
    if (isMobileRef.current && layersRef.current[layersRef.current.length - 1] === 'compose') {
      window.history.back();
      return;
    }
    setComposeOpen(false);
  };

  // Выбор из FAB-листа: слой «выбора» превращается в слой модалки (openModal сам заменит).
  const composePick = (mode) => {
    setComposeOpen(false);
    openModal(mode);
  };

  const closeContext = () => {
    if (layersRef.current[layersRef.current.length - 1] === 'context') {
      window.history.back();
      return;
    }
    setContextChat(null);
  };

  // Открытие чата из листа по долгому нажатию: слой листа → слой чата.
  const openContextChat = () => {
    const chat = contextChat;
    setContextChat(null);
    if (!chat) {
      return;
    }
    setActiveChatId(chat.id);
    setMobileChatOpen(true);
    if (layersRef.current.length) {
      layersRef.current[layersRef.current.length - 1] = 'chat';
      window.history.replaceState({ gorLayer: 'chat' }, '');
    } else {
      pushLayer('chat');
    }
  };

  // Свайп вправо от левого края = «назад» к списку чатов.
  const onChatTouchStart = (event) => {
    if (!isMobileRef.current || !mobileChatOpen) {
      return;
    }
    const touch = event.touches[0];
    if (touch.clientX > 60) {
      return;
    }
    gestureRef.current = { x0: touch.clientX, y0: touch.clientY, dx: 0, dy: 0, prevDx: 0, velocity: 0, dragging: false };
  };

  const onChatTouchMove = (event) => {
    const gesture = gestureRef.current;
    if (!gesture) {
      return;
    }
    const touch = event.touches[0];
    gesture.dx = touch.clientX - gesture.x0;
    gesture.dy = touch.clientY - gesture.y0;
    if (!gesture.dragging && gesture.dx > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy)) {
      gesture.dragging = true;
      setMobileSwiping(true);
    }
    if (gesture.dragging) {
      // «скорость» свайпа по последнему шагу — для быстрого флика
      gesture.velocity = gesture.dx - (gesture.prevDx || 0);
      gesture.prevDx = gesture.dx;
      setMobileSwipe(Math.max(0, Math.min(gesture.dx, window.innerWidth * 0.8)));
    }
  };

  const onChatTouchEnd = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture || !gesture.dragging) {
      return;
    }
    const width = window.innerWidth || 1;
    // довели до трети экрана или быстрый флик — закрываем чат
    const shouldClose = gesture.dx > width * 0.3 || (gesture.dx > 60 && gesture.velocity > 14);
    if (!shouldClose) {
      // возврат пружиной обратно
      setMobileSwiping(false);
      setMobileSwipe(0);
      return;
    }
    // Плавно «дозакрываем» экран анимацией и синхронизируем историю.
    setMobileSwiping(false);
    setMobileSwipe(0);
    setMobileChatOpen(false);
    window.history.back();
  };

  // Pull-to-refresh в списке чатов (как в Signal: тянешь вниз — список обновляется).
  const onListTouchStart = (event) => {
    if (!isMobileRef.current) {
      return;
    }
    const list = listScrollRef.current;
    if (!list || list.scrollTop > 0) {
      return;
    }
    const touch = event.touches[0];
    pullRef.current = { y0: touch.clientY, dy: 0 };
  };

  const onListTouchMove = (event) => {
    const drag = pullRef.current;
    if (!drag) {
      return;
    }
    const touch = event.touches[0];
    drag.dy = touch.clientY - drag.y0;
    if (drag.dy > 0) {
      pullPxRef.current = Math.min(90, drag.dy * 0.45);
      setPullPx(pullPxRef.current);
    }
  };

  const onListTouchEnd = () => {
    const drag = pullRef.current;
    pullRef.current = null;
    if (!drag || drag.dy <= 0) {
      return;
    }
    if (pullPxRef.current > 55) {
      pullPxRef.current = 0;
      setPullPx(64);
      setPulling(true);
      loadChats().finally(() => {
        setPulling(false);
        setPullPx(0);
      });
    } else {
      pullPxRef.current = 0;
      setPullPx(0);
    }
  };

  // Долгое нажатие на чат → нижний лист (Signal-style).
  const startLongPress = (chat) => () => {
    longPressRef.current = false;
    clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      longPressRef.current = true;
      setContextChat(chat);
      if (isMobileRef.current) {
        pushLayer('context');
      }
    }, 420);
  };

  const cancelLongPress = () => {
    clearTimeout(pressTimerRef.current);
  };

  const onChatItemClick = (chat) => () => {
    if (longPressRef.current) {
      longPressRef.current = false;
      return;
    }
    selectChat(chat.id);
  };

  // Долгое нажатие на сообщение → меню: ответить / править / удалить / копировать.
  const startMsgPress = (msg) => () => {
    longPressRef.current = false;
    clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      longPressRef.current = true;
      setMsgMenu(msg);
    }, 420);
  };

  const onMsgContext = (msg) => (event) => {
    event.preventDefault();
    setMsgMenu(msg);
  };

  const closeSettings = () => {
    if (isMobileRef.current && layersRef.current[layersRef.current.length - 1] === 'settings') {
      window.history.back();
      return;
    }
    setSettingsOpen(false);
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
          <h1>VAKSA</h1>
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
          <h1>VAKSA</h1>
          <p className="setup-subtitle">Подключение…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    const username = authForm.username.trim();
    const usernameOk = /^[a-zA-Z0-9_.-]{3,32}$/.test(username);
    const passOk = authForm.password.length >= 8;
    const pass2Ok = authMode === 'login' || authForm.pass2 === authForm.password;
    const canSubmit = usernameOk && passOk && pass2Ok && !authBusy;

    // Силу пароля считаем честно: длина + классы символов.
    let strength = 0;
    if (authForm.password.length >= 8) strength += 34;
    if (authForm.password.length >= 12) strength += 22;
    if (/[0-9]/.test(authForm.password)) strength += 14;
    if (/[a-zа-я]/.test(authForm.password) && /[A-ZА-Я]/.test(authForm.password)) strength += 16;
    if (/[^a-zA-Z0-9а-яА-Я]/.test(authForm.password)) strength += 14;
    const strengthLabel =
      strength < 35 ? 'слабый' : strength < 70 ? 'нормальный' : 'крепкий';
    const strengthClass =
      strength < 35 ? 'weak' : strength < 70 ? 'mid' : 'good';

    return (
      <div className="setup-screen">
        <form className="setup-card auth-card" onSubmit={handleAuthSubmit}>
          <div className="auth-brand">
            <img className="auth-logo" src="/icons/icon-192.png" alt="VAKSA" />
            <div className="auth-wordmark">VAKSA</div>
            <div className="auth-tagline">
              {authMode === 'login' ? 'С возвращением' : 'Добро пожаловать'}
            </div>
          </div>

          <div className="auth-tabs">
            <button
              type="button"
              className={`auth-tab ${authMode === 'login' ? 'active' : ''}`}
              onClick={() => { setAuthMode('login'); setAuthError(''); }}
            >
              Вход
            </button>
            <button
              type="button"
              className={`auth-tab ${authMode === 'register' ? 'active' : ''}`}
              onClick={() => { setAuthMode('register'); setAuthError(''); }}
            >
              Регистрация
            </button>
          </div>

          <label className="auth-field">
            <span className="auth-label">Имя пользователя</span>
            <input
              type="text"
              className={`setup-input auth-input ${authMode === 'register' && username && !usernameOk ? 'invalid' : ''}`}
              value={authForm.username}
              onChange={(e) => setAuthForm((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="имя_на_латинице"
              autoComplete="username"
              autoFocus
              maxLength={32}
              spellCheck={false}
            />
            {authMode === 'register' && (
              <span className={`auth-hint ${usernameOk ? 'ok' : username ? 'bad' : ''}`}>
                {usernameOk
                  ? 'Имя подходит'
                  : username
                  ? '3-32 символа: латиница, цифры, _ . -'
                  : 'Латиница, цифры, _ . -'}
              </span>
            )}
          </label>

          <label className="auth-field">
            <span className="auth-label">Пароль</span>
            <div className="auth-passwrap">
              <input
                type={authShowPass ? 'text' : 'password'}
                className={`setup-input auth-input ${authMode === 'register' && authForm.password && !passOk ? 'invalid' : ''}`}
                value={authForm.password}
                onChange={(e) => setAuthForm((prev) => ({ ...prev, password: e.target.value }))}
                onKeyUp={(e) => setAuthCaps(!!e.getModifierState && e.getModifierState('CapsLock'))}
                placeholder={authMode === 'login' ? 'Пароль' : 'Минимум 8 символов'}
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
              />
              <button
                type="button"
                className="auth-eye"
                onClick={() => setAuthShowPass((v) => !v)}
                title={authShowPass ? 'Скрыть пароль' : 'Показать пароль'}
                aria-label={authShowPass ? 'Скрыть пароль' : 'Показать пароль'}
              >
                {authShowPass ? '🙈' : '👁'}
              </button>
            </div>

            {authCaps && (
              <span className="auth-caps">⚠️ Включён Caps Lock</span>
            )}

            {authMode === 'register' && (
              <>
                {authForm.password && (
                  <div className={`auth-strength ${strengthClass}`}>
                    <div className="auth-strength-bar" />
                    <span>Пароль {strengthLabel}</span>
                  </div>
                )}
                <input
                  type={authShowPass ? 'text' : 'password'}
                  className={`setup-input auth-input ${authForm.pass2 && !pass2Ok ? 'invalid' : ''}`}
                  value={authForm.pass2}
                  onChange={(e) => setAuthForm((prev) => ({ ...prev, pass2: e.target.value }))}
                  placeholder="Повторите пароль"
                  autoComplete="new-password"
                />
                <span className={`auth-hint ${pass2Ok ? 'ok' : authForm.pass2 ? 'bad' : ''}`}>
                  {authForm.pass2 && !pass2Ok ? 'Пароли не совпадают' : ' '}
                </span>
              </>
            )}
          </label>

          {authError && (
            <div className="auth-error" role="alert">
              {authError}
            </div>
          )}

          <button type="submit" className="setup-button auth-submit" disabled={!canSubmit}>
            {authBusy ? (
              <span className="auth-spinner" aria-label="Подождите" />
            ) : authMode === 'login' ? (
              'Войти'
            ) : (
              'Создать аккаунт'
            )}
          </button>

          <div className="auth-switch-row">
            {authMode === 'login' ? (
              <button
                type="button"
                className="auth-switch"
                onClick={() => { setAuthMode('register'); setAuthError(''); }}
              >
                Нет аккаунта? Регистрация
              </button>
            ) : (
              <button
                type="button"
                className="auth-switch"
                onClick={() => { setAuthMode('login'); setAuthError(''); }}
              >
                Уже есть аккаунт? Войти
              </button>
            )}
          </div>

          {isDesktop() && (
            <button
              type="button"
              className="auth-switch auth-serverlink"
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
    <div className={`app-shell ${isMobile ? 'mobile' : ''}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div>
            <div className="brand">VAKSA<span>CHAT</span></div>
            <div className="sidebar-me">@{username}</div>
          </div>
          <span className={`indicator ${isConnected ? 'connected' : 'disconnected'}`} title={isConnected ? 'На связи' : 'Нет связи'}></span>
        </div>

        <div className="sidebar-actions">
          <button type="button" className="new-chat-button" onClick={() => openModal('direct')}>＋ ЧАТ</button>
          <button type="button" className="new-group-button" onClick={() => openModal('group')}>＋ ГРУППА</button>
        </div>

        <div
          className={`pull-refresh ${pulling ? 'pulling' : ''}`}
          style={{ height: `${pullPx}px` }}
        >
          {pullPx > 8 && (
            <span className="pull-spinner" style={{ transform: `rotate(${pullPx * 4}deg)` }}></span>
          )}
        </div>

        <div
          className={`chat-list ${pulling ? 'pulling' : ''}`}
          ref={listScrollRef}
          onTouchStart={onListTouchStart}
          onTouchMove={onListTouchMove}
          onTouchEnd={onListTouchEnd}
        >
          {chatsLoading && chats.length === 0 && <div className="chat-list-hint">Загрузка…</div>}
          {!chatsLoading && chats.length === 0 && <div className="chat-list-hint">Пока нет чатов</div>}
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`chat-item ${chat.id === activeChatId ? 'active' : ''}`}
              onPointerDown={startLongPress(chat)}
              onPointerUp={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onClick={onChatItemClick(chat)}
            >
              <div className="chat-item-top">
                {chat.type === 'direct' && chat.avatar && (
                  <img className="chat-item-avatar" src={chat.avatar} alt={chat.peer} />
                )}
                <span className="chat-item-title">
                  {chat.type === 'group' ? '# ' : '@ '}{chat.title || chat.peer || 'Чат'}
                </span>
                {chat.lastTime && <span className="chat-item-time">{localTime(chat.lastTime)}</span>}
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
          <button type="button" className="icon-button" title="Настройки" onClick={openSettings}>⚙</button>
          <button type="button" className="icon-button" title="Выйти из аккаунта" onClick={handleLogout}>⏻</button>
        </div>
      </aside>

      {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />}

      <main
        className={`chat-main ${mobileChatOpen ? 'open' : ''} ${mobileSwiping ? 'swiping' : ''}`}
        onTouchStart={onChatTouchStart}
        onTouchMove={onChatTouchMove}
        onTouchEnd={onChatTouchEnd}
        style={mobileSwiping ? { transform: `translateX(${mobileSwipe}px)`, transition: 'none' } : undefined}
      >
        <header className="chat-header">
          <button type="button" className="back-button" onClick={closeChatMobile} title="Назад к чатам">‹</button>
          <button type="button" className="menu-button" onClick={() => setSidebarOpen((open) => !open)} title="Чаты">
            ☰
          </button>
          <div className="chat-heading">
            <h2>
              {activeChat
                ? `${activeChat.type === 'group' ? '# ' : '@ '}${activeChat.title || activeChat.peer || 'Чат'}`
                : 'VAKSA CHAT'}
            </h2>
            <span className={`chat-sub ${typingUser ? 'typing' : ''}`}>
              {typingUser
                ? `${typingUser} печатает…`
                : activeChat
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
          ref={messagesContainerRef}
          onScroll={onMessagesScroll}
        >
          {!activeChat && (
            <div className="welcome-message">
              &gt; Добро пожаловать в VAKSA CHAT<br />
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
          {loadingOlder && <div className="history-loading">загрузка истории…</div>}
          {!loadingOlder && canLoadOlder && (
            <button type="button" className="history-more" onClick={loadOlder}>
              ⤒ показать более старые сообщения
            </button>
          )}
          {renderedMessages.map((row) => (
            row.divider ? (
              <div key={row.key} className="day-divider"><span>{row.label}</span></div>
            ) : (
              (() => {
                const msg = row.msg;
                return (
                  <div
                    key={`${msg.chatId}-${msg.id}-${row.key}`}
                    data-mid={msg.id}
                    className={`message ${msg.username === 'System' ? 'system' : 'user'} ${msg.userId && user && msg.userId === user.id ? 'own' : ''} ${msg.type === 'deleted' ? 'deleted' : ''}`}
                    onPointerDown={startMsgPress(msg)}
                    onPointerUp={cancelLongPress}
                    onPointerLeave={cancelLongPress}
                    onContextMenu={onMsgContext(msg)}
                    title="Долгое нажатие — действия"
                  >
                    <div className="msg-head">
                      {avatars[msg.username]
                        ? <img className="msg-avatar msg-avatar-img" src={avatars[msg.username]} alt={msg.username} />
                        : <span className="msg-avatar">{(msg.username?.[0] || '?').toUpperCase()}</span>}
                      <span className="username-label">[{msg.username}]</span>
                      <span className="timestamp">{localTime(msg.timestamp)}{msg.edited ? ' (изменено)' : ''}{msg.userId === user?.id ? (readMarks[msg.chatId] >= msg.id ? ' ✓✓' : ' ✓') : ''}</span>
                    </div>
                    {msg.replyTo ? (
                      (() => {
                        const q = messages.find((m) => m.id === msg.replyTo);
                        return (
                          <div
                            className="msg-quote"
                            onClick={() => document.querySelector(`[data-mid="${msg.replyTo}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                          >
                            <span className="msg-quote-username">
                              {q ? q.username : `сообщение #${msg.replyTo}`}
                            </span>
                            <span className="msg-quote-text">
                              {q
                                ? (q.text || (q.type === 'sticker' ? '🎨 Стикер' : (q.type === 'file' ? '📎 Файл' : ''))).slice(0, 110)
                                : ' message not loaded'}
                            </span>
                          </div>
                        );
                      })()
                    ) : null}
                    {msg.text && (
                      <span className="message-text">&gt; {msg.type === 'deleted' && '🚫 '}
                        {msg.type === 'deleted' ? msg.text : <Markdown text={msg.text} />}
                      </span>
                    )}
                    {renderMessageContent(msg)}
                    {(reactions[String(msg.id)] || []).length > 0 && (
                      <div className="msg-reactions">
                        {reactions[String(msg.id)].map((agg) => (
                          <button
                            key={agg.emoji}
                            type="button"
                            className={`msg-react-chip ${agg.usernames.includes(username) ? 'mine' : ''}`}
                            title={agg.usernames.join(', ')}
                            onClick={() => sendReaction(msg, agg.emoji)}
                          >
                            {agg.emoji}{agg.count > 1 ? ` ${agg.count}` : ''}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()
            )
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

        {(replyTo || editingMsg) && (
          <div className="composer-bar">
            <span className="composer-bar-label">
              {editingMsg ? '✎ Редактирование' : `↩ Ответ ${replyTo.username}`}
            </span>
            <span className="composer-bar-text">
              {(editingMsg ? editingMsg.text : replyTo.text) || (replyTo?.type === 'sticker' ? '🎨 Стикер' : '📎 Файл')}
            </span>
            <button
              type="button"
              className="composer-bar-clear"
              title="Отменить"
              onClick={() => { setReplyTo(null); setEditingMsg(null); }}
            >
              ✕
            </button>
          </div>
        )}

        {msgMenu && (
          <div className="msg-menu-overlay" onClick={() => setMsgMenu(null)}>
            <div className="msg-menu" onClick={(e) => e.stopPropagation()}>
              <div className="msg-menu-preview">
                <b>{msgMenu.username}</b>: {(msgMenu.text || '🎨 Стикер / 📎 Файл').slice(0, 90)}
              </div>
              {msgMenu.type !== 'deleted' && msgMenu.username !== 'System' && (
                <div className="react-row">
                  {['👍', '❤️', '😂', '🔥', '😮', '😡'].map((e) => (
                    <button key={e} type="button" className="react-btn" onClick={() => sendReaction(msgMenu, e)}>
                      {e}
                    </button>
                  ))}
                </div>
              )}
              {msgMenu.type !== 'deleted' && msgMenu.username !== 'System' && (
                <button type="button" onClick={() => { setReplyTo(msgMenu); setEditingMsg(null); setMsgMenu(null); }}>
                  ↩ Ответить
                </button>
              )}
              {msgMenu.userId === user?.id
                && !['deleted', 'file', 'sticker'].includes(msgMenu.type)
                && msgMenu.username !== 'System' && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingMsg(msgMenu);
                    setReplyTo(null);
                    setInputValue(msgMenu.text);
                    setMsgMenu(null);
                    showToast('Так и отправится — можешь переписать текст');
                  }}
                >
                  ✎ Редактировать
                </button>
              )}
              {msgMenu.userId === user?.id && msgMenu.type !== 'deleted' && msgMenu.username !== 'System' && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    wsRef.current?.send(JSON.stringify({ type: 'delete', messageId: msgMenu.id }));
                    setMsgMenu(null);
                    showToast('Сообщение удалено везде');
                  }}
                >
                  🗑 Удалить
                </button>
              )}
              {msgMenu.text && (
                <button
                  type="button"
                  onClick={() => { navigator.clipboard?.writeText(msgMenu.text).catch(() => {}); setMsgMenu(null); }}
                >
                  ⧉ Копировать
                </button>
              )}
            </div>
          </div>
        )}

        <form className="input-form" onSubmit={handleSendMessage}>
          <div className="input-prompt">&gt; {username}:</div>
          <input
            type="text"
            value={inputValue}
            onChange={handleInputChange}
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
        <div className="settings-overlay" onClick={closeSettings}>
          <form
            className="settings-card"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              applyServer(serverDraft);
            }}
          >
            <h2>Настройки</h2>

            <div className="avatar-row">
              {user?.avatar
                ? <img className="avatar-preview" src={user.avatar} alt={username} />
                : <span className="avatar-preview avatar-empty">{(username?.[0] || '?').toUpperCase()}</span>}
              <div>
                <div className="avatar-name">{username}</div>
                <button type="button" className="avatar-change" onClick={() => avatarInputRef.current?.click()}>
                  Сменить аватар…
                </button>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarFile}
                style={{ display: 'none' }}
              />
            </div>

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
                onClick={closeSettings}
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

      {/* --- Мобильные жестовые элементы (FAB, нижние листы, toast) --- */}
      {isMobile && !mobileChatOpen && (
        <button type="button" className="compose-fab" onClick={openCompose} aria-label="Новый чат">＋</button>
      )}

      {composeOpen && (
        <div className="sheet-overlay" onClick={closeCompose}>
          <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle"></div>
            <button type="button" className="sheet-item" onClick={() => composePick('direct')}>
              <span className="sheet-emoji">👤</span> Новый личный чат
            </button>
            <button type="button" className="sheet-item" onClick={() => composePick('group')}>
              <span className="sheet-emoji">👥</span> Новая группа
            </button>
          </div>
        </div>
      )}

      {contextChat && (
        <div className="sheet-overlay" onClick={closeContext}>
          <div className="bottom-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle"></div>
            <div className="sheet-title">
              {contextChat.type === 'group' ? '# ' : '@ '}
              {contextChat.title || contextChat.peer || 'Чат'}
            </div>
            <div className="sheet-sub">
              {contextChat.type === 'group' ? 'Групповой чат' : 'Личный чат'}
              {contextChat.unread > 0 ? ` · ${contextChat.unread} непрочитанных` : ''}
            </div>
            <button type="button" className="sheet-item" onClick={openContextChat}>
              <span className="sheet-emoji">💬</span> Открыть чат
            </button>
            <button type="button" className="sheet-item" onClick={closeContext}>
              <span className="sheet-emoji">✕</span> Отмена
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

export default App;

// Мини-markdown: **жирный**, *курсив*, `код`, https-ссылки. Чистый JSX — без
// innerHTML, XSS невозможен по построению.
function Markdown({ text }) {
  const src = String(text ?? '');
  const parts = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|https?:\/\/[^\s]+)/g;
  let last = 0;
  let i = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) parts.push(src.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<b key={i++}>{tok.slice(2, -2)}</b>);
    else if (tok.startsWith('`')) parts.push(<code key={i++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('http')) {
      parts.push(
        <a key={i++} href={tok} target="_blank" rel="noreferrer noopener">
          {tok.length > 60 ? `${tok.slice(0, 57)}…` : tok}
        </a>,
      );
    } else parts.push(<i key={i++}>{tok.slice(1, -1)}</i>);
    last = m.index + tok.length;
  }
  if (last < src.length) parts.push(src.slice(last));
  return <>{parts}</>;
}
