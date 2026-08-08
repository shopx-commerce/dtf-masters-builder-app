// Shared packing core. Both `arrange-worker.ts` (the normal path) and the synchronous
// fallback in `useImageEditorModelArrangeKeyboard.ts` (used when the worker is missing or
// times out) call `runArrange` from here. These were previously two hand-maintained
// copies that had silently diverged: the worker was missing the maximal-free-rectangle
// split that MaxRects depends on, while the fallback lacked obstacle support and the
// rotation safety offset. Keep this the single implementation.

import {
  inkInset,
  inkProfile,
  keepPositionsNest,
  nestPack,
  type NestItem,
  type NestMask,
  type NestObstacle,
} from './nest-core';

type SkylineSeg = { x: number; y: number; w: number };
type PackItem = { id: string; w: number; h: number; rotation: number; gap: number; noRotate?: boolean };
export type PlacedItem = {
  id: string;
  nx: number;
  ny: number;
  rotation: number;
  overflows: boolean;
  /** Set when the item kept its existing position, so the caller can leave it untouched. */
  anchored?: boolean;
};
type Candidate = {
  result: PlacedItem[];
  maxHeight: number;
  wastedArea: number;
  overflows: number;
  /**
   * Bottom edge of the lowest ink, which is the film the sheet actually consumes. Equal to
   * `maxHeight` for items without a silhouette, so rankings are unchanged when no masks
   * are supplied.
   */
  filmHeight: number;
};

export interface FixedRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Silhouette in the design's own unrotated space, when its artwork is known. */
  mask?: NestMask;
  /** How the design is turned on the sheet, so `mask` can be oriented to match. */
  rotation?: number;
}

/** Where a design currently sits: axis-aligned bounds in inches from the sheet's top-left. */
export interface CurrentRect extends FixedRect {
  id: string;
  rotation: number;
}

export interface ArrangeInput {
  type: 'arrange';
  requestId: number;
  items: Array<{
    id: string;
    w: number;
    h: number;
    fill: number;
    /**
     * Ink silhouette covering the item's whole footprint. Supplying it lets the bitmap
     * nester compete with the rectangle packers, so shapes can interlock instead of each
     * reserving its empty corners.
     */
    mask?: NestMask;
    /**
     * Item that must be placed at rotation 0. Used for a user-defined group, which is packed
     * as one super-item and can only be translated back onto its members.
     */
    noRotate?: boolean;
  }>;
  usableW: number;
  usableH: number;
  artboardWidth: number;
  artboardHeight: number;
  isAggressive: boolean;
  customGap?: number;
  fixedRects?: FixedRect[];
  /**
   * Where the items already are. Supplying this lets the packer offer a layout that leaves
   * settled work alone; without it every arrange is a repack from an empty sheet.
   */
  current?: CurrentRect[];
  /**
   * Keep existing positions unless a full repack is *worth* the disruption. Used for the
   * arranges the user did not explicitly ask for — adding a copy, duplicating, growing the
   * sheet — where silently relocating a dozen settled designs is the reported complaint.
   */
  preferStable?: boolean;
  /** Purchasable sheet heights. A repack only counts as an improvement if it reaches a shorter one. */
  heightSteps?: number[];
}

const EPS = 0.01;
const DEBUG_OVERLAP = false; // Set true to log when rotation is used (for overlap debugging)
/** ARRANGE_RANK_DEBUG=1 dumps the candidate ranking. Node-only; workers have no `process`. */
const DEBUG_RANK = typeof process !== 'undefined' && !!process.env?.ARRANGE_RANK_DEBUG;
const ROTATION_SAFETY = 0.02; // Extra vertical offset when rotation=90 to prevent overlap with row above

function findBestPos(sky: SkylineSeg[], itemW: number, itemH: number, usableH: number): { x: number; y: number; waste: number } | null {
  let bestX = -1, bestY = Infinity, bestWaste = Infinity, found = false;
  for (let i = 0; i < sky.length; i++) {
    let spanW = 0, maxY = 0, j = i;
    while (j < sky.length && spanW < itemW) {
      maxY = Math.max(maxY, sky[j].y);
      spanW += sky[j].w;
      j++;
    }
    if (spanW < itemW - EPS) continue;
    if (maxY + itemH > usableH + EPS) continue;
    let waste = 0;
    const rightBound = sky[i].x + itemW;
    for (let k = i; k < j; k++) {
      const segL = Math.max(sky[k].x, sky[i].x);
      const segR = Math.min(sky[k].x + sky[k].w, rightBound);
      waste += (maxY - sky[k].y) * Math.max(0, segR - segL);
    }
    const betterY = maxY < bestY - EPS;
    const sameY = Math.abs(maxY - bestY) < EPS;
    const moreLeft = sky[i].x < bestX - EPS;
    const sameX = Math.abs(sky[i].x - bestX) < EPS;
    if (betterY || (sameY && moreLeft) || (sameY && sameX && waste < bestWaste)) {
      bestY = maxY; bestX = sky[i].x; bestWaste = waste; found = true;
    }
  }
  return found ? { x: bestX, y: bestY, waste: bestWaste } : null;
}

function placeSeg(sky: SkylineSeg[], px: number, itemW: number, itemH: number): SkylineSeg[] {
  let topY = 0;
  for (const s of sky) {
    // Include segments that overlap or touch (>= px-EPS: segment ending exactly at px must contribute topY)
    if (s.x < px + itemW && s.x + s.w >= px - EPS) topY = Math.max(topY, s.y);
  }
  const next: SkylineSeg[] = [];
  for (const s of sky) {
    const sR = s.x + s.w, iR = px + itemW;
    if (sR <= px || s.x >= iR) { next.push(s); continue; }
    if (s.x < px) next.push({ x: s.x, y: s.y, w: px - s.x });
    if (sR > iR) next.push({ x: iR, y: s.y, w: sR - iR });
  }
  next.push({ x: px, y: topY + itemH, w: itemW });
  next.sort((a, b) => a.x - b.x);
  const merged: SkylineSeg[] = [next[0]];
  for (let k = 1; k < next.length; k++) {
    const prev = merged[merged.length - 1];
    if (Math.abs(prev.y - next[k].y) < EPS && Math.abs((prev.x + prev.w) - next[k].x) < EPS) {
      prev.w += next[k].w;
    } else {
      merged.push(next[k]);
    }
  }
  return merged;
}

function toNxNy(absX: number, absY: number, w: number, h: number, abW: number, abH: number) {
  return {
    nx: Math.max(w / 2 / abW, Math.min((abW - w / 2) / abW, absX / abW)),
    ny: Math.max(h / 2 / abH, Math.min((abH - h / 2) / abH, absY / abH)),
  };
}

function skylinePack(items: PackItem[], usableW: number, usableH: number, abW: number, abH: number): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  let sky: SkylineSeg[] = [{ x: 0, y: 0, w: usableW }];
  const result: PlacedItem[] = [];
  let totalWaste = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const g = item.gap;
    const halfG = g / 2;
    let pos: { x: number; y: number; waste: number } | null = null;
    let rw = 0, rh = 0;

    pos = findBestPos(sky, item.w + g, item.h + g, usableH);
    if (pos) { rw = item.w + g; rh = item.h + g; }
    if (!pos) {
      pos = findBestPos(sky, item.w + halfG, item.h + halfG, usableH);
      if (pos) { rw = item.w + halfG; rh = item.h + halfG; }
    }

    if (pos) {
      totalWaste += pos.waste;
      sky = placeSeg(sky, pos.x, rw, rh);
      const extraY = item.rotation === 90 ? ROTATION_SAFETY : 0;
      const absCx = pos.x + item.w / 2, absCy = pos.y + item.h / 2 + extraY;
      const { nx, ny } = toNxNy(absCx, absCy, item.w, item.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: item.rotation, overflows: false });
    } else {
      const skyMax = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0;
      const placedH = item.h + halfG;
      const absX = item.w / 2;
      const extraY = item.rotation === 90 ? ROTATION_SAFETY : 0;
      const absY = skyMax + placedH / 2 + extraY;
      sky = placeSeg(sky, 0, Math.min(item.w + halfG, usableW), placedH);
      const { nx, ny } = toNxNy(absX, absY, item.w, item.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: item.rotation, overflows: true });
    }
  }
  const maxH = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0;
  return { result, maxHeight: maxH, wastedArea: totalWaste };
}

function greedyOrientPack(sortedItems: Array<{ id: string; w: number; h: number; gap: number; noRotate?: boolean }>, usableW: number, usableH: number, abW: number, abH: number): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  let sky: SkylineSeg[] = [{ x: 0, y: 0, w: usableW }];
  const result: PlacedItem[] = [];
  let totalWaste = 0;

  for (const item of sortedItems) {
    const g = item.gap;
    const orientations: Array<{ w: number; h: number; rot: number }> = [
      { w: item.w, h: item.h, rot: 0 },
    ];
    if (!item.noRotate && Math.abs(item.w - item.h) > 0.1) {
      orientations.push({ w: item.h, h: item.w, rot: 90 });
    }

    let bestPos: { x: number; y: number; waste: number } | null = null;
    let bestOrient = orientations[0];
    let bestSky = sky;

    for (const orient of orientations) {
      const halfG = g / 2;
      const attempts = [
        { w: orient.w + g, h: orient.h + g },
        { w: orient.w + halfG, h: orient.h + halfG },
      ];
      for (const attempt of attempts) {
        const pos = findBestPos(sky, attempt.w, attempt.h, usableH);
        if (!pos) continue;
        const score = pos.y * 10000 + pos.x * 10 + pos.waste;
        const bestScore = bestPos ? bestPos.y * 10000 + bestPos.x * 10 + bestPos.waste : Infinity;
        if (score < bestScore) {
          bestPos = pos;
          bestOrient = orient;
          bestSky = placeSeg(sky.map(s => ({ ...s })), pos.x, attempt.w, attempt.h);
        }
        break;
      }
    }

    if (bestPos) {
      totalWaste += bestPos.waste;
      sky = bestSky;
      const extraY = bestOrient.rot === 90 ? ROTATION_SAFETY : 0;
      const { nx, ny } = toNxNy(bestPos.x + bestOrient.w / 2, bestPos.y + bestOrient.h / 2 + extraY, bestOrient.w, bestOrient.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: bestOrient.rot, overflows: false });
    } else {
      if (DEBUG_OVERLAP && Math.abs(item.w - item.h) > 0.1) {
        console.debug('[arrange] greedyOrientPack overflow', item.id.slice(0, 8), 'rect', item.w.toFixed(2), 'x', item.h.toFixed(2));
      }
      const skyMax = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0;
      const placedH = item.h + g;
      const absX = item.w / 2;
      const absY = skyMax + placedH / 2;
      sky = placeSeg(sky, 0, Math.min(item.w + g, usableW), placedH);
      const { nx, ny } = toNxNy(absX, absY, item.w, item.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: 0, overflows: true });
    }
  }
  const maxH = sky.length > 0 ? Math.max(...sky.map(s => s.y)) : 0;
  return { result, maxHeight: maxH, wastedArea: totalWaste };
}

function gridPack(
  items: Array<{ id: string; w: number; h: number; fill: number; noRotate?: boolean }>,
  gap: number,
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
): { result: PlacedItem[]; maxHeight: number; wastedArea: number } | null {
  if (items.length < 2) return null;

  const ref = items[0];
  const allSimilar = items.every(d =>
    Math.abs(d.w - ref.w) < 0.2 && Math.abs(d.h - ref.h) < 0.2
  );
  if (!allSimilar) return null;

  // Use max dimensions so every item fits in its cell (avoids overlap when items vary within 0.2")
  const cellW = Math.max(...items.map(d => d.w));
  const cellH = Math.max(...items.map(d => d.h));

  const tryGrid = (iw: number, ih: number, rot: number) => {
    const cols = Math.max(1, Math.floor((usableW + gap) / (iw + gap)));
    const rows = Math.ceil(items.length / cols);
    const totalH = rows * ih + (rows - 1) * gap;
    const totalWUsed = cols * iw + (cols - 1) * gap;
    const wastedWidth = usableW - totalWUsed;

    const result: PlacedItem[] = [];
    const extraY = rot === 90 ? ROTATION_SAFETY : 0;
    for (let idx = 0; idx < items.length; idx++) {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const absX = col * (iw + gap) + iw / 2;
      const absY = row * (ih + gap) + ih / 2 + extraY;
      const overflows = absX + iw / 2 > usableW + EPS || absY + ih / 2 > usableH + EPS;
      const { nx, ny } = toNxNy(absX, absY, iw, ih, abW, abH);
      result.push({ id: items[idx].id, nx, ny, rotation: rot, overflows });
    }
    return {
      result,
      maxHeight: totalH,
      wastedArea: wastedWidth * totalH,
    };
  };

  const normalGrid = tryGrid(cellW, cellH, 0);
  const isSquarish = Math.abs(ref.w - ref.h) < 0.2;
  // A grid turns every cell at once, so one item that cannot be turned rules out the
  // rotated variant for the whole sheet.
  if (isSquarish || items.some(d => d.noRotate)) return normalGrid;

  const rotatedGrid = tryGrid(cellH, cellW, 90);
  if (DEBUG_OVERLAP) {
    console.debug('[arrange] grid rotated', { cellW: cellW.toFixed(2), cellH: cellH.toFixed(2), rot: 90 });
  }

  const normalOverflows = normalGrid.result.filter(r => r.overflows).length;
  const rotatedOverflows = rotatedGrid.result.filter(r => r.overflows).length;
  if (normalOverflows !== rotatedOverflows) return normalOverflows < rotatedOverflows ? normalGrid : rotatedGrid;
  if (Math.abs(normalGrid.maxHeight - rotatedGrid.maxHeight) > 0.01) return normalGrid.maxHeight < rotatedGrid.maxHeight ? normalGrid : rotatedGrid;
  return normalGrid.wastedArea <= rotatedGrid.wastedArea ? normalGrid : rotatedGrid;
}

function mixedOrientPack(
  items: PackItem[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  const halfW = usableW / 2;
  const adjusted: PackItem[] = items.map(item => {
    if (!item.noRotate && item.w > halfW && item.h < item.w && item.h <= halfW) {
      return { ...item, w: item.h, h: item.w, rotation: item.rotation === 0 ? 90 : 0 };
    }
    return item;
  });
  return skylinePack(adjusted, usableW, usableH, abW, abH);
}

type FreeRect = { x: number; y: number; w: number; h: number };

function subtractRect(from: FreeRect, placed: { x: number; y: number; w: number; h: number }): FreeRect[] {
  if (placed.x >= from.x + from.w - EPS || placed.x + placed.w <= from.x + EPS ||
      placed.y >= from.y + from.h - EPS || placed.y + placed.h <= from.y + EPS) {
    return [from];
  }
  // The four strips must each be MAXIMAL — as large as they can be without covering
  // `placed` — which means they overlap each other in the corners. That overlap is what
  // makes this MaxRects rather than a guillotine partition: a later item can straddle a
  // corner that no single non-overlapping strip would have offered. Clipping the
  // horizontal strips to `placed.w` instead of the full `from.w` measured a drop from
  // 80% to 41% packing utilisation on 20-50 item sheets.
  const newFree: FreeRect[] = [];
  // Left strip (full height)
  if (placed.x > from.x + EPS)
    newFree.push({ x: from.x, y: from.y, w: placed.x - from.x, h: from.h });
  // Right strip (full height)
  if (placed.x + placed.w < from.x + from.w - EPS)
    newFree.push({ x: placed.x + placed.w, y: from.y, w: from.x + from.w - placed.x - placed.w, h: from.h });
  // Top strip (full width)
  if (placed.y > from.y + EPS)
    newFree.push({ x: from.x, y: from.y, w: from.w, h: placed.y - from.y });
  // Bottom strip (full width)
  if (placed.y + placed.h < from.y + from.h - EPS)
    newFree.push({ x: from.x, y: placed.y + placed.h, w: from.w, h: from.y + from.h - placed.y - placed.h });
  return newFree;
}

function removeContainedRects(rects: FreeRect[]): FreeRect[] {
  const result: FreeRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.w < 0.01 || r.h < 0.01) continue;
    const area = r.w * r.h;
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const o = rects[j];
      if (r.x >= o.x - EPS && r.y >= o.y - EPS &&
          r.x + r.w <= o.x + o.w + EPS && r.y + r.h <= o.y + o.h + EPS) {
        // Two identical rects each contain the other, so a plain containment test drops
        // both and loses the space entirely. Only discard the strictly smaller one, and
        // for equal areas keep whichever comes first.
        const otherArea = o.w * o.h;
        if (area < otherArea - EPS || (Math.abs(area - otherArea) <= EPS && j < i)) {
          contained = true;
          break;
        }
      }
    }
    if (!contained) result.push(r);
  }
  return result;
}

function applyObstacles(initial: FreeRect[], obstacles: FixedRect[], gap: number): FreeRect[] {
  let freeRects = [...initial];
  for (const obs of obstacles) {
    const placed = { x: obs.x, y: obs.y, w: obs.w + gap, h: obs.h + gap };
    const next: FreeRect[] = [];
    for (const fr of freeRects) {
      // Clamp placed to the free rect so we only subtract the overlapping region
      const clipX = Math.max(placed.x, fr.x);
      const clipY = Math.max(placed.y, fr.y);
      const clipW = Math.min(placed.x + placed.w, fr.x + fr.w) - clipX;
      const clipH = Math.min(placed.y + placed.h, fr.y + fr.h) - clipY;
      if (clipW > EPS && clipH > EPS) {
        next.push(...subtractRect(fr, { x: clipX, y: clipY, w: clipW, h: clipH }));
      } else {
        next.push(fr);
      }
    }
    freeRects = removeContainedRects(next);
  }
  return freeRects;
}

function maxRectsPack(
  items: PackItem[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
  heuristic: 'bssf' | 'baf',
  initialObstacles?: FixedRect[],
  gap?: number,
): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  const GAP = gap ?? 0.25;
  let freeRects: FreeRect[] = [{ x: 0, y: 0, w: usableW, h: usableH }];
  if (initialObstacles && initialObstacles.length > 0) {
    freeRects = applyObstacles(freeRects, initialObstacles, GAP);
  }
  const result: PlacedItem[] = [];
  let maxHeight = 0;
  let totalItemArea = 0;

  for (const item of items) {
    const g = item.gap;
    const iw = item.w + g;
    const ih = item.h + g;

    let bestScore = Infinity;
    let bestSecondary = Infinity;
    let bestX = 0, bestY = 0;
    let found = false;

    for (const fr of freeRects) {
      if (iw > fr.w + EPS || ih > fr.h + EPS) continue;
      let score: number, secondary: number;
      if (heuristic === 'bssf') {
        score = Math.min(fr.w - iw, fr.h - ih);
        secondary = Math.max(fr.w - iw, fr.h - ih);
      } else {
        score = fr.w * fr.h - iw * ih;
        secondary = Math.min(fr.w - iw, fr.h - ih);
      }
      if (score < bestScore - EPS || (Math.abs(score - bestScore) < EPS && secondary < bestSecondary - EPS)) {
        bestScore = score;
        bestSecondary = secondary;
        bestX = fr.x;
        bestY = fr.y;
        found = true;
      }
    }

    if (found) {
      maxHeight = Math.max(maxHeight, bestY + ih);
      totalItemArea += item.w * item.h;
      const extraY = item.rotation === 90 ? ROTATION_SAFETY : 0;
      const { nx, ny } = toNxNy(bestX + item.w / 2, bestY + item.h / 2 + extraY, item.w, item.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: item.rotation, overflows: false });

      const placed = { x: bestX, y: bestY, w: iw, h: ih };
      const newFree: FreeRect[] = [];
      for (const fr of freeRects) newFree.push(...subtractRect(fr, placed));
      freeRects = removeContainedRects(newFree);
    } else {
      const extraY = item.rotation === 90 ? ROTATION_SAFETY : 0;
      const { nx, ny } = toNxNy(item.w / 2, maxHeight + ih / 2 + extraY, item.w, item.h, abW, abH);
      result.push({ id: item.id, nx, ny, rotation: item.rotation, overflows: true });
      maxHeight += ih;
    }
  }

  const wastedArea = Math.max(0, usableW * maxHeight - totalItemArea);
  return { result, maxHeight, wastedArea };
}

/**
 * Shortest sheet that could hold `items` at all, whatever layout the packer arrives at.
 *
 * This exists so the expansion path can skip rungs of the height ladder instead of walking
 * it one at a time. Skipping is only safe if the rungs skipped are ones that provably
 * *cannot* work, so every term below is a lower bound that no legal arrangement can
 * undercut, and the weakest reading is always taken:
 *
 *   tallest    a design has to fit vertically, in whichever orientation is shortest.
 *   area       ink cannot overlap ink, so the total ink area needs `area / usableW` of film
 *              however cleverly it is nested. Gaps are ignored, which only weakens it.
 *   stacking   designs too wide to sit beside *each other* have to sit above one another,
 *              so their ink heights add. Width here is the narrowest inked scanline, not
 *              the bounding box: a shape can be nested alongside a neighbour wherever it is
 *              narrow, and only the narrowest row is true of it everywhere.
 *
 * Rotation is handled by taking each item's best case on both axes independently, which can
 * describe an orientation the packer would never choose — again, weaker and therefore safe.
 * Obstacles are ignored for the same reason: they only ever add ink.
 *
 * Being a lower bound is the whole contract. Returning too small a number costs an extra
 * pack; returning too large a one would sell the customer film they do not need.
 */
export function packingHeightLowerBound(
  items: Array<{ w: number; h: number; mask?: NestMask; noRotate?: boolean }>,
  usableW: number,
): number {
  if (items.length === 0 || !(usableW > 0)) return 0;

  let inkArea = 0;
  let tallest = 0;
  const spans: Array<{ minWidth: number; minHeight: number }> = [];
  for (const it of items) {
    if (!(it.w > 0) || !(it.h > 0)) continue;
    const p = inkProfile(it.mask, it.w, it.h);
    // Turning the design swaps which axis its scanlines run along: the ink height becomes
    // the ink width, and the per-scanline width becomes the per-column height.
    const minHeight = it.noRotate ? p.height : Math.min(p.height, p.width);
    const minWidth = it.noRotate ? p.minRowWidth : Math.min(p.minRowWidth, p.minColHeight);
    inkArea += p.area;
    if (minHeight > tallest) tallest = minHeight;
    spans.push({ minWidth, minHeight });
  }
  if (spans.length === 0) return 0;

  // Descending by width, so the two narrowest members of any prefix are its last two. Once
  // a prefix admits a pair that fits side by side, every longer prefix does too.
  spans.sort((a, b) => b.minWidth - a.minWidth);
  let running = spans[0].minHeight;
  let stacked = 0;
  for (let k = 1; k < spans.length; k++) {
    if (spans[k - 1].minWidth + spans[k].minWidth <= usableW + EPS) break;
    running += spans[k].minHeight;
    stacked = running;
  }

  return Math.max(tallest, inkArea / usableW, stacked);
}

/** True when `a` and `b` are closer than `gap`, i.e. placing both would break the spacing. */
function violatesGap(a: FixedRect, b: FixedRect, gap: number): boolean {
  return a.x < b.x + b.w + gap - EPS && a.x + a.w + gap > b.x + EPS &&
         a.y < b.y + b.h + gap - EPS && a.y + a.h + gap > b.y + EPS;
}

/**
 * Packs only what has to move. Every item that already has a legal position keeps it
 * exactly; the rest — new uploads, and anything whose current spot is off-sheet or too
 * close to a neighbour — is placed into whatever room is left.
 *
 * Anchors are considered top-to-bottom so that the part of the sheet the user has already
 * settled (in practice the top) wins any conflict, and a newcomer is what gives way.
 */
export function keepPositionsPack(
  items: Array<{ id: string; w: number; h: number; fill: number; noRotate?: boolean }>,
  current: CurrentRect[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
  gap: number,
  obstacles: FixedRect[] | undefined,
  /** Import placement passes false: a design arriving sideways on its own is startling. */
  allowRotation = true,
): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  const currentById = new Map(current.map(c => [c.id, c]));
  const anchoredRects: FixedRect[] = [];
  const result: PlacedItem[] = [];
  const floating: Array<{ id: string; w: number; h: number; fill: number; noRotate?: boolean }> = [];
  let overflowExtent = 0;

  const ordered = [...items].sort((a, b) => {
    const ca = currentById.get(a.id), cb = currentById.get(b.id);
    if (!ca) return cb ? 1 : 0;
    if (!cb) return -1;
    return ca.y - cb.y || ca.x - cb.x;
  });

  for (const item of ordered) {
    const c = currentById.get(item.id);
    if (!c) { floating.push(item); continue; }
    const inBounds = c.x >= -EPS && c.y >= -EPS &&
                     c.x + c.w <= usableW + EPS && c.y + c.h <= usableH + EPS;
    const clashes = anchoredRects.some(o => violatesGap(c, o, gap)) ||
                    (obstacles?.some(o => violatesGap(c, o, gap)) ?? false);
    if (!inBounds || clashes) { floating.push(item); continue; }
    anchoredRects.push({ x: c.x, y: c.y, w: c.w, h: c.h });
    const { nx, ny } = toNxNy(c.x + c.w / 2, c.y + c.h / 2, c.w, c.h, abW, abH);
    result.push({ id: item.id, nx, ny, rotation: c.rotation, overflows: false, anchored: true });
  }

  if (floating.length > 0) {
    const blocked = [...(obstacles ?? []), ...anchoredRects];
    // Largest first, and try each orientation, because the leftover room is fragmented and
    // a newcomer often only fits one way round.
    const order = [...floating].sort((a, b) =>
      Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h));
    let best: { result: PlacedItem[]; maxHeight: number; wastedArea: number } | null = null;
    let bestScore = Infinity;
    const orients = allowRotation
      ? (['normal', 'landscape', 'portrait'] as const)
      : (['normal'] as const);
    for (const orient of orients) {
      const packItems: PackItem[] = order.map(d => {
        let w = d.w, h = d.h, rot = 0;
        if (!d.noRotate) {
          if (orient === 'landscape' && h > w) { const t = w; w = h; h = t; rot = 90; }
          if (orient === 'portrait' && w > h) { const t = w; w = h; h = t; rot = 90; }
        }
        return { id: d.id, w, h, rotation: rot, gap, noRotate: d.noRotate };
      });
      for (const heuristic of ['bssf', 'baf'] as const) {
        const packed = maxRectsPack(packItems, usableW, usableH, abW, abH, heuristic, blocked, gap);
        const overflows = packed.result.filter(r => r.overflows).length;
        const score = overflows * 1e6 + packed.maxHeight;
        if (score < bestScore) { bestScore = score; best = packed; }
      }
    }
    if (best) {
      result.push(...best.result);
      // `ny` is clamped to the sheet, so measuring the placements below tops out at `abH`
      // and cannot say how far past the bottom edge an overflowing layout actually ran. The
      // sub-pack tracks that honestly, and the expansion path needs the honest number.
      overflowExtent = best.maxHeight;
    }
  }

  let maxHeight = overflowExtent;
  const dims = new Map(items.map(i => [i.id, i]));
  for (const p of result) {
    const it = dims.get(p.id);
    if (!it) continue;
    const h = p.anchored
      ? (currentById.get(p.id)?.h ?? it.h)
      : (p.rotation === 90 ? it.w : it.h);
    maxHeight = Math.max(maxHeight, p.ny * abH + h / 2);
  }
  const itemArea = items.reduce((sum, i) => sum + i.w * i.h, 0);
  return { result, maxHeight, wastedArea: Math.max(0, usableW * maxHeight - itemArea) };
}

function shelfPack(
  items: PackItem[],
  usableW: number,
  usableH: number,
  abW: number,
  abH: number,
): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  const result: PlacedItem[] = [];
  let curY = 0, curX = 0, shelfH = 0;
  let totalItemArea = 0;

  for (const item of items) {
    const g = item.gap;
    const iw = item.w + g;
    const ih = item.h + g;

    if (curX + iw > usableW + EPS) {
      curY += shelfH + g;
      curX = 0;
      shelfH = 0;
    }

    shelfH = Math.max(shelfH, ih);
    const overflows = curX + iw > usableW + EPS || curY + ih > usableH + EPS;
    totalItemArea += item.w * item.h;

    const extraY = item.rotation === 90 ? ROTATION_SAFETY : 0;
    const absCx = curX + item.w / 2, absCy = curY + item.h / 2 + extraY;
    const { nx, ny } = toNxNy(absCx, absCy, item.w, item.h, abW, abH);
    result.push({ id: item.id, nx, ny, rotation: item.rotation, overflows });
    curX += iw;
  }

  const maxHeight = curY + shelfH;
  const wastedArea = Math.max(0, usableW * maxHeight - totalItemArea);
  return { result, maxHeight, wastedArea };
}

export function runArrange(input: ArrangeInput) {
  const { items, usableW, usableH, artboardWidth, artboardHeight, customGap, fixedRects,
          current, preferStable, heightSteps } = input;
  const hasCustomGap = customGap !== undefined && customGap >= 0;
  const GAP = hasCustomGap ? customGap : 0.25;

  const getItemGap = (_fill: number): number => GAP;

  const itemById = new Map(items.map(i => [i.id, i]));
  const currentById = new Map((current ?? []).map(c => [c.id, c]));
  const hasMasks = items.some(i => i.mask);

  /**
   * Bottom edge of the lowest ink in a layout. Rectangle packers and the nester have to be
   * ranked on the same yardstick, and the honest one is where the printable artwork ends —
   * measuring bounding boxes would credit the nester for overlapping empty corners and
   * penalise it for footprints that legitimately hang off the sheet.
   */
  const filmBottom = (placed: PlacedItem[]): number => {
    let bottom = 0;
    for (const p of placed) {
      const it = itemById.get(p.id);
      if (!it) continue;
      const anchored = p.anchored ? currentById.get(p.id) : undefined;
      const fh = anchored ? anchored.h : (p.rotation === 90 ? it.w : it.h);
      const inset = inkInset(it.mask, it.w, it.h, p.rotation);
      bottom = Math.max(bottom, p.ny * artboardHeight + fh / 2 - inset.bottom);
    }
    return bottom;
  };

  /**
   * Height of the ink's centre of mass. Used to separate layouts that tie on film height,
   * which happens whenever one tall design sets the height on its own: every arrangement of
   * everything else is then free as far as film height is concerned, and without a second
   * yardstick the winner among them is arbitrary. Pulling the centre of mass up keeps the
   * small work interlocked near the top and leaves the space below it whole, which is both
   * what nesting is for and what the next few designs need.
   */
  const inkCentroidY = (placed: PlacedItem[]): number => {
    let weight = 0, moment = 0;
    for (const p of placed) {
      const it = itemById.get(p.id);
      if (!it) continue;
      // `fill` is the design's ink ratio, so this weights by ink rather than by footprint —
      // otherwise a sparse design would pull as hard as a solid one of the same size.
      const area = Math.max(it.w * it.h * (it.fill > 0 ? it.fill : 1), 1e-6);
      weight += area;
      moment += area * p.ny * artboardHeight;
    }
    return weight > 0 ? moment / weight : 0;
  };

  const evaluate = (pack: { result: PlacedItem[]; maxHeight: number; wastedArea: number }): Candidate => ({
    ...pack,
    overflows: pack.result.filter(r => r.overflows).length,
    filmHeight: filmBottom(pack.result),
  });

  const makePackItems = (order: typeof items, orient: 'normal' | 'landscape' | 'portrait', gapOverride?: number): PackItem[] =>
    order.map(d => {
      const g = gapOverride !== undefined ? gapOverride : getItemGap(d.fill);
      let w = d.w, h = d.h, rot = 0;
      if (!d.noRotate) {
        if (orient === 'landscape' && h > w) { const tmp = w; w = h; h = tmp; rot = 90; }
        if (orient === 'portrait' && w > h) { const tmp = w; w = h; h = tmp; rot = 90; }
      }
      return { id: d.id, w, h, rotation: rot, gap: g, noRotate: d.noRotate };
    });

  const byWidth = [...items].sort((a, b) => b.w - a.w || b.h - a.h);
  const byHeight = [...items].sort((a, b) => Math.max(b.h, b.w) - Math.max(a.h, a.w) || (b.w * b.h) - (a.w * a.h));
  const byArea = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const byPerimeter = [...items].sort((a, b) => (b.w + b.h) - (a.w + a.h));
  const byEmptySpace = [...items].sort((a, b) => a.fill - b.fill || (b.w * b.h) - (a.w * a.h));
  const byAspectRatio = [...items].sort((a, b) => (b.w / Math.max(b.h, 0.01)) - (a.w / Math.max(a.h, 0.01)));
  const byLongestSide = [...items].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || (b.w * b.h) - (a.w * a.h));
  const byAreaAsc = [...items].sort((a, b) => (a.w * a.h) - (b.w * b.h));
  const alternating: typeof items = [];
  for (let lo = 0, hi = byArea.length - 1; lo <= hi;) {
    alternating.push(byArea[lo++]);
    if (lo <= hi) alternating.push(byArea[hi--]);
  }

  const sortOrders = [byWidth, byHeight, byArea, byPerimeter, byEmptySpace, byAspectRatio, byLongestSide, alternating, byAreaAsc];

  /**
   * Above this many designs the nester is skipped. It scales roughly with sheet area times
   * item count, and past a few hundred designs the rectangle packers are both fast and
   * close to optimal anyway, because at that size the sheet is dominated by items that tile
   * rather than interlock.
   */
  const NEST_ITEM_LIMIT = 300;

  const toNestItems = (order: typeof items): NestItem[] =>
    order.map(d => ({ id: d.id, w: d.w, h: d.h, mask: d.mask, noRotate: d.noRotate }));

  const runNestCandidates = (): Candidate[] => {
    if (!hasMasks || items.length > NEST_ITEM_LIMIT) return [];
    const obstacles: NestObstacle[] | undefined = fixedRects;
    // Three orderings is the point of diminishing returns: longest-side-first wins most
    // sheets, and area/perimeter occasionally beat it when a few big pieces dominate.
    const orders: Array<[string, typeof items]> = [
      ['longestSide', byLongestSide], ['area', byArea], ['perimeter', byPerimeter],
    ];
    return orders.map(([name, order]) => {
      const c = evaluate(nestPack(
        toNestItems(order), usableW, usableH, artboardWidth, artboardHeight, GAP, obstacles,
      ));
      (c as any)._algo = `nest_${name}`;
      return c;
    });
  };

  const runCandidatesWithObstacles = (gapOverride?: number): Candidate[] => {
    const cands: Candidate[] = [];
    const g = gapOverride !== undefined ? gapOverride : GAP;
    for (const order of sortOrders) {
      const normalPi = makePackItems(order, 'normal', gapOverride);
      cands.push(evaluate(maxRectsPack(normalPi, usableW, usableH, artboardWidth, artboardHeight, 'bssf', fixedRects, g)));
      cands.push(evaluate(maxRectsPack(normalPi, usableW, usableH, artboardWidth, artboardHeight, 'baf', fixedRects, g)));
      cands.push(evaluate(maxRectsPack(makePackItems(order, 'landscape', gapOverride), usableW, usableH, artboardWidth, artboardHeight, 'bssf', fixedRects, g)));
      cands.push(evaluate(maxRectsPack(makePackItems(order, 'portrait', gapOverride), usableW, usableH, artboardWidth, artboardHeight, 'bssf', fixedRects, g)));
    }
    return cands;
  };

  const runCandidates = (gapOverride?: number): (Candidate & { _algo?: string })[] => {
    const cands: (Candidate & { _algo?: string })[] = [];
    const g = gapOverride !== undefined ? gapOverride : GAP;
    for (let oi = 0; oi < sortOrders.length; oi++) {
      const order = sortOrders[oi];
      const normalPi = makePackItems(order, 'normal', gapOverride);
      const sl = evaluate(skylinePack(normalPi, usableW, usableH, artboardWidth, artboardHeight)); (sl as any)._algo = `skyline_${oi}`; cands.push(sl);

      const greedyItems = order.map(d => ({
        id: d.id, w: d.w, h: d.h,
        gap: gapOverride !== undefined ? gapOverride : getItemGap(d.fill),
        noRotate: d.noRotate,
      }));
      const go = evaluate(greedyOrientPack(greedyItems, usableW, usableH, artboardWidth, artboardHeight)); (go as any)._algo = `greedy_${oi}`; cands.push(go);

      const mo = evaluate(mixedOrientPack(normalPi, usableW, usableH, artboardWidth, artboardHeight)); (mo as any)._algo = `mixed_${oi}`; cands.push(mo);

      const mr1 = evaluate(maxRectsPack(normalPi, usableW, usableH, artboardWidth, artboardHeight, 'bssf')); (mr1 as any)._algo = `maxRects_bssf_${oi}`; cands.push(mr1);
      const mr2 = evaluate(maxRectsPack(normalPi, usableW, usableH, artboardWidth, artboardHeight, 'baf')); (mr2 as any)._algo = `maxRects_baf_${oi}`; cands.push(mr2);

      const sh = evaluate(shelfPack(normalPi, usableW, usableH, artboardWidth, artboardHeight)); (sh as any)._algo = `shelf_${oi}`; cands.push(sh);

      const slL = evaluate(skylinePack(makePackItems(order, 'landscape', gapOverride), usableW, usableH, artboardWidth, artboardHeight)); (slL as any)._algo = `skyline_landscape_${oi}`; cands.push(slL);
      const slP = evaluate(skylinePack(makePackItems(order, 'portrait', gapOverride), usableW, usableH, artboardWidth, artboardHeight)); (slP as any)._algo = `skyline_portrait_${oi}`; cands.push(slP);
    }

    const gridResult = gridPack(items, g, usableW, usableH, artboardWidth, artboardHeight);
    if (gridResult) { const gr = evaluate(gridResult); (gr as any)._algo = 'grid'; cands.push(gr); }

    return cands;
  };

  const candidates: Candidate[] = [
    ...(fixedRects && fixedRects.length > 0
      ? (hasCustomGap ? runCandidatesWithObstacles() : [...runCandidatesWithObstacles(), ...runCandidatesWithObstacles(0.125), ...runCandidatesWithObstacles(0.0625)])
      : (hasCustomGap
        ? [...runCandidates()]
        : [
            ...runCandidates(),
            ...runCandidates(0.125),
            ...runCandidates(0.0625),
          ])),
    ...runNestCandidates(),
  ];

  // Fewer overflows, then fit within the artboard, then the shortest film, then the most
  // compact arrangement of everything that ties on film length.
  //
  // Utilisation used to sit between "fits" and film height, but it is `totalItemArea /
  // (usableW * filmHeight)` — with the first two terms constant across candidates it ranks
  // identically to film height, just with a coarser dead-band, so it only ever blurred the
  // comparison it duplicated.
  //
  // The tiebreak used to be each packer's self-reported `wastedArea`, which is not
  // comparable between algorithms: the rectangle packers subtract footprint area while the
  // nester subtracts *ink* area, so on identical film height the nester reports roughly the
  // shapes' empty margins as extra waste and always loses. That put a thumb on the scale
  // against nesting in exactly the case where film height cannot separate the candidates —
  // when one big design sets the length by itself and the rest are free.
  candidates.sort((a, b) => {
    if (a.overflows !== b.overflows) return a.overflows - b.overflows;
    const aFits = a.filmHeight <= usableH ? 0 : 1;
    const bFits = b.filmHeight <= usableH ? 0 : 1;
    if (aFits !== bFits) return aFits - bFits;
    if (Math.abs(a.filmHeight - b.filmHeight) > EPS) return a.filmHeight - b.filmHeight;
    return inkCentroidY(a.result) - inkCentroidY(b.result);
  });

  if (DEBUG_RANK) {
    console.debug('[arrange] ranking (top 10 of ' + candidates.length + ')');
    for (const c of candidates.slice(0, 10)) {
      console.debug(
        '  ' + ((c as any)._algo ?? 'obstacle_variant').padEnd(24),
        'film', c.filmHeight.toFixed(2),
        'centroid', inkCentroidY(c.result).toFixed(2),
        'wasted', c.wastedArea.toFixed(1),
        'overflows', c.overflows,
      );
    }
  }

  const winner = candidates[0];
  if (DEBUG_OVERLAP && winner.result.some(r => r.rotation !== 0)) {
    console.debug('[arrange] winner with rotation', (winner as any)._algo, winner.result.length, winner.result.map(r => ({ id: r.id.slice(0, 8), nx: r.nx.toFixed(4), ny: r.ny.toFixed(4), rot: r.rotation })));
  }

  /**
   * What the caller needs to size the sheet, bolted onto whichever candidate wins.
   *
   * `packedExtent` is how far down the film this layout actually ran, overflowing items
   * included — the placements themselves cannot say, because their `ny` is clamped to the
   * sheet. It is a description of one layout, not a requirement: an overflowing pack piles
   * everything it could not place into its own full-width row, so the extent routinely
   * overstates what a taller sheet would really need. Sizing off it directly is what would
   * buy the customer film they do not need, which is why the expansion path sizes off
   * `minRequiredHeight` and treats this as diagnostic.
   */
  const describe = (chosen: Candidate) => ({
    ...chosen,
    packedExtent: Math.max(chosen.maxHeight, chosen.filmHeight),
    minRequiredHeight: packingHeightLowerBound(items, usableW),
  });

  if (!current || current.length === 0) return describe(winner);

  // With silhouettes in play, settled designs routinely have overlapping bounding boxes —
  // that is what nesting means — so the rectangle-based version of this would demote almost
  // all of them as clashing and stability would evaporate.
  const stable = hasMasks
    ? evaluate(keepPositionsNest(
        toNestItems(items), current, usableW, usableH, artboardWidth, artboardHeight, GAP,
        fixedRects))
    : evaluate(keepPositionsPack(
        items, current, usableW, usableH, artboardWidth, artboardHeight, GAP, fixedRects));

  // What the customer actually pays for is the next sheet length up, so a repack that
  // shaves an inch off but lands on the same purchasable height has bought nothing and
  // is not worth relocating settled designs for.
  const billable = (h: number): number =>
    heightSteps?.find(step => step >= h - EPS) ?? h;

  if (stable.overflows > winner.overflows) return describe(winner);

  if (preferStable) {
    return describe(billable(winner.filmHeight) < billable(stable.filmHeight) - EPS ? winner : stable);
  }

  // An explicit Auto-Arrange is a licence to move things, not a licence to make them worse.
  // Packing from scratch is usually the shorter answer, but a layout the customer built up
  // one import at a time can already be better than anything the from-scratch orderings
  // find, and this path used to overwrite it regardless. It still repacks whenever the new
  // layout ties, so pressing the button on an already-good sheet visibly does something.
  return describe(billable(winner.filmHeight) > billable(stable.filmHeight) + EPS ? stable : winner);
}
