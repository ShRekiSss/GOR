// Web Push-клиент: регистрация SW, подписка на пуши, отписка.

export const hasPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function ensureSw() {
  if (!hasPush()) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}

export async function pushState(token, serverBase = '') {
  if (!hasPush()) return { supported: false, on: false };
  try {
    const reg = await ensureSw();
    if (!reg) return { supported: false, on: false };
    const sub = await reg.pushManager.getSubscription();
    return { supported: true, on: !!sub, endpoint: sub ? sub.endpoint : '' };
  } catch {
    return { supported: false, on: false };
  }
}

export async function pushEnable(token, serverBase = '') {
  if (!hasPush()) throw new Error('Пуш не поддержан этим браузером');
  const reg = await ensureSw();
  if (!reg) throw new Error('Service Worker не завёлся');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Уведомления не разрешены');
  const r = await fetch(`${serverBase}/api/push/pubkey`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Сервер не отдал VAPID-ключ');
  const { publicKey } = await r.json();
  const appKey = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey });
  const j = sub.toJSON();
  const up = await fetch(`${serverBase}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
  });
  if (!up.ok) throw new Error(up.status === 400 ? 'Сервер отклонил подписку' : 'Не удалось сохранить подписку');
  return true;
}

export async function pushDisable(token, serverBase = '') {
  const reg = await ensureSw();
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  try {
    await fetch(`${serverBase}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch { /* сервер может быть недоступен — подписку всё равно гасим */ }
  await sub.unsubscribe().catch(() => {});
}

// Выбрать чат из push-нотификации: клиент слушает сообщения SW.
export function initPushRouting(onOpenChat) {
  if (!hasPush()) return;
  navigator.serviceWorker.addEventListener('message', (ev) => {
    try {
      if (ev.data?.type === 'open-chat') {
        const m = /chat=(\d+)/.exec(ev.data.url || '');
        onOpenChat(m ? Number(m[1]) : null);
      }
    } catch { /* игнорируем мусор */ }
  });
}
