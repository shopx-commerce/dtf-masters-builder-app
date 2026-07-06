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
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const longEdge = Math.max(w, h);
  if (dpi >= 290 && longEdge > 0 && longEdge <= 2200) return RASTER_DPI_FALLBACK;
  return dpi;
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
  injectPngDpi,
  clampDesignToArtboard,
  getRotatedBounds,
  getEffectiveHeight,
  getStampExtra,
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

async function fetchImageDpi(file: File): Promise<number> {
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

export let exportReqCounter = 0;
export let arrangeReqCounter = 0;
export function nextExportRequestId() { return ++exportReqCounter; }
export function nextArrangeRequestId() { return ++arrangeReqCounter; }
