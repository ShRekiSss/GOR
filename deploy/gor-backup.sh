#!/usr/bin/env bash
# Авто-бэкап VAKSA (GOR): снапшот SQLite раз в сутки, держим 7 последних.
# Ставится как systemd-timer (см. gor-backup.service/.timer).
set -euo pipefail

DB="${GOR_DB:-/var/lib/gor/chat.db}"
UPLOADS="${GOR_UPLOADS:-/var/lib/gor/uploads}"
BACKUP_DIR="/var/lib/gor/backups"
KEEP=7

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/gor-$TS.db"

# VACUUM INTO делает консистентный снапшот даже при работающем сервере.
sqlite3 "$DB" "VACUUM INTO '$OUT.tmp';" 2>/dev/null || {
  # fallback: копия на живую (WAL-режим обычно это переживает)
  cp "$DB" "$OUT.tmp"
}
mv "$OUT.tmp" "$OUT"

# uploads — инкрементно, раз в сутки, в отдельную папку месяца.
if [ -d "$UPLOADS" ]; then
  mkdir -p "$BACKUP_DIR/uploads-$(date +%Y%m)"
  rsync -a --ignore-existing "$UPLOADS/" "$BACKUP_DIR/uploads-$(date +%Y%m)/" 2>/dev/null || true
fi

ls -1t "$BACKUP_DIR"/gor-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "Бэкап готов: $OUT ($(du -h "$OUT" | cut -f1))"
