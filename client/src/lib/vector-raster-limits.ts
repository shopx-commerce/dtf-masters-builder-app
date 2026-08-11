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

/**
 * Detect a mobile-class device — one with a small memory budget and a hard
 * canvas ceiling — so callers can pick a budget that will not kill the tab.
 *
 * The user agent alone cannot answer this, and the gap is not an edge case.
 * Since iPadOS 13, Safari sends a desktop-class user agent that is
 * byte-identical to a Mac's: no `iPad`, no `Mobile`. Every iPad therefore read
 * as a desktop machine here and took desktop canvas and concurrency budgets on
 * a device with a fraction of a Mac's memory and a quarter of its canvas
 * ceiling. `maxTouchPoints` closes it, because no Mac has a touch screen — a
 * `Macintosh` agent reporting touch points is an iPad.
 *
 * Deliberately not a plain `(pointer: coarse)` or touch test. Those also match
 * a Windows laptop with a touch screen, which has neither the memory limit nor
 * the 4096 px canvas cap this is used to avoid, and would be needlessly
 * throttled.
 *
 * Kept as a local copy rather than imported from a shared upload-concurrency
 * module: that module is a larger, separate piece of upload-queue machinery
 * outside the scope of this port, and this function is small, pure, and has no
 * other dependencies.
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

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
