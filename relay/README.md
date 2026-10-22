# ВАКСА-релей (Cloudflare Workers)

Аварийно-штатный мост между доменом `vaksa.space` и домашним сервером,
когда провайдер режет Cloudflare Tunnel (порт 7844).

## Как устроено

```
браузер/приложение ─ https://vaksa.space ─▶ Cloudflare Worker + Durable Object
                                                   │  (WebSocket, обычный TLS:443)
                                                   ▼
                                     домашний клиент cmd/relayclient (WSS)
                                                   │  http://127.0.0.1:8080
                                                   ▼
                                             сервер GOR
```

- `relay/worker/` — Worker выступает публичным фронтом на `vaksa.space`
  (custom domain, бесплатно) и хранит WS-каналы на домашний клиент.
- `cmd/relayclient/` — клиент на машине с сервером: держит WSS наружу
  (для провайдера это обычный HTTPS-443 трафик, не режется), принимает кадры
  `{c, req, d, fin}` и исполняет их против `127.0.0.1:8080`.

## Развёртывание

```bash
cd relay/worker
wrangler login                      # один раз, в браузере
wrangler secret put RELAY_KEY       # тот же ключ, что в /etc/gor-relay.env
wrangler deploy
```

Домашний клиент (systemd):

```bash
sudo cp cmd/relayclient/../bin/relayclient /opt/gor/relayclient
sudo systemctl enable --now gor-relay
```

## Ограничения

- Бесплатный план Cloudflare: ~100 тыс. запросов/день на Worker, лимит CPU
  на запрос — piping-проксирование не тратит CPU, так что практически не ощутимо.
- Тела файлов идут чанками по 512 КиБ (base64) — uploads/downloads работают.
- Если соединение рвётся, клиент сам переподключается каждые 5 секунд.
