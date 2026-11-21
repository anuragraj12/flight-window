// What you fly over: rivers, lakes, national parks & reserves, mountain ranges & plateaus,
// states, and lines like the Tropic of Cancer. Builds a timeline of events along the route.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { dist, project, lonDiff } from './geo.js';

// Feature record: [type, name, extra, bbox [w,s,e,n], geometry]
//  r = river (lines), l = lake (polygons), g = region e.g. range/plateau (polygons),
//  s = state/province (polygons), p = park/reserve (polygons), k = peak ([lon,lat], extra = elevation)

// ---------- OSM parks / reserves / rivers / peaks from tiles already saved for this flight ----------
const PARK_WORDS = /national park|tiger reserve|biosphere|wildlife|sanctuary|reserve|forest|park/i;

export async function extractTileFeatures(tileUrls, cache) {
  const parks = new Map(), rivers = new Map(), peaks = new Map();
  for (const url of tileUrls) {
    const m = url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!m) continue;
    const [z, x, y] = m.slice(1).map(Number);
    const res = await cache.match(url, { ignoreVary: true });
    if (!res) continue;
    let tile;
    try { tile = new VectorTile(new PbfReader(new Uint8Array(await res.arrayBuffer()))); } catch { continue; }
    const park = tile.layers.park;
    for (let i = 0; park && i < park.length; i++) {
      const f = park.feature(i);
      const name = f.properties['name:en'] || f.properties.name_en || f.properties.name;
      if (!name || f.type !== 3) continue;
      const cls = f.properties.class || '';
      if (!PARK_WORDS.test(`${name} ${cls}`) && !/national_park|nature_reserve|protected_area/.test(cls)) continue;
      const g = f.toGeoJSON(x, y, z).geometry;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const e = parks.get(name) || { cls, polys: [] };
      for (const p of polys) e.polys.push(p.map(thinRing));
      parks.set(name, e);
    }
    const ww = tile.layers.waterway;
    for (let i = 0; ww && i < ww.length; i++) {
      const f = ww.feature(i);
      const name = f.properties['name:en'] || f.properties.name_en || f.properties.name;
      if (!name || f.properties.class !== 'river' || f.type !== 2) continue;
      const g = f.toGeoJSON(x, y, z).geometry;
      const lines = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const e = rivers.get(name) || [];
      for (const l of lines) e.push(thinRing(l));
      rivers.set(name, e);
    }
    const pk = tile.layers.mountain_peak;
    for (let i = 0; pk && i < pk.length; i++) {
      const f = pk.feature(i);
      const name = f.properties['name:en'] || f.properties.name_en || f.properties.name;
      if (!name || peaks.has(name)) continue;
      const c = f.toGeoJSON(x, y, z).geometry.coordinates;
      peaks.set(name, [round(c[0]), round(c[1]), +f.properties.ele || 0]);
    }
  }
  const out = [];
  for (const [name, e] of parks) out.push(['p', name, prettyClass(name, e.cls), bboxOf(e.polys), e.polys]);
  for (const [name, lines] of rivers) out.push(['r', name, 5, bboxOf(lines), lines]);
  for (const [name, [lon, lat, ele]] of peaks) out.push(['k', name, ele, [lon, lat, lon, lat], [lon, lat]]);
  return out;
}

const round = (v) => Math.round(v * 1e4) / 1e4;
function thinRing(r) {
  const step = Math.max(1, Math.floor(r.length / 120));
  const out = [];
  for (let i = 0; i < r.length; i += step) out.push([round(r[i][0]), round(r[i][1])]);
  const last = r[r.length - 1];
  if (out[out.length - 1][0] !== round(last[0]) || out[out.length - 1][1] !== round(last[1])) out.push([round(last[0]), round(last[1])]);
  return out;
}
function prettyClass(name, cls) {
  if (/tiger reserve/i.test(name)) return 'Tiger reserve';
  if (/biosphere/i.test(name)) return 'Biosphere reserve';
  if (/national park/i.test(name) || cls === 'national_park') return 'National park';
  if (/sanctuary/i.test(name)) return 'Wildlife sanctuary';
  if (/forest/i.test(name)) return 'Forest';
  return 'Protected area';
}
function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  (function walk(c) {
    if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); } else c.forEach(walk);
  })(geom);
  return [w, s, e, n];
}

// ---------- geometry helpers ----------
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}
export function inPolys(pt, polys) {
  for (const poly of polys) {
    if (!inRing(pt, poly[0])) continue;
    let hole = false;
    for (let h = 1; h < poly.length; h++) if (inRing(pt, poly[h])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}
function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + t * r[0], a[1] + t * r[1]] : null;
}
const normName = (n) => n.toLowerCase().replace(/\b(river|nadi|lake|the)\b/g, '').replace(/[^a-z]/g, '');

// Bring a feature's longitudes next to the (possibly unwrapped) route.
function shiftFor(bbox, routeMidLon) {
  const mid = (bbox[0] + bbox[2]) / 2;
  return Math.round((routeMidLon - mid) / 360) * 360;
}
const shiftGeom = (g, dx) => (dx ? JSON.parse(JSON.stringify(g), (k, v) => (Array.isArray(v) && typeof v[0] === 'number' && v.length === 2 ? [v[0] + dx, v[1]] : v)) : g);

// ---------- timeline ----------
const LINES = [
  { lat: 66.5634, name: 'Arctic Circle' },
  { lat: 23.4362, name: 'Tropic of Cancer' },
  { lat: 0, name: 'Equator' },
  { lat: -23.4362, name: 'Tropic of Capricorn' },
];

export function buildEvents(path, feats) {
  const pts = path.pts;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of pts) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  const pad = 0.6, mid = (w + e) / 2;
  const step = 2;
  const samples = [];
  for (let a = 0, i = 0; a <= path.total; a += step) {
    while (i < path.cum.length - 2 && path.cum[i + 1] < a) i++;
    const t = (a - path.cum[i]) / (path.cum[i + 1] - path.cum[i] || 1);
    samples.push({ a, p: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t] });
  }
  const events = [];
  const seenRiver = new Map();
  for (const [type, name, extra, bbox0, geom0] of feats) {
    const dx = shiftFor(bbox0, mid);
    const bbox = [bbox0[0] + dx, bbox0[1], bbox0[2] + dx, bbox0[3]];
    const near = type === 'p' || type === 'g' || type === 'l' ? 0.4 : 0;
    if (bbox[2] < w - pad - near || bbox[0] > e + pad + near || bbox[3] < s - pad - near || bbox[1] > n + pad + near) continue;
    const geom = shiftGeom(geom0, dx);
    if (type === 'g' && extra === 'Peninsula') continue;
    if (type === 'r') {
      if (extra > 9) continue;
      const key = normName(name);
      for (const line of geom) {
        for (let j = 0; j < line.length - 1; j++) {
          const a = line[j], b = line[j + 1];
          if (Math.max(a[0], b[0]) < w - 0.1 || Math.min(a[0], b[0]) > e + 0.1 || Math.max(a[1], b[1]) < s - 0.1 || Math.min(a[1], b[1]) > n + 0.1) continue;
          for (let i = 0; i < pts.length - 1; i++) {
            const x = segIntersect(pts[i], pts[i + 1], a, b);
            if (!x) continue;
            const along = project(path, x).along;
            const prev = seenRiver.get(key) || [];
            if (prev.some((p) => Math.abs(p - along) < 8)) continue;
            prev.push(along); seenRiver.set(key, prev);
            events.push({ type: 'r', name: prettyRiver(name), start: along, end: along, kind: 'cross', point: x });
          }
        }
      }
    } else if (type === 'k') {
      const pr = project(path, geom);
      if (pr.d < 45) events.push({ type: 'k', name, extra, start: pr.along, end: pr.along, kind: 'near', side: pr.side, d: pr.d, point: geom });
    } else {
      // polygon: where does the route enter / leave it?
      let inside = false, enter = 0;
      const spans = [];
      for (const { a, p } of samples) {
        const now = inPolys(p, geom);
        if (now && !inside) { inside = true; enter = a; }
        if (!now && inside) { inside = false; spans.push([enter, a]); }
      }
      if (inside) spans.push([enter, path.total]);
      if (type === 's') {
        // ignore brief dips across a border: merge gaps under 30 km, drop slivers under 15 km
        for (let i = spans.length - 1; i > 0; i--) if (spans[i][0] - spans[i - 1][1] < 30) { spans[i - 1][1] = spans[i][1]; spans.splice(i, 1); }
        for (let i = spans.length - 1; i >= 0; i--) if (spans[i][1] - spans[i][0] < 15 && spans[i][0] > 0 && spans[i][1] < path.total) spans.splice(i, 1);
      }
      if (spans.length) {
        for (const [a, b] of spans) {
          if (b - a < (type === 's' ? 1 : 3)) continue;
          events.push({ type, name, extra, start: a, end: b, kind: 'over' });
        }
      } else if (type === 'p' || type === 'l') {
        // close by but not crossed: nearest approach
        let best = { d: Infinity };
        for (const poly of geom) for (const pt of poly[0]) {
          const pr = project(path, pt);
          if (pr.d < best.d) best = { ...pr, pt };
        }
        if (best.d < 35) events.push({ type, name, extra, start: best.along, end: best.along, kind: 'near', side: best.side, d: best.d, point: best.pt });
      }
    }
  }
  // latitude lines
  for (const L of LINES) {
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i], b = samples[i + 1];
      if ((a.p[1] - L.lat) * (b.p[1] - L.lat) <= 0 && a.p[1] !== b.p[1]) {
        const t = (L.lat - a.p[1]) / (b.p[1] - a.p[1]);
        events.push({ type: 't', name: L.name, start: a.a + t * step, end: a.a + t * step, kind: 'cross' });
      }
    }
  }
  // drop the states you take off from / land in from "entering" alerts, keep them as context
  for (const ev of events) if (ev.type === 's' && ev.start < 1) ev.origin = true;
  return events.sort((x, y) => x.start - y.start);
}

const plain = (n) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const prettyRiver = (n) => { n = plain(n); return /river|nadi|creek|canal/i.test(n) ? n : `${n} River`; };

export const ICON = { r: '🌊', l: '💧', g: '⛰️', s: '📍', p: '🌳', k: '🏔️', t: '🌐' };

export function eventTitle(ev) {
  switch (ev.type) {
    case 'r': return `Crossing the ${ev.name}`;
    case 't': return `Crossing the ${ev.name}`;
    case 's': return ev.origin ? `Over ${ev.name}` : `Entering ${ev.name}`;
    case 'p': return ev.kind === 'over' ? `Over ${ev.name}` : `${ev.name}`;
    case 'g': return `Over the ${ev.name.replace(/^the /i, '')}`;
    case 'l': return ev.kind === 'over' ? `Over ${ev.name}` : ev.name;
    case 'k': return `${ev.name}${ev.extra ? ` (${Math.round(ev.extra).toLocaleString()} m)` : ''}`;
    default: return ev.name;
  }
}

export function eventSub(ev) {
  if (ev.type === 'p') return ev.extra || 'Protected area';
  if (ev.type === 'g') return ev.extra === 'Range/mtn' ? 'Mountain range' : ev.extra;
  if (ev.type === 's') return ev.extra || 'State';
  if (ev.type === 'l') return 'Lake';
  if (ev.type === 'k') return 'Peak';
  if (ev.type === 't') return 'Latitude line';
  return 'River';
}

export function summary(events) {
  const c = { r: 0, p: 0, g: 0, s: 0, l: 0, t: 0 };
  const seen = new Set();
  for (const ev of events) {
    const k = `${ev.type}:${ev.name}`;
    if (seen.has(k) || !(ev.type in c)) continue;
    if (ev.type === 's' && ev.origin) { seen.add(k); c.s++; continue; }
    seen.add(k); c[ev.type]++;
  }
  return c;
}

// map overlay data for the parks / rivers / lakes on this route
export function overlayData(feats, events) {
  const names = new Set(events.map((e) => `${e.type}:${e.name}`));
  const fs = [];
  for (const [type, name, extra, , geom] of feats) {
    const label = type === 'r' ? prettyRiver(name) : name;
    if (!names.has(`${type}:${label}`) && !names.has(`${type}:${name}`)) continue;
    if (type === 'r') fs.push({ type: 'Feature', properties: { kind: 'r', name: label }, geometry: { type: 'MultiLineString', coordinates: geom } });
    else if (type === 'p' || type === 'l') fs.push({ type: 'Feature', properties: { kind: type, name }, geometry: { type: 'MultiPolygon', coordinates: geom } });
  }
  return { type: 'FeatureCollection', features: fs };
}

export { dist, lonDiff };
