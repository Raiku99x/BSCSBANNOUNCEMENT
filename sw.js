// ============================================================
//  BSCS1B TaskHub — sw.js
//  Handles push events including zero-payload pushes
// ============================================================

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim());
});

// ─── PUSH EVENT ──────────────────────────────────────────────
self.addEventListener('push', event => {
  // Try to parse payload — but ALWAYS show a notification
  // even if payload is empty (zero-payload push)
  let title = '🚫 Task Cancelled';
  let body  = 'A task has been cancelled. Tap to view.';
  let tag   = 'taskhub-cancel';
  let url   = '/';

  if (event.data) {
    try {
      const data = event.data.json();
      title = data.title || title;
      body  = data.body  || body;
      tag   = data.tag   || tag;
      url   = data.url   || url;
    } catch {
      try {
        // Maybe it's plain text
        const text = event.data.text();
        if (text) body = text;
      } catch {}
    }
  }

  const options = {
    body,
    icon:               '/icon-192.png',
    badge:              '/badge-72.png',
    tag,
    data:               { url },
    vibrate:            [200, 100, 200],
    silent:             false,
    renotify:           true,
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ─── NOTIFICATION CLICK ──────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(urlToOpen);
    })
  );
});

self.addEventListener('notificationclose', () => {});
