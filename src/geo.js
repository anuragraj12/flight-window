// Geometry helpers. Points are [lon, lat]. Distances in km.
const R = 6371.0088;
export const rad = (d) => (d * Math.PI) / 180;
export const deg = (r) => (r * 180) / Math.PI;
export const lonDiff = (a, b) => ((((a - b + 540) % 360) + 360) % 360) - 180;

export function dist(a, b) {
  const p1 = rad(a[1]), p2 = rad(b[1]);
  const dp = p2 - p1, dl = rad(b[0] - a[0]);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a, b) {
  const p1 = rad(a[1]), p2 = rad(b[1]), dl = rad(b[0] - a[0]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Great-circle polyline, longitudes unwrapped so the line never jumps at the antimeridian.
export function greatCircle(a, b, stepKm = 10) {
  const d = dist(a, b) / R;
  const n = Math.max(2, Math.ceil((d * R) / stepKm));
  const p1 = rad(a[1]), l1 = rad(a[0]), p2 = rad(b[1]), l2 = rad(b[0]);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    if (d < 1e-9) { pts.push([a[0], a[1]]); continue; }
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
    const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
    const z = A * Math.sin(p1) + B * Math.sin(p2);
    pts.push([deg(Math.atan2(y, x)), deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  for (let i = 1; i < pts.length; i++) {
    while (pts[i][0] - pts[i - 1][0] > 180) pts[i][0] -= 360;
    while (pts[i][0] - pts[i - 1][0] < -180) pts[i][0] += 360;
  }
  return pts;
}

export function buildPath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  return { pts, cum, total: cum[cum.length - 1] };
}

export function pointAt(path, km) {
  const { pts, cum, total } = path;
  km = Math.max(0, Math.min(total, km));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < km) i++;
  const seg = cum[i + 1] - cum[i] || 1;
  const t = (km - cum[i]) / seg;
  const a = pts[i], b = pts[i + 1];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function headingAt(path, km) {
  const a = pointAt(path, km - 5), b = pointAt(path, km + 5);
  return bearing(a, b);
}

// Nearest point on the path: along-track km, distance km, side of travel ('L' or 'R').
export function project(path, p) {
  const { pts, cum } = path;
  let best = { d: Infinity, along: 0, side: 'L' };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const kx = 111.32 * Math.cos(rad(a[1])), ky = 110.574;
    const px = lonDiff(p[0], a[0]) * kx, py = (p[1] - a[1]) * ky;
    const bx = lonDiff(b[0], a[0]) * kx, by = (b[1] - a[1]) * ky;
    const L2 = bx * bx + by * by || 1e-9;
    const t = Math.max(0, Math.min(1, (px * bx + py * by) / L2));
    const dx = px - t * bx, dy = py - t * by;
    const d = Math.hypot(dx, dy);
    if (d < best.d) {
      const cross = bx * py - by * px; // > 0 → left of travel direction
      best = { d, along: cum[i] + t * (cum[i + 1] - cum[i]), side: cross > 0 ? 'L' : 'R' };
    }
  }
  return best;
}

// Which side of the aircraft a point is on, given current heading.
export function sideOf(pos, heading, p) {
  const rel = (bearing(pos, p) - heading + 360) % 360;
  return { side: rel < 180 ? 'R' : 'L', rel };
}

// ---- Web Mercator tile maths ----
const normLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
export const lon2x = (lon, z) => Math.floor(((normLon(lon) + 180) / 360) * 2 ** z);
export function lat2y(lat, z) {
  lat = Math.max(-85.0511, Math.min(85.0511, lat));
  const r = rad(lat);
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

function addBox(set, z, lon, lat, km) {
  const n = 2 ** z;
  const dLat = km / 110.574;
  const dLon = km / (111.32 * Math.max(0.05, Math.cos(rad(lat))));
  const xa = Math.floor(((normLon(lon) - dLon + 180) / 360) * n);
  const xb = Math.floor(((normLon(lon) + dLon + 180) / 360) * n);
  const ya = lat2y(lat + dLat, z), yb = lat2y(lat - dLat, z);
  for (let x = xa; x <= xb; x++) {
    const xx = ((x % n) + n) % n;
    for (let y = Math.max(0, ya); y <= Math.min(n - 1, yb); y++) set.add(`${z}/${xx}/${y}`);
  }
}

// plan: [{ zmin, zmax, km }] → tiles within `km` of the path for those zooms.
// spots: extra [lon, lat, km, zmax] areas (airports) cached in more detail.
export function corridorTiles(path, plan, spots = []) {
  const set = new Set();
  const step = 4;
  for (const { zmin, zmax, km } of plan) {
    for (let s = 0; s <= path.total + step; s += step) {
      const [lon, lat] = pointAt(path, s);
      for (let z = zmin; z <= zmax; z++) addBox(set, z, lon, lat, km);
    }
  }
  for (const [lon, lat, km, zmax] of spots) {
    for (let z = 0; z <= zmax; z++) addBox(set, z, lon, lat, km);
  }
  return [...set].map((k) => k.split('/').map(Number));
}
