import { makePngChunk, pngHeaderParts, stripRangesFor } from "./png-stream";
import { drawPrintLabel, labelReadsUpsideDown, type PrintLabelLayout } from "./print-label";

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
  /**
   * Where the printed filename goes, decided on the main thread.
   *
   * Not recomputed here on purpose. Choosing between the artwork's own corner and a band
   * underneath needs the design's ink silhouette, which is built from a canvas the main thread
   * has and this worker does not. Sending the answer is what guarantees the film reserved by the
   * nester is the film the label lands on.
   */
  label?: PrintLabelLayout;
}

interface ExportInput {
  type: 'export';
  requestId: number;
  designs: DesignExportData[];
  /**
   * Deduplicated source images. If designs use `sourceIndex`, they refer into
   * this array. Absent when the caller uses the older inline shape.
   *
   * Blobs rather than ArrayBuffers on purpose. A Blob crosses to the worker as
   * a reference to browser-managed storage, which can page to disk; reading
   * every full-resolution upload into an ArrayBuffer first put all of them in
   * the main thread's JS heap simultaneously, before a single pixel had been
   * rendered. On a gangsheet with a dozen large uploads that was the peak of
   * the whole export.
   */
  sources?: Blob[];
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
  /** The design's centre on the sheet, and where that centre sits inside `width` × `height`. */
  centerX: number;
  centerY: number;
  pivotX: number;
  pivotY: number;
  stampKey: string;
}

// Per-stamp memory cap: skip caching individual stamps that would exceed this
// (huge one-off designs). Small duplicates (the common gangsheet case) always fit.
const STAMP_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB RGBA per stamp (= ~4096x4096)
// Total stamp cache cap: guard against many unique large stamps.
const STAMP_CACHE_TOTAL_MAX_BYTES = 256 * 1024 * 1024; // 256 MB across all stamps

function makeStampKey(d: DesignExportData, drawW: number, drawH: number): string {
  // The label's own text and placement, not just the flag: a name that had to be shortened to fit
  // and a name that did not are different pixels, a name that wrapped onto two rows is different
  // again, and a label in the corner is a different canvas from one in a band. Two copies of a
  // design may only share a pre-render if all of that matches, so the rows are joined with a
  // separator that cannot occur inside one.
  const labelKey = d.label ? `|n${d.label.lines.join('\u0000')}|p${d.label.placement}` : '';
  return [
    designSourceKey(d),
    drawW,
    drawH,
    d.rotation | 0,
    d.flipX ? 1 : 0,
    d.flipY ? 1 : 0,
    d.alphaThresholded ? 1 : 0,
    d.printFileName ? 1 : 0,
    labelKey,
  ].join('|');
}

const BATCH_ROWS = 1024;
/**
 * How many bytes of finished IDAT chunks to hold in the heap before folding them
 * into a Blob. This is the peak the PNG assembly costs, independent of how large
 * the sheet is.
 */
const IDAT_FOLD_BYTES = 16 * 1024 * 1024;

function designDrawSize(d: DesignExportData, exportDpi: number) {
  return {
    drawW: Math.max(1, Math.round(d.widthInches * d.s * exportDpi)),
    drawH: Math.max(1, Math.round(d.heightInches * d.s * exportDpi)),
  };
}

/**
 * How far the label reaches outside the artwork's own bounding box, in whole pixels per side.
 *
 * The design's pre-render canvas used to be sized to the artwork alone while the label was drawn
 * a tenth of an inch below it — off the canvas, so the label was clipped away entirely and never
 * reached the printed sheet. These paddings are what give it somewhere to land.
 *
 * A label placed inside the artwork returns zeroes: it is already inside the box.
 */
function labelPadding(d: DesignExportData, drawW: number, drawH: number) {
  const none = { left: 0, top: 0, right: 0, bottom: 0 };
  const label = d.label;
  const artH = d.heightInches * d.s;
  if (!label || !(artH > 0)) return none;

  // Against the drawn artwork rather than the nominal export DPI, so the label keeps its
  // proportions after `drawW`/`drawH` were rounded to whole pixels.
  const pxPerInch = drawH / artH;
  const x0 = label.rect.x * pxPerInch;
  const y0 = label.rect.y * pxPerInch;
  const x1 = (label.rect.x + label.rect.width) * pxPerInch;
  const y1 = (label.rect.y + label.rect.height) * pxPerInch;

  const rad = (d.rotation * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
    const rx = x * cosA - y * sinA;
    const ry = x * sinA + y * cosA;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }

  // The artwork's canvas puts the pivot on a whole pixel, so its edges sit at these distances
  // from the pivot and the padding is whatever the label needs beyond them.
  const cos = Math.abs(cosA);
  const sin = Math.abs(sinA);
  const aabbW = Math.max(1, Math.ceil(drawW * cos + drawH * sin));
  const aabbH = Math.max(1, Math.ceil(drawW * sin + drawH * cos));
  const pivotX = Math.round(aabbW / 2);
  const pivotY = Math.round(aabbH / 2);
  return {
    left: Math.max(0, Math.ceil(-pivotX - minX)),
    top: Math.max(0, Math.ceil(-pivotY - minY)),
    right: Math.max(0, Math.ceil(maxX - (aabbW - pivotX))),
    bottom: Math.max(0, Math.ceil(maxY - (aabbH - pivotY))),
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
  const pad = labelPadding(d, drawW, drawH);
  // Every expression below reduces to the unpadded one when there is no label, so an unlabelled
  // sheet exports the same bytes it always did.
  return {
    drawW,
    drawH,
    centerX,
    centerY,
    aabbW: aabbW + pad.left + pad.right,
    aabbH: aabbH + pad.top + pad.bottom,
    /** Where the design's centre sits inside its pre-render canvas, on a whole pixel. */
    pivotX: Math.round(aabbW / 2) + pad.left,
    pivotY: Math.round(aabbH / 2) + pad.top,
    left: centerX - aabbW / 2 - pad.left,
    right: centerX + aabbW / 2 + pad.right,
    top: centerY - aabbH / 2 - pad.top,
    bottom: centerY + aabbH / 2 + pad.bottom,
  };
}

/**
 * Placement and stamp identity for every design on the sheet.
 *
 * Depends only on the sheet geometry, so a band worker computes it once for the
 * whole sheet and reuses it for each band it is handed.
 */
function boundsForDesigns(
  designs: DesignExportData[],
  outW: number,
  outH: number,
  exportDpi: number,
): DesignExportBounds[] {
  return designs.map((design) => {
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
      centerX: bounds.centerX,
      centerY: bounds.centerY,
      pivotX: bounds.pivotX,
      pivotY: bounds.pivotY,
      stampKey: makeStampKey(design, bounds.drawW, bounds.drawH),
    };
  });
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
  sources: Blob[] | undefined,
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

  const shared = d.sourceIndex != null && sources ? sources[d.sourceIndex] : undefined;
  // The deduped shape hands us a Blob directly; the legacy inline shape still
  // arrives as a buffer and has to be wrapped.
  const blob = shared
    ?? (d.imageBuffer ? new Blob([d.imageBuffer], { type: d.mimeType || 'image/png' }) : undefined);
  if (!blob) throw new Error('Export design is missing image data.');

  const resizeQuality: ImageBitmapOptions['resizeQuality'] = d.alphaThresholded ? 'pixelated' : 'high';
  // Crop rects are in EXIF-oriented pixels, and `createImageBitmap` does not
  // reliably orient by default — see the note on `ORIENT_FROM_IMAGE` in
  // `image-editor/utils.ts`. Without this a rotated JPEG prints the wrong slice.
  const orient: ImageBitmapOptions = { imageOrientation: 'from-image' };
  const shouldResize =
    wantW > 0 && wantH > 0 &&
    (!crop || wantW < crop.width || wantH < crop.height);
  const options: ImageBitmapOptions = shouldResize
    ? { ...orient, resizeWidth: wantW, resizeHeight: wantH, resizeQuality }
    : { ...orient };

  let bitmap: ImageBitmap;
  if (crop) {
    bitmap = await createImageBitmap(blob, crop.x, crop.y, crop.width, crop.height, options);
  } else if (shouldResize) {
    // Without a crop rect we only know the source size after a probe decode,
    // so clamp the request to the natural size to avoid upscaling here.
    const probe = await createImageBitmap(blob, orient);
    if (wantW >= probe.width && wantH >= probe.height) {
      cache.set(key, probe);
      return probe;
    }
    bitmap = await createImageBitmap(probe, 0, 0, probe.width, probe.height, options);
    probe.close();
  } else {
    bitmap = await createImageBitmap(blob, orient);
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

/**
 * How much stamp memory this worker may hold.
 *
 * A budget rather than the constant, because a parallel export runs several of
 * these workers at once and the cap has to be shared out between them.
 */
type StampCacheState = { totalBytes: number; maxTotalBytes: number };

// Pre-render a design into an AABB-sized canvas. If the same source + render
// parameters appear again in another copy (typical for duplicated stickers),
// we skip the entire rotate/scale/drawImage/text pipeline and just blit the
// pre-baked stamp with a single drawImage — orders of magnitude cheaper than
// rebuilding each copy from scratch.
async function getOrBuildStamp(
  d: DesignExportData,
  bounds: DesignExportBounds,
  bitmap: ImageBitmap,
  cache: StampCache,
  cacheState: StampCacheState,
): Promise<{ stamp: OffscreenCanvas | null; aabbW: number; aabbH: number }> {
  const aabbW = bounds.width;
  const aabbH = bounds.height;
  const stampBytes = aabbW * aabbH * 4;
  const canCache = stampBytes <= STAMP_CACHE_MAX_BYTES
    && cacheState.totalBytes + stampBytes <= cacheState.maxTotalBytes;

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
  // The pivot lands on an integer pixel, matching the pre-cache path that translated to
  // Math.round(centerX). This guarantees byte-identical output regardless of whether we hit the
  // stamp cache. It is offset by any padding the label needed on the top and left.
  sctx.translate(bounds.pivotX, bounds.pivotY);
  sctx.rotate((d.rotation * Math.PI) / 180);
  sctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
  sctx.drawImage(bitmap, -bounds.drawW / 2, -bounds.drawH / 2, bounds.drawW, bounds.drawH);
  const artH = d.heightInches * d.s;
  if (d.label && artH > 0) {
    // Undo the flip so the name is never printed mirrored. The label's coordinates are defined in
    // this unflipped space, which is the space the nest mask reserved its film in.
    sctx.scale(d.flipX ? -1 : 1, d.flipY ? -1 : 1);
    drawPrintLabel(sctx, d.label, bounds.drawH / artH, labelReadsUpsideDown(d.rotation));
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
  sources: Blob[] | undefined,
  bitmapCache: SourceBitmapCache,
  stampCache: StampCache,
  stampCacheState: StampCacheState,
) {
  const stripBottom = stripY + stripH;
  for (const p of designs) {
    if (p.bottom < stripY || p.top > stripBottom) continue;
    const d = p.design;
    const bitmap = await getSourceBitmap(d, sources, bitmapCache, p.drawW, p.drawH);
    const { stamp } = await getOrBuildStamp(
      d, p, bitmap, stampCache, stampCacheState,
    );
    if (!stamp) {
      // A null stamp means the browser refused a 2d context for the design's
      // pre-render canvas — graphics memory is exhausted. Skipping it would
      // print an incomplete sheet, so abort the export instead.
      throw new Error(
        `Could not render "${d.name || 'a design'}" onto the sheet — the device ran out of ` +
        'graphics memory. Close other apps or tabs and try again, or reduce the sheet size.',
      );
    }

    // The design's pivot lands on the same integer pixel as the pre-cache code path
    // (Math.round of the design's absolute centre), preserving byte-identical output. `stripY` is
    // whole, so subtracting it after rounding is the same as rounding the difference.
    const drawX = Math.round(p.centerX) - p.pivotX;
    const drawY = Math.round(p.centerY) - stripY - p.pivotY;
    ctx.drawImage(stamp, drawX, drawY);
  }
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p >= a ? p - a : a - p;
  const pb = p >= b ? p - b : b - p;
  const pc = p >= c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Distance between scored bytes when choosing a row's filter.
 *
 * Coprime with the 4-byte pixel on purpose, so consecutive samples land on
 * different channels. A multiple of 4 scores red and never looks at alpha,
 * which is where most of the structure in cutout artwork lives: on halftone
 * art a stride of 16 came out 1.2% smaller than scoring everything while 17
 * came out level, but on gradients 16 cost 3% and 17 cost 1%.
 */
const FILTER_SCORE_STRIDE = 17;

/**
 * Pick a PNG row filter (None/Sub/Up/Average/Paeth) and write the filtered row.
 *
 * The five predictors are scored on a sample of the row rather than on every
 * byte, and only the winner is then computed in full. Scoring all five for
 * every byte of a 67 MB strip was two thirds of this worker's non-compression
 * time; sampling measured 2.6-2.9x faster on sheet-sized strips for 0.1-1%
 * more compressed bytes.
 *
 * Sampling cannot change a single output pixel. The filter type is per-row
 * metadata and the decoder reverses whichever one it finds, so a worse guess
 * costs bytes, never fidelity.
 */
function filterRowAdaptive(
  cur: Uint8ClampedArray,
  prev: Uint8Array,
  bpp: number,
  rowBytes: number,
  out: Uint8Array,
  outOff: number,
) {
  let sNone = 0, sSub = 0, sUp = 0, sAvg = 0, sPaeth = 0;
  for (let i = 0; i < rowBytes; i += FILTER_SCORE_STRIDE) {
    const x = cur[i];
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;

    sNone += x < 128 ? x : 256 - x;

    const vs = (x - a) & 0xff; sSub += vs < 128 ? vs : 256 - vs;
    const vu = (x - b) & 0xff; sUp += vu < 128 ? vu : 256 - vu;
    const vg = (x - ((a + b) >> 1)) & 0xff; sAvg += vg < 128 ? vg : 256 - vg;
    const vp = (x - paethPredictor(a, b, c)) & 0xff; sPaeth += vp < 128 ? vp : 256 - vp;
  }

  let best = 0, bestSum = sNone;
  if (sSub < bestSum) { best = 1; bestSum = sSub; }
  if (sUp < bestSum) { best = 2; bestSum = sUp; }
  if (sAvg < bestSum) { best = 3; bestSum = sAvg; }
  if (sPaeth < bestSum) { best = 4; }

  out[outOff] = best;
  const d = outOff + 1;
  switch (best) {
    case 0:
      out.set(cur, d);
      break;
    case 1:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
      }
      break;
    case 2:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - prev[i]) & 0xff;
      }
      break;
    case 3:
      for (let i = 0; i < rowBytes; i++) {
        out[d + i] = (cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
      }
      break;
    default:
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0;
        const c = i >= bpp ? prev[i - bpp] : 0;
        out[d + i] = (cur[i] - paethPredictor(a, prev[i], c)) & 0xff;
      }
      break;
  }
}

/** Anything the filtered rows of a sheet can be poured into. */
interface FilteredRowSink {
  write(bytes: Uint8Array): Promise<void>;
}

async function writeEmptyRows(
  sink: FilteredRowSink,
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
    await sink.write(batch);
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

// The blank-sheet guard message. Thrown when a sheet that contains designs
// encodes to 100% transparent pixels — the browser (typically iOS under
// graphics-memory pressure) silently rendered nothing instead of erroring.
// Without this guard the blank uploads successfully and a customer can order
// an empty print at a perfectly valid production URL.
const BLANK_EXPORT_ERROR =
  'The exported sheet came out blank — the browser rendered no pixels ' +
  '(this usually means the device ran out of memory). Close other apps or ' +
  'tabs and try again, or reduce the sheet size.';

async function writeStripRows(
  sink: FilteredRowSink,
  pixels: Uint8ClampedArray,
  stripH: number,
  filteredRowLen: number,
  rowBytes: number,
  bpp: number,
  prevRow: Uint8Array,
): Promise<boolean> {
  let sawInk = false;
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
        sawInk = true;
        filterRowAdaptive(cur, prevRow, bpp, rowBytes, batch, r * filteredRowLen);
        prevRow.set(cur); // this row is the "up" reference for the next
      }
    }
    await sink.write(batch);
  }
  return sawInk;
}

/**
 * Compresses filtered rows into a finished PNG, one row-order stream at a time.
 *
 * All of a PNG's compressed data has to form a single zlib stream, so there is
 * exactly one of these per sheet no matter how many workers produced the rows
 * feeding it. Wrapping each compressed piece in its own IDAT as it arrives is
 * what makes this streaming — the alternative is to hold the entire compressed
 * image so its length can be written as one chunk header. A PNG may carry any
 * number of IDAT chunks and a decoder concatenates them, so this is the same
 * image either way, about 12 bytes per chunk larger.
 */
class PngSink implements FilteredRowSink {
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly drained: Promise<void>;
  private readonly fileParts: BlobPart[];
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;

  constructor(outW: number, outH: number, exportDpi: number) {
    const cs = new CompressionStream('deflate');
    this.writer = cs.writable.getWriter();
    this.fileParts = [...pngHeaderParts(outW, outH, exportDpi)];
    const reader = cs.readable.getReader();
    this.reader = reader;
    this.drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;
        const chunk = makePngChunk('IDAT', value);
        this.pending.push(chunk);
        this.pendingBytes += chunk.length;
        if (this.pendingBytes >= IDAT_FOLD_BYTES) this.fold();
      }
    })();
  }

  /**
   * Hand bytes to the compressor.
   *
   * Awaiting the write is the backpressure for the whole pipeline: until it
   * resolves, whoever is producing rows has to wait, which is what stops a
   * sheet's worth of filtered rows piling up in memory ahead of the compressor.
   */
  write(bytes: Uint8Array): Promise<void> {
    return this.writer.write(bytes);
  }

  private fold(): void {
    if (this.pending.length === 0) return;
    // Handing bytes to a Blob lets the browser page them out instead of keeping
    // the whole file in this worker's heap.
    this.fileParts.push(new Blob(this.pending));
    this.pending = [];
    this.pendingBytes = 0;
  }

  async finish(): Promise<Blob> {
    await this.writer.close();
    await this.drained;
    this.pending.push(makePngChunk('IEND', new Uint8Array(0)));
    this.fold();
    return new Blob(this.fileParts, { type: 'image/png' });
  }

  /** Tear the stream down so a failed export leaves no dangling state. */
  async abort(reason?: unknown): Promise<void> {
    try { await this.writer.abort(reason); } catch { /* already closed or errored */ }
    try { await this.reader.cancel(); } catch { /* already done */ }
    await this.drained.catch(() => {});
    this.pending = [];
    this.pendingBytes = 0;
    this.fileParts.length = 0;
  }
}

async function buildPngStreaming(input: ExportInput): Promise<Blob> {
  const { designs, sources, outW, outH, exportDpi } = input;
  const designBounds = boundsForDesigns(designs, outW, outH, exportDpi);
  const bitmapCache: SourceBitmapCache = new Map();
  const stampCache: StampCache = new Map();
  const stampCacheState: StampCacheState = {
    totalBytes: 0,
    maxTotalBytes: STAMP_CACHE_TOTAL_MAX_BYTES,
  };
  self.postMessage({
    type: 'progress',
    requestId: input.requestId,
    phase: 'preparing',
    completed: 1,
    total: 1,
  });

  const sink = new PngSink(outW, outH, exportDpi);

  const rowBytes = outW * 4;
  const filteredRowLen = 1 + rowBytes;
  const emptyRow = new Uint8Array(filteredRowLen);

  // Adaptive-filter state, reused across all rows/strips to avoid per-row allocation.
  const bpp = 4; // RGBA, 8-bit
  const prevRow = new Uint8Array(rowBytes); // "up" reference; starts as zeros (transparent)

  let stripCanvas: OffscreenCanvas | null = null;
  let stripCtx: OffscreenCanvasRenderingContext2D | null = null;
  const strips = stripRangesFor(outW, outH);
  const totalStrips = strips.length;
  let completedStrips = 0;
  // Set when any encoded row contains a non-zero byte. Free to compute — the
  // per-row zero scan already runs for the PNG filter fast path.
  let sawInk = false;

  try {
    for (const strip of strips) {
      const stripY = strip.y;
      const stripH = strip.height;

      if (!stripHasContent(designBounds, stripY, stripH)) {
        await writeEmptyRows(sink, outW, stripH, emptyRow, filteredRowLen);
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
      if (await writeStripRows(sink, imageData.data, stripH, filteredRowLen, rowBytes, bpp, prevRow)) {
        sawInk = true;
      }
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

    // A sheet that contains designs must have produced at least one
    // non-transparent row. All-zero output means every draw silently failed
    // (iOS graphics-memory exhaustion) or every design landed outside the
    // sheet — fail loudly instead of uploading a blank production file.
    if (designs.length > 0 && !sawInk) {
      throw new Error(BLANK_EXPORT_ERROR);
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

    return await sink.finish();
  } catch (err) {
    // The encode failed mid-stream (blank sheet, a design that could not be
    // rendered, or memory exhaustion). Tear the compression pipeline down so
    // the worker holds no dangling stream state or pixel caches, then rethrow
    // for the caller's error path.
    await sink.abort(err);
    if (stripCanvas) {
      stripCanvas.width = 0;
      stripCanvas.height = 0;
    }
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
    throw err;
  }
}

/**
 * One horizontal band of a sheet, rendered and filtered but not compressed.
 *
 * This is the render half of what `buildPngStreaming` does per strip, packaged
 * so several workers can each take a band while a single compressor consumes
 * them in order. Compression stays in one place because a PNG's data must be
 * one zlib stream, and because the browser's native compressor turned out to be
 * about 3.7x faster than any JavaScript one we could run per band — splitting it
 * up would have meant giving that up to win back less.
 *
 * The filtered bytes are byte-for-byte what the serial path would have produced
 * for the same rows, which is why the context row exists: a row's filter may
 * predict from the row above it, and for the first row of a band that row was
 * rendered by a different worker. Rather than forbid those filters, the band
 * renders one extra row above itself and throws it away after filtering.
 */
interface BandInput {
  type: 'band';
  requestId: number;
  index: number;
  stripY: number;
  stripH: number;
  designs: DesignExportData[];
  sources?: Blob[];
  outW: number;
  outH: number;
  exportDpi: number;
  /** This worker's share of the tab-wide stamp cache budget. */
  stampCacheBudgetBytes: number;
}

type BandSession = {
  requestId: number;
  bounds: DesignExportBounds[];
  bitmapCache: SourceBitmapCache;
  stampCache: StampCache;
  stampCacheState: StampCacheState;
  canvas: OffscreenCanvas | null;
  ctx: OffscreenCanvasRenderingContext2D | null;
};

let bandSession: BandSession | null = null;

function releaseBandSession(): void {
  const session = bandSession;
  bandSession = null;
  if (!session) return;
  for (const bitmap of session.bitmapCache.values()) {
    try { bitmap.close(); } catch { /* already closed */ }
  }
  session.bitmapCache.clear();
  for (const stamp of session.stampCache.values()) {
    stamp.width = 0;
    stamp.height = 0;
  }
  session.stampCache.clear();
  if (session.canvas) {
    session.canvas.width = 0;
    session.canvas.height = 0;
  }
}

function bandSessionFor(input: BandInput): BandSession {
  if (bandSession && bandSession.requestId === input.requestId) return bandSession;
  // A different export means the cached bitmaps and stamps describe artwork
  // nobody is asking for any more.
  releaseBandSession();
  bandSession = {
    requestId: input.requestId,
    bounds: boundsForDesigns(input.designs, input.outW, input.outH, input.exportDpi),
    bitmapCache: new Map(),
    stampCache: new Map(),
    stampCacheState: { totalBytes: 0, maxTotalBytes: input.stampCacheBudgetBytes },
    canvas: null,
    ctx: null,
  };
  return bandSession;
}

/**
 * Filter `rowCount` rows starting at `firstRow`, using the row before it as the
 * "up" reference when there is one.
 *
 * Mirrors `writeStripRows` row for row, including its treatment of fully
 * transparent rows and its report of whether any ink was seen, so that a band
 * and a serial strip covering the same rows produce the same bytes.
 */
function filterBandToBuffer(
  pixels: Uint8ClampedArray,
  firstRow: number,
  rowCount: number,
  rowBytes: number,
  bpp: number,
): { filtered: Uint8Array; sawInk: boolean } {
  const filteredRowLen = 1 + rowBytes;
  // Zero-filled, which is already the correct encoding for a transparent row:
  // filter type 0 followed by zero bytes.
  const filtered = new Uint8Array(rowCount * filteredRowLen);
  // Starts as zeros, matching the serial writer's state at the top of a sheet.
  // For a band that rendered a context row, the row above is copied in first.
  const prevRow = new Uint8Array(rowBytes);
  if (firstRow > 0) {
    const aboveStart = (firstRow - 1) * rowBytes;
    if (!isRowAllZero(pixels, aboveStart, rowBytes)) {
      prevRow.set(pixels.subarray(aboveStart, aboveStart + rowBytes));
    }
  }
  let sawInk = false;
  for (let r = 0; r < rowCount; r++) {
    const rowStart = (firstRow + r) * rowBytes;
    if (isRowAllZero(pixels, rowStart, rowBytes)) {
      prevRow.fill(0);
      continue;
    }
    sawInk = true;
    const cur = pixels.subarray(rowStart, rowStart + rowBytes);
    filterRowAdaptive(cur, prevRow, bpp, rowBytes, filtered, r * filteredRowLen);
    prevRow.set(cur);
  }
  return { filtered, sawInk };
}

async function buildBand(input: BandInput): Promise<{ filtered: Uint8Array; sawInk: boolean }> {
  const { outW, stripY, stripH, exportDpi, sources } = input;
  const session = bandSessionFor(input);
  const rowBytes = outW * 4;
  const bpp = 4;

  if (!stripHasContent(session.bounds, stripY, stripH)) {
    // Nothing lands here, so there is no reason to hold a canvas: an empty
    // band's filtered form is a block of zeroes. The row above cannot change
    // that — every filter predicts 0 from a transparent row.
    return { filtered: new Uint8Array(stripH * (1 + rowBytes)), sawInk: false };
  }

  // Render one row above the band, when there is one, purely so the first real
  // row can be filtered against it exactly as the serial path would.
  const contextRow = stripY > 0 ? 1 : 0;
  const renderY = stripY - contextRow;
  const renderH = stripH + contextRow;

  if (!session.canvas || session.canvas.width !== outW || session.canvas.height !== renderH) {
    session.canvas = new OffscreenCanvas(outW, renderH);
    session.ctx = session.canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!session.ctx) throw new Error('Failed to get strip canvas context');
  }
  const ctx = session.ctx!;
  ctx.clearRect(0, 0, outW, renderH);
  await drawDesignsOnStrip(
    ctx, session.bounds, renderY, renderH, exportDpi,
    sources, session.bitmapCache, session.stampCache, session.stampCacheState,
  );
  const imageData = ctx.getImageData(0, 0, outW, renderH);
  return filterBandToBuffer(imageData.data, contextRow, stripH, rowBytes, bpp);
}

/**
 * The sheet being assembled by this worker acting as the compressor for a
 * parallel export. One at a time: it owns the single zlib stream.
 */
let encodeSession: { requestId: number; sink: PngSink } | null = null;

async function releaseEncodeSession(): Promise<void> {
  const session = encodeSession;
  encodeSession = null;
  if (session) await session.sink.abort();
}

async function runExportLegacy(input: ExportInput): Promise<Blob> {
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
    const legacyArtH = design.heightInches * design.s;
    if (design.label && legacyArtH > 0) {
      ctx.scale(design.flipX ? -1 : 1, design.flipY ? -1 : 1);
      drawPrintLabel(ctx, design.label, drawH / legacyArtH, labelReadsUpsideDown(design.rotation));
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

  // iOS silently returns a transparent canvas when the allocation exceeds the
  // tab's graphics-memory budget — drawImage never throws. Scan the alpha
  // channel at native resolution in horizontal bands (early exit on the first
  // opaque pixel) so even a single tiny design counts as ink; a downsampled
  // probe could average sparse artwork below one alpha step and false-flag it.
  if (designs.length > 0) {
    const bandRows = Math.max(1, Math.floor(4_000_000 / outW));
    let ink = false;
    for (let y = 0; y < outH && !ink; y += bandRows) {
      const h = Math.min(bandRows, outH - y);
      const alpha = ctx.getImageData(0, y, outW, h).data;
      for (let i = 3; i < alpha.length; i += 4) {
        if (alpha[i] !== 0) { ink = true; break; }
      }
    }
    if (!ink) throw new Error(BLANK_EXPORT_ERROR);
  }

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
  return new Blob(parts, { type: 'image/png' });
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
  const partSize = Number(meta.partSize) || 8 * 1024 * 1024;
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
  if (e.data.type === 'band') {
    const input = e.data as BandInput;
    try {
      const { filtered, sawInk } = await buildBand(input);
      self.postMessage(
        { type: 'band-result', requestId: input.requestId, index: input.index, filtered, sawInk },
        [filtered.buffer],
      );
    } catch (err: any) {
      // The caches describe a sheet this worker is no longer going to finish.
      releaseBandSession();
      self.postMessage({
        type: 'error',
        requestId: input.requestId,
        index: input.index,
        error: err?.message || 'Export failed',
      });
    }
    return;
  }
  if (e.data.type === 'encode-begin') {
    await releaseEncodeSession();
    encodeSession = {
      requestId: e.data.requestId,
      sink: new PngSink(e.data.outW, e.data.outH, e.data.exportDpi),
    };
    self.postMessage({ type: 'encode-ready', requestId: e.data.requestId });
    return;
  }
  if (e.data.type === 'encode-band') {
    const { requestId, index } = e.data;
    try {
      const session = encodeSession;
      if (!session || session.requestId !== requestId) {
        throw new Error('Sheet bands arrived without an open encoder.');
      }
      // Acknowledged only once the compressor has taken the bytes, which is how
      // the coordinator learns it may render further ahead.
      await session.sink.write(e.data.filtered as Uint8Array);
      self.postMessage({ type: 'encode-ack', requestId, index });
    } catch (err: any) {
      await releaseEncodeSession();
      self.postMessage({
        type: 'error',
        requestId,
        index,
        error: err?.message || 'Compressing the sheet failed',
      });
    }
    return;
  }
  if (e.data.type === 'encode-finish') {
    const { requestId } = e.data;
    try {
      const session = encodeSession;
      if (!session || session.requestId !== requestId) {
        throw new Error('The sheet encoder closed before it was finished.');
      }
      encodeSession = null;
      const blob = await session.sink.finish();
      if (blob.size === 0) throw new Error('Export produced an empty image.');
      self.postMessage({ type: 'result', requestId, blob, byteLength: blob.size });
    } catch (err: any) {
      await releaseEncodeSession();
      self.postMessage({ type: 'error', requestId, error: err?.message || 'Export failed' });
    }
    return;
  }
  if (e.data.type === 'export') {
    const designs = e.data.designs as ExportInput['designs'] | undefined;
    try {
      const blob = hasStreaming
        ? await buildPngStreaming(e.data)
        : await runExportLegacy(e.data);
      // Posted as a Blob, with no transfer list — Blobs are not transferable,
      // and they do not need to be. The main thread receives a reference to the
      // same browser-managed storage instead of copying the whole sheet into its
      // own heap the way a transferred ArrayBuffer forced it to.
      self.postMessage({ type: 'result', requestId: e.data.requestId, blob, byteLength: blob.size });
    } catch (err: any) {
      self.postMessage({ type: 'error', requestId: e.data.requestId, error: err?.message || 'Export failed' });
    }
  }
};
