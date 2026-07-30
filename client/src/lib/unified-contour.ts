import { StrokeSettings } from "@/components/image-editor";

interface ContourPoint {
  x: number;
  y: number;
}

interface DetectedObject {
  id: number;
  pixels: ContourPoint[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  area: number;
  aspectRatio: number;
  isText: boolean;
}

export function createUnifiedContour(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  canvas.width = image.width;
  canvas.height = image.height;

  // Step 1: Get image data for analysis
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Step 2: Create unified bounding shape that encompasses all objects
  const bounds = findContentBounds(data, canvas.width, canvas.height, strokeSettings.alphaThreshold);
  if (!bounds) {
    return canvas;
  }

  // Step 3: Create a unified contour using convex hull or alpha shape
  const unifiedContour = createSingleContour(data, canvas.width, canvas.height, bounds, strokeSettings);

  // Step 4: Clear canvas and draw the final unified contour only
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawUnifiedContour(ctx, unifiedContour, strokeSettings);

  return canvas;
}

function findContentBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  let minX = width, maxX = 0, minY = height, maxY = 0;
  let hasContent = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha >= alphaThreshold) { // Use configurable alpha threshold
        hasContent = true;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return hasContent ? { minX, maxX, minY, maxY } : null;
}

function createSingleContour(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  strokeSettings: StrokeSettings
): ContourPoint[] {
  // Step 1: Automatically detect separate objects and text
  const separateObjects = detectSeparateObjects(data, width, height, strokeSettings.alphaThreshold);
  
  if (separateObjects.length === 0) {
    return [];
  }
  
  if (separateObjects.length === 1) {
    // Single object - create precise contour
    return createObjectContour(separateObjects[0], data, width, height, strokeSettings);
  }
  
  // Step 2: Create individual contours for each object
  const individualContours = separateObjects.map(obj => 
    createObjectContour(obj, data, width, height, strokeSettings)
  );
  
  // Step 3: Intelligently merge contours based on proximity
  return mergeNearbyContours(individualContours, strokeSettings.width * 2);
}

function findAllEdgePoints(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number
): ContourPoint[] {
  const edgePoints: ContourPoint[] = [];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const currentAlpha = data[(y * width + x) * 4 + 3];
      
      if (currentAlpha >= alphaThreshold) {
        // Check if this is an edge pixel (has transparent neighbor)
        const neighbors = [
          data[((y-1) * width + x) * 4 + 3], // top
          data[((y+1) * width + x) * 4 + 3], // bottom
          data[(y * width + (x-1)) * 4 + 3], // left
          data[(y * width + (x+1)) * 4 + 3], // right
        ];
        
        const hasTransparentNeighbor = neighbors.some(alpha => alpha < alphaThreshold);
        
        if (hasTransparentNeighbor) {
          edgePoints.push({ x, y });
        }
      }
    }
  }
  
  return edgePoints;
}

function calculateConvexHull(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 3) return points;

  // Graham scan algorithm for convex hull
  const center = points.reduce(
    (acc, p) => ({ x: acc.x + p.x / points.length, y: acc.y + p.y / points.length }),
    { x: 0, y: 0 }
  );

  // Sort points by polar angle
  const sortedPoints = points.sort((a, b) => {
    const angleA = Math.atan2(a.y - center.y, a.x - center.x);
    const angleB = Math.atan2(b.y - center.y, b.x - center.x);
    return angleA - angleB;
  });

  const hull: ContourPoint[] = [];
  
  for (const point of sortedPoints) {
    while (hull.length >= 2) {
      const orientation = calculateOrientation(
        hull[hull.length - 2],
        hull[hull.length - 1],
        point
      );
      if (orientation <= 0) {
        hull.pop();
      } else {
        break;
      }
    }
    hull.push(point);
  }

  return hull;
}

function createAlphaShape(points: ContourPoint[], alpha: number): ContourPoint[] {
  // Simplified alpha shape - create concave hull with maximum edge length
  if (points.length < 3) return points;

  const maxEdgeLength = alpha;
  const result: ContourPoint[] = [];
  
  // Start with convex hull
  const convexHull = calculateConvexHull(points);
  
  // Refine by adding interior points that create concave sections
  for (let i = 0; i < convexHull.length; i++) {
    const current = convexHull[i];
    const next = convexHull[(i + 1) % convexHull.length];
    
    result.push(current);
    
    // Check if we should add intermediate points
    const distance = Math.sqrt(
      Math.pow(next.x - current.x, 2) + Math.pow(next.y - current.y, 2)
    );
    
    if (distance > maxEdgeLength) {
      // Find closest interior points
      const intermediatePoints = points.filter(p => {
        const distToCurrent = Math.sqrt(
          Math.pow(p.x - current.x, 2) + Math.pow(p.y - current.y, 2)
        );
        const distToNext = Math.sqrt(
          Math.pow(p.x - next.x, 2) + Math.pow(p.y - next.y, 2)
        );
        return distToCurrent < maxEdgeLength && distToNext < maxEdgeLength;
      });
      
      // Add the best intermediate point
      if (intermediatePoints.length > 0) {
        const best = intermediatePoints.reduce((closest, p) => {
          const distToCurrent = Math.sqrt(
            Math.pow(p.x - current.x, 2) + Math.pow(p.y - current.y, 2)
          );
          const closestDist = Math.sqrt(
            Math.pow(closest.x - current.x, 2) + Math.pow(closest.y - current.y, 2)
          );
          return distToCurrent < closestDist ? p : closest;
        });
        result.push(best);
      }
    }
  }
  
  return result;
}

function createMorphologicalContour(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  strokeSettings: StrokeSettings
): ContourPoint[] {
  // Create binary mask using alpha threshold
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 4) {
    mask[i / 4] = data[i + 3] >= strokeSettings.alphaThreshold ? 1 : 0;
  }

  // Apply morphological closing to connect nearby objects
  const closingRadius = Math.max(3, strokeSettings.width);
  const closedMask = morphologicalClosing(mask, width, height, closingRadius);

  // Find the outer boundary of the closed shape
  return traceBoundary(closedMask, width, height);
}

function morphologicalClosing(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  // Dilation followed by erosion
  const dilated = morphologicalDilation(mask, width, height, radius);
  return morphologicalErosion(dilated, width, height, radius);
}

function morphologicalDilation(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const result = new Uint8Array(width * height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      
      // Check if any pixel in the neighborhood is set
      let hasNeighbor = false;
      for (let dy = -radius; dy <= radius && !hasNeighbor; dy++) {
        for (let dx = -radius; dx <= radius && !hasNeighbor; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            if (mask[ny * width + nx] === 1) {
              hasNeighbor = true;
            }
          }
        }
      }
      
      result[index] = hasNeighbor ? 1 : 0;
    }
  }
  
  return result;
}

function morphologicalErosion(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number
): Uint8Array {
  const result = new Uint8Array(width * height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      
      // Check if all pixels in the neighborhood are set
      let allNeighborsSet = true;
      for (let dy = -radius; dy <= radius && allNeighborsSet; dy++) {
        for (let dx = -radius; dx <= radius && allNeighborsSet; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            if (mask[ny * width + nx] === 0) {
              allNeighborsSet = false;
            }
          } else {
            allNeighborsSet = false; // Out of bounds treated as 0
          }
        }
      }
      
      result[index] = allNeighborsSet ? 1 : 0;
    }
  }
  
  return result;
}

function traceBoundary(mask: Uint8Array, width: number, height: number): ContourPoint[] {
  // Find starting point (leftmost, topmost filled pixel)
  let startX = -1, startY = -1;
  
  for (let y = 0; y < height && startX === -1; y++) {
    for (let x = 0; x < width && startX === -1; x++) {
      if (mask[y * width + x] === 1) {
        startX = x;
        startY = y;
      }
    }
  }
  
  if (startX === -1) return [];

  // Moore neighborhood boundary following
  const boundary: ContourPoint[] = [];
  const directions = [
    [-1, -1], [0, -1], [1, -1],
    [1, 0], [1, 1], [0, 1],
    [-1, 1], [-1, 0]
  ];
  
  let currentX = startX;
  let currentY = startY;
  let direction = 0; // Start facing right
  
  do {
    boundary.push({ x: currentX, y: currentY });
    
    // Look for next boundary pixel
    let found = false;
    for (let i = 0; i < 8 && !found; i++) {
      const checkDir = (direction + i) % 8;
      const dx = directions[checkDir][0];
      const dy = directions[checkDir][1];
      const nextX = currentX + dx;
      const nextY = currentY + dy;
      
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
        if (mask[nextY * width + nextX] === 1) {
          currentX = nextX;
          currentY = nextY;
          direction = (checkDir + 6) % 8; // Turn left for next search
          found = true;
        }
      }
    }
    
    if (!found) break;
    
  } while (currentX !== startX || currentY !== startY || boundary.length < 8);
  
  // Simplify boundary to reduce points
  return simplifyContour(boundary, 2);
}

function simplifyContour(contour: ContourPoint[], tolerance: number): ContourPoint[] {
  if (contour.length <= 2) return contour;
  
  // Douglas-Peucker simplification
  return douglasPeuckerSimplify(contour, tolerance);
}

function douglasPeuckerSimplify(points: ContourPoint[], tolerance: number): ContourPoint[] {
  if (points.length <= 2) return points;
  
  let maxDistance = 0;
  let maxIndex = 0;
  
  // Find the point with maximum distance from line between first and last
  for (let i = 1; i < points.length - 1; i++) {
    const distance = pointToLineDistance(
      points[i],
      points[0],
      points[points.length - 1]
    );
    
    if (distance > maxDistance) {
      maxDistance = distance;
      maxIndex = i;
    }
  }
  
  if (maxDistance > tolerance) {
    // Split and recursively simplify
    const left = douglasPeuckerSimplify(points.slice(0, maxIndex + 1), tolerance);
    const right = douglasPeuckerSimplify(points.slice(maxIndex), tolerance);
    
    return left.slice(0, -1).concat(right);
  } else {
    return [points[0], points[points.length - 1]];
  }
}

function pointToLineDistance(
  point: ContourPoint,
  lineStart: ContourPoint,
  lineEnd: ContourPoint
): number {
  const A = lineEnd.y - lineStart.y;
  const B = lineStart.x - lineEnd.x;
  const C = lineEnd.x * lineStart.y - lineStart.x * lineEnd.y;
  
  return Math.abs(A * point.x + B * point.y + C) / Math.sqrt(A * A + B * B);
}

function calculateOrientation(p: ContourPoint, q: ContourPoint, r: ContourPoint): number {
  const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (val === 0) return 0; // collinear
  return val > 0 ? 1 : 2; // clockwise or counterclockwise
}

function detectSeparateObjects(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold: number
): DetectedObject[] {
  const visited = new Uint8Array(width * height);
  const objects: DetectedObject[] = [];
  let objectId = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const alpha = data[index * 4 + 3];
      
      if (alpha >= alphaThreshold && !visited[index]) {
        // Found unvisited solid pixel - start flood fill
        const objectPixels = floodFillObject(data, visited, x, y, width, height, alphaThreshold);
        
        if (objectPixels.length > 10) { // Minimum size threshold
          const bounds = calculateObjectBounds(objectPixels);
          const area = objectPixels.length;
          const aspectRatio = (bounds.maxX - bounds.minX) / (bounds.maxY - bounds.minY);
          const isText = detectIfText(objectPixels, bounds, aspectRatio);
          
          objects.push({
            id: objectId++,
            pixels: objectPixels,
            bounds,
            area,
            aspectRatio,
            isText
          });
        }
      }
    }
  }

  return objects;
}

function floodFillObject(
  data: Uint8ClampedArray,
  visited: Uint8Array,
  startX: number,
  startY: number,
  width: number,
  height: number,
  alphaThreshold: number
): ContourPoint[] {
  const pixels: ContourPoint[] = [];
  const stack: ContourPoint[] = [{ x: startX, y: startY }];
  
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    const index = y * width + x;
    
    if (x < 0 || x >= width || y < 0 || y >= height || visited[index]) {
      continue;
    }
    
    const alpha = data[index * 4 + 3];
    if (alpha < alphaThreshold) {
      continue;
    }
    
    visited[index] = 1;
    pixels.push({ x, y });
    
    // Add 4-connected neighbors
    stack.push({ x: x + 1, y });
    stack.push({ x: x - 1, y });
    stack.push({ x, y: y + 1 });
    stack.push({ x, y: y - 1 });
  }
  
  return pixels;
}

function calculateObjectBounds(pixels: ContourPoint[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  
  for (const pixel of pixels) {
    minX = Math.min(minX, pixel.x);
    maxX = Math.max(maxX, pixel.x);
    minY = Math.min(minY, pixel.y);
    maxY = Math.max(maxY, pixel.y);
  }
  
  return { minX, maxX, minY, maxY };
}

function detectIfText(pixels: ContourPoint[], bounds: { minX: number; maxX: number; minY: number; maxY: number }, aspectRatio: number): boolean {
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const area = pixels.length;
  const boundingArea = width * height;
  const density = area / boundingArea;
  
  // Text characteristics:
  // - Moderate aspect ratio (not too wide or tall)
  // - Medium density (has internal spaces)
  // - Reasonable size
  const isTextLikeAspectRatio = aspectRatio > 0.2 && aspectRatio < 8;
  const isTextLikeDensity = density > 0.3 && density < 0.9;
  const isReasonableSize = width > 5 && height > 5 && width < 500 && height < 100;
  
  return isTextLikeAspectRatio && isTextLikeDensity && isReasonableSize;
}

function createObjectContour(
  object: DetectedObject,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  strokeSettings: StrokeSettings
): ContourPoint[] {
  // Create a localized edge detection for this object
  const edgePoints: ContourPoint[] = [];
  
  for (const pixel of object.pixels) {
    const { x, y } = pixel;
    
    // Check if this pixel is on the edge (has transparent neighbor)
    const neighbors = [
      { x: x - 1, y },
      { x: x + 1, y },
      { x, y: y - 1 },
      { x, y: y + 1 }
    ];
    
    const hasTransparentNeighbor = neighbors.some(neighbor => {
      if (neighbor.x < 0 || neighbor.x >= width || neighbor.y < 0 || neighbor.y >= height) {
        return true; // Out of bounds = transparent
      }
      const neighborAlpha = data[(neighbor.y * width + neighbor.x) * 4 + 3];
      return neighborAlpha < strokeSettings.alphaThreshold;
    });
    
    if (hasTransparentNeighbor) {
      edgePoints.push(pixel);
    }
  }
  
  if (edgePoints.length < 3) {
    return calculateConvexHull(object.pixels);
  }
  
  // For text objects, use tighter contours
  if (object.isText) {
    return createTextContour(edgePoints, strokeSettings.width * 0.5);
  }
  
  // For regular objects, use standard contour
  return createShapeContour(edgePoints, strokeSettings.width);
}

function createTextContour(edgePoints: ContourPoint[], margin: number): ContourPoint[] {
  // For text, create a tight but smooth contour
  const bounds = calculateObjectBounds(edgePoints);
  const padding = Math.max(1, margin);
  
  return [
    { x: bounds.minX - padding, y: bounds.minY - padding },
    { x: bounds.maxX + padding, y: bounds.minY - padding },
    { x: bounds.maxX + padding, y: bounds.maxY + padding },
    { x: bounds.minX - padding, y: bounds.maxY + padding }
  ];
}

function createShapeContour(edgePoints: ContourPoint[], margin: number): ContourPoint[] {
  // For shapes, create a more organic contour following the actual edges
  if (edgePoints.length < 10) {
    return calculateConvexHull(edgePoints);
  }
  
  // Use alpha shape for complex objects
  return createAlphaShape(edgePoints, margin * 5);
}

function mergeNearbyContours(contours: ContourPoint[][], mergeDistance: number): ContourPoint[] {
  if (contours.length === 0) return [];
  if (contours.length === 1) return contours[0];
  
  // Find all contours that are within merge distance
  const contourGroups: ContourPoint[][][] = [];
  const processed = new Set<number>();
  
  for (let i = 0; i < contours.length; i++) {
    if (processed.has(i)) continue;
    
    const group: ContourPoint[][] = [contours[i]];
    processed.add(i);
    
    // Find all contours close to this one
    for (let j = i + 1; j < contours.length; j++) {
      if (processed.has(j)) continue;
      
      const distance = calculateMinimumContourDistance(contours[i], contours[j]);
      if (distance <= mergeDistance) {
        group.push(contours[j]);
        processed.add(j);
      }
    }
    
    contourGroups.push(group);
  }
  
  // Merge each group into a single contour
  const mergedContours = contourGroups.map(group => mergeContourGroup(group));
  
  // If we still have multiple groups, create a unified hull around all
  if (mergedContours.length > 1) {
    const allPoints = mergedContours.flat();
    return calculateConvexHull(allPoints);
  }
  
  return mergedContours[0];
}

function calculateMinimumContourDistance(contour1: ContourPoint[], contour2: ContourPoint[]): number {
  let minDistance = Infinity;
  
  for (const p1 of contour1) {
    for (const p2 of contour2) {
      const distance = Math.sqrt(
        Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2)
      );
      minDistance = Math.min(minDistance, distance);
    }
  }
  
  return minDistance;
}

function mergeContourGroup(contours: ContourPoint[][]): ContourPoint[] {
  if (contours.length === 1) return contours[0];
  
  // Create a unified hull around all contours in the group
  const allPoints = contours.flat();
  
  // Use morphological closing approach for better merging
  const bounds = calculateObjectBounds(allPoints);
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  
  // Create a binary mask for all points
  const mask = new Uint8Array(width * height);
  
  for (const point of allPoints) {
    const x = point.x - bounds.minX;
    const y = point.y - bounds.minY;
    if (x >= 0 && x < width && y >= 0 && y < height) {
      mask[y * width + x] = 1;
    }
  }
  
  // Apply morphological closing to connect nearby objects
  const closedMask = morphologicalClosing(mask, width, height, 3);
  
  // Trace the boundary of the closed shape
  const boundary = traceBoundary(closedMask, width, height);
  
  // Convert back to global coordinates
  return boundary.map(point => ({
    x: point.x + bounds.minX,
    y: point.y + bounds.minY
  }));
}

function drawUnifiedContour(
  ctx: CanvasRenderingContext2D,
  contour: ContourPoint[],
  strokeSettings: StrokeSettings
): void {
  if (contour.length < 2) return;

  ctx.strokeStyle = strokeSettings.color;
  ctx.lineWidth = Math.max(1, strokeSettings.width);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.fillStyle = 'transparent';

  ctx.beginPath();
  ctx.moveTo(contour[0].x, contour[0].y);
  
  for (let i = 1; i < contour.length; i++) {
    ctx.lineTo(contour[i].x, contour[i].y);
  }
  
  ctx.closePath();
  ctx.stroke();
}