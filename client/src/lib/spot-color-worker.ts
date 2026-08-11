interface Point {
  x: number;
  y: number;
}

interface SpotColorInputWorker {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite?: boolean;
  spotGloss?: boolean;
  spotWhiteName?: string;
  spotGlossName?: string;
  spotFluorY?: boolean;
  spotFluorM?: boolean;
  spotFluorG?: boolean;
  spotFluorOrange?: boolean;
  spotFluorYName?: string;
  spotFluorMName?: string;
  spotFluorGName?: string;
  spotFluorOrangeName?: string;
}

interface SpotColorRegionWorker {
  name: string;
  paths: Point[][];
  tintCMYK: [number, number, number, number];
}

/**
 * One separation's worth of work.
 *
 * Each spot type (white, gloss, and the four fluorescents) is an independent mask and
 * trace over the same pixels, so they are dispatched as separate jobs across a worker
 * pool instead of looping inside a single worker. The caller assembles the replies.
 */
interface WorkerMessage {
  type: 'trace';
  imageBuffer: ArrayBuffer;
  imageWidth: number;
  imageHeight: number;
  /** The colours the customer assigned to this separation. */
  markedColors: SpotColorInputWorker[];
  /** Every spot colour in the design — the mask needs them all to pick a nearest match. */
  spotColors: SpotColorInputWorker[];
  regionName: string;
  dpi: number;
}

interface WorkerResponse {
  type: 'result';
  /** Null when the separation traced to nothing, which is not an error. */
  region: SpotColorRegionWorker | null;
}

function createClosestColorMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  markedColors: SpotColorInputWorker[],
  allSpotColors: SpotColorInputWorker[],
  colorTolerance: number,
  alphaThreshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);

  const markedHexSet = new Set(markedColors.map(mc => mc.hex));
  const markedRGBs = markedColors.map(mc => mc.rgb);
  const allColorsIndexed = allSpotColors.map(c => ({
    rgb: c.rgb,
    hex: c.hex
  }));

  const directTolerance = 100;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];

      if (a < alphaThreshold) continue;

      let closestHex = '';
      let closestDistance = Infinity;

      for (const sc of allColorsIndexed) {
        const dr = r - sc.rgb.r;
        const dg = g - sc.rgb.g;
        const db = b - sc.rgb.b;
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);

        if (distance < closestDistance) {
          closestDistance = distance;
          closestHex = sc.hex;
        }
      }

      if (closestDistance < colorTolerance && markedHexSet.has(closestHex)) {
        let withinDirect = false;
        for (const mrgb of markedRGBs) {
          const dr = r - mrgb.r;
          const dg = g - mrgb.g;
          const db = b - mrgb.b;
          if (Math.sqrt(dr * dr + dg * dg + db * db) < directTolerance) {
            withinDirect = true;
            break;
          }
        }
        if (withinDirect) {
          mask[y * width + x] = 1;
        }
      }
    }
  }

  return mask;
}

function marchingSquaresTrace(mask: Uint8Array, width: number, height: number): Point[][] {
  function getMask(x: number, y: number): number {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return mask[y * width + x];
  }

  interface Edge {
    fromX: number; fromY: number;
    toX: number; toY: number;
    dx: number; dy: number;
  }

  const edges: Edge[] = [];

  for (let y = 0; y <= height; y++) {
    for (let x = 0; x < width; x++) {
      const above = getMask(x, y - 1);
      const below = getMask(x, y);
      if (above !== below) {
        if (above === 1) {
          edges.push({ fromX: x + 1, fromY: y, toX: x, toY: y, dx: -1, dy: 0 });
        } else {
          edges.push({ fromX: x, fromY: y, toX: x + 1, toY: y, dx: 1, dy: 0 });
        }
      }
    }
  }

  for (let x = 0; x <= width; x++) {
    for (let y = 0; y < height; y++) {
      const left = getMask(x - 1, y);
      const right = getMask(x, y);
      if (left !== right) {
        if (left === 1) {
          edges.push({ fromX: x, fromY: y, toX: x, toY: y + 1, dx: 0, dy: 1 });
        } else {
          edges.push({ fromX: x, fromY: y + 1, toX: x, toY: y, dx: 0, dy: -1 });
        }
      }
    }
  }

  if (edges.length === 0) return [];

  const fromMap = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const key = `${edges[i].fromX},${edges[i].fromY}`;
    if (!fromMap.has(key)) fromMap.set(key, []);
    fromMap.get(key)!.push(i);
  }

  const rightTurnPriority: Record<string, [number, number][]> = {
    '1,0': [[0, 1], [1, 0], [0, -1], [-1, 0]],
    '0,1': [[-1, 0], [0, 1], [1, 0], [0, -1]],
    '-1,0': [[0, -1], [-1, 0], [0, 1], [1, 0]],
    '0,-1': [[1, 0], [0, -1], [-1, 0], [0, 1]],
  };

  const used = new Uint8Array(edges.length);
  const contours: Point[][] = [];

  for (let startIdx = 0; startIdx < edges.length; startIdx++) {
    if (used[startIdx]) continue;

    const contour: Point[] = [];
    let edgeIdx = startIdx;
    const maxSteps = edges.length;
    let steps = 0;

    while (!used[edgeIdx] && steps < maxSteps) {
      used[edgeIdx] = 1;
      const edge = edges[edgeIdx];
      contour.push({ x: edge.fromX, y: edge.fromY });

      const nextKey = `${edge.toX},${edge.toY}`;
      const candidates = fromMap.get(nextKey);
      if (!candidates) break;

      const priority = rightTurnPriority[`${edge.dx},${edge.dy}`];
      let nextIdx = -1;

      if (priority) {
        for (const [pdx, pdy] of priority) {
          for (const ci of candidates) {
            if (!used[ci] && edges[ci].dx === pdx && edges[ci].dy === pdy) {
              nextIdx = ci;
              break;
            }
          }
          if (nextIdx !== -1) break;
        }
      } else {
        for (const ci of candidates) {
          if (!used[ci]) { nextIdx = ci; break; }
        }
      }

      if (nextIdx === -1) break;
      edgeIdx = nextIdx;
      steps++;
    }

    if (contour.length > 2) {
      contours.push(contour);
    }
  }

  return contours;
}

function collapseCollinear(contour: Point[]): Point[] {
  if (contour.length < 3) return contour;

  const result: Point[] = [];

  for (let i = 0; i < contour.length; i++) {
    const prev = contour[(i - 1 + contour.length) % contour.length];
    const curr = contour[i];
    const next = contour[(i + 1) % contour.length];

    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;

    const sameDirX = (dx1 > 0 && dx2 > 0) || (dx1 < 0 && dx2 < 0) || (dx1 === 0 && dx2 === 0);
    const sameDirY = (dy1 > 0 && dy2 > 0) || (dy1 < 0 && dy2 < 0) || (dy1 === 0 && dy2 === 0);

    if (!(sameDirX && sameDirY)) {
      result.push(curr);
    }
  }

  return result.length >= 3 ? result : contour;
}

function traceMaskToInchPaths(mask: Uint8Array, width: number, height: number, pixelsPerInch: number): Point[][] {
  const rawPaths = marchingSquaresTrace(mask, width, height);
  return rawPaths.map(rawPath => {
    const collapsed = collapseCollinear(rawPath);
    return collapsed.map(p => ({
      x: p.x / pixelsPerInch,
      y: p.y / pixelsPerInch
    }));
  }).filter(p => p.length >= 3);
}

self.onmessage = function(e: MessageEvent<WorkerMessage>) {
  try {
    if (e.data.type !== 'trace') return;
    const { imageBuffer, imageWidth, imageHeight, markedColors, spotColors, regionName, dpi } = e.data;
    const pixelData = new Uint8ClampedArray(imageBuffer);
    const mask = createClosestColorMask(pixelData, imageWidth, imageHeight, markedColors, spotColors, 80, 128);
    const paths = traceMaskToInchPaths(mask, imageWidth, imageHeight, dpi);
    const response: WorkerResponse = {
      type: 'result',
      region: paths.length > 0 ? { name: regionName, paths, tintCMYK: [0, 1, 0, 0] } : null,
    };
    self.postMessage(response);
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err) });
  }
};
