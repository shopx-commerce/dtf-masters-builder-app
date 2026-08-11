/**
 * Static expansion analysis for imported SVG.
 *
 * The problem this guards
 * ----------------------
 * An SVG's *source* size says almost nothing about how much work it asks the
 * renderer for, because `<use>` instantiates a subtree by reference. A chain
 * where each level holds two `<use>` of the level below it doubles the rendered
 * primitive count per level while the file grows linearly:
 *
 *   <g id="a"><rect/></g>
 *   <g id="b"><use href="#a"/><use href="#a"/></g>
 *   <g id="c"><use href="#b"/><use href="#b"/></g>   ...
 *
 * Nothing about that is malicious or even invalid, and a badly-exported
 * Illustrator file with deeply nested symbol instances can approach it by
 * accident. Thirty levels is a couple of kilobytes that asks for ~10^9
 * primitives. Measured on the raster path with sanitisation bypassed, depth 16
 * (65k primitives, 1.6 KB of source) blocked the main thread for 66 seconds and
 * depth 18 never came back at all.
 *
 * Which document this has to analyse, and why it is the raw one
 * -------------------------------------------------------------
 * The raw file, as authored, for two reasons.
 *
 * The first is that this is now the only thing standing between a `<use>` bomb
 * and our own rasteriser. `svg-parser` admits `<use>` to the DOMPurify config,
 * because the profile's refusal to allow-list it was importing every legitimate
 * `<symbol>`-based file as a blank bitmap. That fix means the chain above
 * survives sanitisation intact and reaches the renderer, so this guard is
 * load-bearing rather than belt-and-braces. It was written against the full
 * authored reference graph from the start, which is exactly why it still holds.
 *
 * The second is that the raw file reaches a renderer by a second route we do not
 * control: the uploads library builds its sidebar thumbnail by handing the
 * unmodified `File` to an `<img>`, so the browser resolves the author's graph
 * whatever sanitisation would have done to it. Measured, that freezes the tab
 * indefinitely. `useImageEditorModelUploadCrop` now runs that save only after
 * this guard has passed the file, so the count that gates the thumbnail is the
 * count in the file as authored — which is what `analyseRawSvgExpansion` reads.
 *
 * Reading it does not reintroduce the XML entity-expansion exposure that moving
 * to a single sanitised parse removed: the raw source is parsed as `text/html`,
 * exactly as DOMPurify parses it, and the HTML parser does not expand custom
 * DTD entities at all. The reference graph survives an HTML parse intact, which
 * is the only thing this needs.
 *
 * Thresholds are set from measurement; see the constants below.
 *
 * Cost model, and why `<pattern>` is not a tile multiplier
 * -------------------------------------------------------
 * A naive model multiplies a pattern's content by its tile count, which for a
 * 4-unit tile over a 400-unit fill is 10,000x. Measured, that is simply wrong:
 * the browser rasterises a pattern tile once and repeats the bitmap, so a
 * pattern fill with a nominal 5,000 tiles drew in 1 ms and a nominal 160,000
 * tiles in 2.9 ms. Treating tiles as a multiplier would reject every legitimate
 * halftone or fabric-swatch fill. What a pattern does cost is its content,
 * rendered a small number of times, so its content is counted once with a
 * constant weight taken from the measured overhead (a pattern wrapping a given
 * subtree cost ~6x that subtree alone).
 */

const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * Hard ceiling on rendered primitives, whatever the file looks like.
 *
 * Measured upper bound for plausible legitimate artwork, all deliberately more
 * extreme than a real order: a gangsheet laying out 300 copies of a
 * 2,000-path logo through `<use>` is 600,000 rendered primitives; 400 copies of
 * an 800-path logo is 320,000 and rasterises in 4.3 s; a dense flat
 * illustration of 60,000 paths (3.4 MB of source, no reuse at all) is 60,000
 * and rasterises in 2.6 s. This sits ~3.3x above the worst of those and three
 * orders of magnitude below what a `<use>` chain reaches by depth 24.
 */
export const MAX_EFFECTIVE_PRIMITIVES = 2_000_000;

/**
 * Above this many primitives the expansion factor starts to matter, below it
 * nothing is rejected on amplification grounds however the count was reached.
 */
export const AMPLIFIED_PRIMITIVE_FLOOR = 50_000;

/**
 * Ratio of rendered primitives to primitives actually present in the source.
 *
 * This, not the absolute count, is what separates a bomb from heavy artwork.
 * Measured on the corpus: the 400-copy logo sheet above expands 400x, the
 * 300-copy one 300x, three levels of legitimate icon / row / block nesting
 * 120x, an icon set 25x, and a flat illustration 1x. A `<use>` chain expands
 * 65,536x at depth 16 and 1,048,576x at depth 20 — four orders of magnitude
 * clear of anything legitimate, which is why the two are easy to separate even
 * though 1,000x is only 2.5x above the worst legitimate reading. Erring
 * generous is deliberate: rejecting a paying customer's artwork is worse than a
 * slow import, and the rasterisation timeout in `svg-raster` is the backstop
 * for anything that slips through.
 *
 * Nothing is rejected on this ratio below `AMPLIFIED_PRIMITIVE_FLOOR`, which is
 * what keeps small-but-heavily-reused files out of it: a `<use>` chain inside a
 * pattern tile is allowed through depth 13 (32,769 primitives, measured 5.7 s)
 * and refused from depth 14 (65,537, measured 13.7 s, and depth 16 never
 * finished at all).
 */
export const MAX_EXPANSION_FACTOR = 1_000;

/**
 * Constant weight for a pattern's content. See the header note: tile count is
 * deliberately *not* a multiplier. 4 approximates the measured overhead of
 * wrapping a subtree in a pattern.
 */
const PATTERN_CONTENT_WEIGHT = 4;

/** Keeps arithmetic finite for pathological inputs; well above any threshold. */
const COUNT_CEILING = 1_000_000_000;

/** Elements that put a mark on the canvas where they sit. */
const GRAPHIC_TAGS = new Set([
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "image",
]);

/**
 * Elements that define something for later reference and render nothing in
 * place. Their content is counted only where it is instantiated.
 */
const DEFINITION_TAGS = new Set([
  "defs", "symbol", "pattern", "marker", "mask", "clippath", "filter",
  "lineargradient", "radialgradient", "style", "title", "desc", "metadata",
  "animate", "animatetransform", "animatemotion", "animatecolor", "set", "view",
  "font", "font-face", "glyph", "missing-glyph", "script",
]);

/** Definition wrappers whose children are what an instance actually draws. */
const INSTANTIABLE_WRAPPERS = new Set([
  "symbol", "pattern", "defs", "marker", "mask", "clippath",
]);

export interface SvgExpansionReport {
  /** Primitives the renderer would be asked to draw, after resolving references. */
  effectivePrimitives: number;
  /** Primitives physically present in the source, however many times reused. */
  sourcePrimitives: number;
  /** `effectivePrimitives / sourcePrimitives`, 1 when there is no reuse. */
  expansionFactor: number;
  /** True when the artwork should be rejected rather than handed to a renderer. */
  exceeded: boolean;
  /** Which limit was hit, for the message and for diagnostics. */
  reason: "total" | "amplified" | null;
  /** Counting was clamped at `COUNT_CEILING`; the real figure is larger still. */
  truncated: boolean;
  /**
   * A `<use>` referenced itself or a mutual partner. Invalid per spec and the
   * renderer refuses it, but the analysis has to survive it, so the cyclic edge
   * contributes nothing and this flag records that the file is malformed.
   */
  cyclicReferences: boolean;
  /** `<use>` elements whose target id is not in the document. */
  unresolvedReferences: number;
}

const localName = (el: Element): string => (el.localName || el.tagName).toLowerCase();

/**
 * Same-document fragment target of a `<use>` / `fill="url(#id)"` style
 * reference, resolved the way a renderer resolves it: `href` first, then the
 * legacy `xlink:href`, and only `#id` — a reference into another file is a
 * network load, which the `<img>` sandbox blocks, so it draws nothing.
 */
function fragmentTarget(el: Element): string | null {
  const raw =
    el.getAttribute("href") ??
    el.getAttributeNS(XLINK_NS, "href") ??
    // Present when the document was parsed without the xlink namespace declared.
    el.getAttribute("xlink:href");
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("#")) return null;
  const id = trimmed.slice(1);
  return id.length > 0 ? id : null;
}

/** Pattern ids referenced by this element's paint properties. */
function referencedPaintIds(el: Element): string[] {
  const out: string[] = [];
  const sources = [el.getAttribute("fill"), el.getAttribute("stroke"), el.getAttribute("style")];
  for (const value of sources) {
    if (!value || !value.includes("url(")) continue;
    for (const m of value.matchAll(/url\(\s*['"]?#([^)'"\s]+)['"]?\s*\)/g)) {
      out.push(m[1]);
    }
  }
  return out;
}

const clamp = (n: number): number => (n > COUNT_CEILING ? COUNT_CEILING : n);

const EMPTY_REPORT: SvgExpansionReport = {
  effectivePrimitives: 0, sourcePrimitives: 0, expansionFactor: 1,
  exceeded: false, reason: null, truncated: false,
  cyclicReferences: false, unresolvedReferences: 0,
};

/**
 * Effective rendered primitive count for an SVG root element.
 *
 * Linear in document size despite the exponential counts it reports, because
 * the cost of each referenced element is memoised: a depth-30 chain is 30
 * lookups producing 2^30, not 2^30 units of work. That memo is also what makes
 * the analysis safe on a file designed to blow it up.
 */
export function analyseSvgExpansion(root: Element | null): SvgExpansionReport {
  if (!root) return EMPTY_REPORT;

  // First definition wins, matching getElementById on a document with
  // duplicate ids. Ids outside the root cannot be referenced from inside it.
  const byId = new Map<string, Element>();
  for (const el of Array.from(root.querySelectorAll("[id]"))) {
    const id = el.getAttribute("id");
    if (id && !byId.has(id)) byId.set(id, el);
  }

  // Costs differ inside a pattern's content, so they memoise separately. A
  // pattern can only be nested inside another pattern, so "inside" is sticky.
  const memoOutside = new Map<Element, number>();
  const memoInside = new Map<Element, number>();
  const inProgress = new Set<Element>();
  let truncated = false;
  let cyclicReferences = false;
  let unresolvedReferences = 0;

  /** What one instance of `target` draws. */
  const instanceCost = (target: Element, inPattern: boolean): number => {
    const memo = inPattern ? memoInside : memoOutside;
    const cached = memo.get(target);
    if (cached !== undefined) return cached;
    if (inProgress.has(target)) {
      // Invalid self- or mutual reference. Contribute nothing rather than
      // recursing forever; the renderer refuses these too.
      cyclicReferences = true;
      return 0;
    }
    inProgress.add(target);
    const cost = INSTANTIABLE_WRAPPERS.has(localName(target))
      ? childrenCost(target, inPattern)
      : renderedCost(target, inPattern);
    inProgress.delete(target);
    memo.set(target, cost);
    return cost;
  };

  const childrenCost = (el: Element, inPattern: boolean): number => {
    let sum = 0;
    for (const child of Array.from(el.children)) {
      sum = clamp(sum + renderedCost(child, inPattern));
      if (sum >= COUNT_CEILING) { truncated = true; break; }
    }
    return sum;
  };

  /**
   * Paint-server content this element pulls in, e.g. a pattern fill.
   *
   * Charged once per pattern *definition*, not per reference and not per
   * nesting level, because that is what the renderer does: the tile is
   * rasterised once and repeated as a bitmap wherever it is used. Both of the
   * other models were measured to be wrong by a wide margin.
   *
   * Per nesting level is wrong: tile-nested patterns held their decode cost flat
   * at 21-23 ms from five levels to twenty, where compounding would have
   * predicted 4^20. Those files do get slower overall at depth (7.7 s at twenty
   * levels against 0.6 s at five) but every millisecond of it is `drawImage` and
   * PNG encode of a dense bitmap, not reference expansion — a cost `svg-raster`
   * bounds and this cannot distinguish from a legitimately busy halftone.
   *
   * Per reference is also wrong: a thousand shapes sharing one tile would score
   * a thousand times the tile, when the tile is built once.
   */
  const chargedPatterns = new Set<Element>();
  const paintCost = (el: Element, inPattern: boolean): number => {
    let extra = 0;
    for (const id of referencedPaintIds(el)) {
      const target = byId.get(id);
      if (!target || localName(target) !== "pattern") continue;
      if (chargedPatterns.has(target)) continue;
      chargedPatterns.add(target);
      const weight = inPattern ? 1 : PATTERN_CONTENT_WEIGHT;
      extra = clamp(extra + instanceCost(target, true) * weight);
    }
    return extra;
  };

  /** What this element draws where it sits in the tree. */
  const renderedCost = (el: Element, inPattern: boolean): number => {
    const tag = localName(el);
    if (DEFINITION_TAGS.has(tag)) return 0;

    if (tag === "use") {
      const id = fragmentTarget(el);
      if (!id) { unresolvedReferences += 1; return 0; }
      const target = byId.get(id);
      if (!target) { unresolvedReferences += 1; return 0; }
      const memo = inPattern ? memoInside : memoOutside;
      if (memo.get(target) === undefined && inProgress.has(target)) {
        cyclicReferences = true;
        return 0;
      }
      return clamp(instanceCost(target, inPattern) + paintCost(el, inPattern));
    }

    if (GRAPHIC_TAGS.has(tag)) return clamp(1 + paintCost(el, inPattern));

    // Containers: `g`, `a`, `switch`, nested `svg`, and anything unrecognised
    // that might still hold drawable children.
    return clamp(childrenCost(el, inPattern) + paintCost(el, inPattern));
  };

  const effectivePrimitives = renderedCost(root, false);
  const sourcePrimitives = root.querySelectorAll(
    "path, rect, circle, ellipse, line, polyline, polygon, text, image",
  ).length;

  const expansionFactor = sourcePrimitives > 0
    ? effectivePrimitives / sourcePrimitives
    : effectivePrimitives > 0 ? Number.POSITIVE_INFINITY : 1;

  let reason: SvgExpansionReport["reason"] = null;
  if (effectivePrimitives > MAX_EFFECTIVE_PRIMITIVES) {
    reason = "total";
  } else if (
    effectivePrimitives > AMPLIFIED_PRIMITIVE_FLOOR &&
    expansionFactor > MAX_EXPANSION_FACTOR
  ) {
    reason = "amplified";
  }

  return {
    effectivePrimitives,
    sourcePrimitives,
    expansionFactor: Number.isFinite(expansionFactor)
      ? Math.round(expansionFactor * 10) / 10
      : expansionFactor,
    exceeded: reason !== null,
    reason,
    truncated,
    cyclicReferences,
    unresolvedReferences,
  };
}

/**
 * The same analysis on the file exactly as the customer authored it.
 *
 * This is the one that matters — see the header note on which document reaches a
 * renderer. Parsed as `text/html` deliberately: it is the parse DOMPurify
 * already performs on this same string, it expands no DTD entities, and foreign
 * content rules keep the SVG subtree, its attributes and its self-closing tags
 * intact. Tag names come back lower-cased, which the tag sets here already
 * assume.
 *
 * Returns `null` when there is no `<svg>` root to analyse, leaving the decision
 * to the caller rather than reporting a misleading zero.
 */
export function analyseRawSvgExpansion(rawSource: string): SvgExpansionReport | null {
  let root: Element | null = null;
  try {
    root = new DOMParser().parseFromString(rawSource, "text/html").querySelector("svg");
  } catch {
    return null;
  }
  return root ? analyseSvgExpansion(root) : null;
}
