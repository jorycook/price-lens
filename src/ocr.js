/* Price Lens: reading text off a picture, on the phone itself.
 *
 * Uses Tesseract (compiled to WebAssembly). The reader and its English model (about 4 MB in all)
 * are fetched the first time and kept by the offline worker, so later scans need no connection.
 * This is the standard reader: src/reader.js uses it on phones that cannot run PaddleOCR. */

const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const PATHS = {
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
};

let workerPromise = null;

/* The files the reader fetches, to keep for offline use: Tesseract's worker loads the core built
   with SIMD where WebAssembly has it, and the plain one elsewhere. */
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
export function readerFiles() {
  let simd = false;
  try { simd = WebAssembly.validate(SIMD_TEST); } catch {}
  return [TESSERACT, PATHS.workerPath, `${PATHS.corePath}/tesseract-core-${simd ? 'simd-' : ''}lstm.wasm.js`, `${PATHS.langPath}/eng.traineddata.gz`];
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the text reader. Check the connection.'));
    document.head.appendChild(s);
  });
}

/* Starts the reader once; later calls get the same one. onProgress(0..1, words) reports loading. */
export function getReader(onProgress = () => {}) {
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript(TESSERACT);
      const worker = await window.Tesseract.createWorker('eng', 1, {
        ...PATHS,
        logger: (m) => {
          if (m.status && m.status.startsWith('loading')) onProgress(m.progress || 0, m.status);
        },
      });
      await worker.setParameters({
        tessedit_pageseg_mode: '11', // sparse text: price tags are scattered words, not paragraphs
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/* Cuts the region out of the source, enlarges small text, and evens out the contrast.
 * Light text on a dark tag (white on red, say) is turned dark-on-light, which the reader prefers.
 * Returns the canvas and the scale, to map what is found back onto the source. */
export function prepare(source, region) {
  const { x, y, w, h } = region;
  const scale = Math.min(2.5, Math.max(1, 1200 / w), 2400 / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, x, y, w, h, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
    d[i] = g;
    hist[g]++;
  }
  /* stretch between the 2nd and 98th percentile of brightness */
  const n = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > n * 0.02) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > n * 0.02) { hi = v; break; } }
  let mean = 0;
  for (let v = 0; v < 256; v++) mean += v * hist[v];
  mean /= n;
  const invert = mean < 110;
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = ((d[i] - lo) * 255) / span;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (invert) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, scale };
}

/* Reads the region and returns its lines: { text, height, bbox } with bbox in source pixels. */
export async function readLines(source, region) {
  const worker = await getReader();
  const { canvas, scale } = prepare(source, region);
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  let lines = data.lines;
  if (!lines && data.blocks) lines = data.blocks.flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
  return (lines || [])
    .filter((l) => l.text && l.text.trim() && l.confidence > 20)
    .map((l) => {
      /* the height of the line is the median height of its words: one tall smudge should not count */
      const heights = (l.words || []).map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
      const height = heights.length ? heights[heights.length >> 1] : l.bbox.y1 - l.bbox.y0;
      return {
        text: l.text.trim(),
        height: height / scale,
        confidence: l.confidence,
        bbox: {
          x0: region.x + l.bbox.x0 / scale,
          y0: region.y + l.bbox.y0 / scale,
          x1: region.x + l.bbox.x1 / scale,
          y1: region.y + l.bbox.y1 / scale,
        },
      };
    });
}
