import { hasCleanAlpha } from "@/lib/image-crop";
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

function inchesFromPixelsPair(pw: number, ph: number, dpi: number): { widthInches: number; heightInches: number } {
  const wIn = pw / dpi;
  const hIn = wIn * (ph / pw);
  return {
    widthInches: Math.max(0.01, parseFloat(wIn.toFixed(4))),
    heightInches: Math.max(0.01, parseFloat(hIn.toFixed(4))),
  };
}

function normalizeRasterDpiForInches(dpi: number): number {
  const normalized = Number.isFinite(dpi) && dpi > 0 ? dpi : RASTER_DPI_FALLBACK;
  return Math.min(normalized, EXPORT_DPI);
}

/**
 * The design's print-source pixels as an `ImageBitmap`, at about
 * `targetW` × `targetH`.
 *
 * Used to recover the full-resolution artwork behind a preview that has been
 * downsampled for editor memory (`MAX_STORED_IMAGE_DIMENSION`) — e.g. to
 * rebuild a halftone from its un-screened source, or to run a pixel edit
 * against print resolution instead of the capped preview.
 *
 * `crop` is `exportCrop`: when set, `blob` is an uncropped original and only
 * that content box should be decoded. Returns `null` when the platform lacks
 * `createImageBitmap` or the decode fails — callers should fall back to the
 * preview in that case.
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

function imageHasCleanAlpha(img: HTMLImageElement): boolean {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  return hasCleanAlpha(data, width, height);
}

export {
  inchesFromPixelsPair,
  normalizeRasterDpiForInches,
  imageHasCleanAlpha,
  fetchImageDpi,
  isPngWithoutEmbeddedDpi,
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

let _arrangeWorker: Worker | null = null;
export function getArrangeWorker(): Worker | null {
  if (!_arrangeWorker) {
    try { _arrangeWorker = new ArrangeWorkerModule(); }
    catch { return null; }
  }
  return _arrangeWorker;
}

/**
 * Kill the shared arrange worker so the next arrange spawns a fresh one.
 *
 * Packing only overruns its deadline on a device that is already struggling, and the caller
 * answers a timeout by packing the same sheet again on the main thread. Left alive, the
 * abandoned worker would keep a core busy on a layout nobody will read for as long as the
 * fallback takes — turning one slow arrange into a frozen tab on exactly the hardware that
 * could least afford it.
 */
export function discardArrangeWorker(): void {
  const worker = _arrangeWorker;
  _arrangeWorker = null;
  if (worker) {
    try { worker.terminate(); } catch { /* worker already dead */ }
  }
}

// Reads DPI metadata from PNG/JPEG headers, if present.
function parseDpiFromHeader(buf: Uint8Array): number | null {
  const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
  let isPng = buf.length >= 8;
  for (let i = 0; i < pngSig.length && isPng; i++) if (buf[i] !== pngSig[i]) isPng = false;
  if (isPng) {
    let offset = 8;
    while (offset + 12 <= buf.length) {
      const len = readU32(buf, offset);
      const isPHYs = buf[offset + 4] === 0x70 && buf[offset + 5] === 0x48 &&
                     buf[offset + 6] === 0x59 && buf[offset + 7] === 0x73;
      const isIdatOrEnd =
        (buf[offset + 4] === 0x49 && buf[offset + 5] === 0x44 && buf[offset + 6] === 0x41 && buf[offset + 7] === 0x54) ||
        (buf[offset + 4] === 0x49 && buf[offset + 5] === 0x45 && buf[offset + 6] === 0x4e && buf[offset + 7] === 0x44);
      if (isPHYs) {
        const dataStart = offset + 8;
        const ppuX = readU32(buf, dataStart);
        const unit = buf[dataStart + 8]; // 1 = metre
        if (unit === 1 && ppuX > 0) return Math.round(ppuX * 0.0254); // px/metre -> px/inch
        return null;
      }
      if (isIdatOrEnd) break;
      offset += 12 + len;
    }
    return null;
  }

  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break; // EOI / start of scan
      const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
      if (marker === 0xe0 && offset + 18 <= buf.length) {
        const isJfif = buf[offset + 4] === 0x4a && buf[offset + 5] === 0x46 &&
                       buf[offset + 6] === 0x49 && buf[offset + 7] === 0x46 && buf[offset + 8] === 0x00;
        if (isJfif) {
          const units = buf[offset + 11]; // 1 = dpi, 2 = dpcm, 0 = aspect only
          const xDensity = (buf[offset + 12] << 8) | buf[offset + 13];
          if (xDensity > 0) {
            if (units === 1) return xDensity;
            if (units === 2) return Math.round(xDensity * 2.54);
          }
          return null;
        }
      }
      offset += 2 + segLen;
    }
    return null;
  }

  return null;
}

async function fetchImageDpi(file: File): Promise<number> {
  // Fast path: parse from the header. Falls back to the server only if that fails.
  try {
    const headerBytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const headerDpi = parseDpiFromHeader(headerBytes);
    if (headerDpi && Number.isFinite(headerDpi) && headerDpi > 0) {
      return Math.min(headerDpi, EXPORT_DPI);
    }
  } catch {
    // fall through to the server round-trip
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
  try {
    const headerBytes = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    const pngSig = [137, 80, 78, 71, 13, 10, 26, 10];
    if (headerBytes.length < pngSig.length) return false;
    for (let i = 0; i < pngSig.length; i++) {
      if (headerBytes[i] !== pngSig[i]) return false;
    }
    return parseDpiFromHeader(headerBytes) == null;
  } catch {
    return false;
  }
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
