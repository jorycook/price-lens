/* Price Lens: end-to-end check in a real browser.
 *
 * Draws price tags, then (1) hands one to the page as a photo and (2) plays another to the page as
 * its camera, and checks the price is read and converted. Needs Playwright with Chromium, and a
 * connection (the text reader and the exchange rates come from the web).
 *
 *   node test/e2e.mjs            (from the price-lens folder) */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const ROOT = new URL('..', import.meta.url).pathname;
const OUT = process.env.PL_OUT || join(tmpdir(), 'price-lens-e2e');
await mkdir(OUT, { recursive: true });

/* a tiny static server for the app */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
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

const tagHtml = (lines) => `<div style="height:100%;display:grid;place-items:center;background:#d9d4c7">
  <div style="background:#fff;border:3px solid #c00;padding:28px 56px;text-align:center;border-radius:10px">${lines}</div></div>`;

const maker = await chromium.launch({ args: proxyArgs });

/* ---------- 1. a photo of a euro tag ---------- */
{
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
  await page.setInputFiles('#photo-input-2', { name: 'tag.png', mimeType: 'image/png', buffer: png });
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 90000 }).catch(() => {});
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
{
  const W = 720, H = 1280; // a phone held upright
  const { png, rgba } = await drawTag(maker, `<div style="height:100%;background:#d9d4c7;padding-top:250px;box-sizing:border-box">
    <div style="width:440px;margin:0 auto;background:#fff;border:3px solid #c00;padding:18px 0;text-align:center;border-radius:10px">
    <div style="font-size:26px">Earl Grey Tea 80 bags</div>
    <div style="font-size:100px;font-weight:bold">£3.49</div>
    <div style="font-size:20px">£4.36 per 100g</div>
    <div style="font-size:18px;margin-top:8px">Aisle 12 &nbsp; Item 4471 &nbsp; Save 30</div></div></div>`, W, H);
  await writeFile(join(OUT, 'tag-gbp.png'), png);
  const video = join(OUT, 'tag-gbp.y4m');
  await writeFile(video, y4m(rgba, W, H));

  const browser = await chromium.launch({
    args: [...proxyArgs, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`],
  });
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
  await page.click('#shutter');
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 90000 }).catch(() => {});
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    lines: window.priceLens.state.lines.map((l) => l.text),
    prices: window.priceLens.state.prices.map((p) => [p.amount, p.currency]),
    converted: document.getElementById('converted').textContent,
    tagPill: document.getElementById('from-label').textContent + ' ' + document.getElementById('from-code').textContent,
    hint: document.getElementById('hint').textContent,
  }));
  console.log('  ', JSON.stringify(r));
  check(r.prices[0]?.[0] === 3.49 && r.prices[0]?.[1] === 'GBP', 'camera: reads £3.49 as the main price');
  check(/[¥￥]\s?[\d,]+$/.test(r.converted), 'camera: shows it in yen');
  check(r.tagPill === 'Tag · GB GBP', 'camera: knows from the time zone that tags here are in pounds');
  check(!r.prices.some(([a]) => [12, 4471, 30].includes(a)), 'camera: aisle, item and "save 30" numbers are not prices');
  await page.screenshot({ path: join(OUT, 'camera.png') });

  /* live mode keeps reading */
  await page.click('#shutter'); // back to the moving picture
  await page.click('#live-btn');
  await page.evaluate(() => { window.priceLens.state.prices = []; window.priceLens.state.pickKey = null; });
  await page.waitForFunction(() => window.priceLens.state.prices.length > 0, null, { timeout: 60000 }).catch(() => {});
  /* then watch the big price for a few seconds: it should stay put */
  const shown = [];
  for (let i = 0; i < 12; i++) {
    shown.push(await page.textContent('#original'));
    await page.waitForTimeout(400);
  }
  console.log('   live:', [...new Set(shown)].join(' | '));
  check(shown[0].startsWith('£3.49'), 'live: reads the price on its own');
  check(new Set(shown).size === 1, 'live: the price shown stays steady over 5 seconds');
  await browser.close();
}

/* ---------- 3. GPS beats the time zone: phone still on London time, but in Tokyo ---------- */
{
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

await maker.close();
server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed', `(pictures in ${OUT})`);
process.exit(failed ? 1 : 0);
