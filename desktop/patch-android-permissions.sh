#!/usr/bin/env bash
# Вставляет разрешения для голосовых звонков и уведомлений в AndroidManifest.
# Tauri регенерирует gen/android при «tauri android init», поэтому патчим
# ПОСЛЕ init и до build. Идемпотентно: повторные запуски ничего не дублируют.
# Пути: ./patch-android-permissions.sh (запускать из каталога desktop/).
set -euo pipefail

M="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
[ -f "$M" ] || { echo "AndroidManifest не найден: сначала npx tauri android init"; exit 1; }

PERMS=(
  android.permission.RECORD_AUDIO          # микрофон — голосовые звонки (WebRTC)
  android.permission.MODIFY_AUDIO_SETTINGS # аудионастройки звонка (эхо-подавление и пр.)
  android.permission.POST_NOTIFICATIONS    # уведомления на Android 13+
  android.permission.FOREGROUND_SERVICE    # процесс на переднем плане для звонка
  android.permission.VIBRATE               # вибро-рингтон входящего звонка
)

add_perm() {
  local perm="$1"
  if grep -q "android:name=\"$perm\"" "$M"; then
    echo "уже есть: $perm"
    return
  fi
  if grep -q "android.permission.INTERNET" "$M"; then
    # вставляем сразу после первой uses-permission (INTERNET у Tauri есть всегда)
    sed -i "0,/android.permission.INTERNET/s|<uses-permission android:name=\"android.permission.INTERNET\" />|<uses-permission android:name=\"android.permission.INTERNET\" />\n    <uses-permission android:name=\"$perm\" />|" "$M"
  else
    # страховой вариант: перед </manifest>
    sed -i "s|</manifest>|    <uses-permission android:name=\"$perm\" />\n</manifest>|" "$M"
  fi
  echo "добавлено: $perm"
}

for perm in "${PERMS[@]}"; do
  add_perm "$perm"
done

grep -c "uses-permission" "$M"
