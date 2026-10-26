import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// ---- Тотальный ловец ошибок JS (баннер поверх UI) ----
// На телефоне без devtools не видно крашей React/WS — зато мы их тут же видим.
function showFatalError(text) {
  const cur = document.getElementById('fatal-error');
  if (!cur) {
    const el = document.createElement('div');
    el.id = 'fatal-error';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;'
      + 'background:#7a1420;color:#fff;font:13px/1.45 monospace;padding:10px 14px;'
      + 'white-space:pre-wrap;max-height:34vh;overflow:auto;border-top:2px solid #ff6b81';
    el.textContent = text;
    (document.body || document.createElement('body')).appendChild(el);
  } else if (cur.textContent.length < 4000) {
    cur.textContent += `\n+ ${text}`;
  }
}

try {
  window.addEventListener('error', (e) => {
    if (e && e.message) showFatalError(`⚠ JS error: ${e.message}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    showFatalError(`⚠ Promise: ${typeof r === 'object' && r ? (r.stack || r.message || JSON.stringify(r)) : String(r)}`);
  });
} catch (e) {
  /* совсем старый WebView без addEventListener — уже беда, но не мешаем */
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// PWA: регистрируем service worker (в desktop-версии не мешает — если что, тихо игнорим)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* PWA недоступна в текущем окружении (Tauri/локальный файл) — не критично */
    });
  });
}

