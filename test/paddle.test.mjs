/* Tests for the plain-JavaScript steps of the PaddleOCR reader (src/paddle-boxes.js): boxes from
 * the detector's map, cutting them out level, letter height, and joining boxes into lines.
 * Run with: npm test */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findBoxes, toSource, boxHeight, boxLength, turned, cropWidth, cropTransform, extent,
  letterHeight, assemble, decode,
} from '../src/paddle-boxes.js';

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const apply = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

/* a probability map with one filled rectangle, centre (cx, cy), long side len, short side thick, turned by deg */
function mapWithBar(W, H, { cx, cy, len, thick, deg }) {
  const prob = new Float32Array(W * H);
  const t = (deg * Math.PI) / 180, ux = Math.cos(t), uy = Math.sin(t);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (Math.abs(dx * ux + dy * uy) <= len / 2 && Math.abs(-dx * uy + dy * ux) <= thick / 2) prob[y * W + x] = 0.9;
    }
  }
  return prob;
}
const SETTINGS = { thresh: 0.2, boxThresh: 0.45, unclip: 1.4 };

test('a level line of text becomes a box along it, grown past its core', () => {
  const [r] = findBoxes(mapWithBar(200, 100, { cx: 100, cy: 50, len: 120, thick: 10, deg: 0 }), 200, 100, SETTINGS);
  near(r.cx, 100, 1, 'centre x');
  near(r.cy, 50, 1, 'centre y');
  near(r.ux, 1, 0.01, 'direction');
  assert.ok(r.hh * 2 > 10 && r.hh * 2 < 30, `grown height ${r.hh * 2}`);
});

test('the box corners land in the right place when the map is squeezed more one way than the other', () => {
  const [r] = findBoxes(mapWithBar(200, 120, { cx: 100, cy: 60, len: 100, thick: 16, deg: 25 }), 200, 120, SETTINGS);
  const fx = 2.1, fy = 3.4;
  const b = toSource(r, fx, fy);
  /* the map rectangle's corners, scaled, must be the box's corners */
  const vx = -r.uy, vy = r.ux;
  for (const [s, t] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const mx = r.cx + s * r.ux * r.hw + t * vx * r.hh, my = r.cy + s * r.uy * r.hw + t * vy * r.hh;
    const px = b.cx + s * b.ax + t * b.bx, py = b.cy + s * b.ay + t * b.by;
    near(px, mx * fx, 1e-6, 'corner x');
    near(py, my * fy, 1e-6, 'corner y');
  }
});

test('cutting a box out maps its corners onto the corners of the crop', () => {
  const b = { cx: 300, cy: 200, ax: 120, ay: 40, bx: -9, by: 33 }; // a slanted box (not a rectangle)
  const W = cropWidth(b), H = 48;
  const m = cropTransform(b, W, H);
  const corner = (s, t) => apply(m, b.cx + s * b.ax + t * b.bx, b.cy + s * b.ay + t * b.by);
  const want = { '-1,-1': [0, 0], '1,-1': [W, 0], '-1,1': [0, H], '1,1': [W, H] };
  for (const [k, [x, y]] of Object.entries(want)) {
    const [s, t] = k.split(',').map(Number);
    const [cx, cy] = corner(s, t);
    near(cx, x, 1e-6, `crop x of corner ${k}`);
    near(cy, y, 1e-6, `crop y of corner ${k}`);
  }
  near(W, Math.round((48 * boxLength(b)) / boxHeight(b)), 0, 'crop width keeps the proportions');
});

test('text turned more than 45° gives a tall box, which turned() reads along its length, downwards', () => {
  const [r] = findBoxes(mapWithBar(200, 200, { cx: 100, cy: 100, len: 120, thick: 12, deg: 70 }), 200, 200, SETTINGS);
  const b = toSource(r, 1, 1);
  assert.ok(boxHeight(b) >= 1.5 * boxLength(b), `tall: height ${boxHeight(b)}, length ${boxLength(b)}`);
  const t = turned(b);
  const ang = (Math.atan2(t.ay, t.ax) * 180) / Math.PI;
  near(ang, 70, 2, 'reading direction');
  near(boxLength(t), boxHeight(b), 1e-6, 'the long side is now the length');
  /* still a box with the letters' tops on the left of the reading direction */
  assert.ok(t.ax * t.by - t.ay * t.bx > 0);
});

/* a crop W x 48 with ink (black) on white in the given rows, between columns x0 and x1 */
function crop(W, rows, x0 = 4, x1 = W - 4) {
  const data = new Uint8ClampedArray(W * 48 * 4).fill(255);
  for (const [top, bottom, a = x0, b = x1] of rows) {
    for (let y = top; y <= bottom; y++) {
      for (let x = a; x < b; x++) if ((x >> 2) % 2 === 0) data.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
    }
  }
  return { width: W, height: 48, data };
}
const readAcross = (W) => ({ at: [[0, 0], [Math.floor(W / 8) - 1, Math.floor(W / 8) - 1]], stride: 8 });

test('letter height is the ink across the middle, not the box, and not the lines above and below', () => {
  const short = crop(80, [[14, 33]]);
  const long = crop(600, [[14, 33], [0, 3], [45, 47]]); // bits of the neighbouring lines at the edges
  assert.equal(letterHeight(readAcross(80), short), 20);
  assert.equal(letterHeight(readAcross(600), long), 20);
});

test('raised cents in a box of their own join the price only when their letters are smaller', () => {
  const item = (text, x0, y0, x1, y1, height) => ({ text, height, size: y1 - y0, confidence: 90, bbox: { x0, y0, x1, y1 } });
  const joined = assemble([item('541', 0, 0, 150, 80, 60), item('99', 152, 4, 200, 44, 28)]);
  assert.deepEqual(joined.map((l) => l.text), ['541.99']);
  const apart = assemble([item('541', 0, 0, 150, 80, 60), item('99', 152, 4, 200, 44, 55)]);
  assert.ok(!apart.some((l) => l.text.includes('541.99')));
  assert.ok(joined.every((l) => !('size' in l)), 'lines carry only what the price finder reads');
});

test('CTC decoding merges repeats and drops blanks', () => {
  const dict = ['', '1', '2', '.'];
  const steps = [1, 1, 0, 1, 3, 0, 2, 2];
  const probs = new Float32Array(steps.length * 4);
  steps.forEach((c, t) => { probs[t * 4 + c] = 0.9; });
  const r = decode(probs, steps.length, 4, 0, dict);
  assert.equal(r.chars.join(''), '11.2');
  near(r.confidence, 90, 1e-3, 'confidence');
});

test('the upright box around a slanted box covers all its corners', () => {
  const b = { cx: 10, cy: 20, ax: 6, ay: 2, bx: -1, by: 3 };
  const e = extent(b);
  for (const [s, t] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const x = b.cx + s * b.ax + t * b.bx, y = b.cy + s * b.ay + t * b.by;
    assert.ok(x >= e.x0 - 1e-9 && x <= e.x1 + 1e-9 && y >= e.y0 - 1e-9 && y <= e.y1 + 1e-9);
  }
});
