// Flight story: a shareable 1080×1920 image of the flight, drawn entirely on the phone (works offline).
import { inPolys } from './features.js';

const W = 1080, H = 1920;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif';

export async function makeStory({ trip, route, events, geo, track, progress, pois }) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  // background: night sky with a few stars
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#04070f'); bg.addColorStop(0.55, '#0b1030'); bg.addColorStop(1, '#1a0f33');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    g.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`;
    g.beginPath(); g.arc(rnd() * W, rnd() * 520, rnd() * 1.8 + 0.3, 0, Math.PI * 2); g.fill();
  }

  const done = progress?.maxAlong || 0;
  const total = route.path.total;
  const flown = done > total * 0.3;
  const passed = flown ? events.filter((e) => e.start <= done + 5) : events;

  // header
  g.textAlign = 'left';
  g.fillStyle = '#8ea3c0'; g.font = `600 30px ${FONT}`;
  const head = [trip.airline, trip.carrier && trip.flight ? `${trip.carrier} ${trip.flight}` : '', trip.date ? new Date(trip.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : new Date().toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })].filter(Boolean).join('  ·  ');
  g.fillText(!flown ? 'MY FLIGHT AHEAD' : done < total - 20 ? 'MY FLIGHT SO FAR' : 'MY FLIGHT', 80, 130);
  g.fillStyle = '#c9d6ea'; g.font = `500 30px ${FONT}`;
  g.fillText(head, 80, 178);

  g.font = `800 150px ${FONT}`;
  const grad = g.createLinearGradient(80, 0, 1000, 0);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.55, '#ffd08a'); grad.addColorStop(1, '#4cc9f0');
  g.fillStyle = grad;
  g.fillText(route.from.code, 80, 350);
  g.textAlign = 'right'; g.fillText(route.to.code, W - 80, 350);
  g.textAlign = 'center'; g.font = `400 70px ${FONT}`; g.fillStyle = '#4cc9f0'; g.fillText('✈', W / 2, 330);
  g.font = `500 32px ${FONT}`; g.fillStyle = '#8ea3c0';
  g.textAlign = 'left'; g.fillText(route.from.city || '', 84, 405);
  g.textAlign = 'right'; g.fillText(route.to.city || '', W - 84, 405);

  // ---- map panel ----
  const box = { x: 60, y: 450, w: W - 120, h: 780 };
  g.save();
  roundRect(g, box.x, box.y, box.w, box.h, 40); g.clip();
  g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(box.x, box.y, box.w, box.h);
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [lon, lat] of route.path.pts) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
  const midLat = (s + n) / 2, k = Math.cos((midLat * Math.PI) / 180);
  let spanX = (e - w) * k, spanY = n - s;
  const minSpan = 3;
  if (spanX < minSpan) { const d = (minSpan - spanX) / 2 / k; w -= d; e += d; spanX = minSpan; }
  if (spanY < minSpan) { const d = (minSpan - spanY) / 2; s -= d; n += d; spanY = minSpan; }
  const scale = Math.min((box.w * 0.8) / spanX, (box.h * 0.82) / spanY);
  const cx = (w + e) / 2, cy = (s + n) / 2;
  const P = ([lon, lat]) => [box.x + box.w / 2 + (lon - cx) * k * scale, box.y + box.h / 2 - (lat - cy) * scale];
  const vw = cx - box.w / 2 / (k * scale), ve = cx + box.w / 2 / (k * scale), vs = cy - box.h / 2 / scale, vn = cy + box.h / 2 / scale;
  const inView = (b) => b[2] >= vw && b[0] <= ve && b[3] >= vs && b[1] <= vn;
  const shift = (lon) => lon + Math.round((cx - lon) / 360) * 360;

  // states (faint outlines)
  g.lineWidth = 1.5; g.strokeStyle = 'rgba(160,190,230,0.16)';
  for (const [type, , , b, geom] of geo) {
    if (type !== 's' || !inView(b)) continue;
    for (const poly of geom) { drawRing(g, poly[0], P, shift); g.stroke(); }
  }
  // parks crossed / nearby
  const names = new Set(passed.map((ev) => `${ev.type}:${ev.name}`));
  // rivers on route
  for (const [type, name, , b, geom] of geo) {
    if (type !== 'r' || !inView(b)) continue;
    const label = /river|nadi/i.test(name) ? name : `${name} River`;
    if (!names.has(`r:${label.normalize('NFD').replace(/[̀-ͯ]/g, '')}`)) continue;
    g.strokeStyle = 'rgba(76,201,240,0.85)'; g.lineWidth = 3.2; g.lineJoin = 'round';
    for (const line of geom) { g.beginPath(); line.forEach((pt, i) => { const [x, y] = P([shift(pt[0]), pt[1]]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); }
  }
  // tropic / equator lines
  for (const ev of passed.filter((x) => x.type === 't')) {
    const lat = { 'Tropic of Cancer': 23.4362, 'Tropic of Capricorn': -23.4362, Equator: 0, 'Arctic Circle': 66.5634 }[ev.name];
    const y = P([cx, lat])[1];
    g.setLineDash([14, 12]); g.strokeStyle = 'rgba(255,200,90,0.75)'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(box.x, y); g.lineTo(box.x + box.w, y); g.stroke(); g.setLineDash([]);
    g.fillStyle = '#ffd08a'; g.font = `600 24px ${FONT}`; g.textAlign = 'right'; g.fillText(ev.name.toUpperCase(), box.x + box.w - 24, y - 12);
  }
  // planned route (dashed) and flown track (glowing)
  g.setLineDash([10, 12]); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 3;
  g.beginPath(); route.path.pts.forEach((pt, i) => { const [x, y] = P(pt); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); g.setLineDash([]);
  if (track?.length > 1) {
    for (const [lw, col] of [[18, 'rgba(255,0,110,0.18)'], [9, 'rgba(255,0,110,0.35)'], [4, '#ff3d8b']]) {
      g.strokeStyle = col; g.lineWidth = lw; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); track.forEach((pt, i) => { const [x, y] = P([shift(pt[0]), pt[1]]); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
    }
  }
  // biggest cities along the way
  const taken = [route.from, route.to].map((ap) => { const [x, y] = P([ap.lon, ap.lat]); return [x - 30, y - 34, x + 150, y + 34]; });
  const hit = (b) => taken.some((t) => b[0] < t[2] && b[2] > t[0] && b[1] < t[3] && b[3] > t[1]);
  const top = [...(pois || [])].filter((p) => p.kind === 'c' && p.d < 120).sort((a, b) => b.val - a.val);
  g.font = `600 26px ${FONT}`; g.textAlign = 'left';
  let shown = 0;
  for (const p of top) {
    if (shown >= 7) break;
    const [x, y] = P([p.lon, p.lat]);
    const tw = g.measureText(p.name).width;
    const b = [x - 10, y - 20, x + 18 + tw, y + 16];
    if (hit(b)) continue;
    taken.push(b); shown++;
    g.fillStyle = p.side === 'L' ? '#ffb703' : '#4cc9f0';
    g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(234,242,255,0.9)'; g.fillText(p.name, x + 14, y + 9);
  }
  // airports
  for (const [ap, al] of [[route.from, 'left'], [route.to, 'left']]) {
    const [x, y] = P([ap.lon, ap.lat]);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ff006e'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = `800 34px ${FONT}`; g.textAlign = al; g.fillText(ap.code, x + 22, y + 12);
  }
  g.restore();

  // ---- stats ----
  const states = uniq(passed.filter((x) => x.type === 's').map((x) => x.name));
  const rivers = uniq(passed.filter((x) => x.type === 'r').map((x) => x.name.replace(/ River$/, '')));
  const parks = uniq(passed.filter((x) => x.type === 'p').map((x) => x.name));
  const ranges = uniq(passed.filter((x) => x.type === 'g').map((x) => x.name));
  const km = flown ? done : total;
  const mins = progress?.t0 && progress?.t1 && progress.t1 - progress.t0 > 20 * 60000 ? (progress.t1 - progress.t0) / 60000 : (km / 800) * 60 + 27 * Math.min(1, km / total);
  const stats = [
    [Math.round(km).toLocaleString(), flown ? 'km flown' : 'km to fly'],
    [`${Math.floor(mins / 60)}h ${String(Math.round(mins % 60)).padStart(2, '0')}m`, 'in the air'],
    [String(rivers.length), rivers.length === 1 ? 'river crossed' : 'rivers crossed'],
    [String(states.length), states.length === 1 ? 'state' : 'states'],
  ];
  const sy = 1270;
  const colX = [80, 330, 600, 850];
  stats.forEach(([v, l], i) => {
    const x = colX[i];
    g.textAlign = 'left'; g.fillStyle = '#fff'; g.font = `800 ${i === 1 ? 54 : 60}px ${FONT}`; g.fillText(v, x, sy + 60);
    g.fillStyle = '#8ea3c0'; g.font = `500 25px ${FONT}`; g.fillText(l, x, sy + 100);
  });

  // ---- highlights ----
  const lines = [];
  if (rivers.length) lines.push(['🌊', listText(rivers, 4)]);
  if (passed.some((x) => x.type === 't')) lines.push(['🌐', `Crossed the ${uniq(passed.filter((x) => x.type === 't').map((x) => x.name)).join(' and the ')}`]);
  if (parks.length) lines.push(['🌳', listText(parks, 2)]);
  if (ranges.length) lines.push(['⛰️', listText(ranges, 3)]);
  if (states.length) lines.push(['📍', listText(states, 5, ' → ')]);
  let y = 1450;
  for (const [ico, text] of lines.slice(0, 5)) {
    if (y > H - 170) break;
    g.textAlign = 'left'; g.font = `400 38px ${FONT}`; g.fillStyle = '#fff'; g.fillText(ico, 80, y + 2);
    g.font = `500 31px ${FONT}`; g.fillStyle = '#dbe6f5';
    y = wrap(g, text, 146, y, W - 226, 40, 2) + 62;
  }

  // footer
  g.textAlign = 'center'; g.fillStyle = 'rgba(234,242,255,0.55)'; g.font = `500 26px ${FONT}`;
  g.fillText(`Made with Flight Companion  ·  ${location.host}`, W / 2, H - 70);
  return c;
}

function drawRing(g, ring, P, shift) {
  g.beginPath();
  ring.forEach((pt, i) => { const [x, y] = P([shift(pt[0]), pt[1]]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.closePath();
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
const uniq = (a) => [...new Set(a)];
function listText(items, max, sep = ', ') {
  return items.length > max ? `${items.slice(0, max).join(sep)} +${items.length - max} more` : items.join(sep);
}
function wrap(g, text, x, y, maxW, lh, maxLines) {
  const words = text.split(' ');
  let line = '', lines = 0;
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y); y += lh; lines++; line = words[i];
      if (lines === maxLines - 1) { const rest = words.slice(i).join(' '); let r = rest; while (g.measureText(`${r}…`).width > maxW && r.length) r = r.slice(0, -1); g.fillText(r === rest ? r : `${r}…`, x, y); return y; }
    } else line = test;
  }
  g.fillText(line, x, y);
  return y;
}

export { inPolys };
