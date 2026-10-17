/* Price Lens: reading text off a picture with PaddleOCR, on the phone itself.
 *
 * The same readLines(source, region) as src/ocr.js, with a different reader behind it. Tesseract
 * (src/ocr.js) was made for scanned pages: dark text in tidy lines on white. PaddleOCR's PP-OCR
 * models were trained on photos of signs, shelves and packaging, at angles and in odd light, which
 * is what a price tag looks like through a phone camera. Reading takes two steps, each a small
 * neural network run by ONNX Runtime compiled to WebAssembly:
 *
 *   1. detection: the picture goes in; out comes a map of how likely each pixel is to be text.
 *      The blobs in that map become boxes (the "DB" post-processing, done here in plain JS).
 *   2. recognition: each box is cut out, turned level, scaled to 48 pixels high and read as one
 *      line of characters.
 *
 * The runtime and the models are fetched from the CDN the first time, at pinned versions, and kept
 * by the offline worker. It runs on one thread: GitHub Pages cannot send the headers (COOP and
 * COEP) that WebAssembly threads need. */

const CDN = 'https://cdn.jsdelivr.net/npm/';
const ORT_DIR = CDN + 'onnxruntime-web@1.24.3/dist/'; // MIT; the WebAssembly-only build, 12 MB (2.6 MB as sent)

/* Model sets: PaddleOCR's weights (Apache-2.0) as ONNX, at pinned versions. size: bytes, for the progress bar. */
export const MODEL_SETS = {
  /* PP-OCRv6 tiny (2026), the default: 6 MB for both. 6,905 characters: Latin with its accents,
     Greek, Chinese, € £ ¥ ₹ ₩ ₽ ₺ ₪ ₫ ₱; no Cyrillic, Japanese kana, Hangul, Thai, or 円. */
  'v6-tiny': {
    det: CDN + '@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/det/inference.onnx', // Apache-2.0
    rec: CDN + '@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/rec/inference.onnx',
    dict: CDN + '@arcships/light-ocr-model-ppocrv6-tiny@0.1.0/bundle/rec/dictionary.json',
    size: 6.3e6,
  },
  /* PP-OCRv6 small: 31 MB, three times slower; 18,709 characters (adds 円, Cyrillic, kana, Hangul) */
  'v6-small': {
    det: CDN + '@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/det/inference.onnx', // Apache-2.0
    rec: CDN + '@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/rec/inference.onnx',
    dict: CDN + '@arcships/light-ocr-model-ppocrv6-small@0.3.4/bundle/rec/dictionary.json',
    size: 31.1e6,
  },
  /* PP-OCRv4 mobile, Chinese and English (2023): 16 MB. Its dictionary has no € or £. */
  'v4': {
    det: CDN + '@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_det_infer.onnx', // MIT package, Apache-2.0 weights
    rec: CDN + '@gutenye/ocr-models@1.4.2/assets/ch_PP-OCRv4_rec_infer.onnx',
    dict: CDN + '@gutenye/ocr-models@1.4.2/assets/ppocr_keys_v1.txt',
    size: 15.6e6,
  },
};
/* PaddleOCR's text direction classifier (upright or turned 180°), 0.6 MB; works with any set */
const CLS = CDN + '@gutenye/ocr-models@1.4.2/assets/ch_ppocr_mobile_v2.0_cls_infer.onnx';

/* What the reader does; bench/ experiments change these before the first scan. */
export const settings = {
  models: 'v6-tiny',
  det: null,        // a detection model from another set, e.g. 'v4' (null: the set's own)
  detSide: 640,     // the long side of the picture the detector sees, in pixels
  detSide2: 0,      // and of a second, smaller look for big letters (0: none)
  upscale: true,    // enlarge small pictures to detSide too (small text is found more often)
  thresh: 0.2,      // a pixel is text when the map says at least this
  boxThresh: 0.45,  // a box is kept when the map's mean inside it is at least this
  unclip: 1.4,      // how far each box is grown past the text's core (PP-OCRv6's own values)
  maxBoxes: 60,     // boxes read per picture, biggest first: a whole shelf can hold hundreds
  minWidth: 320,    // the recogniser reads crops padded to at least this width, as it was trained
  angle: false,     // run the upside-down classifier
  joinLines: true,  // join boxes on the same line, so "€" and "4,99" read as one line
  raisedCents: true, // read "4⁹⁹" as 4.99 (see markRaisedCents)
  recognizer: null, // another reader for the crops, (crops) => [{ chars, confidence }] (bench experiments)
};

/* Changes settings; a different model set takes effect on the next getReader(). */
export function configure(options = {}) {
  const models = options.models ?? settings.models, det = options.det ?? settings.det, angle = options.angle ?? settings.angle;
  if (models !== settings.models || det !== settings.det || angle !== settings.angle) readerPromise = null;
  Object.assign(settings, options);
}

let readerPromise = null;

/* Fetches a file, reporting bytes as they arrive. */
async function fetchBytes(url, onBytes) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Could not load the text reader (${res.status}). Check the connection.`);
  if (!res.body || !onBytes) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* The recogniser's alphabet: index 0 of its output is CTC's "blank", then one entry per character.
 * Some dictionaries leave out the space at the end, which the model still has. */
function alphabet(raw, json, classes) {
  let chars = json ? JSON.parse(raw).characters : raw.split('\n').map((c) => c.replace(/\r$/, ''));
  if (chars.length > classes - 1 && chars[chars.length - 1] === '') chars = chars.slice(0, -1);
  if (chars.length === classes - 2) chars.push(' ');
  if (chars.length !== classes - 1) throw new Error(`dictionary has ${chars.length} characters, model reads ${classes - 1}`);
  return ['', ...chars];
}

/* Starts the reader once; later calls get the same one. onProgress(0..1, words) reports loading. */
export function getReader(onProgress = () => {}) {
  if (!readerPromise) {
    readerPromise = (async () => {
      const set = MODEL_SETS[settings.models];
      const detUrl = settings.det ? MODEL_SETS[settings.det].det : set.det;
      const models = [detUrl, set.rec, ...(settings.angle ? [CLS] : [])];
      let got = 0;
      const total = set.size + 12.4e6 + (settings.angle ? 0.6e6 : 0);
      const onBytes = (n) => { got += n; onProgress(Math.min(0.99, got / total), 'loading text reader'); };
      /* everything at once: the runtime, its WebAssembly, the models and the alphabet */
      const [ort, wasm, dictText, ...files] = await Promise.all([
        import(ORT_DIR + 'ort.wasm.min.mjs'),
        fetchBytes(ORT_DIR + 'ort-wasm-simd-threaded.wasm', onBytes),
        fetchBytes(set.dict).then((b) => new TextDecoder().decode(b)),
        ...models.map((u) => fetchBytes(u, onBytes)),
      ]);
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = ORT_DIR;
      ort.env.wasm.wasmBinary = wasm;
      const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
      const sessions = [];
      for (const f of files) sessions.push(await ort.InferenceSession.create(f, options));
      /* the number of classes the recogniser tells apart, read off one tiny run */
      const rec = sessions[1];
      const probe = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 48 * 32), [1, 3, 48, 32]) });
      const dict = alphabet(dictText, set.dict.endsWith('.json'), probe[rec.outputNames[0]].dims[2]);
      onProgress(1, 'ready');
      return { ort, det: sessions[0], rec, cls: sessions[2] || null, dict };
    })().catch((err) => {
      readerPromise = null;
      throw err;
    });
  }
  return readerPromise;
}

/* ---------- 1. detection ---------- */

/* Draws the region at the detector's size (multiples of 32) and turns it into its input:
 * blue, green, red planes (PaddleOCR reads pictures with OpenCV, which is BGR), normalised with the
 * ImageNet mean and spread it was trained with. */
function detectionInput(source, region, side) {
  const { x, y, w, h } = region;
  let scale = side / Math.max(w, h);
  if (!settings.upscale) scale = Math.min(1, scale);
  const dw = Math.max(32, Math.round((w * scale) / 32) * 32);
  const dh = Math.max(32, Math.round((h * scale) / 32) * 32);
  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, w, h, 0, 0, dw, dh);
  const px = ctx.getImageData(0, 0, dw, dh).data;
  const n = dw * dh;
  const data = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) data[c * n + i] = (px[i * 4 + 2 - c] / 255 - mean[c]) / std[c];
  }
  return { data, dw, dh, sx: w / dw, sy: h / dh };
}

/* Convex hull of points [x, y, x, y, ...] (Andrew's monotone chain), as a list of [x, y]. */
function hull(flat) {
  const pts = [];
  for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/* The smallest rectangle around a convex hull, at any angle (rotating calipers: one of its sides
 * lies on a side of the hull). Returned as a centre, a unit direction along its length, and half
 * sizes, with the direction the one nearer horizontal, pointing right: text on a tag is upright. */
function minAreaRect(h) {
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const [x0, y0] = h[i], [x1, y1] = h[(i + 1) % h.length];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!len) continue;
    const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of h) {
      const a = x * ux + y * uy, b = -x * uy + y * ux;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area) best = { area, ux, uy, a0, a1, b0, b1 };
  }
  if (!best) return null;
  let { ux, uy, a0, a1, b0, b1 } = best;
  const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
  const cx = ca * ux - cb * uy, cy = ca * uy + cb * ux;
  let hw = (a1 - a0) / 2, hh = (b1 - b0) / 2;
  /* make u the axis nearer horizontal, pointing right */
  if (Math.abs(uy) > Math.abs(ux)) { [ux, uy] = [uy, -ux]; [hw, hh] = [hh, hw]; }
  if (ux < 0) { ux = -ux; uy = -uy; }
  return { cx, cy, ux, uy, hw, hh };
}

/* Mean of the map inside a rectangle (PaddleOCR's "box score"): a blob that is only faintly text
 * as a whole is dropped. */
function boxScore(prob, W, H, r) {
  const ex = Math.abs(r.ux) * r.hw + Math.abs(r.uy) * r.hh, ey = Math.abs(r.uy) * r.hw + Math.abs(r.ux) * r.hh;
  const x0 = Math.max(0, Math.floor(r.cx - ex)), x1 = Math.min(W - 1, Math.ceil(r.cx + ex));
  const y0 = Math.max(0, Math.floor(r.cy - ey)), y1 = Math.min(H - 1, Math.ceil(r.cy + ey));
  let sum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - r.cx, dy = y + 0.5 - r.cy;
      if (Math.abs(dx * r.ux + dy * r.uy) <= r.hw && Math.abs(-dx * r.uy + dy * r.ux) <= r.hh) { sum += prob[y * W + x]; n++; }
    }
  }
  return n ? sum / n : 0;
}

/* Turns the probability map into rectangles in map pixels: threshold it, take each connected blob,
 * fit the smallest rectangle around it, and grow that by the "unclip" distance. The detector is
 * trained to mark only the core of each line of text, so that lines close together stay apart;
 * growing the box gives back the whole line. */
function findBoxes(prob, W, H) {
  const { thresh, boxThresh, unclip } = settings;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const rowMin = new Int32Array(H).fill(W), rowMax = new Int32Array(H).fill(-1);
  const boxes = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || prob[start] <= thresh) continue;
    /* flood fill the blob (8 neighbours, as OpenCV's contours), noting each row's leftmost and rightmost pixel */
    let top = 0, count = 0;
    const rows = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      const x = i % W, y = (i - x) / W;
      count++;
      if (rowMax[y] < 0) rows.push(y);
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const j = yy * W + xx;
          if (!seen[j] && prob[j] > thresh) { seen[j] = 1; stack[top++] = j; }
        }
      }
    }
    /* the blob's outline: each row's two ends, as pixel corners */
    const pts = [];
    for (const y of rows) {
      pts.push(rowMin[y], y, rowMax[y] + 1, y, rowMin[y], y + 1, rowMax[y] + 1, y + 1);
      rowMin[y] = W; rowMax[y] = -1;
    }
    if (count < 4) continue;
    const r = minAreaRect(hull(pts));
    if (!r || Math.min(r.hw, r.hh) * 2 < 3) continue;
    const score = boxScore(prob, W, H, r);
    if (score < boxThresh) continue;
    /* grow by area * ratio / perimeter, as PaddleOCR's unclip (pyclipper offset) does */
    const w = r.hw * 2, h = r.hh * 2;
    const d = (w * h * unclip) / (2 * (w + h));
    r.hw += d; r.hh += d;
    if (r.hh * 2 < 5) continue;
    r.score = score;
    boxes.push(r);
  }
  return boxes;
}

/* Finds the lines of text in the region at one size: rectangles in source pixels. */
async function detectAt(reader, source, region, side) {
  const { ort, det } = reader;
  const input = detectionInput(source, region, side);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', input.data, [1, 3, input.dh, input.dw]) });
  const map = out[det.outputNames[0]];
  const [mh, mw] = map.dims.slice(-2);
  /* the map is the input's size; scale its rectangles back to the source */
  const fx = input.sx * (input.dw / mw), fy = input.sy * (input.dh / mh);
  return findBoxes(map.data, mw, mh).map((r) => toSource(r, fx, fy, region));
}

/* The upright box around a rectangle, and how much of a's box lies inside b's. */
const extent = (r) => {
  const ex = Math.abs(r.ux) * r.hw + Math.abs(r.uy) * r.hh, ey = Math.abs(r.uy) * r.hw + Math.abs(r.ux) * r.hh;
  return { x0: r.cx - ex, y0: r.cy - ey, x1: r.cx + ex, y1: r.cy + ey };
};
function inside(a, b) {
  const A = extent(a), B = extent(b);
  const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  return w > 0 && h > 0 ? (w * h) / ((A.x1 - A.x0) * (A.y1 - A.y0)) : 0;
}

/* Finds the lines of text in the region. The small detector misses letters that fill a large part
 * of what it sees (the big price, close up), so it also looks at a smaller copy, where they are
 * of a size it knows; boxes found there are added where the first look found little. */
async function detect(reader, source, region) {
  let boxes = await detectAt(reader, source, region, settings.detSide);
  if (settings.detSide2) {
    for (const b of await detectAt(reader, source, region, settings.detSide2)) {
      const covered = boxes.reduce((sum, a) => sum + inside(b, a), 0);
      if (covered >= 0.5) continue;
      boxes = boxes.filter((a) => inside(a, b) < 0.7);
      boxes.push(b);
    }
  }
  return boxes.sort((a, b) => b.hw * b.hh - a.hw * a.hh).slice(0, settings.maxBoxes);
}

/* A rectangle from map pixels to source pixels (the two may be scaled differently across and down). */
function toSource(r, fx, fy, region) {
  const ax = r.ux * r.hw * fx, ay = r.uy * r.hw * fy;    // half of the long side
  const bx = -r.uy * r.hh * fx, by = r.ux * r.hh * fy;   // half of the short side
  const hw = Math.hypot(ax, ay), hh = Math.hypot(bx, by);
  return { cx: region.x + r.cx * fx, cy: region.y + r.cy * fy, ux: ax / hw, uy: ay / hw, hw, hh, score: r.score };
}

/* ---------- 2. recognition ---------- */

/* Cuts one rectangle out of the source, level and 48 pixels high. */
function crop(source, r, flip = false) {
  const H = 48;
  const W = Math.max(8, Math.min(48 * 40, Math.round((H * r.hw) / r.hh)));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  /* map source pixels onto the crop: along the box becomes across the crop, scaled to fit */
  const sx = (2 * r.hw) / W, sy = (2 * r.hh) / H;
  let { ux, uy } = r;
  if (flip) { ux = -ux; uy = -uy; }
  const tlx = r.cx - ux * r.hw + uy * r.hh, tly = r.cy - uy * r.hw - ux * r.hh;
  ctx.setTransform(ux / sx, -uy / sy, uy / sx, ux / sy, -(ux * tlx + uy * tly) / sx, (uy * tlx - ux * tly) / sy);
  /* only the part of the source under the box is drawn */
  const ex = Math.abs(ux) * r.hw + Math.abs(uy) * r.hh + 2, ey = Math.abs(uy) * r.hw + Math.abs(ux) * r.hh + 2;
  const sw = source.naturalWidth || source.videoWidth || source.width, sh = source.naturalHeight || source.videoHeight || source.height;
  const x0 = Math.max(0, Math.floor(r.cx - ex)), y0 = Math.max(0, Math.floor(r.cy - ey));
  const x1 = Math.min(sw, Math.ceil(r.cx + ex)), y1 = Math.min(sh, Math.ceil(r.cy + ey));
  if (x1 > x0 && y1 > y0) ctx.drawImage(source, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  return ctx.getImageData(0, 0, W, H);
}

/* Several crops as one input, padded on the right to the same width with grey (0 after normalising). */
function recognitionInput(crops, width) {
  const H = 48, plane = H * width;
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

/* CTC greedy decoding: the likeliest class at each step, repeats merged, blanks dropped.
 * Confidence is the mean probability of the characters kept. Each character also keeps the steps
 * it was read at, which says where in the crop it is. */
function decode(probs, steps, classes, offset, dict) {
  const chars = [], at = [];
  let sum = 0, last = 0;
  for (let t = 0; t < steps; t++) {
    const row = offset + t * classes;
    let best = 0, bp = probs[row];
    for (let c = 1; c < classes; c++) if (probs[row + c] > bp) { bp = probs[row + c]; best = c; }
    if (best !== 0 && best === last) at[at.length - 1][1] = t;
    else if (best !== 0) { chars.push(dict[best]); at.push([t, t]); sum += bp; }
    last = best;
  }
  return { chars, at, confidence: chars.length ? (sum / chars.length) * 100 : 0 };
}

/* Reads the crops, a few at a time; the shortest go together so little is padding. */
async function recognize(reader, crops) {
  const { ort, rec, dict } = reader;
  const order = crops.map((c, i) => i).sort((a, b) => crops[a].width - crops[b].width);
  const results = new Array(crops.length);
  for (let s = 0; s < order.length; s += 6) {
    const batch = order.slice(s, s + 6);
    const width = Math.max(settings.minWidth, ...batch.map((i) => crops[i].width));
    const data = recognitionInput(batch.map((i) => crops[i]), width);
    const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', data, [batch.length, 3, 48, width]) });
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
async function upsideDown(reader, crops) {
  const { ort, cls } = reader;
  const W = 192, H = 48;
  const out = [];
  for (const img of crops) {
    /* the classifier wants 48 x 192: squeeze or pad the 48-high crop */
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const tmp = document.createElement('canvas');
    tmp.width = img.width; tmp.height = H;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, Math.min(W, img.width), H);
    const data = recognitionInput([ctx.getImageData(0, 0, W, H)], W);
    const res = await cls.run({ [cls.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, H, W]) });
    const p = res[cls.outputNames[0]].data;
    out.push(p[1] > p[0] && p[1] > 0.9);
  }
  return out;
}

/* ---------- cents printed small and raised ---------- */

/* Which pixels of a crop are ink: Otsu's threshold on brightness, and ink is whichever side the
 * crop's border is not (dark on light or light on dark). */
function inkMask(img) {
  const { width: W, height: H, data } = img;
  const g = new Uint8Array(W * H), hist = new Uint32Array(256);
  for (let i = 0; i < W * H; i++) { g[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000; hist[g[i]]++; }
  let total = 0, best = 0, cut = 128, w0 = 0, s0 = 0;
  for (let v = 0; v < 256; v++) total += v * hist[v];
  for (let v = 0; v < 256; v++) {
    w0 += hist[v]; s0 += v * hist[v];
    const w1 = W * H - w0;
    if (!w0 || !w1) continue;
    const between = w0 * w1 * (s0 / w0 - (total - s0) / w1) ** 2;
    if (between > best) { best = between; cut = v; }
  }
  let dark = 0, n = 0;
  for (let x = 0; x < W; x++) { dark += (g[x] <= cut) + (g[(H - 1) * W + x] <= cut); n += 2; }
  const inkIsDark = dark < n / 2;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = (g[i] <= cut) === inkIsDark;
  return mask;
}

/* The runs of ink rows between two columns of the crop, top to bottom, as [top, bottom].
 * Gaps of a row or two do not split a run; a wider gap does (the "€" or "лв" printed under
 * small cents is a run of its own). */
function inkRuns(mask, W, H, x0, x1) {
  x0 = Math.max(0, Math.round(x0)); x1 = Math.min(W, Math.round(x1));
  const need = Math.max(1, (x1 - x0) * 0.15);
  const runs = [];
  let gap = 99;
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) n += mask[y * W + x];
    if (n < need) { gap++; continue; }
    if (gap > 2 || !runs.length) runs.push([y, y]);
    else runs[runs.length - 1][1] = y;
    gap = 0;
  }
  return runs;
}

/* The recogniser reads characters, not their size, so "4⁹⁹" (cents small and raised, as on most
 * shelf labels) comes out as "499". The crop still shows the size: where a run of three or more
 * digits ends in two that are much shorter than the rest and level with their tops, those two
 * are cents, and a point goes before them. */
function markRaisedCents(read, img) {
  const { chars, at, stride } = read;
  const W = img.width, H = img.height;
  let mask = null;
  const centre = (k) => ((at[k][0] + at[k][1] + 1) / 2) * stride;
  for (let e = chars.length; e > 0; e--) {
    if (!/\d/.test(chars[e - 1]) || (e < chars.length && /\d/.test(chars[e]))) continue;
    let s = e;
    while (s > 0 && /\d/.test(chars[s - 1])) s--;
    if (e - s < 3 || (s >= 2 && /[.,]/.test(chars[s - 1]) && /\d/.test(chars[s - 2]))) { e = s; continue; }
    mask = mask || inkMask(img);
    /* each digit spans halfway to its neighbours */
    const runs = [];
    for (let k = s; k < e; k++) {
      const c = centre(k);
      const left = k > s ? (c + centre(k - 1)) / 2 : c - (centre(k + 1) - c) / 2;
      const right = k < e - 1 ? (c + centre(k + 1)) / 2 : c + (c - centre(k - 1)) / 2;
      runs.push(inkRuns(mask, W, H, left, right));
    }
    if (runs.some((r) => !r.length)) { e = s; continue; }
    /* the big digits: the tallest run in each, and the part all of them cover */
    const tallest = runs.slice(0, -2).map((list) => list.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a)));
    const top = Math.max(...tallest.map((r) => r[0])), bottom = Math.min(...tallest.map((r) => r[1]));
    const h = bottom - top;
    /* the last two: the run that overlaps the big digits most, which must sit in their upper part */
    const overlap = (r) => Math.min(r[1], bottom) - Math.max(r[0], top);
    const small = runs.slice(-2).map((list) => list.reduce((a, b) => (overlap(b) > overlap(a) ? b : a)));
    const raised = h > 8 && small.every((r) => r[0] < top + 0.2 * h && r[1] < top + 0.75 * h);
    if (raised) { chars.splice(e - 2, 0, '.'); at.splice(e - 2, 0, at[e - 2]); }
    e = s;
  }
}

/* ---------- lines ---------- */

/* Adds box b to the end of line a. */
function merge(a, b, glue) {
  const n0 = a.text.length, n1 = b.text.length;
  a.confidence = (a.confidence * n0 + b.confidence * n1) / (n0 + n1);
  a.text += glue + b.text;
  a.height = Math.max(a.height, b.height);
  a.bbox = {
    x0: Math.min(a.bbox.x0, b.bbox.x0), y0: Math.min(a.bbox.y0, b.bbox.y0),
    x1: Math.max(a.bbox.x1, b.bbox.x1), y1: Math.max(a.bbox.y1, b.bbox.y1),
  };
}

/* Cents in a box of their own: two digits (maybe with the mark, "99 Kč"), smaller than the number
 * and level with its top, right after it. They join the number with a point: "541" + "99" is 541.99. */
function joinCents(items) {
  const gone = new Set();
  for (const a of items) {
    if (gone.has(a) || !/\d$/.test(a.text)) continue;
    const h = a.bbox.y1 - a.bbox.y0;
    const b = items.find((b) => b !== a && !gone.has(b) && /^\d\d(?!\d)/.test(b.text) &&
      b.height < 0.8 * a.height && Math.abs(b.bbox.y0 - a.bbox.y0) < 0.25 * h &&
      b.bbox.x0 > a.bbox.x1 - 0.5 * h && b.bbox.x0 < a.bbox.x1 + 0.5 * h && b.bbox.x1 > a.bbox.x1);
    if (!b) continue;
    merge(a, b, '.');
    gone.add(b);
  }
  return items.filter((it) => !gone.has(it));
}

/* Puts boxes in reading order and, when asked, joins boxes on the same line: the detector splits
 * a line where the gap is wide ("4,99   €"), and the price finder needs the mark next to the number. */
function assemble(items) {
  if (settings.raisedCents) items = joinCents(items);
  items.sort((a, b) => a.bbox.y0 + a.bbox.y1 - b.bbox.y0 - b.bbox.y1);
  /* rows: boxes whose middles are within half a height of each other */
  const rows = [];
  for (const it of items) {
    const cy = (it.bbox.y0 + it.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, it.height) / 2);
    if (row) row.items.push(it);
    else rows.push({ cy, h: it.height, items: [it] });
  }
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let cur = null;
    for (const it of row.items) {
      const similar = cur && Math.max(cur.height, it.height) < 2 * Math.min(cur.height, it.height);
      const close = cur && it.bbox.x0 - cur.bbox.x1 < 1.5 * Math.max(cur.height, it.height);
      if (settings.joinLines && similar && close) {
        merge(cur, it, ' ');
      } else {
        cur = { ...it };
        lines.push(cur);
      }
    }
  }
  return lines;
}

/* Reads the region and returns its lines: { text, height, confidence, bbox } with bbox in source pixels. */
export async function readLines(source, region) {
  const reader = await getReader();
  const boxes = await detect(reader, source, region);
  if (!boxes.length) return [];
  let crops = boxes.map((r) => crop(source, r));
  if (settings.angle && reader.cls) {
    const flip = await upsideDown(reader, crops);
    crops = crops.map((c, i) => (flip[i] ? crop(source, boxes[i], true) : c));
  }
  const read = settings.recognizer ? await settings.recognizer(crops) : await recognize(reader, crops);
  const items = [];
  boxes.forEach((r, i) => {
    if (settings.raisedCents && read[i].at) markRaisedCents(read[i], crops[i]);
    const text = read[i].chars.join(''), confidence = read[i].confidence;
    if (!text.trim()) return;
    items.push({ text: text.trim(), height: 2 * r.hh, confidence, bbox: extent(r) });
  });
  return assemble(items);
}
