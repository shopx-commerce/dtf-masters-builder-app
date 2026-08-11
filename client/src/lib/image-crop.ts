/**
 * Check if image has binary alpha (0 or 255 only) - e.g. from Photoshop export.
 * Returns true if >95% of opaque pixels have alpha 255 and >95% of transparent have alpha 0.
 */
export function hasCleanAlpha(data: Uint8ClampedArray, w: number, h: number): boolean {
  let transparentCount = 0;
  let transparentClean = 0;
  let opaqueCount = 0;
  let opaqueClean = 0;
  const sampleStep = Math.max(1, Math.floor((w * h) / 10000));
  for (let i = 0; i < w * h; i += sampleStep) {
    const alpha = data[i * 4 + 3];
    if (alpha < 50) {
      transparentCount++;
      if (alpha === 0) transparentClean++;
    } else if (alpha > 200) {
      opaqueCount++;
      if (alpha === 255) opaqueClean++;
    }
  }
  const transparentOk = transparentCount === 0 || transparentClean / transparentCount >= 0.95;
  const opaqueOk = opaqueCount === 0 || opaqueClean / opaqueCount >= 0.95;
  return transparentCount > 0 && opaqueCount > 0 && transparentOk && opaqueOk;
}

/**
 * Detect a solid background color by sampling edge pixels.
 * If > 70% of edge pixels share the same color (within tolerance), return it.
 */
function detectEdgeBackground(data: Uint8ClampedArray, w: number, h: number): {r: number; g: number; b: number} | null {
  const samples: Array<{r: number; g: number; b: number}> = [];
  const addPixel = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    if (data[i + 3] > 200) samples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
  };
  const step = Math.max(1, Math.floor(Math.max(w, h) / 200));
  for (let x = 0; x < w; x += step) { addPixel(x, 0); addPixel(x, h - 1); }
  for (let y = 0; y < h; y += step) { addPixel(0, y); addPixel(w - 1, y); }
  if (samples.length < 8) return null;

  const counts = new Map<string, {r: number; g: number; b: number; n: number}>();
  const TOL = 30;
  for (const s of samples) {
    const key = `${Math.round(s.r / TOL)},${Math.round(s.g / TOL)},${Math.round(s.b / TOL)}`;
    const e = counts.get(key);
    if (e) { e.r += s.r; e.g += s.g; e.b += s.b; e.n++; }
    else counts.set(key, { r: s.r, g: s.g, b: s.b, n: 1 });
  }
  let best: {r: number; g: number; b: number; n: number} | null = null;
  for (const v of counts.values()) { if (!best || v.n > best.n) best = v; }
  if (!best || best.n / samples.length < 0.7) return null;
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/**
 * Remove solid-color background from image data by making matching pixels transparent.
 * Uses a flood-fill from the edges so interior pixels of the same color are preserved.
 */
function removeBackground(data: Uint8ClampedArray, w: number, h: number, bg: {r: number; g: number; b: number}, tol: number = 35): boolean {
  const totalPixels = w * h;
  const hadCleanAlpha = hasCleanAlpha(data, w, h);
  const visited = new Uint8Array(totalPixels);
  const queue: number[] = [];

  const matches = (idx: number) => {
    const i = idx * 4;
    if (data[i + 3] < 20) return true;
    return Math.abs(data[i] - bg.r) < tol && Math.abs(data[i + 1] - bg.g) < tol && Math.abs(data[i + 2] - bg.b) < tol;
  };

  for (let x = 0; x < w; x++) {
    if (matches(x)) { queue.push(x); visited[x] = 1; }
    const b = (h - 1) * w + x;
    if (matches(b)) { queue.push(b); visited[b] = 1; }
  }
  for (let y = 1; y < h - 1; y++) {
    const l = y * w;
    if (matches(l)) { queue.push(l); visited[l] = 1; }
    const r = y * w + w - 1;
    if (matches(r)) { queue.push(r); visited[r] = 1; }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    data[idx * 4 + 3] = 0;
    const x = idx % w, y = (idx - x) / w;
    const neighbors = [];
    if (x > 0) neighbors.push(idx - 1);
    if (x < w - 1) neighbors.push(idx + 1);
    if (y > 0) neighbors.push(idx - w);
    if (y < h - 1) neighbors.push(idx + w);
    for (const n of neighbors) {
      if (!visited[n] && matches(n)) { visited[n] = 1; queue.push(n); }
    }
  }

  const removedCount = queue.length;
  if (removedCount > totalPixels * 0.95) {
    return false;
  }

  // Skip edge-feather when image already had clean binary alpha (e.g. from Photoshop).
  // The feather would incorrectly add semi-transparent pixels to crisp edges.
  if (hadCleanAlpha) {
    return true;
  }

  // Edge-feather pass: clean up JPEG compression artifact halos.
  // Pixels adjacent to transparent areas that are close to the bg get faded.
  const widerTol = tol + 25;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const i = idx * 4;
      if (data[i + 3] === 0) continue;
      let touchesTransparent = false;
      if (x > 0 && data[((y) * w + (x - 1)) * 4 + 3] === 0) touchesTransparent = true;
      else if (x < w - 1 && data[((y) * w + (x + 1)) * 4 + 3] === 0) touchesTransparent = true;
      else if (y > 0 && data[((y - 1) * w + x) * 4 + 3] === 0) touchesTransparent = true;
      else if (y < h - 1 && data[((y + 1) * w + x) * 4 + 3] === 0) touchesTransparent = true;
      if (!touchesTransparent) continue;
      const dr = Math.abs(data[i] - bg.r);
      const dg = Math.abs(data[i + 1] - bg.g);
      const db = Math.abs(data[i + 2] - bg.b);
      if (dr < widerTol && dg < widerTol && db < widerTol) {
        const maxDiff = Math.max(dr, dg, db);
        if (maxDiff < tol) {
          data[i + 3] = 0;
        } else {
          data[i + 3] = Math.round(((maxDiff - tol) / (widerTol - tol)) * data[i + 3]);
        }
      }
    }
  }

  return true;
}

export function getImageBounds(image: HTMLImageElement): { x: number; y: number; width: number; height: number } {
  if (image.width === 0 || image.height === 0) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { x: 0, y: 0, width: image.width, height: image.height };

  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = 0;
  let maxY = 0;
  
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      if (alpha > 10) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  if (minX > maxX || minY > maxY) {
    return { x: 0, y: 0, width: image.width, height: image.height };
  }
  
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Longest edge of the scratch canvas `isOpaqueRasterUpload` samples. 200px gives up to
 * 40k alpha samples, more than the ~10k the previous full-resolution scan looked at, for
 * roughly 1/100th of the pixels read back off the GPU.
 */
const OPACITY_SAMPLE_MAX_EDGE = 200;

export function isOpaqueRasterUpload(image: HTMLImageElement): boolean {
  try {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    if (w <= 0 || h <= 0) return false;
    // No size ceiling: the scratch canvas below is 200 px whatever the source
    // is, so there is nothing here for a large upload to exhaust. A ceiling
    // would report a big opaque photo as *transparent*, which is the answer
    // that sends it down the trim path.

    // Draw into a small canvas and read that back instead of the whole image. The old code
    // read every pixel and then stepped through only ~10k of them, so ~99% of the readback
    // was discarded — and the readback is the expensive part, not the arithmetic.
    const scale = Math.min(1, OPACITY_SAMPLE_MAX_EDGE / Math.max(w, h));
    const sw = Math.max(1, Math.round(w * scale));
    const sh = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement('canvas');
    // Read-back canvas: without the hint Chrome keeps it GPU-backed and the
    // getImageData below blocks until the GPU flushes everything queued ahead
    // of it, which during a multi-file upload is seconds rather than millis.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;

    canvas.width = sw;
    canvas.height = sh;
    // Point sampling, not bilinear. Smoothing would AVERAGE alpha, so a hard-edged cutout's
    // transparent pixels would blend with opaque neighbours and a fully opaque image could
    // come back slightly transparent (or a lightly-cut one fully opaque). With nearest
    // neighbour every sampled alpha is a real alpha from the source, which makes the sample
    // an unbiased estimate of the true transparent-area fraction — exactly what this ratio
    // test needs, and the same quantity the old full-resolution stepped scan estimated.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;

    let transparentCount = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 50) transparentCount++;
    }
    const transparentRatio = transparentCount / (sw * sh);
    return transparentRatio <= 0.05;
  } catch {
    return false;
  }
}

// Full-frame canvas work above this many pixels (or this edge) OOMs mobile
// Safari and can freeze Chrome, so crops decline and callers must use a
// bounded copy of the source instead.
export const MAX_CROP_PIXELS = 16_000_000;
export const MAX_CROP_EDGE_PX = 4096;

/**
 * A copy of `image` as a canvas, downscaled only when the source exceeds the
 * crop limits above. For callers whose null-crop fallback is "use the whole
 * image": their layout comes from physical inch sizes, so an oversized raster
 * loses only excess sharpness here, never geometry — and the fallback stays
 * within the allocation budget the crop guard exists to protect.
 */
export function boundedImageCopyCanvas(image: HTMLImageElement): HTMLCanvasElement {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  const canvas = document.createElement('canvas');
  if (!(srcW > 0) || !(srcH > 0)) {
    canvas.width = 1;
    canvas.height = 1;
    return canvas;
  }
  const scale = Math.min(
    1,
    MAX_CROP_EDGE_PX / Math.max(srcW, srcH),
    Math.sqrt(MAX_CROP_PIXELS / (srcW * srcH)),
  );
  canvas.width = Math.max(1, Math.round(srcW * scale));
  canvas.height = Math.max(1, Math.round(srcH * scale));
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (scale < 1) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export function cropImageToContent(image: HTMLImageElement): HTMLCanvasElement | null {
  try {
    const srcW = image.naturalWidth || image.width;
    const srcH = image.naturalHeight || image.height;
    // Full-frame getImageData of a large raster OOMs Chrome (and Safari). Callers
    // fall back to the uncropped source when this returns null.
    if (!(srcW > 0) || !(srcH > 0) || srcW * srcH > MAX_CROP_PIXELS || Math.max(srcW, srcH) > MAX_CROP_EDGE_PX) {
      return null;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    canvas.width = srcW;
    canvas.height = srcH;
    ctx.drawImage(image, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    let opaqueCount = 0;
    let transparentCount = 0;
    const sampleStep = Math.max(1, Math.floor(data.length / 4 / 10000));
    for (let i = 3; i < data.length; i += sampleStep * 4) {
      const alpha = data[i];
      if (alpha > 240) opaqueCount++;
      else if (alpha < 50) transparentCount++;
    }
    const totalSampled = Math.ceil(data.length / 4 / sampleStep);
    const opaqueRatio = opaqueCount / totalSampled;
    const transparentRatio = transparentCount / totalSampled;

    const pixelCount = canvas.width * canvas.height;
    let bgWasRemoved = false;
    const hasSignificantTransparency = transparentRatio > 0.05;
    if (!hasSignificantTransparency && opaqueRatio > 0.9 && pixelCount <= 25_000_000) {
      const bg = detectEdgeBackground(data, canvas.width, canvas.height);
      if (bg) {
        const dataCopy = new Uint8ClampedArray(data);
        const ok = removeBackground(data, canvas.width, canvas.height, bg);
        if (!ok) {
          data.set(dataCopy);
        } else {
          bgWasRemoved = true;
          ctx.putImageData(imageData, 0, 0);
        }
      }
    }

    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (minX > maxX || minY > maxY) {
      return canvas;
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < canvas.width * 0.05 || bh < canvas.height * 0.05) {
      return canvas;
    }

    const out = document.createElement('canvas');
    out.width = bw;
    out.height = bh;
    // Callers encode or trace this canvas (`toDataURL` in `image-utils`, the
    // contour scans in `shape-outline` and `silhouette-contour`), so it is a
    // read-back target even though nothing in this file reads it.
    const outCtx = out.getContext('2d', { willReadFrequently: true });
    if (!outCtx) return null;
    outCtx.drawImage(canvas, minX, minY, bw, bh, 0, 0, bw, bh);
    return out;
  } catch (error) {
    console.error('Error cropping image:', error);
    return null;
  }
}
