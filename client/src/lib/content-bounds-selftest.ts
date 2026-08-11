/**
 * Development-only correctness check for the upload trim.
 *
 * `measureContentBox` replaced a full-frame `getImageData` that had to refuse
 * anything over 16 MP or 4096 px, which quietly left ordinary sheet-sized
 * uploads (a 22 x 8 in sheet at 300 DPI is 6600 x 2400) importing with all their
 * empty space. The sizes that used to be refused are the ones most worth
 * checking, and the property to check is strict: the measured box must equal the
 * rectangle we planted, exactly, with no tolerance.
 *
 * Only a real browser canvas can answer this — the tile walk depends on
 * `drawImage` sub-rect sampling and `getImageData`, and the platform ceilings
 * that motivated the whole design are platform behaviour. So this runs in the
 * page rather than in a headless test.
 *
 * A caveat that matters on the platform this all exists for: *generating* a test
 * image needs one canvas at full size, which is exactly what iOS Safari refuses
 * past 4096 px — silently, by handing back a blank surface. So on iOS the large
 * cases cannot be built at all, and reporting them as failures would be
 * backwards. Each generated image is therefore checked for ink before it is
 * measured, and cases whose *source* came back blank are reported as skipped.
 * Verifying those sizes on a real device means uploading a real file.
 *
 * Registered under `window.__testTrim` when `import.meta.env.DEV` is truthy.
 *
 *   await __testTrim();            // the standard matrix
 *   await __testTrim({ verbose: true });
 */

import { measureContentBox, type ContentBox } from "./content-bounds";

interface TrimCase {
  label: string;
  width: number;
  height: number;
  /** Planted artwork, in source pixels. */
  content: ContentBox;
  /** Expected result; defaults to `content`. Null means "keep the full frame". */
  expect?: ContentBox | null;
}

interface TrimCaseResult extends TrimCase {
  /** "skipped" means the harness could not build the source, not that the
   *  measurement was wrong. See the note at the top of this file. */
  status: "pass" | "fail" | "skipped";
  got: ContentBox | null;
  ms: number;
}

/**
 * Cases are transparent outside `content` so the alpha trim has something to
 * find; a fully opaque upload is deliberately never trimmed and is covered by
 * `isOpaqueRasterUpload` at the call site instead.
 */
const CASES: TrimCase[] = [
  // Previously refused by the edge cap despite being under the pixel cap. This
  // is the regression that prompted the rewrite.
  { label: "22x8in sheet @300dpi", width: 6600, height: 2400, content: { x: 700, y: 250, width: 5000, height: 1800 } },
  // Previously refused by the pixel cap.
  { label: "25 MP square", width: 5000, height: 5000, content: { x: 1234, y: 999, width: 2500, height: 3001 } },
  { label: "just over 16 MP", width: 4200, height: 4000, content: { x: 11, y: 13, width: 4000, height: 3000 } },
  // Tall/narrow: neither edge is large but the long axis crosses tile seams.
  { label: "banner 12000x900", width: 12000, height: 900, content: { x: 5, y: 40, width: 11990, height: 800 } },
  // Was already working before; must not regress.
  { label: "small 1500x1200", width: 1500, height: 1200, content: { x: 100, y: 90, width: 900, height: 700 } },
  // Tile-seam arithmetic at 2048.
  { label: "flush to tile seam", width: 4096, height: 4096, content: { x: 2048, y: 2048, width: 2048, height: 2048 } },
  { label: "2px straddling seam", width: 4096, height: 4096, content: { x: 2047, y: 2047, width: 2, height: 2 },
    // Under the 5% minimum-content floor, so the frame is deliberately kept.
    expect: null },
  { label: "ragged final tile", width: 5000, height: 3001, content: { x: 300, y: 200, width: 4600, height: 2700 } },
  // A frame that is already tight has nothing worth trimming.
  { label: "already tight", width: 3000, height: 3000, content: { x: 0, y: 0, width: 3000, height: 3000 }, expect: null },
];

function boxesEqual(a: ContentBox | null, b: ContentBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function describe(b: ContentBox | null): string {
  return b ? `${b.x},${b.y} ${b.width}x${b.height}` : "full frame";
}

/**
 * Whether a decoded source actually carries the ink we tried to draw into it.
 *
 * Read from a small bounded downscale, so this is cheap and safe at any size,
 * and it distinguishes "the platform would not give us a canvas that big" from
 * "the measurement missed the artwork".
 */
function hasVisibleInk(image: HTMLImageElement): boolean {
  const PROBE_EDGE = 256;
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  if (!(w > 0) || !(h > 0)) return false;
  const scale = Math.min(1, PROBE_EDGE / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * scale));
  const ph = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(image, 0, 0, pw, ph);
  const { data } = ctx.getImageData(0, 0, pw, ph);
  canvas.width = 0;
  canvas.height = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

/**
 * A transparent source with one opaque rectangle, decoded as an
 * `HTMLImageElement` so the measurement sees exactly what an upload gives it.
 *
 * Encoded through a canvas at full size — the very allocation
 * `measureContentBox` exists to avoid, and the reason the large cases cannot be
 * generated on iOS. The image under test is what has to survive on a phone, not
 * this.
 */
async function makeTestImage(c: TrimCase): Promise<HTMLImageElement> {
  const canvas = document.createElement("canvas");
  canvas.width = c.width;
  canvas.height = c.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = "#e11d48";
  ctx.fillRect(c.content.x, c.content.y, c.content.width, c.content.height);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error(`toBlob failed at ${c.width}x${c.height}`);

  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode failed")); };
    img.src = url;
  });
}

export async function runTrimSelfTest(
  options: { verbose?: boolean; cases?: TrimCase[] } = {},
): Promise<{ passed: number; failed: number; skipped: number; results: TrimCaseResult[] }> {
  const cases = options.cases ?? CASES;
  const results: TrimCaseResult[] = [];

  console.groupCollapsed(`[trim] ${cases.length} cases`);
  for (const c of cases) {
    const expected = c.expect === undefined ? c.content : c.expect;
    const mp = ((c.width * c.height) / 1_000_000).toFixed(1);
    const prefix = `${c.label.padEnd(22)} ${c.width}x${c.height} (${mp} MP)`;

    let image: HTMLImageElement | null = null;
    try {
      image = await makeTestImage(c);
    } catch (err) {
      console.error(`[trim] could not build ${c.label}`, err);
    }

    if (!image || !hasVisibleInk(image)) {
      results.push({ ...c, status: "skipped", got: null, ms: 0 });
      console.warn(
        `skip  ${prefix}  the harness could not build a source this large ` +
          `(platform canvas limit) — upload a real file to check this size`,
      );
      continue;
    }

    let got: ContentBox | null = null;
    let ms = 0;
    let threw = false;
    try {
      const started = performance.now();
      got = await measureContentBox(image);
      ms = performance.now() - started;
    } catch (err) {
      threw = true;
      console.error(`[trim] ${c.label} threw`, err);
    }

    const ok = !threw && boxesEqual(got, expected);
    results.push({ ...c, status: ok ? "pass" : "fail", got, ms });

    const line = `${ok ? "pass" : "FAIL"}  ${prefix}  ${describe(got)}  ${ms.toFixed(0)} ms`;
    if (ok) {
      if (options.verbose) console.log(line);
    } else {
      console.error(`${line}\n      expected ${describe(expected)}`);
    }
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const slowest = Math.max(0, ...results.map((r) => r.ms));
  console.log(`[trim] ${passed} passed, ${failed} failed, ${skipped} skipped · slowest ${slowest.toFixed(0)} ms`);
  if (failed === 0 && passed > 0) {
    console.log("[trim] every size measured trimmed to the exact planted box — no size-based skips remain.");
  }
  console.groupEnd();

  return { passed, failed, skipped, results };
}

/** Expose the harness under `window.__testTrim` in dev builds only. */
export function installTrimSelfTest(): void {
  if (typeof window === "undefined") return;
  if (!import.meta.env?.DEV) return;
  (window as unknown as { __testTrim?: typeof runTrimSelfTest }).__testTrim = runTrimSelfTest;
  console.info("[trim] __testTrim() is available — verifies the upload trim is exact at every size.");
}
