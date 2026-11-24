// Landscapes: which ecoregion the plane is over, and the sequence a route crosses.
// Data: public/data/eco.json, built by pipeline/build_landscapes.py from RESOLVE Ecoregions 2017.
import { inPolys } from './features.js';
import { pointAt } from './geo.js';

const polysOf = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

export function prepare(eco) {
  if (!eco || eco._ready) return eco;
  for (const f of eco.features) {
    f._polys = polysOf(f.geometry);
    let w = 180, s = 90, e = -180, n = -90;
    for (const poly of f._polys) for (const [x, y] of poly[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    f._bb = [w, s, e, n];
  }
  eco._ready = true;
  return eco;
}

export function ecoAt(eco, [x, y]) {
  if (!eco) return null;
  prepare(eco);
  for (const f of eco.features) {
    const [w, s, e, n] = f._bb;
    if (x < w || x > e || y < s || y > n) continue;
    if (inPolys([x, y], f._polys)) return f.properties;
  }
  return null;
}

// The landscapes a route crosses, in order, each with where it starts and ends (km along).
// Stretches under 30 km are folded into their neighbours, so the list stays short.
export function routeLandscapes(eco, path, step = 8) {
  if (!eco) return [];
  const runs = [];
  for (let a = 0; a <= path.total; a += step) {
    const p = ecoAt(eco, pointAt(path, a));
    const key = p ? p.name : null;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.end = a;
    else runs.push({ key, eco: p, start: a, end: a });
  }
  const kept = runs.filter((r) => r.key && r.end - r.start >= 30);
  const merged = [];
  for (const r of kept) {
    const last = merged[merged.length - 1];
    if (last && last.key === r.key) last.end = r.end;
    else merged.push({ ...r });
  }
  return merged.map((r) => ({ ...r.eco, start: r.start, end: Math.min(path.total, r.end + step) }));
}

// Plain-language biome names and what each looks like from the air.
const BIOMES = [
  [/moist broadleaf/i, 'Moist forest', 'Dense, dark green forest that stays green all year, thickest on hills where the rain falls first.'],
  [/dry broadleaf/i, 'Dry forest', 'Patchy forest that turns brown and bare in the dry months and bright green after the monsoon, broken up by fields.'],
  [/coniferous|conifer/i, 'Pine forest', 'Darker, blue-green pine forest on hill slopes, with terraced fields in the valleys.'],
  [/temperate broadleaf/i, 'Mountain forest', 'Steep forested slopes, with fields cut into terraces along the valleys.'],
  [/flooded/i, 'Wetland', 'Flat, wet land with pools and marsh that floods in the monsoon.'],
  [/montane grasslands/i, 'High grassland', 'High, treeless slopes and plateaus, brown in summer and white with snow in winter.'],
  [/grasslands|savanna|shrubland/i, 'Grassland and scrub', 'Open, dusty land with scattered trees and scrub, more brown than green for most of the year.'],
  [/desert|xeric/i, 'Desert', 'Sandy or stony beige land with very few fields, crossed by dry riverbeds.'],
  [/mangrove/i, 'Mangroves', 'Dark green coastal forest threaded with muddy, winding creeks.'],
  [/tundra|rock and ice/i, 'Rock and ice', 'Bare rock, snowfields and glaciers.'],
];
export function biomeInfo(biome = '') {
  const b = BIOMES.find(([re]) => re.test(biome));
  return b ? { short: b[1], tip: b[2] } : { short: 'Natural region', tip: '' };
}
