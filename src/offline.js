// Offline map support: rewrites the OpenFreeMap style to a custom protocol whose
// handler serves everything (tiles, fonts, sprites) from Cache Storage first.
import * as maplibregl from 'maplibre-gl';
import { corridorTiles } from './geo.js';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const MAX_Z = 11; // deepest zoom we download; the map overzooms beyond this
const TILE_CACHE = 'fw-tiles-v1';
const DATA_CACHE = 'fw-data-v1';
const PROTO = 'fwc';

const toProto = (u) => u.replace(/^https:\/\//, `${PROTO}://`);
const fromProto = (u) => u.replace(new RegExp(`^${PROTO}://`), 'https://');
const canon = (u) => new URL(u).href;

// Corridor plan: how far either side of the route to save, per zoom band.
export const PLAN = [
  { zmin: 0, zmax: 5, km: 600 },
  { zmin: 6, zmax: 8, km: 260 },
  { zmin: 9, zmax: 9, km: 160 },
  { zmin: 10, zmax: 10, km: 80 },
  { zmin: 11, zmax: 11, km: 25 },
];
const GLYPH_RANGES = Array.from({ length: 34 }, (_, i) => i * 256); // Latin, Cyrillic, Greek, Indic, punctuation…

let tileCache;
const openTiles = () => (tileCache ??= caches.open(TILE_CACHE));

function decode(buf, type) {
  if (type === 'json') return JSON.parse(new TextDecoder().decode(buf));
  if (type === 'string') return new TextDecoder().decode(buf);
  return buf;
}

export function registerProtocol() {
  maplibregl.addProtocol(PROTO, async (params, ac) => {
    const url = canon(fromProto(params.url));
    const cache = await openTiles();
    const hit = await cache.match(url, { ignoreVary: true });
    if (hit) return { data: decode(await hit.arrayBuffer(), params.type) };
    try {
      const res = await fetch(url, { signal: ac.signal, mode: 'cors' });
      if (res.ok) {
        cache.put(url, res.clone()).catch(() => {});
        return { data: decode(await res.arrayBuffer(), params.type) };
      }
    } catch (e) {
      if (e.name === 'AbortError') throw e;
    }
    // Offline and not saved. A missing font range can be empty; a missing map tile must
    // fail so MapLibre keeps drawing the lower-zoom tile it already has for that area.
    if (url.includes('/fonts/')) return { data: new ArrayBuffer(0) };
    throw new Error(`Not available offline: ${url}`);
  });
}

async function fetchJSON(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Fetch the online style and inline every source so no further JSON lookups are needed.
export async function buildStyle() {
  const style = await fetchJSON(STYLE_URL);
  for (const src of Object.values(style.sources)) {
    if (src.url && src.url.startsWith('https://')) {
      const tj = await fetchJSON(src.url);
      src.tiles = tj.tiles;
      src.minzoom ??= tj.minzoom;
      src.maxzoom ??= tj.maxzoom;
      if (!src.attribution && tj.attribution) src.attribution = tj.attribution;
      delete src.url;
    }
    if (src.tiles) {
      src.tiles = src.tiles.map(toProto);
      if (src.type === 'vector') src.maxzoom = Math.min(src.maxzoom ?? 14, MAX_Z);
    }
  }
  if (style.glyphs) style.glyphs = toProto(style.glyphs);
  if (typeof style.sprite === 'string') style.sprite = toProto(style.sprite);
  else if (Array.isArray(style.sprite)) style.sprite = style.sprite.map((s) => ({ ...s, url: toProto(s.url) }));
  return style;
}

const styleKey = (id) => `/__fw/style-${id}.json`;

export async function saveStyle(id, style) {
  const c = await caches.open(DATA_CACHE);
  await c.put(styleKey(id), new Response(JSON.stringify(style), { headers: { 'content-type': 'application/json' } }));
}

export async function loadSavedStyle(id) {
  const c = await caches.open(DATA_CACHE);
  const r = await c.match(styleKey(id));
  return r ? r.json() : null;
}

// Fresh style when online, else the most recent one we saved.
export async function getStyle() {
  try {
    const s = await buildStyle();
    saveStyle('latest', s).catch(() => {});
    return s;
  } catch {
    const s = await loadSavedStyle('latest');
    if (s) return s;
    throw new Error('The map needs an internet connection the first time.');
  }
}

export function fontStacks(style) {
  const out = new Map();
  for (const l of style.layers || []) {
    let f = l.layout?.['text-font'];
    if (Array.isArray(f) && f[0] === 'literal') f = f[1];
    if (Array.isArray(f) && f.every((s) => typeof s === 'string')) out.set(f.join(','), f);
  }
  if (!out.size) out.set('Noto Sans Regular', ['Noto Sans Regular']);
  return [...out.values()];
}

export function buildUrlList(style, path, spots) {
  const tiles = corridorTiles(path, PLAN, spots);
  const urls = [];
  for (const src of Object.values(style.sources)) {
    if (!src.tiles) continue;
    const tpl = fromProto(src.tiles[0]);
    const minz = src.minzoom ?? 0;
    const maxz = Math.min(src.maxzoom ?? 22, MAX_Z);
    for (const [z, x, y] of tiles) {
      if (z < minz || z > maxz) continue;
      urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  const tileCount = urls.length;
  if (style.glyphs) {
    const g = fromProto(style.glyphs);
    for (const fs of fontStacks(style))
      for (const r of GLYPH_RANGES) urls.push(g.replace('{fontstack}', fs.join(',')).replace('{range}', `${r}-${r + 255}`));
  }
  const sprites = typeof style.sprite === 'string' ? [style.sprite] : (style.sprite || []).map((s) => s.url);
  for (const s of sprites) {
    const b = fromProto(s);
    urls.push(`${b}.json`, `${b}.png`, `${b}@2x.json`, `${b}@2x.png`);
  }
  return { urls: urls.map(canon), tileCount };
}

export async function prefetch(urls, onProgress, signal) {
  const cache = await openTiles();
  let next = 0, done = 0, bytes = 0, failed = 0;
  async function worker() {
    while (next < urls.length) {
      if (signal?.aborted) return;
      const u = urls[next++];
      try {
        const hit = await cache.match(u, { ignoreVary: true });
        if (!hit) {
          let res;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { res = await fetch(u, { mode: 'cors', signal }); break; }
            catch (e) { if (e.name === 'AbortError') return; if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 600)); }
          }
          if (res.ok) {
            const buf = await res.clone().arrayBuffer();
            bytes += buf.byteLength;
            await cache.put(u, res);
          } else if (res.status !== 404 && res.status !== 204) failed++;
        }
      } catch {
        failed++;
      }
      done++;
      onProgress?.({ done, total: urls.length, bytes, failed });
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  return { done, bytes, failed };
}

export async function clearAll() {
  await caches.delete(TILE_CACHE);
  tileCache = undefined;
}
