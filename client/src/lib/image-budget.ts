/**
 * Pre-decode budget checks for user-uploaded rasters.
 *
 * The single biggest crash vector on iOS Safari is trying to create a
 * canvas larger than the platform's ceiling. iOS Safari silently caps a
 * single canvas at 4096×4096; anything above that makes `drawImage` no-op
 * and leaves a black canvas — no error is thrown. On top of the
 * dimensional cap, tab memory is much smaller than desktop (~500 MB
 * typical), so a 200 MP scan can crash the tab before the app even reads
 * the pixels.
 *
 * These helpers give us a place to reject or downscale *before* touching
 * a canvas, with typed error results that the upload UI can turn into a
 * user-friendly toast.
 */

export const MAX_UPLOAD_MEGAPIXELS = 40;

/** iOS Safari's single-canvas dimensional cap. Chromium/Firefox are
 *  higher, but staying at or below 4096 on the widest axis avoids
 *  platform-specific silent failures. Higher-resolution export is
 *  handled by decoding `exportBlob` directly at print time. */
export const IOS_SAFE_CANVAS_DIM = 4096;

export type BudgetOutcome =
  | { ok: true; megapixels: number }
  | { ok: false; reason: "too_many_pixels" | "unreadable_dimensions"; megapixels: number };

export function checkPixelBudget(width: number, height: number, maxMP = MAX_UPLOAD_MEGAPIXELS): BudgetOutcome {
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: "unreadable_dimensions", megapixels: 0 };
  }
  const megapixels = (width * height) / 1_000_000;
  if (megapixels > maxMP) {
    return { ok: false, reason: "too_many_pixels", megapixels };
  }
  return { ok: true, megapixels };
}

/**
 * Compute a downscale factor that fits `w` × `h` within a max dimension
 * (typically `IOS_SAFE_CANVAS_DIM`). Returns 1 when the image already
 * fits — callers can skip the downscale in that case. Preserves aspect
 * ratio.
 */
export function fitWithinDimension(w: number, h: number, maxDim: number = IOS_SAFE_CANVAS_DIM): number {
  const largest = Math.max(w, h);
  if (largest <= maxDim) return 1;
  return maxDim / largest;
}

/**
 * Format a human-readable megapixel count for toast messages.
 * e.g. `formatMegapixels(53.2)` → `"53 MP"`.
 */
export function formatMegapixels(mp: number): string {
  if (mp < 10) return `${mp.toFixed(1)} MP`;
  return `${Math.round(mp)} MP`;
}
