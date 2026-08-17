/**
 * Turns a design into the ink silhouette the nester packs with.
 *
 * The mask covers the design's whole footprint — artwork plus, when the filename is set to
 * print, the label's opaque box — at the nester's grid resolution. Anything the printer will
 * put on film has to be ink here, because the packer's only guarantee is that ink is spaced
 * and on-sheet; a feature missing from the mask is a feature another design is free to sit on
 * top of.
 *
 * This is also where the label's placement is decided, because deciding it needs the artwork's
 * ink and nothing else does. A design with an empty bottom-right corner gets its label tucked
 * in there for free; anything solid pays for a band underneath. The answer travels out on the
 * result so the preview and the export draw the label exactly where the film was reserved.
 *
 * Masks are cached per source image and footprint size. The cache key includes the image
 * URL, which changes whenever a pixel edit produces a new blob, so an edited design cannot
 * keep nesting against its pre-edit silhouette.
 */

import { NEST_ALPHA_THRESHOLD, NEST_CELL_INCHES, type NestMask } from './nest-core';
import {
  canvasLabelMeasure,
  layoutPrintLabel,
  type LabelRect,
  type PrintLabelLayout,
} from './print-label';

export interface DesignMaskRequest {
  image: HTMLImageElement | ImageBitmap;
  /** Artwork footprint in inches at its current scale, excluding any label band. */
  artW: number;
  artH: number;
  /**
   * File name to print on the design, or undefined when the label is off. The band it needs is
   * worked out here rather than passed in: only this function knows where the ink is, and
   * whether the label can tuck into the artwork instead of costing extra film depends on that.
   */
  labelName?: string;
  flipX?: boolean;
  flipY?: boolean;
  /** Stable identity for the pixels — normally the image URL. */
  sourceKey: string;
}

export interface DesignMask {
  mask: NestMask;
  /** Share of the footprint covered by ink, 0..1. */
  inkRatio: number;
  /**
   * Where the label went, for everything downstream that has to agree with the space reserved
   * here — the preview, the export worker, overlap detection. Null when there is no label.
   */
  label: PrintLabelLayout | null;
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
 * Cell range covering a rectangle given in the label's coordinates — inches from the artwork's
 * centre, y down.
 *
 * Rounded outwards on every edge. A cell the rectangle only clips still counts, for the same
 * reason the artwork is supersampled: a mask that under-reports by half a cell is an invitation
 * for the packer to seat a neighbour in the gap.
 */
function cellRange(rect: LabelRect, artW: number, artH: number, cols: number, rows: number) {
  const toCol = (inches: number) => (inches + artW / 2) / NEST_CELL_INCHES;
  const toRow = (inches: number) => (inches + artH / 2) / NEST_CELL_INCHES;
  return {
    col0: Math.max(0, Math.floor(toCol(rect.x))),
    col1: Math.min(cols, Math.ceil(toCol(rect.x + rect.width))),
    row0: Math.max(0, Math.floor(toRow(rect.y))),
    row1: Math.min(rows, Math.ceil(toRow(rect.y + rect.height))),
  };
}

/**
 * Reserves the label's rows across the full width of the design.
 *
 * The box is opaque white, so as far as the film is concerned it is as solid as artwork — a
 * neighbour packed underneath it would be erased.
 *
 * This used to mark only the box, which let a wide design with a short name keep the film
 * either side of its label. That saving is what made renaming dangerous. The box is
 * right-aligned and only as wide as the text, so a short name left a pocket of free cells
 * beside it, the nester quite legitimately seated a neighbour there, and then editing the
 * name to something longer widened the box straight over the top of it — the design was
 * never re-packed, because nothing about renaming looked like a layout change.
 *
 * Reserving the whole row instead makes the footprint a function of the design's width and
 * the label's row count, neither of which the text length can move. Renaming inside the same
 * number of rows is now free: the reservation is byte-identical, so no arrangement that was
 * valid before the rename can be invalid after it. The cost is the film beside a short
 * label, which is the price of the guarantee.
 */
function markLabel(
  bits: Uint8Array,
  cols: number,
  rows: number,
  artW: number,
  artH: number,
  label: PrintLabelLayout,
): void {
  const { row0, row1 } = cellRange(label.rect, artW, artH, cols, rows);
  for (let r = row0; r < row1; r++) {
    bits.fill(1, r * cols, r * cols + cols);
  }
}

/**
 * Builds (or returns a cached) silhouette for a design. Returns null when the image is not
 * decodable yet or no canvas is available, in which case callers should fall back to
 * bounding-box packing rather than guess.
 */
export function getDesignNestMask(request: DesignMaskRequest): DesignMask | null {
  const { image, artW, artH } = request;
  if (!(artW > 0) || !(artH > 0)) return null;

  const cols = cellsFor(artW);
  const artRows = cellsFor(artH);
  // Rotation is deliberately absent: it turns the whole footprint, label included, so it cannot
  // change the mask. The one thing it does affect — whether the text reads upside down — is
  // asked separately at draw time.
  const key = [
    request.sourceKey,
    cols, artRows,
    request.flipX ? 1 : 0,
    request.flipY ? 1 : 0,
    request.labelName ?? '',
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

  const artBits = new Uint8Array(cols * artRows);
  try {
    const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
    for (let sy = 0; sy < sampleH; sy++) {
      const rowBase = ((sy / ss) | 0) * cols;
      let p = sy * sampleW * 4 + 3;
      for (let sx = 0; sx < sampleW; sx++, p += 4) {
        if (data[p] > NEST_ALPHA_THRESHOLD) artBits[rowBase + ((sx / ss) | 0)] = 1;
      }
    }
  } catch {
    return null;
  }

  // The artwork's ink is known now, so the label can be offered the corner. Everything in this
  // mask is in the same space the design is displayed and printed in — the flips were applied
  // when the artwork was drawn above — so the label's coordinates need no further mapping.
  const label = request.labelName
    ? layoutPrintLabel(
        {
          name: request.labelName,
          artWidthInches: artW,
          artHeightInches: artH,
          isClearOfInk: (rect) => {
            const { col0, col1, row0, row1 } = cellRange(rect, artW, artH, cols, artRows);
            for (let r = row0; r < row1; r++) {
              const base = r * cols;
              for (let c = col0; c < col1; c++) if (artBits[base + c]) return false;
            }
            return true;
          },
        },
        canvasLabelMeasure(ctx),
      )
    : null;

  const totalRows = cellsFor(artH + (label?.bandInches ?? 0));
  let bits = artBits;
  if (totalRows > artRows) {
    bits = new Uint8Array(cols * totalRows);
    bits.set(artBits);
  }
  if (label) markLabel(bits, cols, totalRows, artW, artH, label);

  let ink = 0;
  for (let i = 0; i < bits.length; i++) if (bits[i]) ink++;

  const result: DesignMask = {
    mask: { cols, rows: totalRows, bits },
    inkRatio: ink / (cols * totalRows),
    label,
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
