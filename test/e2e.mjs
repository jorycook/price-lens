/* Price Lens: end-to-end check in a real browser.
 *
 * Draws price tags, then (1) hands one to the page as a photo and (2) plays another to the page as
 * its camera, and checks the price is read and converted, with the default reader (PaddleOCR, in
 * its worker) while the page keeps responding. Then (5) blocks that reader's downloads, to check
 * the app falls back to Tesseract and tries PaddleOCR again later, (6) cuts the network after one
 * visit, to check it still reads offline, (7) jumps the clock as if the app had been switched away
 * from, and (8) taps Scan during a slow first download. Needs Playwright with Chromium, and a
 * connection (the text reader and the exchange rates come from the web).
 *
 *   node test/e2e.mjs            (from the price-lens folder)
 *   PL_ONLY=5,6 node test/e2e.mjs  only some of the parts below */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = resolve(process.env.PL_OUT || join(tmpdir(), 'price-lens-e2e')); // absolute: Chromium gets the camera's file by this path
await mkdir(OUT, { recursive: true });

/* a tiny static server for the app; it can hold back the offline worker's script (see part 6) */
let swHeld = null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (path === '/sw.js' && swHeld) await swHeld;
  try {
    const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/`;

/* behind a proxy, pass it to Chromium directly: Playwright's own proxy option also sends the local server through it */
const proxyArgs = process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [];

/* A switch for the network (part 6): a small proxy that passes the browser's https connections on
   (to HTTPS_PROXY, if set) until it is turned off. Playwright's setOffline cuts the page and its
   worker but not the offline worker (sw.js), which would quietly go on fetching. */
const network = { up: true, sockets: new Set() };
const upstream = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const gate = createServer((req, res) => { res.writeHead(502); res.end(); });
gate.on('connect', (req, client, head) => {
  if (!network.up) return client.end('HTTP/1.1 502 Offline\r\n\r\n');
  const [host, port] = req.url.split(':');
  const up = upstream ? connect(Number(upstream.port), upstream.hostname) : connect(Number(port) || 443, host);
  up.on('connect', () => {
    if (upstream) up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n\r\n`);
    else client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  for (const sock of [client, up]) {
    network.sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => network.sockets.delete(sock));
  }
});
await new Promise((r) => gate.listen(0, '127.0.0.1', r));
const gatedArgs = [`--proxy-server=http://127.0.0.1:${gate.address().port}`, '--proxy-bypass-list=127.0.0.1;localhost'];
const cutNetwork = () => { network.up = false; for (const sock of network.sockets) sock.destroy(); };
const ONLY = process.env.PL_ONLY ? process.env.PL_ONLY.split(',').map(Number) : null;
const want = (part) => !ONLY || ONLY.includes(part);
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

/* draw a price tag and give back a PNG and its raw pixels */
async function drawTag(browser, html, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<style>html,body{margin:0;height:100%;font-family:Arial,Helvetica,sans-serif}</style>${html}`);
  const png = await page.screenshot();
  const rgba = await page.evaluate(async ({ b64, width, height }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(0, 0, width, height).data);
  }, { b64: png.toString('base64'), width, height });
  await page.close();
  return { png, rgba };
}

/* a one-frame Y4M video (what Chromium's fake camera plays) from RGBA pixels */
function y4m(rgba, w, h) {
  const Y = Buffer.alloc(w * h), U = Buffer.alloc((w / 2) * (h / 2)), V = Buffer.alloc((w / 2) * (h / 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    Y[y * w + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    if (y % 2 === 0 && x % 2 === 0) {
      const j = (y / 2) * (w / 2) + x / 2;
      U[j] = Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
      V[j] = Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
    }
  }
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, U, V]);
}

/* The page's longest stall: a 50 ms timer runs while `during` does its work, and the longest gap
   between its ticks is how long the page stopped responding to taps. */
async function longestStall(page, during) {
  await page.evaluate(() => {
    const g = (window.stall = { last: performance.now(), longest: 0 });
    g.timer = setInterval(() => { const t = performance.now(); g.longest = Math.max(g.longest, t - g.last); g.last = t; }, 50);
  });
  await during();
  return page.evaluate(() => { clearInterval(window.stall.timer); return Math.round(window.stall.longest); });
}
/* hands the page a photo and waits for a price, or for the hint to say why there is none */
const readPhoto = async (page, png) => {
  await page.evaluate(() => { window.priceLens.state.prices = []; document.getElementById('hint').textContent = ''; });
  await page.setInputFiles('#photo-input-2', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0 || /could not|No text|No price/.test(document.getElementById('hint').textContent), null, { timeout: 120000 }).catch(() => {});
};
const hidePage = (hidden) => {
  Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible'), configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};
/* the camera, when a part needs one: a phone held upright at the pound tag, drawn by part 2 or here */
const GBP_TAG = `<div style="height:100%;background:#d9d4c7;padding-top:250px;box-sizing:border-box">
    <div style="width:440px;margin:0 auto;background:#fff;border:3px solid #c00;padding:18px 0;text-align:center;border-radius:10px">
    <div style="font-size:26px">Earl Grey Tea 80 bags</div>
    <div style="font-size:100px;font-weight:bold">£3.49</div>
    <div style="font-size:20px">£4.36 per 100g</div>
    <div style="font-size:18px;margin-top:8px">Aisle 12 &nbsp; Item 4471 &nbsp; Save 30</div></div></div>`;
async function cameraArgs(browser) {
  const video = join(OUT, 'tag-gbp.y4m');
  try { await access(video); } catch {
    const { png, rgba } = await drawTag(browser, GBP_TAG, 720, 1280);
    await writeFile(join(OUT, 'tag-gbp.png'), png);
    await writeFile(video, y4m(rgba, 720, 1280));
  }
  return ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`];
}
/* holds one of the reader's files back until released: a slow first download */
async function holdFile(ctx, pattern) {
  let release;
  const held = new Promise((r) => { release = r; });
  await ctx.route(pattern, async (route) => { const res = await route.fetch(); await held; await route.fulfill({ response: res }); });
  return release;
}
const mainPrice = (page) => page.evaluate(() => window.priceLens.state.prices.map((p) => [p.amount, p.currency])[0] || null);
/* the plain words people see: never an exception's own text */
const RAW_ERROR = /Error|fail(ed)? to fetch|dynamically imported|module|undefined|\bnull\b|HTTP \d|wasm|onnx|ERR_/i;

const tagHtml = (lines) => `<div style="height:100%;display:grid;place-items:center;background:#d9d4c7">
  <div style="background:#fff;border:3px solid #c00;padding:28px 56px;text-align:center;border-radius:10px">${lines}</div></div>`;

const maker = await chromium.launch({ args: proxyArgs });

/* ---------- 1. a photo of a euro tag ---------- */
if (want(1)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:34px">Bio Vollmilch 1 l</div>
    <div style="font-size:120px;font-weight:bold">1,19 €</div>
    <div style="font-size:24px">Art. 40213</div>`), 900, 700);
  await writeFile(join(OUT, 'tag-eur.png'), png);

  const browser = await chromium.launch({ args: proxyArgs });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  page.on('console', (m) => m.type() !== 'log' && console.log('console:', m.text()));
  page.on('response', (r) => r.status() >= 400 && console.log('http', r.status(), r.url()));
  await page.goto(base);
  await page.waitForFunction(() => window.priceLens?.state.table, null, { timeout: 20000 });
  check(true, 'exchange rates fetched');
  /* the first photo also starts the reader: download, start-up and its self-test */
  const firstStall = await longestStall(page, () => readPhoto(page, png));
  const reader = await page.evaluate(() => window.priceLens.reader().engine);
  check(reader === 'paddle', `reader: PaddleOCR is the default (using ${reader})`);
  check(firstStall < 200, `responsive: the page never stalls 200 ms while the reader starts and reads (longest ${firstStall} ms)`);
  const stall = await longestStall(page, () => readPhoto(page, png));
  check(stall < 200, `responsive: nor while a photo is read (longest ${stall} ms)`);
  await page.waitForTimeout(400); // let the labels finish appearing before the screenshot
  const r = await page.evaluate(() => ({
    lines: window.priceLens.state.lines.map((l) => l.text),
    prices: window.priceLens.state.prices.map((p) => [p.amount, p.currency]),
    converted: document.getElementById('converted').textContent,
    original: document.getElementById('original').textContent,
    rates: document.getElementById('rates-line').textContent,
    tags: [...document.querySelectorAll('.tag')].map((t) => t.textContent),
  }));
  console.log('  ', JSON.stringify(r));
  check(r.prices[0]?.[0] === 1.19 && r.prices[0]?.[1] === 'EUR', 'photo: reads €1.19 as the main price');
  check(/^\$1\.\d\d$/.test(r.converted), 'photo: shows it in US dollars');
  check(r.tags.length >= 1, 'photo: puts a label on the price');
  check(/1 EUR = [\d.]+ USD/.test(r.rates), 'photo: shows the rate and its date');
  await page.screenshot({ path: join(OUT, 'photo.png') });

  /* the typed price uses the same reading */
  await page.click('#type-btn');
  await page.fill('#typer-input', '¥1,980');
  const typed = await page.textContent('#typer-out');
  console.log('  ', typed);
  check(/^\$\d+\.\d\d/.test(typed) && /1,980/.test(typed), 'typing: ¥1,980 converts to dollars');
  await browser.close();
}

/* ---------- 2. the camera, aimed at a pound tag ---------- */
if (want(2)) {
  const W = 720, H = 1280; // a phone held upright
  const { png, rgba } = await drawTag(maker, GBP_TAG, W, H);
  await writeFile(join(OUT, 'tag-gbp.png'), png);
  const video = join(OUT, 'tag-gbp.y4m');
  await writeFile(video, y4m(rgba, W, H));

  const browser = await chromium.launch({ args: [...proxyArgs, ...(await cameraArgs(maker))] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-GB', timezoneId: 'Europe/London', permissions: ['camera'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  page.on('console', (m) => m.type() !== 'log' && console.log('console:', m.text()));
  page.on('response', (r) => r.status() >= 400 && console.log('http', r.status(), r.url()));
  await page.goto(base);
  await page.evaluate(() => { window.priceLens.settings.to = 'JPY'; });
  await page.waitForSelector('#intro', { state: 'hidden', timeout: 10000 }).catch(() => page.click('#start-btn'));
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, { timeout: 15000 });
  check(true, 'camera: starts and plays');
  await page.waitForFunction(() => window.priceLens.state.table, null, { timeout: 20000 });
  /* wait for the reader before scanning, as a person would see "ready" */
  await page.waitForFunction(() => !/ready/.test(document.getElementById('hint').textContent), null, { timeout: 60000 });
  const liveAtStart = await page.evaluate(() => ({ live: window.priceLens.state.live, pressed: document.getElementById('live-btn').getAttribute('aria-pressed'), shutter: document.getElementById('shutter-label').textContent }));
  check(liveAtStart.live && liveAtStart.pressed === 'true' && liveAtStart.shutter === 'Scan', `live: on by itself once the camera starts (${JSON.stringify(liveAtStart)})`);
  /* Scan holds the sharpest frame and reads it */
  await page.click('#shutter');
  await page.waitForFunction(() => window.priceLens.state.frozen && !window.priceLens.state.live && !window.priceLens.state.busy && !window.priceLens.state.waiting, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    lines: window.priceLens.state.lines.map((l) => l.text),
    prices: window.priceLens.state.prices.map((p) => [p.amount, p.currency]),
    converted: document.getElementById('converted').textContent,
    tagPill: document.getElementById('from-label').textContent + ' ' + document.getElementById('from-code').textContent,
    hint: document.getElementById('hint').textContent,
  }));
  console.log('  ', JSON.stringify(r));
  check(r.prices[0]?.[0] === 3.49 && r.prices[0]?.[1] === 'GBP', 'camera: Scan holds the frame and reads £3.49 as the main price');
  check(/[¥￥]\s?[\d,]+$/.test(r.converted), 'camera: shows it in yen');
  check(r.tagPill === 'Tag · GB GBP', 'camera: knows from the time zone that tags here are in pounds');
  check(!r.prices.some(([a]) => [12, 4471, 30].includes(a)), 'camera: aisle, item and "save 30" numbers are not prices');
  await page.screenshot({ path: join(OUT, 'camera.png') });

  /* the burst keeps the sharpest frame: the score must rank a sharp picture above a blurred one */
  const ranks = await page.evaluate(async () => {
    const { frameScore } = await import('./src/camera.js');
    const draw = (blur) => {
      const c = document.createElement('canvas');
      c.width = 600; c.height = 300;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 300);
      x.filter = blur ? `blur(${blur}px)` : 'none';
      x.fillStyle = '#000'; x.font = 'bold 120px sans-serif'; x.fillText('£3.49', 120, 200);
      return c;
    };
    const box = { x: 0, y: 0, w: 600, h: 300 };
    return [0, 1.5, 4].map((b) => frameScore(draw(b), box).sharpness);
  });
  console.log('   sharpness (sharp, slightly blurred, blurred):', ranks.map(Math.round).join(', '));
  check(ranks[0] > ranks[1] && ranks[1] > ranks[2], 'camera: the sharpness score ranks sharp > slightly blurred > blurred');

  /* Again: back to the moving picture, and live reading goes on by itself */
  await page.click('#shutter');
  await page.waitForFunction(() => window.priceLens.state.live && !window.priceLens.state.frozen, null, { timeout: 10000 });
  await page.evaluate(() => { window.priceLens.state.prices = []; window.priceLens.state.pickKey = null; });
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 60000 }).catch(() => {});
  /* then watch the big price for a few seconds: it should stay put */
  const shown = [];
  for (let i = 0; i < 12; i++) {
    shown.push(await page.textContent('#original'));
    await page.waitForTimeout(400);
  }
  console.log('   live:', [...new Set(shown)].join(' | '));
  check(shown[0].startsWith('£3.49'), 'live: goes on by itself after Again and reads the price on its own');
  check(new Set(shown).size === 1, 'live: the price shown stays steady over 5 seconds');

  /* Scan, then leave the app and come back: the camera restarts, and the labels of the frozen
     frame must not float over the moving picture */
  await page.click('#shutter'); // Scan, from live: holds the frame
  await page.waitForFunction(() => window.priceLens.state.frozen && !window.priceLens.state.busy && document.querySelectorAll('#labels .tag').length > 0, null, { timeout: 30000 });
  await page.evaluate(hidePage, true);
  await page.evaluate(hidePage, false);
  await page.waitForFunction(() => window.priceLens.state.stream && !window.priceLens.state.frozen && document.getElementById('video').videoWidth > 0, null, { timeout: 15000 });
  await page.waitForTimeout(800);
  const back = await page.evaluate(() => ({ frozen: window.priceLens.state.frozen, labels: document.querySelectorAll('#labels .tag').length, shutter: document.getElementById('shutter-label').textContent }));
  check(!back.frozen && back.labels === 0 && back.shutter === 'Scan', `camera: back from the background, no labels of the old frame float over the live picture (${JSON.stringify(back)})`);
  await page.waitForFunction(() => window.priceLens.state.live, null, { timeout: 10000 }).catch(() => {});
  check(await page.evaluate(() => window.priceLens.state.live), 'live: goes on again after coming back from the background');

  /* the Live button turns continuous reading off, and the choice outlives a reload */
  await page.click('#live-btn');
  await page.waitForFunction(() => !window.priceLens.state.live && !window.priceLens.state.busy, null, { timeout: 10000 });
  const off = await page.evaluate(() => ({ live: window.priceLens.state.live, pressed: document.getElementById('live-btn').getAttribute('aria-pressed'), hint: document.getElementById('hint').textContent, saved: JSON.parse(localStorage.getItem('price-lens:settings')).live }));
  check(!off.live && off.pressed === 'false' && off.saved === false && /tap Scan/.test(off.hint), `live: the Live button turns it off and the hint says to tap Scan (${JSON.stringify(off)})`);
  await page.reload();
  await page.waitForFunction(() => window.priceLens && document.getElementById('video').videoWidth > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const afterReload = await page.evaluate(() => ({ live: window.priceLens.state.live, pressed: document.getElementById('live-btn').getAttribute('aria-pressed') }));
  check(!afterReload.live && afterReload.pressed === 'false', `live: off stays off after a reload (${JSON.stringify(afterReload)})`);
  await page.click('#live-btn');
  await page.waitForFunction(() => window.priceLens.state.live, null, { timeout: 10000 }).catch(() => {});
  check(await page.evaluate(() => window.priceLens.state.live), 'live: the Live button turns it back on');
  await browser.close();
}

/* ---------- 3. zoom and flashlight, on a camera that has them ---------- */
if (want(3)) {
  const browser = await chromium.launch({ args: [...proxyArgs, ...(await cameraArgs(maker))] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-GB', timezoneId: 'Europe/London', permissions: ['camera'] });
  /* the test camera has neither, so pretend it does and record what the app asks of it */
  await ctx.addInitScript(() => {
    const P = MediaStreamTrack.prototype;
    const caps = P.getCapabilities, settings = P.getSettings;
    window.applied = [];
    let zoom = 1, torch = false;
    P.getCapabilities = function () { return { ...caps.call(this), zoom: { min: 1, max: 5, step: 0.1 }, torch: true }; };
    P.getSettings = function () { return { ...settings.call(this), zoom, torch }; };
    P.applyConstraints = async function (c) {
      const a = (c.advanced || [])[0] || {};
      window.applied.push(a);
      if ('zoom' in a) zoom = a.zoom;
      if ('torch' in a) torch = a.torch;
    };
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(base);
  await page.waitForSelector('#intro', { state: 'hidden', timeout: 10000 }).catch(() => page.click('#start-btn'));
  await page.waitForFunction(() => !document.getElementById('zoom-btn').hidden, null, { timeout: 15000 }).catch(() => {});
  const z0 = await page.textContent('#zoom-btn');
  check(z0 === '2×', `zoom: starts at 2× (shows ${z0})`);
  await page.click('#zoom-btn');
  const z1 = await page.textContent('#zoom-btn');
  await page.click('#zoom-btn');
  const z2 = await page.textContent('#zoom-btn');
  check(z1 === '3×' && z2 === '1×', `zoom: the button steps 2× → 3× → 1× (got ${z1}, ${z2})`);
  check(await page.isVisible('#torch-btn'), 'torch: the flashlight button shows when the camera has one');
  await page.click('#torch-btn');
  const torch = await page.evaluate(() => ({ pressed: document.getElementById('torch-btn').getAttribute('aria-pressed'), asked: window.applied.some((a) => a.torch === true) }));
  check(torch.pressed === 'true' && torch.asked, 'torch: tapping it turns the flashlight on');
  const remembered = await page.evaluate(() => JSON.parse(localStorage.getItem('price-lens:settings')).zoom);
  check(remembered === 1, 'zoom: the chosen zoom is remembered');
  await browser.close();
}

/* ---------- 4. GPS beats the time zone: phone still on London time, but in Tokyo ---------- */
if (want(4)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:30px">Matcha Kit Kat</div>
    <div style="font-size:120px;font-weight:bold">298</div>`), 900, 700);
  const browser = await chromium.launch({ args: proxyArgs });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'Europe/London',
    permissions: ['geolocation'], geolocation: { latitude: 35.68, longitude: 139.69 },
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.priceLens?.place.source === 'GPS', null, { timeout: 20000 }).catch(() => {});
  const where = await page.evaluate(() => ({ ...window.priceLens.place }));
  console.log('  ', JSON.stringify(where));
  check(where.country === 'JP' && where.currency === 'JPY', 'GPS: finds Japan although the clock is on London time');
  await page.waitForFunction(() => window.priceLens.state.table, null, { timeout: 20000 });
  await page.setInputFiles('#photo-input-2', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 90000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    prices: window.priceLens.state.prices.map((p) => [p.amount, p.currency]),
    converted: document.getElementById('converted').textContent,
    line: document.getElementById('place-line').textContent,
  }));
  console.log('  ', JSON.stringify(r));
  check(r.prices[0]?.[0] === 298 && r.prices[0]?.[1] === 'JPY', 'GPS: a tag with no sign is read in yen');
  check(/^\$\d+\.\d\d$/.test(r.converted), 'GPS: and shown in dollars');
  check(/Japan \(from GPS\)/.test(r.line), 'GPS: settings say where you are and how it was found');
  await browser.close();
}

/* ---------- 5. PaddleOCR cannot be downloaded: the standard reader takes over, PaddleOCR is tried again later ---------- */
if (want(5)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:34px">Bio Vollmilch 1 l</div>
    <div style="font-size:120px;font-weight:bold">1,19 €</div>
    <div style="font-size:24px">Art. 40213</div>`), 900, 700);
  const browser = await chromium.launch({ args: proxyArgs });
  /* no offline worker here, so every request of the reader's worker meets the block */
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.clock.install(); // so the pause before PaddleOCR's next try can be jumped over
  await page.goto(base);
  await page.waitForFunction(() => window.priceLens?.state.table, null, { timeout: 20000 });
  const readerState = () => page.evaluate(() => ({ reader: window.priceLens.reader().engine, hint: document.getElementById('hint').textContent }));

  /* no connection at all: neither reader loads, and the hint says what to do */
  await ctx.route(/cdn\.jsdelivr\.net/, (route) => route.abort());
  await readPhoto(page, png);
  const none = await readerState();
  await page.click('#settings-btn');
  none.note = await page.textContent('#reader-line');
  await page.keyboard.press('Escape');
  console.log('  ', JSON.stringify(none));
  check(none.reader === null && /could not be downloaded/.test(none.hint) && !RAW_ERROR.test(none.hint), 'no connection: the hint says the reader could not be downloaded, in plain words');
  check(/^Text reader: none yet/.test(none.note), 'no connection: Settings does not claim a reader is in use');
  await ctx.unroute(/cdn\.jsdelivr\.net/);

  /* only PaddleOCR's files blocked: the standard reader takes over */
  const blocked = [];
  await ctx.route(/onnxruntime-web|light-ocr-model/, (route) => { blocked.push(route.request().url()); return route.abort(); });
  await readPhoto(page, png);
  const r = await readerState();
  const price = await mainPrice(page);
  await page.click('#settings-btn');
  const note = await page.textContent('#reader-line');
  await page.keyboard.press('Escape');
  console.log('  ', JSON.stringify({ ...r, price, note, blocked: blocked.length }));
  check(blocked.length > 0, 'fallback: the PaddleOCR downloads were blocked');
  check(r.reader === 'tesseract', 'fallback: the app switches to the standard reader');
  check(price?.[0] === 1.19 && price?.[1] === 'EUR', 'fallback: and still reads €1.19');
  check(/^Text reader: standard \(the better reader could not/.test(note) && !RAW_ERROR.test(note), 'fallback: Settings says so in plain words');
  check(!RAW_ERROR.test(r.hint), `fallback: no technical error on screen ("${r.hint}")`);
  await page.screenshot({ path: join(OUT, 'fallback-settings.png') });

  /* the connection is back: the next scan still uses the standard reader (no retry storm), and a
     scan a minute later brings PaddleOCR back */
  await ctx.unroute(/onnxruntime-web|light-ocr-model/);
  const requested = [];
  page.on('request', (q) => /onnxruntime-web|light-ocr-model/.test(q.url()) && requested.push(q.url()));
  await readPhoto(page, png);
  const soon = await readerState();
  check(soon.reader === 'tesseract' && requested.length === 0, 'retry: right after the failure, the standard reader goes on reading');
  await page.clock.fastForward(60000);
  await readPhoto(page, png);
  const later = await readerState();
  const laterPrice = await mainPrice(page);
  console.log('  ', JSON.stringify({ ...later, laterPrice }));
  check(later.reader === 'paddle' && laterPrice?.[0] === 1.19 && laterPrice?.[1] === 'EUR', 'retry: a minute later, the next scan brings PaddleOCR back and reads €1.19');
  await browser.close();
}

/* ---------- 6. offline: after one visit, the app reads with no connection ---------- */
if (want(6)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:34px">Bio Vollmilch 1 l</div>
    <div style="font-size:120px;font-weight:bold">1,19 €</div>
    <div style="font-size:24px">Art. 40213</div>`), 900, 700);
  const browser = await chromium.launch({ args: gatedArgs });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/New_York' });
  /* hold the offline worker back until the reader has started and read, as on a phone whose
     camera (and so the reader) starts the moment the page opens */
  let release;
  swHeld = new Promise((r) => { release = () => { swHeld = null; r(); }; });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.priceLens?.state.table, null, { timeout: 20000 });
  await readPhoto(page, png);
  const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
  check(!controlled && (await mainPrice(page))?.[0] === 1.19, 'offline: the first visit reads before the offline worker is in charge');
  release();
  /* so the page's list must still get every file stored */
  /* (polled from here: waitForFunction does not wait on a promise's value) */
  let stored = null;
  for (let t = 0; t < 120 && !stored; t++) {
    stored = await page.evaluate(async () => {
      const files = window.priceLens.reader().files;
      const keys = (await (await caches.open('price-lens-cdn')).keys()).map((r) => r.url);
      return files.length && files.every((f) => keys.includes(f)) ? files : null;
    });
    if (!stored) await page.waitForTimeout(500);
  }
  check(!!stored, `offline: the reader's files are stored after the first visit (${stored ? stored.length : 0} files)`);
  /* no network (for the offline worker too) and an empty browser cache: only the offline copy can answer */
  await (await ctx.newCDPSession(page)).send('Network.clearBrowserCache');
  cutNetwork();
  await ctx.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => window.priceLens?.state.table, null, { timeout: 20000 });
  const online = await page.evaluate(() => navigator.onLine);
  await readPhoto(page, png);
  const price = await mainPrice(page);
  const reader = await page.evaluate(() => window.priceLens.reader().engine);
  console.log('  ', JSON.stringify({ online, price, reader }));
  check(price?.[0] === 1.19 && price?.[1] === 'EUR' && reader === 'paddle', 'offline: after a reload with no network, PaddleOCR still reads €1.19');
  await browser.close();
}

/* ---------- 7. switched away from while PaddleOCR downloads or reads: it stays the reader ---------- */
if (want(7)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:34px">Bio Vollmilch 1 l</div>
    <div style="font-size:120px;font-weight:bold">1,19 €</div>
    <div style="font-size:24px">Art. 40213</div>`), 900, 700);
  const browser = await chromium.launch({ args: proxyArgs });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-US', timezoneId: 'America/New_York', serviceWorkers: 'block' });
  const release = await holdFile(ctx, /rec\/inference\.onnx/);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  page.on('console', (m) => m.type() !== 'log' && console.log('console:', m.text()));
  /* the page's clock can be jumped forward: a phone suspends the page and its worker while the
     person is in another app, and the clock keeps running */
  await page.clock.install();
  await page.goto(base);
  await page.waitForFunction(() => window.priceLens?.state.table, null, { timeout: 20000 });
  await page.setInputFiles('#photo-input-2', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => /ready… \d+%/.test(document.getElementById('hint').textContent) && window.priceLens.state.waiting, null, { timeout: 60000 });
  await page.waitForTimeout(2000); // everything but the held file has arrived
  const during = await page.evaluate(() => ({ hint: document.getElementById('hint').textContent, disabled: document.getElementById('shutter').disabled, busy: window.priceLens.state.busy }));
  console.log('  ', JSON.stringify(during));
  check(/^Getting the text reader ready… \d+%$/.test(during.hint) && !during.disabled, 'slow start: the download\'s progress stays on screen while the photo waits for the reader');
  await page.clock.fastForward(61000); // a minute in another app, mid-download
  release();
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 120000 }).catch(() => {});
  const r1 = await page.evaluate(() => ({ reader: window.priceLens.reader().engine, why: window.priceLens.reader().why }));
  const p1 = await mainPrice(page);
  console.log('  ', JSON.stringify({ ...r1, p1 }));
  check(r1.reader === 'paddle' && p1?.[0] === 1.19, 'away: a minute away during the first download does not switch the reader');
  /* 25 s away in the middle of a read */
  await page.evaluate(() => { window.priceLens.state.prices = []; });
  await page.setInputFiles('#photo-input-2', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.priceLens.state.busy, null, { polling: 5, timeout: 10000 });
  await page.waitForTimeout(100);
  await page.clock.fastForward(25000);
  await page.waitForFunction(() => !window.priceLens.state.busy, null, { timeout: 120000 });
  const r2 = await page.evaluate(() => ({ reader: window.priceLens.reader().engine, why: window.priceLens.reader().why }));
  const p2 = await mainPrice(page);
  console.log('  ', JSON.stringify({ ...r2, p2 }));
  check(r2.reader === 'paddle' && p2?.[0] === 1.19, 'away: 25 s away in the middle of a read does not switch the reader either');
  await browser.close();
}

/* ---------- 8. first visit on a slow connection: Scan tapped during the download ---------- */
if (want(8)) {
  const { png } = await drawTag(maker, tagHtml(`
    <div style="font-size:34px">Bio Vollmilch 1 l</div>
    <div style="font-size:120px;font-weight:bold">1,19 €</div>
    <div style="font-size:24px">Art. 40213</div>`), 900, 700);
  const browser = await chromium.launch({ args: [...proxyArgs, ...(await cameraArgs(maker))] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, locale: 'en-GB', timezoneId: 'Europe/London', permissions: ['camera'], serviceWorkers: 'block' });
  const release = await holdFile(ctx, /rec\/inference\.onnx/);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('page error:', e.message));
  await page.goto(base);
  await page.waitForSelector('#intro', { state: 'hidden', timeout: 10000 }).catch(() => page.click('#start-btn'));
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0 && window.priceLens.state.table, null, { timeout: 20000 });
  await page.waitForFunction(() => /ready… \d+%/.test(document.getElementById('hint').textContent), null, { timeout: 60000 });
  await page.click('#shutter');
  await page.waitForFunction(() => window.priceLens.state.frozen && window.priceLens.state.waiting, null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  const during = await page.evaluate(() => ({
    hint: document.getElementById('hint').textContent, shutter: document.getElementById('shutter-label').textContent,
    disabled: document.getElementById('shutter').disabled, busy: window.priceLens.state.busy,
  }));
  console.log('  ', JSON.stringify(during));
  check(/^Getting the text reader ready… \d+%$/.test(during.hint) && !during.disabled && during.shutter === 'Again', 'slow start: with Scan tapped during the download, the progress stays on screen and the button stays free');
  /* a photo chosen meanwhile takes over: it is read whole, in its own currency */
  await page.setInputFiles('#photo-input', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.priceLens.state.photo, null, { timeout: 10000 });
  release();
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 120000 }).catch(() => {});
  const r = await page.evaluate(() => ({
    prices: window.priceLens.state.prices.map((p) => [p.amount, p.currency]), region: window.priceLens.state.region,
    lines: window.priceLens.state.lines?.map((l) => l.text), reader: window.priceLens.reader().engine,
  }));
  console.log('  ', JSON.stringify(r));
  check(r.prices[0]?.[0] === 1.19 && r.prices[0]?.[1] === 'EUR' && r.region?.x === 0 && r.region?.w === 900, 'slow start: the photo chosen while waiting is read whole, as €1.19 (not in the camera box, as pounds)');
  await browser.close();
}

await maker.close();
server.close();
gate.close();
console.log(failed ? `\n${failed} failed` : '\nall passed', `(pictures in ${OUT})`);
process.exit(failed ? 1 : 0);
