/**
 * Bounds the preview a draft restore rebuilds.
 *
 * A design carries two representations: `image`, the preview the editor canvas
 * draws, capped at `MAX_STORED_IMAGE_DIMENSION` on upload, and `file`, the
 * full-resolution print source. A draft persists one blob per design, and that
 * blob is deliberately the uncapped one so print resolution survives recovery —
 * which leaves restore holding a decoded preview far larger than the session
 * that saved it (a 4096 px prepared preview is ~67 MB of RGBA against the much
 * smaller size the editor budgeted, per design).
 *
 * So restore mirrors the upload path instead: `image` is capped the same way,
 * and the caller keeps the original blob as the print source, so the export
 * path still has every pixel it had before the reload.
 */

import { MAX_STORED_IMAGE_DIMENSION } from "@/components/image-editor/constants";

export interface CappedRestoredPreview {
  image: HTMLImageElement;
  /** Uncapped pixels `image` was derived from — the design's print source. */
  exportBlob: Blob;
  width: number;
  height: number;
}

function decodeBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not decode capped preview")); };
    image.src = url;
  });
}

export async function capRestoredPreview(
  image: HTMLImageElement,
  blob: Blob,
  opts?: {
    /**
     * Whether the artwork has 1-bit alpha. Matches the upload path (and the
     * preview renderer), which turn smoothing off for cut-out and halftoned
     * artwork so the resample cannot soften its edges.
     */
    preserveCleanAlpha?: boolean;
  },
): Promise<CappedRestoredPreview> {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const longestEdge = Math.max(width, height);
  if (!width || !height || longestEdge <= MAX_STORED_IMAGE_DIMENSION) {
    return { image, exportBlob: blob, width, height };
  }

  const scale = MAX_STORED_IMAGE_DIMENSION / longestEdge;
  const cappedWidth = Math.max(1, Math.round(width * scale));
  const cappedHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cappedWidth;
  canvas.height = cappedHeight;
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return { image, exportBlob: blob, width, height };
    context.imageSmoothingEnabled = !opts?.preserveCleanAlpha;
    if (!opts?.preserveCleanAlpha) context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, cappedWidth, cappedHeight);
    const capped = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
    if (!capped) return { image, exportBlob: blob, width, height };
    return {
      image: await decodeBlob(capped),
      exportBlob: blob,
      width: cappedWidth,
      height: cappedHeight,
    };
  } catch (error) {
    // A failed cap is a memory concern, not a correctness one: the uncapped
    // preview frames the artwork identically, so fall back to it.
    console.warn("[editor-draft] could not cap restored preview", error);
    return { image, exportBlob: blob, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
