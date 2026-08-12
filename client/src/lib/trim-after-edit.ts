/**
 * Trimming the empty margin a destructive pixel edit leaves behind.
 *
 * Removing a white background turns the background into transparency, but the
 * frame stays exactly as large as it was: a logo centred on a white square
 * becomes a logo surrounded by a large transparent square. The import path
 * already refuses to accept that shape — it measures the content box and sizes
 * the design from it — and this brings the same treatment to artwork that only
 * becomes cut-out after it has been placed.
 *
 * The trim runs inside the edit pass that is already happening, so it costs one
 * content scan and nothing else: no extra decode, and the PNG encode was going
 * to happen regardless.
 *
 * Shrinking a placed design is not just a matter of cropping its pixels. Its
 * physical size is stored in inches and its position is the centre of its
 * bounding box, so a crop that takes more off one side than the other has to
 * move that centre or the artwork slides across the sheet. `geometryAfterTrim`
 * is the arithmetic for that, kept pure and separate so it can be checked
 * directly — see `scripts/verify-trim-geometry.mjs`.
 */

import { measureContentBox, type ContentBox } from "./content-bounds";
import type { CanvasPixelEdit } from "./print-source-edit";
import type { ImageTransform } from "./types";

/** Floor on a design's physical size, matching the upload path. */
const MIN_DESIGN_INCHES = 0.01;

export interface TrimResult {
  /** Canvas dimensions before the trim, which the geometry is relative to. */
  sourceWidth: number;
  sourceHeight: number;
  /**
   * The region kept, in pre-trim canvas pixels, or null when the frame was
   * left alone — either because the content already filled it or because the
   * edit erased everything.
   */
  box: ContentBox | null;
}

/**
 * Copy one region of a canvas at its natural size.
 *
 * Deliberately not `drawContentPreview`, which caps its output at
 * `IOS_SAFE_CANVAS_DIM`. That is the right ceiling for an editor preview and
 * the wrong one here: a print source on desktop is rasterised up to 8192 px
 * (`vectorExportMaxEdge`), so routing a large trim through the preview helper
 * would quietly halve the resolution of the sheet.
 */
function cropCanvasToBox(source: HTMLCanvasElement, box: ContentBox): HTMLCanvasElement | null {
  const canvas = document.createElement("canvas");
  canvas.width = box.width;
  canvas.height = box.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // Source and destination rectangles are the same size and integer aligned,
  // so this is a straight blit and no resampling happens either way.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return canvas;
}

/**
 * Wrap a pixel edit so that whatever empty space it creates is cropped away.
 *
 * Returns the edit to hand to `applyEditAtPrintResolution` (or
 * `applyEditToPreviewSource`) together with a reader for what the trim did,
 * which the caller needs in order to correct the design's size and position.
 *
 * `minContentFraction` is 0 rather than the import default of 0.05. That guard
 * exists to stop a barely-visible speck from defining a fresh import's
 * physical size; here the artwork is already placed and keeps the size it has,
 * and a small subject in a large white frame is precisely the case being
 * trimmed. `measureContentBox` still declines a trim that would shave less
 * than half a percent off both axes.
 */
export function createTrimmingEdit(apply: (canvas: HTMLCanvasElement) => Promise<void> | void): {
  edit: CanvasPixelEdit;
  trim: () => TrimResult | null;
} {
  let result: TrimResult | null = null;

  const edit: CanvasPixelEdit = async (canvas) => {
    await apply(canvas);

    const sourceWidth = canvas.width;
    const sourceHeight = canvas.height;
    const box = await measureContentBox(canvas, { minContentFraction: 0 }).catch((error) => {
      console.warn("[trim-after-edit] could not measure content bounds", error);
      return null;
    });
    result = { sourceWidth, sourceHeight, box };
    if (!box) return;

    const cropped = cropCanvasToBox(canvas, box);
    if (!cropped) {
      // The edit itself succeeded, so keep it and leave the frame alone rather
      // than failing the whole removal over a canvas the browser would not give
      // us. Reporting no box keeps the geometry untouched to match.
      result = { sourceWidth, sourceHeight, box: null };
      return;
    }
    return cropped;
  };

  return { edit, trim: () => result };
}

export interface TrimmableGeometry {
  widthInches: number;
  heightInches: number;
  transform: ImageTransform;
}

/**
 * The size and placement a design should take once `trim` has been applied to
 * its pixels, or null when nothing needs to change.
 *
 * The artwork keeps the size it is drawn at: the inches shrink in the same
 * proportion as the pixels, and `transform.s` is left alone, so the only thing
 * that changes is how much empty space the design's box claims. That also keeps
 * the reported DPI honest for free, since it is pixels divided by inches and
 * both sides shrink by the same factor.
 *
 * The centre moves by wherever the kept region sat inside the old frame. Export
 * draws a design by translating to its centre, rotating, then flipping (see
 * `export-worker.ts`), so an offset measured in the artwork's own axes has to be
 * flipped and then rotated to land in sheet axes.
 */
export function geometryAfterTrim(
  geometry: TrimmableGeometry,
  trim: TrimResult,
  artboardWidth: number,
  artboardHeight: number,
): TrimmableGeometry | null {
  const { box, sourceWidth, sourceHeight } = trim;
  if (!box) return null;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  if (!(artboardWidth > 0) || !(artboardHeight > 0)) return null;
  if (box.width >= sourceWidth && box.height >= sourceHeight) return null;

  const { widthInches, heightInches, transform } = geometry;

  // Where the kept region's centre sits inside the old frame, as a signed
  // fraction of the frame away from its middle.
  const fdx = (box.x + box.width / 2) / sourceWidth - 0.5;
  const fdy = (box.y + box.height / 2) / sourceHeight - 0.5;

  // The same offset in inches on the sheet, before rotation: the design is
  // drawn `widthInches * s` wide, whatever its pixel count.
  let dx = fdx * widthInches * transform.s;
  let dy = fdy * heightInches * transform.s;
  if (transform.flipX) dx = -dx;
  if (transform.flipY) dy = -dy;

  const radians = (transform.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    widthInches: Math.max(MIN_DESIGN_INCHES, (widthInches * box.width) / sourceWidth),
    heightInches: Math.max(MIN_DESIGN_INCHES, (heightInches * box.height) / sourceHeight),
    transform: {
      ...transform,
      nx: transform.nx + (dx * cos - dy * sin) / artboardWidth,
      ny: transform.ny + (dx * sin + dy * cos) / artboardHeight,
    },
  };
}
