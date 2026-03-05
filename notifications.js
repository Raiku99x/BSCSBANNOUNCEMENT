const _notifSb = supabase.createClient(
  'https://kbubagifwlfphfcbadvq.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtidWJhZ2lmd2xmcGhmY2JhZHZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI2OTUyMzAsImV4cCI6MjA4ODI3MTIzMH0.2hNZ5EVtEKOJbVC9TtWt2z77H1tD1sq9rhvoUmBZFGA'
);

// ============================================================
//  BSCS1B TaskHub — notifications.js
//  Client-side push subscription management
// ============================================================

// ─── VAPID PUBLIC KEY ──────────────
const VAPID_PUBLIC_KEY = 'BDB28hUn4e2av41itWZ8NP2hryHALsKH2OHomYfNCkWI6rTLwTJEbTNtotHf2jz663NB5DdLI-hkyC3jsck_8iU';

let _swRegistration = null;
let _notifPermission = Notification?.permission || 'default';
let _pushSubscription = null;

// ─── UTILS ───────────────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

function arrayBufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

// ─── REGISTER SERVICE WORKER ─────────────────────────────────
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    _swRegistration = reg;
    return reg;
  } catch (err) {
    console.error('[Notif] SW registration failed:', err);
    return null;
  }
}

// ─── REQUEST PERMISSION ──────────────────────────────────────
async function requestNotifPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied')  return false;

  const perm = await Notification.requestPermission();
  _notifPermission = perm;
  return perm === 'granted';
}

// ─── SUBSCRIBE TO PUSH ───────────────────────────────────────
async function subscribeToPush(reg) {
  try {
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    _pushSubscription = sub;

    const p256dh = arrayBufferToBase64(sub.getKey('p256dh'));
    const auth   = arrayBufferToBase64(sub.getKey('auth'));

    const { error } = await _sb.from('push_subscriptions').upsert({
      endpoint: sub.endpoint,
      p256dh,
      auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

    if (error) {
      console.error('[Notif] Failed to save subscription:', error);
    } else {
      console.log('[Notif] Push subscription saved ✓');
    }

    return sub;
  } catch (err) {
    console.error('[Notif] Subscribe failed:', err);
    return null;
  }
}

// ─── UNSUBSCRIBE ─────────────────────────────────────────────
async function unsubscribeFromPush() {
  if (!_swRegistration) return;
  const sub = await _swRegistration.pushManager.getSubscription();
  if (!sub) return;

  await _sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe();
  _pushSubscription = null;
  console.log('[Notif] Unsubscribed ✓');
}

// ─── BELL BUTTON TOGGLE ──────────────────────────────────────
async function toggleNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    showNotifToast('❌ Notifications not supported on this browser.', 'error');
    return;
  }

  if (_notifPermission === 'denied' || Notification.permission === 'denied') {
    showNotifToast('⚠️ Notifications are blocked. Enable them in browser settings.', 'warn');
    return;
  }

  const currentSub = _swRegistration
    ? await _swRegistration.pushManager.getSubscription()
    : null;

if (currentSub) {
    // Already subscribed → show challenge before unsubscribing
    openUnsubChallenge();
    return;
  } else {
    // Not subscribed → subscribe
    const granted = await requestNotifPermission();
    if (!granted) {
      showNotifToast('⚠️ Permission denied. Enable notifications in browser settings.', 'warn');
      updateBellUI();
      return;
    }
    const reg = _swRegistration || await registerServiceWorker();
    if (!reg) {
      showNotifToast('❌ Could not register service worker.', 'error');
      return;
    }
    const sub = await subscribeToPush(reg);
    if (sub) {
      showNotifToast('🔔 Notifications enabled! You\'ll be notified about tasks & notes.', 'success');
    } else {
      showNotifToast('❌ Failed to enable notifications.', 'error');
    }
    updateBellUI();
  }
}

// ─── UPDATE BELL ICON STATE ──────────────────────────────────
async function updateBellUI() {
  const btn  = document.getElementById('notifBellBtn');
  const icon = document.getElementById('notifBellIcon');
  if (!btn || !icon) return;

  // Check real subscription state from SW
  let sub = null;
  try {
    const reg = _swRegistration || await navigator.serviceWorker.ready;
    if (reg) {
      _swRegistration = reg;
      sub = await reg.pushManager.getSubscription();
    }
  } catch (e) {
    // SW not available — treat as unsubscribed
  }

  const denied  = Notification?.permission === 'denied';
  const active  = !!sub;

  // ── Always show the bell; never hide it ──────────────────────
  // Visibility: show always. The bell is how users toggle notifications.
  btn.style.display = '';
  btn.style.removeProperty('display');

  // ── Reset classes cleanly ────────────────────────────────────
  btn.className = 'icon-bar notif-bell';
  if (active) btn.classList.add('notif-on', 'notif-subscribed');
  if (denied) btn.classList.add('notif-denied');

  btn.title = denied ? 'Notifications blocked — enable in browser settings'
            : active ? 'Notifications ON — tap to disable'
            :          'Enable task notifications';

  // ── Icon: bell with filled dot when active, plain when not ───
  if (active) {
    icon.innerHTML = `
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>`;
    // Active dot is handled via CSS ::before on .notif-on
  } else if (denied) {
    icon.innerHTML = `
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      <line x1="1" y1="1" x2="23" y2="23"/>`;
  } else {
    icon.innerHTML = `
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>`;
  }
}

// ─── TOAST ───────────────────────────────────────────────────
function showNotifToast(msg, type = 'info') {
  let toast = document.getElementById('notifToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'notifToast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className   = 'notif-toast notif-toast-' + type + ' show';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3800);
}

// ─── INIT ────────────────────────────────────────────────────
async function initNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

  // Register SW silently on page load
  const reg = await registerServiceWorker();
  if (!reg) return;
  _swRegistration = reg;

  // Check if already subscribed
  const sub = await reg.pushManager.getSubscription();

  if (sub) {
    _pushSubscription = sub;
    const p256dh = arrayBufferToBase64(sub.getKey('p256dh'));
    const auth   = arrayBufferToBase64(sub.getKey('auth'));

    // Re-upsert to DB on every page load so subscription stays fresh
    const { error } = await _sb.from('push_subscriptions').upsert({
      endpoint:   sub.endpoint,
      p256dh,
      auth,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });

    if (error) {
      console.warn('[Notif] Re-upsert failed:', error);
    } else {
      console.log('[Notif] Subscription refreshed in DB ✓');
    }
    _syncDoneToSupabase();
  }

  // Update bell UI to reflect current state
  await updateBellUI();
}

// Auto-init when script loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initNotifications);
} else {
  initNotifications();
}
