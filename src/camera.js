/* Price Lens: getting sharp pictures of small print out of a phone camera.
 *
 * What helps most (see the README for sources):
 *  - Zoom about 2×. The phone is then held about 25–40 cm away, beyond the distance where the main
 *    lens of recent iPhones stops focusing (15–20 cm), so it no longer blurs or jumps to the
 *    ultra-wide lens. The camera crops its sensor to zoom, so the zoom adds real detail.
 *  - Never read the frame taken at the instant of the tap: the tap itself shakes the phone. Wait a
 *    moment, then keep the sharpest of a short burst of frames.
 *  - Use focus controls where the browser has them (Chrome on Android: continuous focus, tap to
 *    focus). Safari has none; it focuses by itself.
 * Every constraint is applied on its own, so one the camera refuses cannot cancel the others. */

/* Opens the back camera. On Android, a phone sometimes hands over a fixed-focus auxiliary camera
   first; when the camera it opened cannot focus, the other back cameras are tried in turn. */
export async function openBackCamera() {
  const base = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
  const canFocus = (s) => (s.getVideoTracks()[0].getCapabilities?.().focusMode || []).includes('continuous');
  if (/Android/i.test(navigator.userAgent) && !canFocus(stream)) {
    const opened = stream.getVideoTracks()[0].getSettings().deviceId;
    const backs = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'videoinput' && /back/i.test(d.label) && d.deviceId !== opened);
    for (const d of backs) {
      try {
        const other = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, facingMode: undefined, deviceId: { exact: d.deviceId } } });
        if (canFocus(other)) { stream.getTracks().forEach((t) => t.stop()); stream = other; break; }
        other.getTracks().forEach((t) => t.stop());
      } catch {}
    }
  }
  return stream;
}

const capsOf = (track) => (track && track.getCapabilities ? track.getCapabilities() : {});

async function apply(track, constraint) {
  try { await track.applyConstraints({ advanced: [constraint] }); return true; } catch { return false; }
}

/* The zoom range this camera offers, or null. On iPhones with several lenses, 1 is the main lens
   and 0.5 the ultra-wide; on Android, 1 is the whole picture. */
export function zoomRange(track) {
  const z = capsOf(track).zoom;
  return z && z.max > z.min ? { min: z.min, max: z.max, step: z.step || 0.1 } : null;
}

export function currentZoom(track) {
  try { return track.getSettings().zoom ?? null; } catch { return null; }
}

export async function setZoom(track, zoom) {
  const range = zoomRange(track);
  if (!range) return null;
  const z = Math.min(range.max, Math.max(Math.max(1, range.min), Math.round(zoom / range.step) * range.step));
  return (await apply(track, { zoom: z })) ? z : null;
}

/* Focus, white balance and exposure on automatic where the camera lets the page choose, then the
   zoom. Applied one at a time and in turn: overlapping calls race on both browsers. */
export async function tuneTrack(track, { zoom = 2 } = {}) {
  const caps = capsOf(track);
  if (caps.focusMode?.includes('continuous')) await apply(track, { focusMode: 'continuous' });
  if (caps.whiteBalanceMode?.includes('continuous')) await apply(track, { whiteBalanceMode: 'continuous' });
  if (caps.exposureMode?.includes('continuous')) await apply(track, { exposureMode: 'continuous' });
  return setZoom(track, zoom);
}

export const hasTorch = (track) => !!capsOf(track).torch;
export async function setTorch(track, on) {
  return hasTorch(track) && apply(track, { torch: on });
}

/* Tap to focus, where the browser supports it (Chrome on Android). x and y are 0..1 across the
   video frame, not the screen. Returns false where it does nothing. */
export async function focusAt(track, x, y) {
  if (!('pointsOfInterest' in (navigator.mediaDevices.getSupportedConstraints?.() || {}))) return false;
  if (!(await apply(track, { pointsOfInterest: [{ x, y }] }))) return false;
  if (capsOf(track).focusMode?.includes('continuous')) await apply(track, { focusMode: 'continuous' });
  return true;
}

/* ---------- how sharp is a frame? ---------- */

/* Sharpness is the variance of the Laplacian (a standard focus measure) of the aiming box, made
   grey and scaled to a fixed width so frames can be compared with each other. Motion is the mean
   difference from the previous frame: low means the phone is being held still. Both are only
   meaningful relative to other frames of the same scene, never as absolute thresholds. */
const SCORE_W = 360;
const scoreCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
const sctx = scoreCanvas && scoreCanvas.getContext('2d', { willReadFrequently: true });

export function frameScore(source, roi, previous = null) {
  const h = Math.max(8, Math.round((roi.h * SCORE_W) / roi.w));
  if (scoreCanvas.width !== SCORE_W || scoreCanvas.height !== h) { scoreCanvas.width = SCORE_W; scoreCanvas.height = h; }
  sctx.drawImage(source, roi.x, roi.y, roi.w, roi.h, 0, 0, SCORE_W, h);
  const { data } = sctx.getImageData(0, 0, SCORE_W, h);
  const grey = new Float32Array(SCORE_W * h);
  for (let i = 0, j = 0; j < grey.length; i += 4, j++) grey[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1, k = y * SCORE_W + 1; x < SCORE_W - 1; x++, k++) {
      const v = grey[k - SCORE_W] + grey[k + SCORE_W] + grey[k - 1] + grey[k + 1] - 4 * grey[k];
      s += v; s2 += v * v; n++;
    }
  }
  const mean = s / n;
  let motion = null;
  if (previous && previous.length === grey.length) {
    let d = 0;
    for (let k = 0; k < grey.length; k++) d += Math.abs(grey[k] - previous[k]);
    motion = d / grey.length;
  }
  return { sharpness: s2 / n - mean * mean, motion, grey };
}

/* calls back once per new camera frame (or per screen refresh where the browser cannot tell) */
export function onNextFrame(video, callback) {
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(callback);
  else requestAnimationFrame(callback);
}

function copyFrame(video, canvas) {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  canvas.getContext('2d').drawImage(video, 0, 0);
}

/* After the Scan tap: let the shake of the tap settle, then watch a short burst of frames and keep
   the sharpest whole frame. roi() gives the aiming box in video pixels. Resolves with
   { canvas, sharpness, frames } — the canvas holds the chosen frame at full size. */
export function captureSharpest(video, roi, { settleMs = 160, frames = 8, maxMs = 950 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let best = null, spare = document.createElement('canvas'), bestCanvas = document.createElement('canvas');
    let previous = null, seen = 0;
    const step = () => {
      const t = performance.now() - t0;
      if (t >= settleMs && video.videoWidth) {
        const box = roi();
        const r = frameScore(video, box, previous);
        previous = r.grey;
        seen++;
        if (!best || r.sharpness > best.sharpness) {
          copyFrame(video, spare);
          [spare, bestCanvas] = [bestCanvas, spare];
          best = { sharpness: r.sharpness };
        }
      }
      if ((seen >= frames || t >= maxMs) && best) return resolve({ canvas: bestCanvas, sharpness: best.sharpness, frames: seen });
      if (t >= maxMs * 2) {
        /* no frames arrived (a stalled camera): take whatever the video shows */
        copyFrame(video, bestCanvas);
        return resolve({ canvas: bestCanvas, sharpness: 0, frames: seen });
      }
      onNextFrame(video, step);
    };
    onNextFrame(video, step);
  });
}

/* ---------- live mode: only read frames worth reading ---------- */

/* Watches every frame while live mode is on and keeps the sharpest steady one since the last read.
   take() hands it over (or null when nothing good enough has come in yet). A frame is good enough
   when it is at least 60% as sharp as the sharpest of the last two seconds and the phone was not
   moving much; the bar is relative, so it adapts to the tag, the light and the phone. */
export function frameGate(video, roi, onSteady = () => {}) {
  let running = true, previous = null;
  let candidate = null, spare = document.createElement('canvas'), held = document.createElement('canvas');
  let fallback = null, fallbackCanvas = document.createElement('canvas');
  const recent = [];      // [time, sharpness] of the last 2 s
  let lastScore = 0, lastTaken = performance.now();
  const step = (now) => {
    if (!running) return;
    const t = performance.now();
    /* about 12 scores a second is plenty and leaves the processor to the reader */
    if (video.videoWidth && t - lastScore > 80) {
      lastScore = t;
      const box = roi();
      const r = frameScore(video, box, previous);
      previous = r.grey;
      recent.push([t, r.sharpness]);
      while (recent.length && t - recent[0][0] > 2000) recent.shift();
      const top = Math.max(...recent.map((x) => x[1]));
      const steady = r.motion != null && r.motion < 6 && r.sharpness >= 0.6 * top;
      onSteady(steady);
      if (steady && (!candidate || r.sharpness > candidate.sharpness)) {
        copyFrame(video, spare);
        [spare, held] = [held, spare];
        candidate = { canvas: held, sharpness: r.sharpness };
      } else if (!candidate && (!fallback || r.sharpness > fallback.sharpness)) {
        /* the sharpest frame so far even if the phone moved, for hands that are never quite still */
        copyFrame(video, fallbackCanvas);
        fallback = { canvas: fallbackCanvas, sharpness: r.sharpness };
      }
    }
    onNextFrame(video, step);
  };
  onNextFrame(video, step);
  return {
    take() {
      let c = candidate;
      if (c) {
        /* hand over this canvas and draw the next candidate into a fresh one */
        held = document.createElement('canvas');
      } else if (fallback && performance.now() - lastTaken > 1200) {
        c = fallback;
        fallbackCanvas = document.createElement('canvas');
      } else {
        return null;
      }
      candidate = null;
      fallback = null;
      lastTaken = performance.now();
      return c;
    },
    stop() { running = false; },
  };
}

/* ---------- pinch to zoom ---------- */

/* Two fingers on the picture change the camera's zoom (at most one change per screen refresh).
   getTrack() returns the current camera track; onZoom(z) reports the new zoom. */
export function attachPinch(stage, getTrack, onZoom) {
  const points = new Map();
  let d0 = 0, z0 = 1, want = null, frame = 0;
  const dist = () => { const [a, b] = [...points.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const flush = async () => {
    frame = 0;
    const z = want;
    want = null;
    const track = getTrack();
    if (track && z != null) {
      const done = await setZoom(track, z);
      if (done != null) onZoom(done);
    }
  };
  stage.addEventListener('pointerdown', (e) => {
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2) { d0 = dist(); z0 = currentZoom(getTrack()) || 1; }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!points.has(e.pointerId)) return;
    points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.size === 2 && d0 && zoomRange(getTrack())) {
      want = (z0 * dist()) / d0;
      if (!frame) frame = requestAnimationFrame(flush);
    }
  });
  const up = (e) => { points.delete(e.pointerId); if (points.size < 2) d0 = 0; };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  /* iOS zooms the page itself on a pinch unless told not to */
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  return () => points.size >= 2;
}
