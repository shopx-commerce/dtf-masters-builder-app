/**
 * Turns a design into the ink silhouette the nester packs with.
 *
 * The mask covers the design's whole footprint — artwork plus, when the filename is set to
 * print, the band of text underneath it — at the nester's grid resolution. Anything the
 * printer will put on film has to be ink here, because the packer's only guarantee is that
 * ink is spaced and on-sheet; a feature missing from the mask is a feature another design
 * is free to sit on top of.
 *
 * Masks are cached per source image and footprint size. The cache key includes the image
 * URL, which changes whenever a pixel edit produces a new blob, so an edited design cannot
 * keep nesting against its pre-edit silhouette.
 */

import { NEST_ALPHA_THRESHOLD, NEST_CELL_INCHES, type NestMask } from './nest-core';

export interface DesignMaskRequest {
  image: HTMLImageElement | ImageBitmap;
  /** Artwork footprint in inches at its current scale, excluding the stamp band. */
  artW: number;
  artH: number;
  /** Height of the printed-filename band below the artwork, in inches. 0 when disabled. */
  stampExtra: number;
  /** Filename as printed, so the band reserves only the width the text needs. */
  stampText?: string;
  flipX?: boolean;
  flipY?: boolean;
  /** Stable identity for the pixels — normally the image URL. */
  sourceKey: string;
}

export interface DesignMask {
  mask: NestMask;
  /** Share of the footprint covered by ink, 0..1. */
  inkRatio: number;
}

/**
 * Rounded the same way `nest-core` rounds, so a mask always lines up cell-for-cell with the
 * footprint the packer reserves for it.
 */
function cellsFor(inches: number): number {
  return Math.max(1, Math.ceil(inches / NEST_CELL_INCHES - 1e-6));
}

const CACHE_MAX = 240;
const cache = new Map<string, DesignMask>();

/**
 * Cells are 0.05" across, so drawing the artwork at one pixel per cell asks the browser
 * whether the cell's *centre* is inked. A cell the shape only clips the corner of comes back
 * transparent, which shaves a sliver off every diagonal and curved edge and lets the packer
 * seat a neighbour inside the gap. Rendering several samples per cell and taking their union
 * means partial coverage still counts, so the silhouette covers the ink rather than
 * approximating it.
 *
 * The alpha threshold is still applied per sample, so a design with a faint full-bleed halo
 * does not become a solid rectangle.
 */
const SUPERSAMPLE = 3;

/** Keeps the scratch buffer to a few megapixels on billboard-sized artwork. */
const MAX_SAMPLE_PIXELS = 4_000_000;

function supersampleFor(cols: number, rows: number): number {
  const area = cols * rows;
  for (let ss = SUPERSAMPLE; ss > 1; ss--) {
    if (area * ss * ss <= MAX_SAMPLE_PIXELS) return ss;
  }
  return 1;
}

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function getScratch(cols: number, rows: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    if (typeof document === 'undefined') return null;
    scratch = document.createElement('canvas');
    scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
  }
  if (!scratchCtx) return null;
  if (scratch.width !== cols || scratch.height !== rows) {
    scratch.width = cols;
    scratch.height = rows;
  }
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.clearRect(0, 0, cols, rows);
  return scratchCtx;
}

/**
 * Adds the printed-filename band. The export draws the name right-aligned to the artwork's
 * right edge, one tenth of an inch below it, at 4.5% of the artwork height — so the band is
 * measured here with the same font rather than assumed to span the full width, which on a
 * wide design with a short name would throw away inches of usable film.
 */
function markStampBand(
  bits: Uint8Array,
  cols: number,
  artRows: number,
  totalRows: number,
  request: DesignMaskRequest,
): void {
  const { stampExtra, stampText, artH } = request;
  if (stampExtra <= 0 || !stampText) return;

  const marginRows = Math.round(0.1 / NEST_CELL_INCHES);
  const top = Math.min(totalRows - 1, artRows + marginRows);
  if (top >= totalRows) return;

  const fontInches = artH * 0.045;
  let textCols = cols;
  const ctx = scratchCtx;
  if (ctx && fontInches > 0) {
    const probePx = 100;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `bold ${probePx}px sans-serif`;
    const displayName = stampText.replace(/\.[^/.]+$/, '');
    const widthInches = (ctx.measureText(displayName).width / probePx) * fontInches;
    ctx.restore();
    textCols = Math.min(cols, Math.max(1, Math.ceil(widthInches / NEST_CELL_INCHES)));
  }

  // Right-aligned, unless the name is wider than the design, in which case it is clamped
  // to the footprint rather than allowed to reserve space the footprint does not own.
  const startCol = request.flipX ? 0 : Math.max(0, cols - textCols);
  const endCol = Math.min(cols, startCol + textCols);
  for (let r = top; r < totalRows; r++) {
    bits.fill(1, r * cols + startCol, r * cols + endCol);
  }
}

/**
 * Builds (or returns a cached) silhouette for a design. Returns null when the image is not
 * decodable yet or no canvas is available, in which case callers should fall back to
 * bounding-box packing rather than guess.
 */
export function getDesignNestMask(request: DesignMaskRequest): DesignMask | null {
  const { image, artW, artH, stampExtra } = request;
  if (!(artW > 0) || !(artH > 0)) return null;

  const cols = cellsFor(artW);
  const artRows = cellsFor(artH);
  const totalRows = cellsFor(artH + stampExtra);
  const key = [
    request.sourceKey,
    cols, artRows, totalRows,
    request.flipX ? 1 : 0,
    request.flipY ? 1 : 0,
    stampExtra > 0 ? (request.stampText ?? '') : '',
  ].join('|');

  const hit = cache.get(key);
  if (hit) {
    // Refresh recency so the designs currently on the sheet are the ones that survive.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const naturalW = 'naturalWidth' in image ? (image.naturalWidth || image.width) : image.width;
  const naturalH = 'naturalHeight' in image ? (image.naturalHeight || image.height) : image.height;
  if (!naturalW || !naturalH) return null;

  const ss = supersampleFor(cols, artRows);
  const sampleW = cols * ss;
  const sampleH = artRows * ss;
  const ctx = getScratch(sampleW, sampleH);
  if (!ctx) return null;

  try {
    ctx.save();
    ctx.translate(request.flipX ? sampleW : 0, request.flipY ? sampleH : 0);
    ctx.scale(request.flipX ? -1 : 1, request.flipY ? -1 : 1);
    ctx.drawImage(image as CanvasImageSource, 0, 0, sampleW, sampleH);
    ctx.restore();
  } catch {
    // Tainted canvas or an undecoded image. Bounding-box packing is the safe fallback.
    return null;
  }

  const bits = new Uint8Array(cols * totalRows);
  try {
    const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
    for (let sy = 0; sy < sampleH; sy++) {
      const rowBase = ((sy / ss) | 0) * cols;
      let p = sy * sampleW * 4 + 3;
      for (let sx = 0; sx < sampleW; sx++, p += 4) {
        if (data[p] > NEST_ALPHA_THRESHOLD) bits[rowBase + ((sx / ss) | 0)] = 1;
      }
    }
  } catch {
    return null;
  }

  let ink = 0;
  for (let i = 0; i < artRows * cols; i++) if (bits[i]) ink++;

  markStampBand(bits, cols, artRows, totalRows, request);
  for (let i = artRows * cols; i < bits.length; i++) if (bits[i]) ink++;

  const result: DesignMask = {
    mask: { cols, rows: totalRows, bits },
    inkRatio: ink / (cols * totalRows),
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, result);
  return result;
}

/** Drops every cached mask. Used when the editor is reset. */
export function clearDesignNestMaskCache(): void {
  cache.clear();
}
