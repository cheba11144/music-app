// service-worker.js
//
// Что делает:
//  1) index.html и прочие файлы приложения — «сначала сеть, потом кэш»: после деплоя на Vercel
//     пользователь сразу получает свежую версию, а без интернета приложение открывается из кэша.
//  2) mp3 — сохраняются офлайн только после того, как трек послушали (index.html присылает
//     сообщение 'cache-track'), и отдаются из кэша с правильным ответом 206 (так нужно плееру,
//     особенно Safari/iOS). Не прослушанные и пропущенные треки в кэш не попадают.
//  3) Старые кэши удаляются при обновлении.

const SHELL = 'shell-v3';        // кэш самого приложения; при желании меняй имя — старый удалится сам
const AUDIO = 'audio-v1';        // кэш треков: имя НЕ меняй при обновлениях, иначе офлайн-треки пропадут
const MAX_TRACKS = 40;           // сколько треков хранить офлайн (самые старые удаляются первыми)

const loading = new Set();       // треки, которые сейчас докачиваются в кэш

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(['./', './index.html'])));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== AUDIO) await caches.delete(key);   // чистим старые версии кэша
    }
    await self.clients.claim();
  })());
});

// Сообщение от страницы: «трек послушали — сохрани его для офлайна»
self.addEventListener('message', event => {
  const d = event.data;
  if (d && d.type === 'cache-track' && typeof d.url === 'string') event.waitUntil(cacheTrack(d.url));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.toLowerCase().endsWith('.mp3')) {
    event.respondWith(audioResponse(req));
  } else {
    event.respondWith(networkFirst(req));
  }
});

// Файлы приложения: сначала сеть (свежая версия), нет сети — из кэша
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  // Все открытия страницы (в т.ч. с параметрами от Telegram) храним под одним ключом
  const key = req.mode === 'navigate' ? './index.html' : req;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(key)) || Response.error();
  }
}

// mp3: если трек уже в кэше — отдаём оттуда, иначе обычный запрос в сеть
async function audioResponse(req) {
  const cache = await caches.open(AUDIO);
  const hit = await cache.match(req.url);                 // ключ — чистый URL без заголовка Range
  if (!hit) return fetch(req);
  const range = req.headers.get('range');
  return range ? sliceResponse(hit, range) : hit;
}

// В кэше лежит файл целиком, а плеер просит кусок (Range) — отвечаем «206 Partial Content»
async function sliceResponse(res, range) {
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  const start = m[1] === '' ? Math.max(0, size - +m[2]) : +m[1];
  const end = (m[1] === '' || m[2] === '') ? size - 1 : Math.min(+m[2], size - 1);
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1
    }
  });
}

// Докачиваем трек целиком в кэш (запрос без Range — сервер отвечает 200, его можно сохранить)
async function cacheTrack(rawUrl) {
  try {
    const url = new URL(rawUrl, self.location.href);
    if (url.origin !== self.location.origin || !url.pathname.toLowerCase().endsWith('.mp3')) return;
    const key = url.href;
    if (loading.has(key)) return;
    const cache = await caches.open(AUDIO);
    if (await cache.match(key)) return;
    loading.add(key);
    try {
      await cache.add(key);
      await trim(cache);
    } finally {
      loading.delete(key);
    }
  } catch (e) { /* нет сети или места — не страшно, трек просто не сохранится */ }
}

// Оставляем не больше MAX_TRACKS треков: самые старые удаляем
async function trim(cache) {
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TRACKS)).map(k => cache.delete(k)));
}
