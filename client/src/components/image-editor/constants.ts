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
/** Warn when effective layer DPI falls below export DPI minus this margin. */
export const LOW_RES_EFFECTIVE_DPI_THRESHOLD = EXPORT_DPI - 22;
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
