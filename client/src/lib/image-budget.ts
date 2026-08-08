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
 * Large sources are accepted via the server prepare path (sharp/libvips):
 * the browser never full-decodes them. Inline decode is reserved for
 * sources that fit comfortably in a mobile tab.
 */

/** Soft threshold: above this, route through `/api/prepare-raster-upload`
 *  instead of decoding the full raster in the browser. */
export const MAX_INLINE_DECODE_MEGAPIXELS = 40;

/**
 * @deprecated Prefer MAX_INLINE_DECODE_MEGAPIXELS. Kept as an alias so
 * PDF/SVG render clamps and older call sites keep compiling.
 */
export const MAX_UPLOAD_MEGAPIXELS = MAX_INLINE_DECODE_MEGAPIXELS;

/** Hard reject for pathological scans even sharp shouldn't try to keep. */
export const MAX_SOURCE_MEGAPIXELS = 150;

/** Max compressed upload size accepted by the prepare endpoint. */
export const MAX_SOURCE_FILE_BYTES = 100 * 1024 * 1024;

/** Longest edge on the editor working/preview PNG from prepare. */
export const PREPARE_PREVIEW_MAX_EDGE = 4096;

/** iOS Safari's single-canvas dimensional cap. Chromium/Firefox are
 *  higher, but staying at or below 4096 on the widest axis avoids
 *  platform-specific silent failures. Higher-resolution export is
 *  handled by decoding `exportBlob` directly at print time. */
export const IOS_SAFE_CANVAS_DIM = 4096;

export type BudgetOutcome =
  | { ok: true; mode: "inline" | "prepare"; megapixels: number }
  | { ok: false; reason: "too_many_pixels" | "unreadable_dimensions" | "file_too_large"; megapixels: number };

export function checkPixelBudget(
  width: number,
  height: number,
  maxSourceMP = MAX_SOURCE_MEGAPIXELS,
  maxInlineMP = MAX_INLINE_DECODE_MEGAPIXELS,
): BudgetOutcome {
  if (!(width > 0) || !(height > 0)) {
    return { ok: false, reason: "unreadable_dimensions", megapixels: 0 };
  }
  const megapixels = (width * height) / 1_000_000;
  if (megapixels > maxSourceMP) {
    return { ok: false, reason: "too_many_pixels", megapixels };
  }
  if (megapixels > maxInlineMP) {
    return { ok: true, mode: "prepare", megapixels };
  }
  return { ok: true, mode: "inline", megapixels };
}

export function checkFileSizeBudget(byteLength: number): BudgetOutcome {
  if (!(byteLength > 0)) {
    return { ok: false, reason: "unreadable_dimensions", megapixels: 0 };
  }
  if (byteLength > MAX_SOURCE_FILE_BYTES) {
    return { ok: false, reason: "file_too_large", megapixels: 0 };
  }
  return { ok: true, mode: "inline", megapixels: 0 };
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
 * Scale factor that fits `w` × `h` under a megapixel budget (and optional
 * max edge). Returns 1 when already within budget.
 */
export function fitWithinMegapixels(
  w: number,
  h: number,
  maxMP: number,
  maxEdge?: number,
): number {
  const pixels = Math.max(1, w * h);
  const mpScale = Math.sqrt((maxMP * 1_000_000) / pixels);
  const edgeScale =
    maxEdge && maxEdge > 0 ? Math.min(maxEdge / Math.max(w, 1), maxEdge / Math.max(h, 1)) : 1;
  return Math.min(1, mpScale, edgeScale);
}

/**
 * Format a human-readable megapixel count for toast messages.
 * e.g. `formatMegapixels(53.2)` → `"53 MP"`.
 */
export function formatMegapixels(mp: number): string {
  if (mp < 10) return `${mp.toFixed(1)} MP`;
  return `${Math.round(mp)} MP`;
}

/**
 * Format a compressed file size for toast messages.
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

/** A vector upload larger than `MAX_SOURCE_FILE_BYTES`. */
export class VectorFileTooLargeError extends Error {
  readonly code = "vector_file_too_large";
  /** Keys the caller should use for the toast; `message` is for logs only. */
  readonly titleKey = "toast.imageTooLarge";
  readonly translationKey = "toast.imageTooLargeDesc";
  constructor(readonly bytes: number) {
    super(
      `Vector file is ${formatFileSize(bytes)}, over the ` +
        `${formatFileSize(MAX_SOURCE_FILE_BYTES)} limit`,
    );
    this.name = "VectorFileTooLargeError";
  }
}

/**
 * Size ceiling enforced inside the parsers themselves.
 *
 * `parseSVG` and `parsePDF` are both exported and both read the whole file
 * (`file.text()` / `file.arrayBuffer()`) before doing anything else. The 100 MB
 * ceiling lived only in the upload caller, so the invariant held purely because
 * all four existing call sites happen to sit behind `rejectOversizedVector`.
 * Checking here makes it local to the code that would suffer, and survives a
 * fifth call site.
 */
export function assertVectorFileWithinLimit(file: { size: number }): void {
  if (file.size > MAX_SOURCE_FILE_BYTES) throw new VectorFileTooLargeError(file.size);
}
