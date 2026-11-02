// 앱 화면 파일을 저장해 두어 다시 열 때 빠르게 뜨게 함 (지도 타일과 데이터는 네트워크 우선)
const CACHE = "ujbk-v4";
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.json", "icon.svg", "mascot.svg"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
