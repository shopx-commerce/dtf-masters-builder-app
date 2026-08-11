/**
 * A small pool of interchangeable workers, for jobs that are independent enough to
 * run at the same time.
 *
 * Why this exists
 * ---------------
 * Every worker in this app was a lone singleton processing one job at a time, so a
 * batch of independent passes over the same image ran strictly one after another no
 * matter how many cores the machine had. Splitting a representative spot-colour
 * workload (1800x1800, six passes) across workers measured 538 ms on one worker and
 * 140 ms on eight — a 3.8x saving that was simply being left on the table.
 *
 * The gain is sub-linear because these loops are memory-bound: they touch four bytes
 * per pixel and do very little arithmetic, so past a handful of workers they queue up
 * on memory bandwidth rather than CPU. That, plus each in-flight job holding its own
 * copy of the pixels, is why `MAX_POOL_SIZE` is deliberately small — a 32-core
 * machine gains almost nothing from 32 workers and would hold 32 buffers to get it.
 *
 * Pooled workers are single-job at a time, which is what makes them interchangeable
 * and lets a caller skip the `requestId` correlation every other worker here has to
 * do: while a job is running, that worker is answering to nobody else.
 */

/**
 * Ceiling on pool width. Beyond roughly this many concurrent pixel passes the
 * memory bus saturates, and each extra worker still costs a thread and a buffer.
 */
const MAX_POOL_SIZE = 6;

/** Terminate workers that have gone unused this long, so idle tabs shed threads. */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long a single job may run before its worker is assumed dead rather than slow.
 *
 * A worker that dies without dispatching `error` — which is what a Safari or Firefox
 * worker OOM looks like — would otherwise leave `run` pending forever, and with it the
 * `Promise.all` in `runPooled` and whatever spinner that batch is driving. Generous
 * enough for a full-resolution pass on a slow phone, still bounded.
 */
const DEFAULT_JOB_TIMEOUT_MS = 60_000;

/**
 * Coarse mobile check used only to cap pool width. Phones report core counts they
 * cannot actually sustain in parallel, and the memory pressure of running several
 * full-resolution buffers at once is what kills those tabs.
 */
function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent ?? "";
  if (/iPhone|iPad|iPod|Android|Mobile|Windows Phone/i.test(ua)) return true;
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * How many workers to run in parallel for `desired` independent jobs.
 *
 * Mobile gets one: phones report core counts they cannot actually sustain, and the
 * memory pressure of parallel full-resolution buffers is what kills those tabs.
 */
export function resolveWorkerPoolSize(desired: number): number {
  if (desired <= 1) return 1;
  if (isMobileDevice()) return 1;
  const cores = navigator.hardwareConcurrency || 4;
  // Leave a core for the main thread so parallel work does not make the UI worse.
  return Math.max(1, Math.min(desired, cores - 1, MAX_POOL_SIZE));
}

export interface WorkerPoolOptions {
  /** Upper bound on live workers. Defaults to `resolveWorkerPoolSize` of the job count. */
  size?: number;
  idleTimeoutMs?: number;
  /** Per-job ceiling. Defaults to `DEFAULT_JOB_TIMEOUT_MS`. */
  jobTimeoutMs?: number;
  /** Used in warnings, to make a failing pool identifiable. */
  name?: string;
}

interface IdleEntry {
  worker: Worker;
  timer: ReturnType<typeof setTimeout> | null;
}

export class WorkerPool {
  private idle: IdleEntry[] = [];
  private live = 0;
  private waiting: Array<(worker: Worker) => void> = [];
  private disposed = false;

  constructor(
    private readonly factory: () => Worker,
    private readonly options: WorkerPoolOptions = {},
  ) {}

  private get maxSize(): number {
    return Math.max(1, this.options.size ?? MAX_POOL_SIZE);
  }

  private acquire(): Promise<Worker> {
    const entry = this.idle.pop();
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      return Promise.resolve(entry.worker);
    }
    if (this.live < this.maxSize) {
      const worker = this.factory();
      this.live++;
      return Promise.resolve(worker);
    }
    // Saturated: wait for whichever job finishes first.
    return new Promise<Worker>(resolve => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    if (this.disposed) {
      worker.terminate();
      this.live--;
      return;
    }
    const next = this.waiting.shift();
    if (next) {
      next(worker);
      return;
    }
    const idleTimeoutMs = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const entry: IdleEntry = { worker, timer: null };
    entry.timer = setTimeout(() => {
      const at = this.idle.indexOf(entry);
      if (at !== -1) this.idle.splice(at, 1);
      worker.terminate();
      this.live--;
    }, idleTimeoutMs);
    this.idle.push(entry);
  }

  /** Drop a worker that errored or timed out — it may be in an unusable state. */
  private discard(worker: Worker): void {
    worker.terminate();
    this.live--;
    const next = this.waiting.shift();
    if (next && this.live < this.maxSize) {
      this.live++;
      next(this.factory());
    }
  }

  /**
   * Runs one job on one worker and resolves with its first reply.
   *
   * `transfer` is forwarded as the postMessage transfer list — use it for anything
   * large, since a copy of a full-resolution buffer costs tens of milliseconds of
   * blocked main thread and a transfer costs a fraction of one.
   *
   * Always settles: a worker that goes silent rejects after `jobTimeoutMs` and is
   * discarded rather than handed back, because a pooled worker carries no requestId
   * and a late reply from it would be read as the next caller's result.
   */
  async run<Res>(payload: unknown, transfer?: Transferable[]): Promise<Res> {
    if (this.disposed) throw new Error("Worker pool has been terminated.");
    const worker = await this.acquire();
    const label = this.options.name ?? "Worker";
    const jobTimeoutMs = this.options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    return new Promise<Res>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onMessageError);
        fn();
      };
      const onMessage = (event: MessageEvent) => settle(() => {
        this.release(worker);
        resolve(event.data as Res);
      });
      const onError = (event: ErrorEvent) => settle(() => {
        this.discard(worker);
        reject(new Error(event.message || `${label} failed.`));
      });
      // A reply that cannot be deserialised never reaches `onMessage`, so without this
      // the job would wait out the full timeout for a worker that is in fact alive.
      const onMessageError = () => settle(() => {
        this.discard(worker);
        reject(new Error(`${label} sent a reply that could not be read.`));
      });
      const timer = setTimeout(() => settle(() => {
        this.discard(worker);
        reject(new Error(`${label} timed out after ${jobTimeoutMs}ms.`));
      }), jobTimeoutMs);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onMessageError);
      try {
        worker.postMessage(payload, transfer ?? []);
      } catch (err) {
        settle(() => {
          this.discard(worker);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
  }

  terminate(): void {
    this.disposed = true;
    for (const entry of this.idle) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.worker.terminate();
    }
    this.live -= this.idle.length;
    this.idle = [];
    this.waiting = [];
  }
}

/**
 * Runs `jobs` across a pool and returns their results in the original order.
 *
 * A job that throws yields `null` in its slot rather than failing the batch, because
 * every caller here treats a missing result as "this pass produced nothing" — which
 * is exactly what the sequential versions did when a pass found no pixels.
 */
export async function runPooled<Job, Res>(
  jobs: Job[],
  factory: () => Worker,
  toMessage: (job: Job) => { payload: unknown; transfer?: Transferable[] },
  options: WorkerPoolOptions = {},
): Promise<Array<Res | null>> {
  if (jobs.length === 0) return [];
  const pool = new WorkerPool(factory, {
    ...options,
    size: options.size ?? resolveWorkerPoolSize(jobs.length),
  });
  try {
    return await Promise.all(
      jobs.map(async job => {
        try {
          const { payload, transfer } = toMessage(job);
          return await pool.run<Res>(payload, transfer);
        } catch (err) {
          console.warn(`[${options.name ?? "worker-pool"}] job failed:`, err);
          return null;
        }
      }),
    );
  } finally {
    pool.terminate();
  }
}
