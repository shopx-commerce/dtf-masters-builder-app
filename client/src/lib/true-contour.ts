import { StrokeSettings } from "@/components/image-editor";

export interface TrueContourOptions {
  strokeSettings: StrokeSettings;
  threshold: number;
  smoothing: number;
  includeHoles: boolean;
  holeMargin: number;
  fillHoles: boolean;
  autoTextBackground: boolean;
}

interface ContourPoint {
  x: number;
  y: number;
}

export function createTrueContour(
  image: HTMLImageElement,
  options: TrueContourOptions
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  try {
    const { strokeSettings } = options;
    
    // Set canvas size to match image exactly
    canvas.width = image.width;
    canvas.height = image.height;
    
    // Clear canvas with transparent background
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Always draw the original image first
    ctx.drawImage(image, 0, 0);
    
    // Add outline if enabled
    if (strokeSettings.enabled && strokeSettings.width > 0) {
      try {
        // Simple outline generation
        const outline = generateSimpleOutline(image, strokeSettings);
        if (outline.length > 0) {
          drawSimpleOutline(ctx, outline, strokeSettings);
        }
      } catch (outlineError) {
        console.error('Outline generation error:', outlineError);
      }
    }
    
    return canvas;
  } catch (error) {
    console.error('True contour error:', error);
    // Return canvas with just the original image
    canvas.width = image.width;
    canvas.height = image.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    return canvas;
  }
}

function generateSimpleOutline(image: HTMLImageElement, strokeSettings: StrokeSettings): ContourPoint[] {
  try {
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) {
      console.error('Failed to get canvas context for outline generation');
      return [];
    }
    
    // Validate image dimensions
    if (image.width <= 0 || image.height <= 0) {
      console.warn('Invalid image dimensions for outline generation');
      return [];
    }
    
    tempCanvas.width = image.width;
    tempCanvas.height = image.height;
    tempCtx.drawImage(image, 0, 0);
    
    const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
    const { data, width, height } = imageData;
    
    // Create actual contour following the image shape
    return generateActualContour(data, width, height, strokeSettings);
  } catch (error) {
    console.error('Error generating simple outline:', error);
    return [];
  }
}

function generateActualContour(
  data: Uint8ClampedArray, 
  width: number, 
  height: number, 
  strokeSettings: StrokeSettings
): ContourPoint[] {
  // Step 1: Find edge pixels using alpha channel
  const edgePixels = findImageEdgePixels(data, width, height);
  
  if (edgePixels.length === 0) return [];
  
  // Step 2: Create ordered contour from edge pixels
  const orderedContour = createOrderedContour(edgePixels);
  
  // Step 3: Apply offset for stroke width with intelligent growth
  const offset = strokeSettings.width / 100 * 5;
  return applyIntelligentOffset(orderedContour, offset, data, width, height);
}

function findImageEdgePixels(data: Uint8ClampedArray, width: number, height: number): ContourPoint[] {
  const edgePixels: ContourPoint[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      // If this pixel is visible
      if (alpha > 50) {
        // Check if it's an edge pixel (has transparent neighbor)
        let isEdge = false;
        
        // Check 8-directional neighbors
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const nx = x + dx;
            const ny = y + dy;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              isEdge = true; // Edge of image
              break;
            }
            
            const nIdx = (ny * width + nx) * 4;
            const nAlpha = data[nIdx + 3];
            
            if (nAlpha <= 50) {
              isEdge = true; // Has transparent neighbor
              break;
            }
          }
          if (isEdge) break;
        }
        
        if (isEdge) {
          edgePixels.push({ x, y });
        }
      }
    }
  }
  
  return edgePixels;
}

function createOrderedContour(edgePixels: ContourPoint[]): ContourPoint[] {
  if (edgePixels.length === 0) return [];
  
  // Find starting point (leftmost, then topmost)
  let startPoint = edgePixels[0];
  for (const pixel of edgePixels) {
    if (pixel.x < startPoint.x || (pixel.x === startPoint.x && pixel.y < startPoint.y)) {
      startPoint = pixel;
    }
  }
  
  const orderedContour: ContourPoint[] = [startPoint];
  const used = new Set<string>();
  used.add(`${startPoint.x},${startPoint.y}`);
  
  let currentPoint = startPoint;
  
  // Follow the contour by finding the nearest unused edge pixel
  while (orderedContour.length < edgePixels.length) {
    let nearestPixel: ContourPoint | null = null;
    let minDistance = Infinity;
    
    for (const pixel of edgePixels) {
      const key = `${pixel.x},${pixel.y}`;
      if (used.has(key)) continue;
      
      const dx = pixel.x - currentPoint.x;
      const dy = pixel.y - currentPoint.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      
      // Prefer nearby pixels (within 2 pixel distance)
      if (distance <= 2 && distance < minDistance) {
        minDistance = distance;
        nearestPixel = pixel;
      }
    }
    
    // If no nearby pixel found, find closest overall
    if (!nearestPixel) {
      for (const pixel of edgePixels) {
        const key = `${pixel.x},${pixel.y}`;
        if (used.has(key)) continue;
        
        const dx = pixel.x - currentPoint.x;
        const dy = pixel.y - currentPoint.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < minDistance) {
          minDistance = distance;
          nearestPixel = pixel;
        }
      }
    }
    
    if (!nearestPixel) break;
    
    orderedContour.push(nearestPixel);
    used.add(`${nearestPixel.x},${nearestPixel.y}`);
    currentPoint = nearestPixel;
  }
  
  // Smooth the contour
  return smoothContour(orderedContour);
}

function smoothContour(contour: ContourPoint[]): ContourPoint[] {
  if (contour.length < 3) return contour;
  
  // First pass: basic smoothing
  let smoothed: ContourPoint[] = [];
  
  for (let i = 0; i < contour.length; i++) {
    const prev = contour[(i - 1 + contour.length) % contour.length];
    const curr = contour[i];
    const next = contour[(i + 1) % contour.length];
    
    const smoothX = (prev.x + curr.x * 2 + next.x) / 4;
    const smoothY = (prev.y + curr.y * 2 + next.y) / 4;
    
    smoothed.push({ x: Math.round(smoothX), y: Math.round(smoothY) });
  }
  
  // Second pass: apply merge paths at sharp turns
  smoothed = applyMergePaths(smoothed);
  
  // Third pass: remove overshooting points
  smoothed = removeOvershootingPoints(smoothed);
  
  return smoothed;
}

// Generate U-shaped merge path (for outward curves)
function generateUShape(start: ContourPoint, end: ContourPoint, depth: number): ContourPoint[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = -dy / len;
  const perpY = dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.5, y: quarterY + perpY * depth * 0.5 },
    { x: midX + perpX * depth, y: midY + perpY * depth },
    { x: threeQuarterX + perpX * depth * 0.5, y: threeQuarterY + perpY * depth * 0.5 },
    end
  ];
}

// Generate N-shaped merge path (for inward/concave transitions)
function generateNShape(start: ContourPoint, end: ContourPoint, depth: number): ContourPoint[] {
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return [start, end];
  
  const perpX = dy / len;
  const perpY = -dx / len;
  
  const quarterX = (start.x + midX) / 2;
  const quarterY = (start.y + midY) / 2;
  const threeQuarterX = (midX + end.x) / 2;
  const threeQuarterY = (midY + end.y) / 2;
  
  return [
    start,
    { x: quarterX + perpX * depth * 0.3, y: quarterY + perpY * depth * 0.3 },
    { x: midX + perpX * depth * 0.5, y: midY + perpY * depth * 0.5 },
    { x: threeQuarterX + perpX * depth * 0.3, y: threeQuarterY + perpY * depth * 0.3 },
    end
  ];
}

// Apply merge paths at ALL direction changes (any curve)
function applyMergePaths(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 6) return points;
  
  const result: ContourPoint[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.5 && len2 > 0.5) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Apply to ANY direction change (more than 15 degrees)
      if (angle > Math.PI / 12) {
        // Scale depth based on turn sharpness - small turns get small curves, sharp turns get larger
        const sharpness = angle / Math.PI;
        const baseDepth = Math.min(len1, len2) * 0.4;
        const depth = Math.max(1, baseDepth * (0.3 + sharpness * 0.7));
        
        if (cross < 0) {
          // Concave turn (inward) - use N shape
          const mergePoints = generateNShape(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        } else if (cross > 0) {
          // Convex turn (outward) - use U shape
          const mergePoints = generateUShape(prev, next, depth);
          for (let m = 1; m < mergePoints.length - 1; m++) {
            result.push(mergePoints[m]);
          }
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Remove points that overshoot or stick out beyond the smooth path
function removeOvershootingPoints(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 5) return points;
  
  // First pass: detect and unite crossing junctions
  let result = uniteJunctions(points);
  
  // Second pass: remove remaining spikes
  result = removeSpikesFromPath(result);
  
  return result.length >= 3 ? result : points;
}

// Detect where path segments cross or nearly touch and unite them
function uniteJunctions(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 8) return points;
  
  // First pass: detect sharp turns that need U/N merge shapes
  let result = detectAndMergeSharpTurns(points);
  
  // Second pass: detect close proximity junctions
  result = detectProximityJunctions(result);
  
  return result;
}

// Detect sharp turns (>45 degrees) and apply U/N merge shapes
function detectAndMergeSharpTurns(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 6) return points;
  
  const result: ContourPoint[] = [];
  const n = points.length;
  
  let i = 0;
  while (i < n) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const next2 = points[(i + 2) % n];
    
    const v1x = curr.x - prev.x;
    const v1y = curr.y - prev.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    
    const len1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const len2 = Math.sqrt(v2x * v2x + v2y * v2y);
    
    if (len1 > 0.1 && len2 > 0.1) {
      const dot = (v1x * v2x + v1y * v2y) / (len1 * len2);
      const cross = v1x * v2y - v1y * v2x;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      
      // Sharp turn detected (more than 45 degrees) - ALWAYS apply merge
      if (angle > Math.PI / 4) {
        const sharpness = angle / Math.PI;
        // Use larger depth for sharper turns to ensure proper merge
        const depth = Math.max(3, Math.min(len1, len2) * sharpness * 0.6);
        
        if (cross < 0) {
          // Concave (inward) - N shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = (next.y - curr.y) / len2;
          const perpY = -(next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        } else {
          // Convex (outward) - U shape merge
          const midX = (curr.x + next.x) / 2;
          const midY = (curr.y + next.y) / 2;
          const perpX = -(next.y - curr.y) / len2;
          const perpY = (next.x - curr.x) / len2;
          
          result.push({ x: midX + perpX * depth * 0.4, y: midY + perpY * depth * 0.4 });
          i++;
          continue;
        }
      }
    }
    
    result.push(curr);
    i++;
  }
  
  return result.length >= 3 ? result : points;
}

// Detect points that are close in space but far in path order
function detectProximityJunctions(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 8) return points;
  
  const n = points.length;
  const result: ContourPoint[] = [];
  const skipIndices = new Set<number>();
  
  for (let i = 0; i < n; i++) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    let foundJunction = false;
    
    // Increased search range and decreased distance threshold for tighter detection
    for (let j = i + 4; j < Math.min(i + 60, n); j++) {
      const pathDist = j - i;
      if (pathDist < 4) continue;
      
      const pj = points[j];
      const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
      
      // Much tighter detection - within 12 pixels now (was 8)
      if (dist < 12) {
        // Skip all points in the loop
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        
        // Create smooth merge at junction center
        const mergePoint = { x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 };
        result.push(mergePoint);
        foundJunction = true;
        break;
      }
    }
    
    if (!foundJunction) {
      result.push(pi);
    }
  }
  
  return result;
}

// Remove individual spike points
function removeSpikesFromPath(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 5) return points;
  
  const result: ContourPoint[] = [];
  const n = points.length;
  
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    
    const lineX = next.x - prev.x;
    const lineY = next.y - prev.y;
    const lineLen = Math.sqrt(lineX * lineX + lineY * lineY);
    
    if (lineLen > 0) {
      const toPointX = curr.x - prev.x;
      const toPointY = curr.y - prev.y;
      const cross = Math.abs(lineX * toPointY - lineY * toPointX) / lineLen;
      
      // Skip if point sticks out too far
      if (cross > 12) {
        continue;
      }
    }
    
    result.push(curr);
  }
  
  return result;
}

function applyIntelligentOffset(
  contour: ContourPoint[], 
  offset: number, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): ContourPoint[] {
  if (contour.length === 0) return [];
  
  let offsetContour: ContourPoint[] = [];
  
  for (let i = 0; i < contour.length; i++) {
    const point = contour[i];
    const prev = contour[(i - 1 + contour.length) % contour.length];
    const next = contour[(i + 1) % contour.length];
    
    // Calculate outward normal vector
    const dx1 = point.x - prev.x;
    const dy1 = point.y - prev.y;
    const dx2 = next.x - point.x;
    const dy2 = next.y - point.y;
    
    // Average direction
    const avgDx = (dx1 + dx2) / 2;
    const avgDy = (dy1 + dy2) / 2;
    
    // Perpendicular vector (outward normal)
    const normalX = -avgDy;
    const normalY = avgDx;
    
    // Normalize
    const length = Math.sqrt(normalX * normalX + normalY * normalY) || 1;
    const unitNormalX = normalX / length;
    const unitNormalY = normalY / length;
    
    // Apply offset with boundary checking
    let actualOffset = offset;
    
    // Check for collision with other solid content
    for (let testOffset = 1; testOffset <= offset; testOffset++) {
      const testX = Math.round(point.x + unitNormalX * testOffset);
      const testY = Math.round(point.y + unitNormalY * testOffset);
      
      // Check bounds
      if (testX < 0 || testX >= width || testY < 0 || testY >= height) {
        actualOffset = testOffset - 1;
        break;
      }
      
      // Check for collision with solid content
      const testIdx = (testY * width + testX) * 4;
      const testAlpha = data[testIdx + 3];
      
      if (testAlpha > 50) {
        actualOffset = Math.max(1, testOffset - 2);
        break;
      }
    }
    
    const offsetX = Math.round(point.x + unitNormalX * actualOffset);
    const offsetY = Math.round(point.y + unitNormalY * actualOffset);
    
    offsetContour.push({ 
      x: Math.max(0, Math.min(width - 1, offsetX)), 
      y: Math.max(0, Math.min(height - 1, offsetY)) 
    });
  }
  
  // CRITICAL: Apply junction detection and merging AFTER offset is applied
  // This is where crossings happen at sharp corners
  offsetContour = fixOffsetCrossings(offsetContour);
  
  return offsetContour;
}

// Fix crossings that occur in offset contours at sharp corners
function fixOffsetCrossings(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 6) return points;
  
  let result = [...points];
  
  // Multiple passes to catch all crossings
  for (let pass = 0; pass < 3; pass++) {
    result = detectAndFixCrossings(result);
    result = mergeClosePoints(result);
  }
  
  return result;
}

// Detect where lines actually cross and fix them
function detectAndFixCrossings(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: ContourPoint[] = [];
  const skipUntil = new Map<number, number>();
  
  for (let i = 0; i < n; i++) {
    // Check if we should skip this point
    let shouldSkip = false;
    for (const [start, end] of skipUntil.entries()) {
      if (i > start && i < end) {
        shouldSkip = true;
        break;
      }
    }
    if (shouldSkip) continue;
    
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    
    // Check for intersection with ALL non-adjacent segments (full path scan)
    for (let j = i + 3; j < n - 1; j++) {
      const p3 = points[j];
      const p4 = points[(j + 1) % n];
      
      const intersection = lineIntersection(p1, p2, p3, p4);
      if (intersection) {
        // Found a crossing - skip the loop between them and add merge point
        skipUntil.set(i, j);
        result.push(intersection);
        break;
      }
    }
    
    if (!skipUntil.has(i)) {
      result.push(p1);
    }
  }
  
  return result.length >= 3 ? result : points;
}

// Check if two line segments intersect
function lineIntersection(p1: ContourPoint, p2: ContourPoint, p3: ContourPoint, p4: ContourPoint): ContourPoint | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  if (Math.abs(cross) < 0.0001) return null; // Parallel
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  // Check if intersection is within both segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

// Merge points that are very close together (indicating a near-crossing)
function mergeClosePoints(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 6) return points;
  
  const n = points.length;
  const result: ContourPoint[] = [];
  const skipIndices = new Set<number>();
  
  for (let i = 0; i < n; i++) {
    if (skipIndices.has(i)) continue;
    
    const pi = points[i];
    
    // Search the ENTIRE path, not just 80 points ahead
    for (let j = i + 3; j < n; j++) {
      if (skipIndices.has(j)) continue;
      
      const pj = points[j];
      const dist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2);
      
      // Increased threshold to catch all near-crossings
      if (dist < 10) {
        // Skip all points between i and j
        for (let k = i + 1; k < j; k++) {
          skipIndices.add(k);
        }
        // Add merge point
        result.push({ x: (pi.x + pj.x) / 2, y: (pi.y + pj.y) / 2 });
        skipIndices.add(j);
        break;
      }
    }
    
    if (!skipIndices.has(i)) {
      result.push(pi);
    }
  }
  
  return result.length >= 3 ? result : points;
}

interface ImageRegion {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  pixels: ContourPoint[];
}

function findSeparateRegions(data: Uint8ClampedArray, width: number, height: number): ImageRegion[] {
  const visited = new Set<string>();
  const regions: ImageRegion[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      const key = `${x},${y}`;
      
      if (alpha > 50 && !visited.has(key)) {
        // Found a new region - flood fill to find all connected pixels
        const region = floodFillRegion(data, width, height, x, y, visited);
        if (region.pixels.length > 10) { // Minimum region size
          regions.push(region);
        }
      }
    }
  }
  
  return regions;
}

function floodFillRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  visited: Set<string>
): ImageRegion {
  const stack: ContourPoint[] = [{ x: startX, y: startY }];
  const pixels: ContourPoint[] = [];
  let minX = startX, maxX = startX, minY = startY, maxY = startY;
  
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    const key = `${x},${y}`;
    
    if (x < 0 || x >= width || y < 0 || y >= height || visited.has(key)) {
      continue;
    }
    
    const idx = (y * width + x) * 4;
    const alpha = data[idx + 3];
    
    if (alpha <= 50) continue; // Not visible
    
    visited.add(key);
    pixels.push({ x, y });
    
    // Update bounding box
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    
    // Add 4-connected neighbors
    stack.push({ x: x + 1, y });
    stack.push({ x: x - 1, y });
    stack.push({ x, y: y + 1 });
    stack.push({ x, y: y - 1 });
  }
  
  return { minX, maxX, minY, maxY, pixels };
}

function mergeRegionsWithIntelligentOutlines(
  regions: ImageRegion[], 
  strokeSettings: StrokeSettings, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): ContourPoint[] {
  if (regions.length === 0) return [];
  
  // For merged regions, we want to create a single encompassing outline
  // that can grow outward freely since it's the exterior boundary
  const offset = strokeSettings.width / 100 * 5;
  
  // Find overall bounding box of all regions
  let globalMinX = regions[0].minX;
  let globalMaxX = regions[0].maxX;
  let globalMinY = regions[0].minY;
  let globalMaxY = regions[0].maxY;
  
  for (const region of regions) {
    globalMinX = Math.min(globalMinX, region.minX);
    globalMaxX = Math.max(globalMaxX, region.maxX);
    globalMinY = Math.min(globalMinY, region.minY);
    globalMaxY = Math.max(globalMaxY, region.maxY);
  }
  
  // Create exterior outline that can grow freely
  return [
    { x: Math.max(0, globalMinX - offset), y: Math.max(0, globalMinY - offset) },
    { x: Math.min(width - 1, globalMaxX + offset), y: Math.max(0, globalMinY - offset) },
    { x: Math.min(width - 1, globalMaxX + offset), y: Math.min(height - 1, globalMaxY + offset) },
    { x: Math.max(0, globalMinX - offset), y: Math.min(height - 1, globalMaxY + offset) },
    { x: Math.max(0, globalMinX - offset), y: Math.max(0, globalMinY - offset) }
  ];
}

function createIntelligentOutline(
  region: ImageRegion, 
  strokeSettings: StrokeSettings, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): ContourPoint[] {
  const baseOffset = strokeSettings.width / 100 * 5;
  
  // Check if this region is surrounded by other content (interior) or touches edges (exterior)
  const isInteriorRegion = checkIfInteriorRegion(region, data, width, height);
  
  if (isInteriorRegion) {
    // For interior regions, calculate constrained outline that stops when it hits other content
    return createConstrainedOutline(region, baseOffset, data, width, height);
  } else {
    // For exterior regions, allow free growth
    return createFreeGrowthOutline(region, baseOffset, width, height);
  }
}

function checkIfInteriorRegion(
  region: ImageRegion, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): boolean {
  // Check if region touches image boundaries - if so, it's exterior
  if (region.minX <= 5 || region.maxX >= width - 5 || 
      region.minY <= 5 || region.maxY >= height - 5) {
    return false; // Touches edges, so it's exterior
  }
  
  // Check if region is surrounded by other solid content
  const checkRadius = 20; // Look around the region
  let surroundingPixels = 0;
  let solidPixels = 0;
  
  for (let y = Math.max(0, region.minY - checkRadius); 
       y <= Math.min(height - 1, region.maxY + checkRadius); y++) {
    for (let x = Math.max(0, region.minX - checkRadius); 
         x <= Math.min(width - 1, region.maxX + checkRadius); x++) {
      
      // Skip if inside the region itself
      if (x >= region.minX && x <= region.maxX && y >= region.minY && y <= region.maxY) {
        continue;
      }
      
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      surroundingPixels++;
      if (alpha > 50) {
        solidPixels++;
      }
    }
  }
  
  // If more than 30% of surrounding area is solid, consider it interior
  return surroundingPixels > 0 && (solidPixels / surroundingPixels) > 0.3;
}

function createConstrainedOutline(
  region: ImageRegion, 
  baseOffset: number, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): ContourPoint[] {
  // For interior regions, calculate how much we can grow in each direction
  // before hitting other solid content
  
  const maxGrowthLeft = calculateMaxGrowth(region, 'left', baseOffset, data, width, height);
  const maxGrowthRight = calculateMaxGrowth(region, 'right', baseOffset, data, width, height);
  const maxGrowthTop = calculateMaxGrowth(region, 'top', baseOffset, data, width, height);
  const maxGrowthBottom = calculateMaxGrowth(region, 'bottom', baseOffset, data, width, height);
  
  return [
    { x: region.minX - maxGrowthLeft, y: region.minY - maxGrowthTop },
    { x: region.maxX + maxGrowthRight, y: region.minY - maxGrowthTop },
    { x: region.maxX + maxGrowthRight, y: region.maxY + maxGrowthBottom },
    { x: region.minX - maxGrowthLeft, y: region.maxY + maxGrowthBottom },
    { x: region.minX - maxGrowthLeft, y: region.minY - maxGrowthTop }
  ];
}

function calculateMaxGrowth(
  region: ImageRegion, 
  direction: 'left' | 'right' | 'top' | 'bottom', 
  requestedOffset: number, 
  data: Uint8ClampedArray, 
  width: number, 
  height: number
): number {
  let maxGrowth = requestedOffset;
  
  for (let distance = 1; distance <= requestedOffset; distance++) {
    let hitsSolid = false;
    
    if (direction === 'left') {
      const checkX = region.minX - distance;
      if (checkX < 0) {
        maxGrowth = distance - 1;
        break;
      }
      for (let y = region.minY; y <= region.maxY; y++) {
        const idx = (y * width + checkX) * 4;
        if (data[idx + 3] > 50) {
          hitsSolid = true;
          break;
        }
      }
    } else if (direction === 'right') {
      const checkX = region.maxX + distance;
      if (checkX >= width) {
        maxGrowth = distance - 1;
        break;
      }
      for (let y = region.minY; y <= region.maxY; y++) {
        const idx = (y * width + checkX) * 4;
        if (data[idx + 3] > 50) {
          hitsSolid = true;
          break;
        }
      }
    } else if (direction === 'top') {
      const checkY = region.minY - distance;
      if (checkY < 0) {
        maxGrowth = distance - 1;
        break;
      }
      for (let x = region.minX; x <= region.maxX; x++) {
        const idx = (checkY * width + x) * 4;
        if (data[idx + 3] > 50) {
          hitsSolid = true;
          break;
        }
      }
    } else if (direction === 'bottom') {
      const checkY = region.maxY + distance;
      if (checkY >= height) {
        maxGrowth = distance - 1;
        break;
      }
      for (let x = region.minX; x <= region.maxX; x++) {
        const idx = (checkY * width + x) * 4;
        if (data[idx + 3] > 50) {
          hitsSolid = true;
          break;
        }
      }
    }
    
    if (hitsSolid) {
      maxGrowth = Math.max(1, distance - 2); // Stop a bit before hitting solid content
      break;
    }
  }
  
  return maxGrowth;
}

function createFreeGrowthOutline(
  region: ImageRegion, 
  offset: number, 
  width: number, 
  height: number
): ContourPoint[] {
  // For exterior regions, allow full growth but respect image boundaries
  return [
    { x: Math.max(0, region.minX - offset), y: Math.max(0, region.minY - offset) },
    { x: Math.min(width - 1, region.maxX + offset), y: Math.max(0, region.minY - offset) },
    { x: Math.min(width - 1, region.maxX + offset), y: Math.min(height - 1, region.maxY + offset) },
    { x: Math.max(0, region.minX - offset), y: Math.min(height - 1, region.maxY + offset) },
    { x: Math.max(0, region.minX - offset), y: Math.max(0, region.minY - offset) }
  ];
}

function shouldUseSimpleRectangle(regions: ImageRegion[], mergeDistance: number): boolean {
  // Use simple rectangle if regions are relatively close or aligned
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const r1 = regions[i];
      const r2 = regions[j];
      
      // Check horizontal or vertical alignment
      const horizontalOverlap = Math.min(r1.maxY, r2.maxY) - Math.max(r1.minY, r2.minY);
      const verticalOverlap = Math.min(r1.maxX, r2.maxX) - Math.max(r1.minX, r2.minX);
      
      if (horizontalOverlap > 10 || verticalOverlap > 10) {
        return true; // Regions are aligned, use simple rectangle
      }
    }
  }
  
  return regions.length <= 2; // For 2 or fewer regions, use simple rectangle
}

function createConvexHullContour(regions: ImageRegion[], offset: number): ContourPoint[] {
  // Collect all corner points from all regions
  const allPoints: ContourPoint[] = [];
  
  for (const region of regions) {
    allPoints.push(
      { x: region.minX, y: region.minY },
      { x: region.maxX, y: region.minY },
      { x: region.maxX, y: region.maxY },
      { x: region.minX, y: region.maxY }
    );
  }
  
  // Calculate convex hull
  const hull = calculateConvexHull(allPoints);
  
  // Apply offset to hull points
  const center = calculateCentroid(hull);
  return hull.map(point => {
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const normalX = dx / length;
    const normalY = dy / length;
    
    return {
      x: Math.round(point.x + normalX * offset),
      y: Math.round(point.y + normalY * offset)
    };
  });
}

function calculateConvexHull(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 3) return points;
  
  // Simple gift wrapping algorithm for convex hull
  const hull: ContourPoint[] = [];
  
  // Find leftmost point
  let leftmost = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[leftmost].x || 
        (points[i].x === points[leftmost].x && points[i].y < points[leftmost].y)) {
      leftmost = i;
    }
  }
  
  let current = leftmost;
  do {
    hull.push(points[current]);
    let next = (current + 1) % points.length;
    
    for (let i = 0; i < points.length; i++) {
      const orientation = calculateOrientation(points[current], points[i], points[next]);
      if (orientation === 2) { // Counterclockwise
        next = i;
      }
    }
    
    current = next;
  } while (current !== leftmost);
  
  return hull;
}

function calculateOrientation(p: ContourPoint, q: ContourPoint, r: ContourPoint): number {
  const val = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
  if (val === 0) return 0; // Collinear
  return val > 0 ? 1 : 2; // Clockwise or Counterclockwise
}

function calculateCentroid(points: ContourPoint[]): ContourPoint {
  const sum = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  );
  return {
    x: sum.x / points.length,
    y: sum.y / points.length
  };
}

function drawSimpleOutline(ctx: CanvasRenderingContext2D, outline: ContourPoint[], strokeSettings: StrokeSettings): void {
  if (outline.length < 3) return;
  
  ctx.strokeStyle = strokeSettings.color;
  ctx.lineWidth = Math.max(1, strokeSettings.width / 100);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.beginPath();
  ctx.moveTo(outline[0].x, outline[0].y);
  
  for (let i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i].x, outline[i].y);
  }
  
  ctx.stroke();
}

function createSimpleContour(image: HTMLImageElement, strokeSettings: StrokeSettings): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  
  const padding = strokeSettings.width * 2;
  canvas.width = image.width + padding * 2;
  canvas.height = image.height + padding * 2;
  
  ctx.drawImage(image, padding, padding);
  return canvas;
}

function fillTransparentHoles(image: HTMLImageElement, threshold: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  
  canvas.width = image.width;
  canvas.height = image.height;
  
  // Draw white background first
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Extract image data to identify holes
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return canvas;
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const { data, width, height } = imageData;
  
  // Create filled image data
  const filledData = new Uint8ClampedArray(data.length);
  filledData.set(data);
  
  // Use flood fill algorithm to identify and fill interior gaps
  const visited = new Uint8Array(width * height);
  const isInteriorGap = new Uint8Array(width * height);
  
  // First pass: identify all transparent regions and classify them
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const pixelIdx = y * width + x;
      const currentAlpha = data[idx + 3];
      
      if (currentAlpha < threshold && !visited[pixelIdx]) {
        // Found an unvisited transparent region - flood fill to analyze it
        const region = floodFillRegion(data, width, height, x, y, threshold, visited);
        
        // Check if this region is an interior gap (surrounded by solid content)
        const isSurrounded = isRegionSurrounded(region, data, width, height, threshold);
        
        if (isSurrounded) {
          // Mark all pixels in this region as interior gaps
          for (const pixel of region) {
            isInteriorGap[pixel.y * width + pixel.x] = 1;
          }
        }
      }
    }
  }
  
  // Second pass: fill all identified interior gaps with white
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIdx = y * width + x;
      if (isInteriorGap[pixelIdx]) {
        const idx = (y * width + x) * 4;
        filledData[idx] = 255;     // R
        filledData[idx + 1] = 255; // G
        filledData[idx + 2] = 255; // B
        filledData[idx + 3] = 255; // A
      }
    }
  }
  
  // Create new image data and draw it
  const filledImageData = new ImageData(filledData, width, height);
  ctx.putImageData(filledImageData, 0, 0);
  
  return canvas;
}

function addTextBackground(image: HTMLImageElement, threshold: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  
  canvas.width = image.width;
  canvas.height = image.height;
  
  // Extract image data to analyze text structure
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return canvas;
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const { data, width, height } = imageData;
  
  // Find the bounding box of all visible content
  let minX = width, maxX = 0, minY = height, maxY = 0;
  let hasContent = false;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      if (alpha >= threshold) {
        hasContent = true;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  if (!hasContent) {
    // If no content, return original image
    ctx.drawImage(image, 0, 0);
    return canvas;
  }
  
  // Add padding around the content bounding box
  const padding = Math.max(8, Math.min(width, height) * 0.02); // 2% of smallest dimension, minimum 8px
  const bgMinX = Math.max(0, minX - padding);
  const bgMaxX = Math.min(width - 1, maxX + padding);
  const bgMinY = Math.max(0, minY - padding);
  const bgMaxY = Math.min(height - 1, maxY + padding);
  
  // Create new image data with white background
  const newData = new Uint8ClampedArray(data.length);
  
  // Copy original data
  newData.set(data);
  
  // Add white background in the bounding box area
  for (let y = bgMinY; y <= bgMaxY; y++) {
    for (let x = bgMinX; x <= bgMaxX; x++) {
      const idx = (y * width + x) * 4;
      
      // If pixel is transparent, make it white
      if (data[idx + 3] < threshold) {
        newData[idx] = 255;     // R
        newData[idx + 1] = 255; // G
        newData[idx + 2] = 255; // B
        newData[idx + 3] = 255; // A
      }
    }
  }
  
  // Create new image data and draw it
  const newImageData = new ImageData(newData, width, height);
  ctx.putImageData(newImageData, 0, 0);
  
  return canvas;
}



function isRegionSurrounded(
  region: Array<{x: number, y: number}>,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean {
  // Check if any pixel in the region touches the image boundary
  for (const {x, y} of region) {
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      return false; // Region touches boundary, so it's not an interior gap
    }
  }
  
  // Check if the region is surrounded by solid content
  // We'll sample points around the region's perimeter
  const perimeter = new Set<string>();
  
  for (const {x, y} of region) {
    // Check 8-directional neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        
        const nx = x + dx;
        const ny = y + dy;
        
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = (ny * width + nx) * 4;
          const nAlpha = data[nIdx + 3];
          
          if (nAlpha >= threshold) {
            perimeter.add(`${nx},${ny}`);
          }
        }
      }
    }
  }
  
  // If we found solid pixels around the region and the region doesn't touch boundaries,
  // and the perimeter has sufficient solid content, consider it surrounded
  const regionSize = region.length;
  const perimeterSize = perimeter.size;
  
  // Require a minimum ratio of perimeter to region size for robust detection
  return perimeterSize > 0 && (perimeterSize >= Math.min(regionSize * 0.3, 50));
}

function generateTrueContourPaths(
  image: HTMLImageElement,
  threshold: number,
  smoothing: number,
  includeHoles: boolean,
  holeMargin: number
): ContourPoint[][] {
  try {
    // Simple CadCut-style outline generation
    return generateCadCutOutline(image, threshold, smoothing);
  } catch (error) {
    console.error('Error generating cadcut outline:', error);
    return [];
  }
}

function generateCadCutOutline(
  image: HTMLImageElement,
  threshold: number,
  outlineWidth: number
): ContourPoint[][] {
  // Simple CadCut-style outline generation
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return [];
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
  tempCtx.drawImage(image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const { data, width, height } = imageData;
  
  // Step 1: Create simple binary mask
  const binaryMask = createSimpleBinaryMask(data, width, height, threshold);
  
  // Step 2: Find edge pixels
  const edgePixels = findEdgePixels(binaryMask, width, height);
  
  if (edgePixels.length === 0) return [];
  
  // Step 3: Apply simple offset
  const offsetPixels = applySimpleOffset(edgePixels, Math.max(1, outlineWidth / 20));
  
  // Step 4: Connect pixels into contour
  const contour = connectPixelsToContour(offsetPixels);
  
  return contour.length > 3 ? [contour] : [];
}

function createSimpleBinaryMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean[][] {
  const mask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      mask[y][x] = alpha >= threshold;
    }
  }
  
  return mask;
}

function findEdgePixels(
  mask: boolean[][],
  width: number,
  height: number
): ContourPoint[] {
  const edgePixels: ContourPoint[] = [];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (mask[y][x]) {
        // Check if this pixel is on the edge
        const neighbors = [
          mask[y-1][x], mask[y+1][x], // top, bottom
          mask[y][x-1], mask[y][x+1], // left, right
        ];
        
        if (neighbors.some(n => !n)) {
          edgePixels.push({ x, y });
        }
      }
    }
  }
  
  return edgePixels;
}

function applySimpleOffset(
  edgePixels: ContourPoint[],
  offsetDistance: number
): ContourPoint[] {
  if (edgePixels.length === 0) return [];
  
  const offsetPixels: ContourPoint[] = [];
  
  // Find the center of the shape
  const centerX = edgePixels.reduce((sum, p) => sum + p.x, 0) / edgePixels.length;
  const centerY = edgePixels.reduce((sum, p) => sum + p.y, 0) / edgePixels.length;
  
  for (const pixel of edgePixels) {
    // Calculate outward vector from center
    const dx = pixel.x - centerX;
    const dy = pixel.y - centerY;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    
    // Normalize and apply offset
    const normalX = dx / length;
    const normalY = dy / length;
    
    const offsetX = pixel.x + normalX * offsetDistance;
    const offsetY = pixel.y + normalY * offsetDistance;
    
    offsetPixels.push({
      x: Math.round(offsetX),
      y: Math.round(offsetY)
    });
  }
  
  return offsetPixels;
}

function connectPixelsToContour(pixels: ContourPoint[]): ContourPoint[] {
  if (pixels.length === 0) return [];
  
  // Find the center of the shape
  const centerX = pixels.reduce((sum, p) => sum + p.x, 0) / pixels.length;
  const centerY = pixels.reduce((sum, p) => sum + p.y, 0) / pixels.length;
  
  // Sort pixels by angle from center to create a closed contour
  const sortedPixels = pixels.slice().sort((a, b) => {
    const angleA = Math.atan2(a.y - centerY, a.x - centerX);
    const angleB = Math.atan2(b.y - centerY, b.x - centerX);
    return angleA - angleB;
  });
  
  // Apply simple smoothing
  const smoothed: ContourPoint[] = [];
  for (let i = 0; i < sortedPixels.length; i++) {
    const prev = sortedPixels[(i - 1 + sortedPixels.length) % sortedPixels.length];
    const curr = sortedPixels[i];
    const next = sortedPixels[(i + 1) % sortedPixels.length];
    
    // Simple averaging for smoothing
    smoothed.push({
      x: Math.round((prev.x + curr.x + next.x) / 3),
      y: Math.round((prev.y + curr.y + next.y) / 3)
    });
  }
  
  return smoothed;
}

function createBordifyBinaryMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean[][] {
  const mask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // Bordify uses adaptive thresholding with local statistics
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      // Apply local adaptive threshold (Bordify's method)
      let localThreshold = threshold;
      if (alpha > 0 && alpha < 255) {
        // Check local neighborhood for better edge detection
        let neighborSum = 0;
        let neighborCount = 0;
        
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const ny = y + dy;
            const nx = x + dx;
            if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
              const nIdx = (ny * width + nx) * 4;
              neighborSum += data[nIdx + 3];
              neighborCount++;
            }
          }
        }
        
        const localMean = neighborSum / neighborCount;
        localThreshold = Math.max(threshold * 0.5, localMean * 0.8);
      }
      
      mask[y][x] = alpha >= localThreshold;
    }
  }
  
  return mask;
}

function morphologicalClosing(
  mask: boolean[][],
  width: number,
  height: number,
  kernelSize: number
): boolean[][] {
  // Bordify uses closing (dilation followed by erosion) to fill gaps
  const dilated = morphologicalDilation(mask, width, height, kernelSize);
  return morphologicalErosion(dilated, width, height, kernelSize);
}

function morphologicalDilation(
  mask: boolean[][],
  width: number,
  height: number,
  kernelSize: number
): boolean[][] {
  const result: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  const radius = Math.floor(kernelSize / 2);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hasTrue = false;
      
      for (let dy = -radius; dy <= radius && !hasTrue; dy++) {
        for (let dx = -radius; dx <= radius && !hasTrue; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (mask[ny][nx]) {
              hasTrue = true;
            }
          }
        }
      }
      
      result[y][x] = hasTrue;
    }
  }
  
  return result;
}

function morphologicalErosion(
  mask: boolean[][],
  width: number,
  height: number,
  kernelSize: number
): boolean[][] {
  const result: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  const radius = Math.floor(kernelSize / 2);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let allTrue = true;
      
      for (let dy = -radius; dy <= radius && allTrue; dy++) {
        for (let dx = -radius; dx <= radius && allTrue; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            if (!mask[ny][nx]) {
              allTrue = false;
            }
          } else {
            allTrue = false; // Treat boundary as false
          }
        }
      }
      
      result[y][x] = allTrue;
    }
  }
  
  return result;
}

function calculateDistanceTransform(
  mask: boolean[][],
  width: number,
  height: number
): number[][] {
  // Bordify uses Euclidean distance transform for precise offsetting
  const distances: number[][] = Array(height).fill(null).map(() => Array(width).fill(Infinity));
  
  // Initialize distances for foreground pixels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y][x]) {
        distances[y][x] = 0;
      }
    }
  }
  
  // Forward pass
  for (let y = 1; y < height; y++) {
    for (let x = 1; x < width; x++) {
      if (!mask[y][x]) {
        distances[y][x] = Math.min(
          distances[y][x],
          distances[y-1][x] + 1,
          distances[y][x-1] + 1,
          distances[y-1][x-1] + Math.sqrt(2)
        );
      }
    }
  }
  
  // Backward pass
  for (let y = height - 2; y >= 0; y--) {
    for (let x = width - 2; x >= 0; x--) {
      if (!mask[y][x]) {
        distances[y][x] = Math.min(
          distances[y][x],
          distances[y+1][x] + 1,
          distances[y][x+1] + 1,
          distances[y+1][x+1] + Math.sqrt(2)
        );
      }
    }
  }
  
  return distances;
}

function extractLevelSet(
  distanceField: number[][],
  width: number,
  height: number,
  targetDistance: number
): boolean[][] {
  // Extract pixels at specific distance (Bordify's level set method)
  const levelSet: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = distanceField[y][x];
      
      // Check if this pixel is at the target distance (with tolerance)
      if (Math.abs(distance - targetDistance) <= 0.5) {
        levelSet[y][x] = true;
      }
    }
  }
  
  return levelSet;
}

function traceBordifyContours(
  mask: boolean[][],
  width: number,
  height: number
): ContourPoint[][] {
  // Bordify's chain code contour tracing
  const contours: ContourPoint[][] = [];
  const visited: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // 8-directional chain code (Bordify standard)
  const directions = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1]
  ];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y][x] && !visited[y][x]) {
        const contour = traceSingleBordifyContour(mask, visited, x, y, width, height, directions);
        if (contour.length > 8) { // Minimum contour size
          contours.push(contour);
        }
      }
    }
  }
  
  return contours;
}

function traceSingleBordifyContour(
  mask: boolean[][],
  visited: boolean[][],
  startX: number,
  startY: number,
  width: number,
  height: number,
  directions: number[][]
): ContourPoint[] {
  const contour: ContourPoint[] = [];
  let currentX = startX;
  let currentY = startY;
  let directionIndex = 0;
  
  do {
    visited[currentY][currentX] = true;
    contour.push({ x: currentX, y: currentY });
    
    // Find next boundary pixel using Bordify's chain code method
    let found = false;
    for (let i = 0; i < 8; i++) {
      const searchDir = (directionIndex + i) % 8;
      const [dx, dy] = directions[searchDir];
      const nextX = currentX + dx;
      const nextY = currentY + dy;
      
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height && 
          mask[nextY][nextX] && !visited[nextY][nextX]) {
        currentX = nextX;
        currentY = nextY;
        directionIndex = (searchDir + 6) % 8; // Turn left (Bordify method)
        found = true;
        break;
      }
    }
    
    if (!found) break;
    
  } while (contour.length < 5000 && (currentX !== startX || currentY !== startY || contour.length < 3));
  
  return contour;
}

function applyBordifySmoothing(contour: ContourPoint[]): ContourPoint[] {
  if (contour.length < 4) return contour;
  
  // Bordify uses B-spline approximation for smooth curves
  const smoothed: ContourPoint[] = [];
  
  for (let i = 0; i < contour.length; i++) {
    const p0 = contour[(i - 1 + contour.length) % contour.length];
    const p1 = contour[i];
    const p2 = contour[(i + 1) % contour.length];
    const p3 = contour[(i + 2) % contour.length];
    
    // Cubic B-spline interpolation (Bordify's smoothing method)
    const t = 0.5; // Interpolation parameter
    const smoothedPoint = {
      x: Math.round(
        (1-t)**3 * p0.x + 
        3*(1-t)**2*t * p1.x + 
        3*(1-t)*t**2 * p2.x + 
        t**3 * p3.x
      ),
      y: Math.round(
        (1-t)**3 * p0.y + 
        3*(1-t)**2*t * p1.y + 
        3*(1-t)*t**2 * p2.y + 
        t**3 * p3.y
      )
    };
    
    smoothed.push(smoothedPoint);
  }
  
  return smoothed;
}

function createVisibilityMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean[][] {
  const mask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      mask[y][x] = alpha >= threshold;
    }
  }
  
  return mask;
}

function findTightBoundary(
  mask: boolean[][],
  width: number,
  height: number
): ContourPoint[] {
  // Find all edge pixels that border visible content
  const edgePixels: ContourPoint[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y][x]) {
        // Check if this visible pixel is on the edge
        let isEdge = false;
        
        // Check 8-directional neighbors
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            
            const nx = x + dx;
            const ny = y + dy;
            
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || !mask[ny][nx]) {
              isEdge = true;
              break;
            }
          }
          if (isEdge) break;
        }
        
        if (isEdge) {
          edgePixels.push({ x, y });
        }
      }
    }
  }
  
  // Sort edge pixels to form connected boundary
  return createConnectedBoundary(edgePixels);
}

function createConnectedBoundary(edgePixels: ContourPoint[]): ContourPoint[] {
  if (edgePixels.length === 0) return [];
  
  // Start with leftmost pixel
  let startPixel = edgePixels[0];
  for (const pixel of edgePixels) {
    if (pixel.x < startPixel.x || (pixel.x === startPixel.x && pixel.y < startPixel.y)) {
      startPixel = pixel;
    }
  }
  
  const boundary: ContourPoint[] = [startPixel];
  const remaining = new Set(edgePixels.filter(p => p !== startPixel));
  
  while (remaining.size > 0 && boundary.length < edgePixels.length) {
    const current = boundary[boundary.length - 1];
    let closest: ContourPoint | null = null;
    let minDistance = Infinity;
    
    // Find nearest unvisited edge pixel
    for (const pixel of remaining) {
      const distance = Math.sqrt((pixel.x - current.x) ** 2 + (pixel.y - current.y) ** 2);
      if (distance < minDistance) {
        minDistance = distance;
        closest = pixel;
      }
    }
    
    if (closest && minDistance <= 3) { // Connect nearby pixels
      boundary.push(closest);
      remaining.delete(closest);
    } else {
      break; // No more connected pixels
    }
  }
  
  return boundary;
}

function createSmoothOutline(
  boundary: ContourPoint[],
  offsetPixels: number
): ContourPoint[] {
  if (boundary.length < 3) return boundary;
  
  // Step 1: Apply smoothing to reduce jagged edges
  const smoothed = applySmoothingFilter(boundary);
  
  // Step 2: Apply outward offset
  const offset = applyOutwardOffset(smoothed, offsetPixels);
  
  // Step 3: Final smoothing for cutting machine compatibility
  return applyFinalSmoothing(offset);
}

function applySmoothingFilter(points: ContourPoint[]): ContourPoint[] {
  const smoothed: ContourPoint[] = [];
  const windowSize = 2;
  
  for (let i = 0; i < points.length; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + points.length) % points.length;
      sumX += points[idx].x;
      sumY += points[idx].y;
      count++;
    }
    
    smoothed.push({
      x: sumX / count,
      y: sumY / count
    });
  }
  
  return smoothed;
}

function applyOutwardOffset(
  points: ContourPoint[],
  offsetPixels: number
): ContourPoint[] {
  const offset: ContourPoint[] = [];
  
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    
    // Calculate outward normal vector
    const v1 = { x: curr.x - prev.x, y: curr.y - prev.y };
    const v2 = { x: next.x - curr.x, y: next.y - curr.y };
    
    // Normalize vectors
    const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y) || 1;
    const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y) || 1;
    
    v1.x /= len1; v1.y /= len1;
    v2.x /= len2; v2.y /= len2;
    
    // Calculate perpendicular vectors (outward normals)
    const n1 = { x: -v1.y, y: v1.x };
    const n2 = { x: -v2.y, y: v2.x };
    
    // Average normal for smooth offset
    const avgNormal = {
      x: (n1.x + n2.x) / 2,
      y: (n1.y + n2.y) / 2
    };
    
    // Normalize average normal
    const avgLen = Math.sqrt(avgNormal.x * avgNormal.x + avgNormal.y * avgNormal.y) || 1;
    avgNormal.x /= avgLen;
    avgNormal.y /= avgLen;
    
    // Apply offset outward
    offset.push({
      x: curr.x + avgNormal.x * offsetPixels,
      y: curr.y + avgNormal.y * offsetPixels
    });
  }
  
  return offset;
}

function applyFinalSmoothing(points: ContourPoint[]): ContourPoint[] {
  // Apply Bezier-like smoothing for cutting machine optimization
  const finalSmoothed: ContourPoint[] = [];
  
  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + points.length) % points.length];
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];
    const p3 = points[(i + 2) % points.length];
    
    // Catmull-Rom spline interpolation for smooth curves
    const smoothed = {
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * 0.5 + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * 0.25),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * 0.5 + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * 0.25)
    };
    
    finalSmoothed.push({
      x: Math.round(smoothed.x),
      y: Math.round(smoothed.y)
    });
  }
  
  return finalSmoothed;
}

function ensureClosedPath(points: ContourPoint[]): ContourPoint[] {
  if (points.length < 3) return points;
  
  // Ensure path is closed by connecting last point to first
  const first = points[0];
  const last = points[points.length - 1];
  
  if (Math.sqrt((first.x - last.x) ** 2 + (first.y - last.y) ** 2) > 2) {
    // Add closing point if needed
    return [...points, first];
  }
  
  return points;
}

function rasterToVectorConversion(image: HTMLImageElement, threshold: number): ContourPoint[][] {
  // Convert raster to vector using Potrace-like algorithm
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return [];
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const { data, width, height } = imageData;
  
  // Step 1: Create binary bitmap
  const bitmap = createBinaryBitmap(data, width, height, threshold);
  
  // Step 2: Find connected components (like Flexi does)
  const components = findConnectedComponents(bitmap, width, height);
  
  // Step 3: Convert each component to smooth vector paths
  return components.map(component => componentToVectorPath(component, width, height));
}

function createBinaryBitmap(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean[][] {
  const bitmap: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      bitmap[y][x] = alpha >= threshold;
    }
  }
  
  return bitmap;
}

function findConnectedComponents(
  bitmap: boolean[][],
  width: number,
  height: number
): Array<Array<{x: number, y: number}>> {
  const visited: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  const components: Array<Array<{x: number, y: number}>> = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[y][x] && !visited[y][x]) {
        const component = floodFillComponent(bitmap, visited, x, y, width, height);
        if (component.length > 50) { // Minimum component size
          components.push(component);
        }
      }
    }
  }
  
  return components;
}

function floodFillComponent(
  bitmap: boolean[][],
  visited: boolean[][],
  startX: number,
  startY: number,
  width: number,
  height: number
): Array<{x: number, y: number}> {
  const component: Array<{x: number, y: number}> = [];
  const stack: Array<{x: number, y: number}> = [{x: startX, y: startY}];
  
  while (stack.length > 0) {
    const {x, y} = stack.pop()!;
    
    if (x < 0 || x >= width || y < 0 || y >= height || visited[y][x] || !bitmap[y][x]) {
      continue;
    }
    
    visited[y][x] = true;
    component.push({x, y});
    
    // 4-connected neighbors
    stack.push({x: x + 1, y});
    stack.push({x: x - 1, y});
    stack.push({x, y: y + 1});
    stack.push({x, y: y - 1});
  }
  
  return component;
}

function componentToVectorPath(
  component: Array<{x: number, y: number}>,
  width: number,
  height: number
): ContourPoint[] {
  if (component.length === 0) return [];
  
  // Find boundary pixels of the component
  const boundaryPixels = findComponentBoundary(component, width, height);
  
  // Convert boundary to smooth vector path using Bezier approximation
  return boundaryToSmoothPath(boundaryPixels);
}

function findComponentBoundary(
  component: Array<{x: number, y: number}>,
  width: number,
  height: number
): ContourPoint[] {
  const componentSet = new Set(component.map(p => `${p.x},${p.y}`));
  const boundary: ContourPoint[] = [];
  
  for (const pixel of component) {
    const {x, y} = pixel;
    
    // Check if this pixel is on the boundary (has at least one non-component neighbor)
    let isBoundary = false;
    const directions = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || 
          !componentSet.has(`${nx},${ny}`)) {
        isBoundary = true;
        break;
      }
    }
    
    if (isBoundary) {
      boundary.push({x, y});
    }
  }
  
  // Sort boundary pixels to form a connected path
  return sortBoundaryPixels(boundary);
}

function sortBoundaryPixels(boundary: ContourPoint[]): ContourPoint[] {
  if (boundary.length === 0) return [];
  
  const sorted: ContourPoint[] = [boundary[0]];
  const remaining = new Set(boundary.slice(1));
  
  while (remaining.size > 0) {
    const current = sorted[sorted.length - 1];
    let closest: ContourPoint | null = null;
    let minDistance = Infinity;
    
    for (const pixel of remaining) {
      const distance = Math.sqrt((pixel.x - current.x) ** 2 + (pixel.y - current.y) ** 2);
      if (distance < minDistance) {
        minDistance = distance;
        closest = pixel;
      }
    }
    
    if (closest && minDistance <= 2) { // Only connect nearby pixels
      sorted.push(closest);
      remaining.delete(closest);
    } else {
      break; // No more connected pixels
    }
  }
  
  return sorted;
}

function boundaryToSmoothPath(boundary: ContourPoint[]): ContourPoint[] {
  if (boundary.length < 3) return boundary;
  
  // Apply smoothing using moving average
  const smoothed: ContourPoint[] = [];
  const windowSize = 3;
  
  for (let i = 0; i < boundary.length; i++) {
    let sumX = 0, sumY = 0, count = 0;
    
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + boundary.length) % boundary.length;
      sumX += boundary[idx].x;
      sumY += boundary[idx].y;
      count++;
    }
    
    smoothed.push({
      x: Math.round(sumX / count),
      y: Math.round(sumY / count)
    });
  }
  
  return smoothed;
}

function applyVectorOutlineOffset(path: ContourPoint[], offset: number): ContourPoint[] {
  if (path.length < 3) return path;
  
  const offsetPath: ContourPoint[] = [];
  
  for (let i = 0; i < path.length; i++) {
    const prev = path[(i - 1 + path.length) % path.length];
    const curr = path[i];
    const next = path[(i + 1) % path.length];
    
    // Calculate outward normal vector
    const v1 = {x: curr.x - prev.x, y: curr.y - prev.y};
    const v2 = {x: next.x - curr.x, y: next.y - curr.y};
    
    // Normalize vectors
    const len1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y) || 1;
    const len2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y) || 1;
    
    v1.x /= len1; v1.y /= len1;
    v2.x /= len2; v2.y /= len2;
    
    // Calculate perpendicular (outward normal)
    const n1 = {x: -v1.y, y: v1.x};
    const n2 = {x: -v2.y, y: v2.x};
    
    // Average normal
    const avgNormal = {
      x: (n1.x + n2.x) / 2,
      y: (n1.y + n2.y) / 2
    };
    
    // Normalize
    const avgLen = Math.sqrt(avgNormal.x * avgNormal.x + avgNormal.y * avgNormal.y) || 1;
    avgNormal.x /= avgLen;
    avgNormal.y /= avgLen;
    
    // Apply offset
    offsetPath.push({
      x: Math.round(curr.x + avgNormal.x * offset),
      y: Math.round(curr.y + avgNormal.y * offset)
    });
  }
  
  return offsetPath;
}

function extractVectorHoles(
  image: HTMLImageElement,
  threshold: number,
  holeMargin: number
): ContourPoint[][] {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return [];
  
  tempCanvas.width = image.width;
  tempCanvas.height = image.height;
  tempCtx.drawImage(image, 0, 0);
  
  const imageData = tempCtx.getImageData(0, 0, image.width, image.height);
  const { data, width, height } = imageData;
  
  // Find holes (transparent regions surrounded by solid content)
  const holes = findVectorHoles(data, width, height, threshold);
  
  // Convert holes to vector paths with inward margin
  return holes.map(hole => applyVectorOutlineOffset(hole, -holeMargin));
}

function findVectorHoles(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): ContourPoint[][] {
  const visited: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  const holes: ContourPoint[][] = [];
  
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3];
      
      if (alpha < threshold && !visited[y][x]) {
        const region = floodFillTransparentRegion(data, visited, x, y, width, height, threshold);
        
        if (isInteriorHole(region, data, width, height, threshold)) {
          const holeBoundary = findHoleBoundary(region, data, width, height, threshold);
          if (holeBoundary.length > 6) {
            holes.push(holeBoundary);
          }
        }
      }
    }
  }
  
  return holes;
}

function floodFillTransparentRegion(
  data: Uint8ClampedArray,
  visited: boolean[][],
  startX: number,
  startY: number,
  width: number,
  height: number,
  threshold: number
): Array<{x: number, y: number}> {
  const region: Array<{x: number, y: number}> = [];
  const stack: Array<{x: number, y: number}> = [{x: startX, y: startY}];
  
  while (stack.length > 0) {
    const {x, y} = stack.pop()!;
    
    if (x < 0 || x >= width || y < 0 || y >= height || visited[y][x]) {
      continue;
    }
    
    const idx = (y * width + x) * 4;
    const alpha = data[idx + 3];
    
    if (alpha >= threshold) {
      continue; // Hit solid pixel
    }
    
    visited[y][x] = true;
    region.push({x, y});
    
    // Continue flood fill
    stack.push({x: x + 1, y});
    stack.push({x: x - 1, y});
    stack.push({x, y: y + 1});
    stack.push({x, y: y - 1});
  }
  
  return region;
}

function isInteriorHole(
  region: Array<{x: number, y: number}>,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): boolean {
  // Check if region touches image boundaries
  for (const {x, y} of region) {
    if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
      return false;
    }
  }
  
  // Check if region is surrounded by solid content
  let perimeterSolidCount = 0;
  let perimeterTotal = 0;
  
  for (const {x, y} of region) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        
        const nx = x + dx;
        const ny = y + dy;
        
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          const nIdx = (ny * width + nx) * 4;
          const nAlpha = data[nIdx + 3];
          perimeterTotal++;
          if (nAlpha >= threshold) perimeterSolidCount++;
        }
      }
    }
  }
  
  return perimeterSolidCount / perimeterTotal > 0.7; // 70% solid perimeter
}

function findHoleBoundary(
  region: Array<{x: number, y: number}>,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): ContourPoint[] {
  const regionSet = new Set(region.map(p => `${p.x},${p.y}`));
  const boundary: ContourPoint[] = [];
  
  for (const {x, y} of region) {
    let isBoundary = false;
    
    // Check 4-connected neighbors
    const directions = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (const [dx, dy] of directions) {
      const nx = x + dx;
      const ny = y + dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = (ny * width + nx) * 4;
        const nAlpha = data[nIdx + 3];
        
        if (nAlpha >= threshold || !regionSet.has(`${nx},${ny}`)) {
          isBoundary = true;
          break;
        }
      }
    }
    
    if (isBoundary) {
      boundary.push({x, y});
    }
  }
  
  return sortBoundaryPixels(boundary);
}

function optimizeVectorPath(path: ContourPoint[]): ContourPoint[] {
  if (path.length <= 2) return path;
  
  // Apply Douglas-Peucker simplification with higher tolerance
  let simplified = douglasPeuckerSimplify(path, 2.0);
  
  // Ensure minimum point count for smooth curves
  if (simplified.length < 8 && path.length >= 8) {
    simplified = douglasPeuckerSimplify(path, 1.0);
  }
  
  return simplified;
}



function createOuterEdgeMask(
  data: Uint8ClampedArray, 
  width: number, 
  height: number, 
  threshold: number
): boolean[][] {
  const edgeMask: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // Create alpha mask
  const alphaMask: number[][] = Array(height).fill(null).map(() => Array(width).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      alphaMask[y][x] = data[idx + 3];
    }
  }
  
  // Find only the outermost edges - pixels that are solid and border transparency or image boundary
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const currentAlpha = alphaMask[y][x];
      
      if (currentAlpha >= threshold) {
        let isOuterEdge = false;
        
        // Check if this pixel is on the image boundary
        if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
          isOuterEdge = true;
        } else {
          // Check 8-directional neighbors for transparency
          for (let dy = -1; dy <= 1 && !isOuterEdge; dy++) {
            for (let dx = -1; dx <= 1 && !isOuterEdge; dx++) {
              if (dx === 0 && dy === 0) continue;
              const neighborAlpha = alphaMask[y + dy][x + dx];
              if (neighborAlpha < threshold) {
                isOuterEdge = true;
              }
            }
          }
        }
        
        edgeMask[y][x] = isOuterEdge;
      }
    }
  }
  
  return edgeMask;
}

function createHoleEdgeMask(
  data: Uint8ClampedArray, 
  width: number, 
  height: number, 
  threshold: number,
  holeMargin: number
): boolean[][] {
  const holeEdges: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // Create alpha mask
  const alphaMask: number[][] = Array(height).fill(null).map(() => Array(width).fill(0));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      alphaMask[y][x] = data[idx + 3];
    }
  }
  
  // Find interior holes only - transparent pixels completely surrounded by solid content
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const currentAlpha = alphaMask[y][x];
      
      if (currentAlpha < threshold) {
        // Check if this transparent pixel is truly inside the design (surrounded by solid content)
        let solidCount = 0;
        const checkRadius = Math.max(3, Math.floor(holeMargin * 3));
        let totalChecked = 0;
        
        for (let dy = -checkRadius; dy <= checkRadius; dy++) {
          for (let dx = -checkRadius; dx <= checkRadius; dx++) {
            const checkY = y + dy;
            const checkX = x + dx;
            if (checkY >= 0 && checkY < height && checkX >= 0 && checkX < width) {
              totalChecked++;
              if (alphaMask[checkY][checkX] >= threshold) {
                solidCount++;
              }
            }
          }
        }
        
        // Only mark as hole edge if mostly surrounded by solid content
        if (solidCount > totalChecked * 0.6) {
          // Check immediate neighbors to confirm this is an edge of the hole
          let hasSolidNeighbor = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              if (alphaMask[y + dy][x + dx] >= threshold) {
                hasSolidNeighbor = true;
                break;
              }
            }
            if (hasSolidNeighbor) break;
          }
          
          holeEdges[y][x] = hasSolidNeighbor;
        }
      }
    }
  }
  
  return holeEdges;
}

function traceMainContour(edgeMask: boolean[][], width: number, height: number): ContourPoint[][] {
  const contours: ContourPoint[][] = [];
  const visited: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // Find the largest/main contour (outermost boundary)
  let largestContour: ContourPoint[] = [];
  let largestSize = 0;
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (edgeMask[y][x] && !visited[y][x]) {
        const contour = traceContourFromPoint(edgeMask, visited, x, y, width, height);
        if (contour.length > largestSize) {
          largestSize = contour.length;
          largestContour = contour;
        }
      }
    }
  }
  
  // Only return the main outer contour
  if (largestContour.length > 20) {
    contours.push(largestContour);
  }
  
  return contours;
}

function traceImageContours(edgeMask: boolean[][], width: number, height: number): ContourPoint[][] {
  const contours: ContourPoint[][] = [];
  const visited: boolean[][] = Array(height).fill(null).map(() => Array(width).fill(false));
  
  // Find all contour starting points (used for holes)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      if (edgeMask[y][x] && !visited[y][x]) {
        const contour = traceContourFromPoint(edgeMask, visited, x, y, width, height);
        if (contour.length > 10) { // Minimum contour size
          contours.push(contour);
        }
      }
    }
  }
  
  return contours;
}

function traceContourFromPoint(
  edgeMask: boolean[][],
  visited: boolean[][],
  startX: number,
  startY: number,
  width: number,
  height: number
): ContourPoint[] {
  const contour: ContourPoint[] = [];
  const directions = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1]
  ];
  
  let x = startX;
  let y = startY;
  let dirIndex = 0;
  const maxPoints = Math.min(width * height, 2000); // Reduced for performance
  
  try {
    do {
      if (y >= 0 && y < height && x >= 0 && x < width) {
        visited[y][x] = true;
        contour.push({ x, y });
      }
      
      // Find next edge point
      let found = false;
      for (let i = 0; i < 8; i++) {
        const checkDir = (dirIndex + i) % 8;
        const [dx, dy] = directions[checkDir];
        const nx = x + dx;
        const ny = y + dy;
        
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && 
            edgeMask[ny][nx] && !visited[ny][nx]) {
          x = nx;
          y = ny;
          dirIndex = checkDir;
          found = true;
          break;
        }
      }
      
      if (!found) {
        // Try to find any nearby unvisited edge point
        for (let radius = 1; radius <= 2 && !found; radius++) {
          for (let dy = -radius; dy <= radius && !found; dy++) {
            for (let dx = -radius; dx <= radius && !found; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height && 
                  edgeMask[ny][nx] && !visited[ny][nx]) {
                x = nx;
                y = ny;
                found = true;
              }
            }
          }
        }
      }
      
      if (!found) break;
      
    } while (contour.length < maxPoints && 
             (Math.abs(x - startX) > 1 || Math.abs(y - startY) > 1 || contour.length < 3));
  } catch (error) {
    console.error('Error tracing contour:', error);
  }
  
  return contour;
}

function smoothContourPath(path: ContourPoint[], smoothing: number): ContourPoint[] {
  if (path.length < 3 || smoothing <= 0) return path;
  
  const smoothed: ContourPoint[] = [];
  const windowSize = Math.max(1, Math.floor(smoothing));
  
  for (let i = 0; i < path.length; i++) {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    
    for (let j = -windowSize; j <= windowSize; j++) {
      const idx = (i + j + path.length) % path.length;
      sumX += path[idx].x;
      sumY += path[idx].y;
      count++;
    }
    
    smoothed.push({
      x: Math.round(sumX / count),
      y: Math.round(sumY / count)
    });
  }
  
  return smoothed;
}

function applyFlexiHoleMargins(holeContours: ContourPoint[][], margin: number): ContourPoint[][] {
  // Flexi Auto Contour applies inward offset to holes for proper cutting clearance
  return holeContours.map(contour => {
    if (contour.length < 3) return contour;
    
    const adjustedContour: ContourPoint[] = [];
    const marginPixels = Math.max(1, Math.floor(margin));
    
    for (let i = 0; i < contour.length; i++) {
      const prev = contour[(i - 1 + contour.length) % contour.length];
      const curr = contour[i];
      const next = contour[(i + 1) % contour.length];
      
      // Calculate inward normal vector for hole contour
      const dx1 = curr.x - prev.x;
      const dy1 = curr.y - prev.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      
      const dx2 = next.x - curr.x;
      const dy2 = next.y - curr.y;
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      
      if (len1 > 0 && len2 > 0) {
        // Normalize and average the edge vectors
        const nx1 = -dy1 / len1; // Perpendicular (inward for holes)
        const ny1 = dx1 / len1;
        
        const nx2 = -dy2 / len2;
        const ny2 = dx2 / len2;
        
        // Average normal direction
        let avgNx = (nx1 + nx2) / 2;
        let avgNy = (ny1 + ny2) / 2;
        const avgLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy);
        
        if (avgLen > 0) {
          avgNx /= avgLen;
          avgNy /= avgLen;
          
          // Apply Flexi Auto Contour style inward margin
          adjustedContour.push({
            x: Math.round(curr.x + avgNx * marginPixels),
            y: Math.round(curr.y + avgNy * marginPixels)
          });
        } else {
          adjustedContour.push(curr);
        }
      } else {
        adjustedContour.push(curr);
      }
    }
    
    return adjustedContour.length > 2 ? adjustedContour : contour;
  }).filter(contour => contour.length > 2);
}

function drawTrueContourStroke(
  ctx: CanvasRenderingContext2D,
  contourPaths: ContourPoint[][],
  strokeSettings: StrokeSettings,
  offsetX: number,
  offsetY: number
): void {
  if (contourPaths.length === 0) return;
  
  ctx.save();
  ctx.strokeStyle = strokeSettings.color;
  ctx.lineWidth = strokeSettings.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Draw multiple passes for solid stroke
  for (let pass = 0; pass < 2; pass++) {
    for (const path of contourPaths) {
      if (path.length < 2) continue;
      
      ctx.beginPath();
      
      const firstPoint = path[0];
      ctx.moveTo(firstPoint.x + offsetX, firstPoint.y + offsetY);
      
      for (let i = 1; i < path.length; i++) {
        const point = path[i];
        ctx.lineTo(point.x + offsetX, point.y + offsetY);
      }
      
      // Close the path if it's a complete contour
      if (path.length > 10) {
        ctx.closePath();
      }
      
      ctx.stroke();
    }
  }
  
  ctx.restore();
}