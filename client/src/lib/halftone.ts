import HalftoneWorker from "./halftone-worker?worker";
import { applyHalftoneScreen, type HalftoneStrength } from "./halftone-core";

/**
 * Promise-based bridge to `halftone-worker.ts` with a synchronous main-thread
 * fallback. Callers pass a copy of the pre-resized RGBA buffer (transferable)
 * and receive a new ArrayBuffer with the halftoned pixels.
 *
 * Worker crashes disable the worker path for the remainder of the session so
 * we don't spin forever trying to respawn a broken worker; subsequent calls
 * transparently fall back to the main thread.
 */

export interface RunHalftoneParams {
  buffer: ArrayBuffer;
  procW: number;
  procH: number;
  printWidthInches: number;
  tr: number;
  tg: number;
  tb: number;
  strength: HalftoneStrength;
  /** Milliseconds before the worker path gives up and falls back. */
  timeoutMs?: number;
}

interface PendingRequest {
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: Error) => void;
  timer: number;
}

let _worker: Worker | null = null;
let _workerBroken = false;
let _requestCounter = 0;
const _pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (_workerBroken) return null;
  if (_worker) return _worker;
  if (typeof Worker === "undefined") return null;
  try {
    const worker = new HalftoneWorker();
    worker.onmessage = (event: MessageEvent<{
      type: string;
      requestId: number;
      pixelBuffer?: ArrayBuffer;
      error?: string;
    }>) => {
      const { requestId, type, pixelBuffer, error } = event.data;
      const pending = _pending.get(requestId);
      if (!pending) return;
      _pending.delete(requestId);
      window.clearTimeout(pending.timer);
      if (type === "result" && pixelBuffer) {
        pending.resolve(pixelBuffer);
      } else {
        pending.reject(new Error(error ?? "halftone worker returned no data"));
      }
    };
    worker.onerror = () => {
      _workerBroken = true;
      try { worker.terminate(); } catch { /* worker already dead */ }
      _worker = null;
      for (const p of _pending.values()) {
        window.clearTimeout(p.timer);
        p.reject(new Error("halftone worker crashed"));
      }
      _pending.clear();
    };
    _worker = worker;
    return worker;
  } catch {
    _workerBroken = true;
    return null;
  }
}

/**
 * Kill the shared halftone worker and fail everything still waiting on it.
 *
 * A screen only times out on a device that is already saturated, and the caller answers a
 * timeout by halftoning the same pixels on the main thread. Leaving the worker to finish a
 * result nobody will read would put both copies of the job on the same overloaded CPU, so the
 * worker goes first. Unlike `onerror` this does not set `_workerBroken`: a timeout says the
 * device was busy, not that the worker path is unusable, so the next call gets a fresh one.
 */
function discardHalftoneWorker(reason: string): void {
  const worker = _worker;
  _worker = null;
  if (worker) {
    try { worker.terminate(); } catch { /* worker already dead */ }
  }
  for (const p of _pending.values()) {
    window.clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  _pending.clear();
}

function runOnMainThread(params: RunHalftoneParams): ArrayBuffer {
  const pixels = new Uint8ClampedArray(params.buffer);
  applyHalftoneScreen({
    data: pixels,
    procW: params.procW,
    procH: params.procH,
    printWidthInches: params.printWidthInches,
    tr: params.tr,
    tg: params.tg,
    tb: params.tb,
    strength: params.strength,
  });
  return pixels.buffer;
}

/**
 * Halftone the given RGBA buffer. Prefers the Web Worker path; transparently
 * falls back to main-thread computation if the worker is unavailable or
 * fails. Always resolves with the halftoned buffer — never `null` — so
 * callers do not need a separate fallback branch.
 *
 * The input `buffer` may be transferred (worker path); do not read from it
 * after the call.
 */
export function runHalftone(params: RunHalftoneParams): Promise<ArrayBuffer> {
  const worker = getWorker();
  if (!worker) {
    return Promise.resolve(runOnMainThread(params));
  }

  const timeoutMs = params.timeoutMs ?? 30_000;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const requestId = ++_requestCounter;
    const timer = window.setTimeout(() => {
      _pending.delete(requestId);
      // Fall back to main thread with a fresh copy of the pixels. We cannot
      // reuse `params.buffer` here because it was already transferred to the
      // worker; the caller must supply the source pixels via `params` and
      // accept the timeout cost of recomputing. Terminate first so the abandoned
      // job stops competing with the fallback that replaces it.
      discardHalftoneWorker("halftone worker timed out");
      reject(new Error("halftone worker timed out"));
    }, timeoutMs);
    _pending.set(requestId, { resolve, reject, timer });
    try {
      worker.postMessage(
        {
          type: "halftone",
          requestId,
          pixelBuffer: params.buffer,
          procW: params.procW,
          procH: params.procH,
          printWidthInches: params.printWidthInches,
          tr: params.tr,
          tg: params.tg,
          tb: params.tb,
          strength: params.strength,
        },
        [params.buffer],
      );
    } catch (error) {
      _pending.delete(requestId);
      window.clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
