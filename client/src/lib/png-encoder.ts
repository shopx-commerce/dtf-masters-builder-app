/**
 * Main-thread facade over the PNG encode worker, with a transparent fallback to
 * `canvas.toBlob` when workers, `OffscreenCanvas` or `createImageBitmap` are
 * unavailable — or when the worker fails for any reason. Callers get a Blob
 * either way and never need to know which path produced it.
 *
 * A pixel edit encodes two images, the print source and its preview, and they
 * are independent. A small pool lets them run on separate cores instead of one
 * after the other. It is capped at two because that is all any caller asks for
 * concurrently, and each worker holds a full-size canvas while it runs.
 *
 * Idle workers are terminated, because an idle worker still holds its heap and
 * that matters on memory-constrained iOS. The delay is generous relative to a
 * single edit: tearing the pool down between taps in an editing session only
 * pays to rebuild it on the next one.
 */

import type { PngEncodeRequest, PngEncodeResponse } from "./png-encode-worker";

const MAX_WORKERS = 2;
const IDLE_TERMINATE_MS = 120_000;

interface Job {
  bitmap: ImageBitmap;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

let workersUnavailable = false;
const slots: Slot[] = [];
const waiting: Job[] = [];
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function canUseWorkers(): boolean {
  return (
    !workersUnavailable &&
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function"
  );
}

function scheduleIdleTerminate(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (waiting.length > 0) return;
    for (let i = slots.length - 1; i >= 0; i--) {
      if (!slots[i].job) { slots[i].worker.terminate(); slots.splice(i, 1); }
    }
  }, IDLE_TERMINATE_MS);
}

/** Fail everything in flight and drop the pool, so callers fall back inline
 *  rather than hanging on a worker that will never answer. */
function teardown(reason: string): void {
  const err = new Error(reason);
  for (const slot of slots) {
    slot.job?.reject(err);
    slot.worker.terminate();
  }
  slots.length = 0;
  for (const job of waiting.splice(0)) {
    try { job.bitmap.close(); } catch { /* nothing to release */ }
    job.reject(err);
  }
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function createSlot(): Slot | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./png-encode-worker.ts", import.meta.url), { type: "module" });
  } catch {
    workersUnavailable = true;
    return null;
  }
  const slot: Slot = { worker, job: null };
  worker.onmessage = (event: MessageEvent<PngEncodeResponse>) => {
    const job = slot.job;
    slot.job = null;
    if (job) {
      if (event.data.blob) job.resolve(event.data.blob);
      else job.reject(new Error(event.data.error || "PNG encode failed"));
    }
    pump();
  };
  worker.onerror = () => {
    workersUnavailable = true;
    teardown("PNG encode worker crashed");
  };
  slots.push(slot);
  return slot;
}

/** Hand queued jobs to whichever workers are free, growing the pool up to its
 *  cap on demand. */
function pump(): void {
  while (waiting.length > 0) {
    let slot = slots.find(s => !s.job) ?? null;
    if (!slot && slots.length < MAX_WORKERS) slot = createSlot();
    if (!slot) {
      // No worker and none can be created: nothing will ever pump these, so
      // fail them now and let the caller re-encode inline. Leaving them queued
      // would hang the edit rather than merely slow it down.
      if (slots.length === 0) teardown("PNG encode worker unavailable");
      break;
    }

    const job = waiting.shift()!;
    slot.job = job;
    const request: PngEncodeRequest = { id: 0, bitmap: job.bitmap };
    try {
      slot.worker.postMessage(request, [job.bitmap]);
    } catch (err) {
      slot.job = null;
      job.reject(err instanceof Error ? err : new Error("PNG encode dispatch failed"));
    }
  }
  if (waiting.length === 0 && slots.every(s => !s.job)) scheduleIdleTerminate();
}

function encodeOnMainThread(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error("Could not encode edited pixels."))),
      "image/png",
    );
  });
}

/**
 * PNG-encode a canvas, off the main thread where possible.
 *
 * The canvas is left untouched; the worker receives a transferred copy.
 */
export async function encodeCanvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  if (!canvas.width || !canvas.height) {
    throw new Error("Could not encode edited pixels.");
  }

  if (canUseWorkers()) {
    try {
      const bitmap = await createImageBitmap(canvas);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      return await new Promise<Blob>((resolve, reject) => {
        waiting.push({ bitmap, resolve, reject });
        pump();
      });
    } catch {
      // Any failure on the worker path is recoverable — the canvas still holds
      // the pixels, so re-encode inline rather than losing the edit.
    }
  }
  return encodeOnMainThread(canvas);
}
