/**
 * Client-side SVG → PNG rasteriser.
 *
 * Threat model: an SVG file is an XML document that browsers happily
 * parse and *execute*. `<script>`, event-handler attributes (`onclick`,
 * `onload`, …), `javascript:` URIs on `<a href>` / `<use xlink:href>`,
 * and `<foreignObject>` HTML are all real XSS vectors. The 2020 GitLab
 * SVG stored-XSS (CVE-2020-10977) is the canonical example. We MUST NOT
 * inject raw user-supplied SVG anywhere — not into `innerHTML`, not into
 * an `<img>` on the same origin, and not into a URL that a browser will
 * treat as an active document.
 *
 * Defence stack used here (client-side; a production deployment should
 * also sanitise on the server before persistence — the front-end is not
 * the security boundary):
 *
 *  1. Parse-and-rebuild sanitisation with **DOMPurify** in its SVG
 *     profile. This strips `<script>`, event handlers, `foreignObject`,
 *     JavaScript URIs, external resource loads, and other active
 *     content, while preserving legitimate vector geometry.
 *  2. Convert the sanitised SVG string to a `Blob` and load through an
 *     `<img>` element. Browsers *do not* run scripts inside `<img>`-loaded
 *     SVGs (WebKit / Blink / Gecko all agree). This is the safe render
 *     path even for un-sanitised SVGs, but combined with (1) we get
 *     defence in depth.
 *  3. Draw to a canvas at 300 DPI computed from the SVG's own
 *     `width` / `height` / `viewBox`. `parseSvgLengthToInches` supports
 *     `in`, `cm`, `mm`, `pt`, `px`, and unit-less user units — the same
 *     unit set the sticker-maker server implementation uses so the two
 *     pipelines produce identical print sizes.
 *  4. Clamp the target canvas to `IOS_SAFE_CANVAS_DIM` and the shared
 *     `MAX_UPLOAD_MEGAPIXELS` budget so pathological SVGs never crash
 *     iOS Safari.
 *
 * The result is a PNG `Blob` plus physical dimensions in inches. The
 * caller wraps this in an `ImageInfo` and feeds it into the same
 * pipeline PNG uploads use. High-quality export at print time can
 * re-rasterise from the sanitised SVG source (retained on `ImageInfo`
 * if needed by the export layer).
 *
 * Font handling (source of the majority of user complaints):
 * ---------------------------------------------------------
 * When an SVG is loaded through an `<img>` element the browser sandbox
 * blocks *all* external resource loads — including `@font-face src:
 * url(https://…)` and `@import url(…)`. Google Fonts, self-hosted CDN
 * fonts, Adobe Fonts, and any other externally-linked typeface silently
 * fall back to the browser's default sans-serif. The customer opens the
 * preview, sees their perfectly-typeset "Bespoke Display" logo
 * rendered in Arial, and files a support ticket.
 *
 * The only reliable in-browser fixes are:
 *   (a) The user converts text to paths / outlines before export.
 *   (b) The SVG embeds its fonts as `@font-face src: url(data:…)` so
 *       everything travels in one file.
 *
 * We can't force either, but we *can* detect that text with external
 * fonts is present and surface a warning toast recommending "convert
 * text to paths". `analyseSvgFontRisk` runs on the parsed document
 * without executing any content and returns the info the caller needs
 * to decide whether to warn.
 */

import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { IOS_SAFE_CANVAS_DIM, MAX_UPLOAD_MEGAPIXELS } from "./image-budget";

export interface ParsedSVGData {
  /** Rasterised PNG element ready to draw to a canvas. */
  image: HTMLImageElement;
  /** PNG blob ready to store in `ImageInfo.exportBlob`. */
  pngBlob: Blob;
  /** Sanitised SVG source (retain for higher-DPI re-rasterisation on export). */
  svgSource: string;
  widthPx: number;
  heightPx: number;
  widthInches: number;
  heightInches: number;
  dpi: number;
  /**
   * True when the SVG contains `<text>` elements. If also
   * `hasExternalFonts` is true, the caller should warn the user that
   * fonts may not render as authored. See analyseSvgFontRisk below.
   */
  hasText: boolean;
  /**
   * True when the SVG references at least one font by URL (via
   * `@font-face src: url(http…)` or `@import url(…)` in a `<style>`
   * block). Loading is blocked by the `<img>` sandbox, so any such
   * font falls back to the browser default — very visible on preview.
   */
  hasExternalFonts: boolean;
  /**
   * Dimensions that the SVG root actually declared. Useful for the
   * caller when deciding whether to trust the sizing — the caller may
   * choose to display "no explicit size, using viewBox — please verify
   * dimensions" when this is `"viewbox"`.
   */
  dimensionSource: "attr" | "viewbox" | "fallback";
}

const TARGET_DPI = 300;

/**
 * Fallback intrinsic size for SVGs with neither `width`/`height` nor a
 * usable `viewBox`. Matches the SVG spec's "300 × 150" default (the
 * same one HTML applies to `<embed type="image/svg+xml">`), sized in
 * inches at 72 DPI. Not a great print size but avoids a hard error and
 * gives the user a visible artefact to resize.
 */
const FALLBACK_WIDTH_IN = 300 / 72;
const FALLBACK_HEIGHT_IN = 150 / 72;

/**
 * DOMPurify configuration allowing vector graphics and inline styles.
 *
 * Design changes from the earlier config:
 *
 *  - `<style>` is now allowed. Real-world logo SVGs from Illustrator,
 *    Figma, Sketch, and Inkscape routinely embed a `<style>` block that
 *    sets classes referenced by `class="…"` on paths. Stripping
 *    `<style>` broke fills, strokes, and text formatting for a huge
 *    slice of legitimate files. DOMPurify's SVG profile still parses
 *    the CSS and removes anything it cannot recognise as safe (no
 *    `expression()`, no `behavior:`, no `-moz-binding`, no
 *    `javascript:` URIs).
 *
 *  - `foreignObject` remains forbidden. It's the primary escape hatch
 *    for injecting arbitrary HTML/JS into an "SVG" file.
 *
 *  - `<script>` / `<iframe>` / `<object>` / `<embed>` remain forbidden
 *    for obvious reasons.
 *
 * Event-handler attributes and `javascript:` URIs are stripped by the
 * SVG profile automatically; the `FORBID_ATTR` list here is redundant
 * defence-in-depth for the most common attack vectors.
 */
const DOMPURIFY_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
  FORBID_ATTR: ["onload", "onerror", "onclick", "onmouseover", "onfocus", "onblur"],
  KEEP_CONTENT: false,
};

function sanitiseSvg(raw: string): string {
  const cleaned = DOMPurify.sanitize(raw, DOMPURIFY_CONFIG) as unknown as string;
  if (!cleaned || !cleaned.includes("<svg")) {
    throw new Error("SVG failed sanitisation (empty or no <svg> root)");
  }
  return cleaned;
}

/**
 * Parse one SVG length value (e.g. `"3.5in"`, `"90mm"`, `"900px"`, `"900"`)
 * to inches. Returns `null` for values we can't resolve — including `%`
 * which is meaningless without a containing block. Matches the
 * behaviour of the sticker-maker server `parseSvgLengthToInches` so
 * the two rasterisers agree on physical size.
 */
export function parseSvgLengthToInches(raw: string): number | null {
  const m = raw.trim().match(/^([\d.]+(?:e[+-]?\d+)?)\s*(in|cm|mm|pt|px|pc|)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n) || n <= 0) return null;
  switch ((m[2] ?? "").toLowerCase()) {
    case "in": return n;
    case "cm": return n / 2.54;
    case "mm": return n / 25.4;
    case "pt": return n / 72;
    // `pc` (picas) — 1 pica = 12 points, so 1 pica = 1/6 inch. Real
    // print SVGs from InDesign / Illustrator export in picas
    // occasionally. Adding this closes a subtle sizing bug where a
    // "10pc" logo was interpreted as 10 user units and imported at
    // 0.10 inches wide.
    case "pc": return n / 6;
    case "px": return n / 96;
    default: return n / 96;
  }
}

/**
 * Extract physical dimensions from an SVG string. Priority order:
 *
 *   1. Explicit `width` + `height` with parseable units → trusted.
 *   2. `viewBox` → treat width/height as user-unit CSS pixels (96
 *      user-units = 1 inch). This is what the SVG spec says an SVG
 *      with a viewBox but no width/height should be rendered at.
 *   3. Fallback default (300 × 150 px at 72 DPI). Should never be hit
 *      for a real design file but avoids throwing on empty SVGs.
 *
 * Returns the source of the dimensions alongside the values so callers
 * can decide whether to warn ("no explicit size — using viewBox").
 *
 * Percent units (`width="100%"`) are treated as absent because they're
 * meaningless without a containing block and always represent the SVG
 * being authored for on-screen fluid layout, not print.
 */
export function getSvgDimensionsFromSource(
  source: string,
): { widthInches: number; heightInches: number; source: "attr" | "viewbox" | "fallback" } | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, "image/svg+xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  const w = root.getAttribute("width");
  const h = root.getAttribute("height");
  const wIn = w ? parseSvgLengthToInches(w) : null;
  const hIn = h ? parseSvgLengthToInches(h) : null;
  if (wIn !== null && hIn !== null) {
    return { widthInches: wIn, heightInches: hIn, source: "attr" };
  }

  const vb = root.getAttribute("viewBox");
  if (vb) {
    const parts = vb.trim().split(/[\s,]+/).map(Number);
    if (parts.length >= 4 && parts.slice(2).every((n) => isFinite(n) && n > 0)) {
      // Handle the common case where only one of width/height was set.
      // The other is derived from the viewBox aspect ratio so we don't
      // squash or stretch the artwork.
      const vbW = parts[2];
      const vbH = parts[3];
      if (wIn !== null && hIn === null) {
        return { widthInches: wIn, heightInches: wIn * (vbH / vbW), source: "attr" };
      }
      if (hIn !== null && wIn === null) {
        return { widthInches: hIn * (vbW / vbH), heightInches: hIn, source: "attr" };
      }
      return { widthInches: vbW / 96, heightInches: vbH / 96, source: "viewbox" };
    }
  }

  return { widthInches: FALLBACK_WIDTH_IN, heightInches: FALLBACK_HEIGHT_IN, source: "fallback" };
}

/**
 * Static analysis of an SVG's font risk. Returns two flags:
 *
 *   - `hasText`: any `<text>`, `<tspan>`, or `<textPath>` element with
 *     non-whitespace content.
 *   - `hasExternalFonts`: any `<style>` block whose CSS references an
 *     external URL (`@font-face src: url(https…)`, `url("http…")`,
 *     `@import url(…)`), OR any element with a `font-family` attribute
 *     whose value doesn't match the SVG's own embedded `@font-face`
 *     declarations.
 *
 * A pure static analysis is deliberately conservative — we're happy to
 * over-warn ("your SVG might have font issues") but never under-warn
 * ("looks fine to us" and then it renders wrong). Users who have
 * outlined their text see no warning; users who haven't get told what
 * to do.
 */
function analyseSvgFontRisk(source: string): { hasText: boolean; hasExternalFonts: boolean } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(source, "image/svg+xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) return { hasText: false, hasExternalFonts: false };

  // Any user-visible text run counts. Whitespace-only elements are
  // common in Illustrator exports and would produce false positives.
  const textNodes = Array.from(doc.querySelectorAll("text, tspan, textPath"));
  const hasText = textNodes.some((n) => (n.textContent ?? "").trim().length > 0);

  // Font-declaration analysis. We pull out every CSS declaration in a
  // `<style>` block plus every `font-family` attribute in the tree,
  // then look for URL-loaded fonts (which the browser sandbox will
  // silently drop for `<img>`-mode SVGs).
  const styleBlocks = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  // Match `url("http…")`, `url('http…')`, and `url(http…)` — case-
  // insensitive. Also match `@import url("http…")`. Data URIs (which
  // *do* work in the sandbox) are explicitly excluded so we don't
  // falsely warn on SVGs that correctly embed their fonts.
  const externalFontRegex = /url\(\s*['"]?(?:https?:|\/\/)[^)'"]*['"]?\s*\)/i;
  const importRegex = /@import\s+(?:url\(\s*)?['"]?(?:https?:|\/\/)/i;
  const hasExternalFonts = externalFontRegex.test(styleBlocks) || importRegex.test(styleBlocks);

  return { hasText, hasExternalFonts };
}

async function readFileText(file: File): Promise<string> {
  return await file.text();
}

function loadSvgAsImage(sanitisedSource: string, timeoutMs = 15_000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    // A Blob (over a plain data: URL) avoids CSP issues and lets us
    // revoke the URL as soon as the image finishes decoding.
    const blob = new Blob([sanitisedSource], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const timer = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG load timed out"));
    }, timeoutMs);
    img.decoding = "async";
    img.onload = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      reject(new Error("SVG failed to decode"));
    };
    img.src = url;
  });
}

/** Rasterise a sanitised SVG at the requested pixel dimensions. */
async function rasteriseSvg(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number,
): Promise<{ image: HTMLImageElement; blob: Blob }> {
  const svgImg = await loadSvgAsImage(sanitisedSource);

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) throw new Error("Could not create canvas context for SVG rasterisation");
  ctx.clearRect(0, 0, widthPx, heightPx);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(svgImg, 0, 0, widthPx, heightPx);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Failed to encode SVG as PNG");

  const rasterImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load rasterised PNG")); };
    img.src = url;
  });

  canvas.width = 0;
  canvas.height = 0;

  return { image: rasterImg, blob };
}

export async function parseSVG(file: File): Promise<ParsedSVGData> {
  const raw = await readFileText(file);
  const sanitised = sanitiseSvg(raw);

  const dims = getSvgDimensionsFromSource(sanitised);
  if (!dims) throw new Error("Could not determine SVG dimensions");

  let widthPx = Math.max(1, Math.round(dims.widthInches * TARGET_DPI));
  let heightPx = Math.max(1, Math.round(dims.heightInches * TARGET_DPI));

  // Clamp to iOS Safari canvas ceiling.
  const dimensionalScale = Math.min(
    IOS_SAFE_CANVAS_DIM / Math.max(widthPx, 1),
    IOS_SAFE_CANVAS_DIM / Math.max(heightPx, 1),
    1,
  );
  // Clamp to the shared MP budget.
  const megapixelScale = Math.min(
    Math.sqrt((MAX_UPLOAD_MEGAPIXELS * 1_000_000) / Math.max(widthPx * heightPx, 1)),
    1,
  );
  const safetyScale = Math.min(dimensionalScale, megapixelScale);
  if (safetyScale < 1) {
    widthPx = Math.max(1, Math.round(widthPx * safetyScale));
    heightPx = Math.max(1, Math.round(heightPx * safetyScale));
  }

  const { image, blob } = await rasteriseSvg(sanitised, widthPx, heightPx);
  const effectiveDpi = Math.max(1, Math.round(widthPx / dims.widthInches));

  // Font risk analysis. Runs on the sanitised source (post-DOMPurify
  // stripping) so we're checking what actually reaches the rasteriser,
  // not what the user uploaded.
  const { hasText, hasExternalFonts } = analyseSvgFontRisk(sanitised);

  return {
    image,
    pngBlob: blob,
    svgSource: sanitised,
    widthPx,
    heightPx,
    widthInches: dims.widthInches,
    heightInches: dims.heightInches,
    dpi: effectiveDpi,
    hasText,
    hasExternalFonts,
    dimensionSource: dims.source,
  };
}

export function isSVGFile(file: File): boolean {
  return file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
}

export function isEPSFile(file: File): boolean {
  const t = file.type.toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".eps") ||
    t === "application/postscript" ||
    t === "application/eps" ||
    t === "application/x-eps"
  );
}
