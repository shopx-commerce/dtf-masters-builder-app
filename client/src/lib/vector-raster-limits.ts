/**
 * Platform limits for rasterising vector artwork, and the print DPI those
 * limits actually permit.
 *
 * SVG and PDF uploads are treated as 300 DPI PNGs, matching raster uploads
 * (`RASTER_DPI_FALLBACK`). That is achievable because the export path
 * re-rasterises vectors from their retained geometry at the placement size, so
 * the import preview being smaller costs nothing at print time.
 *
 * The one real constraint is the canvas the raster has to land on. Above the
 * platform ceiling a canvas does not fail loudly — iOS Safari silently no-ops
 * `drawImage` and returns a blank bitmap — so `vectorPrintDpi` reports the DPI
 * the export can genuinely deliver rather than assuming 300. On desktop that is
 * a true 300 DPI for anything up to ~27 inches, which covers every gangsheet
 * width we sell; only unusually large placements on mobile fall short, and
 * those are reported honestly instead of being overstated to the customer.
 */

import { IOS_SAFE_CANVAS_DIM } from "./image-budget";
import { isMobileDevice } from "./upload-queue";

/** Print DPI vector artwork targets, matching `RASTER_DPI_FALLBACK`. */
export const VECTOR_TARGET_DPI = 300;

/**
 * Desktop canvas ceiling. Chromium caps a single canvas edge at 16384 and
 * Firefox higher still; 8192 sits comfortably inside both while covering a
 * 27 inch design at 300 DPI.
 */
const DESKTOP_VECTOR_MAX_EDGE = 8192;

export function vectorExportMaxEdge(): number {
  return isMobileDevice() ? IOS_SAFE_CANVAS_DIM : DESKTOP_VECTOR_MAX_EDGE;
}

/**
 * The DPI a vector design of this physical size will actually be printed at:
 * 300, unless its longest edge at 300 DPI would exceed the platform's canvas
 * ceiling.
 */
export function vectorPrintDpi(widthInches: number, heightInches: number): number {
  const longestInches = Math.max(widthInches, heightInches);
  if (!(longestInches > 0)) return VECTOR_TARGET_DPI;
  const dpiAtCeiling = vectorExportMaxEdge() / longestInches;
  return Math.max(1, Math.round(Math.min(VECTOR_TARGET_DPI, dpiAtCeiling)));
}

/**
 * Wall-clock budget for rasterising an SVG at import preview size.
 *
 * Measured on the heaviest legitimate artwork available: 400 copies of an
 * 800-path logo took 4.3 s and a 60,000-path flat illustration 2.6 s, both at
 * 2400 x 2400. 20 s leaves ~4.5x headroom for a slower machine while still
 * bounding the wait. Only enforceable when rasterisation runs in the isolated
 * frame — see `svg-raster`.
 */
export const SVG_RASTER_TIMEOUT_MS = 20_000;

/**
 * Same budget for the export re-rasterise, which runs at up to 80 MP.
 *
 * Legitimate artwork at 8944 x 8944 measured 1.0-1.4 s, but a filter chain over
 * that area reached 38 s, and export is the worse place to be stuck: a customer
 * who cannot complete checkout is a lost order. Larger than the import budget
 * because the canvas is ~14x the pixels, small enough that the failure is
 * reported rather than waited out.
 */
export const SVG_EXPORT_RASTER_TIMEOUT_MS = 45_000;
