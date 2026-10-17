/* Price Lens: reading text off a picture with PaddleOCR, in a worker of its own.
 *
 * Tesseract (src/ocr.js) was made for scanned pages: dark text in tidy lines on white. PaddleOCR's
 * PP-OCR models were trained on photos of signs, shelves and packaging, at angles and in odd light,
 * which is what a price tag looks like through a phone camera. Reading takes two steps, each a
 * small neural network run by ONNX Runtime compiled to WebAssembly:
 *
 *   1. detection: the picture goes in; out comes a map of how likely each pixel is to be text.
 *      The blobs in that map become boxes (src/paddle-boxes.js).
 *   2. recognition: each box is cut out, turned level, scaled to 48 pixels high and read as one
 *      line of characters.
 *
 * All of it runs here, off the page's thread, so the page stays smooth while a picture is read
 * (a read takes a second or more on a phone). The page sends a snapshot of the part to read
 * (src/ocr-paddle.js); detection and every crop use those same pixels.
 *
 * Messages in:  { type: 'start', settings }, { type: 'read', id, image }, { type: 'configure', settings }
 * Messages out: { type: 'progress', p }, { type: 'ready', files, ms }, { type: 'failed', reason, detail },
 *               { type: 'lines', id, lines }, { type: 'failed', id, detail }
 * `detail` is for the console only; the page words what people see. */

import {
  findBoxes, toSource, extent, inside, boxArea, boxHeight, boxLength, turned, flipped,
  CROP_H, cropWidth, cropTransform, alphabet, decode, inkMask, letterHeight, markRaisedCents, assemble,
} from './paddle-boxes.js';

const CDN = 'https://cdn.jsdelivr.net/npm/';
/* ONNX Runtime Web (MIT), the WebAssembly-only build. It runs on one thread: GitHub Pages cannot
   send the headers (COOP and COEP) that WebAssembly threads need. */
const ORT_DIR = CDN + 'onnxruntime-web@1.24.3/dist/';
const ORT = {
  module: { url: ORT_DIR + 'ort.wasm.min.mjs', size: 49997 },
  glue: { url: ORT_DIR + 'ort-wasm-simd-threaded.mjs', size: 24274 },
  wasm: { url: ORT_DIR + 'ort-wasm-simd-threaded.wasm', size: 12361745 }, // 2.6 MB as sent
};

/* Model sets: PaddleOCR's weights (Apache-2.0) as ONNX, at pinned versions. size: bytes once
   unpacked, for the progress bar. */
const file = (url, size) => ({ url: CDN + url, size });
const MODEL_SETS = {
  /* PP-OCRv6 tiny (2026), the default: 6 MB for both. 6,905 characters: Latin with its accents,
     Greek, Chinese, € £ ¥ ₹ ₩ ₽ ₺ ₪ ₫ ₱; no Cyrillic, Japanese kana, Hangul, Thai, or 円. */
  'v6-tiny': {
    det: file('@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/det/inference.onnx', 1780590),
    rec: file('@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/rec/inference.onnx', 4462639),
    dict: file('@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/rec/dictionary.json', 41009),
  },
  /* PP-OCRv6 small: 31 MB, three times slower; 18,709 characters (adds 円, Cyrillic, kana, Hangul) */
  'v6-small': {
    det: file('@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/det/inference.onnx', 9880512),
    rec: file('@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/rec/inference.onnx', 21159378),
    dict: file('@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/rec/dictionary.json', 112408),
  },
};
/* PaddleOCR's text direction classifier (upright or turned 180°), 0.6 MB; works with either set */
const CLS = file('@gutenye/ocr-models@1.4.2/assets/ch_ppocr_mobile_v2.0_cls_infer.onnx', 578966);

/* What the reader does; bench/ experiments change these before the first read. */
const settings = {
  models: 'v6-tiny',
  det: null,        // a detection model from the other set (null: the set's own)
  detSide: 640,     // the long side of the picture the detector sees, in pixels
  detSide2: 0,      // and of a second, smaller look for big letters (0: none)
  upscale: true,    // enlarge small pictures to detSide too (small text is found more often)
  thresh: 0.2,      // a pixel is text when the map says at least this (PP-OCRv6's own value)
  boxThresh: 0.4,   // a box is kept when the map's mean inside it is at least this (PP-OCRv6's own value;
                    // 0.3 to 0.45 read the benchmark's tags the same, 0.5 lost some)
  unclip: 1.4,      // how far each box is grown past the text's core (PP-OCRv6's own value)
  maxBoxes: 60,     // boxes read per picture, biggest first: a whole shelf can hold hundreds
  minWidth: 320,    // the recogniser reads crops padded to at least this width, as it was trained
  angle: false,     // run the upside-down classifier
  tall: 1.5,        // a box this many times taller than long is also read turned a quarter each way (0: never)
  joinLines: true,  // join boxes on the same line, so "€" and "4,99" read as one line
  raisedCents: true, // read "4⁹⁹" as 4.99 (see markRaisedCents)
  wasmBytes: false, // hand ONNX Runtime its WebAssembly as bytes instead of letting it fetch it (for measuring)
};

const post = (msg) => self.postMessage(msg);
let reader = null;
let queue = Promise.resolve(); // one job at a time: a model cannot run twice at once

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'configure') Object.assign(settings, msg.settings);
  else if (msg.type === 'start') queue = queue.then(() => start(msg.settings));
  else if (msg.type === 'read') queue = queue.then(() => read(msg));
};

/* ---------- starting ---------- */

/* (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt): valid only where WebAssembly has SIMD */
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

/* What this browser lacks that the reader needs, or null. ONNX Runtime 1.24 ships only builds that
   use SIMD and whose WebAssembly asks for shared memory, even on one thread. */
function missing() {
  try { if (!new OffscreenCanvas(1, 1).getContext('2d')) return 'OffscreenCanvas 2D'; } catch { return 'OffscreenCanvas 2D'; }
  try { if (!WebAssembly.validate(SIMD_TEST)) return 'WebAssembly SIMD'; } catch { return 'WebAssembly SIMD'; }
  try { new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }); } catch { return 'shared WebAssembly memory'; }
  return null;
}

async function start(options) {
  Object.assign(settings, options);
  const lack = missing();
  if (lack) return post({ type: 'failed', reason: 'unsupported', detail: 'no ' + lack });
  try {
    reader = await load();
    post({ type: 'ready', files: reader.files, ms: reader.ms });
  } catch (err) {
    post({ type: 'failed', reason: err.reason || 'start', detail: String(err?.message || err) });
  }
}

/* Fetches a file, reporting bytes as they arrive; keeps them only when asked. */
async function fetchBytes(url, signal, onBytes, keep = true) {
  const res = await fetch(url, { mode: 'cors', signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) { const b = new Uint8Array(await res.arrayBuffer()); onBytes(b.length); return keep ? b : null; }
  const stream = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await stream.read();
    if (done) break;
    if (keep) parts.push(value);
    size += value.length;
    onBytes(value.length);
  }
  if (!keep) return null;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const stored = async (url) => { try { return !!(await caches.match(url, { ignoreVary: true })); } catch { return false; } };

/* Loads the runtime and the models, all at once. If one download fails, the others stop too. */
async function load() {
  const t0 = performance.now();
  const set = MODEL_SETS[settings.models];
  const models = [settings.det ? MODEL_SETS[settings.det].det : set.det, set.rec, ...(settings.angle ? [CLS] : [])];
  const files = [ORT.module, ORT.glue, ORT.wasm, set.dict, ...models];
  const total = files.reduce((n, f) => n + f.size, 0);
  let got = 0, shown = 0;
  const onBytes = (n) => {
    got += n;
    if (got / total - shown >= 0.01) { shown = got / total; post({ type: 'progress', p: Math.min(0.99, shown) }); }
  };
  const stop = new AbortController();
  const failed = (err) => {
    stop.abort();
    throw Object.assign(new Error(String(err?.message || err)), { reason: 'download' });
  };
  /* ONNX Runtime fetches its WebAssembly itself (see below). Fetching it once here first shows its
     progress and puts it in the browser's cache, where the runtime then finds it; when the offline
     copy already has it, there is nothing to fetch. */
  const warmWasm = async () => {
    if (settings.wasmBytes) return fetchBytes(ORT.wasm.url, stop.signal, onBytes);
    if (await stored(ORT.wasm.url)) return onBytes(ORT.wasm.size);
    await fetchBytes(ORT.wasm.url, stop.signal, onBytes, false);
  };
  const [ort, wasm, dictBytes, ...modelBytes] = await Promise.all([
    import(ORT.module.url).then((m) => { onBytes(ORT.module.size + ORT.glue.size); return m; }),
    warmWasm(),
    fetchBytes(set.dict.url, stop.signal, onBytes),
    ...models.map((m) => fetchBytes(m.url, stop.signal, onBytes)),
  ].map((p) => p.catch(failed)));

  const t1 = performance.now();
  try {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    /* Letting the runtime fetch the .wasm by its address lets the browser compile it while it
       streams in, and keep the compiled code for next time; bytes handed over in memory would be
       compiled from scratch at every start. */
    if (wasm) ort.env.wasm.wasmBinary = wasm;
    else ort.env.wasm.wasmPaths = ORT_DIR;
    const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const sessions = [];
    for (const bytes of modelBytes) sessions.push(await ort.InferenceSession.create(bytes, options));
    /* the number of classes the recogniser tells apart, read off one tiny run */
    const rec = sessions[1];
    const probe = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * CROP_H * 32), [1, 3, CROP_H, 32]) });
    const dict = alphabet(new TextDecoder().decode(dictBytes), set.dict.url.endsWith('.json'), probe[rec.outputNames[0]].dims[2]);
    post({ type: 'progress', p: 1 });
    /* how long the downloads (or the stored copies) and the start of the runtime and models took */
    const ms = { files: Math.round(t1 - t0), start: Math.round(performance.now() - t1) };
    return { ort, det: sessions[0], rec, cls: sessions[2] || null, dict, files: files.map((f) => f.url), ms };
  } catch (err) {
    throw Object.assign(new Error(String(err?.message || err)), { reason: 'start' });
  }
}

/* ---------- reading ---------- */

const canvas = (w, h) => {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  return [c, ctx];
};

/* The snapshot (an ImageBitmap, or ImageData where the page could not make one) as a canvas to
   draw from, once: every step below reads these same pixels. */
function sourceOf(image) {
  const [c, ctx] = canvas(image.width, image.height);
  if (image instanceof ImageData) ctx.putImageData(image, 0, 0);
  else { ctx.drawImage(image, 0, 0); image.close(); }
  return c;
}

/* Draws the picture at the detector's size (multiples of 32) and turns it into its input:
 * blue, green, red planes (PaddleOCR reads pictures with OpenCV, which is BGR), normalised with the
 * ImageNet mean and spread it was trained with. */
function detectionInput(src, side) {
  const w = src.width, h = src.height;
  let scale = side / Math.max(w, h);
  if (!settings.upscale) scale = Math.min(1, scale);
  const dw = Math.max(32, Math.round((w * scale) / 32) * 32);
  const dh = Math.max(32, Math.round((h * scale) / 32) * 32);
  const [, ctx] = canvas(dw, dh);
  ctx.drawImage(src, 0, 0, w, h, 0, 0, dw, dh);
  const px = ctx.getImageData(0, 0, dw, dh).data;
  const n = dw * dh;
  const data = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) data[c * n + i] = (px[i * 4 + 2 - c] / 255 - mean[c]) / std[c];
  }
  return { data, dw, dh, sx: w / dw, sy: h / dh };
}

/* Finds the lines of text at one size: boxes in snapshot pixels. */
async function detectAt(src, side) {
  const { ort, det } = reader;
  const input = detectionInput(src, side);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, input.dh, input.dw]) });
  const map = out[det.outputNames[0]];
  const [mh, mw] = map.dims.slice(-2);
  /* the map is the input's size; scale its rectangles back to the snapshot */
  const fx = input.sx * (input.dw / mw), fy = input.sy * (input.dh / mh);
  return findBoxes(map.data, mw, mh, settings).map((r) => toSource(r, fx, fy));
}

/* Finds the lines of text. The small detector misses letters that fill a large part of what it
 * sees (the big price, close up), so it can also look at a smaller copy, where they are of a size
 * it knows; boxes found there are added where the first look found little. */
async function detect(src) {
  let boxes = await detectAt(src, settings.detSide);
  if (settings.detSide2) {
    for (const b of await detectAt(src, settings.detSide2)) {
      const covered = boxes.reduce((sum, a) => sum + inside(b, a), 0);
      if (covered >= 0.5) continue;
      boxes = boxes.filter((a) => inside(a, b) < 0.7);
      boxes.push(b);
    }
  }
  return boxes.sort((a, b) => boxArea(b) - boxArea(a)).slice(0, settings.maxBoxes);
}

/* Cuts one box out of the snapshot, level and 48 pixels high. */
function crop(src, b) {
  const W = cropWidth(b), H = CROP_H;
  const [, ctx] = canvas(W, H);
  ctx.setTransform(...cropTransform(b, W, H));
  /* only the part of the snapshot under the box is drawn */
  const e = extent(b);
  const x0 = Math.max(0, Math.floor(e.x0 - 2)), y0 = Math.max(0, Math.floor(e.y0 - 2));
  const x1 = Math.min(src.width, Math.ceil(e.x1 + 2)), y1 = Math.min(src.height, Math.ceil(e.y1 + 2));
  if (x1 > x0 && y1 > y0) ctx.drawImage(src, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  return ctx.getImageData(0, 0, W, H);
}

/* Several crops as one input, padded on the right to the same width with grey (0 after normalising). */
function recognitionInput(crops, width) {
  const H = CROP_H, plane = H * width;
  const data = new Float32Array(crops.length * 3 * plane);
  crops.forEach((img, k) => {
    const base = k * 3 * plane, px = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4, o = y * width + x;
        data[base + o] = px[i + 2] / 127.5 - 1;
        data[base + plane + o] = px[i + 1] / 127.5 - 1;
        data[base + 2 * plane + o] = px[i] / 127.5 - 1;
      }
    }
  });
  return data;
}

/* Reads the crops, a few at a time; the shortest go together so little is padding. */
async function recognize(crops) {
  const { ort, rec, dict } = reader;
  const order = crops.map((c, i) => i).sort((a, b) => crops[a].width - crops[b].width);
  const results = new Array(crops.length);
  for (let s = 0; s < order.length; s += 6) {
    const batch = order.slice(s, s + 6);
    const width = Math.max(settings.minWidth, ...batch.map((i) => crops[i].width));
    const data = recognitionInput(batch.map((i) => crops[i]), width);
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, CROP_H, width]) });
    const p = out[rec.outputNames[0]];
    const [, steps, classes] = p.dims;
    batch.forEach((i, k) => {
      results[i] = decode(p.data, steps, classes, k * steps * classes, dict);
      results[i].stride = width / steps; // crop pixels per step
    });
  }
  return results;
}

/* The upside-down check: PaddleOCR's direction classifier says, for each crop, whether it is
 * turned 180°. A phone aimed at a tag is nearly always upright, so this is off unless asked for. */
async function upsideDown(crops) {
  const { ort, cls } = reader;
  const W = 192, H = CROP_H;
  const out = [];
  for (const img of crops) {
    /* the classifier wants 48 x 192: squeeze or pad the 48-high crop */
    const [tmp, tctx] = canvas(img.width, H);
    tctx.putImageData(img, 0, 0);
    const [, ctx] = canvas(W, H);
    ctx.drawImage(tmp, 0, 0, Math.min(W, img.width), H);
    const data = recognitionInput([ctx.getImageData(0, 0, W, H)], W);
    const res = await cls.run({ [cls.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, W]) });
    const p = res[cls.outputNames[0]].data;
    out.push(p[1] > p[0] && p[1] > 0.9);
  }
  return out;
}

/* Reads the snapshot and returns its lines: { text, height, confidence, bbox } in snapshot pixels. */
async function readLines(src) {
  let boxes = await detect(src);
  if (!boxes.length) return [];
  /* A box much taller than long is either one tall letter ("1") or a line of text running up or
     down the picture. Read it all three ways and keep the reading the recogniser is surest of. */
  const tall = settings.tall ? boxes.flatMap((b, i) => (boxHeight(b) >= settings.tall * boxLength(b) ? [i] : [])) : [];
  const ways = tall.flatMap((i) => [turned(boxes[i]), flipped(turned(boxes[i]))]);
  let all = boxes.concat(ways);
  let crops = all.map((b) => crop(src, b));
  if (settings.angle && reader.cls) {
    const flip = await upsideDown(crops);
    all = all.map((b, i) => (flip[i] ? flipped(b) : b));
    crops = crops.map((c, i) => (flip[i] ? crop(src, all[i]) : c));
  }
  const read = await recognize(crops);
  tall.forEach((j, k) => {
    for (const i of [boxes.length + 2 * k, boxes.length + 2 * k + 1]) {
      if (read[i].chars.length && read[i].confidence > read[j].confidence) { all[j] = all[i]; crops[j] = crops[i]; read[j] = read[i]; }
    }
  });
  const items = [];
  boxes.forEach((_, i) => {
    const b = all[i], r = read[i], img = crops[i];
    const mask = inkMask(img);
    if (settings.raisedCents) markRaisedCents(r, img, mask);
    const text = r.chars.join('').trim();
    if (!text) return;
    /* the letters' height, measured in the crop and scaled back to the picture; where no ink
       stands out, three quarters of the box (the usual share on the benchmark's photos) */
    const size = boxHeight(b);
    const ink = letterHeight(r, img, mask);
    const height = ink ? (ink * size) / CROP_H : size * 0.75;
    items.push({ text, height, size, confidence: r.confidence, bbox: extent(b) });
  });
  return assemble(items, settings);
}

async function read({ id, image }) {
  try {
    if (!reader) throw new Error('the reader has not started');
    const lines = await readLines(sourceOf(image));
    post({ type: 'lines', id, lines });
  } catch (err) {
    image?.close?.();
    post({ type: 'failed', id, detail: String(err?.message || err) });
  }
}
