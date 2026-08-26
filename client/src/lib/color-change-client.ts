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

const JOB_TIMEOUT_MS = 45_000;
let nextJobId = 1;

async function runWorker(
  request: ColorChangeWorkerRequest,
): Promise<ColorChangeWorkerResponse> {
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

  const worker = new ColorChangeWorker();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error("Color change timed out."));
    }, JOB_TIMEOUT_MS);
    const finish = () => {
      window.clearTimeout(timeout);
      worker.terminate();
    };
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
): Promise<ColorChangeAnalysis> {
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { eligible: false, reason: "image-too-large" };
  const request: ColorChangeWorkerRequest = {
    id: nextJobId++,
    kind: "analyze",
    bytes: await readPng(blob),
    crop,
  };
  const response = await runWorker(request);
  if (response.kind !== "analyze") throw new Error("Unexpected color analysis response.");
  return response.result;
}

export async function recolorPngBlob(
  blob: Blob,
  target: RgbColor,
  crop?: SourceCrop,
): Promise<RecolorPngResult> {
  if (blob.size > COLOR_CHANGE_MAX_SOURCE_BYTES) return { ok: false, reason: "image-too-large" };
  const request: ColorChangeWorkerRequest = {
    id: nextJobId++,
    kind: "recolor",
    bytes: await readPng(blob),
    crop,
    target,
  };
  const response = await runWorker(request);
  if (response.kind !== "recolor") throw new Error("Unexpected color change response.");
  return response.result;
}