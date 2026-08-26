/**
 * What "one colour" means in a file a customer actually uploads.
 *
 * The obvious rule — every visible pixel has the same RGB — is the rule a
 * designer would write and the rule almost no real artwork obeys. A logo saved
 * at 400 px has more anti-aliased edge pixels than solid ones, and every one of
 * those edges is a grey. A white design exported from a tool that flattened it
 * over black stores a half-transparent pixel as mid-grey. Line art scanned or
 * traced from a photo carries tonal shading. All three are one ink; only the
 * strict rule says otherwise, and it is what makes the feature refuse the files
 * it exists for.
 *
 * So this models artwork the way a printer sees it: a single ink K, and a
 * "paper" endpoint P meaning no ink at all (white or black, whichever the
 * artwork was flattened over). Every visible pixel is then somewhere on the
 * segment between them, and where it sits is its *coverage* — how much of that
 * one ink it carries. A grey edge pixel is not a second colour, it is 40% ink.
 * Recolouring becomes: keep the coverage, swap the ink.
 *
 * Three shapes of file have to be told apart, and the awkward part is that they
 * disagree about the same pixel:
 *
 *   - **uniform** — RGB is constant across visible pixels (possibly with a
 *     little noise). Coverage is 1 everywhere and alpha is already the whole
 *     story. This is the artwork the old rule accepted, and it must keep coming
 *     out byte for byte identical.
 *   - **premultiplied** — RGB falls in step with alpha, so RGB/α is constant.
 *     The ink is that constant, coverage is 1, and alpha again carries
 *     everything.
 *   - **blend** — RGB carries coverage that alpha does not: opaque greys
 *     running from the ink toward white or black. Coverage comes from where the
 *     colour sits on the segment, and the output alpha is scaled by it.
 *
 * A pixel of (128,128,128,128) is full-strength white ink at half opacity under
 * the second reading and half-coverage grey under the third. Apply the wrong
 * one and the artwork prints at a quarter of its density instead of half — the
 * softness gets counted twice. That is why the shape is decided once for the
 * whole image, from how well each explains the entire pixel population, and
 * never per pixel.
 *
 * Everything here works from statistics that fit in a fixed 128 KB regardless
 * of image size, gathered in one pass, so the streaming engine can keep its
 * constant-memory promise on a 60-megapixel print source.
 */
/** An 8-bit RGB colour. Re-exported by `color-change-core` for its callers. */
export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/** Colour-cube resolution: 16 levels per channel, 4096 bins. */
const BIN_SHIFT = 4;
const BIN_SIDE = 1 << (8 - BIN_SHIFT);
const BIN_COUNT = BIN_SIDE * BIN_SIDE * BIN_SIDE;
/** Per bin: weight, then weight-scaled r, g, b — so each bin's mean is exact. */
const BIN_STRIDE = 4;

/**
 * How far a colour may sit from the model before it counts as "not this ink".
 *
 * Euclidean distance in RGB. It has to clear the colour cube's own resolution
 * (two colours in one bin can be 15 apart per channel) while still separating
 * genuinely different inks, which are hundreds apart.
 */
const OFF_MODEL_DISTANCE = 30;

/** Channel spread below which the artwork is one colour plus encoder noise. */
const UNIFORM_CHANNEL_SPREAD = 10;

/** Alpha below which a pixel is too faint to say anything about RGB/α. */
const PREMUL_MIN_ALPHA = 32;

/** Standard deviation of RGB/α, per channel, that still reads as constant. */
const PREMUL_TOLERANCE = 12;

/** A blend needs the ink and the paper to be genuinely different colours. */
const MIN_PAPER_DISTANCE = 64;

/** Share of the ink weight that may sit off the model before refusing. */
export const MIN_DOMINANCE = 0.95;

/**
 * Coverage at or below which a pixel is paper rather than ink.
 *
 * An anti-aliased edge is a thin tail: most of the weight sits at full ink and
 * falls away toward the paper. A design that is heavy at *both* ends is not one
 * ink with soft edges, it is two inks — black lettering knocked out of a white
 * badge, or a greyscale photograph. Recolouring those as coverage would erase
 * everything at the paper end, so they are refused instead.
 */
const PAPER_END_COVERAGE = 0.15;
const MAX_PAPER_END_SHARE = 0.12;

/** Rows sampled by the statistics pass on a large image. */
const SAMPLE_TARGET_PIXELS = 8_000_000;

const BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const WHITE: RgbColor = { r: 255, g: 255, b: 255 };

/** 255/a, so the hot loop multiplies instead of dividing. */
const INV_ALPHA = (() => {
  const table = new Float64Array(256);
  for (let a = 1; a < 256; a++) table[a] = 255 / a;
  return table;
})();

export type InkModelKind = "uniform" | "premultiplied" | "blend";

/**
 * The decision, in a form that survives `postMessage`.
 *
 * Plain data on purpose: the dialog resolves the model while it checks the
 * artwork and hands it to the worker for the apply pass, which saves reading a
 * print-resolution source twice.
 */
export interface InkModel {
  kind: InkModelKind;
  /** The one ink the artwork is made of. */
  ink: RgbColor;
  /** The no-ink endpoint, or null when every visible pixel is full coverage. */
  paper: RgbColor | null;
  /** Coverage-weighted share of the artwork that fits, 0 to 1. */
  dominance: number;
  /** Pixel dimensions the statistics were gathered from. */
  width: number;
  height: number;
  /** Coverage plane: clamp(cr·r + cg·g + cb·b + c0). Identity for point models. */
  cr: number;
  cg: number;
  cb: number;
  c0: number;
}

export type InkModelReason = "no-visible-pixels" | "multiple-visible-colors";

export type InkModelResult =
  | { ok: true; model: InkModel }
  | { ok: false; reason: InkModelReason; dominance: number };

/** Running totals for one image. Fixed size — nothing here scales with pixels. */
export interface InkStats {
  /** Colour cube: weight, weight·r, weight·g, weight·b per bin. */
  bins: Float64Array;
  /** Σ alpha over visible pixels: how much ink the artwork carries in total. */
  weight: number;
  minR: number;
  maxR: number;
  minG: number;
  maxG: number;
  minB: number;
  maxB: number;
  /** Weight and weighted moments of RGB/α, over pixels solid enough to trust. */
  premulWeight: number;
  premulSumR: number;
  premulSumG: number;
  premulSumB: number;
  premulSumR2: number;
  premulSumG2: number;
  premulSumB2: number;
}

export function createInkStats(): InkStats {
  return {
    bins: new Float64Array(BIN_COUNT * BIN_STRIDE),
    weight: 0,
    minR: 256, maxR: -1,
    minG: 256, maxG: -1,
    minB: 256, maxB: -1,
    premulWeight: 0,
    premulSumR: 0, premulSumG: 0, premulSumB: 0,
    premulSumR2: 0, premulSumG2: 0, premulSumB2: 0,
  };
}

/** Folds one visible pixel into the statistics. Transparent pixels say nothing. */
export function accumulateInkPixel(stats: InkStats, r: number, g: number, b: number, a: number): void {
  if (a === 0) return;
  const index = ((((r >> BIN_SHIFT) * BIN_SIDE) + (g >> BIN_SHIFT)) * BIN_SIDE + (b >> BIN_SHIFT)) * BIN_STRIDE;
  const bins = stats.bins;
  bins[index] += a;
  bins[index + 1] += a * r;
  bins[index + 2] += a * g;
  bins[index + 3] += a * b;
  stats.weight += a;
  if (r < stats.minR) stats.minR = r;
  if (r > stats.maxR) stats.maxR = r;
  if (g < stats.minG) stats.minG = g;
  if (g > stats.maxG) stats.maxG = g;
  if (b < stats.minB) stats.minB = b;
  if (b > stats.maxB) stats.maxB = b;
  if (a >= PREMUL_MIN_ALPHA) {
    const inverse = INV_ALPHA[a];
    const ur = r * inverse, ug = g * inverse, ub = b * inverse;
    stats.premulWeight += a;
    stats.premulSumR += a * ur;
    stats.premulSumG += a * ug;
    stats.premulSumB += a * ub;
    stats.premulSumR2 += a * ur * ur;
    stats.premulSumG2 += a * ug * ug;
    stats.premulSumB2 += a * ub * ub;
  }
}

function clamp255(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}

function distance(ar: number, ag: number, ab: number, br: number, bg: number, bb: number): number {
  const dr = ar - br, dg = ag - bg, db = ab - bb;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Distance from a colour to the segment between `from` and `to`. */
function distanceToSegment(r: number, g: number, b: number, from: RgbColor, to: RgbColor): number {
  const vr = to.r - from.r, vg = to.g - from.g, vb = to.b - from.b;
  const lengthSquared = vr * vr + vg * vg + vb * vb;
  if (lengthSquared === 0) return distance(r, g, b, from.r, from.g, from.b);
  let t = ((r - from.r) * vr + (g - from.g) * vg + (b - from.b) * vb) / lengthSquared;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return distance(r, g, b, from.r + vr * t, from.g + vg * t, from.b + vb * t);
}

/**
 * Walks the populated bins.
 *
 * Every measurement below is some weighted sum over the colour cube, and each
 * bin carries its own exact mean colour, so the quantisation only blurs which
 * colours are grouped together, never where a group actually sits.
 */
function forEachBin(stats: InkStats, visit: (weight: number, r: number, g: number, b: number) => void): void {
  const bins = stats.bins;
  for (let index = 0; index < bins.length; index += BIN_STRIDE) {
    const weight = bins[index];
    if (weight === 0) continue;
    visit(weight, bins[index + 1] / weight, bins[index + 2] / weight, bins[index + 3] / weight);
  }
}

/** Weighted share of the artwork further than `tolerance` from the segment. */
function offModelShare(stats: InkStats, from: RgbColor, to: RgbColor): number {
  if (stats.weight === 0) return 1;
  let off = 0;
  forEachBin(stats, (weight, r, g, b) => {
    if (distanceToSegment(r, g, b, from, to) > OFF_MODEL_DISTANCE) off += weight;
  });
  return off / stats.weight;
}

/**
 * The ink, as the colour furthest from the paper that a real part of the
 * artwork actually reaches.
 *
 * Not the most common colour: on a design that is mostly soft shading there may
 * be no dominant tone at all, while the ink is still whatever the darkest (or,
 * against black paper, the lightest) real region reaches. Not the single
 * furthest pixel either, which would let one stray dot define the ink for the
 * whole file — so this takes the top few percent of the weight by distance and
 * averages it.
 */
function robustInk(stats: InkStats, paper: RgbColor): RgbColor {
  const BUCKETS = 128;
  const MAX_DISTANCE = 442;
  const histogram = new Float64Array(BUCKETS);
  forEachBin(stats, (weight, r, g, b) => {
    const d = distance(r, g, b, paper.r, paper.g, paper.b);
    const bucket = Math.min(BUCKETS - 1, Math.floor((d / MAX_DISTANCE) * BUCKETS));
    histogram[bucket] += weight;
  });
  const cutoffWeight = stats.weight * 0.05;
  let seen = 0;
  let cutoffBucket = 0;
  for (let bucket = BUCKETS - 1; bucket >= 0; bucket--) {
    seen += histogram[bucket];
    if (seen >= cutoffWeight) { cutoffBucket = bucket; break; }
  }
  const minDistance = (cutoffBucket / BUCKETS) * MAX_DISTANCE;
  let weightSum = 0, sumR = 0, sumG = 0, sumB = 0;
  forEachBin(stats, (weight, r, g, b) => {
    if (distance(r, g, b, paper.r, paper.g, paper.b) < minDistance) return;
    weightSum += weight;
    sumR += weight * r;
    sumG += weight * g;
    sumB += weight * b;
  });
  if (weightSum === 0) return { r: clamp255(paper.r), g: clamp255(paper.g), b: clamp255(paper.b) };
  return { r: clamp255(sumR / weightSum), g: clamp255(sumG / weightSum), b: clamp255(sumB / weightSum) };
}

function pointModel(
  kind: InkModelKind,
  ink: RgbColor,
  dominance: number,
  width: number,
  height: number,
): InkModel {
  return { kind, ink, paper: null, dominance, width, height, cr: 0, cg: 0, cb: 0, c0: 1 };
}

function blendModel(ink: RgbColor, paper: RgbColor, dominance: number, width: number, height: number): InkModel {
  const vr = ink.r - paper.r, vg = ink.g - paper.g, vb = ink.b - paper.b;
  const lengthSquared = vr * vr + vg * vg + vb * vb;
  return {
    kind: "blend",
    ink,
    paper,
    dominance,
    width,
    height,
    cr: vr / lengthSquared,
    cg: vg / lengthSquared,
    cb: vb / lengthSquared,
    c0: -(paper.r * vr + paper.g * vg + paper.b * vb) / lengthSquared,
  };
}

/** How much of this one ink the pixel carries, 0 to 1. */
export function inkCoverage(model: InkModel, r: number, g: number, b: number): number {
  if (model.kind !== "blend") return 1;
  const c = model.cr * r + model.cg * g + model.cb * b + model.c0;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/** Weighted share of the artwork sitting at the paper end of the segment. */
function paperEndShare(stats: InkStats, model: InkModel): number {
  if (stats.weight === 0) return 0;
  let atPaper = 0;
  forEachBin(stats, (weight, r, g, b) => {
    if (inkCoverage(model, r, g, b) <= PAPER_END_COVERAGE) atPaper += weight;
  });
  return atPaper / stats.weight;
}

/** Whether RGB variation is fully explained by alpha, leaving alpha to carry it. */
function premultipliedInk(stats: InkStats): RgbColor | null {
  // Too little solid artwork to judge: what remains is faint pixels whose RGB
  // is mostly rounding noise.
  if (stats.premulWeight < stats.weight * 0.5 || stats.premulWeight === 0) return null;
  const w = stats.premulWeight;
  const meanR = stats.premulSumR / w, meanG = stats.premulSumG / w, meanB = stats.premulSumB / w;
  const varianceR = Math.max(0, stats.premulSumR2 / w - meanR * meanR);
  const varianceG = Math.max(0, stats.premulSumG2 / w - meanG * meanG);
  const varianceB = Math.max(0, stats.premulSumB2 / w - meanB * meanB);
  const spread = Math.max(Math.sqrt(varianceR), Math.sqrt(varianceG), Math.sqrt(varianceB));
  if (spread > PREMUL_TOLERANCE) return null;
  return { r: clamp255(meanR), g: clamp255(meanG), b: clamp255(meanB) };
}

/**
 * Picks the shape that explains the whole image, in order of how much it is
 * allowed to change.
 *
 * The order is deliberate rather than a straight best-fit: the models that
 * leave alpha alone are tried first, because getting that wrong on artwork
 * whose alpha already carries the softness is the one mistake that visibly
 * thins a print. Coverage is only inferred from RGB once the alpha-preserving
 * readings have been ruled out.
 */
export function resolveInkModel(stats: InkStats, width: number, height: number): InkModelResult {
  if (stats.weight === 0 || stats.maxR < 0) {
    return { ok: false, reason: "no-visible-pixels", dominance: 0 };
  }

  // One colour exactly: the artwork the strict rule already accepted, and the
  // only path that guarantees a byte-identical alpha channel.
  if (stats.minR === stats.maxR && stats.minG === stats.maxG && stats.minB === stats.maxB) {
    return { ok: true, model: pointModel("uniform", { r: stats.minR, g: stats.minG, b: stats.minB }, 1, width, height) };
  }

  // One colour plus encoder noise — a re-saved PNG, a file that went through
  // JPEG on the way. Snapping to the mean is what the customer means by "this
  // design is white".
  if (
    stats.maxR - stats.minR <= UNIFORM_CHANNEL_SPREAD &&
    stats.maxG - stats.minG <= UNIFORM_CHANNEL_SPREAD &&
    stats.maxB - stats.minB <= UNIFORM_CHANNEL_SPREAD
  ) {
    let sumR = 0, sumG = 0, sumB = 0;
    forEachBin(stats, (weight, r, g, b) => { sumR += weight * r; sumG += weight * g; sumB += weight * b; });
    const ink = {
      r: clamp255(sumR / stats.weight),
      g: clamp255(sumG / stats.weight),
      b: clamp255(sumB / stats.weight),
    };
    return { ok: true, model: pointModel("uniform", ink, 1, width, height) };
  }

  // RGB tracking alpha. The colours run along the segment from black to the
  // ink, so that is what the fit is measured against.
  const premultiplied = premultipliedInk(stats);
  if (premultiplied) {
    const share = offModelShare(stats, BLACK, premultiplied);
    if (1 - share >= MIN_DOMINANCE) {
      return { ok: true, model: pointModel("premultiplied", premultiplied, 1 - share, width, height) };
    }
  }

  // Coverage carried by RGB: try both papers and let the artwork choose. A
  // paper too close to the ink is not a blend at all, it is a degenerate
  // segment that would map the whole design to zero coverage.
  const candidates: { model: InkModel; atPaper: number }[] = [];
  for (const paper of [WHITE, BLACK]) {
    const ink = robustInk(stats, paper);
    if (distance(ink.r, ink.g, ink.b, paper.r, paper.g, paper.b) < MIN_PAPER_DISTANCE) continue;
    const model = blendModel(ink, paper, 1 - offModelShare(stats, paper, ink), width, height);
    candidates.push({ model, atPaper: paperEndShare(stats, model) });
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "multiple-visible-colors", dominance: 0 };
  }

  // Which end is the ink cannot be settled by fit alone: on greyscale artwork
  // the segment from white to black describes the pixels exactly as well
  // upside down, and picking the wrong way round erases the design's solid
  // body instead of its edges. What separates them is where the weight sits —
  // ink is the end the artwork is made of, paper is the end it only tails off
  // toward. So the candidates are ranked by how much of the artwork each one
  // leaves as actual ink: neither off the segment nor sitting at the far end
  // where coverage rounds away to nothing.
  candidates.sort((a, b) =>
    (b.model.dominance - b.atPaper) - (a.model.dominance - a.atPaper));
  const best = candidates[0];

  if (best.model.dominance < MIN_DOMINANCE) {
    return { ok: false, reason: "multiple-visible-colors", dominance: best.model.dominance };
  }
  // Weight piled up at both ends is two inks wearing a gradient's clothes.
  if (best.atPaper > MAX_PAPER_END_SHARE) {
    return {
      ok: false,
      reason: "multiple-visible-colors",
      dominance: Math.min(best.model.dominance, 1 - best.atPaper),
    };
  }
  return { ok: true, model: best.model };
}

/**
 * Whether a model may be applied to an image of these dimensions.
 *
 * A model arrives from another thread as plain data, so nothing about it is
 * guaranteed by the type system by the time it gets here: every field is
 * checked, not just the dimensions. A model that fails this is not an error —
 * the artwork is simply measured again, which is what would have happened
 * anyway if the caller had not offered one.
 */
export function inkModelFits(model: InkModel | undefined, width: number, height: number): model is InkModel {
  if (!model || model.width !== width || model.height !== height) return false;
  if (model.kind !== "uniform" && model.kind !== "premultiplied" && model.kind !== "blend") return false;
  if (model.kind === "blend" ? !isColor(model.paper) : model.paper !== null) return false;
  if (!isColor(model.ink)) return false;
  if (!(model.dominance >= 0 && model.dominance <= 1)) return false;
  return [model.cr, model.cg, model.cb, model.c0].every(Number.isFinite);
}

function isColor(color: RgbColor | null): boolean {
  if (!color) return false;
  return [color.r, color.g, color.b].every(
    value => Number.isInteger(value) && value >= 0 && value <= 255,
  );
}

/**
 * Coverage for every possible 8-bit grey, so a greyscale or indexed source
 * resolves each pixel with a table lookup instead of the plane arithmetic.
 */
export function greyCoverageTable(model: InkModel): Float64Array {
  const table = new Float64Array(256);
  for (let value = 0; value < 256; value++) table[value] = inkCoverage(model, value, value, value);
  return table;
}
