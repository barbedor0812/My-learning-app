// Bump this when core files change to avoid old-cache issues.
const CACHE_NAME = "cpa-study-assistant-pwa-v17";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./pdf.min.js",
  "./pdf.worker.min.js",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(ASSETS);
      self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : Promise.resolve())));
      self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const fresh = await fetch(req);
        // Cache same-origin assets
        if (new URL(req.url).origin === self.location.origin) cache.put(req, fresh.clone());
        return fresh;
      } catch {
        // Fallback to app shell
        return (await cache.match("./index.html")) || Response.error();
      }
    })(),
  );
});

