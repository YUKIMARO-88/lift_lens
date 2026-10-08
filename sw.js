/* Lift Lens service worker. App shell: network-first. Pose model / wasm from CDN: cache-first (large, versioned). */
var VERSION = "lift-lens-v1.1.0";
var SHELL = ["./", "index.html", "style.css", "app.js", "analyze.js", "gemini.js", "reps.js", "calc.js", "manifest.json",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];
var CDN = /^https:\/\/(cdn\.jsdelivr\.net\/npm\/@mediapipe|storage\.googleapis\.com\/mediapipe-models)\//;
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION && k !== "lift-lens-cdn"; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (CDN.test(req.url)) {
    e.respondWith(caches.open("lift-lens-cdn").then(function (c) {
      return c.match(req).then(function (hit) {
        return hit || fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; });
      });
    }));
    return;
  }
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(fetch(req).then(function (r) {
    var copy = r.clone();
    caches.open(VERSION).then(function (c) { c.put(req, copy); });
    return r;
  }).catch(function () { return caches.match(req, { ignoreSearch: true }); }));
});
