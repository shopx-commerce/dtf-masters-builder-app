/**
 * Pure AM-halftone computation. Runs on any Uint8ClampedArray of RGBA pixels
 * (procW × procH × 4). Mutates the input array in place and returns it.
 *
 * Split out of `useImageEditorModelHalftone` so both the halftone Web Worker
 * (`halftone-worker.ts`) and the main-thread fallback in the React hook can
 * share the exact same pixel math — a divergence between the two paths would
 * produce visible drift the moment the worker fails to spawn.
 *
 * The output is *not* yet 1-bit-clean at the browser canvas level; the caller
 * must still `putImageData` and re-read to eliminate ±1 premultiplied-alpha
 * drift on edge pixels. Everything up to that verify pass lives here.
 */

export type HalftoneStrength = "light" | "balanced" | "strong";

const SRGB_LINEAR_LUT = /* @__PURE__ */ (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = SRGB_LINEAR_LUT[r], lg = SRGB_LINEAR_LUT[g], lb = SRGB_LINEAR_LUT[b];
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const lc = Math.cbrt(l), mc = Math.cbrt(m), sc = Math.cbrt(s);
  return [
    0.2104542553 * lc + 0.7936177850 * mc - 0.0040720468 * sc,
    1.9779984951 * lc - 2.4285922050 * mc + 0.4505937099 * sc,
    0.0259040371 * lc + 0.7827717662 * mc - 0.8086757660 * sc,
  ];
}

export interface HalftoneInput {
  data: Uint8ClampedArray;
  procW: number;
  procH: number;
  /** Final printed width in inches, before or after scaling. Used to size the
   *  screen so the dot pitch is 35 LPI at the actual output size. */
  printWidthInches: number;
  tr: number;
  tg: number;
  tb: number;
  strength: HalftoneStrength;
}

/** Apply AM halftone in place. Returns the same array for convenience. */
export function applyHalftoneScreen(input: HalftoneInput): Uint8ClampedArray {
  const { data, procW, procH, printWidthInches, tr, tg, tb, strength } = input;
  const N = procW * procH;

  // ── Strength presets (mirrors INTENSITIES.negra in reference app) ─────────
  const isBlack = tr < 5 && tg < 5 && tb < 5;
  let blackCut: number, whiteCut: number, tolUI: number, featherUI: number;
  if (strength === "light") { blackCut = 0; whiteCut = 80; tolUI = 25; featherUI = 22; }
  else if (strength === "strong") { blackCut = 54; whiteCut = 174; tolUI = 55; featherUI = 38; }
  else { blackCut = 27; whiteCut = 132; tolUI = 40; featherUI = 30; }
  const denom = Math.max(1, whiteCut - blackCut);
  const TOL = tolUI / 200;          // OKLab units (UI_TO_OK = 1/200)
  const FEATHER = featherUI / 200;
  const UPPER = TOL + FEATHER;

  const LPI = 35;
  const ANGLE = 22.5 * Math.PI / 180;
  const effectiveDpi = printWidthInches > 0 ? Math.min(procW / printWidthInches, 300) : 300;
  const MIN_DOT = (0.20 / 25.4) * effectiveDpi;      // 0.20 mm min printable dot
  const cell = Math.max(2, effectiveDpi / LPI);
  const maxR = cell * 0.72;
  const ca = Math.cos(ANGLE), sa = Math.sin(ANGLE);

  // ── 2. Save base alpha + compute tone ─────────────────────────────────────
  const baseAlpha = new Uint8ClampedArray(N);
  for (let i = 0; i < N; i++) baseAlpha[i] = data[i * 4 + 3];

  const tone = new Float32Array(N);
  if (isBlack) {
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
      let v = (lum - blackCut) / denom;
      if (v < 0) v = 0; else if (v > 1) v = 1;
      tone[i] = v;
    }
  } else {
    const gLab = srgbToOklab(tr, tg, tb);
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      const pLab = srgbToOklab(data[o], data[o + 1], data[o + 2]);
      const dL = pLab[0] - gLab[0], da = pLab[1] - gLab[1], db = pLab[2] - gLab[2];
      const dist = Math.sqrt(dL * dL + da * da + db * db);
      let v: number;
      if (dist <= TOL) v = 0;
      else if (dist >= UPPER) v = 1;
      else v = (dist - TOL) / FEATHER;
      tone[i] = v;
    }
  }

  // ── 3. Build AM halftone screen ────────────────────────────────────────────
  const cx = procW * 0.5, cy = procH * 0.5;

  let minRX = Infinity, maxRX = -Infinity, minRY = Infinity, maxRY = -Infinity;
  const corners: [number, number][] = [
    [-cx, -cy],
    [procW - cx, -cy],
    [-cx, procH - cy],
    [procW - cx, procH - cy],
  ];
  for (const [xc, yc] of corners) {
    const xr = xc * ca + yc * sa;
    const yr = -xc * sa + yc * ca;
    if (xr < minRX) minRX = xr; if (xr > maxRX) maxRX = xr;
    if (yr < minRY) minRY = yr; if (yr > maxRY) maxRY = yr;
  }
  const nx2 = Math.ceil(-minRX / cell - 0.5);
  const ny2 = Math.ceil(-minRY / cell - 0.5);
  const oX = (nx2 + 0.5) * cell;
  const oY = (ny2 + 0.5) * cell;
  const cellsX = Math.ceil((maxRX + oX) / cell) + 2;
  const cellsY = Math.ceil((maxRY + oY) / cell) + 2;
  const totalCells = cellsX * cellsY;

  const sums = new Float64Array(totalCells);
  const counts = new Uint32Array(totalCells);
  const hasTransparent = new Uint8Array(totalCells);

  for (let y = 0; y < procH; y++) {
    const yc = y - cy;
    for (let x = 0; x < procW; x++) {
      const xc = x - cx;
      const xr = xc * ca + yc * sa + oX;
      const yr = -xc * sa + yc * ca + oY;
      const ix = (xr / cell) | 0, iy = (yr / cell) | 0;
      if (ix < 0 || iy < 0 || ix >= cellsX || iy >= cellsY) continue;
      const idx = iy * cellsX + ix;
      const ba = baseAlpha[y * procW + x];
      if (ba < 1) { hasTransparent[idx] = 1; }
      else { sums[idx] += tone[y * procW + x]; counts[idx]++; }
    }
  }

  const radii = new Float32Array(totalCells);
  for (let i = 0; i < totalCells; i++) {
    if (!counts[i]) continue;
    if (hasTransparent[i]) { radii[i] = maxR; continue; }
    const avg = sums[i] / counts[i];
    let r = Math.sqrt(avg) * maxR;
    if (r < MIN_DOT) r = 0;
    radii[i] = r;
  }

  const screenAlpha = new Uint8ClampedArray(N);
  for (let y = 0; y < procH; y++) {
    const yc = y - cy;
    for (let x = 0; x < procW; x++) {
      const o = y * procW + x;
      const t = tone[o];
      if (t >= 0.999) { screenAlpha[o] = 255; continue; }
      if (t <= 0.001) { continue; }
      const xc = x - cx;
      const xr = xc * ca + yc * sa + oX;
      const yr = -xc * sa + yc * ca + oY;
      const ix = (xr / cell) | 0, iy = (yr / cell) | 0;
      if (ix < 0 || iy < 0 || ix >= cellsX || iy >= cellsY) continue;
      const r = radii[iy * cellsX + ix];
      if (r <= 0) continue;
      const xrc = (ix + 0.5) * cell, yrc = (iy + 0.5) * cell;
      const dx = xr - xrc, dy = yr - yrc;
      if (Math.sqrt(dx * dx + dy * dy) <= r) screenAlpha[o] = 255;
    }
  }

  // ── 4. Composite + 1-bit alpha threshold ──────────────────────────────────
  const T = 128;
  for (let i = 0; i < N; i++) {
    let a = baseAlpha[i];
    if (screenAlpha[i] < a) a = screenAlpha[i];
    data[i * 4 + 3] = a >= T ? 255 : 0;
  }

  return data;
}
