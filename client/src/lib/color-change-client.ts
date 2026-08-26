import ColorChangeWorker from "./color-change-worker?worker";
import type { ColorChangeAnalysis, RgbColor, SourceCrop } from "./color-change-core";
import type { ColorChangeRecolorResult } from "./color-change-run";
import type { InkModel } from "./ink-model";
import type {
  ColorChangeWorkerRequest,
  ColorChangeWorkerResponse,
} from "./color-change-worker";

/**
 * The worker is given a stall budget, not a completion budget.
 *
 * How long a recolour takes depends on the artwork and the phone, and a
 * deadline guessed from the file size will always be wrong in one direction or
 * the other: too short and a job that was progressing fine is killed, too long
 * and a stuck worker spins for minutes. Since the worker now reports rows as it
 * goes, silence is the only real symptom of a hang — so the clock is reset by
 * every progress message and only fires when nothing has happened at all.
 */
const JOB_STALL_TIMEOUT_MS = 90_000;

/** Thrown when the caller aborts a job; callers should stay silent about it. */
export class ColorChangeAbortError extends Error {
  constructor() {
    super("Color change aborted.");
    this.name = "AbortError";
  }
}

export function isColorChangeAbort(error: unknown): boolean {
  return error instanceof ColorChangeAbortError || (error instanceof Error && error.name === "AbortError");
}

export type ColorChangeProgress = (fraction: number) => void;

let nextJobId = 1;

async function runWorker(
  request: ColorChangeWorkerRequest,
  signal?: AbortSignal,
  onProgress?: ColorChangeProgress,
): Promise<ColorChangeWorkerResponse> {
  if (signal?.aborted) throw new ColorChangeAbortError();

  if (typeof Worker === "undefined") {
    const run = await import("./color-change-run");
    if (request.kind === "analyze") {
      return {
        id: request.id,
        kind: "analyze",
        result: await run.runColorChangeAnalyze(request.blob, request.crop, { signal, onProgress }),
      };
    }
    return {
      id: request.id,
      kind: "recolor",
      result: await run.runColorChangeRecolor(
        request.blob,
        request.target,
        request.crop,
        { signal, onProgress },
        request.model,
      ),
    };
  }

  const worker = new ColorChangeWorker();
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const arm = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        finish();
        reject(new Error("Color change timed out."));
      }, JOB_STALL_TIMEOUT_MS);
    };
    // Closing the dialog must actually stop the work. Without this the worker
    // keeps rewriting a print-resolution PNG that nobody will ever see, and a
    // second attempt runs alongside it.
    const onAbort = () => {
      finish();
      reject(new ColorChangeAbortError());
    };
    const finish = () => {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<ColorChangeWorkerResponse>) => {
      if (event.data.id !== request.id) return;
      if (event.data.kind === "progress") {
        arm();
        onProgress?.(event.data.fraction);
        return;
      }
      finish();
      if (event.data.kind === "error") reject(new Error(event.data.message));
      else resolve(event.data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Color change worker failed."));
    };
    arm();
    worker.postMessage(request);
  });
}

export async function analyzeColorChangeBlob(
  blob: Blob,
  crop?: SourceCrop,
  signal?: AbortSignal,
  onProgress?: ColorChangeProgress,
): Promise<ColorChangeAnalysis> {
  const request: ColorChangeWorkerRequest = { id: nextJobId++, kind: "analyze", blob, crop };
  const response = await runWorker(request, signal, onProgress);
  if (response.kind !== "analyze") throw new Error("Unexpected color analysis response.");
  return response.result;
}

export async function recolorPngBlob(
  blob: Blob,
  target: RgbColor,
  crop?: SourceCrop,
  signal?: AbortSignal,
  onProgress?: ColorChangeProgress,
  /** Reuses the analysis the dialog already ran on this source, when it has one. */
  model?: InkModel,
): Promise<ColorChangeRecolorResult> {
  const request: ColorChangeWorkerRequest = { id: nextJobId++, kind: "recolor", blob, crop, target, model };
  const response = await runWorker(request, signal, onProgress);
  if (response.kind !== "recolor") throw new Error("Unexpected color change response.");
  return response.result;
}
