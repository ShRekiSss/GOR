# GOR

Retro-style messenger: Go + WebSocket + SQLite, клиент на React.
Один бинарник, без внешних зависимостей и без CGO — собирается под Windows, Linux и (в планах) Android.

## Возможности

- 🎮 Ретро-терминальный интерфейс (зелёный на чёрном)
- 💬 Чат в реальном времени по WebSocket
- 🔐 Аккаунты: регистрация и вход, пароли — Argon2id, сессии на 30 дней
- 👤 Личные диалоги 1-1 и группы, список чатов, непрочитанные
- 👥 Несколько пользователей одновременно, счётчик онлайна
- 🔔 Системные сообщения о входе/выходе
- 📎 Отправка файлов (изображения, аудио, видео, документы) до 50 МБ
- 🎨 Стикеры и поиск GIPHY
- 📱 Адаптивная вёрстка (работает с телефона)
- 🖥️ Desktop-приложение (Tauri 2) под Windows и Linux: трей, автозапуск, системные уведомления
- 💾 История сообщений в SQLite (WAL)
- ❤️ Health-check `/api/health` для мониторинга

## Быстрый старт

### Сервер (production)

```bash
# 1. Клиент
cd frontend && npm ci && npm run build && cd ..

# 2. Сервер
go run .                 # http://localhost:8080
# или собранный бинарник
go build -o gor . && ./gor
```

Данные лежат рядом с бинарником: `chat.db` и `uploads/`. Пути и порт можно
переопределить переменными окружения (см. таблицу ниже).

### Разработка (горячая перезагрузка)

```bash
# Терминал 1 — React
cd frontend && npm start        # http://localhost:3000

# Терминал 2 — Go
go run .                        # :8080, проксируется из React (поле "proxy" в package.json)
```

## Конфигурация

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `GOR_PORT` | `8080` | Порт HTTP и WebSocket (флаг `-port` тоже работает) |
| `GOR_DB` | `./chat.db` | Путь к базе SQLite |
| `GOR_UPLOADS` | `./uploads` | Каталог загруженных файлов |
| `GOR_STATIC` | `./frontend/build` | Каталог собранного клиента |
| `GOR_ORIGINS` | — | Разрешённые Origin для WS через запятую (кроме своего) |
| `REACT_APP_GIPHY_API_KEY` | демо-ключ | Ключ GIPHY, подставляется при сборке фронтенда |

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | Статус, аптайм, версия (без входа) |
| POST | `/api/auth/register` | Регистрация: `{username, password}` → токен |
| POST | `/api/auth/login` | Вход: `{username, password}` → токен |
| POST | `/api/auth/logout` | Выход (токен в заголовке) |
| GET | `/api/auth/me` | Текущий пользователь |
| GET | `/api/stats` | Сколько человек онлайн |
| GET | `/api/users?q=` | Поиск пользователей для нового чата |
| GET | `/api/chats` | Чаты пользователя: последнее сообщение и `unread` |
| POST | `/api/chats` | Создать чат: `{type:"direct",username}` или `{type:"group",title,usernames}` |
| GET | `/api/chats/{id}/messages` | Последние 100 сообщений чата |
| POST | `/api/chats/{id}/read` | Отметить прочитанным: `{messageId}` |
| POST | `/api/upload` | Загрузка файла (multipart: `file`, `chatId`) |
| GET | `/api/download?file=...` | Скачивание файла |
| WS | `/ws?token=...` | Чат в реальном времени |

Защищённые запросы передают токен в заголовке
`Authorization: Bearer <token>`; WebSocket — в query `?token=...`
(браузерный WebSocket не умеет заголовки).

### Аккаунты

- Пароль хранится только как хеш **Argon2id** (19 MiB, t=2), в открытом виде — нигде.
- Токен сессии — 32 случайных байта, живёт 30 дней, хранится на клиенте
  в `localStorage` (отдельно для каждого сервера).
- Имя: 3–32 символа, латиница/цифры/`_ . -`, регистр не важен для уникальности.
- Есть ограничение попыток входа/регистрации: 20 за 5 минут с одного IP.
- При регистрации пользователь попадает в **«Общий чат»**; личные диалоги и
  группы создаются из интерфейса. Сообщения и файлы доступны только участникам чата.
- Непрочитанные считаются по `last_read_message_id` для каждого участника.

## Деплой

### Вариант 1 — Docker Compose (рекомендуется)

```bash
cd deploy
docker compose up -d --build
```

Порт слушается только на `127.0.0.1:8080` — наружу отдавайте через Caddy
или Cloudflare Tunnel. Данные — в `deploy/data/`.

### Вариант 2 — systemd + Caddy (VPS с доменом)

```bash
# пользователь и каталоги
sudo useradd -r -s /usr/sbin/nologin -d /opt/gor gor
sudo mkdir -p /opt/gor /var/lib/gor/uploads /etc/gor
sudo chown -R gor:gor /opt/gor /var/lib/gor

# бинарник и клиент
sudo cp gor /opt/gor/
sudo cp -r frontend/build /opt/gor/frontend/

# конфиг и юнит
sudo cp deploy/gor.env.example /etc/gor/gor.env
sudo cp deploy/gor.service /etc/systemd/system/gor.service
sudo systemctl daemon-reload
sudo systemctl enable --now gor

# HTTPS (Caddy сам получит сертификат)
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # замените домен
sudo systemctl reload caddy
```

### Вариант 3 — Cloudflare Tunnel (нет публичного IP / домашний ПК)

```bash
# см. deploy/cloudflared-config.yml
cloudflared tunnel login
cloudflared tunnel create gor
cloudflared tunnel route dns gor chat.example.com
sudo cloudflared service install
```

Доступ по HTTPS из любой точки, порты наружу открывать не нужно.

### Проверка после деплоя

```bash
curl -s https://chat.example.com/api/health
sudo systemctl status gor          # или: docker compose logs -f gor
```

## Сборка под платформы

CGO не используется, поэтому кросс-компиляция не требует тулчейнов:

```bash
make windows   # dist/gor.exe
make linux     # dist/gor
make dist      # готовые zip/tar.gz: сервер + собранный клиент
```

Готовые сборки также собираются в GitHub Actions
(`.github/workflows/build.yml`): на каждый push — артефакты, на тег `v*` — Release.

### Запуск на Windows

1. Скачайте `gor-windows-amd64.zip` из Releases (или соберите `make windows`).
2. Распакуйте, запустите `gor.exe`.
3. Откройте <http://localhost:8080>.

Для доступа с других устройств в той же сети — откройте порт 8080 в брандмауэре
Windows и заходите по локальному IP: `http://192.168.x.x:8080`.


## Приложение для Windows (Tauri 2)

В `desktop/` — обёртка вокруг того же React-клиента: отдельное окно, без браузера
и вкладок. Внутри используется WebView2 (в Windows 10/11 уже установлен).

**Первый запуск:** приложение попросит адрес сервера (например
`https://chat.example.com` или `http://192.168.0.103:8080`), сохранит его и
подключится. Сменить сервер можно кнопкой ⚙ в списке чатов.

Что уже есть в desktop-версии:

- **Трей**: закрытие окна крестиком прячет его в трей, приложение продолжает
  получать сообщения. Меню трея — «Открыть GOR» / «Выход».
- **Автозапуск**: галочка «Запускать при входе в систему» в настройках ⚙.
- **Системные уведомления** о новых сообщениях (Windows Toast / Linux).
- Сохранённый адрес сервера и переключение между серверами.

Готовые сборки (`.exe`-установщик NSIS, portable `.exe`, `.deb`/AppImage)
публикуются в Releases при пуше тега `v*`. Локальная сборка:

```bash
make frontend           # собранный React-клиент
make desktop-windows    # portable .exe + NSIS (кросс-сборка с Linux)
make desktop            # Linux (нужны libwebkit2gtk-4.1-dev, libayatana-appindicator3-dev)
```

Для сборки NSIS с Linux нужны `nsis`, `llvm`/`lld`, `cargo-xwin` и
`libayatana-appindicator3-dev`; Tauri вызывает `makensis` из `PATH`.

Структура:

```
desktop/
  src-tauri/        # Rust: окно, иконки, конфиг Tauri
  assets/           # исходник иконки
  package.json      # @tauri-apps/cli
```

Сервер уже умеет отдавать CORS-заголовки для origin `tauri://localhost`,
поэтому desktop-клиент может подключаться к удалённому серверу. Для Android
этот же проект позже собирается через `tauri android`.

## Роадмап

Приоритет платформ: **Windows → Linux → Android**.

### 1. Деплой (сейчас)
- [x] Конфигурация через переменные окружения
- [x] Health-check `/api/health`
- [x] Корректное завершение по SIGTERM
- [x] Docker + Docker Compose
- [x] systemd-юнит + пример Caddy (HTTPS)
- [x] Пример Cloudflare Tunnel
- [x] GitHub Actions: сборки Windows/Linux и Release по тегу
- [ ] Домен и боевой сервер
- [ ] Автодеплой (GitHub Actions → сервер)
- [ ] Бэкапы `chat.db` и `uploads/` (cron)

### 2. Стабильность
- [x] Ping/pong и таймауты WebSocket (мёртвые соединения закрываются)
- [x] Защита от «чужих» Origin при подключении к WS
- [x] Строгая проверка путей загрузки/скачивания
- [x] Уникальные имена файлов, ограничение размера
- [x] Исправлены дубли сообщений при загрузке файлов
- [ ] Ограничение частоты сообщений (rate limit)
- [ ] Отдача статики с кэшированием, gzip/brotli (сейчас — Caddy)
- [ ] Ротация логов

### 3. Аккаунты и личные сообщения
- [x] Регистрация/вход (логин+пароль, хеш Argon2id)
- [x] Сессии (Bearer-токен, 30 дней; работает и в браузере, и в desktop)
- [x] Ограничение попыток входа
- [x] Приватные чаты 1-1 и группы
- [x] Список чатов, непрочитанные
- [x] Уведомления (системные в desktop, браузерные в web)
- [ ] Пуш-уведомления при закрытом приложении
- [ ] Аватары и профили

### 4. Приложение под Windows (как Telegram/Discord)
- [x] Обёртка Tauri 2 вокруг существующего React-клиента (WebView2)
- [x] Экран выбора сервера и смена сервера в приложении
- [x] Иконка приложения
- [x] Portable `.exe` (кросс-сборка с Linux через cargo-xwin)
- [x] Сборка установщиков NSIS и MSI в GitHub Actions
- [x] Трей, автозапуск, нативные уведомления
- [ ] Автообновление

### 5. Linux
- [x] Та же обёртка Tauri (одна кодовая база)
- [x] Сборка AppImage и deb в GitHub Actions
- [x] Локальная сборка deb/AppImage с треем
- [ ] Проверка на живом дистрибутиве
- [ ] Подпись пакетов

### 6. Android
- [ ] PWA-манифест и service worker (быстрый шаг)
- [ ] Сборка Android в Tauri 2 (тот же React-клиент)
- [ ] Пуш-уведомления (FCM)

### 7. Стиль и название
- [ ] Новое имя и логотип
- [ ] Тёмная/светлая темы, кастомизация
- [ ] Звуки и анимации

## Безопасность (текущее состояние)

- Аккаунты: пароли — Argon2id, вход по токену. Личные чаты и группы изолированы:
  сервер проверяет членство при чтении, отправке и загрузке файлов.
- Файлы в `/uploads/` по-прежнему доступны всем, кто знает прямую ссылку
  (проверка прав на скачивание — следующий шаг).
- Сквозного шифрования пока нет: сервер видит сообщения в базе.
- Для продакшена используйте HTTPS (Caddy/туннель) и регулярные бэкапы.
- `chat.db` и `uploads/` не должны попадать в git (см. `.gitignore`).

## Лицензия

Не указана. Добавьте файл `LICENSE`, если планируете открытый проект.
