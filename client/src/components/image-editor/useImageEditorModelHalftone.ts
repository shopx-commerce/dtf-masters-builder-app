import { useState, useCallback } from "react";
import type { ImageInfo } from "@/lib/types";
import type { ImageEditorBagAfterUploadCrop } from "./image-editor-hook-bag.types";

// ── OKLab colour conversion (matches reference app srgbToOklab) ──────────────
const SRGB_LINEAR_LUT = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function srgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = SRGB_LINEAR_LUT[r], lg = SRGB_LINEAR_LUT[g], lb = SRGB_LINEAR_LUT[b];
  const l = 0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb;
  const m = 0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb;
  const s = 0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb;
  const lc = Math.cbrt(l), mc = Math.cbrt(m), sc = Math.cbrt(s);
  return [
    0.2104542553*lc + 0.7936177850*mc - 0.0040720468*sc,
    1.9779984951*lc - 2.4285922050*mc + 0.4505937099*sc,
    0.0259040371*lc + 0.7827717662*mc - 0.8086757660*sc,
  ];
}

/** Apply 1-bit alpha threshold to an ImageInfo, returning a cleaned copy.
 *  Used by handleApplyHalftone to eliminate semi-transparent pixels that can
 *  be reintroduced by the canvas premultiplied-alpha round-trip. */
export function thresholdImageInfo(info: ImageInfo): Promise<ImageInfo | null> {
  return new Promise(resolve => {
    try {
      const src = info.image;
      const w = src.naturalWidth || src.width;
      const h = src.naturalHeight || src.height;
      if (!w || !h) { resolve(null); return; }
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.drawImage(src, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;
      for (let i = 3; i < data.length; i += 4) {
        data[i] = data[i] >= 128 ? 255 : 0;
      }
      ctx.putImageData(imgData, 0, 0);
      cvs.toBlob(blob => {
        if (!blob) { resolve(null); return; }
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve({ ...info, image: img }); };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
        img.src = url;
      }, 'image/png');
    } catch { resolve(null); }
  });
}

export type HalftoneStrength = 'light' | 'balanced' | 'strong';

export function useImageEditorModelHalftone(bag: ImageEditorBagAfterUploadCrop) {
  const {
    designs,
    selectedDesignId,
    selectedDesignIds,
    setDesigns,
    setImageInfo,
    saveSnapshot,
  } = bag;

  const [halftoneStrength, setHalftoneStrength] = useState<HalftoneStrength>('balanced');
  const [halftoneMenuOpen, setHalftoneMenuOpen] = useState(false);
  const [halftoneTopColors, setHalftoneTopColors] = useState<
    Array<{ r: number; g: number; b: number; hex: string; name?: string }>
  >([]);

  /**
   * Apply AM halftone screen to a design, matching the reference app at
   * https://buywitheze-droid.github.io/Halftone/
   *
   * Pipeline:
   *  1. Resize to 300 DPI (prevents main-thread freeze on high-res images)
   *  2. Compute tone[i] via luminance (black garment) or OKLab distance
   *  3. Build rotated AM dot grid (35 LPI, 22.5° angle)
   *  4. Composite: finalAlpha = min(baseAlpha, screenAlpha)
   *  5. 1-bit alpha threshold (T=128) → output is always 0 or 255
   *  6. Verify no semi-transparent pixels leaked through canvas premult round-trip
   */
  const handleApplyHalftone = useCallback((
    designId: string,
    tr: number, tg: number, tb: number,
    strength: HalftoneStrength = 'balanced',
  ) => {
    const design = designs.find(d => d.id === designId);
    if (!design) return;
    const src = design.imageInfo.image;
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return;

    // ── Screen params ──────────────────────────────────────────────────────────
    // Cap effective DPI at 300 (matches reference app which resizes to 300 DPI
    // first).  300 DPI → cell = 300/35 ≈ 8.57 px — correct physical 35 LPI pitch.
    const nativeDpi    = design.widthInches > 0 ? w / design.widthInches : 300;
    const effectiveDpi = Math.min(nativeDpi, 300);
    const LPI   = 35;
    const ANGLE = 22.5 * Math.PI / 180;
    const MIN_DOT = (0.20 / 25.4) * effectiveDpi; // 0.20 mm in pixels
    const cell  = Math.max(2, effectiveDpi / LPI);
    const maxR  = cell * 0.72;
    const ca = Math.cos(ANGLE), sa = Math.sin(ANGLE);

    // ── Strength presets (source: INTENSITIES.negra in reference app) ──────────
    //   light:    bc=0,  wc=80  | tol=25, feather=22
    //   balanced: bc=27, wc=132 | tol=40, feather=30
    //   strong:   bc=54, wc=174 | tol=55, feather=38
    const isBlack = tr < 5 && tg < 5 && tb < 5;
    let blackCut: number, whiteCut: number, tolUI: number, featherUI: number;
    if (strength === 'light')        { blackCut = 0;  whiteCut = 80;  tolUI = 25; featherUI = 22; }
    else if (strength === 'strong')  { blackCut = 54; whiteCut = 174; tolUI = 55; featherUI = 38; }
    else                             { blackCut = 27; whiteCut = 132; tolUI = 40; featherUI = 30; }
    const denom  = Math.max(1, whiteCut - blackCut);
    const TOL    = tolUI    / 200; // OKLab units (UI_TO_OK = 1/200)
    const FEATHER= featherUI / 200;
    const UPPER  = TOL + FEATHER;

    // ── 1. Resize to 300 DPI then read pixels ─────────────────────────────────
    // Without this a 1063 DPI image (3189 px @ 3") has 10 M+ pixels and the
    // five O(N) loops take 10–30 s, freezing the main thread.
    const TARGET_DPI = 300;
    let procW: number, procH: number;
    if (design.widthInches > 0) {
      procW = Math.min(w, Math.max(1, Math.round(design.widthInches * TARGET_DPI)));
      procH = Math.min(h, Math.max(1, Math.round(procW * h / w)));
    } else {
      const scale = Math.min(1, 2000 / Math.max(w, h));
      procW = Math.max(1, Math.round(w * scale));
      procH = Math.max(1, Math.round(h * scale));
    }

    const cvs = document.createElement('canvas');
    cvs.width = procW; cvs.height = procH;
    const ctx = cvs.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    // High-quality step-down resize (matches reference app's highQualityResize)
    if (procW < w || procH < h) {
      let cur: HTMLCanvasElement | HTMLImageElement = src;
      let cw = w, ch = h;
      while (cw / 2 >= procW && ch / 2 >= procH) {
        const half = document.createElement('canvas');
        half.width  = Math.max(procW, Math.floor(cw / 2));
        half.height = Math.max(procH, Math.floor(ch / 2));
        const hctx = half.getContext('2d')!;
        hctx.imageSmoothingEnabled = true;
        hctx.imageSmoothingQuality = 'high';
        hctx.drawImage(cur, 0, 0, half.width, half.height);
        cur = half; cw = half.width; ch = half.height;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(cur, 0, 0, procW, procH);
    } else {
      ctx.drawImage(src, 0, 0, procW, procH);
    }

    const imgData = ctx.getImageData(0, 0, procW, procH);
    const data = imgData.data;
    const N = procW * procH;

    // ── 2. Save base alpha + compute tone ─────────────────────────────────────
    const baseAlpha = new Uint8ClampedArray(N);
    for (let i = 0; i < N; i++) baseAlpha[i] = data[i * 4 + 3];

    const tone = new Float32Array(N);
    if (isBlack) {
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const lum = 0.2126 * data[o] + 0.7152 * data[o+1] + 0.0722 * data[o+2];
        let v = (lum - blackCut) / denom;
        if (v < 0) v = 0; else if (v > 1) v = 1;
        tone[i] = v;
      }
    } else {
      const gLab = srgbToOklab(tr, tg, tb);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        const pLab = srgbToOklab(data[o], data[o+1], data[o+2]);
        const dL = pLab[0]-gLab[0], da = pLab[1]-gLab[1], db = pLab[2]-gLab[2];
        const dist = Math.sqrt(dL*dL + da*da + db*db);
        let v: number;
        if (dist <= TOL) v = 0;
        else if (dist >= UPPER) v = 1;
        else v = (dist - TOL) / FEATHER;
        tone[i] = v;
      }
    }

    // ── 3. Build AM halftone screen ────────────────────────────────────────────
    // ALL 2-D loops use procW/procH — NOT the original w/h — because the arrays
    // are sized N = procW*procH.  Using original dimensions reads wrong indices.
    const cx = procW * 0.5, cy = procH * 0.5;

    let minRX = Infinity, maxRX = -Infinity, minRY = Infinity, maxRY = -Infinity;
    for (const [xc, yc] of [[-cx,-cy],[procW-cx,-cy],[-cx,procH-cy],[procW-cx,procH-cy]] as [number,number][]) {
      const xr =  xc*ca + yc*sa, yr = -xc*sa + yc*ca;
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

    const sums           = new Float64Array(totalCells);
    const counts         = new Uint32Array(totalCells);
    const hasTransparent = new Uint8Array(totalCells);

    for (let y = 0; y < procH; y++) {
      const yc = y - cy;
      for (let x = 0; x < procW; x++) {
        const xc = x - cx;
        const xr =  xc*ca + yc*sa + oX, yr = -xc*sa + yc*ca + oY;
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
        const xr =  xc*ca + yc*sa + oX, yr = -xc*sa + yc*ca + oY;
        const ix = (xr / cell) | 0, iy = (yr / cell) | 0;
        if (ix < 0 || iy < 0 || ix >= cellsX || iy >= cellsY) continue;
        const r = radii[iy * cellsX + ix];
        if (r <= 0) continue;
        const xrc = (ix + 0.5) * cell, yrc = (iy + 0.5) * cell;
        const dx = xr - xrc, dy = yr - yrc;
        if (Math.sqrt(dx*dx + dy*dy) <= r) screenAlpha[o] = 255;
      }
    }

    // ── 4. Composite + 1-bit threshold ────────────────────────────────────────
    const T = 128;
    for (let i = 0; i < N; i++) {
      let a = baseAlpha[i];
      if (screenAlpha[i] < a) a = screenAlpha[i];
      data[i * 4 + 3] = a >= T ? 255 : 0;
    }

    // ── 5. Commit + verify no semi-transparent pixels survived ────────────────
    ctx.putImageData(imgData, 0, 0);
    // Canvas stores pixels as premultiplied alpha; the straight→premult→straight
    // round-trip can leave ±1 drift on boundary pixels.  One extra pass fixes it.
    const verify = ctx.getImageData(0, 0, procW, procH);
    let dirty = false;
    for (let i = 3; i < verify.data.length; i += 4) {
      const a = verify.data[i];
      if (a !== 0 && a !== 255) { dirty = true; break; }
    }
    if (dirty) {
      for (let i = 3; i < verify.data.length; i += 4) {
        verify.data[i] = verify.data[i] >= 128 ? 255 : 0;
      }
      ctx.putImageData(verify, 0, 0);
    }

    saveSnapshot();
    cvs.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const newInfo: ImageInfo = { ...design.imageInfo, image: img };
        // halftoned: true  → export pipeline pre-cleans before drawing
        // alphaThresholded → nearest-neighbour scaling in export so bilinear
        //   interpolation cannot reintroduce semi-transparent edge pixels
        setDesigns(prev => prev.map(d => d.id === designId
          ? { ...d, imageInfo: newInfo, halftoned: true, alphaThresholded: true }
          : d));
        if (selectedDesignId === designId) setImageInfo(newInfo);
      };
      img.onerror = () => URL.revokeObjectURL(url);
      img.src = url;
    }, 'image/png');
  }, [designs, selectedDesignId, saveSnapshot, setDesigns, setImageInfo]);

  /** Open the halftone colour-picker dropdown, pre-loading top colours. */
  const handleOpenHalftoneMenu = useCallback(async () => {
    const id = selectedDesignId;
    if (!id) return;
    const design = designs.find(d => d.id === id);
    if (!design) return;
    const { extractColorsFromImage } = await import('@/lib/color-extractor');
    const extracted = extractColorsFromImage(design.imageInfo.image, 8);
    const top4 = extracted.slice(0, 4).map(c => ({
      r: c.rgb.r, g: c.rgb.g, b: c.rgb.b, hex: c.hex, name: c.name,
    }));
    setHalftoneTopColors(top4);
    setHalftoneMenuOpen(prev => !prev);
  }, [selectedDesignId, designs]);

  return {
    ...bag,
    halftoneStrength,
    setHalftoneStrength,
    halftoneMenuOpen,
    setHalftoneMenuOpen,
    halftoneTopColors,
    handleApplyHalftone,
    handleOpenHalftoneMenu,
  };
}
