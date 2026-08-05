// Minimal service worker: exists to make the site installable and to keep it
// usable on a flaky counter wifi connection. It deliberately does NOT cache
// HTML the way it caches assets — nginx.conf's whole point is that a phone
// should see a freshly pushed page immediately, and a service worker cache is
// far stickier than an HTTP cache, so pages are network-first with a cache
// fallback only when the network actually fails.
const CACHE = "hn-shell-v1";
const SHELL = [
  "/",
  "/scan/",
  "/assets/app.css",
  "/assets/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const isPage = req.mode === "navigate" || req.destination === "document";
  if (isPage) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((res) => res || caches.match("/")))
    );
    return;
  }

  // Static assets: cache-first, refresh the cache in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
