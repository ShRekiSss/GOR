# ---------- 1. Клиент (React) ----------
FROM node:22-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
# Ключ GIPHY подставляется на этапе сборки (можно задать build-arg)
ARG REACT_APP_GIPHY_API_KEY=""
ENV REACT_APP_GIPHY_API_KEY=$REACT_APP_GIPHY_API_KEY
RUN npm run build

# ---------- 2. Сервер (Go, без CGO) ----------
FROM golang:1.26-alpine AS backend
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/gor .

# ---------- 3. Runtime ----------
FROM alpine:3.22
RUN apk add --no-cache ca-certificates tzdata && \
    addgroup -S gor && adduser -S -G gor -h /app gor
WORKDIR /app
COPY --from=backend /out/gor /app/gor
COPY --from=frontend /app/frontend/build /app/frontend/build

ENV GOR_PORT=8080 \
    GOR_DB=/data/chat.db \
    GOR_UPLOADS=/data/uploads \
    GOR_STATIC=/app/frontend/build

RUN mkdir -p /data/uploads && chown -R gor:gor /data /app
USER gor
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O- http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/app/gor"]
