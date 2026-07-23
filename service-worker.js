/* ============================================================
   Compteur Lisier — Service Worker
   Met en cache l'app pour un fonctionnement hors-ligne.
   Incrémentez CACHE_VERSION à chaque mise à jour des fichiers.
   ============================================================ */
var CACHE_VERSION = "lisier-v8";
var APP_SHELL = [
  ".",
  "index.html",
  "styles.css",
  "app.js",
  "vendor/jspdf.umd.min.js",
  "manifest.webmanifest",
  "icons/logo-murgat.svg",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon-32.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;

  // On ne gère que les GET de même origine (l'app). Tout le reste
  // (dont l'envoi POST vers Google Apps Script) passe directement au réseau.
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Navigation : réseau d'abord, repli sur le cache (index.html) hors-ligne.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match("index.html").then(function (r) { return r || caches.match("."); });
      })
    );
    return;
  }

  // Réseau d'abord (avec mise en cache), repli sur le cache hors-ligne.
  // Ainsi les appareils reçoivent TOUJOURS la dernière version quand il y a
  // du réseau — plus de blocage sur une version périmée en cache.
  event.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (cached) {
        return cached || caches.match("index.html");
      });
    })
  );
});
