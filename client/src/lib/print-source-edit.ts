/**
 * Applies an editor pixel edit to a design's *print source*, not just its
 * on-screen preview.
 *
 * Why this exists
 * ---------------
 * A design carries two representations: `image`, the downscaled preview the
 * editor canvas draws, and a separate high-resolution print source — either
 * `exportBlob` or retained vector geometry (`svgSource` / `originalPdfData`)
 * that gets re-rasterised at placement size. Export prefers the print source,
 * and deliberately ignores `image`.
 *
 * Editing tools used to write their result to `image` alone. The customer saw
 * the edit applied, but export went back to the untouched print source and
 * printed the original — a white background removed on screen would reappear
 * on the printed sheet.
 *
 * Rather than demote the edited preview to being the print source (correct, but
 * it would drop a 20 inch design from 300 DPI to roughly 100), the edit is
 * re-run here against the full-resolution source and the preview is derived
 * from that result. One edit pass, print keeps its resolution, and what is on
 * screen is guaranteed to be what prints because both come from the same
 * pixels.
 */

import { fitWithinMegapixels } from "./image-budget";
import { encodeCanvasToPng } from "./png-encoder";
import { VECTOR_TARGET_DPI, vectorExportMaxEdge } from "./vector-raster-limits";
import { createVectorPrintSourceResolver, hasVectorPrintSource } from "./vector-print-source";
import type { ImageInfo } from "./types";

/**
 * Memory ceiling for a single edit. The edit needs the canvas, a copy for
 * `getImageData`, and the worker's copy live at once, so this is roughly 3x
 * this many pixels in RAM. 40 MP covers a 300 DPI design of about 22 x 20
 * inches — larger than anything that fits a gangsheet width.
 */
const PIXEL_EDIT_MAX_MEGAPIXELS = 40;

/**
 * Mutates the canvas in place, or returns a replacement canvas when the edit
 * changes dimensions (a crop, for instance).
 */
export type CanvasPixelEdit = (
  canvas: HTMLCanvasElement,
) => void | HTMLCanvasElement | Promise<void | HTMLCanvasElement>;

export interface EditedPrintSource {
  /** Full-resolution edited pixels — the design's new print source. */
  exportBlob: Blob;
  /** Preview-sized copy of the same pixels, for the editor canvas. */
  previewImage: HTMLImageElement;
  /**
   * `exportBlob` as a `File`, which is what a draft save has to persist.
   *
   * A draft stores exactly one blob per design and it must be the *uncapped*
   * one: restore decodes it as the print source and derives its own capped
   * preview from it (see `draft-preview-cap.ts`). Persisting the preview instead
   * silently discards whatever resolution the edit produced — measured on an
   * upscale, a design went to 1784 x 1680 at 144 DPI, was saved as its 892 x 840
   * preview, and came back from recovery at 892 x 840 still claiming 144 DPI.
   *
   * It frames the artwork identically to `previewImage`, which restore relies on:
   * both are the same canvas, only the pixel count differs.
   */
  printSourceFile: File;
  /**
   * PNG of the preview. Not what gets persisted — see `printSourceFile`.
   */
  previewFile: File;
  sourceWidth: number;
  sourceHeight: number;
  /** True print DPI of `exportBlob` across the design's physical width. */
  dpi: number;
}

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode edited pixels.")); };
    img.src = url;
  });
}

/**
 * Encoding runs in a worker. It is by far the most expensive step of an edit —
 * on a 4096 x 4096 print source it was 2.2s of a 3.6s magic-wand tap — and
 * doing it on the main thread froze the editor for its whole duration.
 */
const toBlob = encodeCanvasToPng;

/**
 * Decodes the design's print source onto a canvas at the resolution the edit
 * should run at: 300 DPI for its physical size, clamped by the platform canvas
 * ceiling and the memory budget, and never upscaled past what the source
 * actually contains.
 */
async function drawPrintSourceToCanvas(
  info: ImageInfo,
  widthInches: number,
  heightInches: number,
): Promise<HTMLCanvasElement | null> {
  let wantW = Math.round(Math.max(1, widthInches) * VECTOR_TARGET_DPI);
  let wantH = Math.round(Math.max(1, heightInches) * VECTOR_TARGET_DPI);

  const edgeCap = vectorExportMaxEdge();
  const edgeScale = Math.min(edgeCap / Math.max(wantW, wantH), 1);
  const mpScale = fitWithinMegapixels(wantW, wantH, PIXEL_EDIT_MAX_MEGAPIXELS);
  const scale = Math.min(edgeScale, mpScale);
  if (scale < 1) {
    wantW = Math.max(1, Math.round(wantW * scale));
    wantH = Math.max(1, Math.round(wantH * scale));
  }

  let source: ImageBitmap | HTMLImageElement | null = null;
  let close: (() => void) | undefined;

  if (hasVectorPrintSource(info)) {
    const blob = await createVectorPrintSourceResolver().resolve(info, wantW, wantH);
    if (blob) {
      const bmp = await createImageBitmap(blob);
      source = bmp;
      close = () => bmp.close();
    }
  } else if (info.exportBlob) {
    const crop = info.exportCrop;
    // Decode at natural size and let the canvas do the fit — the edit wants
    // every pixel the print source has, up to the caps above. `from-image`
    // keeps the crop rect in the same oriented space it was measured in; see
    // the note on `ORIENT_FROM_IMAGE` in `image-editor/utils.ts`.
    const orient: ImageBitmapOptions = { imageOrientation: "from-image" };
    const bmp = crop
      ? await createImageBitmap(info.exportBlob, crop.x, crop.y, crop.width, crop.height, orient)
      : await createImageBitmap(info.exportBlob, orient);
    source = bmp;
    close = () => bmp.close();
  }

  if (!source) return null;

  const srcW = "width" in source ? source.width : 0;
  const srcH = "height" in source ? source.height : 0;
  if (!srcW || !srcH) { close?.(); return null; }

  // Never invent resolution the source does not have.
  const outW = Math.min(wantW, srcW);
  const outH = Math.min(wantH, srcH);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) { close?.(); return null; }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, srcW, srcH, 0, 0, outW, outH);
  close?.();
  return canvas;
}

function downscaleToPreview(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(maxEdge / Math.max(source.width, source.height), 1);
  if (scale >= 1) return source;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Runs `edit` against the design's full-resolution print source.
 *
 * Returns `null` when the design has no separate print source — its preview
 * already *is* the print source, so the caller's existing preview-only edit is
 * correct and should be used unchanged.
 */
export async function applyEditAtPrintResolution(
  info: ImageInfo,
  widthInches: number,
  heightInches: number,
  edit: CanvasPixelEdit,
): Promise<EditedPrintSource | null> {
  const rendered = await drawPrintSourceToCanvas(info, widthInches, heightInches).catch(err => {
    console.warn("[print-source-edit] could not decode print source", err);
    return null;
  });
  if (!rendered) return null;

  // Pixels per inch of the render, captured before the edit runs. Taking it
  // from the finished canvas would misreport any edit that changes dimensions:
  // cropping a 20 inch design in half leaves a smaller canvas at the same DPI.
  const renderedDpi = rendered.width / Math.max(widthInches, 0.01);

  const replacement = await edit(rendered);
  const canvas = replacement instanceof HTMLCanvasElement ? replacement : rendered;
  if (canvas !== rendered) {
    rendered.width = 0;
    rendered.height = 0;
  }

  // Keep the preview at whatever size it already was, so applying an edit
  // never changes how sharp the design looks on the editor canvas.
  const previewMaxEdge = Math.max(
    1,
    Math.max(info.image?.naturalWidth || info.image?.width || 0, info.image?.naturalHeight || info.image?.height || 0),
  );
  const previewCanvas = downscaleToPreview(canvas, previewMaxEdge);

  // The two encodes are independent, so overlap them rather than paying the
  // sum. Both still finish before the edit is handed back, which keeps the
  // print source and what is on screen guaranteed to be the same pixels.
  const [exportBlob, encodedPreview] = await Promise.all([
    toBlob(canvas),
    previewCanvas === canvas ? Promise.resolve(null) : toBlob(previewCanvas),
  ]);
  const previewBlob = encodedPreview ?? exportBlob;
  const previewImage = await blobToImage(previewBlob);

  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  if (previewCanvas !== canvas) {
    previewCanvas.width = 0;
    previewCanvas.height = 0;
  }
  canvas.width = 0;
  canvas.height = 0;

  const baseName = (info.file?.name || "design").replace(/\.[^.]+$/, "");
  return {
    exportBlob,
    previewImage,
    printSourceFile: new File([exportBlob], `${baseName}.png`, { type: "image/png" }),
    previewFile: new File([previewBlob], `${baseName}.png`, { type: "image/png" }),
    sourceWidth,
    sourceHeight,
    dpi: Math.max(1, Math.min(VECTOR_TARGET_DPI, Math.round(renderedDpi))),
  };
}

/**
 * Runs `edit` against a design whose preview *is* its only source.
 *
 * The companion to `applyEditAtPrintResolution` returning `null`. Most edits
 * can simply fall back to their own preview-only path in that case, but an
 * upscale cannot: its whole purpose is to produce more pixels than the source
 * had, so the result still has to be promoted to the print source. The preview
 * is then capped at `previewMaxEdge` rather than allowed to inherit the new
 * size, which keeps the editor's in-memory buffer bounded.
 */
export async function applyEditToPreviewSource(
  info: ImageInfo,
  previewMaxEdge: number,
  edit: CanvasPixelEdit,
): Promise<EditedPrintSource | null> {
  const source = info.image;
  const width = source?.naturalWidth || source?.width || 0;
  const height = source?.naturalHeight || source?.height || 0;
  if (!width || !height) return null;

  const rendered = document.createElement("canvas");
  rendered.width = width;
  rendered.height = height;
  const ctx = rendered.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);

  const replacement = await edit(rendered);
  const canvas = replacement instanceof HTMLCanvasElement ? replacement : rendered;
  if (canvas !== rendered) {
    rendered.width = 0;
    rendered.height = 0;
  }

  const previewCanvas = downscaleToPreview(canvas, previewMaxEdge);
  const [exportBlob, encodedPreview] = await Promise.all([
    toBlob(canvas),
    previewCanvas === canvas ? Promise.resolve(null) : toBlob(previewCanvas),
  ]);
  const previewBlob = encodedPreview ?? exportBlob;
  const previewImage = await blobToImage(previewBlob);

  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  if (previewCanvas !== canvas) {
    previewCanvas.width = 0;
    previewCanvas.height = 0;
  }
  canvas.width = 0;
  canvas.height = 0;

  const baseName = (info.file?.name || "design").replace(/\.[^.]+$/, "");
  return {
    exportBlob,
    previewImage,
    printSourceFile: new File([exportBlob], `${baseName}.png`, { type: "image/png" }),
    previewFile: new File([previewBlob], `${baseName}.png`, { type: "image/png" }),
    sourceWidth,
    sourceHeight,
    dpi: info.dpi,
  };
}

/**
 * The `ImageInfo` fields to apply after an edit has been committed to the print
 * source. The vector sources must be cleared: they take priority at export, so
 * leaving them in place would re-rasterise the original artwork and throw the
 * edit away — exactly the bug this module exists to fix.
 *
 * `file` and `exportBlob` are two views of the same PNG, matching what the
 * upload path does for a prepared raster: `file` is the blob a draft persists
 * and `exportBlob` is what export reads, and there is no reason for those to be
 * different pixels.
 */
export function printSourceFieldsAfterEdit(edited: EditedPrintSource): Partial<ImageInfo> {
  return {
    image: edited.previewImage,
    file: edited.printSourceFile,
    exportBlob: edited.exportBlob,
    exportCrop: undefined,
    svgSource: undefined,
    originalPdfData: undefined,
    vectorInkBox: undefined,
    dpi: edited.dpi,
  };
}
