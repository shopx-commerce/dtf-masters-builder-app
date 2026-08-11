/**
 * Trims vector imports (SVG and PDF) down to their artwork.
 *
 * Why this exists
 * ---------------
 * A vector file carries a page, and the artwork sits somewhere inside it. An
 * Illustrator artboard or a US-Letter PDF holding a 2 in logo imports as an
 * 8.5 x 11 in design made almost entirely of nothing. That empty page is not
 * cosmetic: it is the footprint the editor clamps to the sheet, the box the
 * nester reserves, and the size shown to the customer, so one small logo could
 * swallow a third of a gangsheet. Raster uploads have always been alpha-trimmed
 * on import; vectors were the one format that kept its padding.
 *
 * How the trim survives to print
 * ------------------------------
 * Vectors are not printed from the import preview — the export re-rasterises
 * from the retained source at the placement size (see `vector-print-source`).
 * So cropping the preview alone would print the whole page again, scaled to the
 * trimmed design's box, and the artwork would come out shifted and shrunken.
 * The trim is therefore recorded as a fraction of the page rather than in
 * pixels, which makes it resolution-independent: the export re-renders the page
 * as large as needed for the crop to land on the placement size, then takes the
 * same fractional box back out. Preview and print stay in agreement at any
 * scale.
 */

/**
 * The artwork's box as a fraction of the full page, so it can be reapplied to a
 * render of any size. `x`/`y` are the top-left offset; all four are 0..1.
 */
export interface VectorInkBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Matches the alpha floor the raster crop uses (`getImageBounds`), so an SVG and
 * a PNG of the same artwork trim to the same edge.
 */
const INK_ALPHA_THRESHOLD = 10;

/**
 * Below this the page is treated as already tight. Antialiasing on artwork that
 * bleeds to the page edge can leave a hairline of near-transparent pixels, and
 * re-rendering the whole page to crop a fraction of a percent off it costs more
 * than it saves.
 */
const MIN_TRIM_FRACTION = 0.005;

/** Guards the full-page readback on absurd import rasters. */
const MAX_MEASURE_PIXELS = 40_000_000;

/**
 * Finds the artwork's box within a rasterised page, or null when there is
 * nothing worth trimming — a page that is already tight, a blank page, or a
 * raster we cannot read. Callers keep the untrimmed import in all three cases.
 */
export function measureVectorInkBox(
  image: HTMLImageElement | HTMLCanvasElement,
): VectorInkBox | null {
  const w = 'naturalWidth' in image ? (image.naturalWidth || image.width) : image.width;
  const h = 'naturalHeight' in image ? (image.naturalHeight || image.height) : image.height;
  if (!(w > 0) || !(h > 0) || w * h > MAX_MEASURE_PIXELS) return null;

  let data: Uint8ClampedArray;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    return null;
  }

  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    let p = y * w * 4 + 3;
    for (let x = 0; x < w; x++, p += 4) {
      if (data[p] <= INK_ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  // A blank page has no artwork to centre on, so leave it at page size rather
  // than collapse it to a point.
  if (maxX < 0) return null;

  const box: VectorInkBox = {
    x: minX / w,
    y: minY / h,
    w: (maxX - minX + 1) / w,
    h: (maxY - minY + 1) / h,
  };
  if (box.w > 1 - MIN_TRIM_FRACTION && box.h > 1 - MIN_TRIM_FRACTION) return null;
  return box;
}

/**
 * Converts a fractional box to whole pixels within a render of `w` x `h`.
 *
 * Both edges are rounded independently rather than flooring the offset and
 * rounding the size. A fraction like 300/1100 evaluates to 0.27272..., and
 * multiplying it back up gives 899.9999999999999, which floors to 899 and shifts
 * the whole crop a pixel off the artwork. Rounding each edge absorbs that.
 */
export function inkBoxToPixels(
  box: VectorInkBox,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const x0 = Math.max(0, Math.min(w - 1, Math.round(box.x * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.round(box.y * h)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.round((box.x + box.w) * w)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.round((box.y + box.h) * h)));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('crop load failed')); };
    img.src = url;
  });
}

/** Cuts `box` out of a decoded page, as a PNG plus a loaded image for preview. */
export async function cropRasterToInkBox(
  source: CanvasImageSource,
  sourceW: number,
  sourceH: number,
  box: VectorInkBox,
): Promise<{ image: HTMLImageElement; blob: Blob; widthPx: number; heightPx: number } | null> {
  const rect = inkBoxToPixels(box, sourceW, sourceH);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const blob = await canvasToPngBlob(canvas);
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) return null;
    const image = await loadImage(blob);
    return { image, blob, widthPx: rect.width, heightPx: rect.height };
  } catch {
    return null;
  }
}

/** Cuts `box` out of an already-encoded page render. Used by the export path. */
export async function cropPngBlobToInkBox(
  blob: Blob,
  box: VectorInkBox,
): Promise<Blob | null> {
  try {
    const img = await loadImage(blob);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    const cropped = await cropRasterToInkBox(img, w, h, box);
    return cropped?.blob ?? null;
  } catch {
    return null;
  }
}

export interface TrimmedVectorImport {
  image: HTMLImageElement;
  pngBlob: Blob;
  widthPx: number;
  heightPx: number;
  widthInches: number;
  heightInches: number;
  inkBox: VectorInkBox;
}

/**
 * Trims a parsed vector page to its artwork. Returns null when the page is
 * already tight or the crop fails, and the caller should import it unchanged.
 *
 * The physical size shrinks by the same fraction as the pixels, so the reported
 * DPI is unaffected.
 */
export async function trimVectorImport(input: {
  image: HTMLImageElement;
  widthInches: number;
  heightInches: number;
}): Promise<TrimmedVectorImport | null> {
  const box = measureVectorInkBox(input.image);
  if (!box) return null;

  const sourceW = input.image.naturalWidth || input.image.width;
  const sourceH = input.image.naturalHeight || input.image.height;
  const cropped = await cropRasterToInkBox(input.image, sourceW, sourceH, box);
  if (!cropped) return null;

  return {
    image: cropped.image,
    pngBlob: cropped.blob,
    widthPx: cropped.widthPx,
    heightPx: cropped.heightPx,
    widthInches: input.widthInches * box.w,
    heightInches: input.heightInches * box.h,
    inkBox: box,
  };
}
