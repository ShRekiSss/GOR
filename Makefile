VERSION ?= 1.0.4
LDFLAGS  = -s -w -X main.version=$(VERSION)
OUT      = dist

.PHONY: all frontend server linux windows dist clean dev desktop desktop-windows

all: dist

frontend:
	cd frontend && npm ci --no-audit --no-fund || npm install --no-audit --no-fund
	cd frontend && npm run build

server:
	mkdir -p $(OUT)
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/gor .

linux: server
	@echo "Linux: $(OUT)/gor"

windows:
	mkdir -p $(OUT)
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/gor.exe .
	@echo "Windows: $(OUT)/gor.exe"

# Готовые комплекты для раздачи: сервер + собранный клиент
dist: frontend
	mkdir -p $(OUT)/gor-linux-amd64 $(OUT)/gor-windows-amd64
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/gor-linux-amd64/gor .
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUT)/gor-windows-amd64/gor.exe .
	cp -r frontend/build $(OUT)/gor-linux-amd64/
	cp -r frontend/build $(OUT)/gor-windows-amd64/
	cp README.md $(OUT)/gor-linux-amd64/ 2>/dev/null || true
	cp README.md $(OUT)/gor-windows-amd64/ 2>/dev/null || true
	tar -C $(OUT) -czf $(OUT)/gor-linux-amd64.tar.gz gor-linux-amd64
	cd $(OUT) && zip -qr gor-windows-amd64.zip gor-windows-amd64
	@ls -lh $(OUT)

# Desktop-приложение (Tauri 2). Сначала нужен собранный клиент: make frontend
desktop: frontend
	cd desktop && npm ci --no-audit --no-fund || npm install --no-audit --no-fund
	cd desktop && npx tauri build --no-bundle

# Кросс-сборка Windows .exe + NSIS с Linux. Нужны: rustup target add x86_64-pc-windows-msvc,
# cargo install cargo-xwin, nsis, llvm/lld и libayatana-appindicator3-dev.
# makensis должен быть в PATH; MSI собирается в CI на windows-latest.
desktop-windows: frontend
	cd desktop && npm ci --no-audit --no-fund || npm install --no-audit --no-fund
	cd desktop && npx tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin --bundles nsis

dev:
	@echo "Терминал 1: cd frontend && npm start"
	@echo "Терминал 2: GOR_PORT=8080 go run ."

clean:
	rm -rf $(OUT) frontend/build
