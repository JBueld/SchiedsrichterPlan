// Einfacher Service Worker: App-Shell (HTML/Manifest/Icons) cachen, damit die
// Seite installierbar ist und auch bei schlechter Verbindung (z.B. in einer
// Sporthalle) zumindest die zuletzt geladenen Daten anzeigt.
const CACHE_NAME = 'srp-cache-v1';
const APP_SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // HTML-Seite und Daten immer netzwerk-zuerst laden (fällt nur bei
  // Netzwerkfehler auf den Cache zurück). So bekommen Nutzer nach einem
  // Deploy sofort die aktuelle Seite statt einer dauerhaft "eingefrorenen"
  // gecachten Version - nur echte Offline-Nutzung greift auf den Cache zu.
  const isAppShell = event.request.mode === 'navigate' || url.pathname.endsWith('data.json');
  if (isAppShell) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Statische Assets (Icons, Manifest, Leaflet-Ressourcen) dürfen aus
  // Performance-Gründen cache-zuerst kommen - die ändern sich praktisch nie.
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
