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

function floodFillFromEdges(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  thresholdValue: number
): Set<number> {
  const toRemove = new Set<number>();
  const visited = new Set<number>();
  const queue: number[] = [];
  const getIndex = (x: number, y: number) => (y * width + x) * 4;

  for (let x = 0; x < width; x++) {
    const topIndex = getIndex(x, 0);
    if (isWhitePixel(data, topIndex, thresholdValue) && !visited.has(topIndex)) {
      queue.push(topIndex);
      visited.add(topIndex);
    }
    const bottomIndex = getIndex(x, height - 1);
    if (isWhitePixel(data, bottomIndex, thresholdValue) && !visited.has(bottomIndex)) {
      queue.push(bottomIndex);
      visited.add(bottomIndex);
    }
  }
  for (let y = 0; y < height; y++) {
    const leftIndex = getIndex(0, y);
    if (isWhitePixel(data, leftIndex, thresholdValue) && !visited.has(leftIndex)) {
      queue.push(leftIndex);
      visited.add(leftIndex);
    }
    const rightIndex = getIndex(width - 1, y);
    if (isWhitePixel(data, rightIndex, thresholdValue) && !visited.has(rightIndex)) {
      queue.push(rightIndex);
      visited.add(rightIndex);
    }
  }

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const currentIndex = queue[queueIndex++];
    if (shouldRemovePixel(data, currentIndex, thresholdValue)) {
      toRemove.add(currentIndex);
    }
    const pixelPos = currentIndex / 4;
    const x = pixelPos % width;
    const y = Math.floor(pixelPos / width);
    const neighbors = [
      { nx: x, ny: y - 1 },
      { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y },
      { nx: x + 1, ny: y },
    ];
    for (const { nx, ny } of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const neighborIndex = getIndex(nx, ny);
      if (visited.has(neighborIndex)) continue;
      visited.add(neighborIndex);
      if (isWhitePixel(data, neighborIndex, thresholdValue)) {
        queue.push(neighborIndex);
      }
    }
  }
  return toRemove;
}

function processRemoval(data: Uint8ClampedArray, width: number, height: number, threshold: number): void {
  const thresholdValue = (threshold / 100) * 255;
  const pixelsToRemove = floodFillFromEdges(data, width, height, thresholdValue);

  const pixelArray = Array.from(pixelsToRemove);
  for (let i = 0; i < pixelArray.length; i++) {
    data[pixelArray[i] + 3] = 0;
  }

  const removedPositions = new Set<number>();
  for (let i = 0; i < pixelArray.length; i++) {
    removedPositions.add(pixelArray[i] / 4);
  }

  const maxCleanupDepth = 3;
  const alphaCleanupThreshold = 180;
  const whiteCleanupThreshold = 200;
  const cleanupQueue: Array<{ pos: number; depth: number }> = [];

  const removedArr = Array.from(removedPositions);
  for (let ri = 0; ri < removedArr.length; ri++) {
    const pixelPos = removedArr[ri];
    const x = pixelPos % width;
    const y = Math.floor(pixelPos / width);
    const neighbors = [
      { nx: x - 1, ny: y }, { nx: x + 1, ny: y },
      { nx: x, ny: y - 1 }, { nx: x, ny: y + 1 },
      { nx: x - 1, ny: y - 1 }, { nx: x + 1, ny: y - 1 },
      { nx: x - 1, ny: y + 1 }, { nx: x + 1, ny: y + 1 },
    ];
    for (const { nx, ny } of neighbors) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nPos = ny * width + nx;
      if (removedPositions.has(nPos)) continue;
      cleanupQueue.push({ pos: nPos, depth: 1 });
    }
  }

  const cleanupVisited = new Set<number>();
  let qi = 0;
  while (qi < cleanupQueue.length) {
    const { pos, depth } = cleanupQueue[qi++];
    if (cleanupVisited.has(pos)) continue;
    cleanupVisited.add(pos);

    const idx = pos * 4;
    const a = data[idx + 3];
    if (a === 0) continue;

    const minCh = Math.min(data[idx], data[idx + 1], data[idx + 2]);

    if (minCh >= whiteCleanupThreshold || a < alphaCleanupThreshold) {
      data[idx + 3] = 0;
      removedPositions.add(pos);

      if (depth < maxCleanupDepth) {
        const x = pos % width;
        const y = Math.floor(pos / width);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const nPos = ny * width + nx;
            if (!removedPositions.has(nPos) && !cleanupVisited.has(nPos)) {
              cleanupQueue.push({ pos: nPos, depth: depth + 1 });
            }
          }
        }
      }
    }
  }
}

self.onmessage = (e: MessageEvent) => {
  const { imageData, width, height, threshold } = e.data as {
    imageData: Uint8ClampedArray;
    width: number;
    height: number;
    threshold: number;
  };

  try {
    processRemoval(imageData, width, height, threshold);
    (self as unknown as Worker).postMessage(
      { type: 'result', imageData, width, height },
      [imageData.buffer] as any
    );
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ type: 'error', error: err?.message || String(err) });
  }
};
