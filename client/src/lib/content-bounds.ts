/**
 * Measures the artwork box inside a raster, at any source size.
 *
 * Why this exists
 * ---------------
 * The original content crop (`cropImageToContent`) allocated a canvas at
 * *source* size and ran `getImageData` over the whole frame. For a 30 MP
 * upload that is ~120 MB of RGBA on the JS heap on top of an equally large
 * canvas backing store, and on iOS Safari any canvas past 4096 px silently
 * hands back a blank surface instead of failing. Both were real crashes, so
 * the upload path grew a 16 MP / 4096 px refusal and simply stopped trimming
 * anything bigger — which left an ordinary 22 x 8 in sheet at 300 DPI
 * (6600 x 2400, under the pixel cap but over the edge cap) importing with all
 * its empty space intact.
 *
 * The fix is to stop sizing the work to the upload. Bounds are measured by
 * walking the source in fixed-size tiles, so peak memory is one tile no matter
 * how large the image is, and no canvas ever approaches a platform limit. Each
 * tile is drawn 1:1, so the result is exact to the pixel rather than estimated
 * from a downsample.
 *
 * The trim itself is then a *rectangle*, not a cropped bitmap: callers keep the
 * customer's original bytes as the print source and record the box in
 * `ImageInfo.exportCrop`, which the export, PDF, and cart paths already honour
 * via `decodePrintSourceAtSize`. Nothing is re-encoded, so trimming no longer
 * costs a generation of quality, and the server prepare path (which has always
 * worked this way) now produces the same shape of result.
 */

import { IOS_SAFE_CANVAS_DIM } from "./image-budget";

export interface ContentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Anything we can measure: a decoded upload, or a rasterised vector page. */
export type MeasurableSource = HTMLImageElement | HTMLCanvasElement;

/**
 * Alpha above this counts as artwork. Matches `getImageBounds` and
 * `vector-trim`, so a PNG and an SVG of the same design trim to the same edge.
 */
export const INK_ALPHA_THRESHOLD = 10;

/**
 * Longest edge of a single scan tile.
 *
 * Every canvas this module allocates for measurement is one tile, so the peak
 * cost is fixed at TILE_EDGE² x 4 bytes (16 MB at 2048) regardless of the
 * upload. Half of iOS Safari's canvas cap also keeps a wide margin from the
 * silent-blank-canvas threshold that made full-frame measurement unsafe there.
 */
const TILE_EDGE = 2048;

/**
 * Below this the frame is already tight. Antialiasing on artwork that bleeds to
 * the edge can leave a hairline of near-transparent pixels, and re-framing the
 * design to shave a fraction of a percent off it is not worth a repaint.
 * Matches `vector-trim`'s threshold.
 */
const MIN_TRIM_FRACTION = 0.005;

/**
 * Default floor: a box smaller than this fraction of the frame on either axis
 * is treated as noise rather than the design, since a single stray pixel in an
 * otherwise empty upload would collapse the whole sheet onto it. Carried over
 * from the original raster crop, which kept the untrimmed frame in that case.
 *
 * Vector imports pass 0 instead — a small logo alone on a Letter page is a tiny
 * fraction of its frame and is precisely what that trim exists to fix.
 */
const MIN_CONTENT_FRACTION = 0.05;

interface TileBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Ink bounds within one tile's pixels, or null when the tile is empty.
 *
 * Each row is probed inward from both ends and abandoned at the first ink
 * pixel, so the margins that dominate a trimmable upload cost two reads per row
 * rather than a full traversal.
 */
function scanTileBounds(data: Uint8ClampedArray, w: number, h: number): TileBounds | null {
  let minX = w;
  let minY = -1;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4 + 3;

    let rowMinX = -1;
    for (let x = 0, p = rowStart; x < w; x++, p += 4) {
      if (data[p] > INK_ALPHA_THRESHOLD) {
        rowMinX = x;
        break;
      }
    }
    if (rowMinX < 0) continue;

    let rowMaxX = rowMinX;
    for (let x = w - 1, p = rowStart + (w - 1) * 4; x > rowMinX; x--, p -= 4) {
      if (data[p] > INK_ALPHA_THRESHOLD) {
        rowMaxX = x;
        break;
      }
    }

    if (minY < 0) minY = y;
    maxY = y;
    if (rowMinX < minX) minX = rowMinX;
    if (rowMaxX > maxX) maxX = rowMaxX;
  }

  if (maxY < 0) return null;
  return { minX, minY, maxX, maxY };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function sourceSize(image: MeasurableSource): { width: number; height: number } {
  return {
    width: ("naturalWidth" in image ? image.naturalWidth : 0) || image.width,
    height: ("naturalHeight" in image ? image.naturalHeight : 0) || image.height,
  };
}

/**
 * The artwork's box in source pixels, or null when there is nothing worth
 * trimming — an already-tight frame, a fully transparent upload, a box too
 * small to be the design, or a canvas we could not obtain. Callers keep the
 * full frame in every one of those cases.
 *
 * Yields between tiles so a multi-tile scan does not freeze the editor while
 * the upload spinner is showing.
 */
export async function measureContentBox(
  image: MeasurableSource,
  opts?: { minContentFraction?: number },
): Promise<ContentBox | null> {
  const minContentFraction = opts?.minContentFraction ?? MIN_CONTENT_FRACTION;
  const { width: srcW, height: srcH } = sourceSize(image);
  if (!(srcW > 0) || !(srcH > 0)) return null;

  const tileW = Math.min(TILE_EDGE, srcW);
  const tileH = Math.min(TILE_EDGE, srcH);
  // An upload that fits in one tile is the common case and is over in a few
  // milliseconds; yielding there would cost more than the scan.
  const multiTile = Math.ceil(srcW / tileW) * Math.ceil(srcH / tileH) > 1;

  const canvas = document.createElement("canvas");
  canvas.width = tileW;
  canvas.height = tileH;
  // Read back immediately below, so the canvas has to be CPU-backed. Without
  // the hint Chrome keeps it on the GPU and `getImageData` blocks until the GPU
  // flushes everything queued ahead of it, which during a multi-file upload is
  // seconds rather than milliseconds.
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  let minX = srcW;
  let minY = srcH;
  let maxX = -1;
  let maxY = -1;

  try {
    for (let ty = 0; ty < srcH; ty += tileH) {
      const th = Math.min(tileH, srcH - ty);
      for (let tx = 0; tx < srcW; tx += tileW) {
        const tw = Math.min(tileW, srcW - tx);

        // A tile wholly inside the box we already have cannot widen it, and the
        // union is all we are after — so skip the readback entirely. This is
        // what makes a large image with a wide margin cheap: once the first
        // inked tile has set the box, the interior stops being read.
        const alreadyCovered =
          maxX >= 0 && tx >= minX && ty >= minY && tx + tw - 1 <= maxX && ty + th - 1 <= maxY;
        if (alreadyCovered) continue;

        ctx.clearRect(0, 0, tw, th);
        ctx.drawImage(image, tx, ty, tw, th, 0, 0, tw, th);
        const { data } = ctx.getImageData(0, 0, tw, th);

        const b = scanTileBounds(data, tw, th);
        if (b) {
          if (tx + b.minX < minX) minX = tx + b.minX;
          if (ty + b.minY < minY) minY = ty + b.minY;
          if (tx + b.maxX > maxX) maxX = tx + b.maxX;
          if (ty + b.maxY > maxY) maxY = ty + b.maxY;
        }

        if (multiTile) await yieldToBrowser();
      }
    }
  } catch (err) {
    console.warn("[content-bounds] measurement failed; keeping the full frame", err);
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  // Nothing but transparency: there is no artwork to centre on, so leave the
  // frame alone rather than collapse it to a point.
  if (maxX < 0) return null;

  const box: ContentBox = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  if (box.width < srcW * minContentFraction || box.height < srcH * minContentFraction) {
    return null;
  }
  if (
    box.width >= srcW * (1 - MIN_TRIM_FRACTION) &&
    box.height >= srcH * (1 - MIN_TRIM_FRACTION)
  ) {
    return null;
  }
  return box;
}

/**
 * An editor-sized preview of `box` (or of the whole frame when `box` is null),
 * scaled to fit `maxEdge`.
 *
 * The destination is bounded, so this is the one draw the upload path needs and
 * it never allocates at source size — the reason the caller can hand us a
 * 100 MP image without a size check first.
 *
 * `pixelated` should be set when the source has binary alpha (halftone-ready
 * art): resampling it smoothly introduces a soft fringe that the editor then
 * reads back as antialiasing.
 */
export function drawContentPreview(
  image: MeasurableSource,
  box: ContentBox | null,
  maxEdge: number,
  opts?: { pixelated?: boolean },
): HTMLCanvasElement | null {
  const { width: srcW, height: srcH } = sourceSize(image);
  if (!(srcW > 0) || !(srcH > 0)) return null;

  const frame = box ?? { x: 0, y: 0, width: srcW, height: srcH };
  const edgeCap = Math.min(maxEdge, IOS_SAFE_CANVAS_DIM);
  const scale = Math.min(1, edgeCap / Math.max(frame.width, frame.height));
  const dw = Math.max(1, Math.round(frame.width * scale));
  const dh = Math.max(1, Math.round(frame.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.imageSmoothingEnabled = !opts?.pixelated;
  if (!opts?.pixelated) ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height, 0, 0, dw, dh);
  return canvas;
}
