interface OverlapRequest {
  type: 'check';
  designs: Array<{
    id: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    /** Index into `bitmaps`, or -1 for a design that has none. */
    bitmapIndex: number;
    drawX: number;
    drawY: number;
    drawW: number;
    drawH: number;
    rotation: number;
    cx: number;
    cy: number;
    stampExtraH?: number;
  }>;
  /**
   * Decoded artwork, already scaled to the footprint it is drawn at, shared by
   * every design that uses it. Copies of one design are the common case on a
   * gang sheet, and a transferred bitmap can only be handed over once.
   */
  bitmaps: ImageBitmap[];
  sw: number;
  sh: number;
}

self.onmessage = (e: MessageEvent<OverlapRequest>) => {
  const designs = e.data?.designs;
  // Bitmaps are shared between designs, so releasing them is a job for this
  // list rather than for the design loop — closing per design would close the
  // same bitmap several times and skip any that no design ended up using.
  const bitmaps = e.data?.bitmaps ?? [];
  const closeAll = () => {
    for (const b of bitmaps) { try { b.close(); } catch { /* already closed */ } }
  };
  try {
  if (e.data.type !== 'check') return;
  const { sw, sh } = e.data;

  const outOfBounds = new Set<string>();
  for (const dr of designs) {
    if (dr.left < -1 || dr.top < -1 || dr.right > sw + 1 || dr.bottom > sh + 1) {
      outOfBounds.add(dr.id);
    }
  }

  if (designs.length < 2) {
    closeAll();
    (self as unknown as Worker).postMessage({ type: 'result', overlapping: Array.from(outOfBounds) });
    return;
  }

  const aabbPairs: [number, number][] = [];
  for (let i = 0; i < designs.length; i++) {
    for (let j = i + 1; j < designs.length; j++) {
      const a = designs[i], b = designs[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        aabbPairs.push([i, j]);
      }
    }
  }

  if (aabbPairs.length === 0) {
    closeAll();
    (self as unknown as Worker).postMessage({ type: 'result', overlapping: Array.from(outOfBounds) });
    return;
  }

  // Rasterize a single design into a small region and return its alpha channel.
  // The region is defined by (rx, ry, rw, rh) in artboard-pixel coordinates.
  // Only the intersection area is allocated — NOT the full artboard.
  const rasterizeRegion = (
    d: OverlapRequest['designs'][0],
    rx: number, ry: number, rw: number, rh: number,
  ): Uint8Array | null => {
    const bitmap = bitmaps[d.bitmapIndex];
    if (!bitmap || rw < 1 || rh < 1) return null;
    try {
      const oc = new OffscreenCanvas(rw, rh);
      const ctx = oc.getContext('2d');
      if (!ctx) return null;
      // Translate so that artboard coords (rx,ry) map to canvas (0,0)
      ctx.translate(-rx, -ry);
      ctx.translate(d.cx, d.cy);
      ctx.rotate((d.rotation * Math.PI) / 180);
      ctx.drawImage(bitmap, -d.drawW / 2, -d.drawH / 2, d.drawW, d.drawH);
      if (d.stampExtraH && d.stampExtraH > 0) {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.fillRect(-d.drawW / 2, d.drawH / 2, d.drawW, d.stampExtraH);
      }
      const rgba = ctx.getImageData(0, 0, rw, rh).data;
      // Extract only alpha channel to save memory
      const alpha = new Uint8Array(rw * rh);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      return alpha;
    } catch {
      return null;
    }
  };

  const overlapping = new Set<string>(outOfBounds);

  for (const [i, j] of aabbPairs) {
    const a = designs[i], b = designs[j];
    // Both already flagged, so the pixel test cannot change the answer — the result
    // is a set of ids, and re-adding either is a no-op. On a crowded sheet, where most
    // designs touch something, this skips the bulk of the rasterisation: each test
    // costs two OffscreenCanvas draws plus two getImageData reads.
    if (overlapping.has(a.id) && overlapping.has(b.id)) continue;

    // Compute the intersection rectangle of the two AABBs
    const ix = Math.max(a.left, b.left);
    const iy = Math.max(a.top, b.top);
    const ix2 = Math.min(a.right, b.right);
    const iy2 = Math.min(a.bottom, b.bottom);
    const iw = Math.max(0, Math.round(ix2 - ix));
    const ih = Math.max(0, Math.round(iy2 - iy));
    if (iw < 1 || ih < 1) continue;

    // Cap the intersection canvas to prevent excessive memory on pathological cases
    const MAX_REGION = 2048;
    let rw = iw, rh = ih, rx = Math.round(ix), ry = Math.round(iy);
    if (rw > MAX_REGION || rh > MAX_REGION) {
      const scale = Math.min(MAX_REGION / rw, MAX_REGION / rh);
      rw = Math.round(rw * scale);
      rh = Math.round(rh * scale);
    }

    const alphaA = rasterizeRegion(a, rx, ry, rw, rh);
    const alphaB = rasterizeRegion(b, rx, ry, rw, rh);
    if (!alphaA || !alphaB) continue;

    // Fast coarse scan (every 4th pixel), then fine scan if needed
    let found = false;
    for (let p = 0; p < alphaA.length; p += 4) {
      if (alphaA[p] > 20 && alphaB[p] > 20) { found = true; break; }
    }
    if (!found) {
      for (let p = 0; p < alphaA.length; p++) {
        if (alphaA[p] > 20 && alphaB[p] > 20) { found = true; break; }
      }
    }
    if (found) {
      overlapping.add(a.id);
      overlapping.add(b.id);
    }
  }

  closeAll();

  (self as unknown as Worker).postMessage({ type: 'result', overlapping: Array.from(overlapping) });
  } catch (err) {
    closeAll();
    (self as unknown as Worker).postMessage({ type: 'error', error: String(err) });
  }
};
