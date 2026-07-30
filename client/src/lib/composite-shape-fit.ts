type Point = { x: number; y: number };

interface EllipseParams {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
}

interface FitResult {
  path: Point[];
  fitted: boolean;
}

function computeSmoothedCurvatures(points: Point[], windowHalf: number): number[] {
  const n = points.length;
  const curvatures: number[] = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    const prev = points[(i - windowHalf + n) % n];
    const curr = points[i];
    const next = points[(i + windowHalf) % n];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const cross = dx1 * dy2 - dy1 * dx2;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    const denom = len1 * len2;

    if (denom > 1e-10) {
      curvatures[i] = cross / denom;
    }
  }

  return curvatures;
}

function findContiguousRuns(
  isInGroup: boolean[],
  totalLen: number
): Array<{ start: number; end: number; indices: number[] }> {
  const runs: Array<{ start: number; end: number; indices: number[] }> = [];

  let startSearch = -1;
  for (let i = 0; i < totalLen; i++) {
    if (!isInGroup[i]) { startSearch = i; break; }
  }
  if (startSearch === -1) {
    if (isInGroup[0]) {
      return [{ start: 0, end: totalLen - 1, indices: Array.from({ length: totalLen }, (_, i) => i) }];
    }
    return [];
  }

  let inRun = false;
  let runStart = 0;
  let currentIndices: number[] = [];

  for (let offset = 0; offset < totalLen; offset++) {
    const i = (startSearch + offset) % totalLen;
    if (isInGroup[i]) {
      if (!inRun) {
        inRun = true;
        runStart = i;
        currentIndices = [];
      }
      currentIndices.push(i);
    } else {
      if (inRun) {
        runs.push({ start: runStart, end: currentIndices[currentIndices.length - 1], indices: currentIndices });
        inRun = false;
      }
    }
  }
  if (inRun) {
    runs.push({ start: runStart, end: currentIndices[currentIndices.length - 1], indices: currentIndices });
  }

  return runs;
}

function pcaEllipseFit(points: Point[]): EllipseParams | null {
  if (points.length < 5) return null;

  const n = points.length;
  let sumX = 0, sumY = 0;
  for (const p of points) { sumX += p.x; sumY += p.y; }
  const cx = sumX / n;
  const cy = sumY / n;

  let cov00 = 0, cov01 = 0, cov11 = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    cov00 += dx * dx;
    cov01 += dx * dy;
    cov11 += dy * dy;
  }
  cov00 /= n;
  cov01 /= n;
  cov11 /= n;

  const trace = cov00 + cov11;
  const det = cov00 * cov11 - cov01 * cov01;
  const disc = trace * trace / 4 - det;
  if (disc < 0) return null;

  const sqrtDisc = Math.sqrt(disc);
  const lambda1 = trace / 2 + sqrtDisc;
  const lambda2 = trace / 2 - sqrtDisc;

  if (lambda1 <= 0 || lambda2 <= 0) return null;

  const rotation = 0.5 * Math.atan2(2 * cov01, cov00 - cov11);

  const rx = Math.sqrt(lambda1) * 2;
  const ry = Math.sqrt(lambda2) * 2;

  if (isNaN(rx) || isNaN(ry) || rx < 1 || ry < 1) return null;
  if (rx / ry > 10 || ry / rx > 10) return null;

  return { cx, cy, rx, ry, rotation };
}

function refineEllipseRadii(ellipse: EllipseParams, points: Point[]): EllipseParams {
  const cosR = Math.cos(-ellipse.rotation);
  const sinR = Math.sin(-ellipse.rotation);

  let sumRatioX = 0, sumRatioY = 0;
  let countX = 0, countY = 0;

  for (const p of points) {
    const dx = p.x - ellipse.cx;
    const dy = p.y - ellipse.cy;
    const lx = dx * cosR - dy * sinR;
    const ly = dx * sinR + dy * cosR;
    const angle = Math.atan2(ly, lx);
    const dist = Math.sqrt(lx * lx + ly * ly);
    const expectedDist = Math.sqrt(
      (ellipse.rx * Math.cos(angle)) ** 2 + (ellipse.ry * Math.sin(angle)) ** 2
    );

    if (expectedDist > 1) {
      const ratio = dist / expectedDist;
      const cosWeight = Math.abs(Math.cos(angle));
      const sinWeight = Math.abs(Math.sin(angle));
      sumRatioX += ratio * cosWeight;
      sumRatioY += ratio * sinWeight;
      countX += cosWeight;
      countY += sinWeight;
    }
  }

  const scaleX = countX > 0 ? sumRatioX / countX : 1;
  const scaleY = countY > 0 ? sumRatioY / countY : 1;

  return {
    ...ellipse,
    rx: ellipse.rx * scaleX,
    ry: ellipse.ry * scaleY
  };
}

function ellipseResidual(ellipse: EllipseParams, points: Point[]): number {
  let totalError = 0;
  const { cx, cy, rx, ry, rotation } = ellipse;
  const cosR = Math.cos(-rotation);
  const sinR = Math.sin(-rotation);

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const lx = dx * cosR - dy * sinR;
    const ly = dx * sinR + dy * cosR;
    const val = (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry);
    totalError += Math.abs(Math.sqrt(val) - 1);
  }

  return totalError / points.length;
}

function detectTabByAngleContinuity(
  points: Point[],
  curvatures: number[]
): { tabIndices: number[]; bodyIndices: number[] } | null {
  const n = points.length;
  if (n < 20) return null;

  const windowHalf = Math.max(2, Math.round(n / 50));
  const edgeAngles: number[] = [];
  for (let i = 0; i < n; i++) {
    const next = (i + windowHalf) % n;
    const dx = points[next].x - points[i].x;
    const dy = points[next].y - points[i].y;
    edgeAngles.push(Math.atan2(dy, dx));
  }

  const angleDiffs: number[] = [];
  for (let i = 0; i < n; i++) {
    let diff = edgeAngles[(i + 1) % n] - edgeAngles[i];
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    angleDiffs.push(Math.abs(diff));
  }

  const sortedDiffs = angleDiffs.slice().sort((a, b) => b - a);
  const cornerThreshold = Math.max(sortedDiffs[Math.min(8, n - 1)] * 0.5, 0.15);

  const isCorner = angleDiffs.map(d => d > cornerThreshold);

  const cornerRuns = findContiguousRuns(isCorner, n);

  if (cornerRuns.length < 2 || cornerRuns.length > 6) {
    return null;
  }

  const cornerCenters = cornerRuns.map(run => {
    let sx = 0, sy = 0;
    for (const i of run.indices) {
      sx += points[i].x;
      sy += points[i].y;
    }
    return { x: sx / run.indices.length, y: sy / run.indices.length, run };
  });

  let bestPairDist = 0;
  let bestPair: [number, number] | null = null;
  for (let i = 0; i < cornerCenters.length; i++) {
    for (let j = i + 1; j < cornerCenters.length; j++) {
      const d = distSq(cornerCenters[i], cornerCenters[j]);
      if (d > bestPairDist) {
        bestPairDist = d;
        bestPair = [i, j];
      }
    }
  }

  if (!bestPair) return null;

  const corner1 = cornerRuns[bestPair[0]];
  const corner2 = cornerRuns[bestPair[1]];

  const c1End = corner1.indices[corner1.indices.length - 1];
  const c2Start = corner2.indices[0];
  const c2End = corner2.indices[corner2.indices.length - 1];
  const c1Start = corner1.indices[0];

  const segment1: number[] = [];
  let idx = (c1End + 1) % n;
  while (idx !== c2Start) {
    segment1.push(idx);
    idx = (idx + 1) % n;
  }

  const segment2: number[] = [];
  idx = (c2End + 1) % n;
  while (idx !== c1Start) {
    segment2.push(idx);
    idx = (idx + 1) % n;
  }

  if (segment1.length === 0 || segment2.length === 0) return null;

  let seg1CurvSum = 0, seg2CurvSum = 0;
  for (const i of segment1) seg1CurvSum += Math.abs(curvatures[i]);
  for (const i of segment2) seg2CurvSum += Math.abs(curvatures[i]);
  const seg1AvgCurv = seg1CurvSum / segment1.length;
  const seg2AvgCurv = seg2CurvSum / segment2.length;

  let tabIndices: number[];
  let bodyIndices: number[];

  if (segment1.length < segment2.length * 0.8 && seg1AvgCurv < seg2AvgCurv * 0.7) {
    tabIndices = [...corner1.indices, ...segment1, ...corner2.indices];
    bodyIndices = segment2;
  } else if (segment2.length < segment1.length * 0.8 && seg2AvgCurv < seg1AvgCurv * 0.7) {
    tabIndices = [...corner2.indices, ...segment2, ...corner1.indices];
    bodyIndices = segment1;
  } else {
    if (seg1AvgCurv < seg2AvgCurv * 0.5) {
      tabIndices = [...corner1.indices, ...segment1, ...corner2.indices];
      bodyIndices = segment2;
    } else if (seg2AvgCurv < seg1AvgCurv * 0.5) {
      tabIndices = [...corner2.indices, ...segment2, ...corner1.indices];
      bodyIndices = segment1;
    } else {
      return null;
    }
  }

  if (tabIndices.length < 3 || bodyIndices.length < n * 0.3) return null;

  return { tabIndices, bodyIndices };
}

function fitMinBoundingRect(points: Point[]): Point[] | null {
  if (points.length < 3) return null;

  const orderedPoints = [...points];

  let bestArea = Infinity;
  let bestCorners: Point[] | null = null;

  const testAngles: number[] = [];
  for (let i = 0; i < orderedPoints.length; i++) {
    const j = (i + 1) % orderedPoints.length;
    const dx = orderedPoints[j].x - orderedPoints[i].x;
    const dy = orderedPoints[j].y - orderedPoints[i].y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0.01) {
      testAngles.push(Math.atan2(dy, dx));
    }
  }

  const uniqueAngles = new Set<number>();
  for (const a of testAngles) {
    const normalized = Math.round((((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)) * 1000) / 1000;
    uniqueAngles.add(normalized);
  }

  for (const rawAngle of testAngles) {
    const cosA = Math.cos(-rawAngle);
    const sinA = Math.sin(-rawAngle);

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const p of points) {
      const rx = p.x * cosA - p.y * sinA;
      const ry = p.x * sinA + p.y * cosA;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }

    const area = (maxX - minX) * (maxY - minY);
    if (area < bestArea) {
      bestArea = area;

      const cosB = Math.cos(rawAngle);
      const sinB = Math.sin(rawAngle);
      bestCorners = [
        { x: minX * cosB - minY * (-sinB), y: minX * sinB + minY * cosB },
        { x: maxX * cosB - minY * (-sinB), y: maxX * sinB + minY * cosB },
        { x: maxX * cosB - maxY * (-sinB), y: maxX * sinB + maxY * cosB },
        { x: minX * cosB - maxY * (-sinB), y: minX * sinB + maxY * cosB },
      ];
    }
  }

  if (!bestCorners) {
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    bestCorners = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
  }

  return bestCorners;
}

function distSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function generateEllipseArc(
  ellipse: EllipseParams,
  startAngle: number,
  endAngle: number,
  numPoints: number
): Point[] {
  const points: Point[] = [];
  const cosR = Math.cos(ellipse.rotation);
  const sinR = Math.sin(ellipse.rotation);

  let sweep = endAngle - startAngle;
  while (sweep < 0) sweep += Math.PI * 2;
  while (sweep > Math.PI * 2) sweep -= Math.PI * 2;
  if (sweep < Math.PI * 0.5) sweep += Math.PI * 2;

  for (let i = 0; i <= numPoints; i++) {
    const t = startAngle + (i / numPoints) * sweep;
    const lx = ellipse.rx * Math.cos(t);
    const ly = ellipse.ry * Math.sin(t);
    points.push({
      x: ellipse.cx + lx * cosR - ly * sinR,
      y: ellipse.cy + lx * sinR + ly * cosR
    });
  }

  return points;
}

function closestEllipseAngle(ellipse: EllipseParams, point: Point): number {
  const cosR = Math.cos(-ellipse.rotation);
  const sinR = Math.sin(-ellipse.rotation);
  const dx = point.x - ellipse.cx;
  const dy = point.y - ellipse.cy;
  const lx = dx * cosR - dy * sinR;
  const ly = dx * sinR + dy * cosR;
  return Math.atan2(ly / ellipse.ry, lx / ellipse.rx);
}

function pointOnEllipse(ellipse: EllipseParams, angle: number): Point {
  const cosR = Math.cos(ellipse.rotation);
  const sinR = Math.sin(ellipse.rotation);
  const lx = ellipse.rx * Math.cos(angle);
  const ly = ellipse.ry * Math.sin(angle);
  return {
    x: ellipse.cx + lx * cosR - ly * sinR,
    y: ellipse.cy + lx * sinR + ly * cosR
  };
}

function buildCompositeOutline(
  ellipse: EllipseParams,
  rectCorners: Point[]
): Point[] | null {
  const nEdges = rectCorners.length;
  const rectEdges: Array<{ p1: Point; p2: Point; idx: number }> = [];
  for (let i = 0; i < nEdges; i++) {
    rectEdges.push({
      p1: rectCorners[i],
      p2: rectCorners[(i + 1) % nEdges],
      idx: i
    });
  }

  const allIntersections: Array<{
    point: Point;
    rectEdgeIdx: number;
    ellipseAngle: number;
    t: number;
  }> = [];

  for (const edge of rectEdges) {
    const hits = lineSegmentIntersectEllipseWithT(edge.p1, edge.p2, ellipse);
    for (const hit of hits) {
      allIntersections.push({
        point: hit.point,
        rectEdgeIdx: edge.idx,
        ellipseAngle: closestEllipseAngle(ellipse, hit.point),
        t: hit.t
      });
    }
  }

  if (allIntersections.length < 2) {
    console.log('[CompositeShapeFit] Only', allIntersections.length, 'intersections found');
    return null;
  }

  let bestPair: [number, number] | null = null;
  let bestSep = 0;

  for (let i = 0; i < allIntersections.length; i++) {
    for (let j = i + 1; j < allIntersections.length; j++) {
      if (allIntersections[i].rectEdgeIdx === allIntersections[j].rectEdgeIdx) continue;
      const sep = Math.abs(allIntersections[j].ellipseAngle - allIntersections[i].ellipseAngle);
      const minSep = Math.min(sep, Math.PI * 2 - sep);
      if (minSep > bestSep) {
        bestSep = minSep;
        bestPair = [i, j];
      }
    }
  }

  if (!bestPair || bestSep < Math.PI * 0.15) {
    console.log('[CompositeShapeFit] Intersections too close or on same edge:', bestSep.toFixed(2), 'rad');
    return null;
  }

  const intA = allIntersections[bestPair[0]];
  const intB = allIntersections[bestPair[1]];

  const edgeDist = Math.min(
    Math.abs(intA.rectEdgeIdx - intB.rectEdgeIdx),
    4 - Math.abs(intA.rectEdgeIdx - intB.rectEdgeIdx)
  );
  if (edgeDist < 2) {
    console.log('[CompositeShapeFit] Intersections on adjacent edges, insufficient tab geometry');
    return null;
  }

  const midAngle1 = (intA.ellipseAngle + intB.ellipseAngle) / 2;
  const midAngle2 = midAngle1 + Math.PI;
  const midPt1 = pointOnEllipse(ellipse, midAngle1);
  const midPt2 = pointOnEllipse(ellipse, midAngle2);

  const rectCx = (rectCorners[0].x + rectCorners[2].x) / 2;
  const rectCy = (rectCorners[0].y + rectCorners[2].y) / 2;
  const rectCenter = { x: rectCx, y: rectCy };

  const d1 = distSq(midPt1, rectCenter);
  const d2 = distSq(midPt2, rectCenter);

  let arcFrom: typeof intA;
  let arcTo: typeof intB;
  if (d1 > d2) {
    arcFrom = intB;
    arcTo = intA;
  } else {
    arcFrom = intA;
    arcTo = intB;
  }

  const NUM_ELLIPSE_POINTS = 200;
  const ellipseArc = generateEllipseArc(
    ellipse, arcFrom.ellipseAngle, arcTo.ellipseAngle, NUM_ELLIPSE_POINTS
  );

  const sampleArcDistFromRect = (arc: Point[]): number => {
    if (arc.length < 3) return 0;
    let total = 0;
    const step = Math.max(1, Math.floor(arc.length / 5));
    let count = 0;
    for (let i = step; i < arc.length - step; i += step) {
      total += distSq(arc[i], rectCenter);
      count++;
    }
    return count > 0 ? total / count : 0;
  };

  const arcDistFromRect = sampleArcDistFromRect(ellipseArc);

  const altArc = generateEllipseArc(
    ellipse, arcTo.ellipseAngle, arcFrom.ellipseAngle, NUM_ELLIPSE_POINTS
  );
  const altDistFromRect = sampleArcDistFromRect(altArc);

  if (altDistFromRect > arcDistFromRect) {
    console.log('[CompositeShapeFit] Swapping arc direction for better body-side coverage');
    ellipseArc.length = 0;
    ellipseArc.push(...altArc);
    const tmp = arcTo;
    arcTo = arcFrom;
    arcFrom = tmp;
  }

  const validateArcOutsideRect = (arc: Point[], rCorners: Point[]): boolean => {
    const step = Math.max(1, Math.floor(arc.length / 10));
    let insideCount = 0;
    let totalChecked = 0;
    for (let i = step; i < arc.length - step; i += step) {
      if (pointInsideConvexPolygon(arc[i], rCorners)) {
        insideCount++;
      }
      totalChecked++;
    }
    return insideCount < totalChecked * 0.3;
  };

  if (!validateArcOutsideRect(ellipseArc, rectCorners)) {
    console.log('[CompositeShapeFit] Arc passes through rectangle region, rejecting composite fit');
    return null;
  }

  const tabPath = buildRectEdgePath(rectCorners, arcTo, arcFrom, ellipse);

  if (!tabPath || tabPath.length < 2) {
    console.log('[CompositeShapeFit] Could not build rectangle edge path');
    return ellipseArc;
  }

  return [...ellipseArc, ...tabPath];
}

function pointInsideConvexPolygon(p: Point, polygon: Point[]): boolean {
  const n = polygon.length;
  let pos = 0;
  let neg = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (cross > 0) pos++;
    else if (cross < 0) neg++;
    if (pos > 0 && neg > 0) return false;
  }
  return true;
}

function buildRectEdgePath(
  corners: Point[],
  fromIntersection: { point: Point; rectEdgeIdx: number; t: number },
  toIntersection: { point: Point; rectEdgeIdx: number; t: number },
  ellipse: EllipseParams
): Point[] | null {
  const nEdges = corners.length;

  const buildPath = (direction: 1 | -1): Point[] | null => {
    const path: Point[] = [fromIntersection.point];
    let currentEdge = fromIntersection.rectEdgeIdx;
    const targetEdge = toIntersection.rectEdgeIdx;

    if (currentEdge === targetEdge) {
      path.push(toIntersection.point);
      return path;
    }

    const cornersInPath: Point[] = [];
    let safety = 0;
    let edge = currentEdge;

    while (safety < nEdges) {
      let nextCorner: number;
      if (direction === 1) {
        nextCorner = (edge + 1) % nEdges;
      } else {
        nextCorner = edge;
      }

      cornersInPath.push(corners[nextCorner]);
      path.push(corners[nextCorner]);

      if (direction === 1) {
        edge = nextCorner;
      } else {
        edge = (nextCorner - 1 + nEdges) % nEdges;
      }

      if (edge === targetEdge) break;
      safety++;
    }

    if (safety >= nEdges) return null;

    path.push(toIntersection.point);
    return path;
  };

  const pathCW = buildPath(1);
  const pathCCW = buildPath(-1);

  const pathDistFromEllipse = (path: Point[] | null): number => {
    if (!path || path.length < 2) return -Infinity;
    let totalDist = 0;
    let count = 0;
    const cosR = Math.cos(-ellipse.rotation);
    const sinR = Math.sin(-ellipse.rotation);
    for (let i = 1; i < path.length - 1; i++) {
      const dx = path[i].x - ellipse.cx;
      const dy = path[i].y - ellipse.cy;
      const lx = dx * cosR - dy * sinR;
      const ly = dx * sinR + dy * cosR;
      const val = (lx * lx) / (ellipse.rx * ellipse.rx) + (ly * ly) / (ellipse.ry * ellipse.ry);
      totalDist += val;
      count++;
    }
    return count > 0 ? totalDist / count : -Infinity;
  };

  const cwDist = pathDistFromEllipse(pathCW);
  const ccwDist = pathDistFromEllipse(pathCCW);

  const pathQuality = (path: Point[] | null): { outsideCount: number; allOutside: boolean; avgDist: number } => {
    if (!path || path.length < 3) return { outsideCount: 0, allOutside: false, avgDist: -Infinity };
    let count = 0;
    let totalVal = 0;
    const intermediateCount = path.length - 2;
    const cosRr = Math.cos(-ellipse.rotation);
    const sinRr = Math.sin(-ellipse.rotation);
    for (let i = 1; i < path.length - 1; i++) {
      const dx = path[i].x - ellipse.cx;
      const dy = path[i].y - ellipse.cy;
      const lx = dx * cosRr - dy * sinRr;
      const ly = dx * sinRr + dy * cosRr;
      const val = (lx * lx) / (ellipse.rx * ellipse.rx) + (ly * ly) / (ellipse.ry * ellipse.ry);
      totalVal += val;
      if (val > 0.95) count++;
    }
    return {
      outsideCount: count,
      allOutside: count === intermediateCount && intermediateCount >= 2,
      avgDist: intermediateCount > 0 ? totalVal / intermediateCount : -Infinity
    };
  };

  const cwQ = pathQuality(pathCW);
  const ccwQ = pathQuality(pathCCW);

  let chosen: Point[] | null = null;

  if (pathCW && pathCCW) {
    if (cwQ.allOutside && !ccwQ.allOutside) {
      chosen = pathCW;
    } else if (ccwQ.allOutside && !cwQ.allOutside) {
      chosen = pathCCW;
    } else if (cwQ.allOutside && ccwQ.allOutside) {
      chosen = cwQ.avgDist >= ccwQ.avgDist ? pathCW : pathCCW;
    } else if (cwQ.outsideCount >= 2 && ccwQ.outsideCount < 2) {
      chosen = pathCW;
    } else if (ccwQ.outsideCount >= 2 && cwQ.outsideCount < 2) {
      chosen = pathCCW;
    } else {
      console.log('[CompositeShapeFit] Neither path has sufficient outside corners, rejecting');
      return null;
    }
  } else {
    const single = pathCW || pathCCW;
    const singleQ = single === pathCW ? cwQ : ccwQ;
    if (single && singleQ.allOutside) {
      chosen = single;
    } else {
      console.log('[CompositeShapeFit] Single available path lacks outside corners, rejecting');
      return null;
    }
  }

  if (!chosen) return null;

  const chosenQ = chosen === pathCW ? cwQ : ccwQ;

  if (!chosenQ.allOutside || chosenQ.avgDist < 1.02) {
    console.log(`[CompositeShapeFit] Tab path quality insufficient: allOutside=${chosenQ.allOutside}, outsideCount=${chosenQ.outsideCount}, avg dist ${chosenQ.avgDist.toFixed(3)}`);
    return null;
  }

  return chosen;
}

function lineSegmentIntersectEllipseWithT(
  p1: Point, p2: Point, ellipse: EllipseParams
): Array<{ point: Point; t: number }> {
  const cosR = Math.cos(-ellipse.rotation);
  const sinR = Math.sin(-ellipse.rotation);

  const transform = (p: Point) => {
    const dx = p.x - ellipse.cx;
    const dy = p.y - ellipse.cy;
    return {
      x: (dx * cosR - dy * sinR) / ellipse.rx,
      y: (dx * sinR + dy * cosR) / ellipse.ry
    };
  };

  const lp1 = transform(p1);
  const lp2 = transform(p2);

  const dx = lp2.x - lp1.x;
  const dy = lp2.y - lp1.y;

  const a = dx * dx + dy * dy;
  const b = 2 * (lp1.x * dx + lp1.y * dy);
  const c = lp1.x * lp1.x + lp1.y * lp1.y - 1;

  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];

  const results: Array<{ point: Point; t: number }> = [];
  const sqrtDisc = Math.sqrt(disc);

  for (const sign of [-1, 1]) {
    const t = (-b + sign * sqrtDisc) / (2 * a);
    if (t >= -0.05 && t <= 1.05) {
      const clampedT = Math.max(0, Math.min(1, t));
      results.push({
        point: {
          x: p1.x + clampedT * (p2.x - p1.x),
          y: p1.y + clampedT * (p2.y - p1.y)
        },
        t: clampedT
      });
    }
  }

  return results;
}

function sanityCheckComposite(
  composite: Point[],
  original: Point[]
): boolean {
  let origMinX = Infinity, origMaxX = -Infinity;
  let origMinY = Infinity, origMaxY = -Infinity;
  for (const p of original) {
    if (p.x < origMinX) origMinX = p.x;
    if (p.x > origMaxX) origMaxX = p.x;
    if (p.y < origMinY) origMinY = p.y;
    if (p.y > origMaxY) origMaxY = p.y;
  }

  let compMinX = Infinity, compMaxX = -Infinity;
  let compMinY = Infinity, compMaxY = -Infinity;
  for (const p of composite) {
    if (p.x < compMinX) compMinX = p.x;
    if (p.x > compMaxX) compMaxX = p.x;
    if (p.y < compMinY) compMinY = p.y;
    if (p.y > compMaxY) compMaxY = p.y;
  }

  const origW = origMaxX - origMinX;
  const origH = origMaxY - origMinY;
  const compW = compMaxX - compMinX;
  const compH = compMaxY - compMinY;

  if (compW < origW * 0.5 || compW > origW * 2.0) return false;
  if (compH < origH * 0.5 || compH > origH * 2.0) return false;

  const origCx = (origMinX + origMaxX) / 2;
  const origCy = (origMinY + origMaxY) / 2;
  const compCx = (compMinX + compMaxX) / 2;
  const compCy = (compMinY + compMaxY) / 2;
  const centerShift = Math.sqrt((compCx - origCx) ** 2 + (compCy - origCy) ** 2);
  const maxShift = Math.max(origW, origH) * 0.3;
  if (centerShift > maxShift) return false;

  return true;
}

export function fitCompositeShape(contourPoints: Point[], _dpi: number): FitResult {
  const n = contourPoints.length;

  if (n < 20) {
    return { path: contourPoints, fitted: false };
  }

  const windowHalf = Math.max(2, Math.min(7, Math.round(n / 40)));
  const curvatures = computeSmoothedCurvatures(contourPoints, windowHalf);

  const tabResult = detectTabByAngleContinuity(contourPoints, curvatures);

  if (!tabResult) {
    console.log('[CompositeShapeFit] No tab region detected, keeping original contour');
    return { path: contourPoints, fitted: false };
  }

  const { tabIndices, bodyIndices } = tabResult;
  console.log('[CompositeShapeFit] Tab:', tabIndices.length, 'pts. Body:', bodyIndices.length, 'pts');

  const bodyPoints = bodyIndices.map(i => contourPoints[i]);
  const tabPoints = tabIndices.map(i => contourPoints[i]);

  let ellipse = pcaEllipseFit(bodyPoints);

  if (!ellipse) {
    console.log('[CompositeShapeFit] PCA ellipse fit failed');
    return { path: contourPoints, fitted: false };
  }

  ellipse = refineEllipseRadii(ellipse, bodyPoints);

  const residual = ellipseResidual(ellipse, bodyPoints);
  console.log('[CompositeShapeFit] Ellipse residual:', residual.toFixed(4),
    'center:', ellipse.cx.toFixed(1), ellipse.cy.toFixed(1),
    'radii:', ellipse.rx.toFixed(1), 'x', ellipse.ry.toFixed(1),
    'rotation:', (ellipse.rotation * 180 / Math.PI).toFixed(1) + '°');

  if (residual > 0.25) {
    console.log('[CompositeShapeFit] Ellipse residual too high, keeping original');
    return { path: contourPoints, fitted: false };
  }

  const rectCorners = fitMinBoundingRect(tabPoints);

  if (!rectCorners) {
    console.log('[CompositeShapeFit] Rectangle fit failed for tab, using full ellipse');
    const fullEllipse = generateEllipseArc(ellipse, 0, Math.PI * 2, 256);
    return { path: fullEllipse, fitted: true };
  }

  console.log('[CompositeShapeFit] Rectangle fitted with right-angle corners');

  const composite = buildCompositeOutline(ellipse, rectCorners);

  if (!composite || composite.length < 10) {
    console.log('[CompositeShapeFit] Composite outline failed, falling back to ellipse');
    const fullEllipse = generateEllipseArc(ellipse, 0, Math.PI * 2, 256);
    return { path: fullEllipse, fitted: true };
  }

  if (!sanityCheckComposite(composite, contourPoints)) {
    console.log('[CompositeShapeFit] Sanity check failed (size/position mismatch), keeping original');
    return { path: contourPoints, fitted: false };
  }

  console.log('[CompositeShapeFit] Composite outline:', composite.length, 'points');
  return { path: composite, fitted: true };
}
