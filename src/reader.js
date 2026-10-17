/* Price Lens: which text reader the app uses.
 *
 * PaddleOCR (src/ocr-paddle.js) reads photos of price tags far better than Tesseract (src/ocr.js),
 * but it needs more of the browser: module workers, OffscreenCanvas in workers, and WebAssembly
 * with SIMD. Some phones that have all of these still get it wrong (iOS 16.4 to 16.5.0 compute
 * SIMD wrongly and read garbage), so after it starts it reads a small picture of a known price
 * first. If anything fails (a missing feature, a download, the test, the worker, a read that
 * never finishes), Tesseract reads for the rest of the visit, and Settings says so.
 *
 * Same getReader(onProgress) and readLines(source, region) as the readers themselves. */

import * as paddle from './ocr-paddle.js';
import * as tesseract from './ocr.js';

/* what Settings shows: { engine: 'paddle' | 'tesseract' | null, why } */
const status = { engine: null, why: null };
let listeners = [];
let choice = null;          // promise of the reader module in use
let paddleFailed = false;   // once PaddleOCR fails, it is not tried again during this visit
let progress = () => {};

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
  if (status.engine !== 'tesseract') return 'Text reader: starts with the first scan.';
  const why = {
    download: 'the better reader could not be downloaded; it will try again next time you open Price Lens',
    stopped: 'the better reader stopped working; it will try again next time you open Price Lens',
  }[status.why] || 'the better reader could not start on this phone';
  return `Text reader: standard (${why}).`;
}

export const readerInfo = () => ({ ...status, files: status.engine === 'paddle' ? paddle.readerFiles() : tesseract.readerFiles() });

/* Asks the offline worker (sw.js) to keep the reader's files. It also keeps them as they are
   fetched, but only once it controls the page, which is not yet the case on the first visit. */
function keepOffline(urls) {
  if (!('serviceWorker' in navigator) || !urls.length) return;
  navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage({ type: 'keep', urls })).catch(() => {});
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

const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const hasSimd = () => { try { return WebAssembly.validate(SIMD_TEST); } catch { return false; } };

async function useTesseract(why) {
  paddleFailed = true;
  setStatus('tesseract', why);
  try {
    await tesseract.getReader((p) => progress(p));
  } catch (err) {
    console.warn('text reader:', err);
    throw Object.assign(new Error('The text reader could not be downloaded. Check the connection and try again.'), { plain: true });
  }
  keepOffline(tesseract.readerFiles());
  return tesseract;
}

async function choose() {
  if (paddleFailed) return useTesseract(status.why);
  if (!paddle.canStart() || !hasSimd() || failedTestHere()) return useTesseract('unsupported');
  try {
    await paddle.getReader((p) => progress(p));
    await selfTest();
  } catch (err) {
    console.warn('PaddleOCR could not start; using Tesseract:', err);
    paddle.stop();
    if (err.reason === 'selftest') rememberFailedTest();
    return useTesseract(err.reason === 'download' || err.reason === 'stalled' ? 'download' : 'unsupported');
  }
  setStatus('paddle');
  keepOffline(paddle.readerFiles());
  return paddle;
}

/* Starts the reader once; later calls get the same one. onProgress(0..1) reports the download. */
export function getReader(onProgress) {
  if (onProgress) progress = onProgress;
  if (!choice) choice = choose().catch((err) => { choice = null; throw err; });
  return choice;
}

/* Reads the region and returns its lines: { text, height, confidence, bbox } with bbox in source pixels. */
export async function readLines(source, region) {
  const reader = await getReader();
  if (reader !== paddle) return reader.readLines(source, region);
  try {
    return await paddle.readLines(source, region);
  } catch (err) {
    /* a read failed or never finished: the standard reader from now on, starting with this picture */
    console.warn('PaddleOCR stopped; using Tesseract:', err);
    paddle.stop();
    choice = useTesseract('stopped').catch((e) => { choice = null; throw e; });
    return (await choice).readLines(source, region);
  }
}
