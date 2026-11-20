import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { registerSW } from 'virtual:pwa-register';
import { dist, bearing, greatCircle, buildPath, pointAt, headingAt, project, sideOf } from './geo.js';
import {
  registerProtocol, getStyle, buildStyle, saveStyle, loadSavedStyle,
  buildUrlList, prefetch, clearAll, fontStacks, MAX_Z,
} from './offline.js';

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
const fmtMB = (b) => `${(b / 1048576).toFixed(b > 104857600 ? 0 : 1)} MB`;
const emptyFC = () => ({ type: 'FeatureCollection', features: [] });
const sideWord = (s) => (s === 'L' ? 'left' : 'right');
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const state = {
  airports: null, places: null, trips: loadTrips(),
  map: null, route: null, trip: null, live: null,
  watchId: null, simTimer: null, simAlong: 0, follow: true, dim: false,
  wake: null, marker: null, track: [], installEvt: null, saving: null,
};

function loadTrips() { try { return JSON.parse(localStorage.getItem('fw-trips') || '[]'); } catch { return []; } }
function saveTrips() { localStorage.setItem('fw-trips', JSON.stringify(state.trips)); }
const ap = (a) => ({ code: a[0], name: a[1], city: a[2], country: a[3], lat: a[4], lon: a[5], large: a[6] });

async function loadAirports() {
  state.airports ??= await (await fetch('/data/airports.json')).json();
  return state.airports;
}
async function loadPlaces() {
  state.places ??= await (await fetch('/data/places.json')).json();
  return state.places;
}

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
    if (pr.d > (kind === 'c' ? 120 : 180)) continue;
    out.push({ kind, name, ctry, lat, lon, val, along: pr.along, d: pr.d, side: pr.side });
  }
  const cities = out.filter((o) => o.kind === 'c').sort((a, b) => b.val - a.val).slice(0, 220);
  const other = out.filter((o) => o.kind !== 'c').slice(0, 80);
  const maxPop = Math.max(10, ...cities.map((c) => c.val));
  const all = [...cities, ...other].sort((a, b) => a.along - b.along);
  for (const o of all) {
    o.rank = o.kind === 'c' ? Math.log10(o.val + 10) / Math.log10(maxPop + 10) : 0.55;
    o.label = o.kind === 'm' && o.val ? `${o.name} (${o.val.toLocaleString()} m)` : o.name;
  }
  return all;
}

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
  state.map = new maplibregl.Map({
    container: 'map',
    style: style || blankStyle(),
    center: [78.5, 21],
    zoom: 3.3,
    minZoom: 1.5,
    maxZoom: 14,
    attributionControl: { compact: true },
    fadeDuration: 0,
  });
  state.map.on('style.load', addOverlays);
  state.map.on('error', (e) => { if (!/Not available offline/.test(e?.error?.message || '')) console.warn(e?.error || e); });
  state.map.on('dragstart', () => { if (state.live && state.follow) setFollow(false); });
  await new Promise((r) => state.map.once('load', r));
}

function setMapStyle(style) {
  return new Promise((resolve) => {
    state.map.once('style.load', () => resolve());
    state.map.setStyle(style, { diff: false });
  });
}

function labelFont() {
  const stacks = fontStacks(state.map.getStyle());
  return stacks.find((s) => s.some((f) => /bold/i.test(f))) || stacks[0];
}

function addOverlays() {
  const m = state.map;
  for (const id of ['route', 'pois', 'track']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: emptyFC() });
  const add = (layer) => { if (!m.getLayer(layer.id)) m.addLayer(layer); };
  add({ id: 'route-glow', type: 'line', source: 'route', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#4cc9f0', 'line-width': 9, 'line-opacity': 0.3, 'line-blur': 4 } });
  add({ id: 'route-line', type: 'line', source: 'route', paint: { 'line-color': '#0a5f86', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
  add({ id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff006e', 'line-width': 3.5 } });
  add({
    id: 'poi-dot', type: 'circle', source: 'pois',
    paint: {
      'circle-radius': ['match', ['get', 'kind'], 'c', ['interpolate', ['linear'], ['get', 'rank'], 0, 3, 1, 7], 4.5],
      'circle-color': ['match', ['get', 'side'], 'L', '#ffb703', '#4cc9f0'],
      'circle-stroke-color': '#0b1220', 'circle-stroke-width': 1.5,
    },
  });
  if (m.getStyle().glyphs) {
    add({
      id: 'poi-label', type: 'symbol', source: 'pois',
      layout: {
        'text-field': ['get', 'label'], 'text-font': labelFont(),
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 9, 14],
        'text-offset': [0, 0.9], 'text-anchor': 'top', 'text-optional': true,
        'symbol-sort-key': ['-', 1, ['get', 'rank']],
      },
      paint: { 'text-color': '#0b1220', 'text-halo-color': ['match', ['get', 'side'], 'L', '#ffe7a0', '#cdf2ff'], 'text-halo-width': 2 },
    });
  }
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

function fitRoute(bottom = 320) {
  const r = state.route;
  if (!r) return;
  const b = new maplibregl.LngLatBounds();
  r.path.pts.forEach((p) => b.extend(p));
  state.map.fitBounds(b, { padding: { top: 90, bottom: Math.min(bottom, innerHeight * 0.55), left: 40, right: 40 }, duration: 600, maxZoom: 8 });
}

// ---------- screens ----------
function banner() {
  if (isIOS && !isStandalone()) {
    return `<div class="note warn"><b>iPhone tip:</b> tap <b>Share → Add to Home Screen</b>, then open Flight Window from your home screen and save your flight <i>there</i>. Safari and the home-screen app keep separate offline storage.</div>`;
  }
  return '';
}

function renderHome() {
  stopLive();
  state.route = null; state.trip = null; state.track = [];
  refreshOverlayData();
  state.map?.easeTo({ center: [78.5, 21], zoom: 3.3, bearing: 0, duration: 600 });
  const trips = state.trips.map((t) => `
    <div class="trip">
      <div class="trip-main" data-action="open" data-id="${esc(t.id)}">
        <div class="trip-codes">${esc(t.from.code)} <span>→</span> ${esc(t.to.code)}</div>
        <div class="trip-sub">${esc(t.from.city)} to ${esc(t.to.city)} · ${fmtKm(t.total)}</div>
        <div class="trip-sub ok">✓ Saved offline${t.bytes ? ` · ${fmtMB(t.bytes)}` : ''}${t.failed ? ` · ${t.failed} files missing` : ''}</div>
      </div>
      <button class="ghost small" data-action="delete" data-id="${esc(t.id)}" aria-label="Delete">✕</button>
    </div>`).join('');
  app.innerHTML = `
    <div class="sheet glass home">
      <div class="brand"><span class="logo">✈︎</span><div><h1>Flight Window</h1><p>See what's below your window, even in flight mode.</p></div></div>
      ${banner()}
      ${state.installEvt ? `<button class="wide" data-action="install">Install app</button>` : ''}
      ${trips ? `<div class="list-title">Your flights</div><div class="trips">${trips}</div>` : `<div class="empty">Save a flight before you board. In the air, your phone's GPS works without signal, so you'll see where you are.</div>`}
      <button class="primary wide" data-action="new" ${navigator.onLine ? '' : 'disabled'}>+ Save a new flight</button>
      ${navigator.onLine ? '' : '<div class="note">You are offline. Saving a new flight needs internet.</div>'}
      <div class="foot"><span id="storage"></span>${state.trips.length ? `<button class="link" data-action="clear">Clear all offline maps</button>` : ''}</div>
    </div>`;
  navigator.storage?.estimate?.().then((e) => { const el = $('#storage'); if (el && e.usage) el.textContent = `Storage used: ${fmtMB(e.usage)}`; });
}

function renderPlan() {
  state.route = null; refreshOverlayData();
  app.innerHTML = `
    <button class="back glass" data-action="home" aria-label="Back">‹</button>
    <div class="sheet glass plan">
      <h2>Save a flight</h2>
      <div class="field"><label>From</label><input id="from" placeholder="Airport code or city, e.g. BLR" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-from"></div></div>
      <div class="field"><label>To</label><input id="to" placeholder="e.g. DEL" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-to"></div></div>
      <div id="plan-info"></div>
    </div>`;
  const picked = { from: null, to: null };
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
        if (key === 'from') $('#to').focus(); else input.blur();
        if (picked.from && picked.to) preview(picked.from, picked.to);
      };
    });
  }
  setTimeout(() => $('#from')?.focus(), 50);
}

async function preview(from, to) {
  const info = $('#plan-info');
  if (from.code === to.code) { info.innerHTML = `<div class="note warn">Pick two different airports.</div>`; return; }
  info.innerHTML = `<div class="note">Plotting route…</div>`;
  const route = await makeRoute(from, to);
  state.route = route; refreshOverlayData(); fitRoute(380);
  const s = route.sides;
  const best = Math.abs(s.L - s.R) < 1.5 ? null : s.L > s.R ? 'L' : 'R';
  const style = state.map.getStyle();
  const spots = [[from.lon, from.lat, 25, MAX_Z], [to.lon, to.lat, 25, MAX_Z]];
  const { urls, tileCount } = buildUrlList(style, route.path, spots);
  info.innerHTML = `
    <div class="stats">
      <div><b>${fmtKm(route.path.total)}</b><span>direct distance</span></div>
      <div><b>~${fmtDur(flightHours(route.path.total))}</b><span>flight time</span></div>
      <div><b>${route.pois.length}</b><span>places on the way</span></div>
    </div>
    <div class="seat">
      <div class="seat-side L ${best === 'L' ? 'best' : ''}"><b>Left side</b><span>${s.nL} places</span></div>
      <div class="seat-side R ${best === 'R' ? 'best' : ''}"><b>Right side</b><span>${s.nR} places</span></div>
    </div>
    <p class="hint">${best ? `For the best view, sit on the <b>${sideWord(best)}</b> side (facing forward).` : 'Both sides have about the same to see.'} Based on the direct route; the real path can differ.</p>
    <button class="primary wide" id="btn-save">Save for offline · ~${Math.max(1, Math.round(tileCount * 0.045))} MB</button>
    <div id="save-progress"></div>`;
  $('#btn-save').onclick = () => saveTrip(route, urls.length);
}

async function saveTrip(route, approxFiles) {
  const btn = $('#btn-save'), box = $('#save-progress');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await navigator.serviceWorker?.ready;
    const style = await buildStyle();
    const spots = [[route.from.lon, route.from.lat, 25, MAX_Z], [route.to.lon, route.to.lat, 25, MAX_Z]];
    const { urls } = buildUrlList(style, route.path, spots);
    const id = `${route.from.code}-${route.to.code}-${Date.now().toString(36)}`;
    await saveStyle(id, style);
    // make sure the app data files are cached for offline use too
    await Promise.all(['/data/places.json', '/data/airports.json'].map((u) => fetch(u).catch(() => {})));
    box.innerHTML = `<div class="bar"><div id="bar-fill"></div></div><div class="note" id="bar-text">Downloading map… 0 / ${urls.length || approxFiles}</div>`;
    const res = await prefetch(urls, ({ done, total, bytes }) => {
      $('#bar-fill').style.width = `${(done / total) * 100}%`;
      $('#bar-text').textContent = `Downloading map… ${done} / ${total} · ${fmtMB(bytes)}`;
    });
    const trip = { id, from: route.from, to: route.to, total: route.path.total, files: urls.length, bytes: res.bytes, failed: res.failed, createdAt: Date.now() };
    state.trips = [trip, ...state.trips.filter((t) => !(t.from.code === trip.from.code && t.to.code === trip.to.code))];
    saveTrips();
    box.innerHTML = `<div class="note ok">✓ Saved${res.failed ? ` (${res.failed} files could not be fetched; try saving again on better Wi-Fi)` : ''}. It will work in flight mode.</div>
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
  const style = await loadSavedStyle(trip.id);
  if (style) await setMapStyle(style);
  state.trip = trip;
  state.route = await makeRoute(trip.from, trip.to);
  try { state.track = JSON.parse(localStorage.getItem(`fw-track-${trip.id}`) || '[]'); } catch { state.track = []; }
  refreshOverlayData();
  renderFly();
  fitRoute(300);
}

function renderFly() {
  const r = state.route;
  app.innerHTML = `
    <div class="hud glass">
      <div><b id="h-alt">—</b><span>alt ft</span></div>
      <div><b id="h-spd">—</b><span>km/h</span></div>
      <div><b id="h-hdg">—</b><span>heading</span></div>
      <div><b id="h-rem">${Math.round(r.path.total).toLocaleString()}</b><span>km left</span></div>
      <div><b id="h-eta">—</b><span>arrive</span></div>
    </div>
    <button class="back glass top" data-action="home" aria-label="Back">‹</button>
    <div class="sheet glass fly">
      <div class="fly-head"><div class="fly-title">${esc(r.from.code)} → ${esc(r.to.code)}</div><span id="gps-pill" class="pill">GPS off</span></div>
      <div class="bar thin"><div id="prog"></div></div>
      <div class="below"><span class="lbl">Below you</span><div id="below">Tap <b>Start GPS</b> by the window, or <b>Simulate</b> to try it.</div></div>
      <div id="upcoming" class="upcoming"></div>
      <div class="controls">
        <button class="primary" data-action="gps" id="btn-gps">Start GPS</button>
        <button data-action="sim" id="btn-sim">Simulate</button>
        <button class="icon ${state.follow ? 'on' : ''}" data-action="follow" id="btn-follow" title="Follow plane">⌖</button>
        <button class="icon ${state.dim ? 'on' : ''}" data-action="dim" id="btn-dim" title="Dim map">☾</button>
      </div>
      <div id="sim-row" class="sim-row hidden"><button class="icon" data-action="play" id="btn-play">▶</button><input type="range" id="sim-range" min="0" max="1000" value="0"></div>
    </div>`;
  $('#sim-range').addEventListener('input', (e) => {
    pauseSim();
    state.simAlong = (e.target.value / 1000) * state.route.path.total;
    update(simState(state.simAlong));
  });
  if (state.live) update(state.live);
}

// ---------- live position ----------
function simState(along) {
  const path = state.route.path, total = path.total;
  const [lon, lat] = pointAt(path, along);
  const f = Math.max(0, Math.min(1, along / 180, (total - along) / 220));
  return { lon, lat, alt: 10900 * f + 900 * (1 - f) * (along > 2 && total - along > 2 ? 1 : 0), speed: (260 + 560 * f) / 3.6, heading: headingAt(path, along), acc: 5, sim: true };
}

function startSim() {
  stopGPS();
  $('#sim-row')?.classList.remove('hidden');
  $('#btn-sim')?.classList.add('on');
  setPill('Simulating', 'sim');
  if (!state.live?.sim) state.simAlong = 0;
  update(simState(state.simAlong));
  setFollow(true);
  playSim();
}
function playSim() {
  pauseSim();
  const btn = $('#btn-play'); if (btn) btn.textContent = '❚❚';
  state.simTimer = setInterval(() => {
    const total = state.route.path.total;
    const s = simState(state.simAlong);
    state.simAlong = Math.min(total, state.simAlong + (s.speed * 120 * 0.25) / 1000); // 120× real time
    update(simState(state.simAlong));
    const range = $('#sim-range'); if (range) range.value = (state.simAlong / total) * 1000;
    if (state.simAlong >= total) pauseSim();
  }, 250);
}
function pauseSim() {
  clearInterval(state.simTimer); state.simTimer = null;
  const btn = $('#btn-play'); if (btn) btn.textContent = '▶';
}
function stopSim() {
  pauseSim();
  $('#sim-row')?.classList.add('hidden');
  $('#btn-sim')?.classList.remove('on');
}

function startGPS() {
  stopSim();
  if (!('geolocation' in navigator)) return setPill('No GPS', 'bad');
  if (state.live?.sim) state.live = null;
  setPill('Searching…', 'wait');
  $('#below').innerHTML = 'Looking for GPS satellites… keep the phone near the window. The first fix can take a few minutes in flight mode.';
  const btn = $('#btn-gps'); btn.textContent = 'Stop GPS'; btn.classList.add('on');
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      setPill(`GPS ±${Math.round(c.accuracy)} m`, 'ok');
      const s = { lon: c.longitude, lat: c.latitude, alt: c.altitude, speed: c.speed, heading: c.heading, acc: c.accuracy };
      update(s);
      recordTrack(s);
    },
    (err) => {
      if (err.code === 1) { setPill('No permission', 'bad'); $('#below').innerHTML = 'Location permission was denied. Allow location for this app in your phone settings, then try again.'; stopGPS(); }
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
  state.live = null;
  state.marker?.remove(); state.marker = null;
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
  const p = $('#gps-pill'); if (!p) return;
  p.textContent = text; p.className = `pill ${cls || ''}`;
}

function update(s) {
  const r = state.route;
  if (!r) return;
  const prev = state.live, now = Date.now();
  let { heading, speed } = s;
  if (prev && !s.sim && !prev.sim) {
    const dkm = dist([prev.lon, prev.lat], [s.lon, s.lat]);
    const dt = (now - prev.t) / 1000;
    if ((heading == null || Number.isNaN(heading)) && dkm > 0.15) heading = bearing([prev.lon, prev.lat], [s.lon, s.lat]);
    if ((speed == null || Number.isNaN(speed)) && dt > 0.5 && dkm > 0.03) speed = (dkm * 1000) / dt;
  }
  const pos = [s.lon, s.lat];
  const pr = project(r.path, pos);
  if (heading == null || Number.isNaN(heading)) heading = prev?.heading ?? headingAt(r.path, pr.along);
  const live = { ...s, heading, speed, t: now, along: pr.along };
  state.live = live;

  // marker
  if (!state.marker) {
    const el = document.createElement('div');
    el.className = 'plane';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="38" height="38"><path fill="#ff006e" stroke="#fff" stroke-width="1.1" stroke-linejoin="round" d="M12 1.8c.8 0 1.35.95 1.35 2.1v5.3l7.85 4.6v2.05l-7.85-2.35v4.9l2.25 1.75v1.15L12 20.3l-3.6 1v-1.15l2.25-1.75v-4.9L2.8 15.85V13.8l7.85-4.6V3.9c0-1.15.55-2.1 1.35-2.1z"/></svg>';
    state.marker = new maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat(pos).addTo(state.map);
  }
  state.marker.setLngLat(pos).setRotation(heading);
  if (state.follow) state.map.easeTo({ center: pos, zoom: Math.max(state.map.getZoom(), 7), duration: s.sim ? 240 : 900 });

  // HUD
  const kmh = speed != null && !Number.isNaN(speed) ? speed * 3.6 : null;
  const rem = Math.max(0, r.path.total - pr.along);
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('#h-alt', s.alt != null && !Number.isNaN(s.alt) ? (Math.round((s.alt * 3.28084) / 100) * 100).toLocaleString() : '—');
  set('#h-spd', kmh != null ? Math.round(kmh).toLocaleString() : '—');
  set('#h-hdg', `${Math.round(heading)}°`);
  set('#h-rem', Math.round(rem).toLocaleString());
  if (kmh && kmh > 150) {
    const arrive = new Date(now + (rem / kmh) * 3600000);
    set('#h-eta', arrive.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
  } else set('#h-eta', '—');
  const prog = $('#prog'); if (prog) prog.style.width = `${Math.min(100, (pr.along / r.path.total) * 100)}%`;
  if (pr.d > 150 && !s.sim) setPill(`${Math.round(pr.d)} km off route`, 'wait');

  // below + upcoming
  const { near, nd } = nearestPlace(pos);
  const below = $('#below');
  const belowLbl = $('.below .lbl');
  if (belowLbl) belowLbl.textContent = near && nd < 25 ? 'Below you' : 'Nearest place';
  if (below) {
    if (near && nd < 150) {
      const side = nd < 4 ? 'right below you' : `${Math.round(nd)} km to your ${sideWord(sideOf(pos, heading, [near.lon, near.lat]).side)}`;
      below.innerHTML = `<b>${esc(near.label)}</b>${near.ctry && near.kind === 'c' ? `<small>, ${esc(near.ctry)}</small>` : ''}<div class="sub">${side}</div>`;
    } else below.innerHTML = '<b>Open country or sea</b><div class="sub">No major place within 150 km</div>';
  }
  const up = r.pois
    .filter((p) => p.along > pr.along + 3 && p.name !== near?.name)
    .slice(0, 40)
    .map((p) => ({ p, d: dist(pos, [p.lon, p.lat]), side: sideOf(pos, heading, [p.lon, p.lat]).side }))
    .filter((x) => x.d < 400)
    .sort((a, b) => b.p.rank - a.p.rank)
    .slice(0, 4)
    .sort((a, b) => a.p.along - b.p.along);
  const upEl = $('#upcoming');
  if (upEl) {
    upEl.innerHTML = up.length
      ? `<span class="lbl">Coming up</span>${up.map(({ p, d, side }) => `
        <div class="up"><span class="badge ${side}">${side === 'L' ? 'LEFT' : 'RIGHT'}</span><span class="up-name">${esc(p.label)}</span>
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
    if (d < nd) { nd = d; near = { kind, name, ctry, lat, lon, val, label: kind === 'm' && val ? `${name} (${val.toLocaleString()} m)` : name }; }
  }
  return { near, nd };
}

function setFollow(on) {
  state.follow = on;
  $('#btn-follow')?.classList.toggle('on', on);
  if (on && state.live) state.map.easeTo({ center: [state.live.lon, state.live.lat], zoom: Math.max(state.map.getZoom(), 7), duration: 500 });
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
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'home') renderHome();
  else if (a === 'new') renderPlan();
  else if (a === 'open') openTrip(el.dataset.id);
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
  } else if (a === 'gps') {
    if (state.watchId != null) { stopGPS(); setPill('GPS off'); releaseWake(); } else startGPS();
  } else if (a === 'sim') {
    if (state.live?.sim && $('#btn-sim')?.classList.contains('on')) { stopSim(); setPill('GPS off'); } else startSim();
  } else if (a === 'play') {
    if (state.simTimer) pauseSim(); else playSim();
  } else if (a === 'follow') setFollow(!state.follow);
  else if (a === 'dim') {
    state.dim = !state.dim;
    document.body.classList.toggle('dim', state.dim);
    el.classList.toggle('on', state.dim);
  }
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; if (!state.route) renderHome(); });
window.addEventListener('online', () => { if (!state.route) renderHome(); });
window.addEventListener('offline', () => { if (!state.route) renderHome(); });

// ---------- boot ----------
(async () => {
  app.innerHTML = `<div class="sheet glass"><div class="note">Loading…</div></div>`;
  await Promise.all([initMap(), loadAirports()]);
  loadPlaces().catch(() => {});
  renderHome();
})();
