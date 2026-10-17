/* Price Lens: the page. Camera, scanning, and showing the converted prices. */

import { findPrices, currencyForLanguage, priceKey } from './prices.js';
import { COUNTRY_CURRENCY, countryName, countryFromTimeZone, countryFromGps, gpsAllowed } from './location.js';
import { getRates, storedRates, convert, rateOf } from './rates.js';
import { getReader, readLines, readerNote, onReaderChange, readerInfo } from './reader.js';
import { openBackCamera, tuneTrack, setZoom, zoomRange, currentZoom, hasTorch, setTorch, focusAt, captureSharpest, frameGate, attachPinch } from './camera.js';

const $ = (id) => document.getElementById(id);
const el = {
  stage: $('stage'), video: $('video'), still: $('still'), reticle: $('reticle'), labels: $('labels'), hint: $('hint'),
  fromCode: $('from-code'), fromLabel: $('from-label'), placeLine: $('place-line'), gpsBtn: $('gps-btn'), toCode: $('to-code'),
  resultEmpty: $('result-empty'), resultMain: $('result-main'), converted: $('converted'), original: $('original'),
  assumed: $('assumed'), others: $('others'), ratesLine: $('rates-line'),
  shutter: $('shutter'), shutterLabel: $('shutter-label'), liveBtn: $('live-btn'),
  zoomBtn: $('zoom-btn'), torchBtn: $('torch-btn'), focusRing: $('focus-ring'),
  intro: $('intro'), introError: $('intro-error'),
  settings: $('settings'), readerLine: $('reader-line'), toSelect: $('to-select'), fromSelect: $('from-select'), ratesDetail: $('rates-detail'),
  typer: $('typer'), typerInput: $('typer-input'), typerOut: $('typer-out'),
};

/* ---------- settings ---------- */

const SETTINGS_KEY = 'price-lens:settings';
const lang = navigator.language || 'en-US';
const guess = currencyForLanguage(lang) || 'USD';
const settings = Object.assign(
  { to: guess, from: 'auto' },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })(),
);
delete settings.learned; // from an earlier version, which guessed the tag currency from the tags themselves
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

/* Where the phone is: { country, currency, source: 'GPS' | 'time zone' }. On "Automatic", price tags
   are read in this country's currency. Set from the time zone at once, then from GPS if allowed. */
const place = { country: null, currency: null, source: null };
const tagCurrency = () => (settings.from === 'auto' ? place.currency || guess : settings.from);

/* ---------- state ---------- */

const state = {
  table: storedRates(),
  stream: null,
  track: null,        // the camera's video track (zoom, torch, focus)
  torch: false,
  shooting: false,    // waiting for the sharpest frame of a burst
  gate: null,         // live mode: picks the frames worth reading
  liveRun: 0,
  wantCamera: false,
  live: false,
  frozen: false,      // a still is on screen (a captured frame or a chosen photo)
  photo: false,       // the still is a chosen photo (shown whole) rather than a camera frame
  busy: false,
  prices: [],
  pick: 0,
  pickKey: null,      // the price shown big; in live mode it stays while it is in view
  locked: false,      // the person tapped a price to choose it
  history: [],        // live mode: the prices seen in the last few frames
  lines: null,
  region: null,
  wakeLock: null,
};

/* ---------- money ---------- */

const formatters = new Map();
function money(amount, code) {
  if (amount == null || !Number.isFinite(amount)) return '—';
  let f = formatters.get(code);
  if (!f) {
    try { f = new Intl.NumberFormat(lang, { style: 'currency', currency: code }); }
    catch { f = { format: (n) => `${n.toFixed(2)} ${code}` }; }
    formatters.set(code, f);
  }
  return f.format(amount);
}
function plain(n) {
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return n.toLocaleString(lang, { maximumSignificantDigits: Math.max(4, digits) });
}
const names = (() => { try { return new Intl.DisplayNames([lang, 'en'], { type: 'currency' }); } catch { return null; } })();
const nameOf = (code) => { try { return names?.of(code) || code; } catch { return code; } };

const knownCodes = () => (state.table ? Object.keys(state.table.rates) : null);

/* ---------- geometry: where a source pixel is on screen ---------- */

function source() {
  return state.frozen ? el.still : el.video;
}
function sourceSize() {
  const s = source();
  return s === el.video ? [s.videoWidth, s.videoHeight] : [s.width, s.height];
}
/* a picture sw × sh shown filling the screen (camera) or whole on it (photo) */
function fitFor(sw, sh, whole) {
  const W = el.stage.clientWidth, H = el.stage.clientHeight;
  const scale = (whole ? Math.min : Math.max)(W / sw, H / sh);
  return { scale, ox: (W - sw * scale) / 2, oy: (H - sh * scale) / 2, sw, sh };
}
function fitOf() {
  const [sw, sh] = sourceSize();
  return fitFor(sw, sh, state.photo);
}
/* the part of the source inside the aiming box (or the whole photo) */
function scanRegion() {
  const f = fitOf();
  if (state.photo) return { x: 0, y: 0, w: f.sw, h: f.sh };
  return boxIn(f.sw, f.sh);
}
/* the aiming box in the pixels of a camera frame sw × sh */
function boxIn(sw, sh) {
  const f = fitFor(sw, sh, false);
  const r = el.reticle.getBoundingClientRect(), s = el.stage.getBoundingClientRect();
  const x = Math.max(0, (r.left - s.left - f.ox) / f.scale);
  const y = Math.max(0, (r.top - s.top - f.oy) / f.scale);
  const w = Math.min(f.sw - x, r.width / f.scale);
  const h = Math.min(f.sh - y, r.height / f.scale);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}
const videoBox = () => boxIn(el.video.videoWidth, el.video.videoHeight);

/* ---------- camera ---------- */

async function startCamera() {
  state.wantCamera = true;
  el.introError.hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    return cameraFailed(window.isSecureContext
      ? 'This browser cannot use the camera. Try Safari or Chrome, or use a photo instead.'
      : 'The camera needs a secure (https) address. Open Price Lens from its https link, or use a photo instead.');
  }
  try {
    const stream = await openBackCamera();
    state.stream = stream;
    state.track = stream.getVideoTracks()[0];
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    el.intro.hidden = true;
    unfreeze();
    setHint(AIM_HINT);
    warmUp();
    /* zoom in (2× unless the person chose otherwise), so the tag is read from beyond the lens's
       closest focus; constraints go on once the video is playing */
    await tuneTrack(state.track, { zoom: settings.zoom ?? 2 });
    updateCameraButtons();
  } catch (err) {
    console.warn(err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    cameraFailed(denied
      ? 'Camera access was refused. Allow the camera for this site in your browser settings, or use a photo instead.'
      : 'The camera could not start. Close other apps that may be using it, or use a photo instead.');
  }
}

function cameraFailed(message) {
  state.wantCamera = false;
  el.intro.hidden = false;
  el.introError.textContent = message;
  el.introError.hidden = false;
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.track = null;
  state.torch = false;
  updateCameraButtons();
}

const AIM_HINT = 'Aim the box at a price, about 25 cm away, then tap Scan';
const zoomText = (z) => `${Math.round(z * 10) / 10}×`;

/* the zoom and flashlight buttons, shown only when this camera has them */
function updateCameraButtons() {
  const t = state.track;
  const range = t && zoomRange(t);
  el.zoomBtn.hidden = !range;
  if (range) el.zoomBtn.textContent = zoomText(currentZoom(t) || 1);
  el.torchBtn.hidden = !(t && hasTorch(t));
  el.torchBtn.setAttribute('aria-pressed', String(state.torch));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
    setLive(false);
  } else if (state.wantCamera && !state.stream) {
    startCamera();
  }
});

/* the reader takes a few seconds to load the first time; start it while the person aims */
function warmUp() {
  getReader((p) => {
    if (!state.busy && p < 1) setHint(`Getting the text reader ready… ${Math.round(p * 100)}%`);
  }).then(() => {
    if (!state.busy && !state.prices.length) setHint(state.photo ? '' : AIM_HINT);
  }).catch((err) => setHint(plainError(err, 'The text reader could not start. Check the connection and try again.')));
}

/* What people see of an error: our own sentences, never the browser's technical wording */
function plainError(err, fallback) {
  console.error(err);
  return err?.plain ? err.message : fallback;
}

/* ---------- scanning ---------- */

function setHint(text) { el.hint.textContent = text; }

/* shows a camera frame (the sharpest of the burst) as a still, to read and label */
function freezeFrame(frame) {
  if (!frame.width) return false;
  el.still.width = frame.width;
  el.still.height = frame.height;
  el.still.getContext('2d').drawImage(frame, 0, 0);
  state.frozen = true;
  state.photo = false;
  el.still.hidden = false;
  el.stage.classList.remove('photo');
  return true;
}

function unfreeze() {
  state.frozen = false;
  state.photo = false;
  el.still.hidden = true;
  el.stage.classList.remove('photo');
  el.labels.replaceChildren();
  updateShutter();
}

function readPrices(lines, region) {
  const center = region && { x: region.x + region.w / 2, y: region.y + region.h / 2, reach: Math.hypot(region.w, region.h) / 2 };
  return findPrices(lines, { local: tagCurrency(), codes: knownCodes(), center });
}

/* Reads the aiming box of the picture on screen, or of a camera frame handed over by live mode. */
async function scan({ quiet = false, from = null } = {}) {
  if (state.busy) return null;
  const [sw] = from ? [from.width] : sourceSize();
  if (!sw) return null;
  state.busy = true;
  el.reticle.classList.add('busy');
  el.shutter.disabled = !state.live;
  if (!quiet) setHint('Reading…');
  try {
    const region = from ? boxIn(from.width, from.height) : scanRegion();
    if (region.w < 20 || region.h < 20) return null;
    const lines = await readLines(from || source(), region);
    state.lines = lines;
    state.region = region;
    let prices = readPrices(lines, region);
    if (state.live) {
      prices = steady(prices);
    } else {
      state.pickKey = prices[0] ? priceKey(prices[0]) : null;
      state.locked = false;
    }
    if (prices && prices.length) {
      state.prices = prices;
      setHint('');
      render();
      drawLabels(prices);
    } else if (!quiet) {
      setHint(lines.length ? 'No price found. Move closer so the price fills the box.' : 'No text found. Move closer, and keep the tag flat and well lit.');
      render();
      drawLabels([]);
    }
    return prices;
  } catch (err) {
    setHint(plainError(err, 'Could not read the picture. Try again.'));
    return null;
  } finally {
    state.busy = false;
    el.reticle.classList.remove('busy');
    el.shutter.disabled = false;
  }
}

/* Live mode reads a frame every half second or so, and the reader does not see exactly the same
   numbers each time. So a price only appears once it has been read in 2 of the last 4 frames, and
   the price shown big stays until it has left the picture, rather than jumping to whichever number
   scored best in the latest frame. Returns the prices to show, or null to leave the screen as it is. */
const FRAMES = 4;
function steady(prices) {
  state.history.push(new Set(prices.slice(0, 5).map(priceKey)));
  if (state.history.length > FRAMES) state.history.shift();
  const hits = (key) => state.history.filter((frame) => frame.has(key)).length;
  const confirmed = prices.filter((p) => hits(priceKey(p)) >= 2);
  const current = state.pickKey;
  const recent = (n) => current && state.history.slice(-n).some((frame) => frame.has(current));
  let main = confirmed.find((p) => priceKey(p) === current);
  if (!main) {
    /* the price shown was missed in this frame but seen just before (or chosen by a tap): hold it */
    if (recent(state.locked ? FRAMES : 2)) return null;
    main = confirmed[0];
    state.locked = false;
  }
  if (!main) return null;
  state.pickKey = priceKey(main);
  return [main, ...confirmed.filter((p) => p !== main)];
}

/* the person tapped a price: show it big, and in live mode keep it while it is in view */
function choose(p) {
  state.pickKey = priceKey(p);
  state.locked = true;
  render();
  drawLabels(state.prices);
}

/* after the tag currency changes, read the last scan's text again under the new assumption */
function rereadLast() {
  state.history = [];
  if (!state.lines) return;
  state.prices = readPrices(state.lines, state.region);
  if (!state.prices.some((p) => priceKey(p) === state.pickKey)) state.pickKey = state.prices[0] ? priceKey(state.prices[0]) : null;
  render();
  drawLabels(state.prices);
}

/* The Scan button: let the shake of the tap settle, keep the sharpest frame of a short burst,
   show it as a still and read it. */
async function shoot() {
  if (state.busy || state.shooting || !el.video.videoWidth) return;
  state.shooting = true;
  el.shutter.disabled = true;
  el.reticle.classList.add('busy');
  setHint('Hold still…');
  try {
    const shot = await captureSharpest(el.video, videoBox);
    if (!state.stream || state.live) return;
    freezeFrame(shot.canvas);
    updateShutter();
    await scan();
  } finally {
    state.shooting = false;
    el.shutter.disabled = false;
  }
}

/* ---------- live mode: keep reading the moving picture ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Reads frame after frame, but only frames worth reading: the frame gate keeps the sharpest steady
   frame since the last read, and the reticle turns green while the phone is held steady. */
async function liveLoop() {
  const run = ++state.liveRun;
  let misses = 0;
  state.gate?.stop();
  const gate = (state.gate = frameGate(el.video, videoBox, (steady) => el.reticle.classList.toggle('steady', steady)));
  try {
    while (state.live && state.stream && !document.hidden && run === state.liveRun) {
      const frame = gate.take();
      if (!frame) { await sleep(80); continue; }
      const found = await scan({ quiet: true, from: frame.canvas });
      if (found && found.length) misses = 0;
      else if (++misses >= FRAMES) { el.labels.replaceChildren(); state.pickKey = null; state.locked = false; }
      await sleep(120);
    }
  } finally {
    gate.stop();
    if (state.gate === gate) state.gate = null;
    el.reticle.classList.remove('steady');
  }
}

async function setLive(on) {
  state.live = on;
  state.history = [];
  el.liveBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    unfreeze();
    setHint('Reading continuously…');
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    liveLoop();
  } else {
    state.wakeLock?.release?.().catch(() => {});
    state.wakeLock = null;
  }
  updateShutter();
}

function updateShutter() {
  el.shutter.classList.toggle('live', state.live);
  el.shutterLabel.textContent = state.live ? 'Stop' : state.frozen ? 'Again' : 'Scan';
}

/* ---------- photos ---------- */

async function usePhoto(file) {
  if (!file) return;
  setLive(false);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(Object.assign(new Error('That file is not a picture this browser can open.'), { plain: true }));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width, h = bitmap.height;
  const k = Math.min(1, 2400 / Math.max(w, h));
  el.still.width = Math.round(w * k);
  el.still.height = Math.round(h * k);
  el.still.getContext('2d').drawImage(bitmap, 0, 0, el.still.width, el.still.height);
  state.frozen = true;
  state.photo = true;
  el.still.hidden = false;
  el.stage.classList.add('photo');
  el.intro.hidden = true;
  el.labels.replaceChildren();
  updateShutter();
  el.shutterLabel.textContent = state.stream ? 'Camera' : 'Photo';
  await scan();
}

/* ---------- showing results ---------- */

function render() {
  state.pick = Math.max(0, state.prices.findIndex((q) => priceKey(q) === state.pickKey));
  const p = state.prices[state.pick];
  el.resultEmpty.hidden = !!p;
  el.resultMain.hidden = !p;
  el.others.replaceChildren();
  if (!p) return;
  const out = convert(state.table, p.amount, p.currency, settings.to);
  if (!state.table) el.converted.textContent = 'No rates yet';
  else if (out == null) el.converted.textContent = `No rate for ${p.currency}`;
  else el.converted.textContent = money(out, settings.to);
  el.original.textContent = `${money(p.amount, p.currency)} · ${nameOf(p.currency)}`;
  el.assumed.hidden = p.explicit && !p.shared;
  el.assumed.textContent = p.explicit ? `${p.mark} read as ${p.currency}` : 'currency assumed';
  state.prices.forEach((q, i) => {
    if (i === state.pick || i > 5) return;
    const b = document.createElement('button');
    b.type = 'button';
    const c = convert(state.table, q.amount, q.currency, settings.to);
    b.innerHTML = '<b></b><span></span>';
    b.firstChild.textContent = money(q.amount, q.currency);
    b.lastChild.textContent = '→ ' + money(c, settings.to);
    b.addEventListener('click', () => choose(q));
    el.others.appendChild(b);
  });
  renderRates();
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function drawLabels(prices) {
  el.labels.replaceChildren();
  const f = fitOf();
  const s = el.stage.getBoundingClientRect();
  const placed = [];
  prices.slice(0, 6).forEach((p, i) => {
    if (!p.bbox) return;
    const main = i === state.pick;
    const box = document.createElement('div');
    box.className = 'box' + (main ? '' : ' minor');
    const left = p.bbox.x0 * f.scale + f.ox, top = p.bbox.y0 * f.scale + f.oy;
    const width = (p.bbox.x1 - p.bbox.x0) * f.scale, height = (p.bbox.y1 - p.bbox.y0) * f.scale;
    Object.assign(box.style, { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' });
    el.labels.appendChild(box);

    const out = convert(state.table, p.amount, p.currency, settings.to);
    if (out == null) return;
    const tag = document.createElement('button');
    tag.type = 'button';
    tag.className = 'tag' + (main ? '' : ' minor');
    tag.textContent = money(out, settings.to);
    /* big enough to read at arm's length: about as tall as the price on screen, within limits */
    tag.style.fontSize = Math.round(main ? clamp(height * 0.75, 34, 52) : clamp(height * 0.55, 22, 32)) + 'px';
    tag.style.visibility = 'hidden';
    el.labels.appendChild(tag);
    const w = tag.offsetWidth, h = tag.offsetHeight;
    /* the main price gets a label above it; the others are covered by theirs, so no label hides a neighbour.
       Labels stay on screen, clear of the top bar, and are nudged down until they do not overlap. */
    const x = clamp(left + width / 2, w / 2 + 8, s.width - w / 2 - 8);
    let y = main ? Math.max(top - 10, 72 + h) : Math.max(top + height / 2, 72 + h / 2);
    const box0 = () => (main ? { t: y - h, b: y } : { t: y - h / 2, b: y + h / 2 });
    const hits = () => placed.some((q) => Math.abs(q.x - x) < (q.w + w) / 2 + 6 && box0().t < q.b + 6 && box0().b > q.t - 6);
    while (hits()) y += h / 2;
    placed.push({ x, w, ...box0() });
    Object.assign(tag.style, { left: x + 'px', top: y + 'px', visibility: '' });
    tag.addEventListener('click', () => choose(p));
  });
}

function timeAgo(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
function when(ms) {
  return new Date(ms).toLocaleString(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderRates() {
  const t = state.table;
  const p = state.prices[state.pick];
  const from = p ? p.currency : tagCurrency();
  if (!t) {
    el.ratesLine.textContent = navigator.onLine ? 'Fetching exchange rates…' : 'No exchange rates yet: connect once to fetch them.';
    el.ratesLine.classList.toggle('stale', !navigator.onLine);
    el.ratesDetail.textContent = 'Not fetched yet.';
    return;
  }
  const r = rateOf(t, from, settings.to);
  const rateText = r == null ? '' : `1 ${from} = ${plain(r)} ${settings.to} · `;
  el.ratesLine.textContent = `${rateText}rates of ${when(t.updated)}${t.stale ? ' (offline)' : ''}`;
  el.ratesLine.classList.toggle('stale', !!t.stale);
  el.ratesDetail.innerHTML = '';
  el.ratesDetail.append(
    `Published ${when(t.updated)}, fetched ${timeAgo(t.fetched)} from `,
    Object.assign(document.createElement('a'), { href: t.link, textContent: t.source, target: '_blank', rel: 'noopener' }),
    `. ${Object.keys(t.rates).length} currencies.`,
  );
}

async function refreshRates(force = false) {
  const t = await getRates({ force });
  if (t) state.table = t;
  else if (state.table) state.table.stale = true;
  fillSelects();
  render();
  renderRates();
  if (state.prices.length) drawLabels(state.prices);
}

/* ---------- currency pickers ---------- */

const POPULAR = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'CHF', 'MXN', 'KRW', 'INR', 'THB', 'SGD', 'HKD'];

function fillSelects() {
  const codes = (knownCodes() || POPULAR).slice().sort();
  const option = (code) => new Option(`${code} · ${nameOf(code)}`, code);
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    list.forEach((c) => g.appendChild(option(c)));
    return g;
  };
  const popular = POPULAR.filter((c) => codes.includes(c));
  el.toSelect.replaceChildren(group('Common', popular), group('All currencies', codes));
  el.toSelect.value = settings.to;
  const auto = new Option(place.currency ? `Automatic: where I am (${place.currency})` : 'Automatic: where I am', 'auto');
  el.fromSelect.replaceChildren(auto, group('Common', popular), group('All currencies', codes));
  el.fromSelect.value = settings.from;
}

function updatePills() {
  el.toCode.textContent = settings.to;
  el.fromCode.textContent = tagCurrency();
  el.fromLabel.textContent = settings.from === 'auto' && place.country ? `Tag · ${place.country}` : 'Tag';
  el.placeLine.textContent = place.country
    ? `You're in ${countryName(place.country, lang)} (from ${place.source === 'GPS' ? 'GPS' : "your phone's time zone"}), so on Automatic, tags are read in ${place.currency}.`
    : `Your location isn't known, so on Automatic, tags are read in ${tagCurrency()}.`;
}

/* ---------- where the phone is ---------- */

function setPlace(country, source) {
  const currency = COUNTRY_CURRENCY[country];
  if (!currency) return;
  const changed = currency !== place.currency;
  Object.assign(place, { country, currency, source });
  updatePills();
  fillSelects();
  if (changed && settings.from === 'auto') rereadLast();
}

/* ask: the person tapped the button, so a permission prompt is expected; otherwise only use GPS
   when it was allowed before */
async function locateByGps(ask) {
  if (!ask && !(await gpsAllowed())) return;
  const btn = el.gpsBtn;
  btn.disabled = true;
  btn.textContent = 'Finding your country…';
  try {
    setPlace(await countryFromGps(), 'GPS');
    btn.textContent = 'Found by GPS';
  } catch (err) {
    btn.textContent = 'Find my country with GPS';
    if (ask) el.placeLine.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

el.toSelect.addEventListener('change', () => {
  settings.to = el.toSelect.value;
  saveSettings(); updatePills(); render(); drawLabels(state.prices);
});
el.fromSelect.addEventListener('change', () => {
  settings.from = el.fromSelect.value;
  saveSettings(); updatePills();
  rereadLast();
});

/* ---------- typing a price ---------- */

function typed() {
  const text = el.typerInput.value.trim();
  if (!text) { el.typerOut.textContent = ''; return; }
  const [p] = findPrices(text, { local: tagCurrency(), codes: knownCodes() });
  if (!p) { el.typerOut.innerHTML = '<small>Type a number, with or without a currency sign.</small>'; return; }
  const out = convert(state.table, p.amount, p.currency, settings.to);
  el.typerOut.textContent = out == null ? 'No rate' : money(out, settings.to);
  const small = document.createElement('small');
  small.textContent = `${money(p.amount, p.currency)} (${nameOf(p.currency)})`;
  el.typerOut.appendChild(small);
}

/* ---------- buttons ---------- */

$('start-btn').addEventListener('click', startCamera);
el.shutter.addEventListener('click', () => {
  if (state.live) return setLive(false);
  if (state.frozen) {
    if (state.stream) { unfreeze(); setHint(AIM_HINT); }
    else $('photo-input').click();
    return;
  }
  if (!state.stream) return $('photo-input').click();
  shoot();
});
el.liveBtn.addEventListener('click', () => {
  if (!state.stream) return startCamera().then(() => state.stream && setLive(true));
  setLive(!state.live);
});
for (const id of ['photo-input', 'photo-input-2']) {
  $(id).addEventListener('change', (e) => { usePhoto(e.target.files[0]).catch((err) => setHint(plainError(err, 'That picture could not be opened.'))); e.target.value = ''; });
}
const openTyper = () => { el.typer.showModal(); el.typerInput.focus(); typed(); };
$('type-btn').addEventListener('click', openTyper);
$('type-btn-2').addEventListener('click', openTyper);
el.typerInput.addEventListener('input', typed);
const openSettings = () => { fillSelects(); renderRates(); el.readerLine.textContent = readerNote(); el.settings.showModal(); };
onReaderChange((note) => { el.readerLine.textContent = note; });
$('settings-btn').addEventListener('click', openSettings);
$('to-btn').addEventListener('click', () => { openSettings(); el.toSelect.focus(); });
$('from-btn').addEventListener('click', () => { openSettings(); el.fromSelect.focus(); });
$('refresh-btn').addEventListener('click', async (e) => {
  e.target.disabled = true;
  e.target.textContent = 'Fetching…';
  await refreshRates(true);
  e.target.disabled = false;
  e.target.textContent = state.table && !state.table.stale ? 'Up to date' : 'Could not fetch; try again';
});
for (const d of [el.settings, el.typer]) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // tap outside closes
}
window.addEventListener('resize', () => state.prices.length && drawLabels(state.prices));
window.addEventListener('online', () => refreshRates());

/* zoom button: steps through 1×, 2×, 3× (as far as the camera goes); pinching works too */
el.zoomBtn.addEventListener('click', async () => {
  const t = state.track, range = t && zoomRange(t);
  if (!range) return;
  const now = currentZoom(t) || 1;
  const steps = [1, 2, 3].filter((z) => z >= Math.max(1, range.min) && z <= range.max);
  const next = steps.find((z) => z > now + 0.05) ?? steps[0];
  const z = await setZoom(t, next);
  if (z != null) { settings.zoom = z; saveSettings(); }
  updateCameraButtons();
});
attachPinch(el.stage, () => state.track, (z) => {
  settings.zoom = z;
  saveSettings();
  el.zoomBtn.textContent = zoomText(z);
});
el.torchBtn.addEventListener('click', async () => {
  if (!state.track) return;
  const on = !state.torch;
  if (await setTorch(state.track, on)) state.torch = on;
  updateCameraButtons();
});
/* tap on the picture to focus there, where the browser allows it (Chrome on Android) */
el.stage.addEventListener('click', async (e) => {
  if (!state.track || state.frozen || e.target.closest('button')) return;
  const f = fitFor(el.video.videoWidth, el.video.videoHeight, false);
  const s = el.stage.getBoundingClientRect();
  const x = (e.clientX - s.left - f.ox) / f.scale / f.sw, y = (e.clientY - s.top - f.oy) / f.scale / f.sh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (await focusAt(state.track, x, y)) {
    Object.assign(el.focusRing.style, { left: e.clientX - s.left + 'px', top: e.clientY - s.top + 'px' });
    el.focusRing.hidden = false;
    el.focusRing.style.animation = 'none';
    void el.focusRing.offsetWidth; // restart the animation
    el.focusRing.style.animation = '';
  }
});
el.video.addEventListener('resize', () => { if (!state.frozen && state.prices.length) drawLabels(state.prices); });

/* ---------- start ---------- */

const zoneCountry = countryFromTimeZone();
if (zoneCountry) setPlace(zoneCountry, 'time zone');
locateByGps(false);
el.gpsBtn.addEventListener('click', () => locateByGps(true));
updatePills();
fillSelects();
render();
renderRates();
refreshRates();
setInterval(() => { if (!document.hidden) refreshRates(); }, 15 * 60 * 1000);

/* open straight onto the camera when it was allowed before */
navigator.permissions?.query({ name: 'camera' }).then((p) => { if (p.state === 'granted') startCamera(); }).catch(() => {});

/* any secure address (https, or http://localhost while testing) can have the offline copy */
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('offline copy:', err));
}

/* for the tests */
window.priceLens = { state, settings, place, scan, usePhoto, reader: readerInfo };
