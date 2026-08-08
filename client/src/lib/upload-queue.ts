/**
 * Bounded concurrency helpers for multi-file uploads.
 *
 * Browsers do not gracefully degrade under memory pressure — iOS Safari
 * silently kills the tab, Chromium raises "Aw, Snap!", and mobile Chrome
 * simply reloads. Fetching or decoding N large files at once on any of
 * these platforms is the crash vector we hit when a user drags a folder
 * of PNGs onto the drop zone.
 *
 * These helpers replace the naive `for (const f of files) handler(f)`
 * pattern (which fires all promises simultaneously) with a queue that
 * runs a fixed number of tasks at a time.
 *
 * Concurrency defaults:
 *   - Mobile: 1  (iOS Safari canvas cap is ~4096, memory ~500 MB)
 *   - Desktop: 2 (two workers can decode in parallel without contending)
 *
 * Reference: 2026 web-perf guidance on decode budgets under memory
 * pressure. Multiple sources agree that "one active decode on constrained
 * devices, at most two on stronger ones" is the safe upper bound for
 * client-side media preflight.
 */

export interface RunWithConcurrencyOptions<T> {
  /** Max in-flight tasks. Defaults to `resolveUploadConcurrency()`. */
  concurrency?: number;
  /** Called with each caught error; failure of one item does not stop the queue. */
  onError?: (error: unknown, item: T, index: number) => void;
  /** Called after each item completes (success or failure). */
  onProgress?: (completed: number, total: number) => void;
  /** Yield to the event loop between items — keeps the UI responsive so
   *  browser input handlers can fire between decodes. */
  yieldBetweenItems?: boolean;
}

/**
 * Detect a mobile-class device — one with a small memory budget and a hard
 * canvas ceiling — so callers can pick a budget that will not kill the tab.
 *
 * The user agent alone cannot answer this, and the gap is not an edge case.
 * Since iPadOS 13, Safari sends a desktop-class user agent that is
 * byte-identical to a Mac's: no `iPad`, no `Mobile`. Every iPad therefore read
 * as a desktop machine here and took desktop canvas and concurrency budgets on
 * a device with a fraction of a Mac's memory and a quarter of its canvas
 * ceiling. `maxTouchPoints` closes it, because no Mac has a touch screen — a
 * `Macintosh` agent reporting touch points is an iPad.
 *
 * Deliberately not a plain `(pointer: coarse)` or touch test. Those also match
 * a Windows laptop with a touch screen, which has neither the memory limit nor
 * the 4096 px canvas cap this is used to avoid, and would be needlessly
 * throttled.
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * Pick a concurrency limit that will not crash the tab.
 *
 * The binding constraint is decode memory rather than CPU — a single 40 MP source
 * costs about 160 MB decoded, so this stays far below the core count no matter how
 * many cores are on offer. `deviceMemory` is the signal that matters, and it is
 * deliberately coarse: the spec quantises it and caps it at 8 GiB, which is all the
 * fidelity this decision needs. Cores only act as a second ceiling, so a
 * memory-rich but core-poor machine does not oversubscribe.
 */
export function resolveUploadConcurrency(): number {
  if (isMobileDevice()) return 1;
  if (typeof navigator === "undefined") return 2;

  // Not in every browser's typings, and absent on Safari and Firefox.
  const memoryGiB = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // Unknown memory keeps the old conservative default.
  const byMemory = memoryGiB === undefined ? 2 : memoryGiB >= 8 ? 4 : memoryGiB >= 4 ? 3 : 2;

  const cores = navigator.hardwareConcurrency || 4;
  // Leave a core for the main thread, which still does the placement work.
  return Math.max(1, Math.min(byMemory, cores - 1));
}

/**
 * Yield to the browser so paint / input / animation frames can process.
 * Prefers `scheduler.yield()` (Chrome 129+) → `requestIdleCallback` →
 * `setTimeout(0)`.
 */
export function yieldToBrowser(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const scheduler = (window as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === "function") {
    return scheduler.yield();
  }
  if ("requestIdleCallback" in window) {
    return new Promise<void>((resolve) => {
      window.requestIdleCallback(() => resolve(), { timeout: 50 });
    });
  }
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/**
 * How many upload batches are still draining.
 *
 * Every multi-file entry point — the hero drop zone, the sidebar file picker and the
 * canvas drag-and-drop — funnels through `runWithConcurrency`, so this counter is the one
 * honest answer to "is the user still importing?". It is a counter rather than a flag
 * because a second drop can start before the first has finished.
 */
let activeBatches = 0;

/**
 * True while any multi-file upload is still being processed.
 *
 * Work that should happen once per batch rather than once per file — re-seating the sheet's
 * artwork clear of the top edge, say — waits on this instead of on a debounce. A debounce
 * cannot tell "the user has finished importing" from "this file took two seconds to
 * decode", and files routinely do take that long, so it would fire mid-batch.
 */
export function isUploadBatchActive(): boolean {
  return activeBatches > 0;
}

/**
 * Run `handler` over `items` with at most `concurrency` promises in flight.
 * Errors from one item do not abort the queue — every item is attempted.
 */
export async function runWithConcurrency<T>(
  items: T[],
  handler: (item: T, index: number) => Promise<void>,
  options: RunWithConcurrencyOptions<T> = {},
): Promise<void> {
  const concurrency = Math.max(1, options.concurrency ?? resolveUploadConcurrency());
  const total = items.length;
  if (total === 0) return;
  activeBatches++;
  try {
    await drain(items, handler, options, concurrency, total);
  } finally {
    activeBatches--;
  }
}

async function drain<T>(
  items: T[],
  handler: (item: T, index: number) => Promise<void>,
  options: RunWithConcurrencyOptions<T>,
  concurrency: number,
  total: number,
): Promise<void> {
  let cursor = 0;
  let completed = 0;

  const runNext = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor++;
      const item = items[index];
      try {
        await handler(item, index);
      } catch (error) {
        options.onError?.(error, item, index);
      }
      completed++;
      options.onProgress?.(completed, total);
      if (options.yieldBetweenItems !== false) {
        await yieldToBrowser();
      }
    }
  };

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, total);
  for (let i = 0; i < workerCount; i++) workers.push(runNext());
  await Promise.all(workers);
}
