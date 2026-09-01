/**
 * The geometry and pixel test behind the red overlap marks.
 *
 * Shared by the overlap worker and the main-thread fallback so the two can never disagree
 * about whether a sheet is clean — they used to carry separate copies of this at different
 * resolutions, which meant the answer changed depending on which one happened to run.
 */

/**
 * Resolution the overlap test rasterises at, in pixels per inch of sheet.
 *
 * This is deliberately a *physical* resolution rather than a fraction of the preview canvas.
 * Deriving it from the canvas tied the answer to how large the sheet happened to be drawn on
 * screen: a long gang sheet is fitted into the same preview as a short one, so a 240" sheet
 * came out around two pixels to the inch. At that scale a 1/16" margin is an eighth of a
 * pixel, neighbouring copies land on the same pixel, and designs that never touch are
 * reported as overlapping. The same sheet then read differently in the workspace and in the
 * storefront, because the two size their preview differently.
 *
 * 48 leaves the smallest margin the editor offers (1/16") three pixels of clear sheet, which
 * survives the resampling `drawImage` does on the way in.
 */
export const OVERLAP_PX_PER_INCH = 48;

/**
 * How far a design's ink may sit past the sheet edge before it is called out of bounds.
 *
 * In inches, so it means the same thing on every sheet length. Arrange clamps ink to the
 * artboard within a hundredth of an inch, so this is several times the slack that rounding
 * can legitimately produce and far below anything a customer would be charged for.
 */
export const OVERLAP_EDGE_TOLERANCE_INCHES = 1 / 16;

/**
 * Largest canvas rasterised at once, per side.
 *
 * A bound on memory, not on resolution: an intersection larger than this is covered by
 * several tiles at full scale rather than being drawn shrunk. Shrinking would undo the point
 * of a fixed resolution — a thin collision resampled down to a few pixels falls under the
 * alpha threshold and the overlap goes unreported, which ships a broken print.
 */
export const OVERLAP_MAX_REGION_PX = 2048;

/** Alpha above which a pixel counts as ink. Matches what the preview treats as visible. */
const INK_ALPHA = 20;

export interface OverlapDesign {
  id: string;
  /** Ink bounds in detection pixels. Transparent padding is excluded: nested designs are
   *  allowed to overlap each other's empty corners. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Index into the artwork array, or -1 for a design whose artwork could not be sampled. */
  sourceIndex: number;
  /** Footprint the artwork is drawn at, in detection pixels. */
  drawW: number;
  drawH: number;
  rotation: number;
  cx: number;
  cy: number;
  /**
   * The printed filename's opaque box, in the same pixels as `drawW`/`drawH` and relative to
   * the design's centre, or absent when the label is off. A box rather than a full-width
   * band: the label can tuck into the artwork's own corner, and claiming the whole width
   * would both invent overlaps beside a short name and miss one that sits inside the art.
   */
  labelBox?: { x: number; y: number; w: number; h: number };
}

export type OverlapCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Detection-space dimensions for a sheet, independent of how it is displayed. */
export function overlapDetectionSize(
  widthInches: number,
  heightInches: number,
): { sw: number; sh: number } {
  return {
    sw: Math.max(60, Math.round(Math.max(0, widthInches) * OVERLAP_PX_PER_INCH)),
    sh: Math.max(30, Math.round(Math.max(0, heightInches) * OVERLAP_PX_PER_INCH)),
  };
}

/** The edge tolerance above, in detection pixels. */
export function overlapEdgeTolerancePx(): number {
  return OVERLAP_EDGE_TOLERANCE_INCHES * OVERLAP_PX_PER_INCH;
}

export function findOutOfBounds(
  designs: Pick<OverlapDesign, 'id' | 'left' | 'top' | 'right' | 'bottom'>[],
  sw: number,
  sh: number,
  tolPx: number = overlapEdgeTolerancePx(),
): Set<string> {
  const out = new Set<string>();
  for (const d of designs) {
    if (d.left < -tolPx || d.top < -tolPx || d.right > sw + tolPx || d.bottom > sh + tolPx) {
      out.add(d.id);
    }
  }
  return out;
}

/** Index pairs whose ink bounds intersect. Only these are worth rasterising. */
export function findAabbPairs(
  designs: Pick<OverlapDesign, 'left' | 'top' | 'right' | 'bottom'>[],
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < designs.length; i++) {
    for (let j = i + 1; j < designs.length; j++) {
      const a = designs[i], b = designs[j];
      if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
        pairs.push([i, j]);
      }
    }
  }
  return pairs;
}

/** A piece of a shared area, in detection pixels, rasterised 1:1. */
export interface OverlapTile {
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

/**
 * The area two designs share, cut into pieces small enough to rasterise.
 *
 * Every tile is full scale and the tiles cover the whole intersection exactly, so no part of
 * it goes untested however large it is.
 */
export function intersectionTiles(
  a: Pick<OverlapDesign, 'left' | 'top' | 'right' | 'bottom'>,
  b: Pick<OverlapDesign, 'left' | 'top' | 'right' | 'bottom'>,
  maxTile: number = OVERLAP_MAX_REGION_PX,
): OverlapTile[] {
  // Outwards on every edge. Rounding each bound to nearest would drop up to half a pixel
  // off the right and bottom of the shared area, and a collision thin enough to live in
  // that strip is exactly the kind this test exists to catch.
  const ix = Math.floor(Math.max(a.left, b.left));
  const iy = Math.floor(Math.max(a.top, b.top));
  const iw = Math.max(0, Math.ceil(Math.min(a.right, b.right)) - ix);
  const ih = Math.max(0, Math.ceil(Math.min(a.bottom, b.bottom)) - iy);
  if (iw < 1 || ih < 1) return [];

  const step = Math.max(1, Math.floor(maxTile));
  const tiles: OverlapTile[] = [];
  for (let oy = 0; oy < ih; oy += step) {
    for (let ox = 0; ox < iw; ox += step) {
      tiles.push({
        rx: ix + ox,
        ry: iy + oy,
        rw: Math.min(step, iw - ox),
        rh: Math.min(step, ih - oy),
      });
    }
  }
  return tiles;
}

export interface DetectOverlapsArgs {
  designs: OverlapDesign[];
  /** Artwork per `sourceIndex`, already at or above the footprint it is drawn at. */
  sources: Array<CanvasImageSource | undefined>;
  sw: number;
  sh: number;
  /** Supplies a cleared drawing context of the requested size. */
  getContext: (w: number, h: number) => OverlapCtx | null;
  tolPx?: number;
  maxRegion?: number;
}

/**
 * Ids to mark red: every design whose ink leaves the sheet, plus both halves of every pair
 * whose ink genuinely intersects.
 *
 * A generator so a caller without a worker can spread the pass over several frames instead
 * of freezing the editor. It yields after each candidate pair; the return value is the
 * finished list. Skipping pairs to save time is deliberately not offered — an unreported
 * overlap ships a broken print, so the work is paced rather than abandoned.
 */
export function* overlapPasses(args: DetectOverlapsArgs): Generator<void, string[], void> {
  const { designs, sources, sw, sh, getContext } = args;
  const tolPx = args.tolPx ?? overlapEdgeTolerancePx();
  const maxRegion = args.maxRegion ?? OVERLAP_MAX_REGION_PX;

  const flagged = findOutOfBounds(designs, sw, sh, tolPx);
  if (designs.length < 2) return Array.from(flagged);

  const rasterize = (d: OverlapDesign, tile: OverlapTile): Uint8Array | null => {
    const src = sources[d.sourceIndex];
    if (!src) return null;
    const ctx = getContext(tile.rw, tile.rh);
    if (!ctx) return null;
    try {
      ctx.save();
      // Detection pixels -> this tile's canvas, then the design's own placement.
      ctx.translate(-tile.rx, -tile.ry);
      ctx.translate(d.cx, d.cy);
      ctx.rotate((d.rotation * Math.PI) / 180);
      ctx.drawImage(src, -d.drawW / 2, -d.drawH / 2, d.drawW, d.drawH);
      // Opaque, because the label prints a white rectangle: anything under it is covered.
      if (d.labelBox) {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.fillRect(d.labelBox.x, d.labelBox.y, d.labelBox.w, d.labelBox.h);
      }
      ctx.restore();
      const rgba = ctx.getImageData(0, 0, tile.rw, tile.rh).data;
      const alpha = new Uint8Array(tile.rw * tile.rh);
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      return alpha;
    } catch {
      // Tainted canvas or an undecoded image. Reporting nothing is the safe direction:
      // inventing an overlap blocks a checkout that is fine.
      return null;
    }
  };

  /** Yields between tiles, so one large pair cannot hold the thread for a whole pass. */
  function* pairCollides(a: OverlapDesign, b: OverlapDesign): Generator<void, boolean, void> {
    for (const tile of intersectionTiles(a, b, maxRegion)) {
      const alphaA = rasterize(a, tile);
      const alphaB = alphaA ? rasterize(b, tile) : null;
      if (alphaA && alphaB) {
        // Coarse scan first, then every pixel: a real collision is usually broad, and the
        // fine pass only has to run on the tiles that look clean.
        let found = false;
        for (let p = 0; p < alphaA.length; p += 4) {
          if (alphaA[p] > INK_ALPHA && alphaB[p] > INK_ALPHA) { found = true; break; }
        }
        if (!found) {
          for (let p = 0; p < alphaA.length; p++) {
            if (alphaA[p] > INK_ALPHA && alphaB[p] > INK_ALPHA) { found = true; break; }
          }
        }
        if (found) return true;
      }
      // A tile that could not be drawn says nothing about the rest of the pair, so the
      // remaining tiles are still worth testing rather than calling the pair clean.
      yield;
    }
    return false;
  }

  for (const [i, j] of findAabbPairs(designs)) {
    const a = designs[i], b = designs[j];
    // Both are already marked, so the pixel test cannot change the answer. On a crowded
    // sheet this skips the bulk of the rasterising.
    if (flagged.has(a.id) && flagged.has(b.id)) { yield; continue; }
    if (yield* pairCollides(a, b)) {
      flagged.add(a.id);
      flagged.add(b.id);
    }
    yield;
  }

  return Array.from(flagged);
}

/** Runs `overlapPasses` to completion. For the worker, which is already off the UI thread. */
export function detectOverlaps(args: DetectOverlapsArgs): string[] {
  const pass = overlapPasses(args);
  let step = pass.next();
  while (!step.done) step = pass.next();
  return step.value;
}
