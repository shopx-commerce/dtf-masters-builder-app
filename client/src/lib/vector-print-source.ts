/**
 * Print sources for vector uploads (SVG and PDF).
 *
 * Why this exists
 * ---------------
 * Vector artwork has no native pixel size, so both parsers rasterise once at
 * import to get something the editor can display, clamped to a screen-safe
 * ceiling (`IOS_SAFE_CANVAS_DIM`). That preview then used to be the *print*
 * source as well, which quietly capped output resolution: a 20 × 20 in design
 * landed at 4096 px, or 205 DPI, when the geometry could have produced 6000 px
 * at a true 300 DPI. Raster uploads had already been moved off this pattern —
 * they decode their original file at the placement size — but vectors kept
 * printing from the preview even though both parsers retained their source for
 * exactly this purpose.
 *
 * So at export time we go back to the source and rasterise again, once, at the
 * size the design is actually placed at. Nothing is ever upscaled: the raster
 * is generated at print resolution and the export path resizes it down to the
 * exact placement box if it overshoots.
 *
 * Ceilings
 * --------
 * Rasterisation still has to land on a real canvas; see `vector-raster-limits`
 * for why that ceiling is platform-dependent and how it feeds the DPI reported
 * to the customer. The megapixel cap below is the memory backstop for extreme
 * aspect ratios, where an edge limit alone would still allow a very large
 * bitmap.
 */

import { fitWithinMegapixels } from "./image-budget";
import { vectorExportMaxEdge, SVG_EXPORT_RASTER_TIMEOUT_MS } from "./vector-raster-limits";
import { rasteriseSvgToPngBlob } from "./svg-parser";
import { SvgRasterTimeoutError } from "./svg-raster";
import { rasterisePdfPageToPngBlob } from "./pdf-parser";
import { cropPngBlobToInkBox } from "./vector-trim";
import type { ImageInfo } from "./types";

export { vectorExportMaxEdge };

/** Memory backstop for long, thin artwork that an edge cap alone would miss. */
const VECTOR_EXPORT_MAX_MEGAPIXELS = 80;

/** True when this upload kept geometry we can re-rasterise at any size. */
export function hasVectorPrintSource(info: ImageInfo): boolean {
  if (info.svgSource) return true;
  // A detached buffer reports zero length; treat it as absent rather than
  // handing pdf.js something it will reject mid-export.
  return !!info.originalPdfData && info.originalPdfData.byteLength > 0;
}

async function rasteriseAtSize(
  info: ImageInfo,
  targetW: number,
  targetH: number,
): Promise<Blob | null> {
  const maxEdge = vectorExportMaxEdge();
  // The source renders whole pages. When the import was trimmed to its artwork,
  // the target describes the artwork, so the page has to be rendered
  // proportionally larger for the artwork within it to come out at the target.
  const box = info.vectorInkBox;
  const pageW = box ? targetW / box.w : targetW;
  const pageH = box ? targetH / box.h : targetH;
  const scale = Math.min(
    1,
    maxEdge / Math.max(pageW, pageH, 1),
    fitWithinMegapixels(pageW, pageH, VECTOR_EXPORT_MAX_MEGAPIXELS),
  );
  const w = Math.max(1, Math.round(pageW * scale));
  const h = Math.max(1, Math.round(pageH * scale));

  let page: Blob | null = null;
  if (info.svgSource) {
    // Export is the dangerous size, not import. A file that previews in 2.4 s at
    // 2400 px measured a 20 s main-thread block at this 80 MP ceiling, and a
    // filter chain over the same area reached 38 s — a frozen checkout, which
    // costs the order rather than just the upload. Same isolated-frame path and
    // the same real timeout as import, with a budget scaled to the pixel count.
    page = await rasteriseSvgToPngBlob(info.svgSource, w, h, {
      timeoutMs: SVG_EXPORT_RASTER_TIMEOUT_MS,
    });
  } else if (info.originalPdfData && info.originalPdfData.byteLength > 0) {
    page = await rasterisePdfPageToPngBlob(info.originalPdfData, w, h, maxEdge);
  }
  if (!page || !box) return page;

  // A failed crop would print the whole page in the artwork's box, so fall back
  // to the import preview instead of shipping misplaced artwork.
  return await cropPngBlobToInkBox(page, box);
}

/** One design whose print-resolution re-render failed, so it prints from the preview. */
export interface VectorPrintSourceShortfall {
  /** True when the re-render was abandoned on the wall-clock budget. */
  timedOut: boolean;
  /** Pixel size that was being attempted. */
  targetW: number;
  targetH: number;
  /** Pixels the import preview actually carries, which is what will print. */
  fallbackW: number;
  fallbackH: number;
  /**
   * True when the fallback cannot cover the target, so the customer really
   * does receive a softer print.
   *
   * A failed re-render is not automatically a quality loss. The import preview
   * is clamped to `IOS_SAFE_CANVAS_DIM` (4096 px), which is still 300 DPI for
   * anything placed up to about 13.6 inches — and most designs on a gangsheet
   * are far smaller than that. Warning on every failure would put a "your print
   * will be soft" message in front of customers whose print is not soft, which
   * is the fastest way to have the warning ignored when it matters.
   */
  material: boolean;
  reason: string;
}

/**
 * Shortfalls worth telling the customer about — see `material`.
 *
 * Shared by the export, cart and edit paths so one definition of "real" is
 * applied everywhere rather than three.
 */
export function materialShortfalls(
  resolver: VectorPrintSourceResolver,
): VectorPrintSourceShortfall[] {
  return resolver.shortfalls().filter((s) => s.material);
}

export interface VectorPrintSourceResolver {
  /**
   * Placement-size raster for a vector design, or `undefined` when the design
   * is not vector-backed (or rasterising failed, in which case the caller
   * should fall back to the retained preview rather than drop the design).
   */
  resolve(info: ImageInfo, targetW: number, targetH: number): Promise<Blob | undefined>;
  /**
   * Designs that fell back to the import preview during this export.
   *
   * A failed re-render used to be a `console.error` and a `null`, and the
   * customer was told nothing: the sheet still exports, just at the preview's
   * resolution instead of print resolution. That shortfall does *not* reach them
   * through the draft-recovery "reduced quality" count, which is computed in
   * `editor-draft-storage` from what a restored design's pixels are and never
   * runs on a normal export.
   *
   * Every failure is recorded here for diagnostics. Callers warning a customer
   * should go through `materialShortfalls`, which drops the ones where the
   * preview covers the placement anyway.
   */
  shortfalls(): VectorPrintSourceShortfall[];
}

/**
 * Per-export resolver with caching, since a sheet routinely holds many copies
 * of one design. Keyed by source identity *and* target size: two copies at
 * different scales legitimately need different rasters, but twenty copies at
 * the same scale should rasterise once.
 */
export function createVectorPrintSourceResolver(): VectorPrintSourceResolver {
  const bySource = new WeakMap<ImageInfo, Map<string, Promise<Blob | null>>>();
  const shortfalls: VectorPrintSourceShortfall[] = [];

  return {
    async resolve(info, targetW, targetH) {
      if (!hasVectorPrintSource(info)) return undefined;
      let bySize = bySource.get(info);
      if (!bySize) {
        bySize = new Map();
        bySource.set(info, bySize);
      }
      const key = `${targetW}x${targetH}`;
      let pending = bySize.get(key);
      if (!pending) {
        pending = rasteriseAtSize(info, targetW, targetH).catch((err) => {
          // A failed re-render must not fail the whole export. Falling back to
          // the import preview costs resolution, which is what shipped before —
          // but it is recorded so the caller can say so out loud instead of
          // shipping a quietly softer sheet.
          const timedOut = err instanceof SvgRasterTimeoutError;
          // What the caller will actually draw instead: the import preview,
          // whose pixel count is on the `ImageInfo`. Only a fallback smaller
          // than the target loses the customer anything.
          const fallbackW = info.originalWidth || 0;
          const fallbackH = info.originalHeight || 0;
          shortfalls.push({
            timedOut,
            targetW,
            targetH,
            fallbackW,
            fallbackH,
            material: fallbackW < targetW || fallbackH < targetH,
            reason: err instanceof Error ? err.message : String(err),
          });
          console.error(
            `[vector-print-source] re-rasterise failed at ${targetW}x${targetH}; ` +
              "printing from the import preview instead:",
            err instanceof Error ? err.message : err,
          );
          return null;
        });
        bySize.set(key, pending);
      }
      return (await pending) ?? undefined;
    },
    shortfalls() {
      return shortfalls.slice();
    },
  };
}
