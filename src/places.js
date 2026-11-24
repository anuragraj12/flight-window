// Place packs (built by pipeline/build_places.py) and choosing what to feature.
import { corridorTiles, project } from './geo.js';
import { icon } from './icons.js';

const BASE = '/places/v1';
const CACHE = 'fw-tiles-v1'; // same cache as map tiles: saved, cleared and served together
const Z = 7;

export const CAT = {
  historic: { icon: icon('historic', 16), label: 'Historic', color: '#E8B07A' },
  nature: { icon: icon('nature', 16), label: 'Nature', color: '#6FCF97' },
  water: { icon: icon('water', 16), label: 'Water', color: '#7CC4FF' },
  terrain: { icon: icon('terrain', 16), label: 'Terrain', color: '#C9A27A' },
  city: { icon: icon('city', 16), label: 'City', color: '#CDB9FF' },
  works: { icon: icon('works', 16), label: 'Engineering', color: '#B0B8C8' },
  battle: { icon: icon('battle', 16), label: 'Battlefield', color: '#F28B7A' },
};

// How far from the flight path each kind of place is still worth pointing out (km).
const REACH = { terrain: 110, water: 80, city: 70, nature: 70, historic: 45, works: 40, battle: 40 };
export const ROUTE_KM = 80; // "along your route" means within this distance
const FAR_KM = 300;          // big peaks are visible much further away

// From 11 km up, snow peaks stand out far beyond anything else on the ground.
export const peakReach = (el = 0) => (el >= 8000 ? 300 : el >= 7000 ? 250 : el >= 6000 ? 200 : el >= 5000 ? 150 : 0);
// Only single summits stand out from far away; a whole range or a pass does not.
const isPeak = (p) => (p.k === 'mountain' || p.k === 'volcano') && p.el >= 5000;
const reachOf = (p) => Math.max(REACH[p.c] || 50, isPeak(p) ? peakReach(p.el) : 0);

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
  const key = ([, x, y]) => `${x}-${y}`;
  const near = new Set(corridorTiles(path, [{ zmin: Z, zmax: Z, km: ROUTE_KM + 30 }], []).map(key));
  const far = corridorTiles(path, [{ zmin: Z, zmax: Z, km: FAR_KM + 30 }], []).map(key)
    .filter((k) => !near.has(k) && (index.tiles[k]?.peak || 0) >= 5000);
  const tiles = [...near, ...far].filter((k) => index.tiles[k]);
  const packs = await Promise.all(tiles.map((k) => getJSON(abs(`${BASE}/${Z}/${k}.json?v=${index.version}`)).catch(() => [])));
  const out = [];
  for (const p of packs.flat()) {
    const pr = project(path, p.p);
    if (pr.along < 0 || pr.along > path.total) continue;
    if (pr.d > ROUTE_KM && !(isPeak(p) && pr.d <= peakReach(p.el))) continue;
    out.push({ ...p, desc: p.d, along: pr.along, d: pr.d, side: pr.side }); // pack 'd' is the description; here d is distance
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
  const reach = reachOf(p) * (low ? 0.5 : 1);
  if (p.d > reach) return 0;
  let v = Math.max(0, 1 - (p.d / reach) ** 1.5);
  if (low && p.d < 20) v *= 1.3;
  const sideFit = p.d < 5 || !side ? 1 : p.side === side ? 1 : 0.5;
  const time = night ? NIGHT_FIT[p.c] ?? 0.3 : DAY_FIT[p.c] ?? 1;
  return p.s * v * sideFit * time * (p.img ? 1 : 0.8);
}

const SMALL = new Set(['monument', 'temple', 'mosque', 'church building', 'mausoleum', 'stupa', 'ruins', 'lighthouse', 'battle', 'archaeological site']);

// Famous enough to point out at all? Most towns and small temples are not.
export function isHighlight(p, { night = false, total = Infinity } = {}) {
  if (p.c === 'city') {
    if (p.along < 50 || total - p.along < 50) return false; // you are flying from or to it
    return p.s >= (night ? 65 : 78);
  }
  if (night) return p.c === 'water' ? p.s >= 55 : false;
  if (isPeak(p)) return p.d <= ROUTE_KM ? p.s >= 45 : p.el >= 6000 && p.s >= 70; // far away: only the famous giants
  if (SMALL.has(p.k) && !(p.area >= 1)) return p.s >= 85; // too small to see from 35,000 ft unless world-famous
  if (p.u) return true;
  if (p.k === 'river') return p.s >= 55;
  return p.s >= 45 && (p.img || p.s >= 60);
}

// Highlights you could see from each side (for choosing a seat).
export function sideHighlights(places, { night = false, total } = {}) {
  const n = { L: 0, R: 0 };
  for (const p of places) if (p.d >= 4 && p.d <= reachOf(p) && isHighlight(p, { night, total })) n[p.side]++;
  return n;
}

// At most `perHour` featured places, spread out: the best famous one in each time slot.
// A slot with nothing famous stays empty.
export function pickFeatured(places, { total, hours, side, night, perHour = 8, min = 15 }) {
  const slots = Math.max(1, Math.round(hours * perHour));
  const slotKm = total / slots;
  const best = new Array(slots).fill(null);
  for (const p of places) {
    if (!isHighlight(p, { night, total })) continue;
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

// "How to spot it from the air": by kind of place, so every sight gets one that holds true.
const FOREST = 'Look for a large patch of darker, unbroken forest with few fields, roads or villages.';
const RIDGES = 'Look for a band of wrinkled, darker ridges rising out of the flatter land around it.';
const COAST = 'Look for the coastline, where brown or green land meets blue water.';
const TINY = 'Too small to pick out from cruising height. Look for the town or hill it stands in instead.';
const TIPS = {
  'national park': FOREST, 'protected area': FOREST, 'nature reserve': FOREST, 'biosphere reserve': FOREST, forest: FOREST,
  river: 'Look for a wide, pale riverbed. Outside the monsoon it is mostly sand, with thin silver channels winding through it.',
  lake: 'Look for a flat patch darker than the land around it. It flashes bright if it catches the sun.',
  reservoir: 'Look for a big sheet of water with a ragged, branching shoreline where it has flooded valleys.',
  wetland: 'Look for a patchwork of shallow water and green marsh, often dotted with pools.',
  dam: 'Find the reservoir first, a big sheet of water, then the straight wall of the dam at its narrow end.',
  waterfall: 'Hard to see from cruising height. Look for the river dropping off the edge of a plateau.',
  mountain: 'Look for snow-capped summits standing above the haze on the horizon. Clear winter mornings give the best view.',
  'mountain range': RIDGES, hill: RIDGES, plateau: 'Look for a raised, flat-topped block of land with steep edges, often cut by rivers.',
  valley: 'Look for a long green trough between ridges, with a river and fields along its floor.',
  glacier: 'Look for grey-white rivers of ice filling the high valleys.',
  desert: 'Look for sandy, beige land with almost no fields or trees.',
  beach: COAST, bay: COAST, lagoon: 'Look for calm, shallow water cut off from the sea by a thin strip of land.', island: COAST,
  fort: 'Look for thick walls with a regular outline on a hilltop or riverbank. Easier during climb and descent.',
  castle: 'Look for thick walls with a regular outline. Easier during climb and descent.',
  palace: TINY, temple: TINY, mosque: TINY, 'church building': TINY, mausoleum: TINY, stupa: TINY, monument: TINY, ruins: TINY,
  'archaeological site': TINY, lighthouse: TINY,
  cave: 'The caves are hidden inside the rock. Look for the rocky hill or cliff they are cut into.',
  bridge: 'Look where the road or railway crosses the river: a thin straight line over the water.',
  canal: 'Look for an unnaturally straight line of water cutting through the fields.',
  port: 'Look for docks, cranes and ships along the shore.',
  airport: 'Look for long straight runways, usually the most geometric thing in sight.',
  'power station': 'Look for tall chimneys or cooling towers, sometimes with a plume of steam.',
  battle: 'Nothing of the battle is left to see. The ground is mostly farmland now.',
};

export function spotTip(p, night = false) {
  if (p.c === 'city') {
    return night
      ? 'Look for a bright orange glow, with lit highways leading out of it like spokes.'
      : 'Look for a grey sprawl of rooftops, with roads and railway lines running into it from all sides.';
  }
  if (night) return p.c === 'water' ? 'Hard to see at night unless the moon is out. Then it shows as a faint silver sheen.' : '';
  return TIPS[p.k] || '';
}
