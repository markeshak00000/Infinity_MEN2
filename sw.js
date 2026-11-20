const CACHE_NAME = "infinity-men2-shell-v2";
const CORE_ASSETS = ["./", "./index.html", "./app.js", "./native-features.bundle.js", "./pwa.js", "./config.js", "./manifest.webmanifest", "./assets/logo.png", "./assets/icon-192.png", "./assets/icon-512.png", "./assets/icon-maskable-512.png", "./assets/favicon-32.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)); return response;
    }).catch(() => caches.match("./index.html")));
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)); }
    return response;
  })));
});
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { payload = { body: event.data ? event.data.text() : "لديك إشعار جديد." }; }
  const title = payload.title || "Infinity MEN2";
  const options = { body: payload.body || "لديك تحديث جديد.", icon: "./assets/icon-192.png", badge: "./assets/icon-192.png", dir: "rtl", lang: "ar", tag: payload.tag || "infinity-men2-push", data: { url: payload.url || "./index.html" }, renotify: false };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || "./index.html", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) { if (client.url.startsWith(self.location.origin) && "focus" in client) { client.navigate(target); return client.focus(); } }
    return self.clients.openWindow(target);
  }));
});
