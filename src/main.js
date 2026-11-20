import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { registerSW } from 'virtual:pwa-register';
import { dist, bearing, greatCircle, buildPath, pointAt, headingAt, project, sideOf, corridorTiles, destination, angDiff } from './geo.js';
import {
  registerProtocol, getStyle, buildStyle, buildEarthStyle, saveStyle, loadSavedStyle,
  buildUrlList, prefetch, clearAll, fontStacks, MAX_Z, PLAN, HI_PLAN, SKY, NIGHT_LAYERS,
} from './offline.js';
import { readTicket, seatInfo } from './boarding.js';

maplibregl.setWorkerUrl(workerUrl);
registerSW({ immediate: true });
registerProtocol();
navigator.storage?.persist?.().catch(() => {});

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = (km) => `${Math.round(km).toLocaleString()} km`;
const fmtDur = (h) => { const m = Math.round(h * 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const fmtMB = (b) => `${Math.max(1, Math.round(b / 1048576))} MB`;
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const sideWord = (s) => (s === 'L' ? 'left' : 'right');
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cardinal = (b) => CARD[Math.round((((b % 360) + 360) % 360) / 45) % 8];
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const hourNow = new Date().getHours();

const state = {
  airports: null, places: null, airlines: null, trips: loadTrips(),
  map: null, route: null, trip: null, live: null,
  watchId: null, simTimer: null, simAlong: 0, follow: true,
  view: 'map', look: 'side', tilt: 76, night: hourNow >= 18 || hourNow < 6,
  vectorStyle: null, earthStyle: null, styleName: null,
  wake: null, marker: null, track: [], installEvt: null, ticket: null,
  dockOpen: false, frame: true, simSpeed: 1, simRunning: false,
};

function loadTrips() { try { return JSON.parse(localStorage.getItem('fw-trips') || '[]'); } catch { return []; } }
function saveTrips() { localStorage.setItem('fw-trips', JSON.stringify(state.trips)); }
const ap = (a) => ({ code: a[0], name: a[1], city: a[2], country: a[3], lat: a[4], lon: a[5], large: a[6] });
const airportByCode = (c) => { const a = state.airports?.find((x) => x[0] === c); return a ? ap(a) : null; };

async function loadJSON(u) { return (await fetch(u)).json(); }
async function loadAirports() { state.airports ??= await loadJSON('/data/airports.json'); return state.airports; }
async function loadPlaces() { state.places ??= await loadJSON('/data/places.json'); return state.places; }
async function loadAirlines() { state.airlines ??= await loadJSON('/data/airlines.json'); return state.airlines; }

function searchAirports(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const res = [];
  for (const a of state.airports || []) {
    const code = a[0].toLowerCase(), city = (a[2] || '').toLowerCase(), name = a[1].toLowerCase();
    let s = 0;
    if (code === q) s = 100;
    else if (code.startsWith(q)) s = 60;
    else if (city.startsWith(q)) s = 50;
    else if (name.startsWith(q)) s = 45;
    else if (city.includes(q)) s = 30;
    else if (name.includes(q)) s = 20;
    if (s) res.push([s + (a[6] ? 10 : 0), a]);
  }
  return res.sort((x, y) => y[0] - x[0]).slice(0, 8).map((r) => ap(r[1]));
}

// ---------- route + points of interest ----------
async function makeRoute(from, to) {
  const path = buildPath(greatCircle([from.lon, from.lat], [to.lon, to.lat], 10));
  const pois = await poisFor(path);
  return { from, to, path, pois, sides: sideScore(pois) };
}

async function poisFor(path) {
  const places = await loadPlaces();
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of path.pts) {
    minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
  }
  const pad = 2.5;
  const out = [];
  for (const [kind, name, ctry, lat, lon0, val] of places) {
    if (lat < minLat - pad || lat > maxLat + pad) continue;
    let lon = lon0;
    if (lon < minLon - pad) lon += 360; else if (lon > maxLon + pad) lon -= 360;
    if (lon < minLon - pad || lon > maxLon + pad) continue;
    const pr = project(path, [lon, lat]);
    if (pr.d > (kind === 'c' ? 150 : 200)) continue;
    out.push({ kind, name, ctry, lat, lon, val, along: pr.along, d: pr.d, side: pr.side });
  }
  const cities = out.filter((o) => o.kind === 'c').sort((a, b) => b.val - a.val).slice(0, 260);
  const other = out.filter((o) => o.kind !== 'c').slice(0, 80);
  const maxPop = Math.max(10, ...cities.map((c) => c.val));
  const all = [...cities, ...other].sort((a, b) => a.along - b.along);
  for (const o of all) {
    o.rank = o.kind === 'c' ? Math.log10(o.val + 10) / Math.log10(maxPop + 10) : 0.55;
    o.label = placeLabel(o);
  }
  return all;
}
const placeLabel = (o) => (o.kind === 'm' && o.val ? `${o.name} (${o.val.toLocaleString()} m)` : o.name);

function sideScore(pois) {
  const s = { L: 0, R: 0, nL: 0, nR: 0 };
  for (const p of pois) {
    if (p.d > 100) continue;
    s[p.side] += p.kind === 'c' ? Math.max(0.5, Math.log10(p.val + 10) - 3) : 2;
    s[`n${p.side}`]++;
  }
  return s;
}
const flightHours = (km) => km / 800 + 0.45;

// ---------- map ----------
const blankStyle = () => ({ version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0b1424' } }] });

async function initMap() {
  let style = null;
  try { style = await getStyle(); } catch { /* offline with nothing saved yet */ }
  state.vectorStyle = style;
  state.map = new maplibregl.Map({
    container: 'map',
    style: style || blankStyle(),
    center: [78.5, 21], zoom: 3.3, minZoom: 1.5, maxZoom: 14, maxPitch: 85,
    attributionControl: false,
    fadeDuration: 0,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });
  state.styleName = 'vector';
  // tap the map during a flight to hide / show all controls
  state.map.on('click', () => { if (document.body.classList.contains('flying')) document.body.classList.toggle('ui-off'); });
  state.map.on('style.load', addOverlays);
  // small always-visible credits line, built from the current style's sources
  state.map.on('styledata', updateCredits);
  state.map.on('error', (e) => { if (!/Not available offline/.test(e?.error?.message || '')) console.warn(e?.error || e); });
  state.map.on('dragstart', () => { if (state.live && state.follow && state.view !== 'window') setFollow(false); });
  document.addEventListener('click', (e) => { if (document.body.classList.contains('ui-off') && e.target.closest('#cabin, .tap-hint')) document.body.classList.remove('ui-off'); });
  await new Promise((r) => state.map.once('load', r));
}

function updateCredits() {
  let el = document.getElementById('credits');
  if (!el) { el = document.createElement('div'); el.id = 'credits'; document.body.appendChild(el); }
  const st = state.map.getStyle();
  const parts = new Set();
  for (const src of Object.values(st?.sources || {})) {
    const a = (src.attribution || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (a) a.split(/\s*[|·]\s*|\s(?=©)/).forEach((x) => x && parts.add(x));
  }
  el.textContent = [...parts].join(' · ');
}

function setMapStyle(style, name) {
  if (!style || state.styleName === name) return Promise.resolve();
  state.styleName = name;
  return new Promise((resolve) => {
    state.map.once('style.load', () => resolve());
    state.map.setStyle(style, { diff: false });
  });
}

function labelFont() {
  const stacks = fontStacks(state.vectorStyle || state.map.getStyle());
  return stacks.find((s) => s.some((f) => /bold/i.test(f))) || stacks[0];
}

function addOverlays() {
  const m = state.map;
  const earth = state.styleName === 'earth';
  for (const id of ['route', 'pois', 'track']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: emptyFC() });
  const add = (layer) => { if (!m.getLayer(layer.id)) m.addLayer(layer); };
  add({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#4cc9f0', 'line-width': 9, 'line-opacity': earth ? 0.22 : 0.3, 'line-blur': 4 } });
  add({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': earth ? '#9be7ff' : '#0a5f86', 'line-width': 2.2, 'line-dasharray': [2, 1.5], 'line-opacity': earth ? 0.8 : 1 } });
  add({ id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff006e', 'line-width': 3.5 } });
  add({
    id: 'poi-dot', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'c', ['interpolate', ['linear'], ['get', 'rank'], 0, 3, 1, 7], 4.5],
      'circle-color': ['match', ['get', 'side'], 'L', '#ffb703', '#4cc9f0'],
      'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5,
      'circle-pitch-alignment': 'map',
    },
  });
  if (m.getStyle().glyphs) {
    add({
      id: 'poi-label', type: 'symbol', source: 'pois',
      layout: {
        'text-field': ['get', 'label'], 'text-font': labelFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, earth ? 12 : 11, 9, 15],
        'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true,
        'symbol-sort-key': ['-', 1, ['get', 'rank']],
      },
      paint: earth
        ? { 'text-color': '#ffffff', 'text-halo-color': 'rgba(5,10,20,0.85)', 'text-halo-width': 1.6 }
        : { 'text-color': '#0b1220', 'text-halo-color': ['match', ['get', 'side'], 'L', '#ffe7a0', '#cdf2ff'], 'text-halo-width': 2 },
    });
  }
  if (earth) applyNight();
  refreshOverlayData();
}

function refreshOverlayData() {
  const m = state.map;
  if (!m?.getSource('route')) return;
  const r = state.route;
  m.getSource('route').setData(r ? { type: 'Feature', geometry: { type: 'LineString', coordinates: r.path.pts } } : emptyFC());
  m.getSource('pois').setData({
    type: 'FeatureCollection',
    features: (r?.pois || []).map((p) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { label: p.label, kind: p.kind, side: p.side, rank: p.rank },
    })),
  });
  m.getSource('track').setData(state.track.length > 1 ? { type: 'Feature', geometry: { type: 'LineString', coordinates: state.track } } : emptyFC());
}

function fitRoute(bottom = 320, pitch = 0) {
  const r = state.route;
  if (!r) return;
  const b = new maplibregl.LngLatBounds();
  r.path.pts.forEach((p) => b.extend(p));
  state.map.fitBounds(b, { padding: { top: 120, bottom: Math.min(bottom, innerHeight * 0.55), left: 40, right: 40 }, duration: 700, maxZoom: 8, pitch, bearing: 0 });
}

function applyNight() {
  document.body.classList.toggle('dim', state.night && state.styleName === 'vector' && !!state.route);
  const m = state.map;
  if (state.styleName !== 'earth' || !m.getLayer('sat')) return;
  const vis = state.night ? 'visible' : 'none';
  m.setLayoutProperty('night', 'visibility', vis);
  for (const id of NIGHT_LAYERS) if (m.getLayer(id)) m.setLayoutProperty(id, 'visibility', vis);
  m.setPaintProperty('sat', 'raster-brightness-max', state.night ? 0.07 : 1);
  m.setPaintProperty('sat', 'raster-saturation', state.night ? -0.7 : 0.12);
  m.setPaintProperty('sat', 'raster-contrast', state.night ? 0 : 0.12);
  m.setSky(state.night ? SKY.night : SKY.day);
  m.setPaintProperty('bg', 'background-color', state.night ? '#000000' : '#56604a');
  if (m.getLayer('poi-label')) {
    m.setPaintProperty('poi-label', 'text-color', state.night ? '#ffe8c2' : '#ffffff');
  }
}

// ---------- screens ----------
function banner() {
  if (isIOS && !isStandalone()) {
    return `<div class="note warn"><b>iPhone tip:</b> tap <b>Share → Add to Home Screen</b>, open Flight Window from your home screen, and save your flight <i>there</i>. Safari and the home-screen app keep separate offline storage.</div>`;
  }
  return '';
}

function ticketLine(t) {
  const bits = [];
  if (t.carrier && t.flight) bits.push(`${t.carrier} ${t.flight}`);
  if (t.seat) bits.push(`Seat ${t.seat}`);
  if (t.date) bits.push(fmtDate(t.date));
  return bits.join(' · ');
}

function renderHome() {
  stopLive();
  state.route = null; state.trip = null; state.track = [];
  document.body.classList.remove('dim');
  if (state.vectorStyle) setMapStyle(state.vectorStyle, 'vector');
  refreshOverlayData();
  state.map?.easeTo({ center: [78.5, 21], zoom: 3.3, bearing: 0, pitch: 0, duration: 600 });
  const online = navigator.onLine;
  const trips = state.trips.map((t) => `
    <div class="trip">
      <div class="trip-main" data-action="open" data-id="${esc(t.id)}">
        <div class="trip-codes">${esc(t.from.code)} <span>→</span> ${esc(t.to.code)}</div>
        <div class="trip-sub">${esc(t.airline || '')}${t.airline ? ' · ' : ''}${esc(ticketLine(t) || `${t.from.city} to ${t.to.city}`)}</div>
        <div class="trip-sub ok">✓ Saved offline${t.bytes ? ` · ${fmtMB(t.bytes)}` : ''}${t.earth ? ' · 3D view' : ''}</div>
      </div>
      <button class="ghost small" data-action="delete" data-id="${esc(t.id)}" aria-label="Delete">✕</button>
    </div>`).join('');
  app.innerHTML = `
    <div class="sheet glass home">
      <div class="brand"><span class="logo">✈︎</span><div><h1>Flight Window</h1><p>Know what's below your window, even in flight mode.</p></div></div>
      ${banner()}
      ${state.installEvt ? `<button class="wide" data-action="install">Install app</button>` : ''}
      ${trips ? `<div class="list-title">Your flights</div><div class="trips">${trips}</div>` : ''}
      <label class="scan ${online ? '' : 'disabled'}">
        <input type="file" id="ticket-file" accept="image/*,application/pdf" ${online ? '' : 'disabled'} hidden>
        <span class="scan-icon">▣</span>
        <span><b>Scan boarding pass</b><small>Photo, screenshot or PDF. Finds your flight, route and seat side.</small></span>
      </label>
      <button class="wide" data-action="new" ${online ? '' : 'disabled'}>Enter route manually</button>
      ${online ? '<div class="note tiny">🔒 Your boarding pass is read on this phone and never uploaded.</div>' : '<div class="note">You are offline. Saving a new flight needs internet.</div>'}
      <div class="foot"><span id="storage"></span>${state.trips.length ? `<button class="link" data-action="clear">Clear all offline maps</button>` : ''}</div>
    </div>`;
  $('#ticket-file')?.addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) importTicket(f); });
  navigator.storage?.estimate?.().then((e) => { const el = $('#storage'); if (el && e.usage) el.textContent = `Storage used: ${fmtMB(e.usage)}`; });
}

async function importTicket(file) {
  app.innerHTML = `<button class="back glass" data-action="home" aria-label="Back">‹</button>
    <div class="sheet glass"><h2>Reading your boarding pass…</h2><div class="bar"><div class="indet"></div></div><div class="note">Looking for the barcode. This happens on your phone.</div></div>`;
  try {
    const [airports, airlines] = await Promise.all([loadAirports(), loadAirlines()]);
    const t = await readTicket(file, airports, airlines);
    const from = airportByCode(t.from), to = airportByCode(t.to);
    if (!from || !to) throw new Error(`Found ${t.from} → ${t.to}, but one of those airports isn't in the app's list.`);
    state.ticket = { ...t, from, to };
    renderTicket();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<button class="back glass" data-action="home" aria-label="Back">‹</button>
      <div class="sheet glass"><h2>Couldn't read it</h2><div class="note warn">${esc(e.message)}</div>
      <label class="scan"><input type="file" id="ticket-file" accept="image/*,application/pdf" hidden><span class="scan-icon">▣</span><span><b>Try another image</b><small>A screenshot of the boarding pass from the airline app works best.</small></span></label>
      <button class="wide" data-action="new">Enter route manually</button></div>`;
    $('#ticket-file')?.addEventListener('change', (ev) => { const f = ev.target.files?.[0]; if (f) importTicket(f); });
  }
}

function seatHtml(seat) {
  const si = seatInfo(seat);
  if (!si) return '';
  if (si.side === 'C') return `<span class="seat-pill">Seat ${esc(seat)} · centre section</span>`;
  return `<span class="seat-pill ${si.side}">Seat ${esc(seat)} · ${sideWord(si.side)} ${si.kind === 'window' ? 'window' : si.kind}</span>`;
}

function renderTicket() {
  const t = state.ticket;
  app.innerHTML = `<button class="back glass" data-action="home" aria-label="Back">‹</button>
    <div class="sheet glass ticket">
      <div class="pass">
        <div class="pass-top"><span>${esc(t.airline || 'Flight')}</span><span>${esc(t.carrier || '')} ${esc(t.flight || '')}</span></div>
        <div class="pass-route">
          <div><b>${esc(t.from.code)}</b><small>${esc(t.from.city)}</small></div>
          <div class="pass-plane">✈︎</div>
          <div><b>${esc(t.to.code)}</b><small>${esc(t.to.city)}</small></div>
        </div>
        <div class="pass-meta">
          <div><span>Date</span><b>${esc(fmtDate(t.date) || '—')}</b></div>
          <div><span>Seat</span><b>${esc(t.seat || '—')}</b></div>
          <div><span>PNR</span><b>${esc(t.pnr || '—')}</b></div>
        </div>
      </div>
      ${t.seat ? `<div class="center">${seatHtml(t.seat)}</div>` : '<div class="note">No seat on this pass yet. You can add it on the next screen.</div>'}
      <div class="note tiny">Read from the ${t.source === 'barcode' ? 'boarding pass barcode' : 'ticket text'}${t.legs > 1 ? ` (showing leg 1 of ${t.legs})` : ''}.</div>
      <button class="primary wide" data-action="ticket-ok">Looks right, continue</button>
      <button class="wide ghost" data-action="new">Edit manually</button>
    </div>`;
}

function renderPlan(pre = {}) {
  state.route = null; refreshOverlayData();
  app.innerHTML = `
    <button class="back glass" data-action="home" aria-label="Back">‹</button>
    <div class="sheet glass plan">
      <h2>${pre.flight ? `${esc(pre.carrier)} ${esc(pre.flight)}` : 'Save a flight'}</h2>
      <div class="field"><label>From</label><input id="from" placeholder="Airport code or city, e.g. DEL" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-from"></div></div>
      <div class="field"><label>To</label><input id="to" placeholder="e.g. BLR" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-to"></div></div>
      <div class="row2">
        <div class="field"><label>Seat (optional)</label><input id="seat" placeholder="e.g. 14A" autocomplete="off" autocapitalize="characters" maxlength="4" value="${esc(pre.seat || '')}"></div>
        <div class="field"><label>Flight (optional)</label><input id="flightno" placeholder="e.g. QP1812" autocomplete="off" autocapitalize="characters" value="${esc(pre.carrier && pre.flight ? pre.carrier + pre.flight : '')}"></div>
      </div>
      <div id="plan-info"></div>
    </div>`;
  const picked = { from: pre.from || null, to: pre.to || null };
  const meta = { ...pre };
  if (picked.from) $('#from').value = `${picked.from.code} · ${picked.from.city}`;
  if (picked.to) $('#to').value = `${picked.to.code} · ${picked.to.city}`;
  const go = () => { if (picked.from && picked.to) preview(picked.from, picked.to, meta); };
  for (const key of ['from', 'to']) {
    const input = $(`#${key}`), dd = $(`#dd-${key}`);
    input.addEventListener('input', () => {
      picked[key] = null;
      const res = searchAirports(input.value);
      dd.innerHTML = res.map((a, i) => `<div class="opt" data-i="${i}"><b>${esc(a.code)}</b> ${esc(a.city)}<small>${esc(a.name)} · ${esc(a.country)}</small></div>`).join('');
      dd.onclick = (e) => {
        const o = e.target.closest('.opt'); if (!o) return;
        const a = res[+o.dataset.i];
        picked[key] = a; input.value = `${a.code} · ${a.city}`; dd.innerHTML = '';
        if (key === 'from' && !picked.to) $('#to').focus(); else input.blur();
        go();
      };
    });
  }
  $('#seat').addEventListener('input', (e) => { meta.seat = e.target.value.trim().toUpperCase(); go(); });
  $('#flightno').addEventListener('input', (e) => {
    const m = e.target.value.trim().toUpperCase().match(/^([A-Z0-9]{2})\s?(\d{1,4})$/);
    if (m) { meta.carrier = m[1]; meta.flight = m[2]; meta.airline = state.airlines?.[m[1]] || meta.airline; }
  });
  loadAirlines().catch(() => {});
  if (picked.from && picked.to) go(); else setTimeout(() => $('#from')?.focus(), 50);
}

let previewSeq = 0;
async function preview(from, to, meta) {
  const info = $('#plan-info');
  if (from.code === to.code) { info.innerHTML = `<div class="note warn">Pick two different airports.</div>`; return; }
  const seq = ++previewSeq;
  if (!state.route || state.route.from !== from || state.route.to !== to) {
    info.innerHTML = `<div class="note">Plotting route…</div>`;
    const route = await makeRoute(from, to);
    if (seq !== previewSeq) return;
    state.route = route; refreshOverlayData(); fitRoute(460);
  }
  const route = state.route;
  const s = route.sides;
  const best = Math.abs(s.L - s.R) < 1.5 ? null : s.L > s.R ? 'L' : 'R';
  const si = seatInfo(meta.seat);
  const spots = [[from.lon, from.lat, 25, MAX_Z], [to.lon, to.lat, 25, MAX_Z]];
  const hiSpots = spots.map(([x, y]) => [x, y, 15, 13]);
  const tiles = corridorTiles(route.path, [...PLAN, ...HI_PLAN], [...spots, ...hiSpots]);
  const vec = state.vectorStyle ? buildUrlList(state.vectorStyle, route.path, spots, tiles) : { estBytes: 0 };
  const earth = buildUrlList(buildEarthStyle(state.vectorStyle), route.path, spots, tiles, { skipVector: true });
  let seatMsg;
  if (si && si.side !== 'C') {
    const mine = si.side === 'L' ? s.nL : s.nR;
    const good = !best || best === si.side;
    seatMsg = `<div class="note ${good ? 'ok' : 'warn'}">Seat ${esc(meta.seat)} is on the <b>${sideWord(si.side)}</b>${si.kind === 'window' ? ' window' : ''}: about ${mine} places on your side.${good ? '' : ` The ${sideWord(best)} side has more. Ask to switch if you can.`}</div>`;
  } else {
    seatMsg = `<p class="hint">${best ? `For the best view, sit on the <b>${sideWord(best)}</b> side (facing forward).` : 'Both sides have about the same to see.'} Based on the direct route; the real path can differ.</p>`;
  }
  info.innerHTML = `
    <div class="stats">
      <div><b>${fmtKm(route.path.total)}</b><span>direct distance</span></div>
      <div><b>~${fmtDur(flightHours(route.path.total))}</b><span>flight time</span></div>
      <div><b>${route.pois.length}</b><span>places on the way</span></div>
    </div>
    <div class="seat">
      <div class="seat-side L ${best === 'L' ? 'best' : ''} ${si?.side === 'L' ? 'mine' : ''}"><b>Left side</b><span>${s.nL} places${si?.side === 'L' ? ' · you' : ''}</span></div>
      <div class="seat-side R ${best === 'R' ? 'best' : ''} ${si?.side === 'R' ? 'mine' : ''}"><b>Right side</b><span>${s.nR} places${si?.side === 'R' ? ' · you' : ''}</span></div>
    </div>
    ${seatMsg}
    <label class="check"><input type="checkbox" id="opt-earth" checked><span><b>3D satellite & window view</b><small>Sharp satellite ground, terrain and glowing night city lights · +${fmtMB(earth.estBytes)}</small></span></label>
    <button class="primary wide" id="btn-save">Save for offline · ~<span id="size">${fmtMB(vec.estBytes + earth.estBytes)}</span></button>
    <div id="save-progress"></div>`;
  $('#opt-earth').onchange = (e) => { $('#size').textContent = fmtMB(vec.estBytes + (e.target.checked ? earth.estBytes : 0)); };
  $('#btn-save').onclick = () => saveTrip(route, meta, $('#opt-earth').checked);
}

async function saveTrip(route, meta, withEarth) {
  const btn = $('#btn-save'), box = $('#save-progress');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await navigator.serviceWorker?.ready;
    const style = await buildStyle();
    const spots = [[route.from.lon, route.from.lat, 25, MAX_Z], [route.to.lon, route.to.lat, 25, MAX_Z]];
    const hiSpots = spots.map(([x, y]) => [x, y, 15, 13]);
    const tiles = corridorTiles(route.path, [...PLAN, ...HI_PLAN], [...spots, ...hiSpots]);
    const urls = new Set(buildUrlList(style, route.path, spots, tiles).urls);
    const earthStyle = withEarth ? buildEarthStyle(style) : null;
    if (earthStyle) buildUrlList(earthStyle, route.path, spots, tiles).urls.forEach((u) => urls.add(u));
    const id = `${route.from.code}-${route.to.code}-${Date.now().toString(36)}`;
    await saveStyle(id, style);
    if (earthStyle) await saveStyle(`${id}-earth`, earthStyle);
    await Promise.all(['/data/places.json', '/data/airports.json', '/data/airlines.json'].map((u) => fetch(u).catch(() => {})));
    const list = [...urls];
    box.innerHTML = `<div class="bar"><div id="bar-fill"></div></div><div class="note" id="bar-text">Downloading maps… 0 / ${list.length}</div>`;
    const res = await prefetch(list, ({ done, total, bytes }) => {
      $('#bar-fill').style.width = `${(done / total) * 100}%`;
      $('#bar-text').textContent = `Downloading maps… ${done} / ${total} · ${fmtMB(bytes)}`;
    });
    const si = seatInfo(meta.seat);
    const trip = {
      id, from: route.from, to: route.to, total: route.path.total,
      carrier: meta.carrier || '', flight: meta.flight || '', airline: meta.airline || (meta.carrier && state.airlines?.[meta.carrier]) || '',
      seat: meta.seat || '', side: si && si.side !== 'C' ? si.side : '', date: meta.date || null,
      files: list.length, bytes: res.bytes, failed: res.failed, earth: !!earthStyle, createdAt: Date.now(),
    };
    state.trips = [trip, ...state.trips.filter((t) => !(t.from.code === trip.from.code && t.to.code === trip.to.code))];
    saveTrips();
    const pct = Math.round((res.failed / list.length) * 100);
    box.innerHTML = `<div class="note ${pct > 10 ? 'warn' : 'ok'}">${pct > 10 ? `Saved, but ${res.failed} of ${list.length} map files failed. Try saving again on better Wi-Fi.` : '✓ Saved. It will work in flight mode.'}</div>
      <button class="primary wide" data-action="open" data-id="${esc(id)}">Open flight view</button>`;
    btn.remove();
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = 'Try again';
    box.innerHTML = `<div class="note warn">Could not save: ${esc(e.message)}</div>`;
  }
}

async function openTrip(id) {
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return renderHome();
  app.innerHTML = `<div class="sheet glass"><div class="note">Opening ${esc(trip.from.code)} → ${esc(trip.to.code)}…</div></div>`;
  const vs = await loadSavedStyle(trip.id);
  if (vs) state.vectorStyle = vs;
  // Built fresh from the trip's own map style so its night-light layers use tiles already saved.
  state.earthStyle = trip.earth ? buildEarthStyle(state.vectorStyle) : null;
  state.trip = trip;
  state.route = await makeRoute(trip.from, trip.to);
  try { state.track = JSON.parse(localStorage.getItem(`fw-track-${trip.id}`) || '[]'); } catch { state.track = []; }
  state.view = state.earthStyle ? '3d' : 'map';
  state.dockOpen = false;
  await applyViewStyle();
  refreshOverlayData();
  renderFly();
  fitRoute(160, state.view === 'map' ? 0 : 50);
}

function mySide() { return state.trip?.side || ''; }
const effLook = () => (state.look === 'side' ? (mySide() || 'L') : state.look);

// ---------- flight screen ----------
function renderFly() {
  const r = state.route, t = state.trip;
  document.body.classList.add('flying');
  app.innerHTML = `
    <div class="fly-top">
      <button class="ibtn" data-action="home" aria-label="Back">‹</button>
      <div class="seg mini" id="views">
        <button data-action="view" data-v="map" class="${state.view === 'map' ? 'on' : ''}">Map</button>
        <button data-action="view" data-v="3d" class="${state.view === '3d' ? 'on' : ''}" ${state.earthStyle ? '' : 'disabled'}>3D</button>
        <button data-action="view" data-v="window" class="${state.view === 'window' ? 'on' : ''}" ${state.earthStyle ? '' : 'disabled'}>Window</button>
      </div>
      <button class="ibtn ${state.night ? 'on' : ''}" data-action="night" id="btn-night" aria-label="Day or night">${state.night ? '☾' : '☀'}</button>
    </div>
    <div class="stats-line" id="stats">
      <span><b id="h-alt">—</b> ft</span><span><b id="h-spd">—</b> km/h</span><span><b id="h-hdg">—</b></span><span><b id="h-rem">${Math.round(r.path.total).toLocaleString()}</b> km left</span><span>ETA <b id="h-eta">—</b></span>
    </div>
    <div id="window-hint" class="window-hint hidden"></div>
    <div class="tap-hint">Tap to show controls</div>
    <div class="dock glass ${state.dockOpen ? 'open' : ''}" id="dock">
      <div class="dock-row" data-action="dock">
        <span id="gps-dot" class="dot"></span>
        <div class="dock-main" id="below-line"><b>${esc(r.from.code)} → ${esc(r.to.code)}</b>${t.carrier ? ` · ${esc(t.carrier)} ${esc(t.flight)}` : ''}${t.seat ? ` · Seat ${esc(t.seat)}` : ''}</div>
        <span class="chev">${state.dockOpen ? '▾' : '▴'}</span>
      </div>
      <div class="dock-body">
        <div class="bar thin"><div id="prog"></div></div>
        <div class="dock-sub"><span id="gps-pill" class="pill">GPS off</span><span id="seat-line">${t.seat ? `Seat ${esc(t.seat)}${mySide() ? ` · ${sideWord(mySide())} side` : ''}<span id="faces"></span>` : ''}</span></div>
        <div id="below" class="below-big"></div>
        <div id="upcoming" class="upcoming"></div>
        <div id="look-row" class="look-row ${state.view === 'window' ? '' : 'hidden'}">
          <div class="seg small">
            <button data-action="look" data-l="L" class="${effLook() === 'L' ? 'on' : ''}">Left</button>
            <button data-action="look" data-l="F" class="${effLook() === 'F' ? 'on' : ''}">Front</button>
            <button data-action="look" data-l="R" class="${effLook() === 'R' ? 'on' : ''}">Right</button>
          </div>
          <input type="range" id="tilt" min="55" max="85" value="${state.tilt}" aria-label="Look down or up">
          <button class="ibtn small ${state.frame ? 'on' : ''}" data-action="frame" title="Window frame">▢</button>
        </div>
        <div class="controls">
          <button class="primary" data-action="gps" id="btn-gps">Start GPS</button>
          <button data-action="sim" id="btn-sim">Simulate</button>
          <button class="icon ${state.follow ? 'on' : ''}" data-action="follow" id="btn-follow" title="Follow plane">⌖</button>
        </div>
        <div id="sim-row" class="sim-row hidden">
          <button class="icon" data-action="play" id="btn-play">▶</button>
          <div class="seg small" id="speeds">${[1, 10, 60].map((k) => `<button data-action="speed" data-k="${k}" class="${state.simSpeed === k ? 'on' : ''}">${k}×</button>`).join('')}</div>
          <input type="range" id="sim-range" min="0" max="1000" value="0">
        </div>
      </div>
    </div>`;
  $('#sim-range').addEventListener('input', (e) => {
    state.simAlong = (e.target.value / 1000) * state.route.path.total;
    ingest(simState(state.simAlong), true);
  });
  $('#tilt').addEventListener('input', (e) => { state.tilt = +e.target.value; });
  updateWindowHint();
  updateCabin();
  if (state.live) renderInfo(true);
}

function setDock(open) {
  state.dockOpen = open;
  $('#dock')?.classList.toggle('open', open);
  const c = $('#dock .chev'); if (c) c.textContent = open ? '▾' : '▴';
}

function updateWindowHint() {
  const h = $('#window-hint'); if (!h) return;
  const show = state.view === 'window' && !state.live;
  h.classList.toggle('hidden', !show);
  if (show) h.innerHTML = 'The window view follows your position.<br>Open the panel below and tap <b>Start GPS</b> or <b>Simulate</b>.';
}

// ---------- cabin window overlay (frame + wing) ----------
const WING = `
<svg viewBox="0 0 400 300" preserveAspectRatio="xMaxYMax meet" class="wing-svg">
  <defs>
    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="w1"/><stop offset="1" class="w2"/></linearGradient>
    <linearGradient id="wl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="w2"/><stop offset="1" class="w1"/></linearGradient>
  </defs>
  <path d="M-60 214 L318 150 Q330 147 334 150 L338 160 L-60 336 Z" fill="url(#wg)"/>
  <path d="M318 150 Q331 146 336 132 L352 46 Q354 40 359 42 L362 46 L347 152 Q344 158 336 160 Z" fill="url(#wl)"/>
  <path d="M-60 214 L318 150" stroke="rgba(255,255,255,0.35)" stroke-width="1.2" fill="none"/>
  <circle class="nav" cx="350" cy="150" r="3.2"/>
  <circle class="strobe" cx="350" cy="150" r="10"/>
</svg>`;

function updateCabin() {
  let c = $('#cabin');
  const show = state.route && state.view === 'window' && state.frame && effLook() !== 'F';
  if (!show) { c?.remove(); document.body.classList.remove('in-cabin'); return; }
  if (!c) {
    c = document.createElement('div');
    c.id = 'cabin';
    c.innerHTML = `<div class="pane"><div class="wing">${WING}</div><div class="glass-sheen"></div></div>`;
    document.body.insertBefore(c, app);
  }
  c.classList.toggle('left', effLook() === 'L');
  c.classList.toggle('night', state.night);
  document.body.classList.add('in-cabin');
}

// ---------- views ----------
async function applyViewStyle() {
  if (state.view === 'map') await setMapStyle(state.vectorStyle, 'vector');
  else await setMapStyle(state.earthStyle, 'earth');
  applyNight();
}

async function setView(v) {
  if (v === state.view) return;
  state.view = v;
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  $('#look-row')?.classList.toggle('hidden', v !== 'window');
  if (v === 'window') setDock(false);
  await applyViewStyle();
  if (state.marker) state.marker.getElement().style.display = v === 'window' ? 'none' : '';
  updateWindowHint();
  updateCabin();
  if (state.live) setFollow(true);
  else fitRoute(160, v === 'map' ? 0 : 50);
}

// ---------- motion: smooth 60 fps camera ----------
// GPS gives ~1 fix per second; between fixes we glide along the last heading and speed.
const motion = { has: false, lon: 0, lat: 0, alt: 0, heading: 0, speed: 0, t: 0, dLon: 0, dLat: 0, dAlt: 0, dHeading: 0 };
let lastFrame = 0, lastInfo = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  if (!state.route || !motion.has || !state.map) return;

  let target;
  if (state.simRunning) {
    const total = state.route.path.total;
    const s = simState(state.simAlong);
    state.simAlong = Math.min(total, state.simAlong + (s.speed * state.simSpeed * dt) / 1000);
    const n = simState(state.simAlong);
    setMotion(n);
    target = [n.lon, n.lat];
    if (state.simAlong >= total) pauseSim();
  } else {
    const ahead = Math.min(4, (now - motion.t) / 1000);
    target = motion.speed > 5 ? destination([motion.lon, motion.lat], motion.heading, (motion.speed * ahead) / 1000) : [motion.lon, motion.lat];
  }
  // ease the displayed values towards the target so nothing jumps
  const k = state.simRunning ? 1 : Math.min(1, dt * 4);
  motion.dLon += lonDelta(motion.dLon, target[0]) * k;
  motion.dLat += (target[1] - motion.dLat) * k;
  motion.dHeading += angDiff(motion.dHeading, motion.heading) * Math.min(1, dt * 1.5);
  motion.dAlt += (motion.alt - motion.dAlt) * Math.min(1, dt * 1.2);
  const pos = [motion.dLon, motion.dLat];

  state.marker?.setLngLat(pos).setRotation(motion.dHeading);
  applyCamera(pos, motion.dHeading, motion.dAlt);

  if (now - lastInfo > 500) {
    lastInfo = now;
    state.live = { ...state.live, lon: pos[0], lat: pos[1], heading: motion.dHeading, speed: motion.speed, alt: motion.alt };
    renderInfo();
    const range = $('#sim-range');
    if (state.simRunning && range) range.value = (state.simAlong / state.route.path.total) * 1000;
  }
}
requestAnimationFrame(frame);
const lonDelta = (a, b) => ((((b - a + 540) % 360) + 360) % 360) - 180;

function setMotion(s) {
  const first = !motion.has;
  Object.assign(motion, { lon: s.lon, lat: s.lat, alt: s.alt ?? motion.alt, heading: s.heading, speed: s.speed ?? motion.speed, t: performance.now(), has: true });
  if (first) Object.assign(motion, { dLon: s.lon, dLat: s.lat, dAlt: motion.alt, dHeading: s.heading });
}

function cameraAlt(alt) {
  return alt != null && !Number.isNaN(alt) && alt > 150 ? alt : state.live?.sim ? 400 : 10500;
}

function applyCamera(pos, heading, alt) {
  const m = state.map;
  if (state.view === 'window') {
    const l = effLook();
    const brg = l === 'F' ? heading : heading + (l === 'L' ? -90 : 90);
    try { m.jumpTo(m.calculateCameraOptionsFromCameraLngLatAltRotation(pos, cameraAlt(alt), brg, state.tilt)); } catch { /* camera below terrain etc. */ }
    return;
  }
  if (!state.follow) return;
  if (state.view === '3d') m.jumpTo({ center: pos, bearing: heading, pitch: 62, zoom: Math.min(Math.max(m.getZoom(), 7.5), 11.5) });
  else m.jumpTo({ center: pos, zoom: Math.max(m.getZoom(), 7), pitch: 0, bearing: 0 });
}

// ---------- live position ----------
function simState(along) {
  const path = state.route.path, total = path.total;
  const [lon, lat] = pointAt(path, along);
  const f = Math.max(0, Math.min(1, along / 180, (total - along) / 220));
  return { lon, lat, alt: 300 + 10600 * f, speed: (260 + 560 * f) / 3.6, heading: headingAt(path, along), acc: 5, sim: true };
}

function startSim() {
  stopGPS();
  $('#sim-row')?.classList.remove('hidden');
  $('#btn-sim')?.classList.add('on');
  setPill('Simulating', 'sim');
  if (!state.live?.sim) state.simAlong = Math.min(state.route.path.total * 0.12, 220);
  ingest(simState(state.simAlong), true);
  setFollow(true);
  playSim();
}
function playSim() {
  state.simRunning = true;
  const b = $('#btn-play'); if (b) b.textContent = '❚❚';
}
function pauseSim() {
  state.simRunning = false;
  const b = $('#btn-play'); if (b) b.textContent = '▶';
}
function stopSim() {
  pauseSim();
  $('#sim-row')?.classList.add('hidden');
  $('#btn-sim')?.classList.remove('on');
}

function startGPS() {
  stopSim();
  if (!('geolocation' in navigator)) return setPill('No GPS', 'bad');
  if (state.live?.sim) { state.live = null; motion.has = false; }
  setPill('Searching…', 'wait');
  const b = $('#below'); if (b) b.innerHTML = 'Looking for GPS satellites… keep the phone near the window. The first fix can take a few minutes in flight mode.';
  const btn = $('#btn-gps'); btn.textContent = 'Stop GPS'; btn.classList.add('on');
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      setPill(`GPS ±${Math.round(c.accuracy)} m`, 'ok');
      const s = { lon: c.longitude, lat: c.latitude, alt: c.altitude, speed: c.speed, heading: c.heading, acc: c.accuracy };
      ingest(s);
      recordTrack(s);
    },
    (err) => {
      if (err.code === 1) { setPill('No permission', 'bad'); const el = $('#below'); if (el) el.innerHTML = 'Location permission was denied. Allow location for this app in your phone settings, then try again.'; stopGPS(); }
      else setPill('Searching…', 'wait');
    },
    { enableHighAccuracy: true, maximumAge: 0 },
  );
  setFollow(true);
  requestWake();
}
function stopGPS() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  const btn = $('#btn-gps'); if (btn) { btn.textContent = 'Start GPS'; btn.classList.remove('on'); }
}
function stopLive() {
  stopGPS(); stopSim(); releaseWake();
  state.live = null; motion.has = false;
  state.marker?.remove(); state.marker = null;
  document.body.classList.remove('flying', 'ui-off', 'in-cabin');
  $('#cabin')?.remove();
}

function recordTrack(s) {
  const last = state.track[state.track.length - 1];
  if (last && dist(last, [s.lon, s.lat]) < 1) return;
  state.track.push([+s.lon.toFixed(5), +s.lat.toFixed(5)]);
  if (state.track.length > 6000) state.track.splice(0, state.track.length - 6000);
  if (state.trip) localStorage.setItem(`fw-track-${state.trip.id}`, JSON.stringify(state.track));
  state.map.getSource('track')?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: state.track } });
}

function setPill(text, cls) {
  const p = $('#gps-pill'); if (p) { p.textContent = text; p.className = `pill ${cls || ''}`; }
  const d = $('#gps-dot'); if (d) d.className = `dot ${cls || ''}`;
}

// New position from GPS or the simulator.
function ingest(s, jump = false) {
  const r = state.route;
  if (!r) return;
  const prev = state.live, now = Date.now();
  let { heading, speed } = s;
  if (prev && !s.sim && !prev.sim && prev.raw) {
    const dkm = dist([prev.raw.lon, prev.raw.lat], [s.lon, s.lat]);
    const dt = (now - prev.t) / 1000;
    if ((heading == null || Number.isNaN(heading)) && dkm > 0.15) heading = bearing([prev.raw.lon, prev.raw.lat], [s.lon, s.lat]);
    if ((speed == null || Number.isNaN(speed)) && dt > 0.5 && dkm > 0.03) speed = (dkm * 1000) / dt;
  }
  if (heading == null || Number.isNaN(heading)) heading = prev?.heading ?? headingAt(r.path, project(r.path, [s.lon, s.lat]).along);
  const first = !state.live;
  state.live = { ...s, heading, speed, t: now, raw: { lon: s.lon, lat: s.lat } };
  if (jump || first || s.sim) { motion.has = false; }
  setMotion({ ...s, heading, speed });
  if (!state.marker) {
    const el = document.createElement('div');
    el.className = 'plane';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="38" height="38"><path fill="#ff006e" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" d="M12 1.8c.8 0 1.35.95 1.35 2.1v5.3l7.85 4.6v2.05l-7.85-2.35v4.9l2.25 1.75v1.15L12 20.3l-3.6 1v-1.15l2.25-1.75v-4.9L2.8 15.85V13.8l7.85-4.6V3.9c0-1.15.55-2.1 1.35-2.1z"/></svg>';
    state.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([s.lon, s.lat]).addTo(state.map);
    if (state.view === 'window') el.style.display = 'none';
  }
  if (first) updateWindowHint();
  if (first || jump) renderInfo(true);
}

// Text: stats line, "below you", coming up. Runs twice a second at most.
function renderInfo() {
  const r = state.route, live = state.live;
  if (!r || !live) return;
  const pos = [live.lon, live.lat];
  const heading = live.heading;
  const pr = project(r.path, pos);
  const speed = live.speed, alt = motion.dAlt || live.alt;
  const kmh = speed != null && !Number.isNaN(speed) ? speed * 3.6 : null;
  const rem = Math.max(0, r.path.total - pr.along);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#h-alt', alt != null && !Number.isNaN(alt) ? (Math.round((alt * 3.28084) / 100) * 100).toLocaleString() : '—');
  set('#h-spd', kmh != null ? Math.round(kmh).toLocaleString() : '—');
  set('#h-hdg', `${cardinal(heading)} ${Math.round(heading)}°`);
  set('#h-rem', Math.round(rem).toLocaleString());
  set('#h-eta', kmh && kmh > 150 ? new Date(Date.now() + (rem / kmh) * 3600000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
  const side = mySide();
  if (side) set('#faces', ` · window faces ${cardinal(heading + (side === 'L' ? -90 : 90))}`);
  const prog = $('#prog'); if (prog) prog.style.width = `${Math.min(100, (pr.along / r.path.total) * 100)}%`;
  if (pr.d > 150 && !live.sim) setPill(`${Math.round(pr.d)} km off route`, 'wait');

  const { near, nd } = nearestPlace(pos);
  let line, big;
  if (near && nd < 150) {
    const ns = sideOf(pos, heading, [near.lon, near.lat]).side;
    const where = nd < 4 ? 'below you' : `${Math.round(nd)} km ${sideWord(ns)}`;
    const look = side && ns === side && nd >= 4 && nd < 60;
    line = `<b>${esc(near.label)}</b> <span class="muted">${where}</span>${look ? ' <span class="look-now">Look out</span>' : ''}`;
    big = `<span class="lbl">${nd < 25 ? 'Below you' : 'Nearest place'}</span><b>${esc(near.label)}</b>${near.ctry && near.kind === 'c' ? `<small>, ${esc(near.ctry)}</small>` : ''}<div class="sub">${nd < 4 ? 'right below you' : `${Math.round(nd)} km to your ${sideWord(ns)}`}</div>`;
  } else {
    line = '<b>Open country</b> <span class="muted">no major place within 150 km</span>';
    big = '<span class="lbl">Below you</span><b>Open country or sea</b>';
  }
  const bl = $('#below-line'); if (bl) bl.innerHTML = line;
  const bb = $('#below'); if (bb) bb.innerHTML = big;

  const up = r.pois
    .filter((p) => p.along > pr.along + 3 && p.name !== near?.name)
    .slice(0, 40)
    .map((p) => ({ p, d: dist(pos, [p.lon, p.lat]), side: sideOf(pos, heading, [p.lon, p.lat]).side }))
    .filter((x) => x.d < 400)
    .sort((a, b) => (b.p.rank + (side && b.side === side ? 0.25 : 0)) - (a.p.rank + (side && a.side === side ? 0.25 : 0)))
    .slice(0, 4)
    .sort((a, b) => a.p.along - b.p.along);
  const upEl = $('#upcoming');
  if (upEl) {
    upEl.innerHTML = up.length
      ? `<span class="lbl">Coming up</span>${up.map(({ p, d, side: ps }) => `
        <div class="up ${side && ps === side ? 'mine' : ''}"><span class="badge ${ps}">${ps === 'L' ? 'LEFT' : 'RIGHT'}</span><span class="up-name">${esc(p.label)}</span>
        <span class="up-meta">${Math.round(d)} km${kmh && kmh > 150 ? ` · ${fmtDur(d / kmh)}` : ''}</span></div>`).join('')}`
      : '';
  }
}

// Nearest city/peak from the whole bundled dataset, so it works even far off the planned line.
function nearestPlace(pos) {
  let near = null, nd = Infinity;
  const lon0 = ((pos[0] + 540) % 360) - 180;
  for (const [kind, name, ctry, lat, lon, val] of state.places || []) {
    if (Math.abs(lat - pos[1]) > 2 || Math.abs(((lon - lon0 + 540) % 360) - 180) > 2.5) continue;
    const d = dist([lon0, pos[1]], [lon, lat]);
    if (d < nd) { nd = d; near = { kind, name, ctry, lat, lon, val, label: placeLabel({ kind, name, val }) }; }
  }
  return { near, nd };
}

function setFollow(on) {
  state.follow = on;
  $('#btn-follow')?.classList.toggle('on', on);
}

async function requestWake() {
  try { state.wake = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
}
function releaseWake() { state.wake?.release?.().catch(() => {}); state.wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.watchId != null) requestWake();
});

// ---------- actions ----------
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === 'home') renderHome();
  else if (a === 'new') {
    const t = state.ticket; state.ticket = null;
    renderPlan(t ? { from: t.from, to: t.to, seat: t.seat, carrier: t.carrier, flight: t.flight, airline: t.airline, date: t.date } : {});
  } else if (a === 'ticket-ok') {
    const t = state.ticket;
    renderPlan({ from: t.from, to: t.to, seat: t.seat, carrier: t.carrier, flight: t.flight, airline: t.airline, date: t.date });
  } else if (a === 'open') openTrip(el.dataset.id);
  else if (a === 'delete') {
    const t = state.trips.find((x) => x.id === el.dataset.id);
    if (t && window.confirm(`Remove ${t.from.code} → ${t.to.code}?`)) {
      state.trips = state.trips.filter((x) => x.id !== t.id); saveTrips();
      localStorage.removeItem(`fw-track-${t.id}`);
      renderHome();
    }
  } else if (a === 'clear') {
    if (window.confirm('Delete all saved flights and offline maps?')) {
      await clearAll();
      state.trips.forEach((t) => localStorage.removeItem(`fw-track-${t.id}`));
      state.trips = []; saveTrips(); renderHome();
    }
  } else if (a === 'install') {
    state.installEvt?.prompt(); state.installEvt = null; renderHome();
  } else if (a === 'dock') setDock(!state.dockOpen);
  else if (a === 'gps') {
    if (state.watchId != null) { stopGPS(); setPill('GPS off'); releaseWake(); } else startGPS();
  } else if (a === 'sim') {
    if (state.live?.sim && $('#btn-sim')?.classList.contains('on')) { stopSim(); setPill('GPS off'); } else { startSim(); if (state.view === 'window') setDock(false); }
  } else if (a === 'play') {
    if (state.simRunning) pauseSim(); else playSim();
  } else if (a === 'speed') {
    state.simSpeed = +el.dataset.k;
    document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', b === el));
  } else if (a === 'follow') setFollow(!state.follow);
  else if (a === 'view') setView(el.dataset.v);
  else if (a === 'look') {
    state.look = el.dataset.l;
    document.querySelectorAll('[data-action="look"]').forEach((b) => b.classList.toggle('on', b === el));
    updateCabin();
  } else if (a === 'frame') {
    state.frame = !state.frame; el.classList.toggle('on', state.frame); updateCabin();
  } else if (a === 'night') {
    state.night = !state.night;
    el.classList.toggle('on', state.night); el.textContent = state.night ? '☾' : '☀';
    applyNight(); updateCabin();
  }
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; if (!state.route && !state.ticket) renderHome(); });
window.addEventListener('online', () => { if (!state.route && !state.ticket) renderHome(); });
window.addEventListener('offline', () => { if (!state.route && !state.ticket) renderHome(); });

// ---------- boot ----------
(async () => {
  app.innerHTML = `<div class="sheet glass"><div class="note">Loading…</div></div>`;
  await Promise.all([initMap(), loadAirports()]);
  loadPlaces().catch(() => {});
  loadAirlines().catch(() => {});
  renderHome();
})();
