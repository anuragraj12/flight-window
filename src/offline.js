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
    // Offline and not saved. A missing font range can be empty. A missing satellite /
    // terrain / night tile is cut out of a saved lower-zoom tile, so there are no holes.
    if (url.includes('/fonts/')) return { data: new ArrayBuffer(0) };
    const fallback = await fromParent(url, cache).catch(() => null);
    if (fallback) return { data: fallback };
    throw new Error(`Not available offline: ${url}`);
  });
}

// ---- parent-tile fallback for raster tiles ----
const RASTER_TEMPLATES = () => [SAT_URL, DEM_URL, NIGHT_URL].map((t) => {
  const order = [...t.matchAll(/\{([zxy])\}/g)].map((m) => m[1]);
  const re = new RegExp(`^${t.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[zxy]\\?\}/g, '(\\d+)')}$`);
  return { t, order, re, dem: t === DEM_URL, jpeg: t.endsWith('.jpg') };
});
let templates;
async function fromParent(url, cache) {
  templates ??= RASTER_TEMPLATES();
  const tpl = templates.find((x) => x.re.test(url));
  if (!tpl) return null;
  const nums = url.match(tpl.re).slice(1).map(Number);
  const c = {}; tpl.order.forEach((k, i) => { c[k] = nums[i]; });
  for (let k = 1; k <= 6 && c.z - k >= 0; k++) {
    const pz = c.z - k, px = c.x >> k, py = c.y >> k;
    const purl = tpl.t.replace('{z}', pz).replace('{x}', px).replace('{y}', py);
    const hit = await cache.match(purl, { ignoreVary: true });
    if (!hit) continue;
    const bmp = await createImageBitmap(await hit.blob());
    const size = bmp.width / 2 ** k;
    const sx = (c.x - (px << k)) * size, sy = (c.y - (py << k)) * size;
    const W = bmp.width;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, W) : Object.assign(document.createElement('canvas'), { width: W, height: W });
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = !tpl.dem; // never blend terrain heights
    ctx.drawImage(bmp, sx, sy, size, size, 0, 0, W, W);
    const type = tpl.jpeg ? 'image/jpeg' : 'image/png';
    const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type, quality: 0.85 }) : await new Promise((r) => canvas.toBlob(r, type, 0.85));
    return blob.arrayBuffer();
  }
  return null;
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

// ---- 3D Earth style: satellite imagery + terrain heights + night lights ----
export const SAT_URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg';
export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const NIGHT_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';
const DEM_MAX = 9;
const SAT_MAX = 14; // z13 along the route, z14 (~10 m/pixel, the imagery's full detail) around airports
// Extra-sharp satellite strip, downloaded after the flight is ready to use. From a window seat you
// look sideways, so only the band you can actually see is sharpened: ~5–55 km out on your side.
export function sharpPlan(side) {
  const band = (sign) => [
    { zmin: 12, zmax: 12, km: 25, offset: sign * 30 },
    { zmin: 13, zmax: 13, km: 9, offset: sign * 17 },
  ];
  if (side === 'L') return band(-1);
  if (side === 'R') return band(1);
  return [...band(-1), ...band(1)];
}
export const HI_PLAN = sharpPlan('');

export const SKY = {
  day: { 'sky-color': '#3f86d6', 'horizon-color': '#cfe2f6', 'fog-color': '#dbe6f2', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.55, 'atmosphere-blend': 0 },
  night: { 'sky-color': '#02040b', 'horizon-color': '#0c1830', 'fog-color': '#060c1a', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.5, 'fog-ground-blend': 0.6, 'atmosphere-blend': 0 },
};

// Night city lights drawn from the map data: glowing roads, warm towns, black water.
export const NIGHT_LAYERS = ['n-water', 'n-urban', 'n-glow', 'n-road-minor', 'n-road-mid', 'n-road-major-glow', 'n-road-major'];
function nightLightLayers(source = 'omt', suffix = '', minzoom = 0) {
  const v = { source, minzoom, layout: { visibility: 'none' } };
  const cls = (list) => ['in', ['get', 'class'], ['literal', list]];
  const w = (a, b, c) => ['interpolate', ['exponential', 1.6], ['zoom'], 6, a, 10, b, 14, c];
  return [
    { id: `n-water${suffix}`, type: 'fill', ...v, 'source-layer': 'water', paint: { 'fill-color': '#000000', 'fill-opacity': 0.9 } },
    { id: `n-urban${suffix}`, type: 'fill', ...v, 'source-layer': 'landuse', filter: cls(['residential', 'commercial', 'industrial', 'retail']), paint: { 'fill-color': '#4a2f0c', 'fill-opacity': 0.55 } },
    {
      id: `n-glow${suffix}`, type: 'circle', ...v, 'source-layer': 'place', filter: cls(['city', 'town']),
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'class'], 'city', 9, 3], 10, ['match', ['get', 'class'], 'city', 70, 22]],
        'circle-color': '#ffb457', 'circle-blur': 1, 'circle-opacity': 0.4, 'circle-pitch-alignment': 'map',
      },
    },
    { id: `n-road-minor${suffix}`, type: 'line', ...v, 'source-layer': 'transportation', filter: cls(['tertiary', 'minor', 'service']), paint: { 'line-color': '#ffe9b8', 'line-width': w(0.15, 0.5, 1.6), 'line-opacity': 0.6, 'line-blur': 0.4 } },
    { id: `n-road-mid${suffix}`, type: 'line', ...v, 'source-layer': 'transportation', filter: cls(['primary', 'secondary']), paint: { 'line-color': '#ffc56e', 'line-width': w(0.3, 1.1, 3), 'line-opacity': 0.9, 'line-blur': 0.6 } },
    { id: `n-road-major-glow${suffix}`, type: 'line', ...v, 'source-layer': 'transportation', filter: cls(['motorway', 'trunk']), paint: { 'line-color': '#ff8a2a', 'line-width': w(1.5, 5, 12), 'line-opacity': 0.55, 'line-blur': 4 } },
    { id: `n-road-major${suffix}`, type: 'line', ...v, 'source-layer': 'transportation', filter: cls(['motorway', 'trunk']), paint: { 'line-color': '#ffd79a', 'line-width': w(0.4, 1.3, 3), 'line-opacity': 1 } },
    ...(suffix ? [{ id: `n-bld${suffix}`, type: 'fill', ...v, 'source-layer': 'building', paint: { 'fill-color': '#ffcf87', 'fill-opacity': 0.22 } }] : []),
  ];
}

// Box ±km around a point, for extra street detail near airports (take-off and landing).
export function areaAround(lon, lat, km = 16) {
  const dLat = km / 110.574, dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export function buildEarthStyle(base, hiAreas = []) {
  const vec = base && Object.values(base.sources || {}).find((s) => s.type === 'vector' && s.tiles);
  const hiSources = {}, hiLayers = [];
  if (vec) hiAreas.forEach((b, i) => {
    const id = `omt-hi-${i}`;
    hiSources[id] = { type: 'vector', tiles: vec.tiles, minzoom: 12, maxzoom: 13, bounds: b };
    hiLayers.push(...nightLightLayers(id, `-hi${i}`, 11.5));
  });
  return {
    version: 8,
    name: 'earth',
    glyphs: base?.glyphs,
    sources: {
      sat: { type: 'raster', tiles: [toProto(SAT_URL)], tileSize: 256, maxzoom: SAT_MAX, attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)' },
      dem: { type: 'raster-dem', tiles: [toProto(DEM_URL)], tileSize: 256, encoding: 'terrarium', maxzoom: DEM_MAX, attribution: 'Terrain: Mapzen / AWS Terrain Tiles' },
      night: { type: 'raster', tiles: [toProto(NIGHT_URL)], tileSize: 256, maxzoom: 8, attribution: 'Night lights: NASA Black Marble' },
      ...(vec ? { omt: { type: 'vector', tiles: vec.tiles, minzoom: vec.minzoom ?? 0, maxzoom: vec.maxzoom ?? MAX_Z, attribution: vec.attribution } } : {}),
      ...hiSources,
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#56604a' } },
      { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 0, 'raster-contrast': 0.12, 'raster-saturation': 0.12 } },
      { id: 'night', type: 'raster', source: 'night', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0, 'raster-opacity': 0.55 } },
      ...(vec ? nightLightLayers() : []),
      ...hiLayers,
    ],
    terrain: { source: 'dem', exaggeration: 1.6 },
    sky: SKY.day,
  };
}

function tileInBounds(z, x, y, [w, s, e, n]) {
  const k = 2 ** z;
  const tw = (x / k) * 360 - 180, te = ((x + 1) / k) * 360 - 180;
  const lat = (t) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / k))) * 180) / Math.PI;
  const tn = lat(y), ts = lat(y + 1);
  return te >= w && tw <= e && tn >= s && ts <= n;
}

// Average bytes per tile, used only for the size estimate shown before saving.
const AVG = { vector: 45e3, raster: 25e3, 'raster-dem': 70e3 };

export function buildUrlList(style, path, spots, tiles = corridorTiles(path, PLAN, spots), { skipVector = false } = {}) {
  const urls = [];
  let estBytes = 0;
  for (const src of Object.values(style.sources)) {
    if (!src.tiles || (skipVector && src.type === 'vector')) continue;
    const tpl = fromProto(src.tiles[0]);
    const minz = src.minzoom ?? 0;
    const maxz = src.maxzoom ?? MAX_Z;
    const avg = src.tiles[0].includes('Black_Marble') ? 10e3 : AVG[src.type] ?? 30e3;
    const bb = src.bounds;
    for (const [z, x, y] of tiles) {
      if (z < minz || z > maxz) continue;
      if (bb && !tileInBounds(z, x, y, bb)) continue;
      urls.push(tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y));
      estBytes += avg;
    }
  }
  const tileCount = urls.length;
  if (style.glyphs && !skipVector) {
    const g = fromProto(style.glyphs);
    for (const fs of fontStacks(style))
      for (const r of GLYPH_RANGES) urls.push(g.replace('{fontstack}', fs.join(',')).replace('{range}', `${r}-${r + 255}`));
  }
  const sprites = typeof style.sprite === 'string' ? [style.sprite] : (style.sprite || []).map((s) => s.url);
  for (const s of sprites) {
    const b = fromProto(s);
    urls.push(`${b}.json`, `${b}.png`, `${b}@2x.json`, `${b}@2x.png`);
  }
  return { urls: urls.map(canon), tileCount, estBytes };
}

// Many small files from far-away servers: speed comes from keeping lots of requests in flight,
// spread across all hosts at once, and touching each file only once.
export async function prefetch(urls, onProgress, { signal, concurrency = 24 } = {}) {
  const cache = await openTiles();
  const have = new Set((await cache.keys()).map((r) => r.url));
  const total = urls.length;
  let done = 0, bytes = 0;
  const failedUrls = [];
  // round-robin by host so no single server (or its connection limit) holds everything up
  const byHost = new Map();
  for (const u of urls) {
    if (have.has(u)) { done++; continue; }
    const h = new URL(u).host;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h).push(u);
  }
  const queues = [...byHost.values()];
  const queue = [];
  for (let i = 0; queues.some((q) => i < q.length); i++) for (const q of queues) if (i < q.length) queue.push(q[i]);
  onProgress?.({ done, total, bytes, failed: 0 });
  let next = 0;
  async function worker() {
    while (next < queue.length) {
      if (signal?.aborted) return;
      const u = queue[next++];
      try {
        let res;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { res = await fetch(u, { mode: 'cors', signal }); break; }
          catch (e) { if (e.name === 'AbortError') return; if (attempt === 2) throw e; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); }
        }
        if (res.ok) {
          const blob = await res.blob();
          bytes += blob.size;
          await cache.put(u, new Response(blob, { headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' } }));
        } else if (res.status !== 404 && res.status !== 204) failedUrls.push(u);
      } catch {
        failedUrls.push(u);
      }
      done++;
      onProgress?.({ done, total, bytes, failed: failedUrls.length });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  return { done, bytes, failed: failedUrls.length, failedUrls };
}

// URLs from the list that are not saved yet.
export async function missingUrls(urls) {
  const cache = await openTiles();
  const have = new Set((await cache.keys()).map((r) => r.url));
  return urls.filter((u) => !have.has(u));
}

export const openTileCache = () => openTiles();

export async function clearAll() {
  await caches.delete(TILE_CACHE);
  tileCache = undefined;
}
