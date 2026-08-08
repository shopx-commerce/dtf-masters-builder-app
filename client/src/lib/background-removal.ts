/**
 * Background removal using a Web Worker for zero UI lag.
 * Flood-fill from edges removes contiguous white background.
 * White areas inside the design are preserved.
 * Serialized: only one job runs at a time; new requests cancel prior ones.
 */

import BgRemovalWorker from './bg-removal-worker?worker';

/**
 * How long one removal may run before the worker is assumed dead rather than slow.
 *
 * A worker that dies without dispatching `error` — what a Safari or Firefox worker OOM
 * looks like — would otherwise leave this promise pending forever, and the caller's
 * "removing background" state with it. Generous enough for a 300 DPI sheet-sized flood
 * fill, still bounded.
 */
const REMOVAL_TIMEOUT_MS = 60_000;

let workerInstance: Worker | null = null;
let currentReject: ((reason: Error) => void) | null = null;
/** Tears down the in-flight request's listeners and timer. Paired with `currentReject`. */
let currentCleanup: (() => void) | null = null;

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new BgRemovalWorker();
  }
  return workerInstance;
}

/**
 * Throw away the shared worker so the next call spawns a fresh one.
 *
 * Requests here are not correlated by id — the module relies on only one job being in
 * flight — so a worker that failed or went quiet cannot be kept: if it later posted the
 * reply we stopped waiting for, that reply would resolve somebody else's request.
 */
function discardWorker(): void {
  const worker = workerInstance;
  workerInstance = null;
  if (worker) {
    try { worker.terminate(); } catch { /* worker already dead */ }
  }
}

/**
 * Removes the background from `canvas` in place.
 *
 * Operating on a canvas rather than an `HTMLImageElement` is what lets the
 * editor re-run this at full print resolution: the caller keeps ownership of
 * the (potentially very large) pixel buffer and can encode it straight to a
 * blob, instead of round-tripping through a data URL that would be hundreds of
 * megabytes of base64 for a 300 DPI sheet-sized design.
 */
export async function removeBackgroundFromCanvas(
  canvas: HTMLCanvasElement,
  threshold: number = 95,
  mode: 'white' | 'black' = 'white'
): Promise<void> {
  if (currentReject) {
    const cancelled = currentReject;
    // Tear the old request down before rejecting it: its timeout is still armed, and
    // firing later it would discard the worker this new request is about to use.
    currentCleanup?.();
    currentReject = null;
    currentCleanup = null;
    cancelled(new Error('Cancelled: new background removal request'));
  }

  const { width, height } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');

  const imageData = ctx.getImageData(0, 0, width, height);
  // Handed to the worker by transfer, not copy. This runs at print resolution now, so
  // the buffer reaches 137 MB on a 36 MP design, and cloning it in and back out again
  // measured ~92 ms of blocked main thread plus a second copy of that memory live at
  // once. Nothing needed the clone: `imageData` is never read again, and the result
  // arrives in a fresh ImageData below.
  const pixels = imageData.data;

  return new Promise<void>((resolve, reject) => {
    const worker = getWorker();

    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      if (currentReject === reject) {
        currentReject = null;
        currentCleanup = null;
      }
    };
    currentReject = reject;
    currentCleanup = cleanup;

    const onMessage = (e: MessageEvent) => {
      cleanup();

      if (e.data.type === 'error') {
        reject(new Error(e.data.error));
        return;
      }

      // The worker transfers its buffer back, so this view already owns the memory.
      ctx.putImageData(new ImageData(e.data.imageData, e.data.width, e.data.height), 0, 0);
      resolve();
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      discardWorker();
      reject(new Error(err.message));
    };

    // A reply that cannot be deserialised never reaches `onMessage`, so without this the
    // call would wait out the full timeout for a worker that is in fact alive.
    const onMessageError = () => {
      cleanup();
      discardWorker();
      reject(new Error('Background removal worker sent a reply that could not be read.'));
    };

    const timer = window.setTimeout(() => {
      if (settled) return;
      cleanup();
      discardWorker();
      reject(new Error(`Background removal timed out after ${REMOVAL_TIMEOUT_MS}ms.`));
    }, REMOVAL_TIMEOUT_MS);

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    try {
      worker.postMessage(
        { imageData: pixels, width, height, threshold, mode },
        [pixels.buffer]
      );
    } catch (err) {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export async function removeBackgroundFromImage(
  image: HTMLImageElement,
  threshold: number = 95,
  mode: 'white' | 'black' = 'white'
): Promise<HTMLImageElement> {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  await removeBackgroundFromCanvas(canvas, threshold, mode);

  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('Could not encode the background-removed image.');
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode the background-removed image.')); };
    img.src = url;
  });
}

export function cropImageToContentCanvas(image: HTMLImageElement): HTMLCanvasElement | null {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;
  const cropCtx = cropCanvas.getContext('2d');
  if (!cropCtx) return null;
  cropCtx.drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
  return cropCanvas;
}
