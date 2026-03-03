interface CropResult {
  processedBuffer: ArrayBuffer;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  bgRemoved: boolean;
}

function processCrop(pixelBuffer: ArrayBuffer, w: number, h: number): CropResult {
  const data = new Uint8ClampedArray(pixelBuffer);

  const bgRemoved = false;

  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX || minY > maxY) {
    return {
      processedBuffer: data.buffer,
      width: w, height: h,
      minX: 0, minY: 0, maxX: w - 1, maxY: h - 1,
      bgRemoved: false,
    };
  }

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < w * 0.05 || bh < h * 0.05) {
    return {
      processedBuffer: data.buffer,
      width: w, height: h,
      minX: 0, minY: 0, maxX: w - 1, maxY: h - 1,
      bgRemoved: false,
    };
  }

  return {
    processedBuffer: data.buffer,
    width: w, height: h,
    minX, minY, maxX, maxY,
    bgRemoved,
  };
}

self.onmessage = function (e: MessageEvent) {
  try {
    if (e.data.type === 'crop') {
      const { pixelBuffer, width, height, requestId } = e.data;
      const result = processCrop(pixelBuffer, width, height);
      self.postMessage({ type: 'result', requestId, ...result }, [result.processedBuffer] as any);
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId: e.data?.requestId, error: String(err) });
  }
};
