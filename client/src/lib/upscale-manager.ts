/**
 * Main-thread owner of the super-resolution worker.
 *
 * One worker, one job at a time, created lazily — the model and the ONNX
 * Runtime wasm binary together are tens of megabytes, so nothing is fetched
 * until a design is actually on the canvas.
 */

import UpscaleWorker from "./upscale-worker?worker";
import { IOS_SAFE_CANVAS_DIM, MAX_UPLOAD_MEGAPIXELS } from "./image-budget";
import { detectUpscaleSupport } from "./upscale-support";
import type { UpscaleTimings } from "./upscale-worker";

export type { UpscaleTimings };

export interface UpscaleResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  timings: UpscaleTimings;
}

export interface UpscaleProgress {
  completed: number;
  total: number;
}

/**
 * The factors the editor offers.
 *
 * 4x is what the network natively produces and 2x is an exact halving of it,
 * so neither needs a resampling filter that could ring on an alpha edge. A
 * 3x option would, for a factor nobody asked for by name.
 */
export const UPSCALE_FACTORS = [2, 4] as const;
export type UpscaleFactor = (typeof UPSCALE_FACTORS)[number];

/**
 * Scale factor that fits `w` x `h` under a megapixel budget (and optional max
 * edge). Returns 1 when the image already fits.
 *
 * Ported inline from the client fork's `image-budget.ts`. Baseline's copy of
 * that file predates the fork's "prepare raster upload" work and does not
 * export this helper yet; porting that whole feature is out of scope here, so
 * the one function this module needs is kept local instead.
 */
function fitWithinMegapixels(w: number, h: number, maxMP: number, maxEdge?: number): number {
  const pixels = Math.max(1, w * h);
  const mpScale = Math.sqrt((maxMP * 1_000_000) / pixels);
  const edgeScale =
    maxEdge && maxEdge > 0 ? Math.min(maxEdge / Math.max(w, 1), maxEdge / Math.max(h, 1)) : 1;
  return Math.min(1, mpScale, edgeScale);
}

/**
 * The largest offered factor at or below `requested` whose result still fits
 * the editor's pixel budget, or 0 when even 2x does not.
 *
 * The same 40 MP ceiling the rest of the editor works to
 * (`MAX_UPLOAD_MEGAPIXELS`): an upscale that blew past it would put a design
 * into the canvas the export path cannot hold, turning "increase quality"
 * into a failed checkout.
 *
 * The client fork also clamps to a device-aware `vectorExportMaxEdge()`
 * (desktop 8192 / mobile 4096), which lives in a `vector-raster-limits.ts`
 * module baseline does not have yet and depends in turn on `upload-queue.ts`'s
 * `isMobileDevice`. Neither has been ported here, so `IOS_SAFE_CANVAS_DIM`
 * (4096) — already exported by baseline's `image-budget.ts` — is used
 * unconditionally as the edge cap: the same safe bound the fork applies on
 * mobile, just applied on desktop too instead of the higher 8192 ceiling.
 */
export function resolveUpscaleScale(width: number, height: number, requested: number): number {
  for (const scale of [...UPSCALE_FACTORS].reverse()) {
    if (scale > requested) continue;
    const fits = fitWithinMegapixels(width * scale, height * scale, MAX_UPLOAD_MEGAPIXELS, IOS_SAFE_CANVAS_DIM);
    if (fits >= 1) return scale;
  }
  return 0;
}

/**
 * Reference workload the throughput gate is judged against: a 2 megapixel
 * design with transparency, which needs two passes over the network.
 */
const REFERENCE_PIXELS = 2_000_000;

/**
 * How long that reference job may take before the control is withdrawn.
 *
 * Measured spread on one Windows laptop: 1.1 us per model pixel on its RTX
 * 5060, 21 us on the integrated Radeon 610M that Chrome actually selects by
 * default. The fast path finishes the reference job in about 5 s; the slow one
 * would take over two minutes. Somewhere in between the feature stops being
 * "increase quality" and starts being "the app has frozen", and 25 s is a
 * defensible place to draw that line.
 */
const MAX_REFERENCE_MS = 25_000;

/**
 * Model pixels processed per source pixel: each tile recomputes its halo, so
 * the grid covers rather more than the image itself.
 */
const TILE_WASTE_FACTOR = 1.2;

/**
 * Estimated *inference* time. Measured against real jobs on an RTX 5060 this
 * tracks `session.run` closely (1.16 us/model px measured, 5.6 s predicted
 * against 5.45 s actual for the reference job) but it does not model the
 * JavaScript either side of the network — the colour bleed, the per-tile blend
 * and the buffer handoff added a further 8-55% of wall-clock on the same runs.
 * The gate is therefore mildly optimistic by design; `TILE_WASTE_FACTOR` and
 * the distance between a passing estimate and `MAX_REFERENCE_MS` absorb it.
 */
export function estimateUpscaleMs(
  sourcePixels: number,
  microsecondsPerModelPixel: number,
  withAlpha: boolean,
): number {
  return (sourcePixels * TILE_WASTE_FACTOR * microsecondsPerModelPixel * (withAlpha ? 2 : 1)) / 1000;
}

/**
 * The per-model-pixel cost at which the reference job lands exactly on
 * `MAX_REFERENCE_MS`, i.e. the budget the calibration has to come in under.
 *
 * Derived from the same numbers the gate uses rather than written out
 * separately, so the two cannot drift apart. Passed to the worker so a machine
 * that is obviously fast enough can stop sampling instead of measuring four
 * times to reach a foregone conclusion.
 */
const CALIBRATION_BUDGET_US =
  (MAX_REFERENCE_MS * 1000) / (REFERENCE_PIXELS * TILE_WASTE_FACTOR * 2);

/**
 * How many times the machine may be measured across the tab's life.
 *
 * A verdict of "fast enough" is final — nothing later can make the hardware
 * slower. A verdict of "too slow" is not, because the cheapest way to get one
 * is to have measured during an upload. Each fresh `isFastEnough` caller after
 * a negative verdict is allowed to pay for one more measurement, up to this
 * many, before the answer is taken as settled.
 */
const MAX_CALIBRATION_RUNS = 3;

type WorkerReply =
  | { type: "ready"; microsecondsPerModelPixel: number }
  | { type: "progress"; requestId: number; completed: number; total: number }
  | { type: "result"; requestId: number; rgba: Uint8ClampedArray; width: number; height: number; timings: UpscaleTimings }
  | { type: "cancelled"; requestId?: number }
  | { type: "error"; requestId?: number; error: string };

class UpscaleManager {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private usPerModelPixel: number | null = null;
  private calibrated: boolean | null = null;
  private calibrationWaiters: Array<(usable: boolean) => void> = [];
  private calibrationRuns = 0;
  /** Set when the worker itself failed, which no amount of retrying will fix. */
  private calibrationBroken = false;
  /** True between accepting an upscale and the worker being handed the job. */
  private starting = false;
  private pending: {
    requestId: number;
    resolve: (result: UpscaleResult) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: UpscaleProgress) => void;
  } | null = null;

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    // The adapter probe decides which model file to fetch, so it has to settle
    // before the worker is told where to look.
    const support = await detectUpscaleSupport();
    if (!support.available) throw new Error("WebGPU is not available in this browser.");
    if (this.worker) return this.worker;

    const worker = new UpscaleWorker();
    worker.addEventListener("message", this.handleMessage);
    worker.addEventListener("error", this.handleError);
    // Same-origin asset paths built from the app's deploy base rather than the
    // current route — resolving against `document.baseURI` would put them under
    // whatever path the editor happens to be mounted at.
    const base = new URL(import.meta.env.BASE_URL || "/", location.origin);
    worker.postMessage({
      type: "init",
      wasmPath: new URL("ort/", base).href,
      modelUrl: new URL(`models/${modelFile(support.f16)}`, base).href,
    });
    this.worker = worker;
    return worker;
  }

  private handleMessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    if (reply.type === "ready") {
      // Keep the best reading. A run that lands while the upload pipeline is
      // still decoding and building contours reads several times slower than
      // the same machine at rest, and the optimistic figure is the one that
      // reflects what the customer will actually experience when they click.
      this.usPerModelPixel = Math.min(this.usPerModelPixel ?? Infinity, reply.microsecondsPerModelPixel);
      const referenceMs = estimateUpscaleMs(REFERENCE_PIXELS, this.usPerModelPixel, true);
      const usable = referenceMs <= MAX_REFERENCE_MS;
      console.info(
        `[upscale] calibrated: ${this.usPerModelPixel.toFixed(2)} us/model px, ` +
        `2 MP + alpha ≈ ${(referenceMs / 1000).toFixed(1)} s -> ${usable ? "offered" : "withheld"}`,
      );
      this.settleCalibration(usable);
      return;
    }
    const pending = this.pending;
    if (!pending || ("requestId" in reply && reply.requestId !== pending.requestId)) return;

    switch (reply.type) {
      case "progress":
        pending.onProgress?.({ completed: reply.completed, total: reply.total });
        break;
      case "result":
        this.pending = null;
        pending.resolve({ rgba: reply.rgba, width: reply.width, height: reply.height, timings: reply.timings });
        break;
      case "cancelled":
        this.pending = null;
        pending.reject(new Error("cancelled"));
        break;
      case "error":
        this.pending = null;
        pending.reject(new Error(reply.error));
        break;
    }
  };

  private handleError = (event: ErrorEvent) => {
    const pending = this.pending;
    this.pending = null;
    // A worker that threw at the top level is broken rather than slow, so the
    // negative verdict is final and must not be retried.
    this.calibrationBroken = true;
    this.settleCalibration(false);
    // A worker that threw at the top level may be unusable; drop it so the
    // next attempt gets a clean one.
    this.dispose();
    pending?.reject(new Error(event.message || "Upscale worker failed."));
  };

  /** Publishes a verdict to everyone waiting on it. */
  private settleCalibration(usable: boolean): void {
    this.calibrated = usable;
    this.calibrationWaiters.forEach(resolve => resolve(usable));
    this.calibrationWaiters = [];
  }

  /**
   * Resolves true once this machine has been measured and found fast enough to
   * be worth offering the control.
   *
   * The measurement is also the shader warm-up, so the first caller pays for
   * both and everyone after it gets the cached answer — except after a negative
   * verdict, which is retried a bounded number of times because the usual cause
   * is contention rather than slow hardware (see `warmup` in the worker).
   */
  isFastEnough(): Promise<boolean> {
    if (this.calibrated === true) return Promise.resolve(true);
    if (
      this.calibrated === false &&
      (this.calibrationBroken || this.calibrationRuns >= MAX_CALIBRATION_RUNS)
    ) {
      return Promise.resolve(false);
    }
    const waiter = new Promise<boolean>(resolve => this.calibrationWaiters.push(resolve));
    if (this.calibrationWaiters.length === 1) {
      const resample = this.calibrationRuns > 0;
      this.calibrationRuns++;
      void this.ensureWorker()
        .then(worker => worker.postMessage({
          type: "warmup",
          maxUsPerModelPixel: CALIBRATION_BUDGET_US,
          resample,
        }))
        .catch(() => {
          // No worker means no amount of retrying will help.
          this.calibrationBroken = true;
          this.settleCalibration(false);
        });
    }
    return waiter;
  }

  /** Measured cost per model pixel, or `null` before the warm-up completes. */
  get microsecondsPerModelPixel(): number | null {
    return this.usPerModelPixel;
  }

  async upscale(
    rgba: Uint8ClampedArray,
    width: number,
    height: number,
    scale: number,
    onProgress?: (progress: UpscaleProgress) => void,
  ): Promise<UpscaleResult> {
    // `pending` is only set after the worker resolves, so testing it alone lets
    // two calls in the same tick both get past the guard; the second would then
    // overwrite `pending` and the first caller's promise would never settle.
    if (this.pending || this.starting) throw new Error("An upscale is already running.");
    this.starting = true;
    let worker: Worker;
    try {
      worker = await this.ensureWorker();
    } finally {
      this.starting = false;
    }
    const requestId = this.nextRequestId++;
    return new Promise<UpscaleResult>((resolve, reject) => {
      this.pending = { requestId, resolve, reject, onProgress };
      worker.postMessage(
        { type: "upscale", requestId, rgba, width, height, scale },
        [rgba.buffer],
      );
    });
  }

  cancel(): void {
    if (!this.pending || !this.worker) return;
    this.worker.postMessage({ type: "cancel", requestId: this.pending.requestId });
  }

  dispose(): void {
    if (!this.worker) return;
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleError);
    this.worker.terminate();
    this.worker = null;
  }
}

/**
 * fp16 halves the download (2.4 MB against 4.9 MB) and runs materially faster
 * where the adapter exposes `shader-f16`. It is only offered there: measured
 * against the PyTorch reference the fp16 graph stays within 0.52 of a single
 * 8-bit level, which cannot survive PNG encoding, let alone reach film.
 */
function modelFile(f16: boolean): string {
  return f16 ? "realesr-general-x4v3-fp16.onnx" : "realesr-general-x4v3.onnx";
}

let instance: UpscaleManager | null = null;

export function getUpscaleManager(): UpscaleManager {
  if (!instance) instance = new UpscaleManager();
  return instance;
}
