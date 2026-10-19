/* Price Lens: the plain-JavaScript steps of the PaddleOCR reader, around its two neural networks.
 *
 * The detector hands over a map of how likely each pixel is to be text; findBoxes turns it into
 * boxes. The recogniser hands over, for each step along a line, how likely each character is;
 * decode turns that into text. Then the boxes are put back together into lines. None of this
 * needs a page or a canvas, so the reader's worker (src/paddle-worker.js) uses it and the tests
 * check it on its own.
 *
 * Two kinds of box:
 *  - a rectangle in the detector's map: { cx, cy, ux, uy, hw, hh }, a centre, a unit direction
 *    along it and half its length and height;
 *  - a box in picture pixels: { cx, cy, ax, ay, bx, by }, a centre and two half sides. A runs
 *    along the text, in the direction it is read; B runs across it, from the top of the letters
 *    to their foot. The map is a little more squeezed one way than the other (its sides are
 *    rounded to multiples of 32), so a turned rectangle in the map is not quite a rectangle in the
 *    picture; keeping both sides as vectors keeps it exact. */

/* Convex hull of points [x, y, x, y, ...] (Andrew's monotone chain), as a list of [x, y]. */
export function hull(flat) {
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
 * lies on a side of the hull). Returned with u the side nearer horizontal, pointing right: text on
 * a tag is usually upright. Text turned further than 45° is handled when it is read (see
 * turned()), since the box alone cannot tell a tall word from a column of letters. */
export function minAreaRect(h) {
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

/* Turns the probability map (W x H) into rectangles in map pixels: threshold it, take each
 * connected blob, fit the smallest rectangle around it, and grow that by the "unclip" distance.
 * The detector is trained to mark only the core of each line of text, so that lines close
 * together stay apart; growing the box gives back the whole line. */
export function findBoxes(prob, W, H, { thresh, boxThresh, unclip }) {
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

/* A rectangle in map pixels as a box in picture pixels, when one map pixel is fx by fy picture
 * pixels. Each corner lands where it should even when fx and fy differ. */
export function toSource(r, fx, fy) {
  return {
    cx: r.cx * fx, cy: r.cy * fy,
    ax: r.ux * r.hw * fx, ay: r.uy * r.hw * fy,     // half the side along the text
    bx: -r.uy * r.hh * fx, by: r.ux * r.hh * fy,    // half the side across it, pointing down
    score: r.score,
  };
}

const cross = (b) => Math.abs(b.ax * b.by - b.ay * b.bx);
/* the box's area, its length along the text and its height across it, in picture pixels */
export const boxArea = (b) => 4 * cross(b);
export const boxLength = (b) => 2 * Math.hypot(b.ax, b.ay);
export const boxHeight = (b) => (2 * cross(b)) / (Math.hypot(b.ax, b.ay) || 1);

/* The same box read the other way: turned a quarter, for text that runs down (as on a sign
 * turned on its side); or half, for text upside down. */
export const turned = (b) => ({ ...b, ax: b.bx, ay: b.by, bx: -b.ax, by: -b.ay });
export const flipped = (b) => ({ ...b, ax: -b.ax, ay: -b.ay, bx: -b.bx, by: -b.by });

/* The upright box around a box, and how much of a's lies inside b's. */
export function extent(b) {
  const ex = Math.abs(b.ax) + Math.abs(b.bx), ey = Math.abs(b.ay) + Math.abs(b.by);
  return { x0: b.cx - ex, y0: b.cy - ey, x1: b.cx + ex, y1: b.cy + ey };
}
export function inside(a, b) {
  const A = extent(a), B = extent(b);
  const w = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0), h = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
  return w > 0 && h > 0 ? (w * h) / ((A.x1 - A.x0) * (A.y1 - A.y0)) : 0;
}

/* The recogniser reads lines 48 pixels high; the crop keeps the box's proportions. */
export const CROP_H = 48;
export function cropWidth(b) {
  return Math.max(8, Math.min(CROP_H * 40, Math.round((CROP_H * boxLength(b)) / (boxHeight(b) || 1))));
}

/* The canvas transform [a, b, c, d, e, f] that draws the picture so the box fills a W x H crop,
 * level: A along the crop, left to right, and B down it. The picture point under crop pixel
 * (X, Y) is centre - A - B + 2A * X / W + 2B * Y / H; this is its inverse. */
export function cropTransform(b, W, H) {
  const k = b.ax * b.by - b.ay * b.bx;
  const a = (W * b.by) / (2 * k), c = (-W * b.bx) / (2 * k);
  const bb = (-H * b.ay) / (2 * k), d = (H * b.ax) / (2 * k);
  const px = b.cx - b.ax - b.bx, py = b.cy - b.ay - b.by;
  return [a, bb, c, d, -(a * px + c * py), -(bb * px + d * py)];
}

/* ---------- reading the recogniser's output ---------- */

/* The recogniser's alphabet: index 0 of its output is CTC's "blank", then one entry per character.
 * Some dictionaries leave out the space at the end, which the model still has. */
export function alphabet(raw, json, classes) {
  let chars = json ? JSON.parse(raw).characters : raw.split('\n').map((c) => c.replace(/\r$/, ''));
  if (chars.length > classes - 1 && chars[chars.length - 1] === '') chars = chars.slice(0, -1);
  if (chars.length === classes - 2) chars.push(' ');
  if (chars.length !== classes - 1) throw new Error(`dictionary has ${chars.length} characters, model reads ${classes - 1}`);
  return ['', ...chars];
}

/* CTC greedy decoding: the likeliest class at each step, repeats merged, blanks dropped.
 * Confidence is the mean probability of the characters kept. Each character also keeps the steps
 * it was read at, which says where in the crop it is. */
export function decode(probs, steps, classes, offset, dict) {
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

/* ---------- the ink in a crop: letter height, and cents printed small and raised ---------- */

/* Which pixels of a crop ({ width, height, data } as RGBA) are ink: Otsu's threshold on
 * brightness, and ink is whichever side the crop's border is not (dark on light or light on dark).
 * Transparent pixels are where the box reached past the picture; they are neither, and count for
 * nothing (read as black, they would pass for ink on a light tag and stretch the letters). */
export function inkMask(img) {
  const { width: W, height: H, data } = img;
  const g = new Uint8Array(W * H), seen = new Uint8Array(W * H), hist = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < W * H; i++) {
    if (!data[i * 4 + 3]) continue;
    g[i] = (data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000;
    seen[i] = 1; hist[g[i]]++; count++;
  }
  let total = 0, best = 0, cut = 128, w0 = 0, s0 = 0;
  for (let v = 0; v < 256; v++) total += v * hist[v];
  for (let v = 0; v < 256; v++) {
    w0 += hist[v]; s0 += v * hist[v];
    const w1 = count - w0;
    if (!w0 || !w1) continue;
    const between = w0 * w1 * (s0 / w0 - (total - s0) / w1) ** 2;
    if (between > best) { best = between; cut = v; }
  }
  let dark = 0, n = 0;
  for (let x = 0; x < W; x++) {
    for (const i of [x, (H - 1) * W + x]) if (seen[i]) { dark += g[i] <= cut; n++; }
  }
  const inkIsDark = dark < n / 2;
  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = seen[i] && (g[i] <= cut) === inkIsDark;
  return mask;
}

/* The runs of ink rows between two columns of the crop, top to bottom, as [top, bottom]. A row
 * is ink when at least `share` of its pixels there are. Gaps of a row or two do not split a run;
 * a wider gap does (the "€" or "лв" printed under small cents is a run of its own). */
export function inkRuns(mask, W, H, x0, x1, share = 0.15) {
  x0 = Math.max(0, Math.round(x0)); x1 = Math.min(W, Math.round(x1));
  const need = Math.max(1, (x1 - x0) * share);
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

/* How tall the letters in a crop are, in crop pixels, or null when no ink is found: the run of
 * ink rows under the characters read that crosses the middle of the crop (the detector centres
 * its box on the line; bits of the lines above and below, at the edges, are runs of their own).
 * Like Tesseract's word height, this depends neither on how far the box was grown nor on how long
 * the line is, so a big price and a long line of small print compare fairly. */
export function letterHeight(read, img, mask = inkMask(img)) {
  const { at, stride } = read;
  if (!at || !at.length) return null;
  const x0 = at[0][0] * stride, x1 = (at[at.length - 1][1] + 1) * stride;
  const runs = inkRuns(mask, img.width, img.height, x0 - stride, x1 + stride, 0.03);
  if (!runs.length) return null;
  const mid = img.height / 2;
  const dist = (r) => (r[0] <= mid && r[1] >= mid ? 0 : Math.min(Math.abs(r[0] - mid), Math.abs(r[1] - mid)));
  const run = runs.reduce((a, b) => (dist(b) < dist(a) || (dist(b) === dist(a) && b[1] - b[0] > a[1] - a[0]) ? b : a));
  return run[1] - run[0] + 1;
}

/* The recogniser reads characters, not their size, so "4⁹⁹" (cents small and raised, as on most
 * shelf labels) comes out as "499". The crop still shows the size: where a run of three or more
 * digits ends in two that are much shorter than the rest and level with their tops, those two
 * are cents, and a point goes before them. */
export function markRaisedCents(read, img, mask = null) {
  const { chars, at, stride } = read;
  const W = img.width, H = img.height;
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

/* Each item is { text, height, size, confidence, bbox }: height is the letters' height, size the
 * box's height across the text (the box is grown past the letters, so it is the right measure for
 * spacing between boxes, not for comparing letter sizes). */

/* Adds box b to the end of line a. */
function merge(a, b, glue) {
  const n0 = a.text.length, n1 = b.text.length;
  a.confidence = (a.confidence * n0 + b.confidence * n1) / (n0 + n1);
  a.text += glue + b.text;
  a.height = Math.max(a.height, b.height);
  a.size = Math.max(a.size, b.size);
  a.bbox = {
    x0: Math.min(a.bbox.x0, b.bbox.x0), y0: Math.min(a.bbox.y0, b.bbox.y0),
    x1: Math.max(a.bbox.x1, b.bbox.x1), y1: Math.max(a.bbox.y1, b.bbox.y1),
  };
}

/* Cents in a box of their own: two digits (maybe with the mark, "99 Kč"), in smaller letters than
 * the number and level with its top, right after it. They join the number with a point:
 * "541" + "99" is 541.99. */
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
 * a line where the gap is wide ("4,99   €"), and the price finder needs the mark next to the number.
 * Returns lines of { text, height, confidence, bbox }. */
export function assemble(items, { joinLines = true, raisedCents = true } = {}) {
  if (raisedCents) items = joinCents(items);
  items.sort((a, b) => a.bbox.y0 + a.bbox.y1 - b.bbox.y0 - b.bbox.y1);
  /* rows: boxes whose middles are within half a box of each other */
  const rows = [];
  for (const it of items) {
    const cy = (it.bbox.y0 + it.bbox.y1) / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, it.size) / 2);
    if (row) row.items.push(it);
    else rows.push({ cy, h: it.size, items: [it] });
  }
  const lines = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    let cur = null;
    for (const it of row.items) {
      const similar = cur && Math.max(cur.size, it.size) < 2 * Math.min(cur.size, it.size);
      const close = cur && it.bbox.x0 - cur.bbox.x1 < 1.5 * Math.max(cur.size, it.size);
      if (joinLines && similar && close) {
        merge(cur, it, ' ');
      } else {
        cur = { ...it };
        lines.push(cur);
      }
    }
  }
  return lines.map(({ size, ...line }) => line);
}
