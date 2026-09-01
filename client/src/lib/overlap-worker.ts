import { detectOverlaps, type OverlapDesign } from './overlap-detect';

/**
 * Off-thread half of the red overlap marks. The geometry and the pixel test live in
 * `overlap-detect` so that this and the main-thread fallback answer identically.
 */
interface OverlapRequest {
  type: 'check';
  designs: OverlapDesign[];
  /**
   * Decoded artwork, already scaled to the footprint it is drawn at, shared by every design
   * that uses it. Copies of one design are the common case on a gang sheet, and a
   * transferred bitmap can only be handed over once.
   */
  bitmaps: ImageBitmap[];
  sw: number;
  sh: number;
  tolPx?: number;
}

let scratch: OffscreenCanvas | null = null;
let scratchCtx: OffscreenCanvasRenderingContext2D | null = null;

/**
 * One canvas, resized per region. A crowded sheet asks for hundreds of regions, and
 * allocating a canvas for each of them costs more than the pixel test does.
 */
function getContext(w: number, h: number): OffscreenCanvasRenderingContext2D | null {
  if (!scratch) {
    scratch = new OffscreenCanvas(w, h);
    scratchCtx = scratch.getContext('2d');
  }
  if (!scratchCtx) return null;
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  scratchCtx.setTransform(1, 0, 0, 1, 0, 0);
  scratchCtx.clearRect(0, 0, w, h);
  return scratchCtx;
}

self.onmessage = (e: MessageEvent<OverlapRequest>) => {
  // Bitmaps are shared between designs, so releasing them is a job for this list rather than
  // for the design loop — closing per design would close the same bitmap several times and
  // skip any that no design ended up using.
  const bitmaps = e.data?.bitmaps ?? [];
  const closeAll = () => {
    for (const b of bitmaps) { try { b.close(); } catch { /* already closed */ } }
  };
  try {
    if (e.data?.type !== 'check') return;
    const { designs, sw, sh, tolPx } = e.data;
    const overlapping = detectOverlaps({
      designs: designs ?? [],
      sources: bitmaps,
      sw,
      sh,
      tolPx,
      getContext,
    });
    closeAll();
    (self as unknown as Worker).postMessage({ type: 'result', overlapping });
  } catch (err) {
    closeAll();
    (self as unknown as Worker).postMessage({ type: 'error', error: String(err) });
  }
};
