/**
 * Terminable SVG rasterisation.
 *
 * The problem
 * -----------
 * `<img>` + `canvas.drawImage` + `toBlob` is the only way a browser will
 * rasterise an SVG, and all three phases run on the main thread. The cost is
 * not bounded by anything we can see up front: measured on sanitiser-legal
 * content (a 2.4 KB file whose only trick is a chain of `feTurbulence` /
 * `feGaussianBlur` / `feDisplacementMap`), the main thread was unavailable for
 * 6.3 s at import size and **38.4 s at the 80 MP export size**. The stall was
 * measured from outside the page, over CDP, so it is a real read of the thread
 * being gone rather than a self-report from a blocked timer.
 *
 * That last point is what makes the obvious fix useless: the pre-existing 15 s
 * timeout around image load could never fire, because the callback needed the
 * very thread the load was holding. A watchdog on the main thread cannot
 * watchdog the main thread.
 *
 * Why not a worker
 * ----------------
 * A worker was the first choice and it does not work: `createImageBitmap`
 * refuses `image/svg+xml` blobs outright — "InvalidStateError: The source image
 * could not be decoded" — in a worker *and* on the window thread, so there is
 * no SVG rasteriser reachable from a worker at all. `OffscreenCanvas` exists
 * there but has nothing to draw. Verified in Chrome 1xx via CDP; not a
 * historical footnote, current behaviour.
 *
 * Chunking the draw was the second choice and is worse: slicing one
 * `drawImage` into an 8x8 grid of source rectangles re-rasterised the SVG per
 * tile, taking 20.0 s where one shot took 2.5 s, and the result was not
 * pixel-identical (0.27% of bytes differed, max delta 255). A print pipeline
 * cannot pay either of those.
 *
 * What works
 * ----------
 * An `<iframe sandbox="allow-scripts">` with no `allow-same-origin` gets an
 * opaque origin, and Chromium's sandboxed-iframe isolation puts it in its own
 * renderer process. So the rasterisation blocks a thread we do not need:
 *
 *   - legitimate artwork: parent's worst stall 156 ms across 38 samples
 *   - the filter/`<use>` bombs: killed on the timeout, parent's worst stall
 *     460 ms, editor still fully interactive
 *   - non-sandboxed control frame (same process): parent stalled 13.9 s,
 *     confirming the isolation is what does the work
 *
 * Output is byte-identical to the main-thread path — same engine, same code —
 * verified by comparing PNG bytes for seven kinds of legitimate artwork
 * (plain paths, icon set, pattern fill, filters, text, deep groups, repeated
 * logo): zero differing bytes in every case. Warm-frame timing is a wash or
 * better than the main thread.
 *
 * Where it does not help
 * ----------------------
 * Sandboxed-iframe process isolation is a Chromium behaviour. On an engine that
 * keeps the frame in the parent process the rasterisation still blocks, exactly
 * as it does today, and the timeout still cannot fire — the fallback is
 * no worse than the status quo but it is no better either. Safari is the
 * expected case. That is why `svg-expansion` exists as a static guard: it costs
 * nothing and it runs before any renderer is involved.
 */

import { SVG_RASTER_TIMEOUT_MS } from "./vector-raster-limits";

/**
 * Rasterisation ran past its wall-clock budget and was abandoned.
 *
 * `titleKey` / `translationKey` are what a caller should show; `message` is an
 * English fallback for logs, not for the customer.
 */
export class SvgRasterTimeoutError extends Error {
  readonly code = "svg_raster_timeout";
  readonly titleKey = "toast.svgRasterTimeout";
  readonly translationKey = "toast.svgRasterTimeoutDesc";
  constructor(readonly timeoutMs: number, readonly widthPx: number, readonly heightPx: number) {
    super(`SVG rasterisation exceeded ${timeoutMs}ms at ${widthPx}x${heightPx}`);
    this.name = "SvgRasterTimeoutError";
  }
}

/** Rasterisation failed for a reason other than time (decode, encode, context). */
export class SvgRasterError extends Error {
  readonly code = "svg_raster_failed";
  constructor(message: string) {
    super(message);
    this.name = "SvgRasterError";
  }
}

export interface RasteriseOptions {
  /** Wall-clock budget. Only enforceable when the isolated frame is in use. */
  timeoutMs?: number;
  /**
   * Skip the isolated frame and rasterise inline. Only for measuring the two
   * paths against each other.
   */
  forceMainThread?: boolean;
}

export interface RasteriseOutcome {
  blob: Blob;
  /** Which path produced this raster, so callers can report honestly. */
  via: "isolated" | "main-thread";
  /** True when the isolated frame was wanted but could not be used. */
  isolationUnavailable: boolean;
}

/**
 * Runs inside the sandboxed frame. Deliberately the same sequence as
 * `rasteriseOnMainThread` below so the two produce identical bytes.
 */
const FRAME_SCRIPT = `
addEventListener('message', async (event) => {
  var msg = event.data;
  if (!msg || msg.kind !== 'raster') return;
  var reply = function (payload, transfer) { parent.postMessage(payload, '*', transfer || []); };
  var url = null;
  try {
    url = URL.createObjectURL(new Blob([msg.source], { type: 'image/svg+xml' }));
    var img = await new Promise(function (resolve, reject) {
      var i = new Image();
      i.decoding = 'async';
      i.onload = function () { resolve(i); };
      i.onerror = function () { reject(new Error('SVG failed to decode')); };
      i.src = url;
    });
    var canvas = document.createElement('canvas');
    canvas.width = msg.width;
    canvas.height = msg.height;
    var ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error('Could not create canvas context for SVG rasterisation');
    ctx.clearRect(0, 0, msg.width, msg.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, msg.width, msg.height);
    var png = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    canvas.width = 0;
    canvas.height = 0;
    if (!png) throw new Error('Failed to encode SVG as PNG');
    var buffer = await png.arrayBuffer();
    reply({ kind: 'result', id: msg.id, ok: true, buffer: buffer }, [buffer]);
  } catch (err) {
    reply({ kind: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) });
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
});
parent.postMessage({ kind: 'ready' }, '*');
`;

/** How long the frame gets to boot before we give up and inline the work. */
const FRAME_READY_TIMEOUT_MS = 4_000;

interface IsolatedFrame {
  el: HTMLIFrameElement;
  win: Window;
}

let framePromise: Promise<IsolatedFrame | null> | null = null;
/** Serialises jobs: the frame is shared, and a kill must not take out a stranger's job. */
let queue: Promise<unknown> = Promise.resolve();
let nextJobId = 0;
/** Set once the environment has proven it cannot host the frame; stop retrying. */
let isolationBroken = false;

function destroyFrame(): void {
  const pending = framePromise;
  framePromise = null;
  void pending?.then((frame) => {
    try { frame?.el.remove(); } catch { /* already detached */ }
  }).catch(() => { /* never created */ });
}

function createFrame(): Promise<IsolatedFrame | null> {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return Promise.resolve(null);
  }
  return new Promise<IsolatedFrame | null>((resolve) => {
    let settled = false;
    let el: HTMLIFrameElement;
    try {
      el = document.createElement("iframe");
    } catch {
      resolve(null);
      return;
    }
    // `allow-scripts` without `allow-same-origin` is the whole point: the frame
    // gets an opaque origin, which is what makes Chromium give it its own
    // process. It also means it cannot touch our DOM, storage or cookies, so
    // this is a stronger place to render customer artwork than the main
    // document was.
    el.setAttribute("sandbox", "allow-scripts");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    el.style.cssText =
      "position:absolute;width:1px;height:1px;left:-10000px;top:0;border:0;opacity:0;pointer-events:none";

    const finish = (value: IsolatedFrame | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      if (!value) {
        try { el.remove(); } catch { /* not attached */ }
      }
      resolve(value);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== el.contentWindow) return;
      const data = event.data as { kind?: string } | null;
      if (data?.kind !== "ready") return;
      const win = el.contentWindow;
      finish(win ? { el, win } : null);
    };

    const timer = setTimeout(() => finish(null), FRAME_READY_TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    el.onerror = () => finish(null);

    try {
      // `</script>` inside the srcdoc string would end the tag early.
      el.srcdoc =
        '<!doctype html><meta charset="utf-8"><title>raster</title><script>' +
        FRAME_SCRIPT.replace(/<\/script/gi, "<\\/script") +
        "</" + "script>";
      document.body.appendChild(el);
    } catch {
      finish(null);
    }
  });
}

function getFrame(): Promise<IsolatedFrame | null> {
  if (isolationBroken) return Promise.resolve(null);
  if (!framePromise) {
    framePromise = createFrame().then((frame) => {
      // A CSP without `frame-src data:`/`child-src`, or an environment with no
      // srcdoc support, shows up here. Stop paying the boot timeout per import.
      if (!frame) isolationBroken = true;
      return frame;
    });
  }
  return framePromise;
}

/** Exactly what the pre-existing implementation did, kept for byte-identical fallback. */
async function rasteriseOnMainThread(
  source: string,
  widthPx: number,
  heightPx: number,
): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.decoding = "async";
      i.onload = () => resolve(i);
      i.onerror = () => reject(new SvgRasterError("SVG failed to decode"));
      i.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext("2d", { alpha: true, willReadFrequently: true });
    if (!ctx) throw new SvgRasterError("Could not create canvas context for SVG rasterisation");
    ctx.clearRect(0, 0, widthPx, heightPx);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, widthPx, heightPx);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new SvgRasterError("Failed to encode SVG as PNG");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rasteriseInFrame(
  frame: IsolatedFrame,
  source: string,
  widthPx: number,
  heightPx: number,
  timeoutMs: number,
): Promise<Blob> {
  const id = ++nextJobId;
  return new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.win) return;
      const data = event.data as
        | { kind?: string; id?: number; ok?: boolean; buffer?: ArrayBuffer; error?: string }
        | null;
      if (data?.kind !== "result" || data.id !== id) return;
      cleanup();
      if (data.ok && data.buffer) {
        resolve(new Blob([data.buffer], { type: "image/png" }));
      } else {
        reject(new SvgRasterError(data?.error || "SVG rasterisation failed"));
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      // The frame's thread is wedged inside a synchronous render; nothing short
      // of dropping the whole frame reclaims it. The next job boots a new one.
      destroyFrame();
      reject(new SvgRasterTimeoutError(timeoutMs, widthPx, heightPx));
    }, timeoutMs);

    window.addEventListener("message", onMessage);
    try {
      frame.win.postMessage({ kind: "raster", id, source, width: widthPx, height: heightPx }, "*");
    } catch (err) {
      cleanup();
      reject(new SvgRasterError(`Could not hand SVG to the isolated renderer: ${String(err)}`));
    }
  });
}

/**
 * Rasterise a sanitised SVG to a PNG blob at exactly the requested pixel size,
 * in a process we can abandon.
 *
 * Jobs are serialised because the frame is shared and a timeout destroys it;
 * letting two run concurrently would mean one job's kill discarding another's
 * in-flight render.
 */
export async function rasteriseSvgToPngBlobSafe(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number,
  options: RasteriseOptions = {},
): Promise<RasteriseOutcome> {
  const timeoutMs = options.timeoutMs ?? SVG_RASTER_TIMEOUT_MS;

  const run = async (): Promise<RasteriseOutcome> => {
    if (!options.forceMainThread) {
      const frame = await getFrame();
      if (frame) {
        const blob = await rasteriseInFrame(frame, sanitisedSource, widthPx, heightPx, timeoutMs);
        return { blob, via: "isolated", isolationUnavailable: false };
      }
    }
    const blob = await rasteriseOnMainThread(sanitisedSource, widthPx, heightPx);
    return {
      blob,
      via: "main-thread",
      isolationUnavailable: !options.forceMainThread,
    };
  };

  // Chain onto the queue whether or not the previous job succeeded.
  const mine = queue.then(run, run);
  queue = mine.catch(() => undefined);
  return await mine;
}

/** Test seam: forget the shared frame so the next call boots a fresh one. */
export function resetSvgRasterFrameForTests(): void {
  isolationBroken = false;
  destroyFrame();
}
