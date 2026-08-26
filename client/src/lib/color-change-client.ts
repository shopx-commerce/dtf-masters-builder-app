import ColorChangeWorker from "./color-change-worker?worker";
import type {
  ColorChangeAnalysis,
  RecolorPngResult,
  RgbColor,
  SourceCrop,
} from "./color-change-core";
import { COLOR_CHANGE_MAX_SOURCE_BYTES } from "./color-change-limits";
import type {
  ColorChangeWorkerRequest,
  ColorChangeWorkerResponse,
} from "./color-change-worker";

/**
 * A decode plus a full re-encode of a print-resolution PNG is seconds of work,
 * and a phone is several times slower than a laptop. A flat deadline would
 * report "timed out" on artwork that was progressing fine, so the budget grows
 * with the source and only exists to bound a genuinely stuck worker — the user
 * can always abort sooner from the dialog.
 */
const JOB_TIMEOUT_BASE_MS = 45_000;
const JOB_TIMEOUT_PER_MB_MS = 15_000;
const JOB_TIMEOUT_CAP_MS = 240_000;

function timeoutForBytes(byteLength: number): number {
  const megabytes = Math.ceil(byteLength / (1024 * 1024));
  return Math.min(JOB_TIMEOUT_CAP_MS, JOB_TIMEOUT_BASE_MS + megabytes * JOB_TIMEOUT_PER_MB_MS);
}

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

let nextJobId = 1;

async function runWorker(
  request: ColorChangeWorkerRequest,
  signal?: AbortSignal,
): Promise<ColorChangeWorkerResponse> {
  if (signal?.aborted) throw new ColorChangeAbortError();

  if (typeof Worker === "undefined") {
    const core = await import("./color-change-core");
    if (request.kind === "analyze") {
      return {
        id: request.id,
        kind: "analyze",
        result: core.analyzeColorChangePng(request.bytes, request.crop),
      };
    }
    return {
      id: request.id,
      kind: "recolor",
      result: core.recolorPng(request.bytes, request.target, request.crop),
    };
  }

  const timeoutMs = timeoutForBytes(request.bytes.byteLength);
  const worker = new ColorChangeWorker();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish();
      reject(new Error("Color change timed out."));
    }, timeoutMs);
    // Closing the dialog must actually stop the work. Without this the worker
    // keeps decoding and re-encoding a print-resolution PNG that nobody will
    // ever see, and a second attempt runs alongside it.
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
      finish();
      if (event.data.kind === "error") reject(new Error(event.data.message));
      else resolve(event.data);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Color change worker failed."));
    };
    worker.postMessage(request, [request.bytes.buffer]);
  });
}

async function readPng(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export async function analyzeColorChangeBlob(
  blob: Blob,
  crop?: SourceCrop,
  signal?: AbortSignal,
): Promise<ColorChangeAnalysis> {
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { eligible: false, reason: "image-too-large" };
  const request: ColorChangeWorkerRequest = {
    id: nextJobId++,
    kind: "analyze",
    bytes: await readPng(blob),
    crop,
  };
  const response = await runWorker(request, signal);
  if (response.kind !== "analyze") throw new Error("Unexpected color analysis response.");
  return response.result;
}

export async function recolorPngBlob(
  blob: Blob,
  target: RgbColor,
  crop?: SourceCrop,
  signal?: AbortSignal,
): Promise<RecolorPngResult> {
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { ok: false, reason: "image-too-large" };
  const request: ColorChangeWorkerRequest = {
    id: nextJobId++,
    kind: "recolor",
    bytes: await readPng(blob),
    crop,
    target,
  };
  const response = await runWorker(request, signal);
  if (response.kind !== "recolor") throw new Error("Unexpected color change response.");
  return response.result;
}