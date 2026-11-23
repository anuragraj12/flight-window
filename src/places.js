// Place packs (built by pipeline/build_places.py) and choosing what to feature.
import { corridorTiles, project } from './geo.js';

const BASE = '/places/v1';
const CACHE = 'fw-tiles-v1'; // same cache as map tiles: saved, cleared and served together
const Z = 7;

export const CAT = {
  historic: { icon: '🏛️', label: 'Historic', color: '#f2b45a' },
  nature: { icon: '🌳', label: 'Nature', color: '#5fd38d' },
  water: { icon: '🌊', label: 'Water', color: '#5ab8f2' },
  terrain: { icon: '⛰️', label: 'Terrain', color: '#c9a27a' },
  city: { icon: '🏙️', label: 'City', color: '#e6e1ff' },
  works: { icon: '🌉', label: 'Engineering', color: '#b0b8c8' },
  battle: { icon: '⚔️', label: 'Battlefield', color: '#f27a6a' },
};

// How far from the flight path each kind of place is still worth pointing out (km).
const REACH = { terrain: 110, water: 80, city: 70, nature: 70, historic: 45, works: 40, battle: 40 };
export const ROUTE_KM = 80; // "along your route" means within this distance

const abs = (p) => new URL(p, location.origin).href;

async function getJSON(url, { fresh = false } = {}) {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit && !(fresh && navigator.onLine)) return hit.json();
  if (hit) { // online and asked for fresh: try the network, fall back to the saved copy
    try { return await fetchPut(url, cache); } catch { return (await cache.match(url)).json(); }
  }
  return fetchPut(url, cache);
}
async function fetchPut(url, cache) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.clone().text();
  cache?.put(url, new Response(body, { headers: { 'content-type': 'application/json' } })).catch(() => {});
  return JSON.parse(body);
}

let indexP;
const loadIndex = () => (indexP ??= getJSON(abs(`${BASE}/index.json`), { fresh: true }).catch((e) => { indexP = null; throw e; }));

// All places within ROUTE_KM of the path, with along-track position and side.
export async function routePlaces(path) {
  const index = await loadIndex();
  const tiles = corridorTiles(path, [{ zmin: Z, zmax: Z, km: ROUTE_KM + 30 }], [])
    .map(([, x, y]) => `${x}-${y}`)
    .filter((k) => index.tiles[k]);
  const packs = await Promise.all(tiles.map((k) => getJSON(abs(`${BASE}/${Z}/${k}.json?v=${index.version}`)).catch(() => [])));
  const out = [];
  for (const p of packs.flat()) {
    const pr = project(path, p.p);
    if (pr.d > ROUTE_KM || pr.along < 0) continue;
    out.push({ ...p, along: pr.along, d: pr.d, side: pr.side });
  }
  out.sort((a, b) => a.along - b.along);
  out.version = index.version;
  return out;
}

const NIGHT_FIT = { city: 1.25, water: 0.55, terrain: 0.2, nature: 0.15, historic: 0.15, works: 0.3, battle: 0.1 };
const DAY_FIT = { city: 0.85 };

// Featured score: notability x how visible from here x your window side x day or night.
export function featureScore(p, { side = '', night = false, total = 0 } = {}) {
  const low = p.along < 120 || total - p.along < 150; // climbing or descending: close to the ground
  const reach = (REACH[p.c] || 50) * (low ? 0.5 : 1);
  if (p.d > reach) return 0;
  let v = Math.max(0, 1 - (p.d / reach) ** 1.5);
  if (low && p.d < 20) v *= 1.3;
  const sideFit = p.d < 5 || !side ? 1 : p.side === side ? 1 : 0.5;
  const time = night ? NIGHT_FIT[p.c] ?? 0.3 : DAY_FIT[p.c] ?? 1;
  return p.s * v * sideFit * time * (p.img ? 1 : 0.8);
}

// About `perHour` featured places, spread evenly: the best one in each time slot.
export function pickFeatured(places, { total, hours, side, night, perHour = 10, min = 9 }) {
  const slots = Math.max(1, Math.round(hours * perHour));
  const slotKm = total / slots;
  const best = new Array(slots).fill(null);
  for (const p of places) {
    const f = featureScore(p, { side, night, total });
    if (f < min) continue;
    const i = Math.min(slots - 1, Math.floor(p.along / slotKm));
    if (!best[i] || f > best[i].f) best[i] = { p, f };
  }
  return best.filter(Boolean).map(({ p, f }) => ({ ...p, f }));
}

export function categoryCounts(places) {
  const c = {};
  for (const p of places) c[p.c] = (c[p.c] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]);
}

// Thumbnails worth saving for offline: every featured place by day and night, both sides, then the top of the rest.
export function imageUrls(places, opts, extra = 80) {
  const set = new Set();
  for (const night of [false, true]) for (const side of ['L', 'R']) {
    pickFeatured(places, { ...opts, night, side }).forEach((p) => p.img && set.add(p.img.u));
  }
  [...places].filter((p) => p.img).sort((a, b) => featureScore(b, opts) - featureScore(a, opts))
    .slice(0, extra).forEach((p) => set.add(p.img.u));
  return [...set];
}

// Give a river, park or range event the photo and summary of the matching place.
export function attachPlaces(events, places) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(river|national park|wildlife sanctuary|tiger reserve|lake|range|hills|plateau|the)\b/g, '').replace(/[^a-z]/g, '');
  const byName = new Map();
  for (const p of places) if (['water', 'nature', 'terrain'].includes(p.c)) {
    const k = norm(p.n);
    if (k.length > 2 && (!byName.has(k) || byName.get(k).s < p.s)) byName.set(k, p);
  }
  for (const e of events) {
    if (!['r', 'p', 'g', 'l', 'k'].includes(e.type)) continue;
    const p = byName.get(norm(e.name));
    if (p) e.place = p;
  }
  return events;
}
