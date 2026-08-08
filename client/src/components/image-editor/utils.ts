import { hasCleanAlpha } from "@/lib/image-crop";
import { IOS_SAFE_CANVAS_DIM, SAFARI_MAX_CANVAS_AREA } from "@/lib/image-budget";
import { isMobileDevice } from "@/lib/upload-queue";
import { inkInset, type NestMask } from "@/lib/nest-core";
import { DEFAULT_SHEET_MARGIN, fitHeightForBand, type InkBand } from "@/lib/sheet-fit";
import { getDesignNestMask } from "@/lib/nest-mask";
import type { ImageTransform } from "@/lib/types";
import ExportWorkerModule from "@/lib/export-worker?worker";
import ArrangeWorkerModule from "@/lib/arrange-worker?worker";
import {
  ADD_TO_CART_LABEL_MAX_LEN,
  EXPORT_DPI,
  RASTER_DPI_FALLBACK,
} from "./constants";

/** Smallest physical size a design may claim. */
const MIN_DESIGN_INCHES = 0.01;

/**
 * Largest physical size a design may claim. Not a product limit — an oversized
 * import is scaled onto the sheet rather than refused — but page geometry can be
 * absurd rather than merely large. A PDF may legally declare `/UserUnit 75000`,
 * which turns a US-Letter page into 637,500 inches, and a hand-edited
 * `/MediaBox [0 0 1e300 1e300]` is accepted by pdf.js as a page 1.4e298 inches
 * wide. Everything downstream divides by these numbers.
 */
const MAX_DESIGN_INCHES = 10_000;

/**
 * Clamp an imported design's physical size to something every downstream
 * calculation can survive, or `null` when the file gave us nothing usable.
 *
 * This is the last gate before a size reaches a design's `transform`, and it has
 * to catch non-finite values specifically: `Math.max(0.01, NaN)` is `NaN`, so the
 * floors that look like they clamp do not. A single `NaN` here becomes
 * `transform.s`, `nx`, and `ny`, gets structured-cloned into the IndexedDB draft
 * unchanged, and is read back verbatim on every reload — so the design can never
 * be laid out, arranged, or exported again, in this session or any future one.
 *
 * Oversized-but-real sizes are scaled proportionally so the aspect ratio the
 * customer authored survives the clamp.
 */
function sanitizeDesignInches(
  widthInches: number,
  heightInches: number,
): { widthInches: number; heightInches: number } | null {
  const usable = (n: number) => Number.isFinite(n) && n > 0;
  if (!usable(widthInches) || !usable(heightInches)) return null;

  const overshoot = Math.max(widthInches, heightInches) / MAX_DESIGN_INCHES;
  const scale = overshoot > 1 ? 1 / overshoot : 1;
  return {
    widthInches: Math.max(MIN_DESIGN_INCHES, widthInches * scale),
    heightInches: Math.max(MIN_DESIGN_INCHES, heightInches * scale),
  };
}

function inchesFromPixelsPair(pw: number, ph: number, dpi: number): { widthInches: number; heightInches: number } {
  // `hIn` used to be derived as `wIn * (ph / pw)`, which is `NaN` for any
  // zero-width source (`0 * Infinity`) and survives the `Math.max` floor below.
  const wIn = pw / dpi;
  const hIn = ph / dpi;
  return {
    widthInches: Math.max(0.01, parseFloat(wIn.toFixed(4))),
    heightInches: Math.max(0.01, parseFloat(hIn.toFixed(4))),
  };
}

function normalizeRasterDpiForInches(dpi: number): number {
  const normalized = Number.isFinite(dpi) && dpi > 0 ? dpi : RASTER_DPI_FALLBACK;
  return Math.min(normalized, EXPORT_DPI);
}

function imageHasCleanAlpha(img: HTMLImageElement): boolean {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  // Read back immediately below, so the canvas must be CPU-backed. Without the
  // hint Chrome keeps it on the GPU and `getImageData` blocks the main thread
  // waiting for a flush — measured elsewhere in this app as seconds of freeze on
  // a canvas of a few hundred pixels. Do *not* copy this to a context that is
  // only drawn to and composited: there the hint forces CPU backing and costs.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  return hasCleanAlpha(data, width, height);
}

export {
  inchesFromPixelsPair,
  sanitizeDesignInches,
  normalizeRasterDpiForInches,
  imageHasCleanAlpha,
  fetchImageDpi,
  isPngWithoutEmbeddedDpi,
  readDeclaredDpi,
  injectPngDpi,
  clampDesignToArtboard,
  getRotatedBounds,
  getInkBounds,
  getContentInkBandY,
  fitGangsheetHeight,
  getDesignNestSilhouette,
  getEffectiveHeight,
  getStampExtra,
  getDesignSelectionUnits,
  getDesignSelectionBounds,
  rotateDesignSelection,
  exportWorkerResultToBlob,
};

export type { DeclaredResolution };

export function shortAddToCartLabel(message: string, maxLen = ADD_TO_CART_LABEL_MAX_LEN): string {
  const s = String(message || '').trim();
  if (!s) return s;
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

let _exportWorker: Worker | null = null;
export function getExportWorker(): Worker | null {
  if (!_exportWorker) {
    try { _exportWorker = new ExportWorkerModule(); }
    catch { return null; }
  }
  return _exportWorker;
}

export function canUseMemoryEfficientPngExport(): boolean {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap === "function"
    && typeof CompressionStream !== "undefined";
}

/**
 * Below this, a production file is not worth printing. Used to decide whether a
 * device that cannot render at full DPI should quietly downgrade or refuse.
 */
export const MIN_PRODUCTION_DPI = 150;

export type ResolvedExportDpi = {
  dpi: number;
  /** True when the sheet would not fit and the DPI had to come down. */
  clamped: boolean;
  /** True when the reduction goes below what is worth sending to a printer. */
  belowPrintQuality: boolean;
};

/**
 * The DPI this device can actually render a sheet of this size at.
 *
 * The streaming worker never materialises the whole sheet, so it always gets
 * the full 300. Only the fallback, which allocates one canvas for the entire
 * gangsheet, has to be talked down.
 *
 * Shared because it did not used to be. The download button clamped and the
 * cart button did not, so the same 22 x 120 inch sheet that downloaded fine
 * asked Add to Cart for a 6600 x 36000 canvas — 237 MP, about 950 MB — on the
 * main thread. Two callers with the same constraint and one of them guarded is
 * a bug waiting to be reintroduced, so there is now one place to change.
 *
 * The mobile budget is Safari's canvas area rather than a generous desktop
 * figure, because the desktop 80 MP allowance is itself five times what iOS
 * will return a bitmap for.
 */
export function resolveExportDpi(
  artboardWidthInches: number,
  artboardHeightInches: number,
  useWorker: boolean,
): ResolvedExportDpi {
  if (useWorker) return { dpi: EXPORT_DPI, clamped: false, belowPrintQuality: false };

  const mobile = isMobileDevice();
  const maxPixels = mobile ? SAFARI_MAX_CANVAS_AREA : 80_000_000;
  const maxEdge = mobile ? IOS_SAFE_CANVAS_DIM : 12_000;

  const w = Math.max(1e-6, artboardWidthInches);
  const h = Math.max(1e-6, artboardHeightInches);
  const dpiByArea = Math.sqrt(maxPixels / (w * h));
  const dpiByEdge = Math.min(maxEdge / w, maxEdge / h);
  const dpi = Math.min(EXPORT_DPI, dpiByArea, dpiByEdge);

  return {
    dpi,
    clamped: dpi < EXPORT_DPI,
    belowPrintQuality: dpi < MIN_PRODUCTION_DPI,
  };
}

export function getExportMemoryWarning(): string | null {
  if (typeof performance === "undefined") return null;
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (!memory) return null;
  const headroom = memory.jsHeapSizeLimit - memory.usedJSHeapSize;
  return headroom < 500 * 1024 * 1024
    ? `Browser memory headroom is approximately ${Math.max(0, Math.round(headroom / (1024 * 1024)))} MB.`
    : null;
}

export type PngExportProgress = {
  phase: "preparing" | "rendering" | "finalizing";
  completed: number;
  total: number;
};

export type PngExportDesign = {
  widthInches: number;
  heightInches: number;
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  image: HTMLImageElement;
  /**
   * Encoded print source. Preferred over `image`: the worker decodes it
   * straight to the placement size, so we never re-encode a full-resolution
   * canvas on the main thread and never resample twice.
   */
  sourceBlob?: Blob;
  /** Content box within `sourceBlob`, in source pixels. */
  sourceCrop?: { x: number; y: number; width: number; height: number };
  alphaThresholded?: boolean;
  printFileName?: boolean;
  name?: string;
};

/**
 * Decode an encoded print source cropped to `crop` and scaled to the size it
 * will occupy on the sheet. Used by the export paths that draw on the main
 * thread (the non-worker canvas fallback and PDF embedding); the PNG worker
 * does the same thing internally.
 *
 * Decoding straight to the placement size means peak memory tracks the sheet
 * rather than the upload, and the pixels are resampled once by the decoder
 * instead of twice. Never upscales — returns the natural size in that case.
 */
export async function decodePrintSourceAtSize(
  blob: Blob,
  crop: { x: number; y: number; width: number; height: number } | undefined,
  targetW: number,
  targetH: number,
  pixelated = false,
): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  const wantW = Math.max(1, Math.round(targetW));
  const wantH = Math.max(1, Math.round(targetH));
  const resizeQuality: ImageBitmapOptions["resizeQuality"] = pixelated ? "pixelated" : "high";
  try {
    if (crop) {
      const options =
        wantW < crop.width || wantH < crop.height
          ? { resizeWidth: wantW, resizeHeight: wantH, resizeQuality }
          : undefined;
      return await createImageBitmap(blob, crop.x, crop.y, crop.width, crop.height, options);
    }
    const probe = await createImageBitmap(blob);
    if (wantW >= probe.width && wantH >= probe.height) return probe;
    const scaled = await createImageBitmap(probe, 0, 0, probe.width, probe.height, {
      resizeWidth: wantW,
      resizeHeight: wantH,
      resizeQuality,
    });
    probe.close();
    return scaled;
  } catch (err) {
    console.warn("[export] print-source decode failed", { err });
    return null;
  }
}

function imageToExportBuffer(image: HTMLImageElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      reject(new Error("Export image has no pixels."));
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      reject(new Error("Could not prepare an export image."));
      return;
    }
    ctx.drawImage(image, 0, 0, width, height);
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      if (blob) {
        blob.arrayBuffer().then(resolve).catch(reject);
      }
      else reject(new Error("Could not encode an export image."));
    }, "image/png");
  });
}

// Duplicate-aware source buffer dedup. When a customer duplicates the same
// design N times (very common in gangsheets), we only encode the source once
// and let the worker cache the decoded bitmap and rendered stamps.
//
// A design carrying `sourceBlob` contributes its already-encoded bytes
// verbatim. Falling back to `imageToExportBuffer` means a full-size canvas
// plus a PNG encode on the main thread, so it is reserved for sources that
// only exist as a decoded element (halftoned output, vector rasterisations).
async function buildDedupedSources(
  designs: PngExportDesign[],
): Promise<{
  sources: ArrayBuffer[];
  designSourceIndex: number[];
}> {
  const imageCache = new WeakMap<HTMLImageElement, number>();
  const blobCache = new WeakMap<Blob, number>();
  const sources: ArrayBuffer[] = [];
  const designSourceIndex: number[] = new Array(designs.length);
  for (let i = 0; i < designs.length; i++) {
    const { image: img, sourceBlob } = designs[i];
    const cache = sourceBlob ? blobCache : imageCache;
    const key = (sourceBlob ?? img) as Blob & HTMLImageElement;
    const existing = cache.get(key);
    if (existing !== undefined) {
      designSourceIndex[i] = existing;
      continue;
    }
    const buffer = sourceBlob ? await sourceBlob.arrayBuffer() : await imageToExportBuffer(img);
    const idx = sources.length;
    sources.push(buffer);
    cache.set(key, idx);
    designSourceIndex[i] = idx;
  }
  return { sources, designSourceIndex };
}

export async function exportPngWithWorker(options: {
  designs: PngExportDesign[];
  outW: number;
  outH: number;
  exportDpi: number;
  onProgress?: (progress: PngExportProgress) => void;
}): Promise<{ blob: Blob; buffer: ArrayBuffer }> {
  const worker = getExportWorker();
  if (!worker || !canUseMemoryEfficientPngExport()) {
    throw new Error("The memory-efficient PNG export path is unavailable in this browser.");
  }

  const { sources, designSourceIndex } = await buildDedupedSources(options.designs);
  const designPayload: Array<{
    widthInches: number;
    heightInches: number;
    nx: number;
    ny: number;
    s: number;
    rotation: number;
    flipX?: boolean;
    flipY?: boolean;
    sourceIndex: number;
    sourceCrop?: { x: number; y: number; width: number; height: number };
    alphaThresholded?: boolean;
    printFileName?: boolean;
    name?: string;
  }> = options.designs.map((design, i) => ({
    widthInches: design.widthInches,
    heightInches: design.heightInches,
    nx: design.nx,
    ny: design.ny,
    s: design.s,
    rotation: design.rotation,
    flipX: design.flipX,
    flipY: design.flipY,
    sourceIndex: designSourceIndex[i],
    sourceCrop: design.sourceBlob ? design.sourceCrop : undefined,
    alphaThresholded: design.alphaThresholded,
    printFileName: design.printFileName,
    name: design.name,
  }));

  const requestId = nextExportRequestId();
  const result = await new Promise<{ buffer: ArrayBuffer; byteLength: number }>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      window.clearTimeout(timer);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.requestId !== requestId) return;
      if (event.data.type === "progress") {
        options.onProgress?.({
          phase: event.data.phase,
          completed: Number(event.data.completed) || 0,
          total: Math.max(1, Number(event.data.total) || 1),
        });
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      if (event.data.type === "error") {
        reject(new Error(event.data.error || "Export failed"));
      } else if (event.data.buffer) {
        const buffer = event.data.buffer as ArrayBuffer;
        resolve({
          buffer,
          byteLength: Number(event.data.byteLength) > 0 ? Number(event.data.byteLength) : buffer.byteLength,
        });
      } else {
        reject(new Error("Export returned no image data"));
      }
    };
    const onError = (event: ErrorEvent) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(event.message || "Export worker crashed"));
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Export timed out — the gangsheet may be too large. Try a smaller size."));
    }, 300_000);
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    try {
      worker.postMessage(
        {
          type: "export",
          requestId,
          sources,
          designs: designPayload,
          outW: options.outW,
          outH: options.outH,
          exportDpi: options.exportDpi,
        },
        sources,
      );
    } catch (error) {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error("Could not start export."));
    }
  });

  return {
    buffer: result.buffer,
    blob: new Blob([result.buffer], { type: "image/png" }),
  };
}

let _arrangeWorker: Worker | null = null;
export function getArrangeWorker(): Worker | null {
  if (!_arrangeWorker) {
    try { _arrangeWorker = new ArrangeWorkerModule(); }
    catch { return null; }
  }
  return _arrangeWorker;
}

/**
 * What a file's own bytes say about its physical resolution.
 *
 * `dpi: null` means "this container declares nothing", which is deliberately
 * not any particular number. libvips fabricates 72 for an undeclared PNG or
 * JPEG and `/api/image-info` adds `|| 72` on top, so by the time a DPI reaches
 * the editor there is no way left to tell a file that asked for 72 from one
 * that asked for nothing — and those two want opposite defaults on a print
 * product. Keeping them distinct is the whole point of this type.
 */
type DeclaredResolution = {
  container: "png" | "jpeg" | "webp" | "unknown";
  /** Declared pixels per inch, or `null` when nothing absolute was declared. */
  dpi: number | null;
  source: "pHYs" | "jfif" | "exif" | null;
};

const UNDECLARED: DeclaredResolution = { container: "unknown", dpi: null, source: null };

/** How much of a file is read to look for a resolution declaration. */
const DPI_HEADER_SNIFF_BYTES = 65536;

/**
 * Upper bound on a believable declaration.
 *
 * Nothing here is a product limit — `normalizeRasterDpiForInches` caps the
 * usable value at `EXPORT_DPI` — it only rejects arithmetic that could not have
 * come from a real encoder, so a hostile 4-billion-px/metre pHYs reads as
 * "declares nothing" instead of being carried into a stamped chunk.
 */
const MAX_DECLARED_DPI = 100_000;

function plausibleDpi(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_DECLARED_DPI) return null;
  return Math.round(value);
}

function isChunkType(buf: Uint8Array, off: number, type: string): boolean {
  for (let i = 0; i < 4; i++) if (buf[off + i] !== type.charCodeAt(i)) return false;
  return true;
}

function parsePngPhys(buf: Uint8Array): Pick<DeclaredResolution, "dpi" | "source"> {
  let offset = 8;
  // The iteration cap is only reachable by a file whose declared chunk lengths
  // keep the walk inside the window; a real PNG reaches IDAT within a handful.
  for (let guard = 0; guard < 4096 && offset + 12 <= buf.length; guard++) {
    const len = readU32(buf, offset);
    if (isChunkType(buf, offset + 4, "pHYs")) {
      const dataStart = offset + 8;
      if (dataStart + 9 > buf.length) return { dpi: null, source: null };
      const ppuX = readU32(buf, dataStart);
      if (buf[dataStart + 8] !== 1) return { dpi: null, source: null }; // unit 1 = metre
      return { dpi: plausibleDpi(ppuX * 0.0254), source: "pHYs" };
    }
    if (isChunkType(buf, offset + 4, "IDAT") || isChunkType(buf, offset + 4, "IEND")) break;
    offset += 12 + len;
  }
  return { dpi: null, source: null };
}

function readJfifDensity(buf: Uint8Array, segStart: number, segEnd: number): number | null {
  const end = Math.min(segEnd, buf.length);
  if (segStart + 18 > end) return null;
  const isJfif =
    buf[segStart + 4] === 0x4a && buf[segStart + 5] === 0x46 &&
    buf[segStart + 6] === 0x49 && buf[segStart + 7] === 0x46 && buf[segStart + 8] === 0x00;
  if (!isJfif) return null;
  const units = buf[segStart + 11]; // 1 = dpi, 2 = dpcm, 0 = aspect ratio only
  const xDensity = (buf[segStart + 12] << 8) | buf[segStart + 13];
  if (xDensity <= 0) return null;
  if (units === 1) return plausibleDpi(xDensity);
  if (units === 2) return plausibleDpi(xDensity * 2.54);
  return null;
}

/**
 * `XResolution` out of an EXIF APP1 segment's IFD0.
 *
 * This is where a "Save As JPEG at 300 DPI" actually puts the number: sharp and
 * Photoshop both write it here, frequently with no JFIF APP0 at all, and often
 * as an un-reduced rational such as `300000/1000`. Both TIFF byte orders occur.
 */
function readExifXResolution(buf: Uint8Array, segStart: number, segEnd: number): number | null {
  const end = Math.min(segEnd, buf.length);
  if (segStart + 10 > end) return null;
  const isExif =
    buf[segStart + 4] === 0x45 && buf[segStart + 5] === 0x78 &&
    buf[segStart + 6] === 0x69 && buf[segStart + 7] === 0x66 &&
    buf[segStart + 8] === 0x00 && buf[segStart + 9] === 0x00;
  if (!isExif) return null;

  const tiff = segStart + 10;
  if (tiff + 8 > end) return null;
  const little = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
  const big = buf[tiff] === 0x4d && buf[tiff + 1] === 0x4d;
  if (!little && !big) return null;
  const u16 = (o: number) => (little ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1]);
  const u32 = (o: number) =>
    (little
      ? buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)
      : (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
  if (u16(tiff + 2) !== 0x002a) return null;

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 < tiff || ifd0 + 2 > end) return null;
  // IFD0 holds a few dozen tags in practice. The cap bounds the walk against a
  // declared count that the segment could not possibly contain.
  const entries = Math.min(u16(ifd0), 512);

  let xres: number | null = null;
  // EXIF's default when ResolutionUnit is absent is inches.
  let unit = 2;
  for (let i = 0; i < entries; i++) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > end) break;
    const tag = u16(entry);
    if (tag === 0x011a) {
      if (u16(entry + 2) !== 5) continue; // must be RATIONAL
      const at = tiff + u32(entry + 8);
      if (at < tiff || at + 8 > end) continue;
      const den = u32(at + 4);
      if (den > 0) xres = u32(at) / den;
    } else if (tag === 0x0128) {
      unit = u16(entry + 8);
    }
  }
  if (xres == null) return null;
  if (unit === 2) return plausibleDpi(xres);
  if (unit === 3) return plausibleDpi(xres * 2.54); // px/cm
  return null; // unit 1 = no absolute unit, i.e. a ratio rather than a resolution
}

function parseJpegDensity(buf: Uint8Array): Pick<DeclaredResolution, "dpi" | "source"> {
  let jfif: number | null = null;
  let exif: number | null = null;
  let offset = 2;
  for (let guard = 0; guard < 4096 && offset + 4 <= buf.length; guard++) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    if (marker === 0xff) { offset++; continue; } // fill byte ahead of a marker
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // standalone markers carry no length field
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
    // A length below 2 does not even cover its own field, so the walk cannot
    // advance and nothing after this point can be located.
    if (segLen < 2) break;
    const segEnd = offset + 2 + segLen;
    if (marker === 0xe0 && jfif == null) jfif = readJfifDensity(buf, offset, segEnd);
    if (marker === 0xe1 && exif == null) exif = readExifXResolution(buf, offset, segEnd);
    offset = segEnd;
  }
  // JFIF wins when it declares an absolute density, which keeps every file the
  // old parser already read behaving identically. It must not win merely by
  // being present: sharp writes an aspect-ratio-only APP0 (`units = 0`) beside
  // a real EXIF declaration, and the old parser's early return on the first
  // APP0 is why those files read as declaring nothing.
  if (jfif != null) return { dpi: jfif, source: "jfif" };
  if (exif != null) return { dpi: exif, source: "exif" };
  return { dpi: null, source: null };
}

/**
 * Read a resolution declaration out of a container header.
 *
 * WebP is recognised and answered `dpi: null` rather than falling through to
 * "unknown container": the format has no density field at all, so a caller
 * asking "did this file declare a resolution?" gets a real answer instead of
 * having to guess whether the parser simply did not look.
 */
function parseDpiFromHeader(buf: Uint8Array): DeclaredResolution {
  if (
    buf.length >= 8 &&
    buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71 &&
    buf[4] === 13 && buf[5] === 10 && buf[6] === 26 && buf[7] === 10
  ) {
    return { container: "png", ...parsePngPhys(buf) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    return { container: "jpeg", ...parseJpegDensity(buf) };
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { container: "webp", dpi: null, source: null };
  }
  return UNDECLARED;
}

/**
 * What `file`'s own container bytes declare about physical resolution.
 *
 * Only the first `DPI_HEADER_SNIFF_BYTES` are read. That covers where every
 * format the uploader accepts puts its resolution in practice, but it is not a
 * guarantee — a JPEG can carry enough padding ahead of its EXIF to push the
 * declaration out of reach — and such a file reports as undeclared rather than
 * as a misread.
 */
async function readDeclaredDpi(file: Blob): Promise<DeclaredResolution> {
  try {
    const headerBytes = new Uint8Array(
      await file.slice(0, DPI_HEADER_SNIFF_BYTES).arrayBuffer(),
    );
    return parseDpiFromHeader(headerBytes);
  } catch {
    return UNDECLARED;
  }
}

async function fetchImageDpi(file: File): Promise<number> {
  // Fast path: parse from the header. Falls back to the server only if that fails.
  const declared = await readDeclaredDpi(file);
  if (declared.dpi != null) {
    return Math.min(declared.dpi, EXPORT_DPI);
  }

  try {
    const form = new FormData();
    form.append('image', file);
    const res = await fetch('/api/image-info', { method: 'POST', body: form });
    if (!res.ok) return RASTER_DPI_FALLBACK;
    const data = await res.json();
    const d = Number(data.density);
    if (!Number.isFinite(d) || d <= 0) return RASTER_DPI_FALLBACK;
    return Math.min(d, EXPORT_DPI);
  } catch {
    return RASTER_DPI_FALLBACK;
  }
}

/**
 * Detect PNG artwork that has no real physical-resolution metadata.
 *
 * Transparent PNG artwork is commonly exported as pixel art at print
 * resolution without a pHYs chunk. Sharp reports 72 DPI synthetically for
 * those files, which is not the intended print resolution. This stays
 * separate from fetchImageDpi because the server's 72-DPI fallback is still
 * intentional for ordinary opaque uploads such as JPEGs.
 */
async function isPngWithoutEmbeddedDpi(file: File): Promise<boolean> {
  const declared = await readDeclaredDpi(file);
  return declared.container === "png" && declared.dpi == null;
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

async function injectPngDpi(blob: Blob, dpi: number): Promise<Blob> {
  const ppm = Math.round(dpi / 0.0254);
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf.length < 8) return blob;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return blob;

  const parts: Uint8Array[] = [];
  parts.push(buf.slice(0, 8));

  const ihdrDataLen = readU32(buf, 8);
  const ihdrTotal = 12 + ihdrDataLen;
  parts.push(buf.slice(8, 8 + ihdrTotal));
  let offset = 8 + ihdrTotal;

  const PHYS_DATA_LEN = 9;
  const physChunk = new Uint8Array(4 + 4 + PHYS_DATA_LEN + 4);
  const pv = new DataView(physChunk.buffer);
  pv.setUint32(0, PHYS_DATA_LEN);
  physChunk[4] = 0x70; physChunk[5] = 0x48; physChunk[6] = 0x59; physChunk[7] = 0x73;
  pv.setUint32(8, ppm);
  pv.setUint32(12, ppm);
  physChunk[16] = 1;
  pv.setUint32(17, crc32(physChunk.slice(4, 4 + 4 + PHYS_DATA_LEN)));
  parts.push(physChunk);

  while (offset + 12 <= buf.length) {
    const dataLen = readU32(buf, offset);
    const chunkTotal = 12 + dataLen;
    const isPHYs = buf[offset + 4] === 0x70 && buf[offset + 5] === 0x48 &&
                   buf[offset + 6] === 0x59 && buf[offset + 7] === 0x73;
    if (!isPHYs) parts.push(buf.slice(offset, offset + chunkTotal));
    offset += chunkTotal;
  }

  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(totalLen);
  let writePos = 0;
  for (const part of parts) { out.set(part, writePos); writePos += part.length; }
  return new Blob([out], { type: 'image/png' });
}

type ExportWorkerResult = {
  type?: string;
  error?: string;
  blob?: Blob;
  buffer?: ArrayBuffer;
};

function exportWorkerResultToBlob(data: ExportWorkerResult): Blob {
  if (data.type === 'error') throw new Error(data.error || 'Export failed');
  if (data.blob instanceof Blob) return data.blob;
  if (data.buffer) return new Blob([data.buffer], { type: 'image/png' });
  throw new Error('Export returned no image data');
}

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function getStampExtra(d: { heightInches: number; transform: ImageTransform; printFileName?: boolean }): number {
  if (!d.printFileName) return 0;
  return 0.1 + d.heightInches * d.transform.s * 0.05;
}

function getEffectiveHeight(d: { heightInches: number; transform: ImageTransform; printFileName?: boolean }): number {
  return d.heightInches * d.transform.s + getStampExtra(d);
}

function getRotatedBounds(
  d: { widthInches: number; heightInches: number; transform: ImageTransform; printFileName?: boolean },
): { minX: number; maxX: number; minY: number; maxY: number } {
  const t = d.transform;
  const w = d.widthInches * t.s;
  const h = d.heightInches * t.s;
  const stamp = getStampExtra(d);
  const rad = (t.rotation * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const corners = [
    { x: -w / 2, y: -h / 2 },
    { x:  w / 2, y: -h / 2 },
    { x:  w / 2, y:  h / 2 + stamp },
    { x: -w / 2, y:  h / 2 + stamp },
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    const rx = c.x * cosA - c.y * sinA;
    const ry = c.x * sinA + c.y * cosA;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return { minX, maxX, minY, maxY };
}

/** What `getInkBounds` and `getDesignNestSilhouette` need to look up a design's silhouette. */
type DesignWithArtwork = {
  widthInches: number;
  heightInches: number;
  transform: ImageTransform;
  printFileName?: boolean;
  name?: string;
  imageInfo?: { image?: HTMLImageElement | null } | null;
};

/**
 * A design's ink silhouette, or undefined when the artwork is not available to sample.
 * Shared by the packer (which nests with it) and the bounds helpers below (which validate
 * against it) so the two can never disagree about where a design's artwork is.
 */
function getDesignNestSilhouette(d: DesignWithArtwork): NestMask | undefined {
  const img = d.imageInfo?.image;
  if (!img) return undefined;
  const built = getDesignNestMask({
    image: img,
    artW: d.widthInches * d.transform.s,
    artH: d.heightInches * d.transform.s,
    stampExtra: getStampExtra(d),
    stampText: d.printFileName ? d.name : undefined,
    flipX: d.transform.flipX,
    flipY: d.transform.flipY,
    sourceKey: img.src,
  });
  return built?.mask;
}

/**
 * Bounds of a design's *artwork*, as opposed to `getRotatedBounds`, which returns the whole
 * image box including transparent padding.
 *
 * These are the bounds that decide whether a design is on the sheet and how far it may be
 * dragged. Using the image box for that would make nesting impossible: nested designs
 * deliberately let their empty corners hang over a neighbour or off the edge, and a box-based
 * clamp would haul every one of them back and undo the layout. Falls back to the image box
 * when the artwork cannot be sampled, which is the conservative direction.
 */
function getInkBounds(
  d: DesignWithArtwork,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const mask = getDesignNestSilhouette(d);
  if (!mask) return getRotatedBounds(d);
  const t = d.transform;
  const w = d.widthInches * t.s;
  const h = d.heightInches * t.s;
  const stamp = getStampExtra(d);
  const inset = inkInset(mask, w, h + stamp, 0);
  const rad = (t.rotation * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const left = -w / 2 + inset.left;
  const right = w / 2 - inset.right;
  const top = -h / 2 + inset.top;
  const bottom = h / 2 + stamp - inset.bottom;
  const corners = [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    const rx = c.x * cosA - c.y * sinA;
    const ry = c.x * sinA + c.y * cosA;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Vertical band the sheet's artwork occupies, in artboard inches measured from the top edge.
 *
 * Ink, not the image box: a nested sheet's lowest design may have transparent padding hanging
 * below its last printed pixel, and billing film for that padding would charge the customer
 * for blank material.
 */
function getContentInkBandY(
  designs: DesignWithArtwork[],
  artboardHeight: number,
): InkBand | null {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const d of designs) {
    const bounds = getInkBounds(d);
    const cy = d.transform.ny * artboardHeight;
    if (cy + bounds.minY < minY) minY = cy + bounds.minY;
    if (cy + bounds.maxY > maxY) maxY = cy + bounds.maxY;
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
  return { minY, maxY };
}

/**
 * The smallest purchasable height that fits the artwork currently on the sheet, plus the
 * measurements that got us there.
 *
 * Single source of truth for two features that must never disagree: the "current bounds" hint
 * in the size dropdown, and auto-shrink. If they sized the sheet separately, the hint could
 * advertise a size that shrinking then declined to apply.
 */
function fitGangsheetHeight(
  designs: DesignWithArtwork[],
  artboardHeight: number,
  designGap: number | undefined,
  heights: number[],
): { height: number; band: InkBand; margin: number } | null {
  if (designs.length === 0) return null;
  const band = getContentInkBandY(designs, artboardHeight);
  if (!band) return null;
  // The setting is one number standing in for two different physical quantities. As the gap
  // *between* designs, 0 is a legitimate choice. As the margin at the *sheet edge* it is not —
  // flush ink is a DTF production risk — so the sheet-edge reading is floored, and named
  // separately from `designGap` to keep the two legible as the different things they are.
  const sheetEdgeMargin = Math.max(designGap ?? DEFAULT_SHEET_MARGIN, DEFAULT_SHEET_MARGIN);
  const height = fitHeightForBand(band.maxY - band.minY, sheetEdgeMargin, heights);
  if (height === null) return null;
  return { height, band, margin: sheetEdgeMargin };
}

function clampDesignToArtboard(
  d: DesignWithArtwork,
  abW: number, abH: number,
): { nx: number; ny: number } {
  const t = d.transform;
  const { minX, maxX, minY, maxY } = getInkBounds(d);
  const minNx = -minX / abW;
  const maxNx = 1 - maxX / abW;
  const minNy = -minY / abH;
  const maxNy = 1 - maxY / abH;
  let nx = t.nx;
  let ny = t.ny;
  if (minNx <= maxNx) {
    nx = Math.max(minNx, Math.min(maxNx, nx));
  }
  if (minNy <= maxNy) {
    ny = Math.max(minNy, Math.min(maxNy, ny));
  }
  return { nx, ny };
}

export type DesignSelectionUnit = {
  key: string;
  members: Array<{
    id: string;
    widthInches: number;
    heightInches: number;
    transform: ImageTransform;
    printFileName?: boolean;
    groupId?: string;
  }>;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

/**
 * Return selected designs as transform units. A group is always expanded to
 * all of its members, even if a stale caller passes only one member id. This
 * is the same super-item model used by auto-arrange and prevents tools from
 * accidentally moving one layer out of a group.
 */
function getDesignSelectionUnits(
  designs: DesignSelectionUnit["members"],
  ids: Set<string>,
  artboardWidth: number,
  artboardHeight: number,
): DesignSelectionUnit[] {
  const selectedGroupIds = new Set(
    designs
      .filter(d => ids.has(d.id) && d.groupId)
      .map(d => d.groupId as string),
  );
  const byKey = new Map<string, DesignSelectionUnit>();

  for (const d of designs) {
    const selected = ids.has(d.id) || (d.groupId ? selectedGroupIds.has(d.groupId) : false);
    if (!selected) continue;
    const key = d.groupId ? `group:${d.groupId}` : `design:${d.id}`;
    const bounds = getRotatedBounds(d);
    const cx = d.transform.nx * artboardWidth;
    const cy = d.transform.ny * artboardHeight;
    const minX = cx + bounds.minX;
    const maxX = cx + bounds.maxX;
    const minY = cy + bounds.minY;
    const maxY = cy + bounds.maxY;
    const unit = byKey.get(key);
    if (unit) {
      unit.members.push(d);
      unit.minX = Math.min(unit.minX, minX);
      unit.maxX = Math.max(unit.maxX, maxX);
      unit.minY = Math.min(unit.minY, minY);
      unit.maxY = Math.max(unit.maxY, maxY);
    } else {
      byKey.set(key, {
        key,
        members: [d],
        minX,
        maxX,
        minY,
        maxY,
      });
    }
  }
  return Array.from(byKey.values());
}

function getDesignSelectionBounds(
  designs: DesignSelectionUnit["members"],
  ids: Set<string>,
  artboardWidth: number,
  artboardHeight: number,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const units = getDesignSelectionUnits(designs, ids, artboardWidth, artboardHeight);
  if (units.length === 0) return null;
  return units.reduce(
    (bounds, unit) => ({
      minX: Math.min(bounds.minX, unit.minX),
      maxX: Math.max(bounds.maxX, unit.maxX),
      minY: Math.min(bounds.minY, unit.minY),
      maxY: Math.max(bounds.maxY, unit.maxY),
    }),
    {
      minX: Infinity,
      maxX: -Infinity,
      minY: Infinity,
      maxY: -Infinity,
    },
  );
}

/**
 * Rotate a complete selection around its combined bounding-box center.
 * Group members keep their groupId and their relative geometry; only the
 * selection translation and each member's visual rotation change.
 */
function rotateDesignSelection(
  designs: DesignSelectionUnit["members"],
  ids: Set<string>,
  angleDeg: number,
  artboardWidth: number,
  artboardHeight: number,
): Map<string, { nx: number; ny: number; rotation: number }> | null {
  const targets = designs.filter(d => ids.has(d.id) || (d.groupId && designs.some(
    member => ids.has(member.id) && member.groupId === d.groupId,
  )));
  const bounds = getDesignSelectionBounds(
    designs,
    ids,
    artboardWidth,
    artboardHeight,
  );
  if (targets.length === 0 || !bounds) return new Map();

  // Selection bounds are already expressed in artboard pixels.
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const candidates = targets.map(d => {
    const px = d.transform.nx * artboardWidth - centerX;
    const py = d.transform.ny * artboardHeight - centerY;
    return {
      d,
      nx: (centerX + px * cos - py * sin) / artboardWidth,
      ny: (centerY + px * sin + py * cos) / artboardHeight,
      rotation: ((d.transform.rotation + angleDeg) % 360 + 360) % 360,
    };
  });

  let nextMinX = Infinity;
  let nextMaxX = -Infinity;
  let nextMinY = Infinity;
  let nextMaxY = -Infinity;
  for (const { d, nx, ny, rotation } of candidates) {
    const next = {
      ...d,
      transform: { ...d.transform, nx, ny, rotation },
    };
    const nextBounds = getRotatedBounds(next);
    const cx = nx * artboardWidth;
    const cy = ny * artboardHeight;
    nextMinX = Math.min(nextMinX, cx + nextBounds.minX);
    nextMaxX = Math.max(nextMaxX, cx + nextBounds.maxX);
    nextMinY = Math.min(nextMinY, cy + nextBounds.minY);
    nextMaxY = Math.max(nextMaxY, cy + nextBounds.maxY);
  }

  if (
    nextMinX < 0 ||
    nextMaxX > artboardWidth ||
    nextMinY < 0 ||
    nextMaxY > artboardHeight
  ) {
    return null;
  }
  return new Map(candidates.map(({ d, nx, ny, rotation }) => [
    d.id,
    { nx, ny, rotation },
  ]));
}

export let exportReqCounter = 0;
export let arrangeReqCounter = 0;
export function nextExportRequestId() { return ++exportReqCounter; }
export function nextArrangeRequestId() { return ++arrangeReqCounter; }
