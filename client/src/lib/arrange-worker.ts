import { runArrange } from './arrange-core';

self.onmessage = function(e: MessageEvent) {
  try {
    if (e.data.type === 'arrange') {
      const packed = runArrange(e.data);
      // Named rather than spread, so the sizing fields the caller relies on cannot be
      // dropped by a change over in `arrange-core`. `packedExtent` and `minRequiredHeight`
      // are what let the expansion path skip rungs of the height ladder: without them the
      // caller only knows *that* the pack overflowed, not by how much, and has no choice
      // but to grow one rung and pack again.
      self.postMessage({
        type: 'result',
        requestId: e.data.requestId,
        result: packed.result,
        maxHeight: packed.maxHeight,
        filmHeight: packed.filmHeight,
        wastedArea: packed.wastedArea,
        overflows: packed.overflows,
        packedExtent: packed.packedExtent,
        minRequiredHeight: packed.minRequiredHeight,
      });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId: e.data?.requestId, error: String(err) });
  }
};
