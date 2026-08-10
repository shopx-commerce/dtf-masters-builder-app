import type { DesignItem } from "./types";

export const LAYER_ASSET_MIME = "image/png";

/** Session-unique so tokens minted in one edit session can never collide with another's keys. */
const SESSION_PREFIX = Math.random().toString(36).slice(2, 8);
const tokens = new WeakMap<HTMLImageElement, string>();
let tokenCounter = 0;

/** The bitmap a layer stores: halftoned layers keep their pre-screen source so restore re-screens once. */
function layerBitmapSource(design: DesignItem): HTMLImageElement {
  return design.halftoned
    ? design.halftoneSourceImage ?? design.imageInfo.image
    : design.imageInfo.image;
}

/** Stable id for a layer's current pixels — every pixel edit swaps in a new image element. */
export function layerContentToken(design: DesignItem): string {
  const image = layerBitmapSource(design);
  const existing = tokens.get(image);
  if (existing) return existing;
  const token = `${SESSION_PREFIX}${(++tokenCounter).toString(36)}`;
  tokens.set(image, token);
  return token;
}

/** Filesystem-safe stem for a layer asset's object key and filename. */
export function layerAssetStem(design: DesignItem, fallback: string): string {
  const stem = String(design.name || "")
    .replace(/\.[^./\\]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return stem || fallback;
}

function drawLayerBitmap(design: DesignItem): HTMLCanvasElement {
  const image = layerBitmapSource(design);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error("Layer bitmap not ready");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.drawImage(image, 0, 0);
  return canvas;
}

/** Re-encodes a layer's processed pixels so a stored asset matches what the export draws. */
export function layerBitmapToPngBlob(design: DesignItem): Promise<Blob> {
  const canvas = drawLayerBitmap(design);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      canvas.width = 0;
      canvas.height = 0;
      if (blob) resolve(blob);
      else reject(new Error("Layer encode failed"));
    }, LAYER_ASSET_MIME);
  });
}
