// The installed game's service worker (game.html registers it): the page's files kept in the browser's cache, so
// the game opens and plays without a network once they came. BUILD is the build's stamp (scripts/web/build_demo.sh's,
// game.html registers sw.js?v=BUILD): a new build is a new worker and a new cache, the old ones dropped once it takes
// over (game.html waits for it before asking for the game's files).
//   - assets/ (the game's files: the same for a build) from the cache first, kept as they come;
//   - the rest (game.html, battle.wasm, the scripts, the lists) from the network first, the cache when it fails.
const BUILD = new URL(self.location).searchParams.get("v") || "dev";
const CACHE = "princess-tale-" + BUILD;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith("princess-tale-") && k !== CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== self.location.origin) return;
  const asset = new URL(r.url).pathname.includes("/assets/") && !r.url.endsWith(".json");
  e.respondWith(asset ? cacheFirst(r) : networkFirst(r));
});

async function cacheFirst(r) {
  const c = await caches.open(CACHE);
  const hit = await c.match(r);
  if (hit) return hit;
  const res = await fetch(r);
  if (res.ok) c.put(r, res.clone());
  return res;
}

async function networkFirst(r) {
  const c = await caches.open(CACHE);
  try {
    const res = await fetch(r);
    if (res.ok) c.put(r, res.clone());
    return res;
  } catch (err) {
    const hit = await c.match(r, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}
