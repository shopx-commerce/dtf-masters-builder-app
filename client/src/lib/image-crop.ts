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
  const ctx = canvas.getContext('2d');
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

export function cropImageToContent(image: HTMLImageElement): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    canvas.width = image.width;
    canvas.height = image.height;
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
    const outCtx = out.getContext('2d');
    if (!outCtx) return null;
    outCtx.drawImage(canvas, minX, minY, bw, bh, 0, 0, bw, bh);
    return out;
  } catch (error) {
    console.error('Error cropping image:', error);
    return null;
  }
}

import ImageCropWorker from './image-crop-worker?worker';

let _cropWorker: Worker | null = null;
function getCropWorker(): Worker | null {
  if (!_cropWorker) {
    try { _cropWorker = new ImageCropWorker(); }
    catch { return null; }
  }
  return _cropWorker;
}

let _cropRequestCounter = 0;

export function cropImageToContentAsync(image: HTMLImageElement): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(cropImageToContent(image)); return; }

      canvas.width = image.width;
      canvas.height = image.height;
      ctx.drawImage(image, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      const worker = getCropWorker();
      if (!worker) { resolve(cropImageToContent(image)); return; }

      const requestId = ++_cropRequestCounter;
      const buffer = imageData.data.buffer.slice(0);
      const timeout = setTimeout(() => {
        worker.removeEventListener('message', handler);
        resolve(cropImageToContent(image));
      }, 15000);

      const handler = (e: MessageEvent) => {
        if (e.data.type === 'result' && e.data.requestId === requestId) {
          clearTimeout(timeout);
          worker.removeEventListener('message', handler);
          const { processedBuffer, width, height, minX, minY, maxX, maxY, bgRemoved } = e.data;
          if (minX > maxX || minY > maxY) { resolve(null); return; }

          if (bgRemoved) {
            const processed = new Uint8ClampedArray(processedBuffer);
            const newImageData = new ImageData(processed, width, height);
            ctx.putImageData(newImageData, 0, 0);
          }

          const bw = maxX - minX + 1;
          const bh = maxY - minY + 1;
          const out = document.createElement('canvas');
          out.width = bw;
          out.height = bh;
          const outCtx = out.getContext('2d');
          if (!outCtx) { resolve(null); return; }
          outCtx.drawImage(canvas, minX, minY, bw, bh, 0, 0, bw, bh);
          resolve(out);
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'crop', pixelBuffer: buffer, width: canvas.width, height: canvas.height, requestId }, [buffer]);
    } catch (error) {
      console.error('Error in async crop:', error);
      resolve(cropImageToContent(image));
    }
  });
}