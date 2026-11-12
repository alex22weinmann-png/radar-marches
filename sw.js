// Radar Marchés : fonctionne hors connexion (interface en cache, données réseau d'abord).
const SHELL = "radar-shell-v1";
const DATA = "radar-data-v1";
const FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, DATA].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/data/")) {
    const key = url.origin + url.pathname;  // ignore le ?v= anti-cache
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(DATA).then(x => x.put(key, c)); } return r; })
      .catch(() => caches.match(key).then(r => r || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(SHELL).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
});
