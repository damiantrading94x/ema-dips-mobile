/* eslint-disable no-undef */
/**
 * Service worker for EMA Dips.
 *
 * Two jobs:
 *  1. Receive web pushes and raise a notification. This runs with the app
 *     closed and the phone locked — that is the entire point of the app.
 *  2. Cache the shell so opening it offline (on a plane, abroad with no data)
 *     shows the last known dip list instead of a browser error page.
 */

const CACHE = 'ema-dips-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  // Take over immediately so a reinstall doesn't leave the old worker handling pushes.
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => { /* a missing shell file must not block install */ })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Network-first for API calls (a stale dip list is worse than none), cache-first
 * for the shell. API responses are still cached so the app can show the last
 * known list with an explicit "offline" marker.
 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isApi = url.pathname.includes('/api/');

  if (isApi) {
    event.respondWith(
      fetch(req)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
          return resp;
        })
        .catch(() => caches.match(req).then(hit => hit || Response.error())),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'EMA Dips', body: event.data ? event.data.text() : 'New alert' };
  }

  const title = data.title || 'EMA Dips alert';
  const options = {
    body: data.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    // Deep dips are the ones worth interrupting for — keep them on screen
    // until acknowledged rather than auto-dismissing after a few seconds.
    requireInteraction: Math.abs(data.pctBelow || 0) >= 20,
    vibrate: [200, 100, 200],
    // One notification per ticker: a later, deeper reading replaces the earlier
    // one instead of stacking five alerts for the same stock.
    tag: data.ticker ? `dip-${data.ticker}` : 'dip-test',
    renotify: true,
    timestamp: data.sentAt ? new Date(data.sentAt).getTime() : Date.now(),
    data: { ticker: data.ticker || null, pctBelow: data.pctBelow ?? null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const ticker = event.notification.data && event.notification.data.ticker;
  const target = ticker ? `./?ticker=${encodeURIComponent(ticker)}` : './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Focus an existing window rather than opening a second copy.
      for (const client of list) {
        if ('focus' in client) {
          client.navigate?.(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
