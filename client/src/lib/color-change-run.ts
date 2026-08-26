/**
 * The color change itself, independent of where it runs.
 *
 * Two callers share this: the worker, which is where it runs in a browser, and
 * the main-thread fallback for environments without workers. Keeping the policy
 * in one place is what stops the two from drifting into subtly different
 * answers about the same file.
 *
 * The policy is: stream it (constant memory, any size), and fall back to the
 * whole-image decoder only for files the streaming reader cannot walk —
 * interlaced PNGs, and browsers missing the compression streams. The fallback
 * keeps its old ceilings, because those ceilings are a property of decoding an
 * image into one buffer, not of the feature.
 */

// Imported statically, not on demand: this module is the worker's entry point,
// and the worker bundle is a single IIFE, so a dynamic import here fails the
// build rather than splitting a chunk.
import { analyzeColorChangePng, recolorPng } from "./color-change-core";
import type { ColorChangeAnalysis, ColorChangeReason, RgbColor, SourceCrop } from "./color-change-core";
import { COLOR_CHANGE_MAX_SOURCE_BYTES } from "./color-change-limits";
import type { InkModel } from "./ink-model";
import { canStreamRecolor, streamAnalyzePng, streamRecolorPng } from "./png-recolor-stream";

/**
 * Recoloured output is a Blob rather than bytes.
 *
 * The streaming encoder produces the file as a list of blob parts it never
 * concatenates, so the result can be handed on — posted from the worker, stored
 * as the print source — without the whole PNG ever existing as one array.
 */
export type ColorChangeRecolorResult =
  | { ok: true; blob: Blob; sourceColor: RgbColor; width: number; height: number }
  | { ok: false; reason: ColorChangeReason };

export interface ColorChangeRunOptions {
  signal?: AbortSignal;
  /** Fraction of the source rows processed, from 0 to 1. */
  onProgress?: (fraction: number) => void;
}

async function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function runColorChangeAnalyze(
  blob: Blob,
  crop?: SourceCrop,
  options?: ColorChangeRunOptions,
): Promise<ColorChangeAnalysis> {
  if (canStreamRecolor()) {
    const streamed = await streamAnalyzePng(blob, crop, options);
    if (streamed) return streamed;
  }
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { eligible: false, reason: "image-too-large" };
  return analyzeColorChangePng(await readBytes(blob), crop);
}

export async function runColorChangeRecolor(
  blob: Blob,
  target: RgbColor,
  crop?: SourceCrop,
  options?: ColorChangeRunOptions,
  /** The model a prior analysis of this same source resolved, when there is one. */
  model?: InkModel,
): Promise<ColorChangeRecolorResult> {
  if (canStreamRecolor()) {
    const streamed = await streamRecolorPng(blob, target, crop, options, model);
    if (streamed) return streamed;
  }
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { ok: false, reason: "image-too-large" };
  const result = recolorPng(await readBytes(blob), target, crop);
  if (!result.ok) return result;
  return {
    ok: true,
    blob: new Blob([result.png], { type: "image/png" }),
    sourceColor: result.sourceColor,
    width: result.width,
    height: result.height,
  };
}
