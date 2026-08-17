/**
 * Bitmap nesting.
 *
 * A rectangle packer reserves a design's whole bounding box, so a circle, a diagonal
 * wordmark or anything with large transparent corners pays for film it never prints on.
 * Here each design is reduced to its ink silhouette on a fixed grid and placed wherever
 * that silhouette fits, which lets shapes interlock. The grid is one bit per cell, so a
 * collision test is a handful of word ANDs and a full sheet nests in single-digit
 * milliseconds — cheap enough to run alongside the rectangle packers and let the better
 * layout win rather than replacing them outright.
 *
 * Two decisions shape everything below.
 *
 * Spacing is enforced on the *write* side: a placed design is stamped into the grid
 * dilated by the gap, and newcomers are tested with their undilated silhouette. Dilating
 * the tested mask instead would make it hang off the sheet edges, forcing either a bogus
 * out-of-bounds rejection or negative-coordinate handling in the hot loop. Writing dilated
 * also makes spacing order-independent: whichever of two designs lands first, the second
 * has to clear the first one's halo.
 *
 * Masks are trimmed to their ink before placement. That is what makes "only the artwork has
 * to be on the sheet" fall out for free — the thing being bounds-checked *is* the artwork —
 * and it keeps every tested coordinate non-negative.
 *
 * This module is deliberately DOM-free so the arrange worker can use it. Turning images
 * into masks lives in `nest-mask.ts`, which needs a canvas and runs on the main thread.
 */

/**
 * Grid resolution. 1/20" is fine enough for silhouettes to interlock visibly while keeping
 * a 22" x 120" sheet at ~440 x 2400 cells, which is a 260 KB occupancy map.
 */
export const NEST_CELL_INCHES = 0.05;

/** Alpha at or below this counts as blank when a mask is built. */
export const NEST_ALPHA_THRESHOLD = 12;

/** A design's ink coverage over its full footprint, one byte per cell, row-major. */
export interface NestMask {
  cols: number;
  rows: number;
  bits: Uint8Array;
}

export interface NestRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NestObstacle extends NestRect {
  /**
   * Silhouette in the design's own unrotated space. Absent means treat the whole rect as
   * ink, which over-reserves but is always safe.
   */
  mask?: NestMask;
  /** How the design is turned on the sheet, so `mask` can be oriented to match `w` x `h`. */
  rotation?: number;
}

export interface NestItem {
  id: string;
  /** Footprint in inches, including any filename-stamp band in `h`. */
  w: number;
  h: number;
  /** Silhouette for rotation 0, covering exactly `w` x `h`. Absent means a solid rect. */
  mask?: NestMask;
  /**
   * Forbids turning this item. Set for composites whose placement the caller can only
   * translate — a user-defined group is packed as one super-item, and its members are moved
   * as a block afterwards, so a rotation chosen here could not be carried out. Reserving a
   * turned slot for something that then lands unturned is how a group ends up overlapping
   * its neighbour.
   */
  noRotate?: boolean;
}

export interface NestPlacement {
  id: string;
  nx: number;
  ny: number;
  rotation: number;
  overflows: boolean;
  anchored?: boolean;
}

export interface NestResult {
  result: NestPlacement[];
  /** Bottom edge of the lowest *ink*, in inches — the film the sheet actually consumes. */
  maxHeight: number;
  wastedArea: number;
}

/** Where a design currently sits: footprint bounds in inches from the sheet's top-left. */
export interface NestCurrent extends NestRect {
  id: string;
  rotation: number;
}

const EPS = 0.01;
const WORD_BITS = 32;

// ---------------------------------------------------------------------------
// Occupancy grid
// ---------------------------------------------------------------------------

interface Grid {
  cols: number;
  rows: number;
  wordsPerRow: number;
  words: Uint32Array;
  /** Highest row index containing anything, or -1. Lets the search skip the empty tail. */
  lastRow: number;
  /**
   * Per-row summaries used to reject a candidate row before scanning it column by column.
   * A row cannot host a silhouette row that needs more free cells than it has, nor one
   * whose longest unbroken ink run exceeds the row's longest unbroken free run. Both are
   * necessary conditions only, so this never changes which placements are legal — it just
   * skips work, and in a dense band it skips nearly all of it.
   */
  freeCount: Int32Array;
  maxFreeRun: Int32Array;
  /** Rows whose summaries are stale, recomputed on demand. */
  dirty: Uint8Array;
}

function makeGrid(cols: number, rows: number): Grid {
  const wordsPerRow = Math.ceil(cols / WORD_BITS);
  const freeCount = new Int32Array(rows).fill(cols);
  const maxFreeRun = new Int32Array(rows).fill(cols);
  return {
    cols, rows, wordsPerRow,
    words: new Uint32Array(wordsPerRow * rows),
    lastRow: -1,
    freeCount,
    maxFreeRun,
    dirty: new Uint8Array(rows),
  };
}

function refreshRow(g: Grid, row: number): void {
  const base = row * g.wordsPerRow;
  let free = 0, run = 0, best = 0;
  for (let c = 0; c < g.cols; c++) {
    if ((g.words[base + (c >>> 5)] & ((1 << (c & 31)) >>> 0)) === 0) {
      free++;
      if (++run > best) best = run;
    } else {
      run = 0;
    }
  }
  g.freeCount[row] = free;
  g.maxFreeRun[row] = best;
  g.dirty[row] = 0;
}

function rowFreeCount(g: Grid, row: number): number {
  if (g.dirty[row]) refreshRow(g, row);
  return g.freeCount[row];
}

function rowMaxFreeRun(g: Grid, row: number): number {
  if (g.dirty[row]) refreshRow(g, row);
  return g.maxFreeRun[row];
}

/** Bits `b`..31 set. */
function maskFrom(b: number): number {
  return (0xFFFFFFFF << b) >>> 0;
}

/** Bits 0..`b` set. */
function maskTo(b: number): number {
  return b >= 31 ? 0xFFFFFFFF : ((1 << (b + 1)) - 1) >>> 0;
}

/** Sets cells [xStart, xEnd) on `row`, clipped to the grid. */
function orSpan(g: Grid, row: number, xStart: number, xEnd: number): void {
  if (row < 0 || row >= g.rows) return;
  const s = Math.max(0, xStart);
  const e = Math.min(g.cols, xEnd);
  if (e <= s) return;
  const base = row * g.wordsPerRow;
  const wStart = s >>> 5;
  const wEnd = (e - 1) >>> 5;
  if (wStart === wEnd) {
    g.words[base + wStart] |= (maskFrom(s & 31) & maskTo((e - 1) & 31)) >>> 0;
  } else {
    g.words[base + wStart] |= maskFrom(s & 31);
    for (let w = wStart + 1; w < wEnd; w++) g.words[base + w] = 0xFFFFFFFF;
    g.words[base + wEnd] |= maskTo((e - 1) & 31);
  }
  g.dirty[row] = 1;
  if (row > g.lastRow) g.lastRow = row;
}

/** Stamps `mask` into the grid at cell (`cx`, `cy`), grown by `pad` cells on every side. */
function writeDilated(g: Grid, mask: NestMask, cx: number, cy: number, pad: number): void {
  const grown = pad > 0 ? dilateMask(mask, pad) : mask;
  const ox = cx - pad;
  const oy = cy - pad;
  const { cols, rows, bits } = grown;
  for (let r = 0; r < rows; r++) {
    const row = oy + r;
    if (row < 0 || row >= g.rows) continue;
    const rowBase = r * cols;
    let c = 0;
    while (c < cols) {
      if (!bits[rowBase + c]) { c++; continue; }
      let end = c + 1;
      while (end < cols && bits[rowBase + end]) end++;
      orSpan(g, row, ox + c, ox + end);
      c = end;
    }
  }
}

// ---------------------------------------------------------------------------
// Mask transforms
// ---------------------------------------------------------------------------

const solidCache = new Map<string, NestMask>();

function solidMask(cols: number, rows: number): NestMask {
  const key = `${cols}x${rows}`;
  const hit = solidCache.get(key);
  if (hit) return hit;
  const bits = new Uint8Array(cols * rows);
  bits.fill(1);
  const mask: NestMask = { cols, rows, bits };
  // Shared and never mutated. Capped so a session that resizes a lot cannot grow it
  // without bound.
  if (solidCache.size > 256) solidCache.clear();
  solidCache.set(key, mask);
  return mask;
}

const dilateCache = new WeakMap<NestMask, Map<number, NestMask>>();

/**
 * Square (Chebyshev) dilation by `pad` cells, as two separable run-length passes. Square
 * rather than circular is both cheaper and the right shape here: it matches the
 * axis-aligned "add the gap to width and height" spacing the rectangle packers use, so the
 * two produce visually consistent margins.
 */
export function dilateMask(mask: NestMask, pad: number): NestMask {
  if (pad <= 0) return mask;
  let perMask = dilateCache.get(mask);
  if (!perMask) { perMask = new Map(); dilateCache.set(mask, perMask); }
  const hit = perMask.get(pad);
  if (hit) return hit;

  const cols = mask.cols + pad * 2;
  const rows = mask.rows + pad * 2;
  const horiz = new Uint8Array(cols * rows);
  for (let r = 0; r < mask.rows; r++) {
    const src = r * mask.cols;
    const dst = (r + pad) * cols;
    let c = 0;
    while (c < mask.cols) {
      if (!mask.bits[src + c]) { c++; continue; }
      let end = c + 1;
      while (end < mask.cols && mask.bits[src + end]) end++;
      // Source run [c, end) sits at [c + pad, end + pad) in the padded buffer and grows by
      // `pad` each way, giving [c, end + 2 * pad).
      horiz.fill(1, dst + c, dst + end + pad * 2);
      c = end;
    }
  }
  const out = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      if (!horiz[r * cols + c]) { r++; continue; }
      let end = r + 1;
      while (end < rows && horiz[end * cols + c]) end++;
      const lo = Math.max(0, r - pad);
      const hi = Math.min(rows, end + pad);
      for (let rr = lo; rr < hi; rr++) out[rr * cols + c] = 1;
      r = end;
    }
  }
  const result: NestMask = { cols, rows, bits: out };
  perMask.set(pad, result);
  return result;
}

const rotateCache = new WeakMap<NestMask, NestMask>();

/**
 * Rotates a mask 90 degrees clockwise, matching what `rotation: 90` does on screen: the
 * editor's transform maps (x, y) to (-y, x) in a y-down space, sending the top-right
 * corner to the bottom-right.
 */
export function rotateMask90(mask: NestMask): NestMask {
  const hit = rotateCache.get(mask);
  if (hit) return hit;
  const { cols, rows, bits } = mask;
  const out = new Uint8Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const src = y * cols;
    const dstX = rows - 1 - y;
    for (let x = 0; x < cols; x++) {
      if (bits[src + x]) out[x * rows + dstX] = 1;
    }
  }
  const result: NestMask = { cols: rows, rows: cols, bits: out };
  rotateCache.set(mask, result);
  return result;
}

function rotateMaskTimes(mask: NestMask, quarters: number): NestMask {
  let out = mask;
  for (let i = 0; i < (((quarters % 4) + 4) % 4); i++) out = rotateMask90(out);
  return out;
}

/**
 * Resample, used only when a cached mask predates a scale change. Every destination cell
 * takes the union of the source cells it covers rather than one sampled cell, so shrinking a
 * mask can never drop ink and let a neighbour encroach on it.
 */
function resampleMask(mask: NestMask, cols: number, rows: number): NestMask {
  if (mask.cols === cols && mask.rows === rows) return mask;
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const r0 = Math.min(mask.rows - 1, Math.floor((r * mask.rows) / rows));
    const r1 = Math.max(r0 + 1, Math.min(mask.rows, Math.ceil(((r + 1) * mask.rows) / rows)));
    const dstBase = r * cols;
    for (let c = 0; c < cols; c++) {
      const c0 = Math.min(mask.cols - 1, Math.floor((c * mask.cols) / cols));
      const c1 = Math.max(c0 + 1, Math.min(mask.cols, Math.ceil(((c + 1) * mask.cols) / cols)));
      let on = 0;
      for (let sr = r0; sr < r1 && !on; sr++) {
        const srcBase = sr * mask.cols;
        for (let sc = c0; sc < c1; sc++) {
          if (mask.bits[srcBase + sc]) { on = 1; break; }
        }
      }
      out[dstBase + c] = on;
    }
  }
  return { cols, rows, bits: out };
}

// ---------------------------------------------------------------------------
// Collision testing
// ---------------------------------------------------------------------------

interface TestMask {
  cols: number;
  rows: number;
  wordsPerRow: number;
  words: Uint32Array;
  /**
   * Row indices containing ink, densest first. Ordering by density means a doomed position
   * is usually rejected on the first row examined, which is what keeps the scan cheap.
   */
  rowOrder: Int32Array;
  /** Leftmost ink column of each row, or -1 for a blank row. Drives the column skip. */
  rowFirstCol: Int32Array;
  /** The densest ink row and its demands, used to reject a grid row before scanning it. */
  denseRow: number;
  denseCount: number;
  denseMaxRun: number;
}

/**
 * A mask trimmed down to its ink, plus where that trim sits inside the original footprint.
 * Everything the packer reasons about is the trimmed silhouette; the offsets exist only to
 * translate a placement back into the footprint coordinates the editor uses.
 */
interface Silhouette {
  mask: NestMask;
  test: TestMask;
  offCol: number;
  offRow: number;
  inkCells: number;
  /** True when the trim found no ink at all, so the footprint was used verbatim. */
  empty: boolean;
}

const silhouetteCache = new WeakMap<NestMask, Silhouette>();

function toSilhouette(mask: NestMask): Silhouette {
  const hit = silhouetteCache.get(mask);
  if (hit) return hit;

  const { cols, rows, bits } = mask;
  let minC = cols, maxC = -1, minR = rows, maxR = -1, inkCells = 0;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      if (!bits[base + c]) continue;
      inkCells++;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
    }
  }

  let trimmed: NestMask;
  let offCol = 0, offRow = 0, empty = false;
  if (maxC < 0) {
    // No ink anywhere. Treat the footprint as solid so a blank design still reserves its
    // own space instead of being placed on top of everything.
    trimmed = solidMask(cols, rows);
    inkCells = cols * rows;
    empty = true;
  } else if (minC === 0 && minR === 0 && maxC === cols - 1 && maxR === rows - 1) {
    trimmed = mask;
  } else {
    const tc = maxC - minC + 1;
    const tr = maxR - minR + 1;
    const out = new Uint8Array(tc * tr);
    for (let r = 0; r < tr; r++) {
      const src = (r + minR) * cols + minC;
      out.set(bits.subarray(src, src + tc), r * tc);
    }
    trimmed = { cols: tc, rows: tr, bits: out };
    offCol = minC;
    offRow = minR;
  }

  const result: Silhouette = {
    mask: trimmed,
    test: toTestMask(trimmed),
    offCol,
    offRow,
    inkCells,
    empty,
  };
  silhouetteCache.set(mask, result);
  return result;
}

const testCache = new WeakMap<NestMask, TestMask>();

function toTestMask(mask: NestMask): TestMask {
  const hit = testCache.get(mask);
  if (hit) return hit;
  const { cols, rows, bits } = mask;
  const wordsPerRow = Math.ceil(cols / WORD_BITS);
  const words = new Uint32Array(wordsPerRow * rows);
  const rowFirstCol = new Int32Array(rows).fill(-1);
  const inked: number[] = [];
  for (let r = 0; r < rows; r++) {
    const src = r * cols;
    const dst = r * wordsPerRow;
    let any = false;
    for (let c = 0; c < cols; c++) {
      if (!bits[src + c]) continue;
      words[dst + (c >>> 5)] |= (1 << (c & 31)) >>> 0;
      if (!any) rowFirstCol[r] = c;
      any = true;
    }
    if (any) inked.push(r);
  }
  inked.sort((a, b) =>
    popcountRow(words, b * wordsPerRow, wordsPerRow) - popcountRow(words, a * wordsPerRow, wordsPerRow));

  const denseRow = inked.length > 0 ? inked[0] : 0;
  let denseCount = 0, denseMaxRun = 0, run = 0;
  {
    const src = denseRow * cols;
    for (let c = 0; c < cols; c++) {
      if (bits[src + c]) {
        denseCount++;
        if (++run > denseMaxRun) denseMaxRun = run;
      } else {
        run = 0;
      }
    }
  }

  const result: TestMask = {
    cols, rows, wordsPerRow, words,
    rowOrder: Int32Array.from(inked),
    rowFirstCol,
    denseRow,
    denseCount,
    denseMaxRun,
  };
  testCache.set(mask, result);
  return result;
}

function popcountRow(words: Uint32Array, base: number, n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    let v = words[base + i];
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0F0F0F0F;
    total += Math.imul(v, 0x01010101) >>> 24;
  }
  return total;
}

/** Index of the lowest set bit, for a non-zero word. */
function lowestBit(v: number): number {
  return 31 - Math.clz32(v & -v);
}

/**
 * Tests `tm` with its top-left at cell (x, y) and returns -1 when it fits.
 *
 * On a collision it returns the next x worth trying rather than a bare false. If grid
 * column `gc` blocked us via one of the silhouette's ink columns, that column can only
 * reach `gc` while `x <= gc - firstInkCol` — so every x up to `gc - firstInkCol` is known
 * to be blocked by the same cell and can be skipped outright. On a dense row that turns a
 * whole blocked span into a single jump, which is where most of the scan cost was.
 */
function probe(g: Grid, tm: TestMask, x: number, y: number): number {
  const order = tm.rowOrder;
  const gWpr = g.wordsPerRow;
  const iWpr = tm.wordsPerRow;
  const wordBase = x >>> 5;
  const phase = x & 31;
  const inv = WORD_BITS - phase;

  for (let k = 0; k < order.length; k++) {
    const r = order[k];
    const gBase = (y + r) * gWpr;
    const iBase = r * iWpr;
    let carry = 0;
    const lastWord = phase === 0 ? iWpr - 1 : iWpr;
    for (let w = 0; w <= lastWord; w++) {
      const iw = w < iWpr ? tm.words[iBase + w] : 0;
      let gw: number;
      if (phase === 0) {
        gw = iw;
      } else {
        gw = (((iw << phase) >>> 0) | carry) >>> 0;
        carry = (iw >>> inv) >>> 0;
      }
      if (gw === 0) continue;
      const gi = wordBase + w;
      if (gi >= gWpr) continue;
      const clash = (g.words[gBase + gi] & gw) >>> 0;
      if (clash !== 0) {
        const gc = gi * WORD_BITS + lowestBit(clash);
        return Math.max(x + 1, gc - tm.rowFirstCol[r] + 1);
      }
    }
  }
  return -1;
}

/** True when `tm` placed with its top-left at cell (x, y) touches nothing occupied. */
function fits(g: Grid, tm: TestMask, x: number, y: number): boolean {
  return probe(g, tm, x, y) === -1;
}

/**
 * Topmost-then-leftmost free position for a silhouette. Scanning down from the top rather
 * than dropping items up from the bottom is what lets a small design settle into a
 * concavity left by a larger one; a gravity drop would only ever stack against the lowest
 * contour and would miss exactly the interlocking this whole module exists for.
 */
function findSpot(g: Grid, tm: TestMask, maxX: number, maxY: number): { x: number; y: number } | null {
  if (maxX < 0 || maxY < 0) return null;
  // Everything below the last occupied row is empty, so the first position in that band is
  // trivially free and there is nothing to be gained by scanning for it.
  const scanTo = Math.min(maxY, g.lastRow + 1);
  for (let y = 0; y <= scanTo; y++) {
    const dense = y + tm.denseRow;
    if (rowFreeCount(g, dense) < tm.denseCount) continue;
    if (rowMaxFreeRun(g, dense) < tm.denseMaxRun) continue;
    let x = 0;
    while (x <= maxX) {
      const next = probe(g, tm, x, y);
      if (next === -1) return { x, y };
      x = next;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

function cellsFor(inches: number, cell: number): number {
  return Math.max(1, Math.ceil(inches / cell - 1e-6));
}

function centreToNorm(absX: number, absY: number, abW: number, abH: number) {
  return { nx: absX / abW, ny: absY / abH };
}

interface Orientation {
  sil: Silhouette;
  rotation: number;
  /** Footprint size at this rotation. */
  w: number;
  h: number;
}

function orientationsFor(item: NestItem, cell: number, allowRotation: boolean): Orientation[] {
  const cols = cellsFor(item.w, cell);
  const rows = cellsFor(item.h, cell);
  const base = item.mask ? resampleMask(item.mask, cols, rows) : solidMask(cols, rows);
  const out: Orientation[] = [{ sil: toSilhouette(base), rotation: 0, w: item.w, h: item.h }];
  if (allowRotation && !item.noRotate && Math.abs(item.w - item.h) > 0.1) {
    const turned = rotateMask90(base);
    out.push({ sil: toSilhouette(turned), rotation: 90, w: item.h, h: item.w });
  }
  return out;
}

/**
 * Translates a silhouette placement back into the footprint centre the editor stores.
 * The footprint origin can legitimately fall outside the sheet — that is the whole point
 * of nesting by content — so this deliberately does not clamp.
 */
function placementToCentre(spotX: number, spotY: number, orient: Orientation, cell: number, abW: number, abH: number) {
  const originX = (spotX - orient.sil.offCol) * cell;
  const originY = (spotY - orient.sil.offRow) * cell;
  return centreToNorm(originX + orient.w / 2, originY + orient.h / 2, abW, abH);
}

interface NestContext {
  grid: Grid;
  cell: number;
  pad: number;
  cols: number;
  rows: number;
}

function makeContext(usableW: number, usableH: number, gap: number): NestContext {
  const cell = NEST_CELL_INCHES;
  const cols = Math.max(1, Math.round(usableW / cell));
  const rows = Math.max(1, Math.round(usableH / cell));
  // A halo of `pad` cells leaves exactly `pad` cells of clear film between two designs: the
  // halo occupies the cells either side, and the next design's ink starts in the first cell
  // beyond it. So the halo is the gap, with nothing to subtract.
  const pad = Math.max(0, Math.round(gap / cell));
  return { grid: makeGrid(cols, rows), cell, pad, cols, rows };
}

/**
 * The silhouette of a design whose bounds on the sheet are `boundsW` x `boundsH`, oriented
 * to match. The mask itself is always stored unrotated, so this is where the sheet's view of
 * a turned design is reconstructed.
 */
function orientedSilhouette(
  mask: NestMask | undefined,
  boundsW: number,
  boundsH: number,
  rotation: number,
  cell: number,
): Silhouette {
  const quarters = ((Math.round(rotation / 90) % 4) + 4) % 4;
  const onAxis = Math.abs(rotation - quarters * 90) < 1;
  if (!mask || !onAxis) {
    // A free rotation would need a resampled affine transform of the mask. Reserving the
    // bounding box over-reserves a little but can never let another design land on this
    // one, and gangsheet artwork is rarely rotated off the axes.
    return toSilhouette(solidMask(cellsFor(boundsW, cell), cellsFor(boundsH, cell)));
  }
  const upright = quarters % 2 === 0;
  const footW = upright ? boundsW : boundsH;
  const footH = upright ? boundsH : boundsW;
  const base = resampleMask(mask, cellsFor(footW, cell), cellsFor(footH, cell));
  return toSilhouette(rotateMaskTimes(base, quarters));
}

function seedObstacles(ctx: NestContext, obstacles: NestObstacle[] | undefined): void {
  for (const obs of obstacles ?? []) {
    const sil = orientedSilhouette(obs.mask, obs.w, obs.h, obs.rotation ?? 0, ctx.cell);
    writeDilated(
      ctx.grid, sil.mask,
      Math.round(obs.x / ctx.cell) + sil.offCol,
      Math.round(obs.y / ctx.cell) + sil.offRow,
      ctx.pad,
    );
  }
}

function nestInto(
  ctx: NestContext,
  items: NestItem[],
  abW: number,
  abH: number,
  gap: number,
  allowRotation: boolean,
  startHeight: number,
): { placements: NestPlacement[]; maxHeight: number } {
  const placements: NestPlacement[] = [];
  let maxHeight = startHeight;

  for (const item of items) {
    let best: { x: number; y: number; orient: Orientation } | null = null;
    for (const orient of orientationsFor(item, ctx.cell, allowRotation)) {
      const spot = findSpot(
        ctx.grid, orient.sil.test,
        ctx.cols - orient.sil.mask.cols,
        ctx.rows - orient.sil.mask.rows,
      );
      if (!spot) continue;
      // Topmost, then leftmost. Note what this does *not* do: it does not ask which
      // orientation ends higher up the film, so a design that can squeeze into a notch
      // standing up is placed there even when lying below the work above it would have cost
      // the sheet less. Judging by the bottom edge here was measured to be worse overall — it
      // lays everything down and spends the sheet's width — because a greedy pass cannot know
      // whether this design will turn out to be the one setting the length. That case is
      // repaired once the layout is known instead; see `reseatFilmBottom`.
      if (!best || spot.y < best.y || (spot.y === best.y && spot.x < best.x)) {
        best = { x: spot.x, y: spot.y, orient: orient };
      }
    }
    if (best) {
      writeDilated(ctx.grid, best.orient.sil.mask, best.x, best.y, ctx.pad);
      const inkBottom = (best.y + best.orient.sil.mask.rows) * ctx.cell;
      if (inkBottom > maxHeight) maxHeight = inkBottom;
      const { nx, ny } = placementToCentre(best.x, best.y, best.orient, ctx.cell, abW, abH);
      placements.push({ id: item.id, nx, ny, rotation: best.orient.rotation, overflows: false });
    } else {
      const { nx, ny } = centreToNorm(item.w / 2, maxHeight + item.h / 2, abW, abH);
      placements.push({ id: item.id, nx, ny, rotation: 0, overflows: true });
      maxHeight += item.h + gap;
    }
  }

  return { placements, maxHeight };
}

function inkArea(items: NestItem[], cell: number): number {
  let total = 0;
  for (const item of items) {
    const cols = cellsFor(item.w, cell);
    const rows = cellsFor(item.h, cell);
    const mask = item.mask ? resampleMask(item.mask, cols, rows) : solidMask(cols, rows);
    total += toSilhouette(mask).inkCells * cell * cell;
  }
  return total;
}

/**
 * Places `items` in the order given. Each item tries both orientations, unless rotation is
 * disallowed, and takes whichever lands higher up the sheet.
 */
export function nestPack(
  items: NestItem[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
  gap: number,
  obstacles?: NestObstacle[],
  allowRotation = true,
): NestResult {
  const ctx = makeContext(usableW, usableH, gap);
  seedObstacles(ctx, obstacles);
  const { placements, maxHeight } = nestInto(ctx, items, abW, abH, gap, allowRotation, 0);
  return {
    result: placements,
    maxHeight,
    wastedArea: Math.max(0, usableW * maxHeight - inkArea(items, ctx.cell)),
  };
}

/**
 * The nesting counterpart of `keepPositionsPack`: settled designs keep their exact
 * position and are stamped into the occupancy grid, and only the newcomers — plus anything
 * whose current spot is illegal — get nested into what is left.
 *
 * Anchors are considered top-to-bottom so the part of the sheet the user has already
 * settled wins any conflict and a newcomer is what gives way.
 */
export function keepPositionsNest(
  items: NestItem[],
  current: NestCurrent[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
  gap: number,
  obstacles: NestObstacle[] | undefined,
  /** Import placement passes false: a design arriving sideways on its own is startling. */
  allowRotation = true,
): NestResult {
  const ctx = makeContext(usableW, usableH, gap);
  seedObstacles(ctx, obstacles);

  // A second grid with a slightly smaller halo decides whether a settled design may stay.
  // Validating against the placement grid would be wrong: rounding a design's inch
  // position to the nearest cell can shift it by half a cell, so a pair spaced at exactly
  // the gap can read as one cell too close and get uprooted for nothing. Placement stays
  // strict; only this legality check is lenient, and by a single cell.
  const check: NestContext = {
    ...ctx,
    grid: makeGrid(ctx.cols, ctx.rows),
    pad: Math.max(0, ctx.pad - 1),
  };
  seedObstacles(check, obstacles);

  const currentById = new Map(current.map(c => [c.id, c]));
  const result: NestPlacement[] = [];
  const floating: NestItem[] = [];
  let maxHeight = 0;

  const ordered = [...items].sort((a, b) => {
    const ca = currentById.get(a.id), cb = currentById.get(b.id);
    if (!ca) return cb ? 1 : 0;
    if (!cb) return -1;
    return ca.y - cb.y || ca.x - cb.x;
  });

  for (const item of ordered) {
    const c = currentById.get(item.id);
    if (!c) { floating.push(item); continue; }
    const anchor = orientedSilhouette(item.mask, c.w, c.h, c.rotation, ctx.cell);
    const inkX = Math.round(c.x / ctx.cell) + anchor.offCol;
    const inkY = Math.round(c.y / ctx.cell) + anchor.offRow;
    const inBounds = inkX >= 0 && inkY >= 0 &&
                     inkX + anchor.mask.cols <= ctx.cols &&
                     inkY + anchor.mask.rows <= ctx.rows;
    if (!inBounds || !fits(check.grid, anchor.test, inkX, inkY)) {
      floating.push(item);
      continue;
    }
    writeDilated(ctx.grid, anchor.mask, inkX, inkY, ctx.pad);
    writeDilated(check.grid, anchor.mask, inkX, inkY, check.pad);
    const inkBottom = (inkY + anchor.mask.rows) * ctx.cell;
    if (inkBottom > maxHeight) maxHeight = inkBottom;
    const { nx, ny } = centreToNorm(c.x + c.w / 2, c.y + c.h / 2, abW, abH);
    result.push({ id: item.id, nx, ny, rotation: c.rotation, overflows: false, anchored: true });
  }

  if (floating.length > 0) {
    // Largest first: the leftover room is fragmented, and a big newcomer left until last
    // has nowhere to go but the bottom.
    const order = [...floating].sort((a, b) =>
      Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h));
    const nested = nestInto(ctx, order, abW, abH, gap, allowRotation, maxHeight);
    result.push(...nested.placements);
    maxHeight = nested.maxHeight;
  }

  return {
    result,
    maxHeight,
    wastedArea: Math.max(0, usableW * maxHeight - inkArea(items, ctx.cell)),
  };
}

/**
 * Most designs allowed to change orientation before the film bottom is reconsidered.
 *
 * When more than a handful of designs are all sitting on the bottom edge, the bottom is a
 * full row of work rather than one design hanging below the rest, and re-seating a whole row
 * is a repack — which the candidate sweep has already done, better. Keeping this small is
 * also what keeps the pass cheap: each design costs one grid scan.
 */
const MAX_RESEAT = 4;

/** How close to the bottom edge a design's ink has to reach to count as setting the film. */
const RESEAT_BAND_INCHES = 0.1;

/**
 * Re-seats the designs whose ink sets the film's bottom edge, trying both ways up, and
 * returns the layout only when the film gets shorter.
 *
 * This exists because the packers place designs one at a time and cannot know which one will
 * end up last. Each takes the topmost slot that fits, so a tall design that can just squeeze
 * into a notch is stood up there even when lying it below the work above would have finished
 * higher. Judging orientation by the bottom edge *during* packing was measured to be worse,
 * not better: it lays everything down, spends the sheet's width and pushes later designs
 * down, costing more than an inch of film per sheet. Once the layout is finished there is no
 * guesswork left — the designs at the bottom are known, and so is what moving them costs — so
 * the choice is made here and only kept when it pays.
 *
 * Worth calibrating expectations: across the 432 layouts in
 * `scripts/verify-arrange-integrity.ts` this fires 127 times and recovers between 0.03" and
 * 2.5" of film, averaging 0.3", and none of those crossed a purchasable length. So it is a
 * tidiness pass, not a discount — which still matters, because the next copy the customer
 * adds is packed into whatever slack this leaves behind. The cases where orientation would
 * have cost a whole rung are caught earlier, by the candidate sweep trying every design
 * landscape and portrait.
 *
 * Returns null when there is nothing to gain, which is the common case; the caller keeps its
 * existing layout untouched.
 */
export function reseatFilmBottom(
  items: NestItem[],
  placed: NestPlacement[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
  gap: number,
  obstacles?: NestObstacle[],
  allowRotation = true,
): NestResult | null {
  if (!allowRotation) return null;
  // Something has to hold the film for a re-seat to be measured against: either designs that
  // are staying put, or fixed obstacles. A design being placed on a sheet whose other designs
  // were handed over as obstacles is the ordinary case for an import or a duplicate, and it is
  // exactly the one the "13x18 landed standing up at the bottom" report describes.
  const hasFloor = placed.length > 1 || (obstacles?.length ?? 0) > 0;
  if (!hasFloor) return null;
  const cell = NEST_CELL_INCHES;
  const itemById = new Map(items.map(i => [i.id, i]));

  interface Seat {
    placement: NestPlacement;
    item: NestItem;
    sil: Silhouette;
    col: number;
    row: number;
  }
  const seats: Seat[] = [];
  for (const p of placed) {
    const item = itemById.get(p.id);
    // An overflowing layout has designs piled outside the sheet, and a free rotation would
    // need the mask resampled rather than turned. Neither is this pass's problem.
    if (!item || p.overflows) return null;
    const quarters = ((Math.round(p.rotation / 90) % 4) + 4) % 4;
    if (Math.abs(p.rotation - quarters * 90) > 1) return null;
    const upright = quarters % 2 === 0;
    const footW = upright ? item.w : item.h;
    const footH = upright ? item.h : item.w;
    const sil = orientedSilhouette(item.mask, footW, footH, p.rotation, cell);
    seats.push({
      placement: p,
      item,
      sil,
      col: Math.round((p.nx * abW - footW / 2) / cell) + sil.offCol,
      row: Math.round((p.ny * abH - footH / 2) / cell) + sil.offRow,
    });
  }

  const inkBottom = (s: Seat): number => s.row + s.sil.mask.rows;
  const filmRows = seats.reduce((m, s) => Math.max(m, inkBottom(s)), 0);
  const band = Math.max(1, Math.round(RESEAT_BAND_INCHES / cell));
  // Anchored designs are ones the caller promised not to disturb, so they hold the bottom
  // rather than being asked to move off it.
  const movers = seats.filter(s => !s.placement.anchored && inkBottom(s) >= filmRows - band);
  if (movers.length === 0 || movers.length > MAX_RESEAT) return null;
  if (movers.length === seats.length && (obstacles?.length ?? 0) === 0) return null;
  // Nothing standing up has anything to gain from being turned, and neither has a square.
  if (!movers.some(m => Math.abs(m.item.w - m.item.h) > 0.1 && !m.item.noRotate)) return null;

  const ctx = makeContext(usableW, usableH, gap);
  seedObstacles(ctx, obstacles);
  const moverIds = new Set(movers.map(m => m.placement.id));
  let floorRows = 0;
  for (const s of seats) {
    if (moverIds.has(s.placement.id)) continue;
    writeDilated(ctx.grid, s.sil.mask, s.col, s.row, ctx.pad);
    floorRows = Math.max(floorRows, inkBottom(s));
  }

  // Largest first, for the same reason the nester seats newcomers that way: the room left
  // over is fragmented, and the big one left until last has nowhere to go but down.
  const order = [...movers].sort((a, b) =>
    Math.max(b.item.w, b.item.h) - Math.max(a.item.w, a.item.h)
    || (b.item.w * b.item.h) - (a.item.w * a.item.h));

  const reseated: NestPlacement[] = [];
  let newBottom = floorRows;
  for (const mover of order) {
    let best: { x: number; y: number; bottom: number; orient: Orientation } | null = null;
    for (const orient of orientationsFor(mover.item, cell, allowRotation)) {
      const spot = findSpot(
        ctx.grid, orient.sil.test,
        ctx.cols - orient.sil.mask.cols,
        ctx.rows - orient.sil.mask.rows,
      );
      if (!spot) continue;
      // Lowest finishing edge wins here, unlike during packing: this design is one of the
      // ones setting the film length, so where its ink ends is exactly what it costs.
      const bottom = spot.y + orient.sil.mask.rows;
      if (!best
        || bottom < best.bottom
        || (bottom === best.bottom && (spot.y < best.y || (spot.y === best.y && spot.x < best.x)))) {
        best = { x: spot.x, y: spot.y, bottom, orient };
      }
    }
    // No seat for something that was placed a moment ago means the grid is telling us this
    // layout cannot be rebuilt piecemeal. Leave it alone.
    if (!best) return null;
    writeDilated(ctx.grid, best.orient.sil.mask, best.x, best.y, ctx.pad);
    if (best.bottom > newBottom) newBottom = best.bottom;
    const { nx, ny } = placementToCentre(best.x, best.y, best.orient, cell, abW, abH);
    reseated.push({ id: mover.placement.id, nx, ny, rotation: best.orient.rotation, overflows: false });
  }

  if (newBottom >= filmRows) return null;

  const byId = new Map(reseated.map(p => [p.id, p]));
  const maxHeight = newBottom * cell;
  return {
    result: placed.map(p => byId.get(p.id) ?? p),
    maxHeight,
    wastedArea: Math.max(0, usableW * maxHeight - inkArea(items, cell)),
  };
}

/**
 * What a design's ink costs a sheet, independent of where anything is placed.
 *
 * Every field is a quantity no legal layout can undercut, which is what makes them usable
 * as lower bounds on the height a set of designs needs. `minRowWidth` is deliberately the
 * *narrowest* inked scanline rather than the ink's bounding width: a design can only be
 * nested beside a neighbour where it is narrow, so the narrowest row is the only width
 * that is true of the design everywhere it has ink.
 */
export interface InkProfile {
  /** Ink area in square inches. Two designs' ink can never overlap, so these add up. */
  area: number;
  /** Fewest inches of horizontal film consumed by any single inked scanline. */
  minRowWidth: number;
  /** Distance from the topmost inked row to the bottommost, in inches. */
  height: number;
  /**
   * The same two measurements for the design turned 90 degrees, where the sheet's
   * scanlines run along what were the mask's columns. Kept here rather than measured from
   * a rotated copy because both fall out of the one pass.
   */
  minColHeight: number;
  width: number;
}

const inkProfileCache = new WeakMap<NestMask, Map<string, InkProfile>>();

/**
 * Measures `mask` as it would appear on a `w` x `h` footprint.
 *
 * A design with no mask is a solid rectangle, which is the strongest possible profile and
 * also the honest one — the rectangle packers reserve the whole footprint for it.
 */
export function inkProfile(mask: NestMask | undefined, w: number, h: number): InkProfile {
  const solid: InkProfile = { area: w * h, minRowWidth: w, height: h, minColHeight: h, width: w };
  if (!mask) return solid;
  const cell = NEST_CELL_INCHES;
  const cols = cellsFor(w, cell);
  const rows = cellsFor(h, cell);
  const key = `${cols}x${rows}`;
  let perMask = inkProfileCache.get(mask);
  if (!perMask) { perMask = new Map(); inkProfileCache.set(mask, perMask); }
  const hit = perMask.get(key);
  if (hit) return hit;

  const scaled = resampleMask(mask, cols, rows);
  const colCells = new Int32Array(cols);
  let inkCells = 0;
  let minRowCells = Infinity;
  let firstRow = -1, lastRow = -1;
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let rowCells = 0;
    for (let c = 0; c < cols; c++) {
      if (!scaled.bits[base + c]) continue;
      rowCells++;
      colCells[c]++;
    }
    if (rowCells === 0) continue;
    inkCells += rowCells;
    if (rowCells < minRowCells) minRowCells = rowCells;
    if (firstRow < 0) firstRow = r;
    lastRow = r;
  }

  // A mask with no ink at all is treated as solid everywhere else in this module, because
  // a blank design still has to reserve its own space rather than be placed on top of
  // something. Same rule here so the two cannot disagree.
  if (firstRow < 0) {
    perMask.set(key, solid);
    return solid;
  }

  let minColCells = Infinity;
  let firstCol = -1, lastCol = -1;
  for (let c = 0; c < cols; c++) {
    if (colCells[c] === 0) continue;
    if (colCells[c] < minColCells) minColCells = colCells[c];
    if (firstCol < 0) firstCol = c;
    lastCol = c;
  }

  const profile: InkProfile = {
    area: inkCells * cell * cell,
    minRowWidth: minRowCells * cell,
    height: (lastRow - firstRow + 1) * cell,
    minColHeight: minColCells * cell,
    width: (lastCol - firstCol + 1) * cell,
  };
  perMask.set(key, profile);
  return profile;
}

/** Blank margin in inches between a footprint's edges and the ink inside it. */
export interface InkInset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NO_INSET: InkInset = { left: 0, top: 0, right: 0, bottom: 0 };

/**
 * How much of a design's footprint is empty on each side at the given rotation.
 *
 * This is what makes a nested layout comparable with a rectangle-packed one: both are
 * measured by where the ink actually ends rather than where the bounding box does, so
 * neither is flattered by the metric.
 */
export function inkInset(
  mask: NestMask | undefined,
  w: number,
  h: number,
  rotation: number,
): InkInset {
  if (!mask) return NO_INSET;
  const quarters = ((Math.round(rotation / 90) % 4) + 4) % 4;
  if (Math.abs(rotation - quarters * 90) > 1) return NO_INSET;
  const cell = NEST_CELL_INCHES;
  const base = resampleMask(mask, cellsFor(w, cell), cellsFor(h, cell));
  const oriented = rotateMaskTimes(base, quarters);
  const sil = toSilhouette(oriented);
  if (sil.empty) return NO_INSET;
  return {
    left: sil.offCol * cell,
    top: sil.offRow * cell,
    right: (oriented.cols - sil.offCol - sil.mask.cols) * cell,
    bottom: (oriented.rows - sil.offRow - sil.mask.rows) * cell,
  };
}

