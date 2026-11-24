import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { registerSW } from 'virtual:pwa-register';
import { dist, bearing, greatCircle, buildPath, pointAt, headingAt, project, sideOf, corridorTiles, destination, angDiff } from './geo.js';
import {
  registerProtocol, getStyle, buildStyle, buildEarthStyle, saveStyle, loadSavedStyle,
  buildUrlList, prefetch, clearAll, fontStacks, MAX_Z, PLAN, sharpPlan, SKY, areaAround, openTileCache, missingUrls,
} from './offline.js';
import { makeStory } from './story.js';
import { extractTileFeatures, buildEvents, eventTitle, eventSub, summary, overlayData, ICON, inPolys } from './features.js';
import { readTicket, seatInfo } from './boarding.js';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/space-grotesk/latin-500.css';
import '@fontsource/space-grotesk/latin-600.css';
import { icon, EV_ICON } from './icons.js';
import { ecoAt, routeLandscapes, biomeInfo } from './landscapes.js';
import { routePlaces, pickFeatured, sideHighlights, imageUrls, attachPlaces, spotTip, CAT } from './places.js';

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
  events: [], feats: [], featData: null, alerted: new Set(), zoomBias: 0, userZooming: false,
  gpsWanted: false, lastFix: null, geo: null,
  featured: [], planFeatured: [], alertItems: [], tour: null,
};

function loadTrips() { try { return JSON.parse(localStorage.getItem('fw-trips') || '[]'); } catch { return []; } }
function saveTrips() { localStorage.setItem('fw-trips', JSON.stringify(state.trips)); }
const ap = (a) => ({ code: a[0], name: a[1], city: a[2], country: a[3], lat: a[4], lon: a[5], large: a[6] });
const airportByCode = (c) => { const a = state.airports?.find((x) => x[0] === c); return a ? ap(a) : null; };

async function loadJSON(u) { return (await fetch(u)).json(); }
async function loadAirports() { state.airports ??= await loadJSON('/data/airports.json'); return state.airports; }
async function loadPlaces() { state.places ??= await loadJSON('/data/places.json'); return state.places; }
async function loadGeo() { state.geo ??= await loadJSON('/data/geo.json'); return state.geo; }
async function loadGuides() {
  if (state.guides === undefined) state.guides = await loadJSON('/data/guides.json').catch(() => null);
  return state.guides;
}
async function loadEco() {
  if (state.eco === undefined) state.eco = await loadJSON('/data/eco.json').catch(() => null);
  return state.eco;
}
const hiAreasFor = (a, b) => [areaAround(a.lon, a.lat), areaAround(b.lon, b.lat)];
const routeSpots = (from, to) => {
  const spots = [[from.lon, from.lat, 25, MAX_Z], [to.lon, to.lat, 25, MAX_Z]];
  return { spots, all: [...spots, ...spots.map(([x, y]) => [x, y, 16, 13]), ...spots.map(([x, y]) => [x, y, 10, 14])] };
};
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
  const [pois, places, eco] = await Promise.all([
    poisFor(path),
    routePlaces(path).catch((e) => { console.warn('place packs unavailable', e); return []; }),
    loadEco(),
    loadGuides(),
  ]);
  return { from, to, path, pois, places, lands: routeLandscapes(eco, path), sides: sideScore(pois, places) };
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

function sideScore(pois, places = []) {
  const s = { L: 0, R: 0, nL: 0, nR: 0 };
  if (places.length) {
    for (const p of places) if (p.d >= 4 && p.d <= 60) { s[p.side] += p.s / 25; s[`n${p.side}`]++; }
    return s;
  }
  for (const p of pois) {
    if (p.d > 100) continue;
    s[p.side] += p.kind === 'c' ? Math.max(0.5, Math.log10(p.val + 10) - 3) : 2;
    s[`n${p.side}`]++;
  }
  return s;
}
const flightHours = (km) => km / 800 + 0.45;
const sinceTakeoff = (along) => fmtDur(along / 800 + 0.15);
// Two numbers, so nothing is hidden: what you need before boarding, and the total once the sharp ground arrives.
const sizeLine = (ready, sharp, withSharp, side) =>
  `${fmtMB(ready)} to be ready${withSharp ? ` · ${fmtMB(ready + sharp)} with sharp ground` : ''}${side || !withSharp ? '' : ' · pick a side to save less'}`;

// ---------- featured places ----------
function featuredFor(route, side, night) {
  if (!route?.places?.length) return [];
  return pickFeatured(route.places, { total: route.path.total, hours: flightHours(route.path.total), side, night });
}
const placeById = (id) => state.route?.places?.find((p) => p.id === id);
const kindLabel = (p) => (p.k ? p.k[0].toUpperCase() + p.k.slice(1) : CAT[p.c]?.label || '');
const sideTag = (p, s = p.side) => (p.d < 5 ? 'BELOW' : s === 'L' ? 'LEFT' : 'RIGHT');

function placeCard(p) {
  const c = CAT[p.c] || {};
  return `<button class="pcard" data-action="place" data-id="${esc(p.id)}">
    <div class="pimg">${p.img ? `<img src="${esc(p.img.u)}" alt="" loading="lazy">` : `<span class="pico">${c.icon || icon('pin')}</span>`}
      <span class="badge ${p.d < 5 ? 'B' : p.side}">${sideTag(p)}</span>${p.u ? '<span class="unesco" title="UNESCO World Heritage Site">UNESCO</span>' : ''}</div>
    <div class="pbody"><b>${esc(p.n)}</b><small>${esc(kindLabel(p))} · ${sinceTakeoff(p.along)} in</small></div>
  </button>`;
}

function featuredHtml(route, feat, night, side) {
  if (!route.places?.length) return '';
  const perHour = feat.length / Math.max(0.5, flightHours(route.path.total));
  return `<section class="featured">
    <div class="feat-head"><h3>Worth looking out for</h3><span>${feat.length ? `${feat.length} picks, about ${Math.max(1, Math.round(perHour))} an hour` : ''}</span></div>
    <div class="cards">${feat.map(placeCard).join('') || `<div class="note">Nothing famous to see on this route ${night ? 'at night' : 'by day'}.</div>`}</div>
  </section>`;
}

function landsHtml(route) {
  const lands = route.lands || [];
  if (lands.length < 2) return '';
  return `<section class="lands">
    <div class="feat-head"><h3>Landscapes you'll cross</h3><span>${lands.length} natural regions</span></div>
    <div class="land-row">${lands.map((l, i) => `<button class="land-chip" data-action="land" data-i="${i}">
      <span class="lc-bar" style="--w:${Math.max(18, Math.min(100, ((l.end - l.start) / route.path.total) * 220))}%"></span>
      <b>${esc(shortEco(l.name))}</b><small>${esc(biomeInfo(l.biome).short)} · ${fmtDur((l.end - l.start) / 800)}</small></button>`).join('')}</div>
  </section>`;
}
// "Narmada Valley dry deciduous forests" -> "Narmada Valley" for tight spaces; the sheet shows the full name.
const shortEco = (n) => n.replace(/\s+(tropical|subtropical|moist|dry|deciduous|evergreen|broadleaf|semi-evergreen|montane|thorn|scrub|forests?|rain|grasslands?|savanna|and|&|xeric|shrublands?|conifer|pine|alpine|meadows|mixed|sub-alpine|subalpine|steppe|freshwater|swamp|mangroves?|desert)\b.*$/i, '').trim() || n;

function openLandscape(l) {
  if (!l) return;
  const b = biomeInfo(l.biome);
  const lands = state.route?.lands || [];
  const run = lands.find((x) => x.name === l.name);
  let ov = $('#place');
  if (!ov) { ov = document.createElement('div'); ov.id = 'place'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="place-box" role="dialog" aria-label="${esc(l.name)}">
    <div class="place-img none land"><span class="big-ico">${icon('terrain', 44)}</span><span class="grab"></span><button class="pl-close" data-place="close" aria-label="Close">${icon('close', 18)}</button></div>
    <div class="place-body">
      <div class="pills"><span class="cat-pill" style="--c:#6FCF97">${esc(b.short)}</span><span class="cat-pill plain">Natural region</span></div>
      <h3>${esc(l.name)}</h3>
      ${run ? `<div class="look-box B">${icon('down', 22)}<div><b>Below you for about ${fmtDur(Math.max(0.1, (run.end - run.start) / 800))}</b><small>from ${sinceTakeoff(run.start)} after take-off</small></div></div>` : ''}
      ${l.x ? `<section><h4>What it is</h4><p>${esc(units(l.x))}</p></section>` : ''}
      ${b.tip ? `<section class="spot-tip">${icon('eye', 22)}<div><b>How to recognise it from the air</b><p>${esc(b.tip)} Much of it is farmland today; the natural cover survives on hills and in protected areas.</p></div></section>` : ''}
      <section class="facts"><div><span>Type</span><b>${esc(l.biome || b.short)}</b></div><div><span>Realm</span><b>${esc(l.realm || '—')}</b></div></section>
      ${guideLink(l.name) ? `<section><h4>Read more</h4>${guideLink(l.name)}</section>` : ''}
      <div class="place-foot"><span class="ok">${icon('check', 15)} Works in flight mode</span>${l.wp ? `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(l.wp.replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipedia →</a>` : ''}</div>
      <div class="src">Map: RESOLVE Ecoregions 2017 (CC BY 4.0). Text from Wikipedia (CC BY-SA)</div>
    </div></div>`;
  ov.classList.add('show');
  ov.querySelector('.place-box').scrollTop = 0;
  ov.onclick = (e) => {
    const gl = e.target.closest('[data-guide]');
    if (gl) { ov.classList.remove('show'); openGuideEntry('land', gl.dataset.guide); return; }
    if (e.target === ov || e.target.closest('[data-place="close"]')) ov.classList.remove('show');
  };
}

// ---------- guides: clouds and India from the air ----------
const GUIDE_LABELS = { clouds: ['From the plane', 'What it means for your flight', 'flight'], land: ['From the plane', 'Where in India', 'where'] };
function guideOverlay() {
  let ov = $('#guide');
  if (!ov) { ov = document.createElement('div'); ov.id = 'guide'; document.body.appendChild(ov); }
  ov.onclick = (e) => {
    const t = e.target.closest('[data-g]');
    if (e.target === ov || e.target.closest('[data-g="close"]')) { ov.classList.remove('show'); return; }
    if (!t) return;
    if (t.dataset.g === 'tab') openGuides(t.dataset.k);
    else if (t.dataset.g === 'entry') openGuideEntry(t.dataset.k, t.dataset.id);
    else if (t.dataset.g === 'back') openGuides(t.dataset.k);
  };
  return ov;
}
const guideCard = (k, e) => `<button class="g-card" data-g="entry" data-k="${k}" data-id="${esc(e.id)}">
    <span class="g-img">${e.img ? `<img src="${esc(e.img.u)}" alt="" loading="lazy">` : icon(k === 'clouds' ? 'cloud' : 'terrain', 28)}</span>
    <b>${esc(e.title)}</b><small>${esc(e.short)}</small></button>`;
async function openGuides(tab = 'clouds') {
  const g = await loadGuides();
  if (!g) { showToast(icon('book', 22), 'Guides not available', 'Open the app once with internet to save them'); return; }
  const ov = guideOverlay();
  const sec = g[tab];
  ov.innerHTML = `<div class="place-box guide-box" role="dialog" aria-label="Guides">
    <div class="g-top"><h3>Guides</h3><button class="pl-close" data-g="close" aria-label="Close">${icon('close', 18)}</button></div>
    <div class="seg g-tabs">${Object.entries(g).map(([k, v]) => `<button data-g="tab" data-k="${k}" class="${k === tab ? 'on' : ''}">${esc(v.title)} <small>${v.entries.length}</small></button>`).join('')}</div>
    <label class="g-search">${icon('search', 16)}<input id="g-q" type="search" placeholder="Search ${esc(sec.title.toLowerCase())}" autocomplete="off"></label>
    <p class="g-intro">${esc(sec.intro)}</p>
    <div class="g-grid" id="g-grid">${sec.entries.map((e) => guideCard(tab, e)).join('')}</div>
    <div class="src">Photos: Wikimedia Commons, credited on each entry. Works in flight mode.</div>
  </div>`;
  ov.classList.add('show');
  ov.querySelector('.guide-box').scrollTop = 0;
  $('#g-q').oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    const re = new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'); // word starts: "salt" finds salt pans, not basalt
    const hits = sec.entries.filter((x) => !q || re.test(`${x.title} ${x.short} ${x.what} ${x.plane}`));
    $('#g-grid').innerHTML = hits.map((x) => guideCard(tab, x)).join('') || '<div class="note">Nothing matches.</div>';
  };
}
async function openGuideEntry(tab, id) {
  const g = await loadGuides();
  const e = g?.[tab]?.entries.find((x) => x.id === id);
  if (!e) return;
  const [l1, l2, k2] = GUIDE_LABELS[tab];
  const ov = guideOverlay();
  ov.innerHTML = `<div class="place-box guide-box" role="dialog" aria-label="${esc(e.title)}">
    <div class="place-img ${e.img ? '' : 'none land'}">${e.img ? `<img src="${esc(e.img.u)}" alt="${esc(e.title)}"><span class="credit">Photo: ${esc(e.img.by)} · ${esc(e.img.lic)} · Wikimedia Commons</span>` : `<span class="big-ico">${icon(tab === 'clouds' ? 'cloud' : 'terrain', 44)}</span>`}
      <button class="g-back" data-g="back" data-k="${tab}" aria-label="Back to the guide">${icon('back', 18)} ${esc(g[tab].title)}</button>
      <button class="pl-close" data-g="close" aria-label="Close">${icon('close', 18)}</button></div>
    <div class="place-body">
      <h3>${esc(e.title)}</h3><div class="hi">${esc(e.short)}</div>
      <section><h4>What it is</h4><p>${esc(e.what)}</p></section>
      <section class="spot-tip">${icon('eye', 22)}<div><b>${l1}</b><p>${esc(e.plane)}</p></div></section>
      <section><h4>${l2}</h4><p>${esc(e[k2])}</p></section>
      <div class="src">Text: Flight Companion. Photo via Wikipedia's "${esc(e.article)}" article.</div>
    </div></div>`;
  ov.classList.add('show');
  ov.querySelector('.guide-box').scrollTop = 0;
}
// A guide entry that explains this place or landscape, if any (by name).
function guideFor(name) {
  const land = state.guides?.land?.entries || [];
  return land.find((e) => (e.match || []).some((m) => name.toLowerCase().includes(m.toLowerCase())));
}
function guideLink(name) {
  const e = name && guideFor(name);
  return e ? `<button class="next-row g-link" data-guide="${esc(e.id)}">${e.img ? `<img src="${esc(e.img.u)}" alt="">` : `<span class="nx-ico">${icon('book', 22)}</span>`}<span><b>${esc(e.title)}</b><small>From the guide · ${esc(e.short)}</small></span><em>${icon('right', 16)}</em></button>` : '';
}

function setupPlaces() {
  const r = state.route;
  state.featured = featuredFor(r, mySide(), state.night);
  attachPlaces(state.events, r?.places || []);
  state.alertItems = planAlerts();
}

const evKey = (e) => (e.type === 's' ? `s:${e.name}` : `${e.type}:${e.name}:${Math.round(e.start)}`);
// About 6 alerts an hour: the most interesting moments, spaced out along the flight.
function planAlerts() {
  const r = state.route;
  if (!r) return [];
  const total = r.path.total;
  const items = [];
  for (const e of state.events) {
    if (e.type === 's' && e.origin) continue;
    const prio = { t: 100, r: 55, p: 55, l: 45, k: 45, s: 40, g: 35 }[e.type] ?? 30;
    items.push({ start: e.start, key: evKey(e), prio: prio + (e.place ? 15 : 0), e });
  }
  for (const p of state.featured) items.push({ start: p.along, key: `pl:${p.id}`, prio: p.f, p });
  (r.lands || []).forEach((l, i) => {
    if (i > 0 && l.end - l.start >= 60) items.push({ start: l.start, key: `land:${l.name}`, prio: 28, land: l });
  });
  const max = Math.max(3, Math.round(flightHours(total) * 6));
  const gap = (total / max) * 0.6;
  const chosen = [];
  for (const it of items.sort((a, b) => b.prio - a.prio)) {
    if (chosen.length >= max) break;
    if (chosen.some((c) => Math.abs(c.start - it.start) < gap)) continue;
    chosen.push(it);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// ---------- flight preview: the whole flight in about a minute, slowing down at each featured place ----------
// Preview speed in km per second of screen time: 12 next to a featured place, 80 between them.
const TOUR_NEAR = 12, TOUR_FAR = 80;
function tourKmS(along, feat = state.featured) {
  let dn = Infinity;
  for (const p of feat) { const d = Math.abs(p.along - along); if (d < dn) dn = d; }
  const t = Math.max(0, Math.min(1, (dn - 12) / 23));
  return TOUR_NEAR + (TOUR_FAR - TOUR_NEAR) * t * t * (3 - 2 * t);
}
function tourSeconds(route, feat) {
  let sec = 0;
  for (let a = 0; a < route.path.total; a += 2) sec += 2 / tourKmS(a, feat);
  return sec;
}

async function startTour({ from, to, side = '', night, back = null, view = '3d' }) {
  stopLive();
  if (!(state.route && state.route.from.code === from.code && state.route.to.code === to.code)) state.route = await makeRoute(from, to);
  if (night != null) state.night = night;
  await loadTripFeatures(null);
  state.trip = { id: 'demo', from, to, total: state.route.path.total, carrier: '', flight: '', airline: '', seat: '', side, earth: true };
  state.earthStyle = state.vectorStyle ? buildEarthStyle(state.vectorStyle) : null;
  state.progress = { maxAlong: 0 }; state.storyShown = false; state.track = [];
  setupPlaces();
  state.alertItems = state.alertItems.filter((it) => !it.p); // places get the spotlight card instead
  state.tour = { back, spot: null };
  state.view = state.earthStyle ? view : 'map';
  state.dockOpen = false;
  await applyViewStyle();
  refreshOverlayData();
  renderFly();
  startSim();
  $('#sim-row')?.classList.add('hidden');
  state.simAlong = 0;
  ingest(simState(0), true);
}

function tourBarHtml() {
  return `<div id="spot" class="spot"></div>
    <div class="tour-bar glass">
      <button class="icon" data-action="tour-play" id="tour-play" aria-label="Pause or play">${icon('pause', 18)}</button>
      <input type="range" id="tour-range" min="0" max="1000" value="0" aria-label="Flight progress">
      <span id="tour-left" class="tour-left"></span>
    </div>`;
}

function updateTour() {
  const T = state.tour; if (!T || !state.route) return;
  const a = state.simAlong, total = state.route.path.total;
  let p = state.featured.find((x) => a > x.along - 18 && a < x.along + 8);
  if (!p && T.spot && performance.now() - T.since < 3000) p = state.featured.find((x) => x.id === T.spot); // keep each card up 3 s
  const el = $('#spot');
  if (el && (p?.id || null) !== T.spot) {
    T.since = performance.now();
    T.spot = p?.id || null;
    if (p) {
      const c = CAT[p.c] || {};
      el.innerHTML = `<div class="spot-card glass" data-action="place" data-id="${esc(p.id)}">
        ${p.img ? `<img src="${esc(p.img.u)}" alt="">` : `<span class="spot-ico">${c.icon || icon('pin')}</span>`}
        <div class="spot-text"><span class="badge ${p.d < 5 ? 'B' : p.side}">${sideTag(p)}</span>${p.u ? '<span class="unesco-mini">UNESCO</span>' : ''}
          <b>${esc(p.n)}</b><small>${c.icon || ''} ${esc(kindLabel(p))}${p.d >= 5 ? ` · ${Math.round(p.d)} km away` : ''}</small></div></div>`;
      if (state.view === 'window' && p.d >= 5 && state.look !== p.side) {
        state.look = p.side;
        document.querySelectorAll('[data-action="look"]').forEach((b) => b.classList.toggle('on', b.dataset.l === state.look));
        updateCabin();
      }
    }
    el.classList.toggle('show', !!p);
  }
  const range = $('#tour-range'); if (range) range.value = (a / total) * 1000;
  const left = $('#tour-left'); if (left) left.textContent = a >= total - 1 ? 'Landed' : `${fmtDur((total - a) / 820)} to landing`;
}

const units = (t) => String(t).replace(/\bkm2\b/g, 'km²').replace(/\bm2\b/g, 'm²');
function placeFacts(p) {
  const f = [];
  const yr = (y) => (y < 0 ? `${-y} BCE` : String(y));
  if (p.year) f.push([{ nature: 'Protected since', historic: 'Built', works: 'Built', city: 'Founded', battle: 'Fought in' }[p.c] || 'Since', yr(p.year)]);
  if (p.el) f.push(['Height', `${p.el.toLocaleString()} m`]);
  if (p.area) f.push(['Area', `${p.area >= 10 ? Math.round(p.area).toLocaleString() : p.area} km²`]);
  if (p.pop) f.push(['Population', p.pop >= 1e6 ? `${(p.pop / 1e6).toFixed(1)} million` : p.pop.toLocaleString()]);
  if (p.adm) f.push(['Where', p.adm]);
  if (f.length < 4) f.push(['Type', kindLabel(p)]);
  return f.slice(0, 4);
}

function openPlace(id) {
  const p = placeById(id);
  if (!p) return;
  const c = CAT[p.c] || {};
  let kicker, where, side = p.d < 5 ? '' : p.side;
  const live = state.live;
  if (live) {
    const pos = [live.lon, live.lat];
    const d = dist(pos, p.p);
    side = d < 5 ? '' : sideOf(pos, live.heading, p.p).side;
    const along = project(state.route.path, pos).along;
    const kmh = live.speed ? live.speed * 3.6 : 0;
    const ahead = p.along > along + 2;
    kicker = !side ? 'Right below you' : `Look ${sideWord(side)}${ahead && kmh > 150 ? ` in ${fmtDur((p.along - along) / kmh)}` : ahead ? '' : ' (behind you now)'}`;
    where = `${Math.round(Math.max(p.d, 0))} km from the plane at its closest · ${Math.round(d)} km now`;
  } else {
    kicker = side ? `On the ${sideWord(side)} of your route` : 'Right below your route';
    where = `${side ? `${Math.round(p.d)} km away · ` : ''}about ${sinceTakeoff(p.along)} after take-off`;
  }
  const list = (state.trip ? state.featured : state.planFeatured) || [];
  const next = list.find((q) => q.along > p.along + 2 && q.id !== p.id);
  const facts = placeFacts(p);
  const tip = spotTip(p, state.night);
  let ov = $('#place');
  if (!ov) { ov = document.createElement('div'); ov.id = 'place'; document.body.appendChild(ov); }
  ov.innerHTML = `<div class="place-box" role="dialog" aria-label="${esc(p.n)}">
    <div class="place-img ${p.img ? '' : 'none'}">${p.img ? `<img src="${esc(p.img.u)}" alt="${esc(p.n)}"><span class="credit">Photo: ${esc(p.img.by)} · ${esc(p.img.lic)} · Wikimedia Commons</span>` : `<span class="big-ico">${icon(p.c, 44)}</span>`}
      <span class="grab"></span><button class="pl-close" data-place="close" aria-label="Close">${icon('close', 18)}</button></div>
    <div class="place-body">
      <div class="pills"><span class="cat-pill" style="--c:${c.color || '#fff'}">${esc(kindLabel(p))}</span>${p.u ? '<span class="cat-pill unesco">UNESCO World Heritage</span>' : ''}${p.adm ? `<span class="cat-pill plain">${esc(p.adm)}</span>` : ''}</div>
      <h3>${esc(p.n)}</h3>${p.hi && p.hi !== p.n ? `<div class="hi">${esc(p.hi)}</div>` : ''}
      <div class="look-box ${side || 'B'}">${icon(side === 'L' ? 'left' : side === 'R' ? 'right' : 'down', 22)}<div><b>${esc(kicker)}</b><small>${esc(where)}</small></div></div>
      ${p.x || p.desc ? `<section><h4>Why it's famous</h4><p>${esc(units(p.x || p.desc))}</p></section>` : ''}
      ${facts.length ? `<section class="facts">${facts.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</section>` : ''}
      ${p.xl ? `<section><h4>The story</h4><p>${esc(units(p.xl))}</p></section>` : ''}
      ${tip ? `<section class="spot-tip">${icon('eye', 22)}<div><b>How to spot it from the air</b><p>${esc(tip)}</p></div></section>` : ''}
      ${guideLink(p.n) ? `<section><h4>From the guide</h4>${guideLink(p.n)}</section>` : ''}
      ${next ? `<section><h4>Next on your flight</h4><button class="next-row" data-place-next="${esc(next.id)}">${next.img ? `<img src="${esc(next.img.u)}" alt="">` : `<span class="nx-ico">${icon(next.c, 22)}</span>`}<span><b>${esc(next.n)}</b><small>${esc(kindLabel(next))} · ${sideWord(next.side)}</small></span><em>${fmtDur(Math.max(0, next.along - p.along) / 800)} later</em></button></section>` : ''}
      <div class="place-foot">
        <span class="ok">${icon('check', 15)} Works in flight mode</span>
        ${p.wp ? `<a href="https://en.wikipedia.org/wiki/${encodeURIComponent(p.wp.replace(/ /g, '_'))}" target="_blank" rel="noopener">Wikipedia →</a>` : ''}
      </div>
      <div class="src">Text from Wikipedia (CC BY-SA) and Wikidata</div>
    </div></div>`;
  ov.classList.add('show');
  ov.querySelector('.place-box').scrollTop = 0;
  const resume = state.tour && state.simRunning;
  if (resume) setTourPlaying(false);
  ov.onclick = (e) => {
    const gl = e.target.closest('[data-guide]');
    if (gl) { ov.classList.remove('show'); openGuideEntry('land', gl.dataset.guide); return; }
    const nx = e.target.closest('[data-place-next]');
    if (nx) { openPlace(nx.dataset.placeNext); return; }
    if (e.target === ov || e.target.closest('[data-place="close"]')) { ov.classList.remove('show'); if (resume && state.tour) setTourPlaying(true); }
  };
}
function setTourPlaying(on) {
  if (on) { if (state.simAlong >= state.route.path.total - 0.5) state.simAlong = 0; playSim(); } else pauseSim();
  const b = $('#tour-play'); if (b) b.innerHTML = icon(on ? 'pause' : 'play', 18);
}

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
  state.map.on('click', (e) => {
    const hit = state.map.getLayer('place-dot') && state.map.queryRenderedFeatures(e.point, { layers: ['place-dot'] })[0];
    if (hit) { openPlace(hit.properties.id); return; }
    if (document.body.classList.contains('flying')) document.body.classList.toggle('ui-off');
  });
  state.map.on('style.load', addOverlays);
  // small always-visible credits line, built from the current style's sources
  state.map.on('styledata', updateCredits);
  state.map.on('error', (e) => { if (!/Not available offline/.test(e?.error?.message || '')) console.warn(e?.error || e); });
  state.map.on('zoomstart', (e) => { if (e.originalEvent) state.userZooming = true; });
  state.map.on('zoomend', () => {
    if (!state.userZooming) return;
    state.userZooming = false;
    if (state.live) state.zoomBias = Math.max(-5, Math.min(4, state.map.getZoom() - baseZoom(motion.dAlt || state.live.alt)));
  });
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
  for (const id of ['route', 'pois', 'track', 'feat', 'places']) if (!m.getSource(id)) m.addSource(id, { type: 'geojson', data: emptyFC() });
  const add = (layer) => { if (!m.getLayer(layer.id)) m.addLayer(layer); };
  const isK = (k) => ['==', ['get', 'kind'], k];
  add({ id: 'feat-park', type: 'fill', source: 'feat', filter: isK('p'), paint: { 'fill-color': '#3ddc97', 'fill-opacity': earth ? 0.16 : 0.22, 'fill-antialias': false } });
  add({ id: 'feat-river-glow', type: 'line', source: 'feat', filter: isK('r'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#4cc9f0', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 3, 10, 9], 'line-opacity': 0.35, 'line-blur': 3 } });
  add({ id: 'feat-river', type: 'line', source: 'feat', filter: isK('r'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': earth ? '#a5ecff' : '#1d8fd0', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 2.2] } });
  if (earth) { try { m.setSourceTileLodParams(4, 6); } catch { /* older engine */ } }
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
  if (m.getStyle().glyphs) {
    add({
      id: 'feat-label', type: 'symbol', source: 'feat',
      layout: {
        'text-field': ['get', 'name'], 'text-font': labelFont(), 'text-size': 12,
        'symbol-placement': ['match', ['get', 'kind'], 'r', 'line', 'point'], 'text-max-angle': 30, 'symbol-spacing': 420, 'text-optional': true,
      },
      paint: { 'text-color': ['match', ['get', 'kind'], 'p', '#b9ffd9', '#cdf6ff'], 'text-halo-color': 'rgba(4,12,24,0.85)', 'text-halo-width': 1.5 },
    });
  }
  add({
    id: 'place-dot', type: 'circle', source: 'places',
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, 5, 9, 8], 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2, 'circle-pitch-alignment': 'map' },
  });
  if (m.getStyle().glyphs) {
    add({
      id: 'place-label', type: 'symbol', source: 'places',
      layout: { 'text-field': ['get', 'name'], 'text-font': labelFont(), 'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11.5, 9, 14.5], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-optional': true, 'symbol-sort-key': ['-', 100, ['get', 's']] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(5,10,20,0.9)', 'text-halo-width': 1.7 },
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
  // With famous sights on the route, the old city dots are just noise: keep their names only.
  if (m.getLayer('poi-dot')) m.setLayoutProperty('poi-dot', 'visibility', r?.places?.length ? 'none' : 'visible');
  m.getSource('pois').setData({
    type: 'FeatureCollection',
    features: (r?.pois || []).map((p) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { label: p.label, kind: p.kind, side: p.side, rank: p.rank },
    })),
  });
  m.getSource('feat')?.setData(r && state.featData ? state.featData : emptyFC());
  const shown = r ? (state.trip ? state.featured : state.planFeatured) || [] : [];
  m.getSource('places')?.setData({
    type: 'FeatureCollection',
    features: shown.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p.p }, properties: { id: p.id, name: p.n, s: p.s, color: CAT[p.c]?.color || '#fff' } })),
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
  for (const l of m.getStyle().layers) if (l.id.startsWith('n-')) m.setLayoutProperty(l.id, 'visibility', vis);
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
    return `<div class="note warn"><b>iPhone tip:</b> tap <b>Share → Add to Home Screen</b>, open Flight Companion from your home screen, and save your flight <i>there</i>. Safari and the home-screen app keep separate offline storage.</div>`;
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

const SAMPLES = [['LKO', 'GAU', 'Kanchenjunga off the left wing'], ['DEL', 'SXR', 'Into the Himalaya'], ['DEL', 'BLR', 'Parks, caves, the Deccan']];
function renderHome() {
  stopLive();
  document.body.classList.remove('planning');
  state.tour = null; document.body.classList.remove('touring');
  state.route = null; state.trip = null; state.track = []; state.featured = []; state.planFeatured = [];
  document.body.classList.remove('dim');
  if (state.vectorStyle) setMapStyle(state.vectorStyle, 'vector');
  refreshOverlayData();
  state.map?.easeTo({ center: [78.5, 21], zoom: 3.3, bearing: 0, pitch: 0, duration: 600 });
  const online = navigator.onLine;
  const trips = state.trips.map((t) => {
    const pct = (a, b) => Math.round(((a || 0) / (b || 1)) * 100);
    const photos = (t.photos || []).slice(0, 3);
    let status;
    if (t.pending) {
      status = `<div class="tc-bar"><div data-dl-bar="${esc(t.id)}" style="width:${pct(t.done, t.files)}%"></div></div>
        <div class="tc-meta"><span data-dl-text="${esc(t.id)}">${downloads.has(t.id) ? 'Saving' : 'Paused'} ${pct(t.done, t.files)}%</span>${downloads.has(t.id) ? '' : `<button class="tc-btn" data-action="resume" data-id="${esc(t.id)}">Resume</button>`}</div>`;
    } else {
      status = `<div class="tc-meta"><span class="ok">${icon('check', 15)} Ready offline</span>${t.sights ? `<span>${t.sights} sights</span>` : ''}${t.bytes ? `<span class="muted">${fmtMB(t.bytes)}</span>` : ''}
        ${t.sharpPending ? `<span class="muted" data-dl-text="${esc(t.id)}">sharpening ${pct(t.sharpDone, t.sharpFiles)}%</span>` : ''}</div>`;
    }
    return `<div class="tcard">
      <button class="tc-open" data-action="open" data-id="${esc(t.id)}" aria-label="Open ${esc(t.from.code)} to ${esc(t.to.code)}">
        ${photos.length ? `<span class="tc-photos">${photos.map((u) => `<img src="${esc(u)}" alt="" loading="lazy">`).join('')}</span>` : ''}
        <span class="tc-body">
          <span class="tc-head"><b>${esc(t.from.code)} → ${esc(t.to.code)}</b><small>${esc(fmtDate(t.date) || '')}</small></span>
          <span class="tc-sub">${esc([t.airline || t.carrier ? `${t.airline || ''} ${t.carrier || ''}${t.flight || ''}`.trim() : `${t.from.city} to ${t.to.city}`, t.seat ? `Seat ${t.seat}${t.side ? `, ${sideWord(t.side)} window` : ''}` : t.side ? `${sideWord(t.side)} window` : ''].filter(Boolean).join(' · '))}</span>
        </span>
      </button>
      <div class="tc-foot">${status}<button class="tc-del" data-action="delete" data-id="${esc(t.id)}" aria-label="Delete this flight">${icon('trash', 16)}</button></div>
    </div>`;
  }).join('');
  app.innerHTML = `
    <div class="home-screen">
      <div class="home-scroll">
        <header class="brand"><span class="logo">${icon('plane', 22)}</span><div><h1>Flight Companion</h1><p>What's below your window, even in flight mode</p></div></header>
        ${banner()}
        ${state.installEvt ? `<button class="wide" data-action="install">Install app</button>` : ''}
        ${trips ? `<h2 class="sec">Your flights</h2><div class="tcards">${trips}</div>` : ''}
        ${online ? `<h2 class="sec">Watch a sample flight</h2>
        <div class="samples">${SAMPLES.map(([a, b, note]) => `<button class="sample" data-action="sample" data-r="${a}-${b}"><span class="s-play">${icon('play', 13)}</span><b>${a} → ${b}</b><small>${note}</small></button>`).join('')}</div>` : '<div class="note">You are offline. Saving a new flight needs internet.</div>'}
        <h2 class="sec">Guides</h2>
        <div class="g-home">
          <button class="g-home-card" data-action="guides" data-k="clouds"><span class="gh-ico">${icon('cloud', 22)}</span><b>Clouds</b><small>What you see above the clouds, and what it means for your flight</small></button>
          <button class="g-home-card" data-action="guides" data-k="land"><span class="gh-ico land">${icon('terrain', 22)}</span><b>India from the air</b><small>Ravines, deltas, salt pans, tea gardens and more</small></button>
        </div>
        <div class="foot"><span id="storage"></span>${state.trips.length ? `<button class="link" data-action="clear">Clear all offline maps</button>` : ''}</div>
      </div>
      <div class="home-bar">
        <div class="hb-row">
          <label class="btn-primary ${online ? '' : 'disabled'}">
            <input type="file" id="ticket-file" accept="image/*,application/pdf" ${online ? '' : 'disabled'} hidden>
            ${icon('scan', 18)} Scan boarding pass
          </label>
          <button class="btn-secondary" data-action="new" ${online ? '' : 'disabled'}>Enter route</button>
        </div>
        <div class="hb-note">${icon('lock', 13)} Your boarding pass is read on this phone, never uploaded</div>
      </div>
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

function ticketSide() {
  const t = state.ticket;
  if (t.side) return t.side;
  const si = seatInfo(t.seat);
  return si && si.side !== 'C' ? si.side : '';
}

function renderTicket() {
  const t = state.ticket;
  app.innerHTML = `<button class="back glass" data-action="home" aria-label="Back">${icon('back', 20)}</button>
    <div class="sheet glass ticket">
      <div class="pass">
        <div class="pass-top"><span>${esc(t.airline || 'Flight')}</span><span>${esc(t.carrier || '')} ${esc(t.flight || '')}</span></div>
        <div class="pass-route">
          <div><b>${esc(t.from.code)}</b><small>${esc(t.from.city)}</small></div>
          <div class="pass-plane">${icon('plane', 22)}</div>
          <div><b>${esc(t.to.code)}</b><small>${esc(t.to.city)}</small></div>
        </div>
        <div class="pass-meta">
          <div><span>Date</span><b>${esc(fmtDate(t.date) || '—')}</b></div>
          <div><span>Seat</span><b>${esc(t.seat || '—')}</b></div>
          <div><span>PNR</span><b>${esc(t.pnr || '—')}</b></div>
        </div>
      </div>
      ${t.seat ? `<div class="center">${seatHtml(t.seat)}</div>` : '<div class="note">No seat on this pass yet.</div>'}
      <div class="side-pick"><span>Your window is on the</span>
        <div class="seg small" id="ticket-side">
          <button data-action="ticket-side" data-s="L" class="${ticketSide() === 'L' ? 'on' : ''}">Left</button>
          <button data-action="ticket-side" data-s="R" class="${ticketSide() === 'R' ? 'on' : ''}">Right</button>
        </div></div>
      <div class="note tiny">Read from the ${t.source === 'barcode' ? 'boarding pass barcode' : 'ticket text'}${t.legs > 1 ? ` (showing leg 1 of ${t.legs})` : ''}.</div>
      <button class="primary wide" data-action="ticket-ok">Looks right, continue</button>
      <button class="wide ghost" data-action="new">Edit manually</button>
    </div>`;
}

function renderPlan(pre = {}) {
  stopLive(); state.tour = null; document.body.classList.remove('touring');
  document.body.classList.add('planning');
  state.route = null; state.planFeatured = []; refreshOverlayData();
  app.innerHTML = `
    <button class="back glass" data-action="home" aria-label="Back">${icon('back', 20)}</button>
    <div id="time-chip"></div>
    <div class="sheet plan ${pre.from && pre.to ? 'collapsed' : ''}">
      <div id="route-edit">
      <h2>${pre.flight ? `${esc(pre.carrier)} ${esc(pre.flight)}` : 'Where are you flying?'}</h2>
      <div class="field"><label>From</label><input id="from" placeholder="Airport code or city, e.g. DEL" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-from"></div></div>
      <div class="field"><label>To</label><input id="to" placeholder="e.g. BLR" autocomplete="off" autocapitalize="characters"><div class="dd" id="dd-to"></div></div>
      <div class="row2">
        <div class="field"><label>Seat (optional)</label><input id="seat" placeholder="e.g. 14A" autocomplete="off" autocapitalize="characters" maxlength="4" value="${esc(pre.seat || '')}"></div>
        <div class="field"><label>Flight (optional)</label><input id="flightno" placeholder="e.g. QP1812" autocomplete="off" autocapitalize="characters" value="${esc(pre.carrier && pre.flight ? pre.carrier + pre.flight : '')}"></div>
      </div>
      </div>
      <div id="plan-info"></div>
    </div>`;
  const picked = { from: pre.from || null, to: pre.to || null };
  const meta = { ...pre };
  state.planMeta = meta;
  if (picked.from) $('#from').value = `${picked.from.code} · ${picked.from.city}`;
  if (picked.to) $('#to').value = `${picked.to.code} · ${picked.to.city}`;
  const go = () => { if (picked.from && picked.to) { $('.sheet.plan')?.classList.add('collapsed'); preview(picked.from, picked.to, meta); } };
  state.planGo = go;
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
  $('#seat').addEventListener('input', (e) => { meta.seat = e.target.value.trim().toUpperCase(); meta.side = ''; go(); });
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
  const night = meta.night ?? state.night;
  const s = route.places?.length ? sideHighlights(route.places, { night, total: route.path.total }) : { L: route.sides.nL, R: route.sides.nR };
  const best = Math.abs(s.L - s.R) <= Math.max(2, 0.25 * Math.max(s.L, s.R)) ? null : s.L > s.R ? 'L' : 'R';
  const si0 = seatInfo(meta.seat);
  const pickedSide = meta.side || (si0 && si0.side !== 'C' ? si0.side : '');
  const si = pickedSide ? { ...(si0 || { kind: 'window' }), side: pickedSide } : si0;
  const { spots, all } = routeSpots(from, to);
  const tiles = corridorTiles(route.path, PLAN, all);
  const vec = state.vectorStyle ? buildUrlList(state.vectorStyle, route.path, spots, tiles) : { estBytes: 0, urls: [] };
  const eStyle = buildEarthStyle(state.vectorStyle, hiAreasFor(from, to));
  const earth = buildUrlList(eStyle, route.path, spots, tiles, { skipVector: true });
  const sharp = buildUrlList(eStyle, route.path, spots, corridorTiles(route.path, sharpPlan(pickedSide), []), { skipVector: true });
  const feat = featuredFor(route, pickedSide, night);
  state.planFeatured = feat; refreshOverlayData();
  const warn = si && si.side !== 'C' && best && best !== si.side
    ? `<div class="note warn">The ${sideWord(best)} side has more to see. Ask to switch seats if you can.</div>` : '';
  const tc = $('#time-chip');
  if (tc) tc.innerHTML = `<button class="map-chip glass" data-action="plan-time" data-n="${night ? 0 : 1}" aria-label="Switch between a day and a night flight">${icon(night ? 'moon' : 'sun', 16)} ${night ? 'Night' : 'Day'} flight</button>`;
  const sub = [fmtKm(route.path.total), `about ${fmtDur(flightHours(route.path.total))}`, fmtDate(meta.date), meta.carrier && meta.flight ? `${meta.carrier} ${meta.flight}` : ''].filter(Boolean).join(' · ');
  const sideBtn = (k) => `<button class="side-btn ${k} ${si?.side === k ? 'on' : ''}" data-action="pick-side" data-s="${k}" aria-pressed="${si?.side === k}">
      <span class="sb-t">${k === 'L' ? `${icon('left', 15)} Left window` : `Right window ${icon('right', 15)}`}</span>
      <span class="sb-s">${s[k]} sight${s[k] === 1 ? '' : 's'}${best === k ? ' · best side' : ''}</span></button>`;
  info.innerHTML = `
    <div class="route-head">
      <div><h1>${esc(from.city)} → ${esc(to.city)}</h1><div class="sub">${esc(sub)}</div></div>
      <button class="link" data-action="edit-route">Change</button>
    </div>
    <div class="sides" role="group" aria-label="Your window side">${sideBtn('L')}${sideBtn('R')}</div>
    ${si && si.side !== 'C' ? warn : `<div class="hint">Tap the side you're sitting on, facing forward.</div>`}
    ${featuredHtml(route, feat, night, pickedSide)}
    ${landsHtml(route)}
    <div class="cta">
      <button class="btn-primary big" id="btn-save"><span>Save for flight mode</span><small id="mb">${sizeLine(vec.estBytes + earth.estBytes, sharp.estBytes, true, pickedSide)}</small></button>
      ${feat.length ? `<button class="btn-secondary" data-action="watch">${icon('play', 14)} Watch a one-minute preview</button>` : ''}
      <div id="save-progress"></div>
    </div>`;
  $('#btn-save').onclick = () => saveTrip(route, meta, true);
}

async function saveTrip(route, meta, withEarth) {
  const btn = $('#btn-save'), box = $('#save-progress');
  btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    await navigator.serviceWorker?.ready;
    const style = await buildStyle();
    const si = seatInfo(meta.seat);
    const side = meta.side || (si && si.side !== 'C' ? si.side : '');
    const { spots, all } = routeSpots(route.from, route.to);
    const tiles = corridorTiles(route.path, PLAN, all);
    const ess = new Set(buildUrlList(style, route.path, spots, tiles).urls);
    const earthStyle = withEarth ? buildEarthStyle(style, hiAreasFor(route.from, route.to)) : null;
    let sharp = [];
    if (earthStyle) {
      buildUrlList(earthStyle, route.path, spots, tiles).urls.forEach((u) => ess.add(u));
      sharp = buildUrlList(earthStyle, route.path, spots, corridorTiles(route.path, sharpPlan(side), []), { skipVector: true }).urls.filter((u) => !ess.has(u));
    }
    (state.guides ? Object.values(state.guides).flatMap((g) => g.entries) : []).forEach((e) => e.img && ess.add(e.img.u));
    if (route.places?.length) imageUrls(route.places, { total: route.path.total, hours: flightHours(route.path.total) }).forEach((u) => ess.add(u));
    const id = `${route.from.code}-${route.to.code}-${Date.now().toString(36)}`;
    await saveStyle(id, style);
    if (earthStyle) await saveStyle(`${id}-earth`, earthStyle);
    await Promise.all(['/data/places.json', '/data/airports.json', '/data/airlines.json', '/data/geo.json'].map((u) => fetch(u).catch(() => {})));
    const lists = { ess: [...ess], sharp };
    const trip = {
      id, from: route.from, to: route.to, total: route.path.total,
      carrier: meta.carrier || '', flight: meta.flight || '', airline: meta.airline || (meta.carrier && state.airlines?.[meta.carrier]) || '',
      seat: meta.seat || '', side, date: meta.date || null, night: meta.night ?? state.night,
      photos: featuredFor(route, side, meta.night ?? state.night).filter((p) => p.img).slice(0, 3).map((p) => p.img.u),
      sights: featuredFor(route, side, meta.night ?? state.night).length,
      files: lists.ess.length, done: 0, sharpFiles: sharp.length, sharpDone: 0, bytes: 0, failed: 0,
      pending: true, sharpPending: sharp.length > 0, earth: !!earthStyle, hi: true, createdAt: Date.now(),
    };
    await saveStyle(`${id}-urls`, lists);
    state.trips = [trip, ...state.trips.filter((t) => !(t.from.code === trip.from.code && t.to.code === trip.to.code))];
    saveTrips();
    box.dataset.trip = id;
    box.innerHTML = `<div class="bar"><div data-dl-bar="${esc(id)}"></div></div><div class="note" data-dl-text="${esc(id)}">Getting your flight ready…</div>
      <div class="note tiny">${'BackgroundFetchManager' in window ? 'You can leave the app: it keeps downloading in the background.' : 'If you leave the app, it carries on from where it stopped when you come back.'}</div>`;
    btn.remove();
    await runDownload(trip, lists);
  } catch (e) {
    console.error(e);
    btn.disabled = false; btn.textContent = 'Try again';
    box.innerHTML = `<div class="note warn">Could not save: ${esc(e.message)}</div>`;
  }
}

// ---------- downloads that survive leaving the app ----------
const downloads = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitVisible = () => (document.visibilityState === 'visible' ? Promise.resolve() : new Promise((r) => {
  const f = () => { if (document.visibilityState === 'visible') { document.removeEventListener('visibilitychange', f); r(); } };
  document.addEventListener('visibilitychange', f);
}));
const normLists = (l) => (Array.isArray(l) ? { ess: l, sharp: [] } : { ess: l?.ess || [], sharp: l?.sharp || [] });

function dlUI(id, text, frac) {
  document.querySelectorAll(`[data-dl-text="${id}"]`).forEach((el) => { el.textContent = text; });
  if (frac != null) document.querySelectorAll(`[data-dl-bar="${id}"]`).forEach((el) => { el.style.width = `${Math.min(100, frac * 100)}%`; });
}

// Download a list, then retry failures a few times (waiting until the app is visible again).
async function fetchAll(list, onProgress) {
  let res = await prefetch(list, onProgress);
  let bytes = res.bytes;
  for (let round = 0; res.failedUrls.length && round < 5; round++) {
    await waitVisible();
    await sleep(1500 * (round + 1));
    res = await prefetch(res.failedUrls, () => {});
    bytes += res.bytes;
  }
  return { bytes, failed: res.failedUrls.length };
}

function runDownload(trip, lists) {
  if (downloads.has(trip.id)) return downloads.get(trip.id);
  const { ess, sharp } = normLists(lists);
  const job = (async () => {
    requestWake();
    let lastSave = 0;
    const persist = () => { if (Date.now() - lastSave > 3000) { lastSave = Date.now(); saveTrips(); } };
    if (await startBackgroundFetch(trip, [...(trip.pending ? ess : []), ...(trip.sharpPending ? sharp : [])]).catch(() => false)) await waitBackgroundFetch(trip);
    if (trip.pending) {
      const r = await fetchAll(ess, ({ done, total, bytes }) => {
        trip.done = done; persist();
        dlUI(trip.id, `Getting your flight ready… ${Math.round((done / total) * 100)}% · ${fmtMB((trip.bytes || 0) + bytes)}`, done / total);
      });
      await finishEssentials(trip, ess, r.bytes, r.failed);
    }
    if (trip.sharpPending && sharp.length) {
      const r = await fetchAll(sharp, ({ done, total }) => {
        trip.sharpDone = done; persist();
        dlUI(trip.id, `sharpening ${Math.round((done / total) * 100)}%`, done / total);
      });
      Object.assign(trip, { sharpPending: false, sharpDone: sharp.length, bytes: (trip.bytes || 0) + r.bytes });
      saveTrips();
      dlUI(trip.id, 'Saved, with extra-sharp ground on your side', 1);
      if (!state.route && !state.ticket && document.querySelector('.home')) renderHome();
    }
  })().catch((e) => { console.warn(e); dlUI(trip.id, 'Download paused · it resumes when you reopen the app', null); })
    .finally(() => { downloads.delete(trip.id); if (!state.route) releaseWake(); });
  downloads.set(trip.id, job);
  return job;
}

async function finishEssentials(trip, list, bytes, failed) {
  dlUI(trip.id, 'Finding rivers, national parks and reserves on your route…', 1);
  try {
    const style = await loadSavedStyle(trip.id);
    const vtpl = Object.values(style.sources).find((x) => x.type === 'vector' && x.tiles)?.tiles[0].replace(/^fwc:\/\//, 'https://');
    const prefix = vtpl ? new URL(vtpl.split('{z}')[0]).href : null;
    const z10 = prefix ? list.filter((u) => u.startsWith(prefix) && /\/10\/\d+\/\d+\.pbf$/.test(u)) : [];
    await saveStyle(`${trip.id}-feat`, await extractTileFeatures(z10, await openTileCache()));
  } catch (e) { console.warn('feature extraction failed', e); }
  Object.assign(trip, { pending: false, done: list.length, bytes: (trip.bytes || 0) + bytes, failed });
  const i = state.trips.findIndex((t) => t.id === trip.id);
  if (i >= 0) state.trips[i] = trip;
  saveTrips();
  const pct = Math.round((failed / list.length) * 100);
  const box = document.querySelector(`#save-progress[data-trip="${trip.id}"]`);
  if (box) {
    box.innerHTML = `<div class="note ${pct > 10 ? 'warn' : 'ok'}">${pct > 10 ? `Saved, but ${failed} of ${list.length} map files failed. Try again on better Wi-Fi.` : '✓ Ready to fly. It works in flight mode.'}</div>
      ${trip.sharpPending ? `<div class="bar thin"><div data-dl-bar="${esc(trip.id)}"></div></div><div class="note tiny" data-dl-text="${esc(trip.id)}">Sharpening your window view…</div>` : ''}
      <button class="primary wide" data-action="open" data-id="${esc(trip.id)}">Open flight view</button>`;
  } else if (!state.route && !state.ticket && document.querySelector('.home')) renderHome();
}

// Android / Chrome: hand the download to the browser so it continues with the app closed.
async function startBackgroundFetch(trip, list) {
  const reg = await navigator.serviceWorker?.ready;
  if (!reg?.backgroundFetch || !list.length) return false;
  if (await reg.backgroundFetch.get(trip.id)) return true;
  const missing = await missingUrls(list);
  if (missing.length < 40) return false;
  await reg.backgroundFetch.fetch(trip.id, missing.map((u) => new Request(u, { mode: 'cors' })), {
    title: `Saving ${trip.from.code} → ${trip.to.code} for offline`,
    icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
  });
  return true;
}
async function waitBackgroundFetch(trip) {
  const reg = await navigator.serviceWorker.ready;
  const bg = await reg.backgroundFetch.get(trip.id);
  if (bg) {
    const ok = await new Promise((resolve) => {
      let last = -1, lastChange = Date.now();
      const tick = () => {
        if (bg.downloaded !== last) { last = bg.downloaded; lastChange = Date.now(); }
        dlUI(trip.id, `Downloading in the background · ${fmtMB(bg.downloaded)} · you can leave the app`, null);
        if (bg.result) done(true);
      };
      // if it makes no progress for 45 s while you're watching, take over in the foreground
      const timer = setInterval(() => {
        if (document.visibilityState === 'visible' && Date.now() - lastChange > 45000) { bg.abort().catch(() => {}); done(false); }
      }, 5000);
      function done(v) { clearInterval(timer); bg.removeEventListener('progress', tick); resolve(v); }
      bg.addEventListener('progress', tick);
      tick();
    });
    if (!ok) return;
  }
  const meta = await caches.open('fw-data-v1');
  for (let i = 0; i < 40 && !(await meta.match(`/__fw/bg-${trip.id}-done`)); i++) await sleep(1000);
}

async function resumePending() {
  if (!navigator.onLine) return;
  for (const t of state.trips.filter((x) => (x.pending || x.sharpPending) && !downloads.has(x.id))) {
    const lists = await loadSavedStyle(`${t.id}-urls`);
    if (lists) runDownload(t, lists); else { t.pending = false; t.sharpPending = false; saveTrips(); }
  }
  if (!state.route && !state.ticket && document.querySelector('.home')) renderHome();
}

async function openTrip(id) {
  const trip = state.trips.find((t) => t.id === id);
  if (!trip) return renderHome();
  app.innerHTML = `<div class="sheet glass"><div class="note">Opening ${esc(trip.from.code)} → ${esc(trip.to.code)}…</div></div>`;
  try { state.progress = JSON.parse(localStorage.getItem(`fw-prog-${trip.id}`) || 'null') || { maxAlong: 0 }; } catch { state.progress = { maxAlong: 0 }; }
  state.storyShown = !!state.progress.storyShown;
  const vs = await loadSavedStyle(trip.id);
  if (vs) state.vectorStyle = vs;
  // Built fresh from the trip's own map style so its night-light layers use tiles already saved.
  state.earthStyle = trip.earth ? buildEarthStyle(state.vectorStyle, trip.hi ? hiAreasFor(trip.from, trip.to) : []) : null;
  state.trip = trip;
  state.route = await makeRoute(trip.from, trip.to);
  if (trip.night != null) state.night = trip.night;
  await loadTripFeatures(trip.id);
  setupPlaces();
  try { state.track = JSON.parse(localStorage.getItem(`fw-track-${trip.id}`) || '[]'); } catch { state.track = []; }
  state.view = state.earthStyle ? '3d' : 'map';
  state.dockOpen = false;
  await applyViewStyle();
  refreshOverlayData();
  renderFly();
  fitRoute(160, state.view === 'map' ? 0 : 50);
}

async function loadTripFeatures(id) {
  state.alerted = new Set();
  try {
    const [geo, osm] = await Promise.all([loadGeo(), id ? loadSavedStyle(`${id}-feat`) : null]);
    const feats = [...geo, ...(osm || [])];
    state.events = buildEvents(state.route.path, feats);
    state.featData = overlayData(feats, state.events);
  } catch (e) { console.warn(e); state.events = []; state.featData = null; }
}

function highlightsHtml(c, events) {
  const bits = [];
  if (c.r) bits.push(`${icon('water', 14)} ${c.r} river${c.r > 1 ? 's' : ''}`);
  if (c.p) bits.push(`${icon('nature', 14)} ${c.p} park${c.p > 1 ? 's' : ''} & reserve${c.p > 1 ? 's' : ''}`);
  if (c.g) bits.push(`${icon('terrain', 14)} ${c.g} range${c.g > 1 ? 's' : ''} & plateau${c.g > 1 ? 's' : ''}`);
  if (c.s) bits.push(`${icon('pin', 14)} ${c.s} state${c.s > 1 ? 's' : ''}`);
  if (c.l) bits.push(`${icon('water', 14)} ${c.l} lake${c.l > 1 ? 's' : ''}`);
  const lines = [...new Set(events.filter((e) => e.type === 't').map((e) => e.name))];
  lines.forEach((n) => bits.push(`${icon('globe', 14)} ${esc(n)}`));
  if (!bits.length) return '';
  return `<div class="highlights"><span class="lbl">On this route</span><div class="chips">${bits.map((b) => `<span>${b}</span>`).join('')}</div>${state.trip ? '' : '<small>National parks and reserves are found when you save.</small>'}</div>`;
}

function mySide() { return state.trip?.side || ''; }
const effLook = () => (state.look === 'side' ? (mySide() || 'L') : state.look);

// ---------- flight screen ----------
function renderFly() {
  const r = state.route, t = state.trip;
  document.body.classList.add('flying');
  app.innerHTML = `
    <div class="fly-top">
      <button class="ibtn" data-action="home" aria-label="Back">${icon('back', 20)}</button>
      <div class="seg mini" id="views">
        <button data-action="view" data-v="map" class="${state.view === 'map' ? 'on' : ''}">Map</button>
        <button data-action="view" data-v="3d" class="${state.view === '3d' ? 'on' : ''}" ${state.earthStyle ? '' : 'disabled'}>3D</button>
        <button data-action="view" data-v="window" class="${state.view === 'window' ? 'on' : ''}" ${state.earthStyle ? '' : 'disabled'}>Window</button>
      </div>
      <button class="ibtn ${state.night ? 'on' : ''}" data-action="night" id="btn-night" aria-label="Day or night">${icon(state.night ? 'moon' : 'sun', 19)}</button>
    </div>
    <div class="stats-line" id="stats">
      <span><b id="h-alt">—</b> ft</span><span><b id="h-spd">—</b> km/h</span><span>lands <b id="h-eta">—</b></span><span class="hide-sm"><b id="h-hdg">—</b></span>
    </div>
    <div class="look-float seg mini ${state.view === 'window' ? '' : 'hidden'}" id="look-float" aria-label="Which way to look">
      <button data-action="look" data-l="L" class="${effLook() === 'L' ? 'on' : ''}">${icon('left', 14)} Left</button>
      <button data-action="look" data-l="F" class="${effLook() === 'F' ? 'on' : ''}">Front</button>
      <button data-action="look" data-l="R" class="${effLook() === 'R' ? 'on' : ''}">Right ${icon('right', 14)}</button>
    </div>
    <div id="window-hint" class="window-hint hidden"></div>
    <div id="toast" class="toast" aria-live="polite"></div>
    ${state.tour ? tourBarHtml() : state.featured.length ? '<div id="strip" class="strip" aria-label="Sights along your flight"></div>' : ''}
    <div class="tap-hint">Tap to show controls</div>
    <div class="dock glass ${state.dockOpen ? 'open' : ''}" id="dock">
      <div class="dock-row" data-action="dock">
        <span id="gps-dot" class="dot"></span>
        <div class="dock-text">
          <div class="dock-main" id="below-line"><b>${esc(r.from.city)} → ${esc(r.to.city)}</b></div>
          <div class="dock-sub2"><span id="gps-word">GPS off</span> · <span id="h-rem">${Math.round(r.path.total).toLocaleString()}</span> km to go</div>
        </div>
        <span class="chev">${icon('up', 20)}</span>
      </div>
      <div class="dock-body">
        <div class="bar thin"><div id="prog"></div></div>
        <div class="dock-sub"><span id="gps-pill" class="pill">GPS off</span><span id="seat-line">${t.seat ? `Seat ${esc(t.seat)}${mySide() ? ` · ${sideWord(mySide())} side` : ''}<span id="faces"></span>` : ''}</span></div>
        <div id="below" class="below-big"></div>
        <div id="land"></div>
        <div id="upcoming" class="upcoming"></div>
        ${state.events.length ? highlightsHtml(summary(state.events), state.events) : ''}
        <div id="look-row" class="look-row ${state.view === 'window' ? '' : 'hidden'}">
          <div class="seg small">
            <button data-action="look" data-l="L" class="${effLook() === 'L' ? 'on' : ''}">Left</button>
            <button data-action="look" data-l="F" class="${effLook() === 'F' ? 'on' : ''}">Front</button>
            <button data-action="look" data-l="R" class="${effLook() === 'R' ? 'on' : ''}">Right</button>
          </div>
          <input type="range" id="tilt" min="55" max="85" value="${state.tilt}" aria-label="Look down or up">
          <button class="ibtn small ${state.frame ? 'on' : ''}" data-action="frame" title="Window frame" aria-label="Window frame">${icon('film', 16)}</button>
        </div>
        <div class="controls">
          <button class="primary ${state.gpsWanted ? 'on' : ''}" data-action="gps" id="btn-gps">${state.gpsWanted ? 'Stop GPS' : 'Start GPS'}</button>
          <button data-action="sim" id="btn-sim">Simulate</button>
          <button class="icon ${state.follow ? 'on' : ''}" data-action="follow" id="btn-follow" title="Follow the plane" aria-label="Follow the plane">${icon('gps', 19)}</button>
          <button class="icon" data-action="story" title="Flight story" aria-label="Flight story">${icon('film', 19)}</button>
          <button class="icon" data-action="guides" title="Guides" aria-label="Guides">${icon('book', 19)}</button>
        </div>
        ${state.trip?.pending ? `<div class="note warn">Maps are still downloading (<span data-dl-text="${esc(state.trip.id)}">${Math.round(((state.trip.done || 0) / (state.trip.files || 1)) * 100)}%</span>). Keep the app open on Wi-Fi before you fly.</div>` : ''}
        <div id="sim-row" class="sim-row hidden">
          <button class="icon" data-action="play" id="btn-play" aria-label="Play or pause">${icon('play', 18)}</button>
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
  $('#tour-range')?.addEventListener('input', (e) => {
    state.simAlong = (e.target.value / 1000) * state.route.path.total;
    ingest(simState(state.simAlong), true);
    updateTour();
  });
  document.body.classList.toggle('touring', !!state.tour);
  document.body.classList.toggle('dock-open', !!state.dockOpen);
  stripNext = null; renderStrip(0, 0, null, 0);
  updateWindowHint();
  updateCabin();
  if (state.gpsWanted) {
    setPill(state.lastFix && Date.now() - state.lastFix.t < 30000 ? 'GPS on' : 'Searching…', state.lastFix ? 'ok' : 'wait');
    if (state.lastFix && Date.now() - state.lastFix.t < 120000) ingest(state.lastFix.s, true);
  }
  if (state.live) renderInfo(true);
}

function setDock(open) {
  state.dockOpen = open;
  document.body.classList.toggle('dock-open', open);
  $('#dock')?.classList.toggle('open', open);

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
  <path d="M-400 271 L318 150 Q330 147 334 150 L338 160 L-400 486 Z" fill="url(#wg)"/>
  <path d="M318 150 Q331 146 336 132 L352 46 Q354 40 359 42 L362 46 L347 152 Q344 158 336 160 Z" fill="url(#wl)"/>
  <path d="M-400 271 L318 150" stroke="rgba(255,255,255,0.35)" stroke-width="1.2" fill="none"/>
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
  $('#look-float')?.classList.toggle('hidden', v !== 'window');
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
    if (state.tour) state.simAlong = Math.min(total, state.simAlong + tourKmS(state.simAlong) * dt);
    else state.simAlong = Math.min(total, state.simAlong + (simState(state.simAlong).speed * state.simSpeed * dt) / 1000);
    const n = simState(state.simAlong);
    setMotion(n);
    target = [n.lon, n.lat];
    if (state.simAlong >= total) { if (state.tour) setTourPlaying(false); else pauseSim(); }
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
    updateTour();
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
  const zoom = state.userZooming ? m.getZoom() : baseZoom(alt) + state.zoomBias;
  if (state.view === '3d') m.jumpTo({ center: pos, bearing: heading, pitch: 64, zoom });
  else m.jumpTo({ center: pos, zoom, pitch: 0, bearing: 0 });
}

// Follow zoom from altitude: close in near the ground, wider at cruise (≈9.6 at 36,000 ft).
function baseZoom(alt) {
  const a = Math.max(300, alt != null && !Number.isNaN(alt) && alt > 0 ? alt : 10500);
  // +1.2 on the old value: closer, so the ground reads as ground rather than a map of India
  const z = 14.8 - Math.log2(a / 700) + (state.view === '3d' ? 0.7 : 0);
  return Math.min(14, Math.max(8.5, z));
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
  const b = $('#btn-play'); if (b) b.innerHTML = icon('pause', 18);
}
function pauseSim() {
  state.simRunning = false;
  const b = $('#btn-play'); if (b) b.innerHTML = icon('play', 18);
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
  state.gpsWanted = true;
  setPill('Searching…', 'wait');
  const b = $('#below'); if (b && !state.lastFix) b.innerHTML = 'Looking for GPS satellites… keep the phone near the window. The first fix can take a few minutes in flight mode.';
  const btn = $('#btn-gps'); if (btn) { btn.textContent = 'Stop GPS'; btn.classList.add('on'); }
  watchGPS();
  setFollow(true);
  requestWake();
}

// One watch for the whole session. If fixes stop arriving (the phone paused location while
// the app was in the background, or a watch got stuck), it is restarted automatically.
function watchGPS() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  const opts = { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 };
  state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, opts);
  navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 30000, timeout: 30000 });
  state.watchStarted = Date.now();
}

function onFix(p) {
  const c = p.coords;
  const s = { lon: c.longitude, lat: c.latitude, alt: c.altitude, speed: c.speed, heading: c.heading, acc: c.accuracy };
  state.lastFix = { s, t: Date.now() };
  try { localStorage.setItem('fw-lastfix', JSON.stringify(state.lastFix)); } catch { /* storage full */ }
  if (!state.route) return;
  setPill(`GPS ±${Math.round(c.accuracy)} m`, 'ok');
  ingest(s);
  recordTrack(s);
}

function onFixError(err) {
  if (err.code === 1) {
    state.gpsWanted = false;
    setPill('No permission', 'bad');
    const el = $('#below'); if (el) el.innerHTML = 'Location permission was denied. Allow location for this app in your phone settings, then try again.';
    stopGPS();
  } else setPill('Searching…', 'wait');
}

setInterval(() => {
  if (!state.gpsWanted || document.visibilityState !== 'visible') return;
  const last = state.lastFix?.t || 0;
  if (Date.now() - last > 25000 && Date.now() - (state.watchStarted || 0) > 20000) watchGPS();
}, 10000);

function stopGPS() {
  state.gpsWanted = false;
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  const btn = $('#btn-gps'); if (btn) { btn.textContent = 'Start GPS'; btn.classList.remove('on'); }
}
function stopLive() {
  // GPS keeps running when you go back, so it is ready the moment you reopen the flight.
  stopSim(); releaseWake();
  state.live = null; motion.has = false;
  state.marker?.remove(); state.marker = null;
  document.body.classList.remove('flying', 'ui-off', 'in-cabin');
  $('#cabin')?.remove();
}

function recordTrack(s) {
  if (!state.route || !state.map) return;
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
  const w = $('#gps-word'); if (w) w.textContent = text === 'GPS on' ? 'GPS live' : text;
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
// Horizontal strip of the featured sights, in flight order; it keeps the next one in view.
let stripTouched = 0, stripNext = null;
function renderStrip(along, kmh, pos, heading) {
  const el = $('#strip'); if (!el) return;
  if (!el._wired) {
    el._wired = true;
    ['pointerdown', 'wheel', 'touchstart'].forEach((ev) => el.addEventListener(ev, () => { stripTouched = Date.now(); }, { passive: true }));
  }
  const next = state.featured.find((p) => p.along > along - 6);
  const html = state.featured.map((p) => {
    const past = p.along < along - 6;
    const km = p.along - along;
    const when = past ? 'passed' : km < 6 ? 'now' : kmh > 150 ? `in ${fmtDur(km / kmh)}` : `in ${Math.round(km)} km`;
    const sd = p.d < 5 ? 'B' : pos ? sideOf(pos, heading, p.p).side : p.side;
    const c = CAT[p.c] || {};
    return `<button class="scard ${past ? 'past' : ''} ${p === next ? 'next' : ''}" data-action="place" data-id="${esc(p.id)}">
      ${p.img ? `<img src="${esc(p.img.u)}" alt="" loading="lazy">` : `<span class="sico">${c.icon || icon('pin')}</span>`}
      <span class="stext"><span class="badge ${sd}">${sd === 'B' ? 'BELOW' : sd === 'L' ? 'LEFT' : 'RIGHT'}</span><b>${esc(p.n)}</b><small>${esc(when)}</small></span></button>`;
  }).join('');
  setHTML('#strip', html);
  if (next && next.id !== stripNext && Date.now() - stripTouched > 8000) {
    stripNext = next.id;
    const card = el.querySelector(`[data-id="${CSS.escape(next.id)}"]`);
    if (card) el.scrollTo({ left: card.offsetLeft - 8, behavior: 'smooth' });
  }
}

// Only touch the DOM when the content really changed, so taps on rows are never lost mid-redraw.
function setHTML(sel, html) {
  const el = $(sel);
  if (el && el._html !== html) { el.innerHTML = html; el._html = html; }
}
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
  trackProgress(pr, kmh, live);
  if (pr.d > 150 && !live.sim) setPill(`${Math.round(pr.d)} km off route`, 'wait');

  const { near, nd } = nearestPlace(pos);
  const kmhNow = kmh && kmh > 150 ? kmh : null;
  // Far off the planned line, route-based events don't apply; use the actual state below instead.
  const onRoute = pr.d < 60;
  if (onRoute) checkAlerts(pr.along, kmhNow, pos, heading);
  let nowEv = onRoute ? currentEvent(pr.along) : null;
  if (!onRoute) { const st = stateAt(pos); if (st) nowEv = { type: 's', name: st, origin: true, kind: 'over' }; }
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
  const land = ecoAt(state.eco, pos);
  state.landNow = land;
  if (land) line = `${icon('terrain', 16)} <b>${esc(shortEco(land.name))}</b> <span class="muted">below you</span>`;
  setHTML('#land', land ? `<button class="land-card" data-action="land">
      <span class="lc-ico">${icon('terrain', 22)}</span>
      <span class="lc-text"><span class="lbl">Landscape below</span><b>${esc(land.name)}</b><small>${esc(biomeInfo(land.biome).short)}${land.x ? ` · ${esc(units(land.x).split('. ')[0].slice(0, 90))}…` : ''}</small></span></button>` : '');
  const routeNear = onRoute ? (state.route.places || []).filter((p) => Math.abs(p.along - pr.along) < 15 && p.s >= 30 && dist(pos, p.p) < 10).sort((a, b) => b.s - a.s)[0] : null;
  if (routeNear && !nowEv) {
    line = `${CAT[routeNear.c]?.icon || icon('pin')} <b>${esc(routeNear.n)}</b> <span class="muted">below you</span>`;
    big = `<span class="lbl">Below you</span><b data-action="place" data-id="${esc(routeNear.id)}">${esc(routeNear.n)} ›</b><div class="sub">${esc(kindLabel(routeNear))}</div>`;
  }
  if (nowEv) line = `${icon(EV_ICON[nowEv.type], 16)} <b>${esc(eventTitle(nowEv))}</b> <span class="muted">${nowEv.kind === 'near' ? `${Math.round(nowEv.d)} km ${sideWord(nowSide(nowEv, pos, heading))}` : 'now'}</span>`;
  setHTML('#below-line', line);
  setHTML('#below', big);

  const up = r.pois
    .filter((p) => p.along > pr.along + 3 && p.name !== near?.name)
    .slice(0, 40)
    .map((p) => ({ p, d: dist(pos, [p.lon, p.lat]), side: sideOf(pos, heading, [p.lon, p.lat]).side }))
    .filter((x) => x.d < 400)
    .sort((a, b) => (b.p.rank + (side && b.side === side ? 0.25 : 0)) - (a.p.rank + (side && a.side === side ? 0.25 : 0)))
    .slice(0, 4)
    .sort((a, b) => a.p.along - b.p.along);
  const evs = state.events.filter((e) => e.start > pr.along + 1 && !(e.type === 's' && e.origin)).slice(0, 4);
  const featUp = (state.featured || []).filter((p) => p.along > pr.along + 2).slice(0, 3).map((p) => {
    const ps = sideOf(pos, heading, p.p).side, km = p.along - pr.along;
    return { at: p.along, html: `
        <div class="up place ${side && ps === side ? 'mine' : ''}" data-action="place" data-id="${esc(p.id)}">${p.img ? `<img class="up-img" src="${esc(p.img.u)}" alt="" loading="lazy">` : `<span class="badge ev">${CAT[p.c]?.icon || icon('pin')}</span>`}
        <span class="up-name">${esc(p.n)}<small>${esc(kindLabel(p))} · ${p.d < 5 ? 'below' : sideWord(ps)}</small></span>
        <span class="up-meta">${kmh && kmh > 150 ? fmtDur(km / kmh) : `${Math.round(km)} km`}</span></div>` };
  });
  const rows = [
    ...featUp,
    ...(featUp.length ? [] : up.slice(0, 3)).map(({ p, d, side: ps }) => ({ at: p.along, html: `
        <div class="up ${side && ps === side ? 'mine' : ''}"><span class="badge ${ps}">${ps === 'L' ? 'LEFT' : 'RIGHT'}</span><span class="up-name">${esc(p.label)}</span>
        <span class="up-meta">${Math.round(d)} km${kmh && kmh > 150 ? ` · ${fmtDur(d / kmh)}` : ''}</span></div>` })),
    ...evs.map((e) => {
      const km = e.start - pr.along;
      const sd = e.kind === 'near' ? nowSide(e, pos, heading) : '';
      return { at: e.start, html: `
        <div class="up ev ev-${e.type}" ${e.place ? `data-action="place" data-id="${esc(e.place.id)}"` : ''}>${e.place?.img ? `<img class="up-img" src="${esc(e.place.img.u)}" alt="" loading="lazy">` : `<span class="badge ev">${icon(EV_ICON[e.type], 18)}</span>`}<span class="up-name">${esc(eventTitle(e))}<small>${esc(eventSub(e))}${sd ? ` · ${sideWord(sd)}` : ''}</small></span>
        <span class="up-meta">${kmh && kmh > 150 ? fmtDur(km / kmh) : `${Math.round(km)} km`}</span></div>` };
    }),
  ].sort((a, b) => a.at - b.at).slice(0, 6);
  const upEl = $('#upcoming');
  renderStrip(pr.along, kmh, pos, heading);
  if (upEl) setHTML('#upcoming', rows.length ? `<span class="lbl">Coming up</span>${rows.map((r) => r.html).join('')}` : '');
}

// ---------- flight progress & story ----------
function trackProgress(pr, kmh, live) {
  const t = state.trip; if (!t || t.id === 'demo' && !live.sim) return;
  const P = state.progress || (state.progress = { maxAlong: 0 });
  if (pr.d < 120) P.maxAlong = Math.max(P.maxAlong || 0, pr.along);
  if (!live.sim && kmh && kmh > 150) { P.t0 ??= Date.now(); P.t1 = Date.now(); }
  if (t.id !== 'demo') { try { localStorage.setItem(`fw-prog-${t.id}`, JSON.stringify(P)); } catch { /* ignore */ } }
  const rem = state.route.path.total - pr.along;
  if (!state.storyShown && P.maxAlong > state.route.path.total * 0.6 && rem < 12 && (!kmh || kmh < 420)) {
    state.storyShown = P.storyShown = true;
    if (t.id !== 'demo') try { localStorage.setItem(`fw-prog-${t.id}`, JSON.stringify(P)); } catch { /* ignore */ }
    showToast(icon('film', 22), 'Your flight story is ready', 'Open the panel and tap Story to share it');
    setTimeout(() => openStory(), 2500);
  }
}

async function openStory() {
  if (!state.route || !state.trip) return;
  let ov = $('#story');
  if (!ov) { ov = document.createElement('div'); ov.id = 'story'; document.body.appendChild(ov); }
  ov.innerHTML = '<div class="story-box"><div class="note">Drawing your flight story…</div></div>';
  ov.classList.add('show');
  try {
    const canvas = await makeStory({ trip: state.trip, route: state.route, events: state.events, geo: await loadGeo(), track: state.track, progress: state.progress, pois: state.route.pois });
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const url = URL.createObjectURL(blob);
    const file = new File([blob], `flight-${state.trip.from.code}-${state.trip.to.code}.png`, { type: 'image/png' });
    const canShare = !!navigator.canShare?.({ files: [file] });
    ov.innerHTML = `<div class="story-box">
      <img src="${url}" alt="Flight story for ${esc(state.trip.from.code)} to ${esc(state.trip.to.code)}">
      <div class="story-actions">
        ${canShare ? '<button class="primary" data-story="share">Share</button>' : ''}
        <a class="btn-like ${canShare ? '' : 'primary'}" href="${url}" download="${esc(file.name)}">Save image</a>
        <button data-story="close">Close</button>
      </div>
      ${canShare ? '' : '<div class="note tiny">On iPhone you can also press and hold the image to save it.</div>'}
    </div>`;
    ov.onclick = async (e) => {
      const b = e.target.closest('[data-story]');
      if (e.target === ov || b?.dataset.story === 'close') { ov.classList.remove('show'); return; }
      if (b?.dataset.story === 'share') {
        try { await navigator.share({ files: [file], title: 'My flight', text: `${state.trip.from.city} → ${state.trip.to.city} with Flight Companion` }); } catch { /* cancelled */ }
      }
    };
  } catch (e) {
    console.error(e);
    ov.innerHTML = `<div class="story-box"><div class="note warn">Couldn't draw the story: ${esc(e.message)}</div><div class="story-actions"><button data-story="close">Close</button></div></div>`;
    ov.onclick = (ev) => { if (ev.target === ov || ev.target.closest('[data-story="close"]')) ov.classList.remove('show'); };
  }
}

// ---------- what you're flying over ----------
function currentEvent(along) {
  let best = null;
  for (const e of state.events) {
    if (e.start - along > 4) break;
    const active = e.kind === 'over' ? along >= e.start - 1 && along <= e.end + 1 : Math.abs(along - e.start) < (e.kind === 'near' ? 12 : 4);
    if (!active || (e.type === 's' && e.origin && along > 30)) continue;
    const prio = { r: 6, t: 6, p: 5, k: 4, l: 4, g: 3, s: 2 }[e.type] || 1;
    if (!best || prio > best.prio || (prio === best.prio && e.type === 's' && e.start > best.e.start)) best = { e, prio };
  }
  return best?.e || null;
}
let stateCache = { key: '', name: null };
function stateAt(pos) {
  const key = `${pos[0].toFixed(2)},${pos[1].toFixed(2)}`;
  if (stateCache.key === key) return stateCache.name;
  let name = null;
  for (const [type, nm, , b, geom] of state.geo || []) {
    if (type !== 's' || pos[0] < b[0] || pos[0] > b[2] || pos[1] < b[1] || pos[1] > b[3]) continue;
    if (inPolys(pos, geom)) { name = nm; break; }
  }
  stateCache = { key, name };
  return name;
}
function nowSide(e, pos, heading) {
  return e.point ? sideOf(pos, heading, e.point).side : e.side || 'L';
}
function checkAlerts(along, kmh, pos, heading) {
  const lead = kmh ? (kmh * 75) / 3600 : 10; // ~75 seconds ahead
  for (const it of state.alertItems || []) {
    if (it.start - along > lead + 1) break;
    if (state.alerted.has(it.key)) continue;
    state.alerted.add(it.key);
    const end = it.e?.kind === 'over' ? it.e.end : it.start;
    if (along - end > 2) continue; // already passed
    const km = Math.max(0, it.start - along);
    const when = km < 1.5 ? 'now' : kmh ? `in ${Math.max(1, Math.round((km / kmh) * 60))} min` : `in ${Math.round(km)} km`;
    if (it.p) {
      const p = it.p;
      const sd = p.d < 5 ? '' : sideOf(pos, heading, p.p).side;
      const kicker = `${sd ? `Look ${sideWord(sd)}` : 'Right below you'}${when === 'now' ? ' now' : ` · ${when}`}`;
      showToast(CAT[p.c]?.icon || icon('pin'), p.n, p.desc || `${kindLabel(p)}${sd ? ` · ${Math.round(p.d)} km away` : ''}`, { img: p.img?.u, id: p.id, kicker, side: sd });
      break;
    }
    if (it.land) {
      const l = it.land;
      showToast(icon('terrain', 22), l.name, `${biomeInfo(l.biome).short} · below you for about ${fmtDur((l.end - l.start) / 800)}`, { kicker: 'Now below you', land: true });
      state.landToast = l;
      break;
    }
    const e = it.e;
    let hint;
    if (e.type === 'r' || e.type === 't') hint = 'Look down';
    else if (e.kind === 'near') hint = `Look ${sideWord(nowSide(e, pos, heading))}`;
    else if (e.type === 's') hint = e.extra || '';
    else hint = eventSub(e);
    const title = e.type === 's' ? `Welcome to ${e.name}` : eventTitle(e);
    showToast(icon(EV_ICON[e.type], 22), title, hint, { img: e.place?.img?.u, id: e.place?.id, kicker: when === 'now' ? 'Now' : when[0].toUpperCase() + when.slice(1) });
    break;
  }
}
let toastTimer;
function showToast(ico, title, sub, { img, id, kicker, side, land } = {}) {
  const t = $('#toast'); if (!t) return;
  t.className = `toast ${side ? `side-${side}` : ''}`;
  t.innerHTML = `${img ? `<img class="t-img" src="${esc(img)}" alt="">` : `<span class="t-ico">${ico}</span>`}<span class="t-text">${kicker ? `<span class="t-kick">${side === 'L' ? icon('left', 14) : side === 'R' ? icon('right', 14) : ''}${esc(kicker)}</span>` : ''}<b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
  if (id) { t.dataset.action = 'place'; t.dataset.id = id; } else if (land) { t.dataset.action = 'land'; delete t.dataset.id; delete t.dataset.i; } else { delete t.dataset.action; delete t.dataset.id; }
  t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  try { navigator.vibrate?.(60); } catch { /* not supported */ }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 7000);
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
  if (document.visibilityState !== 'visible' || !state.gpsWanted) return;
  watchGPS();
  if (state.route) requestWake();
});
try { state.lastFix = JSON.parse(localStorage.getItem('fw-lastfix') || 'null'); } catch { /* ignore */ }

// ---------- actions ----------
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a === 'home') {
    if (state.tour?.back) renderPlan(state.tour.back); else renderHome();
  }
  else if (a === 'new') {
    const t = state.ticket; state.ticket = null;
    renderPlan(t ? { from: t.from, to: t.to, seat: t.seat, side: ticketSide(), carrier: t.carrier, flight: t.flight, airline: t.airline, date: t.date } : {});
  } else if (a === 'ticket-ok') {
    const t = state.ticket;
    renderPlan({ from: t.from, to: t.to, seat: t.seat, side: ticketSide(), carrier: t.carrier, flight: t.flight, airline: t.airline, date: t.date });
  } else if (a === 'ticket-side') {
    state.ticket.side = el.dataset.s;
    document.querySelectorAll('[data-action="ticket-side"]').forEach((b) => b.classList.toggle('on', b === el));
  } else if (a === 'pick-side') {
    if (state.planMeta) { state.planMeta.side = el.dataset.s; state.planGo?.(); }
  } else if (a === 'resume') {
    const t = state.trips.find((x) => x.id === el.dataset.id);
    const lists = t && await loadSavedStyle(`${t.id}-urls`);
    if (t && lists) { runDownload(t, lists); renderHome(); }
  } else if (a === 'story') { openStory();
  } else if (a === 'place') { openPlace(el.dataset.id);
  } else if (a === 'guides') { openGuides(el.dataset.k || 'clouds');
  } else if (a === 'land') {
    const i = el.dataset.i;
    openLandscape(i != null ? state.route?.lands?.[+i] : state.landNow);
  } else if (a === 'edit-route') { $('.sheet.plan')?.classList.remove('collapsed');
  } else if (a === 'watch') {
    const r = state.route, m = state.planMeta || {};
    if (!r) return;
    const si = seatInfo(m.seat);
    startTour({ from: r.from, to: r.to, side: m.side || (si && si.side !== 'C' ? si.side : ''), night: m.night ?? state.night, back: { ...m, from: r.from, to: r.to } });
  } else if (a === 'sample') {
    const [f, t] = el.dataset.r.split('-');
    const from = airportByCode(f), to = airportByCode(t);
    if (from && to) { app.innerHTML = '<div class="sheet glass"><div class="note">Preparing the flight…</div></div>'; await loadPlaces(); startTour({ from, to, side: 'L', night: false }); }
  } else if (a === 'tour-play') { setTourPlaying(!state.simRunning);
  } else if (a === 'plan-time') {
    if (state.planMeta) { state.planMeta.night = el.dataset.n === '1'; state.planGo?.(); }
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
    if (state.gpsWanted) { stopGPS(); setPill('GPS off'); releaseWake(); } else startGPS();
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
    document.querySelectorAll('[data-action="look"]').forEach((b) => b.classList.toggle('on', b.dataset.l === state.look));
    updateCabin();
  } else if (a === 'frame') {
    state.frame = !state.frame; el.classList.toggle('on', state.frame); updateCabin();
  } else if (a === 'night') {
    state.night = !state.night;
    el.classList.toggle('on', state.night); el.innerHTML = icon(state.night ? 'moon' : 'sun', 19);
    applyNight(); updateCabin();
    if (state.trip) { state.featured = featuredFor(state.route, mySide(), state.night); state.alertItems = planAlerts(); refreshOverlayData(); }
  }
});

window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; if (!state.route && !state.ticket) renderHome(); });
window.addEventListener('online', () => { if (!state.route && !state.ticket) renderHome(); });
window.addEventListener('offline', () => { if (!state.route && !state.ticket) renderHome(); });

// ---------- boot ----------
(async () => {
  app.innerHTML = `<div class="sheet glass"><div class="note">Loading…</div></div>`;
  await Promise.all([initMap(), loadAirports()]);
  loadAirlines().catch(() => {});
  const qs = new URLSearchParams(location.search);
  if (qs.has('tour')) {
    await loadPlaces();
    const [a, b] = (qs.get('tour') || 'DEL-BLR').toUpperCase().split('-');
    if (qs.has('embed')) document.body.classList.add('embed');
    const v = qs.get('view');
    await startTour({
      from: airportByCode(a) || airportByCode('DEL'), to: airportByCode(b) || airportByCode('BLR'),
      side: (qs.get('side') || 'L').toUpperCase() === 'R' ? 'R' : 'L', night: qs.has('night') ? qs.get('night') !== '0' : false,
      view: ['map', '3d', 'window'].includes(v) ? v : '3d',
    });
  } else if (qs.has('demo')) await startDemo(qs);
  else { loadPlaces().catch(() => {}); renderHome(); resumePending(); }
})();
window.addEventListener('online', () => resumePending());

// ?demo=DEL-BLR[&side=L|R][&night=1][&view=window|3d|map][&speed=10][&embed]
// Replays a flight in the simulator, straight from the network, without saving anything.
async function startDemo(qs) {
  await loadPlaces();
  const [a, b] = (qs.get('demo') || 'DEL-BLR').toUpperCase().split('-');
  const from = airportByCode(a) || airportByCode('DEL');
  const to = airportByCode(b) || airportByCode('BLR');
  const side = (qs.get('side') || 'L').toUpperCase() === 'R' ? 'R' : 'L';
  if (qs.has('embed')) document.body.classList.add('embed');
  state.route = await makeRoute(from, to);
  await loadTripFeatures(null);
  if (qs.has('night')) state.night = qs.get('night') !== '0';
  state.trip = { id: 'demo', from, to, total: state.route.path.total, carrier: '', flight: '', airline: '', seat: side === 'L' ? '14A' : '14F', side, earth: true };
  state.earthStyle = state.vectorStyle ? buildEarthStyle(state.vectorStyle) : null;
  setupPlaces();
  const v = qs.get('view');
  state.view = state.earthStyle ? (['map', '3d', 'window'].includes(v) ? v : 'window') : 'map';
  state.simSpeed = [1, 10, 60].includes(+qs.get('speed')) ? +qs.get('speed') : 10;
  await applyViewStyle();
  refreshOverlayData();
  renderFly();
  startSim();
  state.simAlong = state.route.path.total * (Math.min(90, Math.max(0, +(qs.get('at') ?? 30))) / 100);
  ingest(simState(state.simAlong), true);
}
