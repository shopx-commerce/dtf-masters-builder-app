/**
 * Pure helpers for the tiled super-resolution pass: tile planning, the
 * seam-killing blend ramp, Lanczos resampling and the transparent-edge colour
 * bleed.
 *
 * Kept free of `onnxruntime-web` and of any worker globals so the geometry can
 * be reasoned about (and exercised) without spinning up a GPU session.
 */

/** The network's own scale factor. `realesr-general-x4v3` is a 4x model. */
export const MODEL_SCALE = 4;

/**
 * Model input tile edge, in source pixels.
 *
 * Measured on an RTX 5060 (fp16 model), raw cost per model pixel is close to
 * flat from 256 upwards — 0.93 us at 256, 0.94 at 320, 0.97 at 512 — so the
 * usual "bigger tiles amortise dispatch overhead" reasoning barely applies
 * here; this workload is compute-bound, not dispatch-bound.
 *
 * What bigger tiles genuinely buy is *less wasted work*. Every tile computes
 * its halo twice and the last tile in each row overhangs the image, and both
 * of those shrink as a share of the tile. Across the representative 1414 x
 * 1414 design the total model pixels are 3.2 M at 256 and 2.4 M at 512 — a
 * 26% saving that shows up directly in wall-clock time.
 *
 * The ceiling is activation memory: at 512 with fp16 the widest intermediate
 * is 64 channels x 512 x 512 x 2 B = 34 MB, and ONNX Runtime Web 1.27 gives JS
 * no way to select the cheaper `simple` buffer-cache mode, so real peak GPU
 * usage sits well above that (see `docs/local-upscale.md`).
 */
export const TILE_SIZE = 512;

/**
 * Halo carried on every side of a tile, in source pixels.
 *
 * Convolution near a tile edge sees replicated padding rather than real
 * neighbours, so the outermost pixels of a tile are wrong. The halo pushes
 * that error outside the region a tile is trusted for, and the blend below
 * cross-fades whatever error is left. 16 is the low end of the useful range
 * and it costs 6% of each tile; 32 would cost 13% for no visible improvement
 * in the seam measurements.
 */
export const TILE_OVERLAP = 16;

/** Source pixels a tile is solely responsible for. */
export const TILE_STRIDE = TILE_SIZE - 2 * TILE_OVERLAP;

export interface TilePlan {
  /** Left/top of the model input window, in source pixels. May be negative. */
  inX: number;
  inY: number;
  /** Whether a previously-blended tile sits to the left / above. */
  rampLeft: boolean;
  rampTop: boolean;
}

/**
 * Lays out the tile grid over a `width` x `height` source.
 *
 * Tiles are emitted in raster order, which is what lets the blend fold each
 * tile into the pixels already written instead of keeping a separate
 * weight-accumulation buffer — at a 4x intermediate that buffer would be
 * hundreds of megabytes for an ordinary design.
 */
export function planTiles(width: number, height: number): TilePlan[] {
  const cols = Math.max(1, Math.ceil(width / TILE_STRIDE));
  const rows = Math.max(1, Math.ceil(height / TILE_STRIDE));
  const plans: TilePlan[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      plans.push({
        inX: col * TILE_STRIDE - TILE_OVERLAP,
        inY: row * TILE_STRIDE - TILE_OVERLAP,
        rampLeft: col > 0,
        rampTop: row > 0,
      });
    }
  }
  return plans;
}

/**
 * Raised-cosine ramp of `length` samples, rising 0 -> 1.
 *
 * Two neighbouring tiles share a band exactly this wide, and the tile already
 * in the destination is implicitly at full weight there, so blending the new
 * tile in with weight `w` leaves `w + (1 - w) = 1`. The cross-fade is
 * therefore an exact partition of unity along each axis — a linear ramp would
 * also sum to one but leaves a visible slope discontinuity at both ends of the
 * band, which reads as a faint seam on flat colour.
 */
export function cosineRamp(length: number): Float32Array {
  const ramp = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    ramp[i] = 0.5 - 0.5 * Math.cos((Math.PI * (i + 0.5)) / length);
  }
  return ramp;
}

/**
 * Halves a square planar float image by exact 2x2 area averaging.
 *
 * The only downscale this pipeline needs, because the offered factors are the
 * model's native 4x and a clean 2x taken from it. An area average is not just
 * the cheap option here, it is the correct one: a windowed-sinc filter would
 * overshoot at the hard alpha edges of a cut-out, and overshoot on alpha is
 * exactly the halo that ruins a direct-to-film print.
 */
export function halvePlanar(src: Float32Array, edge: number, channels: number): Float32Array {
  const half = edge >> 1;
  const out = new Float32Array(channels * half * half);
  for (let c = 0; c < channels; c++) {
    const srcPlane = c * edge * edge;
    const outPlane = c * half * half;
    for (let y = 0; y < half; y++) {
      const r0 = srcPlane + (y << 1) * edge;
      const r1 = r0 + edge;
      const outRow = outPlane + y * half;
      for (let x = 0; x < half; x++) {
        const x0 = x << 1;
        out[outRow + x] = (src[r0 + x0] + src[r0 + x0 + 1] + src[r1 + x0] + src[r1 + x0 + 1]) * 0.25;
      }
    }
  }
  return out;
}

/**
 * Bleeds artwork colour outwards into transparent pixels, in place.
 *
 * A cut-out PNG usually stores black in its fully-transparent pixels. The
 * network never sees alpha, so without this it sees a black cliff exactly
 * where the artwork ends and dutifully sharpens it — the result is a dark
 * fringe that survives into the alpha-composited output and prints as a halo
 * around the design on the garment.
 *
 * Alpha is left untouched; only the colour under it changes.
 */
export function bleedEdgeColour(rgba: Uint8ClampedArray, width: number, height: number, passes: number): void {
  const total = width * height;
  const solid = new Uint8Array(total);
  let transparent = 0;
  for (let p = 0; p < total; p++) {
    if (rgba[p * 4 + 3] > 0) solid[p] = 1;
    else transparent++;
  }
  if (transparent === 0 || transparent === total) return;

  const next = new Uint8Array(solid);
  for (let pass = 0; pass < passes; pass++) {
    let filled = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (solid[p]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width || (dx === 0 && dy === 0)) continue;
            const q = ny * width + nx;
            if (!solid[q]) continue;
            r += rgba[q * 4];
            g += rgba[q * 4 + 1];
            b += rgba[q * 4 + 2];
            n++;
          }
        }
        if (n === 0) continue;
        rgba[p * 4] = r / n;
        rgba[p * 4 + 1] = g / n;
        rgba[p * 4 + 2] = b / n;
        next[p] = 1;
        filled++;
      }
    }
    if (filled === 0) break;
    solid.set(next);
  }
}

/** Whether any pixel is not fully opaque — i.e. whether alpha needs its own pass. */
export function hasTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) return true;
  }
  return false;
}
