/* Price Lens: which text reader the app uses.
 *
 * PaddleOCR (src/ocr-paddle.js) reads photos of price tags far better than Tesseract (src/ocr.js),
 * but it needs more of the browser: module workers, OffscreenCanvas in workers, and WebAssembly
 * with SIMD. Some phones that have all of these still get it wrong (iOS 16.4 to 16.5.0 compute
 * SIMD wrongly and read garbage), so after it starts it reads a small picture of a known price
 * first. A browser that lacks a feature, or fails that test, gets Tesseract for the rest of the
 * visit. A failure that may pass (a download, a worker that stopped or hung) gets Tesseract for
 * now, and PaddleOCR is tried again on a later scan, after a pause that doubles each time. When
 * neither can be loaded, nothing is settled, and the next scan starts over. Settings says which
 * reader is in use, and why.
 *
 * Same getReader(onProgress) and readLines(source, region) as the readers themselves. */

import * as paddle from './ocr-paddle.js';
import * as tesseract from './ocr.js';

/* what Settings shows: { engine: 'paddle' | 'tesseract' | null (none yet), why } */
const status = { engine: null, why: null };
const listeners = [];
let choice = null;       // promise of the reader module in use
let current = null;      // the module it settled on
let blocked = null;      // why PaddleOCR is not tried again this visit: 'unsupported' | 'selftest'
let retryAt = 0;         // after a failure that may pass, PaddleOCR is tried again from this time on
let failures = 0;        // ...and the pause before that doubles with each one
let fallbackWhy = null;  // what Settings says about the standard reader being in use
let keptFallback = false;
let progress = () => {};

const RETRY_MS = 10000;          // the first pause: 10 s, then 20, 40, ... up to RETRY_MAX_MS
const RETRY_MAX_MS = 10 * 60000;
const SELF_TEST_KEY = 'price-lens:reader-test';

function setStatus(engine, why = null) {
  Object.assign(status, { engine, why });
  listeners.forEach((fn) => fn(readerNote()));
}

/* Calls fn(note) whenever the reader changes. */
export function onReaderChange(fn) { listeners.push(fn); }

/* One plain sentence for Settings. */
export function readerNote() {
  if (status.engine === 'paddle') return 'Text reader: PaddleOCR, running on this phone.';
  if (status.engine === 'tesseract') {
    const why = {
      download: 'the better reader could not be downloaded; it will be tried again later',
      stopped: 'the better reader stopped working; it will be tried again later',
    }[status.why] || 'the better reader could not start on this phone';
    return `Text reader: standard (${why}).`;
  }
  if (status.why === 'starting') return 'Text reader: getting ready…';
  if (status.why === 'failed') return 'Text reader: none yet; it could not be downloaded. Check the connection and scan again.';
  return 'Text reader: starts with the first scan.';
}

export const readerInfo = () => ({ ...status, files: status.engine === 'paddle' ? paddle.readerFiles() : tesseract.readerFiles() });

/* Asks the offline worker (sw.js) to keep the reader's files. It also keeps them as they are
   fetched, but only once it controls the page, which is not yet the case on the first visit. */
function keepOffline(urls) {
  if (!('serviceWorker' in navigator) || !urls.length) return;
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: 'keep', urls })).catch(() => {});
}

/* Once PaddleOCR reads, the standard reader's files are kept too (4.4 MB, once), so that it is
   on the phone should PaddleOCR ever fail with no connection; not where the browser asks for
   less data, and only after the first picture has been read. */
function keepFallbackOffline() {
  if (keptFallback || navigator.connection?.saveData) return;
  keptFallback = true;
  setTimeout(() => keepOffline(tesseract.readerFiles()), 5000);
}

/* A small picture of a known price, drawn here: if PaddleOCR cannot read this, it cannot be trusted. */
async function selfTest() {
  const c = document.createElement('canvas');
  c.width = 300;
  c.height = 100;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 56px Arial, Helvetica, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('12.34', c.width / 2, c.height / 2);
  const lines = await paddle.readLines(c, { x: 0, y: 0, w: c.width, h: c.height });
  const text = lines.map((l) => l.text).join(' ').replace(/\s/g, '');
  if (!/12[.,]34/.test(text)) throw Object.assign(new Error(`self-test read "${text}"`), { reason: 'selftest' });
}

/* A phone whose browser failed the test fails it every time: remember that (per browser
   version, so an update gets another try) and go straight to the standard reader. */
const failedTestHere = () => { try { return localStorage.getItem(SELF_TEST_KEY) === navigator.userAgent; } catch { return false; } };
const rememberFailedTest = () => { try { localStorage.setItem(SELF_TEST_KEY, navigator.userAgent); } catch {} };

/* Whether PaddleOCR should be tried now. */
const paddleWanted = () => !blocked && Date.now() >= retryAt;

/* Notes that PaddleOCR failed, and returns what Settings says about the standard reader taking over. */
function paddleFailed(reason) {
  if (reason === 'selftest') rememberFailedTest();
  if (reason === 'unsupported' || reason === 'selftest') { blocked = reason; return (fallbackWhy = 'unsupported'); }
  failures++;
  retryAt = Date.now() + Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS);
  return (fallbackWhy = reason === 'download' || reason === 'stalled' ? 'download' : 'stopped');
}

async function useTesseract(why) {
  setStatus('tesseract', why);
  try {
    await tesseract.getReader((p) => progress(p));
  } catch (err) {
    console.warn('text reader:', err);
    /* neither reader: nothing is settled, and the next scan starts over with PaddleOCR */
    retryAt = 0;
    setStatus(null, 'failed');
    throw Object.assign(new Error('The text reader could not be downloaded. Check the connection and try again.'), { plain: true });
  }
  keepOffline(tesseract.readerFiles());
  return tesseract;
}

async function choose() {
  if (!paddleWanted()) return useTesseract(fallbackWhy);
  if (!paddle.canStart() || failedTestHere()) return useTesseract(paddleFailed('unsupported'));
  setStatus(null, 'starting');
  try {
    await paddle.getReader((p) => progress(p));
    await selfTest();
  } catch (err) {
    console.warn('PaddleOCR could not start; using Tesseract:', err);
    paddle.stop();
    return useTesseract(paddleFailed(err.reason));
  }
  setStatus('paddle');
  keepOffline(paddle.readerFiles());
  return paddle;
}

/* Starts the reader once; later calls get the same one, until PaddleOCR is due another try.
   onProgress(0..1) reports a download. */
export function getReader(onProgress) {
  if (onProgress) progress = onProgress;
  if (choice && current === tesseract && paddleWanted()) choice = null;
  if (!choice) {
    current = null;
    choice = choose().then((m) => (current = m), (err) => { choice = null; throw err; });
  }
  return choice;
}

/* Reads the region and returns its lines: { text, height, confidence, bbox } with bbox in source pixels. */
export async function readLines(source, region) {
  const reader = await getReader();
  if (reader !== paddle) return reader.readLines(source, region);
  try {
    const lines = await paddle.readLines(source, region);
    keepFallbackOffline();
    return lines;
  } catch (err) {
    /* a read failed or never finished: this picture goes to the standard reader, and PaddleOCR
       gets another try later */
    console.warn('PaddleOCR stopped; using Tesseract:', err);
    paddle.stop();
    const why = paddleFailed(err.reason);
    current = null;
    choice = useTesseract(why).then((m) => (current = m), (e) => { choice = null; throw e; });
    return (await choice).readLines(source, region);
  }
}
