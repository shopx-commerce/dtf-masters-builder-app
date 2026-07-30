interface Point {
  x: number;
  y: number;
}

type SnappedPath =
  | { type: 'circle'; cx: number; cy: number; r: number }
  | { type: 'rectangle'; corners: [Point, Point, Point, Point] }
  | { type: 'rounded-rect'; corners: [Point, Point, Point, Point]; radius: number }
  | null;

function computePolygonArea(pts: Point[]): number {
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return Math.abs(area) / 2;
}

function computePerimeter(pts: Point[]): number {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    const dx = pts[j].x - pts[i].x;
    const dy = pts[j].y - pts[i].y;
    p += Math.sqrt(dx * dx + dy * dy);
  }
  return p;
}

function boundingBox(pts: Point[]): { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function percentile(values: number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor(pct / 100 * (sorted.length - 1));
  return sorted[idx];
}

function fitCircleKasa(pts: Point[]): { cx: number; cy: number; r: number } {
  const n = pts.length;
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0;
  let sumX3 = 0, sumY3 = 0, sumX2Y = 0, sumXY2 = 0;

  for (const p of pts) {
    sumX += p.x; sumY += p.y;
    sumX2 += p.x * p.x; sumY2 += p.y * p.y;
    sumXY += p.x * p.y;
    sumX3 += p.x * p.x * p.x; sumY3 += p.y * p.y * p.y;
    sumX2Y += p.x * p.x * p.y; sumXY2 += p.x * p.y * p.y;
  }

  const A = n * sumX2 - sumX * sumX;
  const B = n * sumXY - sumX * sumY;
  const C = n * sumY2 - sumY * sumY;
  const D = 0.5 * (n * sumX3 + n * sumXY2 - sumX * sumX2 - sumX * sumY2);
  const E = 0.5 * (n * sumX2Y + n * sumY3 - sumY * sumX2 - sumY * sumY2);

  const denom = A * C - B * B;
  if (Math.abs(denom) < 1e-12) {
    const cx = sumX / n;
    const cy = sumY / n;
    return { cx, cy, r: 0 };
  }

  const cx = (D * C - B * E) / denom;
  const cy = (A * E - B * D) / denom;
  const r = Math.sqrt((sumX2 - 2 * cx * sumX + n * cx * cx + sumY2 - 2 * cy * sumY + n * cy * cy) / n);

  return { cx, cy, r };
}

function trySnapCircle(pts: Point[], imageW: number, imageH: number): SnappedPath {
  if (pts.length < 40) return null;

  const area = computePolygonArea(pts);
  const perim = computePerimeter(pts);
  const imageArea = imageW * imageH;

  if (area < 0.02 * imageArea) return null;

  const bb = boundingBox(pts);
  const aspect = bb.w / bb.h;
  if (aspect < 0.88 || aspect > 1.12) return null;

  const circularity = (4 * Math.PI * area) / (perim * perim);
  if (circularity < 0.90) return null;

  const { cx, cy, r } = fitCircleKasa(pts);
  if (r < 0.05 * Math.min(imageW, imageH)) return null;

  const distances = pts.map(p => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return Math.abs(Math.sqrt(dx * dx + dy * dy) - r);
  });

  const rmse = Math.sqrt(distances.reduce((s, d) => s + d * d, 0) / distances.length);
  const p95 = percentile(distances, 95);

  const radii = pts.map(p => Math.sqrt((p.x - cx) ** 2 + (p.y - cy) ** 2));
  const meanR = radii.reduce((s, v) => s + v, 0) / radii.length;
  const radStd = Math.sqrt(radii.reduce((s, v) => s + (v - meanR) ** 2, 0) / radii.length) / r;

  const p95Thresh = Math.max(0.005, 0.004 * r);
  const rmseThresh = Math.max(0.0023, 0.002 * r);

  if (p95 > p95Thresh || rmse > rmseThresh || radStd > 0.006) return null;

  const angles = pts.map(p => Math.atan2(p.y - cy, p.x - cx));
  const sortedAngles = [...angles].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < sortedAngles.length; i++) {
    maxGap = Math.max(maxGap, sortedAngles[i] - sortedAngles[i - 1]);
  }
  maxGap = Math.max(maxGap, (sortedAngles[0] + 2 * Math.PI) - sortedAngles[sortedAngles.length - 1]);
  const angleSpan = 360 - (maxGap * 180 / Math.PI);

  if (angleSpan < 330) return null;

  console.log(`[PrimitiveSnap] Circle detected: cx=${cx.toFixed(2)}, cy=${cy.toFixed(2)}, r=${r.toFixed(2)}, rmse=${rmse.toFixed(3)}, p95=${p95.toFixed(3)}, radStd=${radStd.toFixed(5)}, span=${angleSpan.toFixed(1)}°`);

  return { type: 'circle', cx, cy, r };
}

function rdpSimplify(pts: Point[], epsilon: number): Point[] {
  if (pts.length <= 2) return pts;

  let maxDist = 0;
  let maxIdx = 0;
  const start = pts[0];
  const end = pts[pts.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lenSq = dx * dx + dy * dy;

  for (let i = 1; i < pts.length - 1; i++) {
    let dist: number;
    if (lenSq === 0) {
      dist = Math.sqrt((pts[i].x - start.x) ** 2 + (pts[i].y - start.y) ** 2);
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - start.x) * dx + (pts[i].y - start.y) * dy) / lenSq));
      const projX = start.x + t * dx;
      const projY = start.y + t * dy;
      dist = Math.sqrt((pts[i].x - projX) ** 2 + (pts[i].y - projY) ** 2);
    }
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(pts.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(pts.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

function turningAngle(a: Point, b: Point, c: Point): number {
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const dot = v1x * v2x + v1y * v2y;
  const cross = v1x * v2y - v1y * v2x;
  return Math.atan2(cross, dot);
}

function pointToLineDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.sqrt((p.x - (a.x + t * dx)) ** 2 + (p.y - (a.y + t * dy)) ** 2);
}

function trySnapRectangle(pts: Point[], imageW: number, imageH: number): SnappedPath {
  if (pts.length < 20) return null;

  const area = computePolygonArea(pts);
  const imageArea = imageW * imageH;
  if (area < 0.02 * imageArea) return null;

  const simplified = rdpSimplify(pts, 0.007);
  if (simplified.length < 4) return null;

  const n = simplified.length;
  const angles: { idx: number; angle: number }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = simplified[(i - 1 + n) % n];
    const curr = simplified[i];
    const next = simplified[(i + 1) % n];
    const angle = Math.abs(turningAngle(prev, curr, next));
    if (angle > Math.PI * 70 / 180 && angle < Math.PI * 110 / 180) {
      angles.push({ idx: i, angle });
    }
  }

  if (angles.length < 4) return null;

  angles.sort((a, b) => b.angle - a.angle);
  const cornerIndices: number[] = [];

  for (const a of angles) {
    let tooClose = false;
    for (const ci of cornerIndices) {
      const idxDiff = Math.min(Math.abs(a.idx - ci), n - Math.abs(a.idx - ci));
      if (idxDiff < n * 0.1) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      cornerIndices.push(a.idx);
      if (cornerIndices.length === 4) break;
    }
  }

  if (cornerIndices.length !== 4) return null;

  cornerIndices.sort((a, b) => a - b);
  const corners = cornerIndices.map(i => simplified[i]);

  for (let i = 0; i < 4; i++) {
    const prev = corners[(i - 1 + 4) % 4];
    const curr = corners[i];
    const next = corners[(i + 1) % 4];
    const angle = Math.abs(turningAngle(prev, curr, next)) * 180 / Math.PI;
    if (angle < 75 || angle > 105) return null;
  }

  for (let i = 0; i < 4; i++) {
    const startIdx = cornerIndices[i];
    const endIdx = cornerIndices[(i + 1) % 4];
    const a = simplified[startIdx];
    const b = simplified[endIdx];

    let maxDev = 0;
    let j = (startIdx + 1) % n;
    while (j !== endIdx) {
      const dev = pointToLineDist(simplified[j], a, b);
      if (dev > maxDev) maxDev = dev;
      j = (j + 1) % n;
    }

    const sideLen = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
    const threshold = Math.max(0.005, 0.003 * sideLen);
    if (maxDev > threshold) return null;
  }

  console.log(`[PrimitiveSnap] Rectangle detected: corners at (${corners.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(') (')})`);

  return {
    type: 'rectangle',
    corners: corners as [Point, Point, Point, Point]
  };
}

export function primitiveSnap(path: Point[], imageW: number, imageH: number): SnappedPath {
  const circle = trySnapCircle(path, imageW, imageH);
  if (circle) return circle;

  const rect = trySnapRectangle(path, imageW, imageH);
  if (rect) return rect;

  return null;
}

const KAPPA = 0.5522847498307936;

export function circleToPathPDFOps(cx: number, cy: number, r: number): string {
  const k = r * KAPPA;
  let ops = '';
  ops += `${(cx + r).toFixed(4)} ${cy.toFixed(4)} m\n`;
  ops += `${(cx + r).toFixed(4)} ${(cy + k).toFixed(4)} ${(cx + k).toFixed(4)} ${(cy + r).toFixed(4)} ${cx.toFixed(4)} ${(cy + r).toFixed(4)} c\n`;
  ops += `${(cx - k).toFixed(4)} ${(cy + r).toFixed(4)} ${(cx - r).toFixed(4)} ${(cy + k).toFixed(4)} ${(cx - r).toFixed(4)} ${cy.toFixed(4)} c\n`;
  ops += `${(cx - r).toFixed(4)} ${(cy - k).toFixed(4)} ${(cx - k).toFixed(4)} ${(cy - r).toFixed(4)} ${cx.toFixed(4)} ${(cy - r).toFixed(4)} c\n`;
  ops += `${(cx + k).toFixed(4)} ${(cy - r).toFixed(4)} ${(cx + r).toFixed(4)} ${(cy - k).toFixed(4)} ${(cx + r).toFixed(4)} ${cy.toFixed(4)} c\n`;
  ops += 'h\n';
  return ops;
}

export function rectangleToPathPDFOps(corners: [Point, Point, Point, Point]): string {
  let ops = '';
  ops += `${corners[0].x.toFixed(4)} ${corners[0].y.toFixed(4)} m\n`;
  for (let i = 1; i < 4; i++) {
    ops += `${corners[i].x.toFixed(4)} ${corners[i].y.toFixed(4)} l\n`;
  }
  ops += 'h\n';
  return ops;
}
