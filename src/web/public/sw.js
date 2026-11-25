/*
 * オフラインでも読めるようにするためのサービスワーカー。
 * - アプリ本体（/assets・フォントなど）は一度読んだら端末に保存して使う
 * - 画面（HTML）とページの内容（API）は、まずネットから取り、つながらないときは保存しておいたものを使う
 * - ログアウトしたら、保存したものをすべて消す（画面から「clear」が届く）
 */
const STATIC = 'keepnote-static-v1';
const DATA = 'keepnote-data-v1';
const SHELL = '/__app_shell';
const MAX_DATA = 300;
const MAX_STATIC = 400;
/** これより大きいファイル（動画など）は端末に保存しない */
const MAX_BYTES = 15 * 1024 * 1024;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== STATIC && k !== DATA && k !== 'keepnote-share') await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'clear') e.waitUntil(Promise.all([caches.delete(DATA), caches.delete(SHARE)]));
});

/**
 * ほかのアプリからの「共有」を受け取り、端末に一時的に預けてから、保存の画面（/share-received）を開く。
 * 預けた内容は、保存の画面で新しいページにしたら消す。
 */
const SHARE = 'keepnote-share';
async function receiveShare(req) {
  try {
    const form = await req.formData();
    await caches.delete(SHARE);
    const cache = await caches.open(SHARE);
    const text = (v) => (typeof v === 'string' ? v : '');
    const meta = { title: text(form.get('title')), text: text(form.get('text')), url: text(form.get('url')), files: [] };
    let i = 0;
    for (const f of form.getAll('files')) {
      if (typeof f === 'string' || !f.size) continue;
      const key = `/__share/file-${i++}`;
      await cache.put(key, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
      meta.files.push({ key, name: f.name || `file-${i}`, type: f.type || '' });
    }
    await cache.put('/__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/share-received', 303);
  } catch {
    return Response.redirect('/share-received?retry=1', 303);
  }
}

/** オフラインで読むために保存する API（ページの中身・一覧・ログイン状態・画像など） */
function isReadableApi(url) {
  const p = url.pathname;
  if (!p.startsWith('/api/')) return false;
  if (p.startsWith('/api/admin') || p.includes('/collab') || p.includes('/presence') || p.startsWith('/api/public')) return false;
  return (
    p === '/api/auth/session' ||
    p === '/api/workspaces' ||
    p === '/api/pages' ||
    p === '/api/pages/templates' ||
    /^\/api\/pages\/[0-9a-f-]{36}(\/backlinks)?$/.test(p) ||
    /^\/api\/files\/[0-9a-f-]{36}$/.test(p)
  );
}

async function trim(cache, max) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** 保存してよい応答か（一部だけの応答や、大きすぎるものは保存しない） */
function storable(res) {
  if (res.status !== 200 || res.type !== 'basic') return false;
  const len = Number(res.headers.get('Content-Length') || 0);
  return !len || len <= MAX_BYTES;
}

async function save(cacheName, key, res, max) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, res);
    await trim(cache, max);
  } catch {
    // 保存できなくても、表示には影響させない
  }
}

async function networkFirst(e, cacheName, key, max) {
  try {
    const res = await fetch(e.request);
    if (storable(res)) e.waitUntil(save(cacheName, key ?? e.request, res.clone(), max));
    return res;
  } catch (err) {
    const hit = await caches.match(key ?? e.request, { cacheName });
    if (!hit) throw err;
    // 保存しておいたものを返したことを画面に知らせる（「オフラインです」の表示に使う）
    const headers = new Headers(hit.headers);
    headers.set('X-Offline-Cache', '1');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
  }
}

async function cacheFirst(e) {
  const hit = await caches.match(e.request, { cacheName: STATIC });
  if (hit) return hit;
  const res = await fetch(e.request);
  if (storable(res)) e.waitUntil(save(STATIC, e.request, res.clone(), MAX_STATIC));
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  // 動画などの一部だけの読み込みは、そのままネットに任せる
  if (req.headers.has('range')) return;
  // 画面の移動：ネットが使えないときは、保存しておいたアプリの画面を出す（ファイルなどを直接開いたときは除く）
  if (req.mode === 'navigate') {
    if (!url.pathname.startsWith('/api/')) e.respondWith(networkFirst(e, DATA, SHELL, MAX_DATA));
    return;
  }
  // 名前に版が入っているもの（/assets）は保存したものを使い、ほかは新しいものを優先する
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(cacheFirst(e));
    return;
  }
  if (url.pathname.startsWith('/fonts/') || url.pathname.startsWith('/pdfjs/') || url.pathname.startsWith('/icons/')) {
    e.respondWith(networkFirst(e, STATIC, undefined, MAX_STATIC));
    return;
  }
  if (isReadableApi(url)) e.respondWith(networkFirst(e, DATA, undefined, MAX_DATA));
});
