/* Price Lens benchmark: how often does the app read the right price?
 *
 *   node bench/run.mjs                       made-up tags (120, seed 1)
 *   node bench/run.mjs --synth 40 --seed 7   fewer, different ones
 *   node bench/run.mjs --real path/to/labels.json --synth 0
 *   options: --only <regex on case id>  --out results.json  --images <folder to keep the pictures in>
 *
 * Each picture goes through the app's own reading code (src/ocr.js and src/prices.js) in headless
 * Chromium. A case counts as right when the first price the app offers is the tag's selling price,
 * in the right currency. Needs Playwright and a connection (the text reader comes from a CDN). */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { makeCases, tagScene } from './synth.mjs';

const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : fallback; };
const SYNTH = Number(opt('synth', 120));
const SEED = Number(opt('seed', 1));
const REAL = opt('real', null);
const ONLY = opt('only', null) ? new RegExp(opt('only')) : null;
const OUT = opt('out', null);
const IMAGES = opt('images', null);
const ROOT = resolve(new URL('..', import.meta.url).pathname);
const REAL_DIR = REAL ? dirname(resolve(REAL)) : null;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = url.startsWith('/real/') && REAL_DIR ? [REAL_DIR, url.slice(6)] : [ROOT, url];
  const file = join(base, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const proxyArgs = process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [];
const browser = await chromium.launch({ args: proxyArgs });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const benchPage = await ctx.newPage();
benchPage.on('pageerror', (e) => console.error('bench page error:', e.message));
await benchPage.goto(`${origin}/bench/bench.html`);
await benchPage.waitForFunction(() => window.bench, null, { timeout: 20000 });
await benchPage.evaluate(() => window.bench.ready);
const drawPage = await ctx.newPage();
if (IMAGES) await mkdir(IMAGES, { recursive: true });

const same = (a, b) => !!a && !!b && Math.abs(a.amount - b.amount) < 0.005 && a.currency === b.currency;

function score(truth, prices) {
  const top = prices[0] || null;
  const allowed = [truth.main, ...(truth.others || [])];
  return {
    right: same(top, truth.main),
    rightAmount: !!top && Math.abs(top.amount - truth.main.amount) < 0.005,
    found: prices.some((p) => same(p, truth.main)),
    none: prices.length === 0,
    wrong: prices.filter((p) => !allowed.some((a) => same(p, a))).length,
  };
}

const results = [];
async function run(c, url, opts) {
  const out = await benchPage.evaluate(([u, o]) => window.bench.read(u, o), [url, opts]);
  const s = score(c.truth, out.prices);
  results.push({ id: c.id, set: c.set, style: c.style, hard: c.hard, truth: c.truth, ...s, ms: out.ms, prices: out.prices, lines: out.lines });
  const mark = s.right ? 'ok  ' : s.found ? 'near' : 'MISS';
  const got = out.prices.slice(0, 3).map((p) => `${p.amount} ${p.currency}`).join(', ') || '—';
  console.log(`${mark} ${c.id.padEnd(28)} want ${c.truth.main.amount} ${c.truth.main.currency}  got ${got}  (${out.ms} ms)`);
}

/* made-up tags */
for (const c of makeCases(SEED, SYNTH)) {
  if (ONLY && !ONLY.test(c.id)) continue;
  c.set = 'synth';
  const W = c.camera.width, H = Math.round(W * 0.62);
  await drawPage.setViewportSize({ width: W, height: H });
  await drawPage.setContent(tagScene(c), { waitUntil: 'load' });
  await drawPage.evaluate(() => document.fonts.ready);
  const png = await drawPage.screenshot({ type: 'png' });
  const dataUrl = await benchPage.evaluate(([b64, cam]) => window.bench.degrade('data:image/png;base64,' + b64, cam), [png.toString('base64'), c.camera]);
  if (IMAGES) await writeFile(join(IMAGES, c.id + '.jpg'), Buffer.from(dataUrl.split(',')[1], 'base64'));
  await run(c, dataUrl, { local: c.currency });
}

/* real photos: labels.json from the collection, pictures next to it */
if (REAL) {
  const labels = JSON.parse(await readFile(REAL, 'utf8'));
  for (const l of labels) {
    const c = { id: 'r-' + l.id, set: 'real', style: l.style || 'real', hard: l.difficulty === 'hard', truth: { main: l.main, others: l.others || [] } };
    if (ONLY && !ONLY.test(c.id)) continue;
    await run(c, `${origin}/real/${l.file}`, { aim: l.aim, local: l.main.currency });
  }
}

await browser.close();
server.close();

/* the summary */
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—').padStart(5);
function summary(label, list) {
  const n = list.length;
  if (!n) return;
  const sum = (k) => list.filter((r) => r[k]).length;
  const wrong = list.reduce((a, r) => a + r.wrong, 0);
  console.log(`${label.padEnd(18)} ${String(n).padStart(4)}  right ${pct(sum('right'), n)}  amount ${pct(sum('rightAmount'), n)}  found ${pct(sum('found'), n)}  nothing ${pct(sum('none'), n)}  wrong/case ${(wrong / n).toFixed(2)}  ms ${Math.round(list.reduce((a, r) => a + r.ms, 0) / n)}`);
}
console.log('');
summary('ALL', results);
for (const set of ['synth', 'real']) summary(set, results.filter((r) => r.set === set));
summary('synth easy', results.filter((r) => r.set === 'synth' && !r.hard));
summary('synth hard', results.filter((r) => r.set === 'synth' && r.hard));
for (const style of [...new Set(results.map((r) => r.style))].sort()) summary('  ' + style, results.filter((r) => r.style === style));
if (OUT) {
  await writeFile(OUT, JSON.stringify({ seed: SEED, synth: SYNTH, real: REAL, results }, null, 1));
  console.log(`\ndetails in ${OUT}`);
}
