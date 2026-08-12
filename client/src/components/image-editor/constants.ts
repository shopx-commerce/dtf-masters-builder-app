import type { ImageTransform } from "@/lib/types";

/** Minimum stall timeout before add-to-cart / update is considered stuck (admin edit). */
export const ADD_TO_CART_STALL_MIN_MS_UPDATE = 4 * 60 * 1000;

/** Minimum stall timeout before add-to-cart is considered stuck (new design). */
export const ADD_TO_CART_STALL_MIN_MS_NEW = 10 * 60 * 1000;

/** Extra stall time per MB of PNG uploaded (ms). */
export const ADD_TO_CART_STALL_MS_PER_MB = 90_000;

/** Default layer width/height in inches when restoring saved state. */
export const DEFAULT_LAYER_SIZE_INCHES = 1;

/** Default normalized X/Y when layer position missing from saved state. */
export const DEFAULT_LAYER_CENTER_NX = 0.5;
export const DEFAULT_LAYER_CENTER_NY = 0.5;

/** Default scale when restoring layer transform. */
export const DEFAULT_LAYER_SCALE = 1;

/** Default rotation when restoring layer transform. */
export const DEFAULT_LAYER_ROTATION = 0;

/** Default transform for a new design on the artboard. */
export const DEFAULT_DESIGN_TRANSFORM: ImageTransform = {
  nx: DEFAULT_LAYER_CENTER_NX,
  ny: DEFAULT_LAYER_CENTER_NY,
  s: DEFAULT_LAYER_SCALE,
  rotation: DEFAULT_LAYER_ROTATION,
};

/** Default print resolution when an uploaded raster has no reliable DPI metadata. */
export const RASTER_DPI_FALLBACK = 300;
export const EXPORT_DPI = 300;
/**
 * Warn on upload only when the artwork is genuinely unprintable — 36 DPI or
 * below. This used to sit at `EXPORT_DPI - 22` (278), which fires for every
 * ordinary 72 DPI file, so the toast appeared on almost every upload and
 * stopped carrying information. The DPI badge in the toolbar still shows the
 * softer 198/277 tiers, so customers keep the advisory signal without a popup.
 */
export const LOW_RES_EFFECTIVE_DPI_THRESHOLD = 37;
/** Max pixel width/height for the *preview* copy of an uploaded raster kept
 *  in RAM. Export re-decodes from `imageInfo.exportBlob` so lowering this
 *  does not sacrifice print quality; it only bounds the interactive editing
 *  buffer. Previously 4000 → ~64 MB decoded per design. 2000 → ~16 MB decoded
 *  per design. This is above the detail-canvas cap (4 MP / 4096 edge) so HD
 *  zoom of the selected design is unchanged. */
export const MAX_STORED_IMAGE_DIMENSION = 2000;
/** Layer thumbnail size in the layers panel (px). */
export const LAYER_THUMBNAIL_SIZE = 48;
export const ADD_TO_CART_LABEL_MAX_LEN = 34;
export const EXPORT_TIMEOUT_MS = 300_000;
/** Delay before hiding the upload progress bar, so the 100% state is visible. */
export const UPLOAD_PROGRESS_HIDE_DELAY_MS = 300;
/** Concurrent background layer-asset uploads while the customer designs. */
export const LAYER_ASSET_UPLOAD_CONCURRENCY = 3;
/** Grace period before a removed layer's uploaded asset is deleted, so undo can reclaim it. */
export const LAYER_ASSET_GC_DELAY_MS = 8_000;
/** Longest side of the small cart-preview image, in pixels. */
export const CART_PREVIEW_MAX_DIMENSION = 1500;
/**
 * Quiet period after the last edit before a cart preview is rendered and uploaded. A whole-sheet
 * preview is invalidated by every drag/resize/rotate, so without this each mouse-move would queue
 * an upload.
 */
export const CART_PREVIEW_DEBOUNCE_MS = 700;
/**
 * How long Add-to-Cart will wait for the current arrangement's preview upload. On timeout the cart
 * line ships with no preview URL, which the cart already tolerates (it omits the property).
 */
export const CART_PREVIEW_WAIT_MS = 8_000;
/** Render timeout for the small preview. Far below EXPORT_TIMEOUT_MS — this is a ~1500px image. */
export const CART_PREVIEW_RENDER_TIMEOUT_MS = 30_000;
