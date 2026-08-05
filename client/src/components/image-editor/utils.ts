import { hasCleanAlpha } from "@/lib/image-crop";
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

function normalizeRasterDpiForInches(dpi: number, image: HTMLImageElement): number {
  const normalized = Number.isFinite(dpi) && dpi > 0 ? dpi : RASTER_DPI_FALLBACK;
  return Math.min(normalized, EXPORT_DPI);
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

export function canUseMemoryEfficientPngExport(): boolean {
  return typeof Worker !== "undefined"
    && typeof OffscreenCanvas !== "undefined"
    && typeof createImageBitmap === "function"
    && typeof CompressionStream !== "undefined";
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
  alphaThresholded?: boolean;
  printFileName?: boolean;
  name?: string;
};

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

  const designPayload: Array<{
    widthInches: number;
    heightInches: number;
    nx: number;
    ny: number;
    s: number;
    rotation: number;
    flipX?: boolean;
    flipY?: boolean;
    imageBuffer: ArrayBuffer;
    alphaThresholded?: boolean;
    printFileName?: boolean;
    name?: string;
  }> = [];
  for (const design of options.designs) {
    const imageBuffer = await imageToExportBuffer(design.image);
    designPayload.push({
      widthInches: design.widthInches,
      heightInches: design.heightInches,
      nx: design.nx,
      ny: design.ny,
      s: design.s,
      rotation: design.rotation,
      flipX: design.flipX,
      flipY: design.flipY,
      imageBuffer,
      alphaThresholded: design.alphaThresholded,
      printFileName: design.printFileName,
      name: design.name,
    });
  }

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
      const transferables = designPayload.map((design) => design.imageBuffer);
      worker.postMessage(
        {
          type: "export",
          requestId,
          designs: designPayload,
          outW: options.outW,
          outH: options.outH,
          exportDpi: options.exportDpi,
        },
        transferables,
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

function clampDesignToArtboard(
  d: { widthInches: number; heightInches: number; transform: ImageTransform; printFileName?: boolean },
  abW: number, abH: number,
): { nx: number; ny: number } {
  const t = d.transform;
  const { minX, maxX, minY, maxY } = getRotatedBounds(d);
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
