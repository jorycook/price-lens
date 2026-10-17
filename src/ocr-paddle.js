/* Price Lens: the PaddleOCR reader, as the page sees it.
 *
 * The same getReader() and readLines(source, region) as src/ocr.js. The reading itself happens in
 * a worker (src/paddle-worker.js), so the page never stops responding while a picture is read.
 * readLines takes a snapshot of the region first and hands the worker those pixels: a live video
 * moves on, and every step of the reading must see the same picture. The worker is started once
 * and kept, so later reads skip the start-up.
 *
 * Errors carry a `reason` ('unsupported', 'download', 'start', 'stalled', 'worker', 'timeout',
 * 'read') for src/reader.js, which decides what to do and what to tell people. */

const WORKER = new URL('./paddle-worker.js', import.meta.url);
const START_STALL_MS = 60000; // no word from the worker for this long while starting: it has hung
const READ_MS = 20000;        // a read on a slow phone takes a few seconds; this long means it hung

const settings = {}; // the worker's settings, changed by bench/ experiments
let worker = null, starting = null, files = [], timing = null, nextId = 1, progress = () => {};
const pending = new Map();

class ReaderError extends Error {
  constructor(reason, detail) {
    super(detail ? `PaddleOCR reader: ${reason} (${detail})` : `PaddleOCR reader: ${reason}`);
    this.reason = reason;
  }
}

/* Whether this browser can start module workers (a worker that can `import`). Browsers that know
   the option read `type` from it; older ones never look. */
export function canStart() {
  let known = false;
  try {
    new Worker('blob://', { get type() { known = true; return 'module'; } }).terminate();
  } catch {}
  return known && typeof OffscreenCanvas === 'function' && typeof WebAssembly === 'object';
}

/* Changes the worker's settings (bench experiments); takes effect on the next read. */
export function configure(options = {}) {
  Object.assign(settings, options);
  worker?.postMessage({ type: 'configure', settings: options });
}

/* The addresses of the files the reader loaded, to keep for offline use. */
export const readerFiles = () => files.slice();
/* How long its start took, in ms: { files, start } (for the benchmark) */
export const readerTiming = () => timing;

/* Stops the worker; the next getReader() starts a new one. */
export function stop(reason = 'worker', detail) {
  const err = new ReaderError(reason, detail);
  worker?.terminate();
  worker = null;
  starting = null;
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  return err;
}

/* Starts the reader once; later calls get the same one. onProgress(0..1) reports the download. */
export function getReader(onProgress) {
  if (onProgress) progress = onProgress;
  if (!starting) {
    starting = new Promise((resolve, reject) => {
      let stall = 0;
      const watch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => reject(stop('stalled', 'no answer while starting')), START_STALL_MS);
      };
      try {
        worker = new Worker(WORKER, { type: 'module', name: 'price-lens-reader' });
      } catch (err) {
        return reject(stop('unsupported', err?.message));
      }
      worker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.id != null) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.type === 'lines') p?.resolve(msg.lines);
          else p?.reject(stop('read', msg.detail));
          return;
        }
        if (msg.type === 'progress') { watch(); progress(msg.p); }
        else if (msg.type === 'ready') { clearTimeout(stall); files = msg.files || []; timing = msg.ms; resolve(); }
        else if (msg.type === 'failed') { clearTimeout(stall); reject(stop(msg.reason || 'start', msg.detail)); }
      };
      /* the worker's script did not load, or something in it threw outside a read */
      worker.onerror = (e) => {
        e.preventDefault?.();
        clearTimeout(stall);
        reject(stop('worker', e.message || 'error in the worker'));
      };
      worker.onmessageerror = () => reject(stop('worker', 'a message could not be read'));
      watch();
      worker.postMessage({ type: 'start', settings });
    });
  }
  return starting;
}

/* The region of the source as pixels the worker can have: an ImageBitmap where the browser can
   make one (it copies the frame on the graphics side), else ImageData. */
async function snapshot(source, { x, y, w, h }) {
  try {
    return await createImageBitmap(source, x, y, w, h);
  } catch {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, x, y, w, h, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }
}

/* Reads the region and returns its lines: { text, height, confidence, bbox } with bbox in source pixels. */
export async function readLines(source, region) {
  await getReader();
  const sw = source.naturalWidth || source.videoWidth || source.width, sh = source.naturalHeight || source.videoHeight || source.height;
  const x = Math.max(0, Math.round(region.x)), y = Math.max(0, Math.round(region.y));
  const r = { x, y, w: Math.min(sw - x, Math.round(region.w)), h: Math.min(sh - y, Math.round(region.h)) };
  if (r.w < 1 || r.h < 1) return [];
  const image = await snapshot(source, r);
  if (!worker) throw new ReaderError('worker', 'stopped');
  const id = nextId++;
  const lines = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(stop('timeout', `no answer in ${READ_MS / 1000} s`)); }, READ_MS);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker.postMessage({ type: 'read', id, image }, [image instanceof ImageData ? image.data.buffer : image]);
  });
  /* the worker's lines are in snapshot pixels; move them back onto the source */
  return lines.map((l) => ({
    ...l,
    bbox: { x0: l.bbox.x0 + r.x, y0: l.bbox.y0 + r.y, x1: l.bbox.x1 + r.x, y1: l.bbox.y1 + r.y },
  }));
}
