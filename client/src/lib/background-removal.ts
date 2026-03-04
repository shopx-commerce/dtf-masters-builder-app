/**
 * Background removal using a Web Worker for zero UI lag.
 * Flood-fill from edges removes contiguous white background.
 * White areas inside the design are preserved.
 * Serialized: only one job runs at a time; new requests cancel prior ones.
 */

import BgRemovalWorker from './bg-removal-worker?worker';

let workerInstance: Worker | null = null;
let currentReject: ((reason: Error) => void) | null = null;

function getWorker(): Worker {
  if (!workerInstance) {
    workerInstance = new BgRemovalWorker();
  }
  return workerInstance;
}

export async function removeBackgroundFromImage(
  image: HTMLImageElement,
  threshold: number = 95
): Promise<HTMLImageElement> {
  if (currentReject) {
    currentReject(new Error('Cancelled: new background removal request'));
    currentReject = null;
  }

  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas context');
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, width, height);
  const buffer = new Uint8ClampedArray(imageData.data);

  return new Promise<HTMLImageElement>((resolve, reject) => {
    currentReject = reject;
    const worker = getWorker();

    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      if (currentReject === reject) {
        currentReject = null;
      }
    };

    const onMessage = (e: MessageEvent) => {
      cleanup();

      if (e.data.type === 'error') {
        reject(new Error(e.data.error));
        return;
      }

      const resultData = new ImageData(
        new Uint8ClampedArray(e.data.imageData),
        e.data.width,
        e.data.height
      );
      ctx.putImageData(resultData, 0, 0);

      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = canvas.toDataURL('image/png');
    };

    const onError = (err: ErrorEvent) => {
      cleanup();
      reject(new Error(err.message));
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(
      { imageData: buffer, width, height, threshold },
      [buffer.buffer]
    );
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
