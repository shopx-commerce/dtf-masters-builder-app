/**
 * Write one gangsheet PNG using several workers at once.
 *
 * The sheet is cut into the same strips the serial exporter already used, but
 * the strips are rendered and filtered by a pool of workers instead of one after
 * another, and a separate worker compresses them in order as they arrive. This
 * module only routes buffers between the two; it never touches a pixel.
 *
 * Why compression is not also split up. All of a PNG's compressed data has to
 * form a single zlib stream, so parallelising it means flushing each band and
 * concatenating the pieces — which works, but forces a JavaScript compressor,
 * because the browser's native one cannot be flushed mid-stream. Measured on a
 * real band, native deflate was 3.7x faster than pako at the same level *and*
 * produced slightly smaller output, so six parallel JavaScript compressors lost
 * to one native compressor plus parallel rendering, and cost file size on top.
 * Rendering is the half that actually benefits from more cores.
 *
 * The result is byte-for-byte the file the serial path produces. Nothing about
 * the pixels, the filters or the compressed stream differs — only who does the
 * work and when. That is checked directly rather than assumed.
 */

import ExportWorkerModule from "@/lib/export-worker?worker";
import { isMobileDevice } from "@/lib/upload-queue";
import { stripRangesFor } from "@/lib/png-stream";
import type { PrintLabelLayout } from "@/lib/print-label";

export interface ParallelBandDesign {
  widthInches: number;
  heightInches: number;
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
  sourceIndex: number;
  sourceCrop?: { x: number; y: number; width: number; height: number };
  alphaThresholded?: boolean;
  printFileName?: boolean;
  name?: string;
  /** Where the printed filename goes, decided on the main thread. See `DesignExportData`. */
  label?: PrintLabelLayout;
}

export interface ParallelExportProgress {
  phase: "preparing" | "rendering" | "finalizing";
  completed: number;
  total: number;
}

/**
 * Below this, the sheet is not worth splitting.
 *
 * Each worker has to start, load the module and decode its own copy of every
 * source it draws, which is a fixed cost the serial path pays once. Measured on
 * a 36 MP sheet the parallel path came in slower than serial for exactly that
 * reason, so the floor is set above it.
 */
const MIN_PARALLEL_SHEET_PIXELS = 40_000_000;

/**
 * Never split rendering more ways than this.
 *
 * More renderers than the compressor can drain buys nothing but memory, and on
 * a 22 x 120 in sheet that shows up as a measurable loss: two renderers took
 * 14.7 s, three 14.6 s, four 15.1 s and six 14.9 s, because renderers contend
 * for memory bandwidth on `getImageData` while the compressor stays the
 * bottleneck. Three is two plus slack for one slow band.
 */
const MAX_RENDER_WORKERS = 3;

/**
 * Working memory a single render worker needs, as a multiple of one band.
 *
 * A renderer holds the strip canvas, the pixels read back from it, and the
 * filtered rows built from those — three band-sized allocations live at once,
 * before any cached stamps.
 */
const BAND_MEMORY_MULTIPLE = 3;

/**
 * Filtered bands that may sit finished, waiting for the compressor, on top of
 * the ones being rendered. Two is enough to keep the compressor from ever
 * waiting on a renderer, and each one is a band-sized allocation.
 */
const MAX_BUFFERED_BANDS = 2;

/**
 * Total working memory the export may spend across all workers.
 *
 * Deliberately well under a desktop tab's headroom: exceeding it does not
 * degrade, it kills the tab mid-export.
 */
const PARALLEL_MEMORY_BUDGET_BYTES = 1_200 * 1024 * 1024;

/** Tab-wide budget for cached stamps, divided between the render workers. */
const PARALLEL_STAMP_CACHE_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * The blank-sheet guard, worded as the serial path words it.
 *
 * A sheet carrying designs that filters to nothing but transparent rows means
 * every draw silently failed rather than raised, and the file would upload
 * cleanly as an empty print.
 */
const BLANK_EXPORT_ERROR =
  "The exported sheet came out blank — the browser rendered no pixels " +
  "(this usually means the device ran out of memory). Close other apps or " +
  "tabs and try again, or reduce the sheet size.";

/**
 * How many render workers this sheet should use, or 1 to stay serial.
 *
 * Mobile is excluded outright rather than given a smaller number. The numbers
 * that make this worthwhile come from running several renders at once, which is
 * precisely what a phone cannot afford, and iOS Safari answers an over-budget
 * canvas by returning a blank one rather than failing.
 */
export function parallelWorkerCountFor(outW: number, outH: number): number {
  if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return 1;
  if (typeof CompressionStream === "undefined") return 1;
  if (isMobileDevice()) return 1;
  if (outW * outH < MIN_PARALLEL_SHEET_PIXELS) return 1;

  const strips = stripRangesFor(outW, outH);
  if (strips.length < 2) return 1;

  const cores = Math.max(1, Number(navigator.hardwareConcurrency) || 1);
  // Two cores are already committed elsewhere: the compressor worker and the
  // thread running the UI.
  const byCores = Math.min(MAX_RENDER_WORKERS, Math.max(1, cores - 2));

  const bandBytes = outW * strips[0].height * 4;
  const byMemory = Math.max(
    1,
    Math.floor(
      (PARALLEL_MEMORY_BUDGET_BYTES - bandBytes * MAX_BUFFERED_BANDS) /
        Math.max(1, bandBytes * BAND_MEMORY_MULTIPLE),
    ),
  );

  return Math.max(1, Math.min(byCores, byMemory, strips.length));
}

/** Anything that means "this sheet did not come out of the parallel path". */
export class ParallelExportFailure extends Error {}

/**
 * Permits for bands that exist outside a render worker.
 *
 * A renderer takes one before it starts a band and holds it until the
 * compressor has swallowed that band's bytes, so the number of band-sized
 * buffers alive at once is bounded no matter how much faster rendering is than
 * compression.
 */
class BandSlots {
  private held = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  acquire(): Promise<void> {
    if (this.held < this.capacity) {
      this.held++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.held++;
        resolve();
      });
    });
  }

  release(): void {
    this.held--;
    this.waiting.shift()?.();
  }

  /** Wake everything so a failed export cannot leave a renderer parked. */
  releaseAll(): void {
    this.held = 0;
    while (this.waiting.length > 0) this.waiting.shift()?.();
  }
}

export async function exportPngInParallel(options: {
  designs: ParallelBandDesign[];
  sources: Blob[];
  outW: number;
  outH: number;
  exportDpi: number;
  workerCount: number;
  timeoutMs: number;
  onProgress?: (progress: ParallelExportProgress) => void;
}): Promise<Blob> {
  const { designs, sources, outW, outH, exportDpi } = options;
  const strips = stripRangesFor(outW, outH);
  const renderCount = Math.max(1, Math.min(options.workerCount, strips.length));
  const requestId = Math.floor(Math.random() * 0x7fffffff);
  const stampCacheBudgetBytes = Math.floor(PARALLEL_STAMP_CACHE_BUDGET_BYTES / renderCount);

  options.onProgress?.({ phase: "preparing", completed: 1, total: 1 });

  const renderers: Worker[] = [];
  let encoder: Worker | null = null;
  let timer: number | undefined;

  try {
    encoder = new ExportWorkerModule();
    for (let i = 0; i < renderCount; i++) renderers.push(new ExportWorkerModule());

    const slots = new BandSlots(renderCount + MAX_BUFFERED_BANDS);
    // Rendered bands that cannot be sent yet because an earlier one has not
    // arrived. The compressor must be fed in row order.
    const buffered = new Map<number, Uint8Array>();
    let nextToRender = 0;
    let nextToSend = 0;
    let acked = 0;
    // Every band reports whether it filtered a single non-transparent row, and
    // by the last ack every band has been rendered. A sheet with designs that
    // never saw ink is the blank export the serial path refuses to produce.
    let sawInk = false;

    let fail: (error: Error) => void = () => {};
    const failed = new Promise<never>((_, reject) => {
      fail = (error) => {
        slots.releaseAll();
        reject(error);
      };
    });

    const finished = new Promise<Blob>((resolve) => {
      const enc = encoder!;
      enc.addEventListener("message", (event: MessageEvent) => {
        const data = event.data;
        if (data?.requestId !== requestId) return;
        if (data.type === "encode-ack") {
          slots.release();
          acked++;
          options.onProgress?.({ phase: "rendering", completed: acked, total: strips.length });
          if (acked === strips.length) {
            if (designs.length > 0 && !sawInk) {
              fail(new ParallelExportFailure(BLANK_EXPORT_ERROR));
              return;
            }
            options.onProgress?.({ phase: "finalizing", completed: 0, total: 1 });
            enc.postMessage({ type: "encode-finish", requestId });
          }
          return;
        }
        if (data.type === "result") {
          const blob = data.blob as Blob;
          if (!blob || blob.size === 0) {
            fail(new ParallelExportFailure("The parallel export produced an empty image."));
            return;
          }
          resolve(blob);
          return;
        }
        if (data.type === "error") {
          fail(new ParallelExportFailure(String(data.error || "Compressing the sheet failed.")));
        }
      });
      enc.addEventListener("error", (event: ErrorEvent) => {
        fail(new ParallelExportFailure(event.message || "The sheet compressor crashed."));
      });
    });

    const ready = new Promise<void>((resolve) => {
      const enc = encoder!;
      const onReady = (event: MessageEvent) => {
        if (event.data?.type === "encode-ready" && event.data.requestId === requestId) {
          enc.removeEventListener("message", onReady);
          resolve();
        }
      };
      enc.addEventListener("message", onReady);
      enc.postMessage({ type: "encode-begin", requestId, outW, outH, exportDpi });
    });

    /** Forward every band that is now next in row order. */
    const pump = () => {
      const enc = encoder;
      if (!enc) return;
      for (;;) {
        const next = buffered.get(nextToSend);
        if (!next) return;
        buffered.delete(nextToSend);
        enc.postMessage(
          { type: "encode-band", requestId, index: nextToSend, filtered: next },
          [next.buffer],
        );
        nextToSend++;
      }
    };

    const renderLoop = (worker: Worker) =>
      new Promise<void>((resolve) => {
        worker.addEventListener("message", (event: MessageEvent) => {
          const data = event.data;
          if (data?.requestId !== requestId) return;
          if (data.type === "band-result") {
            if (data.sawInk) sawInk = true;
            buffered.set(data.index as number, data.filtered as Uint8Array);
            pump();
            void next();
            return;
          }
          if (data.type === "error") {
            fail(new ParallelExportFailure(String(data.error || "A sheet band failed to render.")));
          }
        });
        worker.addEventListener("error", (event: ErrorEvent) => {
          fail(new ParallelExportFailure(event.message || "A sheet band worker crashed."));
        });

        const next = async () => {
          if (nextToRender >= strips.length) {
            resolve();
            return;
          }
          const current = nextToRender++;
          // Reserved before rendering starts, so a fast renderer cannot build a
          // queue of finished bands in front of the compressor.
          await slots.acquire();
          const strip = strips[current];
          worker.postMessage({
            type: "band",
            requestId,
            index: current,
            stripY: strip.y,
            stripH: strip.height,
            designs,
            sources,
            outW,
            outH,
            exportDpi,
            stampCacheBudgetBytes,
          });
        };
        void next();
      });

    const deadline = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new ParallelExportFailure("Export timed out while rendering sheet bands.")),
        options.timeoutMs,
      );
    });

    await ready;
    await Promise.race([failed, deadline, Promise.all(renderers.map(renderLoop))]);
    return await Promise.race([failed, deadline, finished]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    for (const worker of renderers) {
      try { worker.terminate(); } catch { /* already gone */ }
    }
    try { encoder?.terminate(); } catch { /* already gone */ }
  }
}
