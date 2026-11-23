// Проверка готовности звонков для ПК (Tauri desktop) и Android (WebView/APK).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { fails++; console.log('FAIL', name, extra ?? ''); }
}

const calls = read('frontend/src/calls.js');
const tauri = read('desktop/src-tauri/tauri.conf.json');
const caps = read('desktop/src-tauri/capabilities/default.json');
const patch = read('desktop/patch-android-permissions.sh');
const build = read('.github/workflows/build.yml');
const debug = read('.github/workflows/android-debug.yml');

// --- ПК (Tauri desktop, WebView2 / WKWebView) ---
check('ПК: getUserMedia доступен', calls.includes('navigator.mediaDevices?.getUserMedia'));
check('ПК: демонстрация экрана', calls.includes('getDisplayMedia'));
check('ПК: Tauri CSP разрешает медиа и ws', tauri.includes('media-src') && tauri.includes('connect-src') && tauri.includes('ws:'));
check('ПК: WebView может слать IPC/уведомления', caps.includes('core:default') && caps.includes('notification:default'));
check('ПК: WebRTC через WS-сигналинг', calls.includes("type: 'call_offer'") && calls.includes("type: 'call_answer'") && calls.includes("type: 'call_ice'"));

// --- Android (Tauri Android WebView / APK) ---
for (const perm of ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'FOREGROUND_SERVICE', 'VIBRATE', 'POST_NOTIFICATIONS']) {
  check('Android: разрешение ' + perm, patch.includes(perm));
}
check('Android: патч применяется в release-сборке', build.includes('bash patch-android-permissions.sh'));
check('Android: патч применяется в debug-сборке', debug.includes('bash patch-android-permissions.sh'));
check('Android: собирается universal APK', build.includes('Universal') || build.includes('universal') || build.includes('--apk'));
check('Android: звонок вибрирует при входящем', calls.includes('navigator.vibrate'));

// --- Общее: таймауты и отказы ---
check('есть RING_TIMEOUT и CONNECT_TIMEOUT', calls.includes('RING_TIMEOUT') && calls.includes('CONNECT_TIMEOUT'));
check('есть сброс при iceconnectionstate=failed', calls.includes('oniceconnectionstatechange') && calls.includes('failed'));
check('есть понятные ошибки соединения', calls.includes('Не удалось соединиться'));

console.log(fails ? `ИТОГ: ${fails} ПРОВАЛОВ` : 'ИТОГ: ВСЁ ОК');
process.exit(fails ? 1 : 0);
