/**
 * Edge flood-fill background removal.
 *
 * All bookkeeping uses typed arrays indexed by pixel position rather than
 * `Set<number>`. A `Set` throws "Set maximum size exceeded" past roughly 16.7
 * million entries, so the previous implementation could not process anything
 * above ~16 MP — which is every 300 DPI design larger than about 13 inches
 * square. Flag arrays cost one byte per pixel, have no such ceiling, and are
 * substantially faster at the preview sizes too.
 */

function isWhitePixel(data: Uint8ClampedArray, index: number, thresholdValue: number): boolean {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const a = data[index + 3];
  if (a < 128) return true;
  const minChannel = Math.min(r, g, b);
  return minChannel >= thresholdValue;
}

function shouldRemovePixel(data: Uint8ClampedArray, index: number, thresholdValue: number): boolean {
  const a = data[index + 3];
  if (a < 128) return false;
  const minChannel = Math.min(data[index], data[index + 1], data[index + 2]);
  return minChannel >= thresholdValue;
}

function isBlackPixel(data: Uint8ClampedArray, index: number, thresholdValue: number): boolean {
  const a = data[index + 3];
  if (a < 128) return true;
  return Math.max(data[index], data[index + 1], data[index + 2]) <= thresholdValue;
}

function shouldRemoveBlackPixel(data: Uint8ClampedArray, index: number, thresholdValue: number): boolean {
  if (data[index + 3] < 128) return false;
  return Math.max(data[index], data[index + 1], data[index + 2]) <= thresholdValue;
}

/** Growable Int32 stack of pixel positions. */
class PosQueue {
  private buf: Int32Array;
  private len = 0;
  private head = 0;

  constructor(initial = 1 << 14) {
    this.buf = new Int32Array(initial);
  }

  push(pos: number): void {
    if (this.len === this.buf.length) {
      const next = new Int32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = pos;
  }

  shift(): number {
    return this.buf[this.head++];
  }

  get pending(): boolean {
    return this.head < this.len;
  }
}

/**
 * Marks every background pixel reachable from the border in `removed`.
 *
 * Alpha is deliberately not written here: `isWhitePixel` treats a nearly
 * transparent pixel as background, so zeroing alpha mid-traversal would let the
 * fill bleed through the artwork. The caller applies the flags afterwards.
 */
function floodFillFromEdges(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  thresholdValue: number,
  mode: 'white' | 'black',
  removed: Uint8Array,
): void {
  const isBackground = mode === 'black' ? isBlackPixel : isWhitePixel;
  const shouldRemove = mode === 'black' ? shouldRemoveBlackPixel : shouldRemovePixel;
  const visited = new Uint8Array(width * height);
  const queue = new PosQueue();

  const seed = (pos: number) => {
    if (visited[pos]) return;
    if (!isBackground(data, pos * 4, thresholdValue)) return;
    visited[pos] = 1;
    queue.push(pos);
  };

  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }

  while (queue.pending) {
    const pos = queue.shift();
    if (shouldRemove(data, pos * 4, thresholdValue)) removed[pos] = 1;

    const x = pos % width;
    const y = (pos - x) / width;

    if (y > 0) { const n = pos - width; if (!visited[n]) { visited[n] = 1; if (isBackground(data, n * 4, thresholdValue)) queue.push(n); } }
    if (y < height - 1) { const n = pos + width; if (!visited[n]) { visited[n] = 1; if (isBackground(data, n * 4, thresholdValue)) queue.push(n); } }
    if (x > 0) { const n = pos - 1; if (!visited[n]) { visited[n] = 1; if (isBackground(data, n * 4, thresholdValue)) queue.push(n); } }
    if (x < width - 1) { const n = pos + 1; if (!visited[n]) { visited[n] = 1; if (isBackground(data, n * 4, thresholdValue)) queue.push(n); } }
  }
}

function processRemoval(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  mode: 'white' | 'black' = 'white',
): void {
  const thresholdValue = mode === 'black' ? threshold : (threshold / 100) * 255;
  const total = width * height;
  const removed = new Uint8Array(total);

  floodFillFromEdges(data, width, height, thresholdValue, mode, removed);

  for (let pos = 0; pos < total; pos++) {
    if (removed[pos]) data[pos * 4 + 3] = 0;
  }

  // Feather cleanup: creep a few pixels into the artwork edge to clear the
  // white fringe and semi-transparent halo the fill leaves behind.
  const maxCleanupDepth = 3;
  const alphaCleanupThreshold = 180;
  const whiteCleanupThreshold = 200;
  const cleanupVisited = new Uint8Array(total);
  const queue = new PosQueue();
  const depths = new PosQueue();

  const enqueue = (pos: number, depth: number) => {
    queue.push(pos);
    depths.push(depth);
  };

  for (let pos = 0; pos < total; pos++) {
    if (!removed[pos]) continue;
    const x = pos % width;
    const y = (pos - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nPos = ny * width + nx;
        if (removed[nPos]) continue;
        enqueue(nPos, 1);
      }
    }
  }

  while (queue.pending) {
    const pos = queue.shift();
    const depth = depths.shift();
    if (cleanupVisited[pos]) continue;
    cleanupVisited[pos] = 1;

    const idx = pos * 4;
    const a = data[idx + 3];
    if (a === 0) continue;

    const minCh = Math.min(data[idx], data[idx + 1], data[idx + 2]);
    if (minCh < whiteCleanupThreshold && a >= alphaCleanupThreshold) continue;

    data[idx + 3] = 0;
    removed[pos] = 1;
    if (depth >= maxCleanupDepth) continue;

    const x = pos % width;
    const y = (pos - x) / width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nPos = ny * width + nx;
        if (!removed[nPos] && !cleanupVisited[nPos]) enqueue(nPos, depth + 1);
      }
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const { imageData, width, height, threshold, mode } = e.data as {
    imageData: Uint8ClampedArray;
    width: number;
    height: number;
    threshold: number;
    mode?: 'white' | 'black';
  };

  try {
    processRemoval(imageData, width, height, threshold, mode ?? 'white');
    (self as unknown as Worker).postMessage(
      { type: 'result', imageData, width, height },
      [imageData.buffer] as any
    );
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err?.message || String(err) });
  }
};
