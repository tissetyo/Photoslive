const CACHE_VERSION = "photoslive-shell-v3";
const APP_SHELL = [
  "/booth.html",
  "/booth.css?v=2",
  "/booth.js?v=9",
  "/setup.html",
  "/platform.css?v=2",
  "/setup.css?v=15",
  "/setup.js?v=19",
  "/app.webmanifest",
  "/icons/camera.svg",
  "/icons/arrow-right.svg",
  "/icons/settings.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("photoslive-shell-") && key !== CACHE_VERSION).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function offlineNavigation(pathname) {
  if (pathname === "/setup") return "/setup.html";
  if (pathname === "/booth" || pathname === "/kiosk") return "/booth.html";
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && !["superadmin", "local-agent", "session"].includes(segments[0])) return "/booth.html";
  return null;
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      const fallback = offlineNavigation(url.pathname);
      return fallback ? caches.match(fallback) : Response.error();
    }));
    return;
  }

  event.respondWith(caches.match(request).then(cached => {
    const network = fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    });
    return cached || network;
  }));
});
