// 画面の殻 (html / js / css / アイコン) を端末に覚えさせる。GAS への通信 (別のホスト) は覚えない。
// 殻は「先にサーバーへ取りに行き、つながらない時だけ覚えたものを出す」(ZBook の sw.js と同じ)。版は tools/build-mail-pwa.js が中身から作る。
var VERSION = 'mail-gas-95dcfd7d28';
var SHELL = ["./","app.js","app.css","pwa.css","pwa-shim.js","mail-gas.js","icon-180.png","icon-192.png","icon-192-green.png","icon-192-red.png","icon-512.png"];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/\/(manifest\.webmanifest|sw\.js)$/.test(url.pathname)) return;
  var key = req.mode === 'navigate' ? './' : req.url;   // ?tab=…&buyer=… が付いた開き方でも同じ殻を返す
  e.respondWith(caches.open(VERSION).then(function (c) {
    return fetch(req.mode === 'navigate' ? './' : req).then(function (r) {
      if (r && r.ok) c.put(key, r.clone());
      return r;
    }).catch(function () {
      return c.match(key).then(function (hit) { return hit || Promise.reject(new Error('offline')); });
    });
  }));
});
