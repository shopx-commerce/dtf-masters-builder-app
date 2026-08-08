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
import {
  IOS_SAFE_CANVAS_DIM,
  MAX_UPLOAD_MEGAPIXELS,
  assertVectorFileWithinLimit,
} from "./image-budget";
import { VECTOR_TARGET_DPI, vectorPrintDpi } from "./vector-raster-limits";
import {
  analyseRawSvgExpansion,
  analyseSvgExpansion,
  type SvgExpansionReport,
} from "./svg-expansion";
import { rasteriseSvgToPngBlobSafe, type RasteriseOptions } from "./svg-raster";
import { SvgTooComplexError, isSVGFile, isEPSFile } from "./vector-file";

// Re-exported so callers that already hold this module keep their existing
// imports. Callers that only need these — the upload path deciding whether a
// file is a vector at all, or naming the error it caught — should import them
// from `./vector-file` directly, which does not pull DOMPurify in with them.
export { SvgTooComplexError, isSVGFile, isEPSFile };

export { VectorFileTooLargeError } from "./image-budget";

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
  /**
   * Print DPI for the imported design — 300, like a raster upload, because the
   * export path re-rasterises from `svgSource` at the placement size. Only
   * drops below 300 when the platform's canvas ceiling cannot hold a 300 DPI
   * render of a design this large.
   */
  dpi: number;
  /**
   * DPI of the on-screen preview in `image`, which is clamped for editor
   * memory and is usually lower than `dpi`. Diagnostics only — nothing about
   * print quality should be inferred from it.
   */
  previewDpi: number;
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
   * True when text requests a typeface the file never embeds and the
   * browser has no reason to have. Catches the common Illustrator/Figma
   * export that sets `font-family` with no `@font-face` — no URL to
   * detect, but the text still renders in a fallback font.
   */
  hasUnavailableFonts: boolean;
  /**
   * True when the SVG references an image or symbol that lives outside the
   * file. The `<img>` sandbox blocks the load, so that artwork vanishes
   * from the render with no error.
   */
  hasExternalAssets: boolean;
  /**
   * Instance references (`<use>`) that could not be kept — see `SanitisedSvg`.
   *
   * Zero for legitimate artwork. Above zero only when the file instantiates
   * something that lives outside it, which the renderer cannot fetch, so that
   * artwork is missing from the render and the caller should warn rather than
   * let the customer order the gap.
   */
  droppedInstanceRefs: number;
  /**
   * Expansion analysis of what survived sanitisation — the document our own
   * rasteriser draws. `parseSVG` throws `SvgTooComplexError` rather than
   * returning when a limit is hit, so this is always a passing report.
   */
  expansion: SvgExpansionReport;
  /**
   * The same analysis of the file as authored. `null` when the raw source had
   * no `<svg>` root to analyse. Now that `<use>` survives sanitisation the two
   * agree closely; they still differ where sanitisation dropped a reference
   * that pointed outside the document, or removed content for other reasons.
   */
  sourceExpansion: SvgExpansionReport | null;
  /**
   * Dimensions that the SVG root actually declared. Useful for the
   * caller when deciding whether to trust the sizing — the caller may
   * choose to display "no explicit size, using viewBox — please verify
   * dimensions" when this is `"viewbox"`.
   */
  dimensionSource: "attr" | "viewbox" | "fallback";
}

const TARGET_DPI = VECTOR_TARGET_DPI;

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
 *  - `<use>` is added back via `ADD_TAGS`. It is not in DOMPurify 3.4's SVG
 *    element allow-list, so the profile alone stripped *every* instance
 *    reference — including the legitimate ones. `<symbol>` + `<use>` is what
 *    Illustrator emits for a repeated-logo gangsheet, which is this product's
 *    core use case, and stripping it left `<defs>` with nothing instantiating
 *    them: measured, an icon set rasterised to a bitmap that was 0.000% inked
 *    while the same file with `<use>` admitted came out 3.768% inked. The
 *    import raised no error, so a customer could place a blank selection on the
 *    sheet and order film with nothing on it.
 *
 *    Admitting the tag is not sufficient on its own — see
 *    `restrictUseToLocalFragments` for the `href` restriction that has to come
 *    with it, and `svg-expansion` for why the expansion guard is now
 *    load-bearing rather than belt-and-braces.
 *
 * Event-handler attributes and `javascript:` URIs are stripped by the
 * SVG profile automatically; the `FORBID_ATTR` list here is redundant
 * defence-in-depth for the most common attack vectors. `xml:base` is in it
 * because it would re-root a bare `#fragment` at another document and so
 * defeat the fragment-only check below — the SVG profile already drops it
 * (verified against 3.4.13), but that is an allow-list detail we would rather
 * not silently inherit from a future version.
 */
const DOMPURIFY_CONFIG: DOMPurifyConfig = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_TAGS: ["use"],
  FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
  FORBID_ATTR: [
    "onload", "onerror", "onclick", "onmouseover", "onfocus", "onblur", "xml:base",
  ],
  KEEP_CONTENT: false,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * A same-document instance reference: `#` followed by an id, and nothing that
 * could be read as a path or a second document.
 *
 * Anything else has to go. Measured against DOMPurify 3.4.13 with `<use>`
 * admitted, its own URI handling drops only `data:` and `javascript:` from a
 * `use` href — `https://host/s.svg#i`, `http://…`, `//host/s.svg#i`,
 * `sprite.svg#i` and `/sprite.svg#i` all survive untouched. Every one of those
 * is a fetch of a document we do not control, which is an SSRF-shaped surface
 * on any renderer that resolves it and, in the `<img>` / sandboxed-frame path
 * we actually use, silently draws nothing. Excluding `/` and `\` inside the
 * fragment keeps a path from being smuggled through as an id.
 */
const LOCAL_FRAGMENT_REF = /^#[^#/\\]+$/;

/**
 * `<use>` elements this pass stripped an unusable reference from. Reset per
 * `sanitiseSvg` call, which is safe because `DOMPurify.sanitize` is
 * synchronous — nothing can interleave between the reset and the read.
 */
let droppedRefsThisPass = 0;

/**
 * Confine every admitted `<use>` to a same-document fragment.
 *
 * Registered once, at module scope, rather than added and removed around each
 * call: this module is the only DOMPurify caller in the app, and a hook that is
 * always present cannot be lost by an early return. It touches nothing but
 * `use`.
 *
 * The reference is stripped rather than the element, which leaves an inert
 * `<use>` that draws nothing — exactly what the renderer sandbox does with an
 * external reference anyway — and counts it so the caller can tell the customer
 * that artwork is missing instead of letting them order the gap.
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if ((el.nodeName || "").toLowerCase() !== "use") return;
  const raw =
    el.getAttribute("href") ??
    el.getAttributeNS(XLINK_NS, "href") ??
    el.getAttribute("xlink:href");
  if (raw !== null && LOCAL_FRAGMENT_REF.test(raw.trim())) return;
  el.removeAttribute("href");
  el.removeAttribute("xlink:href");
  el.removeAttributeNS(XLINK_NS, "href");
  // A `<use>` that never carried a reference draws nothing either way and is
  // not artwork the author expected to see, so it is not worth a warning.
  if (raw !== null) droppedRefsThisPass += 1;
});

export interface SanitisedSvg {
  source: string;
  /**
   * Instance references (`<use>`) that could not be kept.
   *
   * Only counts references sanitisation had to neutralise because they point
   * outside the document — `<use href="https://…">`, `sprite.svg#icon`, a
   * `data:` URI. Those genuinely cannot be represented: the renderer gets no
   * network access, so the artwork is absent from the render whatever we do,
   * and the caller should say so rather than let the customer order the gap.
   *
   * Legitimate same-document instances now survive, so this is 0 for real
   * artwork. It used to count *every* `<use>` in the file, because none of them
   * survived at all.
   */
  droppedInstanceRefs: number;
  /** True when we had to put the SVG namespace back on the root. See below. */
  namespaceRestored: boolean;
}

/**
 * DOMPurify serialises through the HTML serialiser and does **not** invent an
 * `xmlns` the input did not have: sanitising `<svg width="10" height="10">
 * <rect/></svg>` returns it verbatim, namespace-less. That output passes the
 * `includes("<svg")` check and XML-parses without a `parsererror` (root
 * `tagName` is `svg`, `namespaceURI` is null), so the dimension read succeeds
 * too — and then the Blob fails to load in an `<img>` and the import dies at
 * `onerror` as a generic "SVG failed to decode". Verified against DOMPurify
 * 3.4.13 in Chrome. Namespace-less roots are common in hand-written and
 * inlined SVG, so put it back.
 */
function ensureSvgNamespaces(source: string): { source: string; restored: boolean } {
  const rootMatch = source.match(/<svg\b[^>]*>/i);
  if (!rootMatch) return { source, restored: false };
  const rootTag = rootMatch[0];
  let patched = rootTag;
  let restored = false;
  if (!/\sxmlns\s*=/i.test(rootTag)) {
    patched = patched.replace(/^<svg\b/i, `<svg xmlns="${SVG_NS}"`);
    restored = true;
  }
  // A bare `xlink:href` with no declaration is a hard XML namespace error, so
  // the single parse below would fail on a file the renderer would have taken.
  if (/\bxlink:/i.test(source) && !/\sxmlns:xlink\s*=/i.test(rootTag)) {
    patched = patched.replace(/^<svg\b/i, `<svg xmlns:xlink="${XLINK_NS}"`);
    restored = true;
  }
  if (!restored) return { source, restored: false };
  return { source: source.replace(rootTag, patched), restored: true };
}

function sanitiseSvg(raw: string): SanitisedSvg {
  droppedRefsThisPass = 0;
  const cleaned = DOMPurify.sanitize(raw, DOMPURIFY_CONFIG) as unknown as string;
  if (!cleaned || !cleaned.includes("<svg")) {
    throw new Error("SVG failed sanitisation (empty or no <svg> root)");
  }
  // Both counts describe the pass that just ran, so read them now: the hook's
  // tally of references pointed outside the document, plus any whole `<use>`
  // DOMPurify itself still removed (a namespace-confused one, for instance).
  let droppedInstanceRefs = droppedRefsThisPass;
  for (const entry of DOMPurify.removed as Array<{ element?: Node }>) {
    const name = entry.element?.nodeName?.toLowerCase();
    if (name === "use") droppedInstanceRefs += 1;
  }
  const { source, restored } = ensureSvgNamespaces(cleaned);
  return { source, droppedInstanceRefs, namespaceRestored: restored };
}

/**
 * The one XML parse of the document.
 *
 * Every analysis below takes this `Document` rather than re-parsing the string.
 * Before, the raw customer source was parsed up to five times, and one of those
 * — `new DOMParser().parseFromString(rawSource, "image/svg+xml")` inside the
 * external-asset check — was the only place raw customer XML was parsed *as
 * XML*, with its DOCTYPE and internal DTD subset intact, leaving entity
 * expansion to the browser's own limits and a `parsererror` check to fail
 * closed. DOMPurify's own parse is `text/html`, which does not expand custom
 * entities at all (measured: a 3-level entity chain that an XML parse expands
 * to 10,000 characters comes out of sanitisation as the literal text `&d;`), so
 * parsing only the sanitised output removes that exposure entirely rather than
 * relying on a limit we do not control.
 *
 * Safe to move the analyses here because sanitisation preserves everything they
 * read: external `href` / `xlink:href` on `<image>` and `<feImage>`, `<style>`
 * block contents including `@font-face` and `@import` URLs, `font-family` /
 * `style` / `class` on text, `<symbol>` / `<pattern>` / `<defs>`, and the root
 * `width` / `height` / `viewBox`. All verified against the real config.
 */
function parseSanitisedSvg(source: string): Document | null {
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  if (doc.querySelector("parsererror")) return null;
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;
  return doc;
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
): SvgDimensions | null {
  const doc = parseSanitisedSvg(source);
  return doc ? getSvgDimensions(doc) : null;
}

export interface SvgDimensions {
  widthInches: number;
  heightInches: number;
  source: "attr" | "viewbox" | "fallback";
}

/** Dimension read against the already-parsed document. */
export function getSvgDimensions(doc: Document): SvgDimensions | null {
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
 * Families the browser can be relied on to resolve without the SVG
 * supplying anything. Generic CSS keywords plus the practical web-safe set
 * that ships on Windows/macOS/Android. Text in one of these still renders
 * close enough to the author's intent that warning would be noise.
 */
const RESOLVABLE_FONT_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji",
  "arial", "arial black", "helvetica", "helvetica neue", "times", "times new roman",
  "courier", "courier new", "verdana", "georgia", "tahoma", "trebuchet ms",
  "impact", "comic sans ms", "palatino", "garamond", "segoe ui", "roboto",
  "lucida sans", "lucida grande", "geneva",
]);

function parseFontFamilyList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().replace(/^['"]|['"]$/g, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Static analysis of an SVG's font risk.
 *
 *   - `hasText`: any `<text>`, `<tspan>`, or `<textPath>` with
 *     non-whitespace content.
 *   - `hasExternalFonts`: the CSS pulls a font over the network
 *     (`@font-face src: url(https…)`, `@import url(…)`). The `<img>`
 *     sandbox blocks those loads outright.
 *   - `hasUnavailableFonts`: text asks for a family that the file never
 *     declares via `@font-face` and that the browser has no reason to
 *     have. This is the *most common* real failure and the one a
 *     URL-based check misses entirely: Illustrator and Figma write plain
 *     `font-family="Bespoke Display"` with no `@font-face` at all, so
 *     there is no URL to find and the text silently renders in the
 *     default sans-serif.
 *
 * Deliberately conservative — over-warning ("your SVG might have font
 * issues") is cheap, under-warning ("looks fine to us") produces a
 * misprint. Text converted to outlines has no `<text>` at all and so
 * never warns.
 */
function analyseSvgFontRisk(doc: Document): {
  hasText: boolean;
  hasExternalFonts: boolean;
  hasUnavailableFonts: boolean;
} {
  const none = { hasText: false, hasExternalFonts: false, hasUnavailableFonts: false };

  // Any user-visible text run counts. Whitespace-only elements are
  // common in Illustrator exports and would produce false positives.
  const textNodes = Array.from(doc.querySelectorAll("text, tspan, textPath"));
  const hasText = textNodes.some((n) => (n.textContent ?? "").trim().length > 0);
  if (!hasText) return none;

  const styleBlocks = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");

  // Match `url("http…")`, `url('http…')`, `url(http…)` and `@import`.
  // Data URIs *do* work in the sandbox, so they must not trigger this.
  const externalFontRegex = /url\(\s*['"]?(?:https?:|\/\/)[^)'"]*['"]?\s*\)/i;
  const importRegex = /@import\s+(?:url\(\s*)?['"]?(?:https?:|\/\/)/i;
  const hasExternalFonts = externalFontRegex.test(styleBlocks) || importRegex.test(styleBlocks);

  // Families the file declares itself. Any `@font-face` counts, whether its
  // src is a data URI (which works) or a URL (already caught above).
  const declared = new Set<string>();
  for (const block of styleBlocks.match(/@font-face\s*\{[^}]*\}/gi) ?? []) {
    const family = block.match(/font-family\s*:\s*([^;}]+)/i);
    if (family) for (const f of parseFontFamilyList(family[1])) declared.add(f);
  }

  // Families the artwork actually asks for: `font-family` attributes, inline
  // `style="font-family:…"`, and CSS rules in `<style>`. Only the primary
  // (first) family matters — that is the typeface the author intended; later
  // entries are web fallbacks that would already look wrong in print.
  const requested: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[font-family], [style]"))) {
    const attr = el.getAttribute("font-family");
    if (attr) requested.push(attr);
    const inline = el.getAttribute("style")?.match(/font-family\s*:\s*([^;]+)/i);
    if (inline) requested.push(inline[1]);
  }
  const cssWithoutFontFace = styleBlocks.replace(/@font-face\s*\{[^}]*\}/gi, "");
  for (const decl of cssWithoutFontFace.match(/font-family\s*:\s*[^;}]+/gi) ?? []) {
    requested.push(decl.replace(/font-family\s*:\s*/i, ""));
  }

  const hasUnavailableFonts = requested.some((value) => {
    const primary = parseFontFamilyList(value)[0];
    return !!primary && !declared.has(primary) && !RESOLVABLE_FONT_FAMILIES.has(primary);
  });

  return { hasText, hasExternalFonts, hasUnavailableFonts };
}

/**
 * Detect references to assets that live outside the file.
 *
 * An SVG loaded through `<img>` gets no network access at all, so an
 * `<image href="https://…/logo.png">` or a relative `<use href="sprite.svg#id">`
 * resolves to nothing and that part of the artwork simply disappears — with no
 * error anywhere. Data URIs and same-document `#fragment` references are fine
 * and must not trigger this.
 *
 * Runs on the sanitised document. Sanitisation keeps external `href` and
 * `xlink:href` on `<image>` and `<feImage>` — verified — so the check is
 * unchanged for those. It never sees an external `<use href="sprite.svg#id">`,
 * because the sanitiser hook strips that reference before this runs; that case
 * is reported more precisely by `droppedInstanceRefs`, which knows how many.
 */
function hasExternalAssetReferences(doc: Document): boolean {
  return Array.from(doc.querySelectorAll("image, use, feImage")).some((el) => {
    const href =
      el.getAttribute("href") ??
      el.getAttributeNS(XLINK_NS, "href") ??
      el.getAttribute("xlink:href") ??
      "";
    const trimmed = href.trim();
    if (!trimmed) return false;
    return !trimmed.startsWith("data:") && !trimmed.startsWith("#");
  });
}

async function readFileText(file: File): Promise<string> {
  return await file.text();
}

/**
 * Rasterise a sanitised SVG to a PNG blob at exactly the requested pixel size.
 *
 * Exported because the import-time raster is only a preview: the export path
 * calls this again at the design's placement size so vector artwork is drawn
 * once, at print resolution, straight from the geometry. Rescaling the import
 * preview instead would throw away detail the source still has.
 *
 * The work happens in a process-isolated frame with a wall-clock budget — see
 * `svg-raster` for why that is the only shape of timeout that can actually
 * fire, and for the evidence that its output is byte-identical to rasterising
 * inline. The previous 15 s timeout here wrapped only `<img>` load, and could
 * not fire even for that: the load was holding the thread the timer needed.
 */
export async function rasteriseSvgToPngBlob(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number,
  options?: RasteriseOptions,
): Promise<Blob> {
  const { blob } = await rasteriseSvgToPngBlobSafe(sanitisedSource, widthPx, heightPx, options);
  return blob;
}

/** Rasterise a sanitised SVG at the requested pixel dimensions. */
async function rasteriseSvg(
  sanitisedSource: string,
  widthPx: number,
  heightPx: number,
): Promise<{ image: HTMLImageElement; blob: Blob }> {
  const blob = await rasteriseSvgToPngBlob(sanitisedSource, widthPx, heightPx);

  const rasterImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Failed to load rasterised PNG")); };
    img.src = url;
  });

  return { image: rasterImg, blob };
}

export async function parseSVG(file: File): Promise<ParsedSVGData> {
  assertVectorFileWithinLimit(file);
  const raw = await readFileText(file);

  // Before anything is handed to a renderer: would resolving this file's
  // references ask for more shapes than any real design contains? Judged on the
  // file as authored, because that is the version other parts of the app hand to
  // a renderer — see the note in svg-expansion.
  const sourceExpansion = analyseRawSvgExpansion(raw);
  if (sourceExpansion?.exceeded) throw new SvgTooComplexError(sourceExpansion);

  const { source: sanitised, droppedInstanceRefs, namespaceRestored } = sanitiseSvg(raw);

  const doc = parseSanitisedSvg(sanitised);
  if (!doc) throw new Error("Could not parse sanitised SVG");

  // And again on what actually survived sanitisation, which is what our own
  // rasteriser will draw. Cheap, and the two can differ in either direction.
  const expansion = analyseSvgExpansion(doc.documentElement);
  if (expansion.exceeded) throw new SvgTooComplexError(expansion);

  const dims = getSvgDimensions(doc);
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
  const previewDpi = Math.max(1, Math.round(widthPx / dims.widthInches));

  // Font risk analysis. Runs on the sanitised document (post-DOMPurify
  // stripping) so we're checking what actually reaches the rasteriser,
  // not what the user uploaded.
  const { hasText, hasExternalFonts, hasUnavailableFonts } = analyseSvgFontRisk(doc);

  if (namespaceRestored) {
    console.warn("[svg-parser] restored a missing xmlns on the sanitised root");
  }
  if (droppedInstanceRefs > 0) {
    console.warn(
      `[svg-parser] ${droppedInstanceRefs} <use> reference(s) pointed outside the ` +
        "document and were dropped; that artwork is missing from the render",
    );
  }

  return {
    image,
    pngBlob: blob,
    svgSource: sanitised,
    widthPx,
    heightPx,
    widthInches: dims.widthInches,
    heightInches: dims.heightInches,
    // Deliberately the print DPI, not the preview's. The raster above is
    // clamped so the editor holds a manageable bitmap; the export path goes
    // back to `svgSource` and renders at the placement size, so quoting the
    // preview's DPI here understated a file that prints at a full 300.
    dpi: vectorPrintDpi(dims.widthInches, dims.heightInches),
    previewDpi,
    hasText,
    hasExternalFonts,
    hasUnavailableFonts,
    hasExternalAssets: hasExternalAssetReferences(doc),
    droppedInstanceRefs,
    expansion,
    sourceExpansion,
    dimensionSource: dims.source,
  };
}
