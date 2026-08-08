interface DesignExportData {
  widthInches: number;
  heightInches: number;
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  // New shape: index into `sources[]` (shared across duplicate designs).
  // Old shape: an inline per-design PNG buffer. One of the two is set.
  sourceIndex?: number;
  imageBuffer?: ArrayBuffer;
  mimeType?: string;
  // Content box within the source, in source pixels. Present when the source
  // is an uncropped original (the oversized-raster import path).
  sourceCrop?: { x: number; y: number; width: number; height: number };
  alphaThresholded?: boolean;
  printFileName?: boolean;
  name?: string;
}

interface ExportInput {
  type: 'export';
  requestId: number;
  designs: DesignExportData[];
  // Deduplicated source PNG buffers. If designs use `sourceIndex`, they refer
  // into this array. Absent when the caller uses the older inline shape.
  sources?: ArrayBuffer[];
  outW: number;
  outH: number;
  exportDpi: number;
}

interface DesignExportBounds {
  design: DesignExportData;
  drawW: number;
  drawH: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  stampKey: string;
}

// Per-stamp memory cap: skip caching individual stamps that would exceed this
// (huge one-off designs). Small duplicates (the common gangsheet case) always fit.
const STAMP_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB RGBA per stamp (= ~4096x4096)
// Total stamp cache cap: guard against many unique large stamps.
const STAMP_CACHE_TOTAL_MAX_BYTES = 256 * 1024 * 1024; // 256 MB across all stamps

function makeStampKey(d: DesignExportData, drawW: number, drawH: number): string {
  const nameKey = d.printFileName && d.name ? `|n${d.name}` : '';
  return [
    designSourceKey(d),
    drawW,
    drawH,
    d.rotation | 0,
    d.flipX ? 1 : 0,
    d.flipY ? 1 : 0,
    d.alphaThresholded ? 1 : 0,
    d.printFileName ? 1 : 0,
    nameKey,
  ].join('|');
}

// Keep temporary export canvases bounded for tall sheets. This only changes
// internal batching; output dimensions, DPI, placement, and pixel quality are
// unchanged.
const STRIP_HEIGHT = 4096;
const BATCH_ROWS = 1024;
const MAX_IDAT_BYTES = 2 * 1024 * 1024;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  chunk[4] = type.charCodeAt(0);
  chunk[5] = type.charCodeAt(1);
  chunk[6] = type.charCodeAt(2);
  chunk[7] = type.charCodeAt(3);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function designDrawSize(d: DesignExportData, exportDpi: number) {
  return {
    drawW: Math.max(1, Math.round(d.widthInches * d.s * exportDpi)),
    drawH: Math.max(1, Math.round(d.heightInches * d.s * exportDpi)),
  };
}

function designAabb(d: DesignExportData, outW: number, outH: number, exportDpi: number) {
  const { drawW, drawH } = designDrawSize(d, exportDpi);
  const centerX = d.nx * outW;
  const centerY = d.ny * outH;
  const rad = (d.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const aabbW = Math.max(1, Math.ceil(drawW * cos + drawH * sin));
  const aabbH = Math.max(1, Math.ceil(drawW * sin + drawH * cos));
  return {
    drawW,
    drawH,
    centerX,
    centerY,
    aabbW,
    aabbH,
    left: centerX - aabbW / 2,
    right: centerX + aabbW / 2,
    top: centerY - aabbH / 2,
    bottom: centerY + aabbH / 2,
  };
}

function stripHasContent(designs: DesignExportBounds[], stripY: number, stripH: number): boolean {
  const stripBottom = stripY + stripH;
  for (const p of designs) {
    if (p.bottom >= stripY && p.top <= stripBottom) return true;
  }
  return false;
}

// Decode-once cache for source buffers. Keyed by source index (or a stable
// synthetic key when the caller sends inline buffers).
type SourceBitmapCache = Map<string, ImageBitmap>;

/**
 * Decode a design's print source, cropped and scaled to the size it will
 * actually occupy on the sheet.
 *
 * A design never needs more pixels than its placed size at the export DPI, so
 * asking the codec for exactly that bounds peak memory by the sheet rather
 * than by the upload: a 150 MP photo placed at 4"×3" decodes to 1200×900.
 * It is also higher quality than decoding full-size and scaling afterwards,
 * because the pixels are resampled once, inside the decoder.
 *
 * Downscale only. When the source is already smaller than the placement we
 * decode it 1:1 and let the stamp canvas do the upscale, exactly as before.
 */
async function getSourceBitmap(
  d: DesignExportData,
  sources: ArrayBuffer[] | undefined,
  cache: SourceBitmapCache,
  targetW?: number,
  targetH?: number,
): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode images inside the export worker.');
  }
  const crop = d.sourceCrop;
  const wantW = targetW && targetW > 0 ? Math.round(targetW) : 0;
  const wantH = targetH && targetH > 0 ? Math.round(targetH) : 0;
  const key = `${designSourceKey(d)}|${wantW}x${wantH}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const buf = d.sourceIndex != null && sources ? sources[d.sourceIndex] : d.imageBuffer;
  if (!buf) throw new Error('Export design is missing image data.');
  const blob = new Blob([buf], { type: d.mimeType || 'image/png' });

  const resizeQuality: ImageBitmapOptions['resizeQuality'] = d.alphaThresholded ? 'pixelated' : 'high';
  const shouldResize =
    wantW > 0 && wantH > 0 &&
    (!crop || wantW < crop.width || wantH < crop.height);
  const options: ImageBitmapOptions | undefined = shouldResize
    ? { resizeWidth: wantW, resizeHeight: wantH, resizeQuality }
    : undefined;

  let bitmap: ImageBitmap;
  if (crop) {
    bitmap = await createImageBitmap(blob, crop.x, crop.y, crop.width, crop.height, options);
  } else if (options) {
    // Without a crop rect we only know the source size after a probe decode,
    // so clamp the request to the natural size to avoid upscaling here.
    const probe = await createImageBitmap(blob);
    if (wantW >= probe.width && wantH >= probe.height) {
      cache.set(key, probe);
      return probe;
    }
    bitmap = await createImageBitmap(probe, 0, 0, probe.width, probe.height, options);
    probe.close();
  } else {
    bitmap = await createImageBitmap(blob);
  }
  cache.set(key, bitmap);
  return bitmap;
}

// Stable per-source key, used by both the decoded-bitmap cache and the stamp
// cache. For the new (deduped) shape the source index is authoritative; for
// the legacy inline shape we tag each design with a WeakMap-based synthetic
// index the first time we see it so repeat strips can hit the cache.
const inlineSourceIndex = new WeakMap<ArrayBuffer, number>();
let inlineSourceCounter = 0;
function designSourceKey(d: DesignExportData): string {
  if (d.sourceIndex != null) return `s${d.sourceIndex}`;
  const buf = d.imageBuffer;
  if (!buf) return `nil`;
  let idx = inlineSourceIndex.get(buf);
  if (idx == null) {
    idx = ++inlineSourceCounter;
    inlineSourceIndex.set(buf, idx);
  }
  return `i${idx}`;
}

type StampCache = Map<string, OffscreenCanvas>;

// Pre-render a design into an AABB-sized canvas. If the same source + render
// parameters appear again in another copy (typical for duplicated stickers),
// we skip the entire rotate/scale/drawImage/text pipeline and just blit the
// pre-baked stamp with a single drawImage — orders of magnitude cheaper than
// rebuilding each copy from scratch.
async function getOrBuildStamp(
  d: DesignExportData,
  bounds: DesignExportBounds,
  bitmap: ImageBitmap,
  exportDpi: number,
  cache: StampCache,
  cacheState: { totalBytes: number },
): Promise<{ stamp: OffscreenCanvas | null; aabbW: number; aabbH: number }> {
  const aabbW = bounds.width;
  const aabbH = bounds.height;
  const stampBytes = aabbW * aabbH * 4;
  const canCache = stampBytes <= STAMP_CACHE_MAX_BYTES
    && cacheState.totalBytes + stampBytes <= STAMP_CACHE_TOTAL_MAX_BYTES;

  if (canCache) {
    const existing = cache.get(bounds.stampKey);
    if (existing) {
      return { stamp: existing, aabbW, aabbH };
    }
  }

  const stamp = new OffscreenCanvas(aabbW, aabbH);
  const sctx = stamp.getContext('2d', { alpha: true });
  if (!sctx) return { stamp: null, aabbW, aabbH };

  sctx.imageSmoothingEnabled = !d.alphaThresholded;
  sctx.imageSmoothingQuality = 'high';
  sctx.save();
  // Round the internal pivot so it lands on an integer pixel, matching the
  // pre-cache path that translated to Math.round(centerX). This guarantees
  // byte-identical output regardless of whether we hit the stamp cache.
  sctx.translate(Math.round(aabbW / 2), Math.round(aabbH / 2));
  sctx.rotate((d.rotation * Math.PI) / 180);
  sctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
  sctx.drawImage(bitmap, -bounds.drawW / 2, -bounds.drawH / 2, bounds.drawW, bounds.drawH);
  if (d.printFileName && d.name) {
    sctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    const marginPx = 0.1 * exportDpi;
    const fontSize = Math.max(8, Math.round(bounds.drawH * 0.045));
    sctx.font = `bold ${fontSize}px sans-serif`;
    const displayName = d.name.replace(/\.[^/.]+$/, '');
    sctx.fillStyle = '#000000';
    sctx.textAlign = 'right';
    sctx.textBaseline = 'top';
    sctx.fillText(displayName, bounds.drawW / 2, bounds.drawH / 2 + marginPx);
  }
  sctx.restore();

  if (canCache) {
    cache.set(bounds.stampKey, stamp);
    cacheState.totalBytes += stampBytes;
  }
  return { stamp, aabbW, aabbH };
}

async function drawDesignsOnStrip(
  ctx: OffscreenCanvasRenderingContext2D,
  designs: DesignExportBounds[],
  stripY: number,
  stripH: number,
  exportDpi: number,
  sources: ArrayBuffer[] | undefined,
  bitmapCache: SourceBitmapCache,
  stampCache: StampCache,
  stampCacheState: { totalBytes: number },
) {
  const stripBottom = stripY + stripH;
  for (const p of designs) {
    if (p.bottom < stripY || p.top > stripBottom) continue;
    const d = p.design;
    const bitmap = await getSourceBitmap(d, sources, bitmapCache, p.drawW, p.drawH);
    const { stamp, aabbW, aabbH } = await getOrBuildStamp(
      d, p, bitmap, exportDpi, stampCache, stampCacheState,
    );
    if (!stamp) continue;

    // Placement chosen so the design's pivot lands on the same integer pixel
    // as the pre-cache code path (Math.round of the design's absolute center),
    // preserving byte-identical output.
    const stampCenterInX = Math.round(aabbW / 2);
    const stampCenterInY = Math.round(aabbH / 2);
    const drawX = Math.round(p.left + p.width / 2) - stampCenterInX;
    const drawY = Math.round(p.top - stripY + p.height / 2) - stampCenterInY;
    ctx.drawImage(stamp, drawX, drawY);
  }
}

type FilterScratch = { sub: Uint8Array; up: Uint8Array; avg: Uint8Array; paeth: Uint8Array };

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Picks the PNG filter (None/Sub/Up/Average/Paeth) that compresses smallest for this row — lossless.
function filterRowAdaptive(
  cur: Uint8ClampedArray,
  prev: Uint8Array,
  bpp: number,
  rowBytes: number,
  scratch: FilterScratch,
  out: Uint8Array,
  outOff: number,
) {
  const { sub, up, avg, paeth } = scratch;
  let sNone = 0, sSub = 0, sUp = 0, sAvg = 0, sPaeth = 0;
  for (let i = 0; i < rowBytes; i++) {
    const x = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;

    sNone += x < 128 ? x : 256 - x;

    const vs = (x - a) & 0xff; sub[i] = vs; sSub += vs < 128 ? vs : 256 - vs;
    const vu = (x - b) & 0xff; up[i] = vu; sUp += vu < 128 ? vu : 256 - vu;
    const vg = (x - ((a + b) >> 1)) & 0xff; avg[i] = vg; sAvg += vg < 128 ? vg : 256 - vg;
    const vp = (x - paethPredictor(a, b, c)) & 0xff; paeth[i] = vp; sPaeth += vp < 128 ? vp : 256 - vp;
  }

  let best = 0, bestSum = sNone;
  if (sSub < bestSum) { best = 1; bestSum = sSub; }
  if (sUp < bestSum) { best = 2; bestSum = sUp; }
  if (sAvg < bestSum) { best = 3; bestSum = sAvg; }
  if (sPaeth < bestSum) { best = 4; }

  out[outOff] = best;
  const d = outOff + 1;
  switch (best) {
    case 0: out.set(cur, d); break;
    case 1: out.set(sub, d); break;
    case 2: out.set(up, d); break;
    case 3: out.set(avg, d); break;
    default: out.set(paeth, d); break;
  }
}

async function writeEmptyRows(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  _outW: number,
  rowCount: number,
  _emptyRow: Uint8Array,
  filteredRowLen: number,
) {
  // new Uint8Array is already zero-filled, so allocation *is* the empty batch.
  // We skip the per-row .set() copy loop, cutting empty-strip CPU roughly in half.
  for (let startRow = 0; startRow < rowCount; startRow += BATCH_ROWS) {
    const batchCount = Math.min(BATCH_ROWS, rowCount - startRow);
    const batch = new Uint8Array(batchCount * filteredRowLen);
    await writer.write(batch);
  }
}

// True when the entire row is zero (fully transparent). Common inside content
// strips for gangsheets, where designs are sparse and most rows are blank.
function isRowAllZero(pixels: Uint8ClampedArray, offset: number, length: number): boolean {
  const end = offset + length;
  let i = offset;
  // Aligned 32-bit stride for speed; Uint8ClampedArray is byte-addressable
  // but the browser lays it out contiguously so we can safely walk it.
  for (; i + 8 <= end; i += 8) {
    if (
      pixels[i] | pixels[i + 1] | pixels[i + 2] | pixels[i + 3] |
      pixels[i + 4] | pixels[i + 5] | pixels[i + 6] | pixels[i + 7]
    ) return false;
  }
  for (; i < end; i++) {
    if (pixels[i]) return false;
  }
  return true;
}

async function writeStripRows(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  pixels: Uint8ClampedArray,
  stripH: number,
  filteredRowLen: number,
  rowBytes: number,
  bpp: number,
  prevRow: Uint8Array,
  scratch: FilterScratch,
) {
  for (let startRow = 0; startRow < stripH; startRow += BATCH_ROWS) {
    const endRow = Math.min(startRow + BATCH_ROWS, stripH);
    const batchCount = endRow - startRow;
    const batch = new Uint8Array(batchCount * filteredRowLen);
    for (let r = 0; r < batchCount; r++) {
      const rowIdx = startRow + r;
      const rowStart = rowIdx * rowBytes;
      const cur = pixels.subarray(rowStart, rowStart + rowBytes);
      if (isRowAllZero(pixels, rowStart, rowBytes)) {
        // Filter type 0 (None) + zero row: cheapest possible representation.
        // batch is already zero, so filter byte + payload are both correct.
        prevRow.fill(0);
      } else {
        filterRowAdaptive(cur, prevRow, bpp, rowBytes, scratch, batch, r * filteredRowLen);
        prevRow.set(cur); // this row is the "up" reference for the next
      }
    }
    await writer.write(batch);
  }
}

async function buildPngStreaming(input: ExportInput): Promise<Uint8Array> {
  const { designs, sources, outW, outH, exportDpi } = input;
  const ppm = Math.round(exportDpi / 0.0254);
  const designBounds: DesignExportBounds[] = designs.map((design) => {
    const bounds = designAabb(design, outW, outH, exportDpi);
    return {
      design,
      drawW: bounds.drawW,
      drawH: bounds.drawH,
      left: bounds.left,
      top: bounds.top,
      right: bounds.right,
      bottom: bounds.bottom,
      width: bounds.aabbW,
      height: bounds.aabbH,
      stampKey: makeStampKey(design, bounds.drawW, bounds.drawH),
    };
  });
  const bitmapCache: SourceBitmapCache = new Map();
  const stampCache: StampCache = new Map();
  const stampCacheState = { totalBytes: 0 };
  self.postMessage({
    type: 'progress',
    requestId: input.requestId,
    phase: 'preparing',
    completed: 1,
    total: 1,
  });

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = new Uint8Array(13);
  const ihdrDv = new DataView(ihdrData.buffer);
  ihdrDv.setUint32(0, outW);
  ihdrDv.setUint32(4, outH);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makePngChunk('IHDR', ihdrData);

  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk('pHYs', physData);

  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();

  const compressedParts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  const readPromise = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedParts.push(new Uint8Array(value));
    }
  })();

  const rowBytes = outW * 4;
  const filteredRowLen = 1 + rowBytes;
  const emptyRow = new Uint8Array(filteredRowLen);

  // Adaptive-filter state, reused across all rows/strips to avoid per-row allocation.
  const bpp = 4; // RGBA, 8-bit
  const prevRow = new Uint8Array(rowBytes); // "up" reference; starts as zeros (transparent)
  const scratch: FilterScratch = {
    sub: new Uint8Array(rowBytes),
    up: new Uint8Array(rowBytes),
    avg: new Uint8Array(rowBytes),
    paeth: new Uint8Array(rowBytes),
  };

  let stripCanvas: OffscreenCanvas | null = null;
  let stripCtx: OffscreenCanvasRenderingContext2D | null = null;
  const totalStrips = Math.max(1, Math.ceil(outH / STRIP_HEIGHT));
  let completedStrips = 0;

  for (let stripY = 0; stripY < outH; stripY += STRIP_HEIGHT) {
    const stripH = Math.min(STRIP_HEIGHT, outH - stripY);

    if (!stripHasContent(designBounds, stripY, stripH)) {
      await writeEmptyRows(writer, outW, stripH, emptyRow, filteredRowLen);
      prevRow.fill(0); // the rows just written are fully transparent (zero)
      completedStrips++;
      self.postMessage({
        type: 'progress',
        requestId: input.requestId,
        phase: 'rendering',
        completed: completedStrips,
        total: totalStrips,
      });
      continue;
    }

    if (!stripCanvas || stripCanvas.width !== outW || stripCanvas.height !== stripH) {
      stripCanvas = new OffscreenCanvas(outW, stripH);
      stripCtx = stripCanvas.getContext('2d', { alpha: true, willReadFrequently: true });
      if (!stripCtx) throw new Error('Failed to get strip canvas context');
    }
    const ctx = stripCtx!;
    ctx.clearRect(0, 0, outW, stripH);
    await drawDesignsOnStrip(
      ctx, designBounds, stripY, stripH, exportDpi,
      sources, bitmapCache, stampCache, stampCacheState,
    );

    const imageData = ctx.getImageData(0, 0, outW, stripH);
    await writeStripRows(writer, imageData.data, stripH, filteredRowLen, rowBytes, bpp, prevRow, scratch);
    completedStrips++;
    self.postMessage({
      type: 'progress',
      requestId: input.requestId,
      phase: 'rendering',
      completed: completedStrips,
      total: totalStrips,
    });
  }

  if (stripCanvas) {
    stripCanvas.width = 0;
    stripCanvas.height = 0;
  }

  // Release the source-bitmap and stamp caches so their pixel storage can be
  // reclaimed before the final PNG chunks are assembled. Stamps and bitmaps
  // can add up to hundreds of megabytes on a duplicate-heavy 370" sheet.
  for (const bitmap of bitmapCache.values()) {
    try { bitmap.close(); } catch {}
  }
  bitmapCache.clear();
  for (const stamp of stampCache.values()) {
    stamp.width = 0;
    stamp.height = 0;
  }
  stampCache.clear();
  stampCacheState.totalBytes = 0;

  self.postMessage({
    type: 'progress',
    requestId: input.requestId,
    phase: 'finalizing',
    completed: 0,
    total: 1,
  });

  await writer.close();
  await readPromise;

  let totalCompressed = 0;
  for (const p of compressedParts) totalCompressed += p.length;
  const compressed = new Uint8Array(totalCompressed);
  let pos = 0;
  for (const p of compressedParts) {
    compressed.set(p, pos);
    pos += p.length;
  }

  const idatChunks: Uint8Array[] = [];
  for (let i = 0; i < compressed.length; i += MAX_IDAT_BYTES) {
    idatChunks.push(makePngChunk('IDAT', compressed.subarray(i, Math.min(i + MAX_IDAT_BYTES, compressed.length))));
  }

  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const parts = [signature, ihdrChunk, physChunk, ...idatChunks, iendChunk];
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLen);
  pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

async function runExportLegacy(input: ExportInput): Promise<Uint8Array> {
  const { designs, sources, outW, outH, exportDpi } = input;

  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get OffscreenCanvas context');

  ctx.clearRect(0, 0, outW, outH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const bitmapCache: SourceBitmapCache = new Map();
  if (typeof createImageBitmap !== 'function') {
    throw new Error('This browser cannot decode images inside the export worker.');
  }
  for (const design of designs) {
    const { drawW, drawH } = designDrawSize(design, exportDpi);
    const bitmap = await getSourceBitmap(design, sources, bitmapCache, drawW, drawH);
    const centerX = design.nx * outW;
    const centerY = design.ny * outH;

    if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((design.rotation * Math.PI) / 180);
    ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
    ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
    if (design.printFileName && design.name) {
      ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
      const marginPx = 0.1 * exportDpi;
      const fontSize = Math.max(8, Math.round(drawH * 0.045));
      ctx.font = `bold ${fontSize}px sans-serif`;
      const displayName = design.name.replace(/\.[^/.]+$/, '');
      ctx.fillStyle = '#000000';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(displayName, drawW / 2, drawH / 2 + marginPx);
      ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
    }
    ctx.restore();
    if (design.alphaThresholded) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
  }
  for (const bitmap of bitmapCache.values()) {
    try { bitmap.close(); } catch {}
  }
  bitmapCache.clear();

  const rawBlob = await canvas.convertToBlob({ type: 'image/png' });
  const rawBuf = new Uint8Array(await rawBlob.arrayBuffer());

  const ppm = Math.round(exportDpi / 0.0254);
  const physData = new Uint8Array(9);
  const physDv = new DataView(physData.buffer);
  physDv.setUint32(0, ppm);
  physDv.setUint32(4, ppm);
  physData[8] = 1;
  const physChunk = makePngChunk('pHYs', physData);

  const parts: Uint8Array[] = [];
  parts.push(rawBuf.slice(0, 8));
  const ihdrDataLen = ((rawBuf[8] << 24) | (rawBuf[9] << 16) | (rawBuf[10] << 8) | rawBuf[11]) >>> 0;
  const ihdrTotal = 12 + ihdrDataLen;
  parts.push(rawBuf.slice(8, 8 + ihdrTotal));
  parts.push(physChunk);
  let offset = 8 + ihdrTotal;
  while (offset + 12 <= rawBuf.length) {
    const dataLen = ((rawBuf[offset] << 24) | (rawBuf[offset + 1] << 16) | (rawBuf[offset + 2] << 8) | rawBuf[offset + 3]) >>> 0;
    const chunkTotal = 12 + dataLen;
    const isPHYs = rawBuf[offset + 4] === 0x70 && rawBuf[offset + 5] === 0x48 &&
                   rawBuf[offset + 6] === 0x59 && rawBuf[offset + 7] === 0x73;
    if (!isPHYs) parts.push(rawBuf.slice(offset, offset + chunkTotal));
    offset += chunkTotal;
  }

  canvas.width = 0;
  canvas.height = 0;
  self.postMessage({
    type: 'progress',
    requestId: input.requestId,
    phase: 'finalizing',
    completed: 0,
    total: 1,
  });
  const totalLen = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLen);
  let writePos = 0;
  for (const part of parts) {
    out.set(part, writePos);
    writePos += part.length;
  }
  return out;
}

const hasStreaming = typeof CompressionStream !== 'undefined';

type R2PartMeta = { partNumber: number; url: string };
type R2UploadMeta = {
  singlePut?: boolean;
  putUrl?: string;
  putHeaders?: Record<string, string>;
  parts?: R2PartMeta[];
  partSize?: number;
  totalParts?: number;
  parallelism?: number;
};

async function uploadBufferToPreparedR2(
  buffer: ArrayBuffer,
  meta: R2UploadMeta,
  requestId: string,
): Promise<Array<{ partNumber: number; etag: string }>> {
  const total = buffer.byteLength;
  if (meta.singlePut && meta.putUrl) {
    const putHeaders = meta.putHeaders || { 'Content-Type': 'image/png' };
    const putRes = await fetch(String(meta.putUrl), { method: 'PUT', body: buffer, headers: putHeaders });
    if (!putRes.ok) throw new Error(`Cloud upload failed: ${putRes.status}`);
    return [];
  }
  const parts = Array.isArray(meta.parts) ? meta.parts : [];
  if (!parts.length) throw new Error('Upload prepare incomplete');
  const bytes = new Uint8Array(buffer);
  const partSize = Number(meta.partSize) || 64 * 1024 * 1024;
  const totalParts = Number(meta.totalParts) || parts.length;
  const parallelism = Math.max(1, Math.min(Number(meta.parallelism) || 16, totalParts));
  const sorted = parts.slice().sort((a, b) => Number(a.partNumber) - Number(b.partNumber));
  let nextIndex = 0;
  const uploadedParts: Array<{ partNumber: number; etag: string }> = [];

  async function uploadPart(part: R2PartMeta) {
    const pn = Number(part.partNumber);
    const start = (pn - 1) * partSize;
    const end = Math.min(start + partSize, total);
    self.postMessage({ type: 'r2-upload-progress', requestId, message: `Uploading part ${pn} of ${totalParts}...` });
    const chunk = bytes.subarray(start, end);
    const res = await fetch(String(part.url), { method: 'PUT', body: chunk });
    if (!res.ok) throw new Error(`Cloud upload part ${pn} failed: ${res.status}`);
    const etag = res.headers.get('etag') || res.headers.get('ETag');
    if (etag) uploadedParts.push({ partNumber: pn, etag });
  }

  async function worker() {
    while (nextIndex < sorted.length) {
      const part = sorted[nextIndex++];
      await uploadPart(part);
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return uploadedParts;
}

self.onmessage = async function(e: MessageEvent) {
  if (e.data.type === 'r2-upload') {
    try {
      const buffer = e.data.buffer as ArrayBuffer | undefined;
      if (!buffer || !buffer.byteLength) throw new Error('Empty design image');
      const meta = e.data.meta as R2UploadMeta;
      const requestId = String(e.data.requestId || '');
      const uploadedParts = await uploadBufferToPreparedR2(buffer, meta, requestId);
      self.postMessage({ type: 'r2-upload-done', requestId, uploadedParts });
    } catch (err: any) {
      self.postMessage({
        type: 'error',
        requestId: e.data.requestId,
        error: err?.message || 'R2 upload failed',
      });
    }
    return;
  }
  if (e.data.type === 'export') {
    const designs = e.data.designs as ExportInput['designs'] | undefined;
    try {
      const bytes = hasStreaming
        ? await buildPngStreaming(e.data)
        : await runExportLegacy(e.data);
      const buffer = bytes.buffer as ArrayBuffer;
      (self as unknown as Worker).postMessage(
        { type: 'result', requestId: e.data.requestId, buffer, byteLength: bytes.byteLength },
        [buffer],
      );
    } catch (err: any) {
      self.postMessage({ type: 'error', requestId: e.data.requestId, error: err?.message || 'Export failed' });
    }
  }
};
