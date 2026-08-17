/**
 * Where a design's printed filename goes, and how big it is.
 *
 * The label is a production aid: it rides on the film so whoever presses the garment can tell
 * one design from another. That makes it ink like any other ink — it has to be reserved for by
 * the nester, respected by overlap detection, kept on the sheet by the clamps, and drawn
 * identically by the preview and the export. Four separate copies of this arithmetic had
 * already drifted apart (the preview put the label below the artwork, the main-thread export
 * fallback put it inside the bottom-right corner, the PDF put it near the top-left at a fixed
 * size), which is the failure this module exists to make impossible: one function decides, and
 * everything else reads the answer.
 *
 * Two properties matter more than anything else here:
 *
 *   1. **The answer is the same everywhere.** Text width is measured as a ratio against the em
 *      size rather than in pixels, so a preview measuring at 11 px and an export measuring at
 *      54 px agree on how many inches of film the label needs. The one input that cannot be
 *      recomputed away from the main thread — whether the artwork's corner is free of ink — is
 *      decided once by the mask builder and carried to the worker.
 *
 *   2. **The label never exceeds the design's footprint.** A label wider than the artwork would
 *      reserve space the nester does not own, and print over whatever got seated beside it. The
 *      font shrinks to fit, and only if that is not enough is the text shortened.
 *
 * Coordinates are inches in design-local space: the origin is the centre of the artwork, x runs
 * right and y runs down, flips already undone. That is exactly the space every drawing path is
 * in after it has translated to the design's centre and rotated, so a layout can be drawn
 * straight from these numbers with no further conversion.
 */

/** Clear film between the artwork's bottom edge and the label, when the label sits below. */
export const LABEL_GAP_INCHES = 0.1;

/** Label em size as a share of artwork height, before the legibility clamps below. */
const LABEL_HEIGHT_FRACTION = 0.045;

/**
 * Smallest em size the label is allowed to print at.
 *
 * DTF transfers lose fine detail: the powder does not adhere evenly to strokes much under a
 * tenth of an inch, and what survives the press can flake off the film. Below this a label is
 * not just hard to read, it is a defect on the garment. Proportional sizing alone would give a
 * one inch sticker a 0.045" label, so the floor is what actually governs on small work.
 */
export const LABEL_MIN_FONT_INCHES = 0.12;

/** Largest em size, so a four-foot banner is not captioned in three-inch letters. */
export const LABEL_MAX_FONT_INCHES = 0.3;

/** White margin around the text inside its background box, in ems. */
const LABEL_PAD_EMS = 0.3;

/** How far inside the artwork's edges the label sits when it is placed inside. */
const LABEL_INSET_INCHES = 0.05;

/**
 * Clear film required around the label before it may sit inside the artwork.
 *
 * The background box is opaque, so ink underneath it is ink the customer loses. This is the
 * width of the moat checked around the box: enough that the label is visibly in open space
 * rather than crowding a stroke it happens not to touch.
 */
const LABEL_CLEARANCE_INCHES = 0.05;

/** Em size the advance ratios are probed at. Large enough that hinting does not skew the ratio. */
const MEASURE_PROBE_PX = 100;

export interface LabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PrintLabelLayout {
  /**
   * `inside` when the label fits in the artwork's own bottom-right corner over clear film, which
   * costs no extra film at all. `below` when it does not, which is the case for anything solid.
   */
  placement: 'inside' | 'below';
  /** Film reserved below the artwork for the label, inches. Zero when placed inside. */
  bandInches: number;
  /** The opaque background box. Text is centred in it. */
  rect: LabelRect;
  /** Em size to draw the text at, inches. */
  fontInches: number;
  /** The name as printed — extension stripped, shortened if it had to be. */
  text: string;
}

/** Width of a string at one em, so callers can convert to whatever unit they draw in. */
export type LabelMeasure = (text: string) => number;

/** The font every path draws the label with. One spelling, so the metrics agree. */
export function labelFont(sizePx: number): string {
  return `bold ${Math.max(1, Math.round(sizePx))}px sans-serif`;
}

const advanceCache = new Map<string, number>();

/**
 * A measure function backed by a canvas.
 *
 * Ratios are cached across calls and contexts because they depend only on the string and the
 * font, and the font is fixed. The probe size is constant, so the same string measured on the
 * main thread and in a worker returns the same ratio — which is the whole point, since one
 * decides the reserved space and the other draws into it.
 */
export function canvasLabelMeasure(
  ctx: { font: string; measureText: (text: string) => { width: number } },
): LabelMeasure {
  return (text: string) => {
    const hit = advanceCache.get(text);
    if (hit !== undefined) return hit;
    const previous = ctx.font;
    ctx.font = labelFont(MEASURE_PROBE_PX);
    const ratio = ctx.measureText(text).width / MEASURE_PROBE_PX;
    ctx.font = previous;
    advanceCache.set(text, ratio);
    return ratio;
  };
}

/** Drops memoised text widths. Only needed if the font stack could change under us. */
export function clearLabelMeasureCache(): void {
  advanceCache.clear();
}

/**
 * Rough advance width when there is no canvas to ask — no DOM and no `OffscreenCanvas`.
 *
 * Only reachable from a non-rendering context, where the answer feeds a reserved height rather
 * than a drawn box, so being a few percent out costs a sliver of film and nothing else. Bold
 * sans-serif averages a little over half an em per character across mixed case.
 */
function estimateAdvance(text: string): number {
  return text.length * 0.58;
}

let measureContext: { font: string; measureText: (text: string) => { width: number } } | null = null;
let measureContextTried = false;

/**
 * The measure function callers should use unless they already have a context to hand.
 *
 * One 1×1 canvas for the whole app: measurements are memoised by string, and the probe size is
 * fixed, so this returns the same ratios as any other context would.
 */
export function sharedLabelMeasure(): LabelMeasure {
  if (!measureContextTried) {
    measureContextTried = true;
    try {
      if (typeof document !== 'undefined') {
        measureContext = document.createElement('canvas').getContext('2d');
      } else if (typeof OffscreenCanvas !== 'undefined') {
        measureContext = new OffscreenCanvas(1, 1).getContext('2d') as typeof measureContext;
      }
    } catch {
      measureContext = null;
    }
  }
  return measureContext ? canvasLabelMeasure(measureContext) : estimateAdvance;
}

/** The filename as it prints: no extension, no surrounding whitespace. */
export function labelTextFor(name: string): string {
  return name.replace(/\.[^/.]+$/, '').trim();
}

/**
 * Whether a design at this rotation would read its label upside down.
 *
 * The label stays attached to the design — it rotates with it, so the film space reserved for it
 * is the same shape however the nester turns the design. Past a quarter turn that would print
 * the name inverted, so the text alone is turned a half turn back inside its box. At exactly a
 * quarter turn it reads sideways, which is legible, and turning it would not improve on that.
 *
 * Deliberately not part of the layout: it depends on rotation, and the layout is cached against
 * a footprint that rotation does not change.
 */
export function labelReadsUpsideDown(rotation: number): boolean {
  const turn = ((rotation % 360) + 360) % 360;
  return turn > 90 && turn < 270;
}

/**
 * Shortens `text` until it fits `maxWidthInches`, appending an ellipsis when it has to cut.
 *
 * Reached only by a design too narrow to caption at the minimum legible size. Printing the full
 * name anyway is not an option: it would overhang the footprint the nester reserved and land on
 * whatever was packed beside it.
 */
function fitText(measure: LabelMeasure, text: string, fontInches: number, maxWidthInches: number): string {
  if (measure(text) * fontInches <= maxWidthInches) return text;
  for (let keep = text.length - 1; keep > 0; keep--) {
    const candidate = `${text.slice(0, keep)}…`;
    if (measure(candidate) * fontInches <= maxWidthInches) return candidate;
  }
  return '…';
}

export interface PrintLabelInput {
  /** The design's file name, extension and all. */
  name: string;
  /** Artwork footprint at its current scale, inches — the drawn size, not the unscaled size. */
  artWidthInches: number;
  artHeightInches: number;
  /**
   * Reports whether a rectangle of the artwork is free of ink, in the same coordinates the
   * layout returns. Only the mask builder can answer this, so paths without a mask omit it and
   * get the band placement — which is always safe, just less thrifty with film.
   */
  isClearOfInk?: (rect: LabelRect) => boolean;
}

/**
 * Decides the label's size and position, or null when there is nothing to print.
 *
 * The size is chosen first and independently of placement, so a design does not get a different
 * label depending on where it happens to fit. Then the corner is tried, because a label inside
 * the artwork's own bounding box costs no film at all; failing that it goes in a band below,
 * which is what any solid shape gets.
 */
export function layoutPrintLabel(
  input: PrintLabelInput,
  measure: LabelMeasure,
): PrintLabelLayout | null {
  const { artWidthInches: artW, artHeightInches: artH } = input;
  if (!(artW > 0) || !(artH > 0)) return null;

  const full = labelTextFor(input.name);
  if (!full) return null;

  // Widest box the footprint can carry. Anything wider would reserve film the design does not
  // own, so this is a hard ceiling on the label rather than a preference.
  const maxBoxWidth = artW;

  let fontInches = Math.min(
    LABEL_MAX_FONT_INCHES,
    Math.max(LABEL_MIN_FONT_INCHES, artH * LABEL_HEIGHT_FRACTION),
  );

  // Shrink to fit before resorting to cutting the name, down to the point where the ink stops
  // surviving the press.
  const boxWidthAt = (size: number) => measure(full) * size + 2 * LABEL_PAD_EMS * size;
  if (boxWidthAt(fontInches) > maxBoxWidth) {
    const needed = maxBoxWidth / (measure(full) + 2 * LABEL_PAD_EMS);
    fontInches = Math.max(LABEL_MIN_FONT_INCHES, needed);
  }

  const pad = LABEL_PAD_EMS * fontInches;
  const text = fitText(measure, full, fontInches, Math.max(0, maxBoxWidth - 2 * pad));
  const boxW = Math.min(maxBoxWidth, measure(text) * fontInches + 2 * pad);
  const boxH = fontInches + 2 * pad;

  // Inside the artwork's own corner, if the corner is empty. Checked with a moat around the box
  // so the label sits in open space rather than up against a stroke.
  if (input.isClearOfInk && boxW + 2 * LABEL_INSET_INCHES <= artW && boxH + 2 * LABEL_INSET_INCHES <= artH) {
    const rect: LabelRect = {
      x: artW / 2 - LABEL_INSET_INCHES - boxW,
      y: artH / 2 - LABEL_INSET_INCHES - boxH,
      width: boxW,
      height: boxH,
    };
    const moat: LabelRect = {
      x: rect.x - LABEL_CLEARANCE_INCHES,
      y: rect.y - LABEL_CLEARANCE_INCHES,
      width: rect.width + 2 * LABEL_CLEARANCE_INCHES,
      height: rect.height + 2 * LABEL_CLEARANCE_INCHES,
    };
    if (input.isClearOfInk(moat)) {
      return { placement: 'inside', bandInches: 0, rect, fontInches, text };
    }
  }

  return {
    placement: 'below',
    bandInches: LABEL_GAP_INCHES + boxH,
    rect: {
      x: artW / 2 - boxW,
      y: artH / 2 + LABEL_GAP_INCHES,
      width: boxW,
      height: boxH,
    },
    fontInches,
    text,
  };
}

/**
 * Draws a laid-out label into a context already translated to the design's centre and rotated
 * with it, with any flip undone, at `pxPerInch`.
 *
 * A white box under black text, rather than bare text. Bare letterforms at this size are the
 * thinnest ink on the sheet: they lose their choke, and a stroke a few thousandths wide is what
 * lifts off the film first. A solid rectangle carries them.
 */
export function drawPrintLabel(
  ctx: {
    save: () => void;
    restore: () => void;
    translate: (x: number, y: number) => void;
    rotate: (angle: number) => void;
    fillRect: (x: number, y: number, w: number, h: number) => void;
    fillText: (text: string, x: number, y: number) => void;
    font: string;
    fillStyle: unknown;
    textAlign: string;
    textBaseline: string;
  },
  layout: PrintLabelLayout,
  pxPerInch: number,
  upsideDown: boolean,
): void {
  const { rect } = layout;
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(rect.x * pxPerInch, rect.y * pxPerInch, rect.width * pxPerInch, rect.height * pxPerInch);

  // Centre of the box, so the text needs no baseline metrics to sit where the reserved space
  // says it does — those differ between a canvas and an offscreen canvas.
  ctx.translate((rect.x + rect.width / 2) * pxPerInch, (rect.y + rect.height / 2) * pxPerInch);
  if (upsideDown) ctx.rotate(Math.PI);
  ctx.font = labelFont(layout.fontInches * pxPerInch);
  ctx.fillStyle = '#000000';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(layout.text, 0, 0);
  ctx.restore();
}
