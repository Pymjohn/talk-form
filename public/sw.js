const CACHE = 'talk-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// 服务端推送：重点关注临期/逾期提醒
self.addEventListener('push', function (e) {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  var opts = {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || 'talk',
    renotify: true,
    data: { url: d.url || '/' }
  };
  e.waitUntil(self.registration.showNotification(d.title || '谈心谈话', opts));
});

// 后台定期检查（Periodic Background Sync）：不依赖推送服务，SW 自己醒来查一次
self.addEventListener('periodicsync', function (e) {
  if (e.tag !== 'focus-check') return;
  e.waitUntil(
    fetch('/api/focus/brief', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || !d.need) return;
        return self.registration.showNotification('重点关注 · ' + d.need + ' 人本周期未谈', {
          body: (d.text || '') + (d.period ? '（' + d.period + ' 截止）' : ''),
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          tag: 'focus-local',
          renotify: true,
          data: { url: '/#focus' }
        });
      })
      .catch(function () {})
  );
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('focus' in list[i]) { list[i].navigate(target); return list[i].focus(); }
    }
    if (clients.openWindow) return clients.openWindow(target);
  }));
});

self.addEventListener('fetch', function (e) {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;           // 接口不缓存
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function (r) {
      const copy = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, copy); }).catch(function () {});
      return r;
    }).catch(function () { return caches.match(e.request).then(function (m) { return m || caches.match('/'); }); })
  );
});
