/**
 * Whether the editor may offer "Increase Quality" at all.
 *
 * The control used to POST to `/api/upscale-image`, which proxies Replicate.
 * With no provider credential configured that route fails every single time,
 * so the button was a guaranteed dead end for every customer who found it.
 * Rather than delete the JSX, the toolbar asks this module whether upscaling
 * is available and renders nothing when it is not — so restoring the control
 * is a one-line change here, not a UI reconstruction.
 */

export type UpscaleSupport =
  | {
      available: true;
      backend: "webgpu";
      /** Adapter exposes `shader-f16`, so the half-precision model can be used. */
      f16: boolean;
    }
  | { available: false; reason: "disabled" | "no-webgpu" };

/**
 * Master switch. `false` hides the control everywhere, in every language, on
 * every breakpoint — set it and the dead end is gone.
 */
export const UPSCALE_FEATURE_ENABLED = true;

let cached: Promise<UpscaleSupport> | null = null;

/**
 * Resolves once per tab.
 *
 * `navigator.gpu` existing is not enough: locked-down VMs, remote desktop
 * sessions and blocklisted drivers all expose the API and then hand back a
 * null adapter. Only an adapter that actually materialises counts.
 *
 * There is deliberately no WebAssembly fallback. ONNX Runtime's wasm path is
 * the documented alternative, but wasm threads need `SharedArrayBuffer`, which
 * needs COOP/COEP headers this origin does not send — and cannot start
 * sending, because they would break the Shopify storefront embed. That leaves
 * single-threaded SIMD for a 33-layer network across dozens of tiles, behind a
 * 26 MB binary download. A control that takes minutes reads as a broken app,
 * so on those machines the button simply is not offered.
 */
export function detectUpscaleSupport(): Promise<UpscaleSupport> {
  if (!cached) cached = probe();
  return cached;
}

/** Structural shape of the slice of WebGPU we touch; `lib.dom` has no WebGPU types. */
type MinimalAdapter = { features?: { has(name: string): boolean } };
type MinimalGPU = { requestAdapter(): Promise<MinimalAdapter | null> };

function getGPU(): MinimalGPU | undefined {
  return (navigator as Navigator & { gpu?: MinimalGPU }).gpu;
}

async function probe(): Promise<UpscaleSupport> {
  if (!UPSCALE_FEATURE_ENABLED) return { available: false, reason: "disabled" };
  const gpu = getGPU();
  if (!gpu) return { available: false, reason: "no-webgpu" };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { available: false, reason: "no-webgpu" };
    return { available: true, backend: "webgpu", f16: adapter.features?.has("shader-f16") ?? false };
  } catch {
    return { available: false, reason: "no-webgpu" };
  }
}
