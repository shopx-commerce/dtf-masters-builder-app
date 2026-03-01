type SkylineSeg = { x: number; y: number; w: number };
type PackItem = { id: string; w: number; h: number; rotation: number; gap: number };
type PlacedItem = { id: string; nx: number; ny: number; rotation: number; overflows: boolean };
type Candidate = { result: PlacedItem[]; maxHeight: number; wastedArea: number; overflows: number };

interface FixedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ArrangeInput {
  type: 'arrange';
  requestId: number;
  items: Array<{ id: string; w: number; h: number; fill: number }>;
  usableW: number;
  usableH: number;
  artboardWidth: number;
  artboardHeight: number;
  isAggressive: boolean;
  customGap?: number;
  fixedRects?: FixedRect[];
}

const EPS = 0.01;
const DEBUG_OVERLAP = false; // Set true to log when rotation is used (for overlap debugging)
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

function greedyOrientPack(sortedItems: Array<{ id: string; w: number; h: number; gap: number }>, usableW: number, usableH: number, abW: number, abH: number): { result: PlacedItem[]; maxHeight: number; wastedArea: number } {
  let sky: SkylineSeg[] = [{ x: 0, y: 0, w: usableW }];
  const result: PlacedItem[] = [];
  let totalWaste = 0;

  for (const item of sortedItems) {
    const g = item.gap;
    const orientations: Array<{ w: number; h: number; rot: number }> = [
      { w: item.w, h: item.h, rot: 0 },
    ];
    if (Math.abs(item.w - item.h) > 0.1) {
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
  items: Array<{ id: string; w: number; h: number; fill: number }>,
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
  if (isSquarish) return normalGrid;

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
    if (item.w > halfW && item.h < item.w && item.h <= halfW) {
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
  const newFree: FreeRect[] = [];
  // Left strip (full height)
  if (placed.x > from.x + EPS)
    newFree.push({ x: from.x, y: from.y, w: placed.x - from.x, h: from.h });
  // Right strip (full height)
  if (placed.x + placed.w < from.x + from.w - EPS)
    newFree.push({ x: placed.x + placed.w, y: from.y, w: from.x + from.w - placed.x - placed.w, h: from.h });
  // Top strip (directly above placed, between left/right strips to avoid overlap)
  if (placed.y > from.y + EPS)
    newFree.push({ x: placed.x, y: from.y, w: placed.w, h: placed.y - from.y });
  // Bottom strip (directly below placed)
  if (placed.y + placed.h < from.y + from.h - EPS)
    newFree.push({ x: placed.x, y: placed.y + placed.h, w: placed.w, h: from.y + from.h - placed.y - placed.h });
  return newFree;
}

function removeContainedRects(rects: FreeRect[]): FreeRect[] {
  const result: FreeRect[] = [];
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.w < 0.01 || r.h < 0.01) continue;
    let contained = false;
    for (let j = 0; j < rects.length; j++) {
      if (i === j) continue;
      const o = rects[j];
      if (r.x >= o.x - EPS && r.y >= o.y - EPS &&
          r.x + r.w <= o.x + o.w + EPS && r.y + r.h <= o.y + o.h + EPS) {
        contained = true;
        break;
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
      for (const fr of freeRects) {
        if (placed.x >= fr.x + fr.w - EPS || placed.x + placed.w <= fr.x + EPS ||
            placed.y >= fr.y + fr.h - EPS || placed.y + placed.h <= fr.y + EPS) {
          newFree.push(fr);
          continue;
        }
        if (placed.x > fr.x + EPS)
          newFree.push({ x: fr.x, y: fr.y, w: placed.x - fr.x, h: fr.h });
        if (placed.x + placed.w < fr.x + fr.w - EPS)
          newFree.push({ x: placed.x + placed.w, y: fr.y, w: fr.x + fr.w - placed.x - placed.w, h: fr.h });
        if (placed.y > fr.y + EPS)
          newFree.push({ x: placed.x, y: fr.y, w: placed.w, h: placed.y - fr.y });
        if (placed.y + placed.h < fr.y + fr.h - EPS)
          newFree.push({ x: placed.x, y: placed.y + placed.h, w: placed.w, h: fr.y + fr.h - placed.y - placed.h });
      }
      freeRects = [];
      for (let i = 0; i < newFree.length; i++) {
        if (newFree[i].w < 0.01 || newFree[i].h < 0.01) continue;
        let contained = false;
        for (let j = 0; j < newFree.length; j++) {
          if (i === j) continue;
          if (newFree[i].x >= newFree[j].x - EPS && newFree[i].y >= newFree[j].y - EPS &&
              newFree[i].x + newFree[i].w <= newFree[j].x + newFree[j].w + EPS &&
              newFree[i].y + newFree[i].h <= newFree[j].y + newFree[j].h + EPS) {
            contained = true;
            break;
          }
        }
        if (!contained) freeRects.push(newFree[i]);
      }
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

function runArrange(input: ArrangeInput) {
  const { items, usableW, usableH, artboardWidth, artboardHeight, customGap, fixedRects } = input;
  const hasCustomGap = customGap !== undefined && customGap >= 0;
  const GAP = hasCustomGap ? customGap : 0.25;

  const getItemGap = (_fill: number): number => GAP;

  const evaluate = (pack: { result: PlacedItem[]; maxHeight: number; wastedArea: number }): Candidate => ({
    ...pack,
    overflows: pack.result.filter(r => r.overflows).length,
  });

  const makePackItems = (order: typeof items, orient: 'normal' | 'landscape' | 'portrait', gapOverride?: number): PackItem[] =>
    order.map(d => {
      const g = gapOverride !== undefined ? gapOverride : getItemGap(d.fill);
      let w = d.w, h = d.h, rot = 0;
      if (orient === 'landscape' && h > w) { const tmp = w; w = h; h = tmp; rot = 90; }
      if (orient === 'portrait' && w > h) { const tmp = w; w = h; h = tmp; rot = 90; }
      return { id: d.id, w, h, rotation: rot, gap: g };
    });

  const totalItemArea = items.reduce((sum, d) => sum + d.w * d.h, 0);

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

  const candidates: Candidate[] = fixedRects && fixedRects.length > 0
    ? (hasCustomGap ? runCandidatesWithObstacles() : [...runCandidatesWithObstacles(), ...runCandidatesWithObstacles(0.125), ...runCandidatesWithObstacles(0.0625)])
    : (hasCustomGap
      ? [...runCandidates()]
      : [
          ...runCandidates(),
          ...runCandidates(0.125),
          ...runCandidates(0.0625),
        ]);

  candidates.sort((a, b) => {
    if (a.overflows !== b.overflows) return a.overflows - b.overflows;
    const aFits = a.maxHeight <= usableH ? 0 : 1;
    const bFits = b.maxHeight <= usableH ? 0 : 1;
    if (aFits !== bFits) return aFits - bFits;
    const aUtil = totalItemArea / (usableW * Math.max(a.maxHeight, 0.01));
    const bUtil = totalItemArea / (usableW * Math.max(b.maxHeight, 0.01));
    if (Math.abs(aUtil - bUtil) > 0.02) return bUtil - aUtil;
    if (Math.abs(a.maxHeight - b.maxHeight) > 0.01) return a.maxHeight - b.maxHeight;
    return a.wastedArea - b.wastedArea;
  });

  const winner = candidates[0];
  if (DEBUG_OVERLAP && winner.result.some(r => r.rotation !== 0)) {
    console.debug('[arrange] winner with rotation', (winner as any)._algo, winner.result.length, winner.result.map(r => ({ id: r.id.slice(0, 8), nx: r.nx.toFixed(4), ny: r.ny.toFixed(4), rot: r.rotation })));
  }
  return winner;
}

self.onmessage = function(e: MessageEvent) {
  try {
    if (e.data.type === 'arrange') {
      const result = runArrange(e.data);
      self.postMessage({ type: 'result', requestId: e.data.requestId, ...result });
    }
  } catch (err) {
    self.postMessage({ type: 'error', requestId: e.data?.requestId, error: String(err) });
  }
};
