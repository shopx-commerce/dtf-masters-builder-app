/**
 * Development-only stress-test harness for the upload pipeline.
 *
 * Purpose: reproduce the multi-file crash / lag scenarios reported by
 * users without needing them to source a stack of huge PNGs. Generates
 * synthetic test files in memory and pushes them through the same drop
 * event flow the UI uses, then reports timing and (when available)
 * memory usage per stage.
 *
 * Not exposed in production builds. Registered under
 * `window.__stressUpload` when `import.meta.env.DEV` is truthy.
 *
 * Usage from the browser console:
 *
 *   // Drop 20 synthetic PNGs, each 2048 × 2048 with random content.
 *   __stressUpload({ count: 20, dimension: 2048, format: "png" });
 *
 *   // Simulate a memory-heavy case: 8 files at 4096 × 4096.
 *   __stressUpload({ count: 8, dimension: 4096, format: "png" });
 *
 *   // 30 small PNGs to exercise the queue itself.
 *   __stressUpload({ count: 30, dimension: 512 });
 *
 * The generator uses `OffscreenCanvas` (with a DOM canvas fallback) so
 * the harness itself does not stall the main thread while producing test
 * files. Files are dispatched by triggering the same drop-target element
 * the user would use, so the concurrency queue and toasts behave
 * identically to a real drop.
 */

export interface StressTestOptions {
  count?: number;
  dimension?: number;
  format?: "png" | "jpeg";
  /** Target DOM element to dispatch the drop on. Defaults to the first
   *  element with `data-stress-drop-target`, then the `<body>`. */
  target?: Element;
  /** Overrides browser detection for mobile behaviour when debugging. */
  simulateMobile?: boolean;
}

interface StressTestReport {
  count: number;
  totalMs: number;
  perFileMs: number;
  memoryUsedMB?: number;
  memoryLimitMB?: number;
}

type ChromePerformanceMemory = {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
};

function readMemory(): ChromePerformanceMemory | undefined {
  if (typeof performance === "undefined") return undefined;
  const p = performance as unknown as { memory?: ChromePerformanceMemory };
  return p.memory;
}

/** Produce a Blob of the requested size and format without blocking the
 *  main thread when `OffscreenCanvas` is available. */
async function makeSyntheticImage(
  dimension: number,
  format: "png" | "jpeg",
  index: number,
): Promise<Blob> {
  const width = dimension;
  const height = dimension;
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";

  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2D not available");
    // Deterministic colour per file so multiple runs are visually
    // distinguishable in the layer panel.
    const hue = (index * 137) % 360;
    ctx.fillStyle = `hsl(${hue} 70% 50%)`;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "white";
    ctx.font = `${Math.max(24, Math.round(dimension / 10))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`#${index + 1}`, width / 2, height / 2);
    return await canvas.convertToBlob({ type: mime, quality: format === "jpeg" ? 0.92 : undefined });
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");
  const hue = (index * 137) % 360;
  ctx.fillStyle = `hsl(${hue} 70% 50%)`;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "white";
  ctx.font = `${Math.max(24, Math.round(dimension / 10))}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`#${index + 1}`, width / 2, height / 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("canvas.toBlob failed");
  return blob;
}

function resolveTarget(explicit?: Element): Element | null {
  if (explicit) return explicit;
  // Prefer the sidebar / hero uploader's file input — assigning
  // `input.files = dataTransfer.files` and firing `change` is the most
  // reliable cross-browser way to simulate a batch upload. `DragEvent`
  // with a synthetic `DataTransfer` is unreliable in Chromium.
  const inputs = document.querySelectorAll<HTMLInputElement>('input[type="file"][accept*="image"]');
  for (const input of inputs) {
    if (input.multiple) return input;
  }
  if (inputs.length > 0) return inputs[0];
  return document.body;
}

/** Feed files through the target. If the target is a file input we set
 *  its `files` property via `DataTransfer` and fire `change` — this is
 *  the pattern every drop handler in the app also supports. Falling
 *  back to a synthetic drop event is best-effort. */
function deliverFiles(target: Element, files: File[]): void {
  const dataTransfer = new DataTransfer();
  for (const f of files) dataTransfer.items.add(f);

  if (target instanceof HTMLInputElement && target.type === "file") {
    // The `files` property is read-only in some browsers; the assignment
    // via `Object.defineProperty` is the same trick Testing Library
    // uses for file-input tests.
    Object.defineProperty(target, "files", {
      configurable: true,
      value: dataTransfer.files,
    });
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
  target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
}

export async function runUploadStressTest(options: StressTestOptions = {}): Promise<StressTestReport> {
  const count = Math.max(1, options.count ?? 10);
  const dimension = Math.max(64, options.dimension ?? 2048);
  const format = options.format ?? "png";

  const target = resolveTarget(options.target);
  if (!target) throw new Error("No drop target found");

  console.groupCollapsed(`[stress] generating ${count} × ${dimension}²  ${format}`);
  const generateStart = performance.now();
  const files: File[] = [];
  for (let i = 0; i < count; i++) {
    const blob = await makeSyntheticImage(dimension, format, i);
    const name = `stress-${dimension}px-${String(i + 1).padStart(3, "0")}.${format === "jpeg" ? "jpg" : "png"}`;
    files.push(new File([blob], name, { type: `image/${format === "jpeg" ? "jpeg" : "png"}` }));
  }
  const generateMs = performance.now() - generateStart;
  console.log(`[stress] generated in ${generateMs.toFixed(0)} ms · avg blob size ${(files.reduce((s, f) => s + f.size, 0) / files.length / 1024).toFixed(0)} kB`);

  const memBefore = readMemory();
  const dropStart = performance.now();
  deliverFiles(target, files);
  // We don't get a clean "all uploads done" callback here because the
  // handler runs async — the caller can rely on the perf trace / memory
  // panel while the queue drains. This return value is the "trigger time",
  // not the "completion time".
  const dropMs = performance.now() - dropStart;
  const memAfter = readMemory();

  const report: StressTestReport = {
    count,
    totalMs: dropMs + generateMs,
    perFileMs: (dropMs + generateMs) / count,
    memoryUsedMB: memAfter ? memAfter.usedJSHeapSize / 1_048_576 : undefined,
    memoryLimitMB: memAfter ? memAfter.jsHeapSizeLimit / 1_048_576 : undefined,
  };

  console.log(`[stress] drop dispatched in ${dropMs.toFixed(0)} ms; queue drain will run in background`);
  if (memBefore && memAfter) {
    const growthMB = (memAfter.usedJSHeapSize - memBefore.usedJSHeapSize) / 1_048_576;
    console.log(`[stress] JS heap: ${growthMB.toFixed(0)} MB growth · ${(memAfter.usedJSHeapSize / 1_048_576).toFixed(0)} / ${(memAfter.jsHeapSizeLimit / 1_048_576).toFixed(0)} MB total`);
  }
  console.log("[stress] Watch DevTools → Performance / Memory tabs for the actual drain profile. Compare frame times and the memory panel between runs.");
  console.groupEnd();

  return report;
}

/** Expose the harness under `window.__stressUpload` in dev builds only. */
export function installUploadStressTest(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env?.DEV) return;
  (window as unknown as { __stressUpload?: typeof runUploadStressTest }).__stressUpload = runUploadStressTest;
  console.info("[stress] __stressUpload(opts) is available. Example: __stressUpload({ count: 20, dimension: 2048 })");
}
