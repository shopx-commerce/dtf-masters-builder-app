/// <reference lib="webworker" />
/**
 * Client-side super-resolution, on the GPU, off the main thread.
 *
 * Runs `realesr-general-x4v3` (SRVGGNetCompact, ~1.2 M parameters) through
 * ONNX Runtime Web's WebGPU execution provider, tile by tile, and cross-fades
 * the tiles back together. Replaces a server round-trip to a hosted
 * Real-ESRGAN endpoint that no longer has a provider behind it.
 *
 * Alpha is the part that matters for direct-to-film. The old server path
 * flattened alpha away, upscaled RGB, then pasted the *original* mask back on
 * top — so the cut-out edge, which is the only edge that actually gets printed
 * on film, was never more than a resample of the input. Here alpha gets its
 * own pass through the same network (this is what Real-ESRGAN's own
 * `--alpha_upsampler realesrgan` mode does), and the colour underneath is
 * bled outwards first so the network never sees the black cliff that a
 * transparent PNG stores behind its cut-out.
 */

import * as ort from "onnxruntime-web/webgpu";
import {
  MODEL_SCALE,
  TILE_OVERLAP,
  TILE_SIZE,
  bleedEdgeColour,
  cosineRamp,
  halvePlanar,
  hasTransparency,
  planTiles,
} from "./upscale-tiling";

/** Colour-bleed distance, in source pixels. Comfortably past the visible fringe. */
const BLEED_PASSES = 12;

export interface UpscaleTimings {
  /** Wall-clock ms for the whole job, measured inside the worker. */
  totalMs: number;
  /** Wall-clock ms spent inside `session.run`. */
  inferenceMs: number;
  /** Tiles executed, counting the alpha pass. */
  tiles: number;
  /** Whether alpha got its own network pass. */
  alphaPass: boolean;
}

type Incoming =
  | { type: "init"; wasmPath: string; modelUrl: string }
  | {
      type: "warmup";
      /** Per-model-pixel cost at or below which the caller will offer the control. */
      maxUsPerModelPixel?: number;
      /** Measure again on an already-warmed session, rather than returning early. */
      resample?: boolean;
    }
  | {
      type: "upscale";
      requestId: number;
      rgba: Uint8ClampedArray;
      width: number;
      height: number;
      scale: number;
    }
  | { type: "cancel"; requestId: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let session: ort.InferenceSession | null = null;
let sessionPromise: Promise<ort.InferenceSession> | null = null;
let modelUrl = "";
let warmedUp = false;
const cancelled = new Set<number>();

/** Reused across every tile so a 49-tile job does not allocate 49 input buffers. */
const inputBuffer = new Float32Array(3 * TILE_SIZE * TILE_SIZE);

function getSession(): Promise<ort.InferenceSession> {
  if (session) return Promise.resolve(session);
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(modelUrl, {
      executionProviders: ["webgpu"],
      graphOptimizationLevel: "all",
    }).then(created => {
      session = created;
      return created;
    }).catch(err => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

/**
 * Copies one tile out of the source into the reused NCHW input buffer.
 *
 * Reads outside the image replicate the nearest edge pixel. `gray` fans the
 * alpha channel across all three inputs, which is how the alpha pass reuses a
 * three-channel colour network.
 */
function fillInput(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  inX: number,
  inY: number,
  gray: boolean,
): void {
  const plane = TILE_SIZE * TILE_SIZE;
  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const sy = Math.min(height - 1, Math.max(0, inY + ty));
    const rowBase = sy * width;
    const dstRow = ty * TILE_SIZE;
    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const sx = Math.min(width - 1, Math.max(0, inX + tx));
      const s = (rowBase + sx) * 4;
      const d = dstRow + tx;
      if (gray) {
        const a = rgba[s + 3] / 255;
        inputBuffer[d] = a;
        inputBuffer[plane + d] = a;
        inputBuffer[2 * plane + d] = a;
      } else {
        inputBuffer[d] = rgba[s] / 255;
        inputBuffer[plane + d] = rgba[s + 1] / 255;
        inputBuffer[2 * plane + d] = rgba[s + 2] / 255;
      }
    }
  }
}

/**
 * Cross-fades one finished tile into the destination.
 *
 * Weight ramps in from the tile's leading edge wherever a previous tile has
 * already written, and is 1 elsewhere; because the tile already in place holds
 * full weight across that same band, the two sum to exactly 1.
 */
function blendTile(
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  tile: Float32Array,
  tileEdge: number,
  dstX: number,
  dstY: number,
  ramp: Float32Array,
  rampLeft: boolean,
  rampTop: boolean,
  gray: boolean,
): void {
  const plane = tileEdge * tileEdge;
  const rampLen = ramp.length;

  // Clip once per tile rather than testing every pixel: at 4x a tile is four
  // million pixels and this loop was costing more than the inference it feeds.
  const txStart = Math.max(0, -dstX);
  const txEnd = Math.min(tileEdge, dstW - dstX);
  const tyStart = Math.max(0, -dstY);
  const tyEnd = Math.min(tileEdge, dstH - dstY);
  // Where the horizontal cross-fade ends and plain copying begins.
  const txPlain = rampLeft ? Math.min(txEnd, Math.max(txStart, rampLen)) : txStart;

  for (let ty = tyStart; ty < tyEnd; ty++) {
    const wy = rampTop && ty < rampLen ? ramp[ty] : 1;
    const tileRow = ty * tileEdge;
    const dstRow = (dstY + ty) * dstW + dstX;
    const blendRow = wy < 1;

    for (let tx = txStart; tx < txEnd; tx++) {
      const t = tileRow + tx;
      const d = (dstRow + tx) * 4;
      // Full weight over most of the tile, so most pixels are a plain store.
      const w = tx < txPlain ? ramp[tx] * wy : wy;

      if (gray) {
        // The three outputs are near-identical for a grey input; averaging
        // them is a touch steadier than picking one.
        const a = ((tile[t] + tile[plane + t] + tile[2 * plane + t]) * (255 / 3));
        dst[d + 3] = (blendRow || tx < txPlain) ? dst[d + 3] * (1 - w) + a * w : a;
      } else {
        const r = tile[t] * 255;
        const g = tile[plane + t] * 255;
        const b = tile[2 * plane + t] * 255;
        if (blendRow || tx < txPlain) {
          const inv = 1 - w;
          dst[d] = dst[d] * inv + r * w;
          dst[d + 1] = dst[d + 1] * inv + g * w;
          dst[d + 2] = dst[d + 2] * inv + b * w;
        } else {
          dst[d] = r;
          dst[d + 1] = g;
          dst[d + 2] = b;
        }
      }
    }
  }
}

async function runTiledPass(
  requestId: number,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  gray: boolean,
  ramp: Float32Array,
  onTile: () => void,
): Promise<number> {
  const active = await getSession();
  const plans = planTiles(width, height);
  const modelEdge = TILE_SIZE * MODEL_SCALE;
  const outEdge = TILE_SIZE * scale;
  let inferenceMs = 0;

  for (let i = 0; i < plans.length; i++) {
    if (cancelled.has(requestId)) throw new CancelledError();
    const plan = plans[i];
    fillInput(rgba, width, height, plan.inX, plan.inY, gray);

    const started = performance.now();
    const tensor = new ort.Tensor("float32", inputBuffer, [1, 3, TILE_SIZE, TILE_SIZE]);
    const results = await active.run({ input: tensor });
    inferenceMs += performance.now() - started;

    const raw = results.output.data as Float32Array;
    // 4x is the network's own output; 2x is an exact halving of it. Doing the
    // reduction per tile rather than at the end means a 2x job never has to
    // hold a full-size 4x intermediate — for a 2 MP design that would be a
    // 128 MB buffer to build and immediately throw three quarters of away.
    const out = outEdge === modelEdge ? raw : halvePlanar(raw, modelEdge, 3);

    blendTile(
      dst, dstW, dstH,
      out, outEdge,
      plan.inX * scale, plan.inY * scale,
      ramp, plan.rampLeft, plan.rampTop, gray,
    );

    onTile();
    // Macrotask yield: lets a `cancel` message land between tiles.
    if ((i & 3) === 3) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return inferenceMs;
}

class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

async function upscale(message: Extract<Incoming, { type: "upscale" }>): Promise<void> {
  const { requestId, rgba, width, height, scale } = message;
  const startedAt = performance.now();
  const dstW = width * scale;
  const dstH = height * scale;
  const dst = new Uint8ClampedArray(dstW * dstH * 4);

  const needsAlphaPass = hasTransparency(rgba);
  if (!needsAlphaPass) {
    for (let i = 3; i < dst.length; i += 4) dst[i] = 255;
  } else {
    bleedEdgeColour(rgba, width, height, BLEED_PASSES);
  }

  const ramp = cosineRamp(2 * TILE_OVERLAP * scale);
  const plans = planTiles(width, height);
  const totalTiles = plans.length * (needsAlphaPass ? 2 : 1);
  let done = 0;
  const onTile = () => {
    done++;
    ctx.postMessage({ type: "progress", requestId, completed: done, total: totalTiles });
  };

  let inferenceMs = await runTiledPass(
    requestId, rgba, width, height, scale, dst, dstW, dstH, false, ramp, onTile,
  );
  if (needsAlphaPass) {
    inferenceMs += await runTiledPass(
      requestId, rgba, width, height, scale, dst, dstW, dstH, true, ramp, onTile,
    );
  }

  const timings: UpscaleTimings = {
    totalMs: performance.now() - startedAt,
    inferenceMs,
    tiles: totalTiles,
    alphaPass: needsAlphaPass,
  };
  ctx.postMessage(
    { type: "result", requestId, rgba: dst, width: dstW, height: dstH, timings },
    [dst.buffer],
  );
}

/**
 * Compiles every shader the real job will need, and measures how fast this
 * machine actually is.
 *
 * Two jobs in one throwaway tile. First, shader compilation: it is paid once
 * per session, so spending it while the customer is still positioning their
 * design means their first actual click does not.
 *
 * Second — and this turned out to matter more — the timing. WebGPU adapters
 * differ by more than an order of magnitude for this workload, and on Windows
 * laptops Chrome cannot be steered to the discrete GPU at all
 * (crbug.com/369219127): a machine with a fast dedicated card will still hand
 * back its integrated one. Capability detection alone therefore says almost
 * nothing about whether this feature is usable, so the caller gets a measured
 * cost per model pixel and decides from that.
 *
 * Always at the size the real job uses. Timing a smaller tile to reach a
 * verdict sooner was tried and abandoned: at 128 px the per-pixel cost missed
 * the real figure by 3x on one adapter and swung by 2x between repeats on the
 * same one, because dispatch overhead rather than arithmetic dominates.
 *
 * The first run is not timed. It carries shader compilation, and — far worse —
 * the gate fires from the editor's design-added effect, so it lands while the
 * upload pipeline is still decoding, contouring and thumbnailing. Measured on
 * one RTX 5060: steady state is 1.2-1.6 us per model pixel, the same machine's
 * first run in an idle tab reads 2.1, and inside the real editor mid-upload it
 * read 19.3 — which withheld the control from a machine that finishes the
 * reference job in 8 s. A single sample cannot tell "slow adapter" from "busy
 * moment", and being wrong in the cautious direction still means silently
 * deleting the feature on hardware that can run it.
 *
 * So: take up to `CALIBRATION_SAMPLES` timed runs and keep the fastest, since
 * contention can only ever make a sample look slower than the hardware is.
 * `maxUsPerModelPixel` lets it stop early — once one sample is inside the
 * caller's budget the verdict cannot change, so a fast machine still answers
 * after a single timed run and only genuinely borderline or slow ones pay for
 * the rest.
 */
const CALIBRATION_SAMPLES = 4;

async function warmup(maxUsPerModelPixel?: number, resample = false): Promise<void> {
  if (warmedUp && !resample) return;
  const active = await getSession();
  inputBuffer.fill(0.5);
  const tensor = new ort.Tensor("float32", inputBuffer, [1, 3, TILE_SIZE, TILE_SIZE]);
  const plane = TILE_SIZE * TILE_SIZE;

  // Compile pass, untimed. Only needed once per session.
  if (!warmedUp) await active.run({ input: tensor });

  let best = Infinity;
  for (let sample = 0; sample < CALIBRATION_SAMPLES; sample++) {
    const started = performance.now();
    await active.run({ input: tensor });
    const us = ((performance.now() - started) * 1000) / plane;
    if (us < best) best = us;
    if (maxUsPerModelPixel !== undefined && best <= maxUsPerModelPixel) break;
    // Yield between samples so a cancel or an upscale request can land.
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  warmedUp = true;
  ctx.postMessage({ type: "ready", microsecondsPerModelPixel: best });
}

ctx.onmessage = async (event: MessageEvent<Incoming>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "init":
        ort.env.wasm.wasmPaths = message.wasmPath;
        // No COOP/COEP on this origin (and adding it would break the Shopify
        // embed), so `SharedArrayBuffer` is unavailable and wasm threads
        // cannot start. The WebGPU EP does not need them.
        ort.env.wasm.numThreads = 1;
        ort.env.logLevel = "error";
        modelUrl = message.modelUrl;
        break;
      case "warmup":
        await warmup(message.maxUsPerModelPixel, message.resample);
        break;
      case "upscale":
        cancelled.delete(message.requestId);
        try {
          await upscale(message);
        } finally {
          // Also on the cancelled path, so a cancel for a request that had
          // already finished does not sit in the set for the tab's lifetime.
          cancelled.delete(message.requestId);
        }
        break;
      case "cancel":
        cancelled.add(message.requestId);
        break;
    }
  } catch (err) {
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (err instanceof CancelledError) {
      ctx.postMessage({ type: "cancelled", requestId });
      return;
    }
    ctx.postMessage({
      type: "error",
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
