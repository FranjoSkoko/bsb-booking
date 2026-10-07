// Jednostavan service worker: aplikacija se može instalirati na mobitel,
// a stil, fontovi i logotipi učitavaju se iz memorije uređaja.
const CACHE = 'bsb-v2';
const SHELL = ['/css/style.css', '/js/booking.js', '/assets/logo/BSB_Horizontalni_logo_tamni.svg', '/assets/logo/BSB_Znak_u_krugu_tamni.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/admin')) return;
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // Ostalo: prvo mreža, a ako nema interneta – zadnja spremljena verzija
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request)));
});

// Obavijesti za Barbaru (novi zahtjev, otkazivanje, lista čekanja)
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Barbara Skoko Beauty', {
    body: data.body || '',
    tag: data.tag,
    icon: '/assets/logo/icon_192.png',
    badge: '/assets/logo/favicon_32.png',
    data: { url: data.url || '/admin' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/admin', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.includes('/admin'));
    if (open) return open.navigate(url).then((c) => (c || open).focus()).catch(() => open.focus());
    return self.clients.openWindow(url);
  }));
});
