// Boarding pass / e-ticket reader. Everything runs on the phone: nothing is uploaded.
// 1. Find the boarding-pass barcode (QR, Aztec, PDF417, Data Matrix) in a photo, screenshot or PDF.
// 2. Parse it as an IATA BCBP string (airline, flight, from/to, date, seat).
// 3. If there is no barcode (e.g. an e-ticket PDF), read the PDF text instead.

let zxing;
async function reader() {
  if (zxing) return zxing;
  const [mod, { default: wasmUrl }] = await Promise.all([
    import('zxing-wasm/reader'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  mod.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
  });
  zxing = mod;
  return mod;
}

const READ_OPTS = {
  formats: ['QRCode', 'Aztec', 'PDF417', 'DataMatrix'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 4,
};

async function decodeImageData(imageData) {
  const { readBarcodes } = await reader();
  const res = await readBarcodes(imageData, READ_OPTS);
  return res.filter((r) => r.isValid && r.text).map((r) => r.text);
}

function canvasFrom(source, maxSide) {
  const w = source.width, h = source.height;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return ctx.getImageData(0, 0, c.width, c.height);
}

async function barcodesFromImage(file) {
  const bmp = await createImageBitmap(file);
  // Try a mid size first (fast), then full detail for small or distant codes.
  for (const side of [1800, 3200]) {
    const found = await decodeImageData(canvasFrom(bmp, side));
    if (found.length) return found;
  }
  return [];
}

async function readPdf(file) {
  const pdfjs = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const codes = [];
  let text = '';
  for (let i = 1; i <= Math.min(doc.numPages, 3); i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += `${tc.items.map((it) => it.str).join(' ')}\n`;
    const viewport = page.getViewport({ scale: 3 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    codes.push(...(await decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height))));
    if (codes.length) break;
  }
  return { codes, text };
}

// ---- IATA BCBP (Resolution 792) ----
export function parseBCBP(raw) {
  const s = raw.replace(/\r?\n/g, '');
  if (!/^M[1-9]/.test(s) || s.length < 58) return null;
  const legsCount = +s[1];
  const name = s.slice(2, 22).trim();
  const legs = [];
  let p = 23;
  for (let i = 0; i < legsCount && p + 37 <= s.length; i++) {
    const leg = {
      pnr: s.slice(p, p + 7).trim(),
      from: s.slice(p + 7, p + 10).trim(),
      to: s.slice(p + 10, p + 13).trim(),
      carrier: s.slice(p + 13, p + 16).trim(),
      flight: s.slice(p + 16, p + 21).trim().replace(/^0+/, ''),
      julian: +s.slice(p + 21, p + 24),
      cabin: s.slice(p + 24, p + 25).trim(),
      seat: normSeat(s.slice(p + 25, p + 29)),
    };
    const varSize = parseInt(s.slice(p + 35, p + 37), 16) || 0;
    legs.push(leg);
    p += 37 + varSize;
  }
  if (!legs.length || !/^[A-Z]{3}$/.test(legs[0].from) || !/^[A-Z]{3}$/.test(legs[0].to)) return null;
  return { name, legs };
}

function normSeat(s) {
  const m = String(s || '').trim().match(/^0*(\d{1,3})\s?([A-K])$/i);
  return m ? `${+m[1]}${m[2].toUpperCase()}` : '';
}

export function julianToDate(day) {
  if (!day || day > 366) return null;
  const now = new Date();
  let best = null;
  for (const y of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const d = new Date(y, 0, day);
    if (!best || Math.abs(d - now) < Math.abs(best - now)) best = d;
  }
  return best;
}

// ---- seat → side of the aircraft ----
// Narrow-body (A–F): A B C | D E F. Wide-body (letters beyond F): A B C | D E F G | H J K.
export function seatInfo(seat, wide) {
  const m = String(seat || '').match(/^(\d{1,3})([A-K])$/);
  if (!m) return null;
  const L = m[2];
  const isWide = wide ?? L > 'F';
  let side, kind;
  if (!isWide) {
    side = L <= 'C' ? 'L' : 'R';
    kind = L === 'A' || L === 'F' ? 'window' : L === 'C' || L === 'D' ? 'aisle' : 'middle';
  } else {
    side = L <= 'C' ? 'L' : L >= 'H' ? 'R' : 'C';
    kind = L === 'A' || L === 'K' ? 'window' : 'other';
  }
  return { row: +m[1], letter: L, side, kind, wide: isWide };
}

// ---- e-ticket text fallback ----
function fromText(text, airports, airlines) {
  const T = text.replace(/\s+/g, ' ');
  const out = {};
  const fl = [...T.matchAll(/\b([A-Z0-9]{2})\s?-?\s?(\d{2,4})\b/g)].find((m) => /[A-Z]/.test(m[1]) && airlines[m[1]]);
  if (fl) { out.carrier = fl[1]; out.flight = fl[2].replace(/^0+/, ''); }
  const codes = [];
  for (const m of T.matchAll(/\b([A-Z]{3})\b/g)) {
    if (airports.has(m[1]) && !codes.includes(m[1])) codes.push(m[1]);
    if (codes.length === 2) break;
  }
  if (codes.length === 2) [out.from, out.to] = codes;
  const seat = T.match(/\bSeat(?:\s*(?:No\.?|Number|#))?\s*[:\-]?\s*(\d{1,2}\s?[A-K])\b/i);
  if (seat) out.seat = normSeat(seat[1]);
  const pnr = T.match(/\b(?:PNR|Booking (?:Ref(?:erence)?|code)|Confirmation)\s*[:#\-]?\s*([A-Z0-9]{6})\b/i);
  if (pnr) out.pnr = pnr[1];
  return out.from && out.to ? out : null;
}

// Main entry: returns { carrier, airline, flight, from, to, date, seat, pnr, source } or throws.
export async function readTicket(file, airportsList, airlines) {
  const airports = new Set(airportsList.map((a) => a[0]));
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let codes = [], text = '';
  if (isPdf) ({ codes, text } = await readPdf(file));
  else codes = await barcodesFromImage(file);

  for (const c of codes) {
    const b = parseBCBP(c);
    if (b) {
      const leg = b.legs[0];
      return {
        carrier: leg.carrier, airline: airlines[leg.carrier] || leg.carrier,
        flight: leg.flight, from: leg.from, to: leg.to,
        date: julianToDate(leg.julian), seat: leg.seat, pnr: leg.pnr,
        legs: b.legs.length, source: 'barcode',
      };
    }
  }
  if (text) {
    const t = fromText(text, airports, airlines);
    if (t) return { ...t, airline: airlines[t.carrier] || t.carrier || '', source: 'text' };
  }
  if (codes.length) throw new Error('Found a barcode, but it is not a boarding pass barcode.');
  throw new Error(isPdf
    ? 'Could not find flight details in this PDF.'
    : 'No boarding pass barcode found. Try a sharper photo or a screenshot of the boarding pass from the airline app.');
}
