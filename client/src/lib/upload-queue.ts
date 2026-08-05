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

/** Detect a mobile-class device via userAgent (best-effort). */
export function isMobileUserAgent(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  return /iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua);
}

/** Pick a concurrency limit that will not crash the tab. */
export function resolveUploadConcurrency(): number {
  if (isMobileUserAgent()) return 1;
  // Coarse desktop heuristic: hardwareConcurrency reports logical cores,
  // but the bottleneck is decode memory, not CPU. Two concurrent decodes
  // is a widely-cited safe default for desktop browsers under real memory
  // pressure. Users with 32-core workstations still open Safari.
  return 2;
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
