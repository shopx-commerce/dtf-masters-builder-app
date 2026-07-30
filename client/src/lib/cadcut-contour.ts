import { StrokeSettings } from "@/components/image-editor";

export function createCadCutContour(
  image: HTMLImageElement,
  strokeSettings: StrokeSettings
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  // Convert inch offset to pixels (at 300 DPI)
  const offsetPixels = Math.round(strokeSettings.width * 300);
  
  // Canvas needs extra space for the contour offset
  const padding = offsetPixels + 10;
  canvas.width = image.width + (padding * 2);
  canvas.height = image.height + (padding * 2);
  
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    // Step 1: Create binary mask from alpha channel
    const mask = createAlphaMask(image);
    if (mask.length === 0) return canvas;
    
    // Step 2: Dilate the mask by offset pixels (morphological dilation)
    const dilatedMask = dilateMask(mask, image.width, image.height, offsetPixels);
    const dilatedWidth = image.width + offsetPixels * 2;
    const dilatedHeight = image.height + offsetPixels * 2;
    
    // Step 3: Find edge pixels of the dilated mask
    const edgePixels = findEdgePixels(dilatedMask, dilatedWidth, dilatedHeight);
    
    if (edgePixels.length < 10) {
      // Just draw the image centered if not enough edge pixels
      ctx.drawImage(image, padding, padding);
      return canvas;
    }
    
    // Step 4: Create ordered contour path from edge pixels
    const contourPath = createOrderedContour(edgePixels, dilatedWidth, dilatedHeight);
    
    // Step 5: Draw the contour outline (offset to account for canvas padding difference)
    const offsetX = padding - offsetPixels;
    const offsetY = padding - offsetPixels;
    
    drawContour(ctx, contourPath, strokeSettings.color || '#FFFFFF', offsetX, offsetY);
    
    // Step 6: Draw the original image on top, centered in the canvas
    ctx.drawImage(image, padding, padding);
    
  } catch (error) {
    console.error('CadCut contour error:', error);
    // Fallback: just draw image
    ctx.drawImage(image, padding, padding);
  }
  
  return canvas;
}

// Performance threshold for high-detail image optimization
const HIGH_DETAIL_THRESHOLD = 400000; // ~632x632 pixels
const MAX_PROCESSING_SIZE = 600;

interface OptimizedMaskResult {
  mask: Uint8Array;
  width: number;
  height: number;
  scale: number;
}

function createAlphaMask(image: HTMLImageElement): Uint8Array {
  const result = createOptimizedAlphaMask(image);
  
  if (result.scale === 1.0) {
    return result.mask;
  }
  
  return upscaleAlphaMask(result.mask, result.width, result.height, image.width, image.height);
}

function createOptimizedAlphaMask(image: HTMLImageElement): OptimizedMaskResult {
  const totalPixels = image.width * image.height;
  
  if (totalPixels <= HIGH_DETAIL_THRESHOLD) {
    return {
      mask: createAlphaMaskAtResolution(image, image.width, image.height),
      width: image.width,
      height: image.height,
      scale: 1.0
    };
  }
  
  const maxDim = Math.max(image.width, image.height);
  const scale = MAX_PROCESSING_SIZE / maxDim;
  const processWidth = Math.round(image.width * scale);
  const processHeight = Math.round(image.height * scale);
  
  return {
    mask: createAlphaMaskAtResolution(image, processWidth, processHeight),
    width: processWidth,
    height: processHeight,
    scale: scale
  };
}

function createAlphaMaskAtResolution(image: HTMLImageElement, targetWidth: number, targetHeight: number): Uint8Array {
  const tempCanvas = document.createElement('canvas');
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return new Uint8Array(0);

  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  
  tempCtx.drawImage(image, 0, 0, targetWidth, targetHeight);
  const imageData = tempCtx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;
  
  // Create binary mask: 1 = solid pixel (alpha >= 128), 0 = transparent
  const mask = new Uint8Array(targetWidth * targetHeight);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
  }
  
  return mask;
}

function upscaleAlphaMask(mask: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): Uint8Array {
  const result = new Uint8Array(dstWidth * dstHeight);
  const scaleX = srcWidth / dstWidth;
  const scaleY = srcHeight / dstHeight;
  
  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.min(Math.floor(y * scaleY), srcHeight - 1);
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.min(Math.floor(x * scaleX), srcWidth - 1);
      result[y * dstWidth + x] = mask[srcY * srcWidth + srcX];
    }
  }
  
  return result;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  // Create expanded canvas to hold dilated result
  const newWidth = width + radius * 2;
  const newHeight = height + radius * 2;
  const dilated = new Uint8Array(newWidth * newHeight);
  
  if (radius <= 0) {
    // No dilation needed, just copy to center of new canvas
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        dilated[(y + radius) * newWidth + (x + radius)] = mask[y * width + x];
      }
    }
    return dilated;
  }
  
  // Precompute circle offsets for the given radius
  const offsets: { dx: number; dy: number }[] = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius) {
        offsets.push({ dx, dy });
      }
    }
  }
  
  // For each solid pixel in original mask, fill circle in dilated mask
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const centerX = x + radius;
        const centerY = y + radius;
        
        for (const offset of offsets) {
          const nx = centerX + offset.dx;
          const ny = centerY + offset.dy;
          if (nx >= 0 && nx < newWidth && ny >= 0 && ny < newHeight) {
            dilated[ny * newWidth + nx] = 1;
          }
        }
      }
    }
  }
  
  return dilated;
}

interface Point {
  x: number;
  y: number;
}

function findEdgePixels(mask: Uint8Array, width: number, height: number): Point[] {
  const edges: Point[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] === 1) {
        // Check if this pixel has a transparent neighbor (4-connected)
        const hasTransparentNeighbor = 
          (x === 0 || mask[idx - 1] === 0) ||
          (x === width - 1 || mask[idx + 1] === 0) ||
          (y === 0 || mask[(y - 1) * width + x] === 0) ||
          (y === height - 1 || mask[(y + 1) * width + x] === 0);
        
        if (hasTransparentNeighbor) {
          edges.push({ x, y });
        }
      }
    }
  }
  
  return edges;
}

function createOrderedContour(edgePixels: Point[], width: number, height: number): Point[] {
  if (edgePixels.length === 0) return [];
  
  // Calculate center of mass for angle-based sorting
  let sumX = 0, sumY = 0;
  for (const p of edgePixels) {
    sumX += p.x;
    sumY += p.y;
  }
  const centerX = sumX / edgePixels.length;
  const centerY = sumY / edgePixels.length;
  
  // Sort by angle from center
  const sorted = [...edgePixels].sort((a, b) => {
    const angleA = Math.atan2(a.y - centerY, a.x - centerX);
    const angleB = Math.atan2(b.y - centerY, b.x - centerX);
    return angleA - angleB;
  });
  
  // Remove self-intersections (Y-shaped crossings) before simplification
  const cleanedPath = removeSelfIntersections(sorted);
  
  // Simplify to reduce point count while maintaining shape
  const simplified = douglasPeucker(cleanedPath, 1.5);
  
  // Final pass to remove any intersections created by simplification
  return removeSelfIntersections(simplified);
}

// Detect and remove self-intersecting segments (Y-shaped and T-shaped crossings)
function removeSelfIntersections(points: Point[]): Point[] {
  if (points.length < 4) return points;
  
  let result = [...points];
  let changed = true;
  let iterations = 0;
  const maxIterations = 50;
  
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;
    
    const n = result.length;
    
    for (let i = 0; i < n && !changed; i++) {
      const p1 = result[i];
      const p2 = result[(i + 1) % n];
      
      for (let j = i + 2; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;
        
        const p3 = result[j];
        const p4 = result[(j + 1) % n];
        
        const intersection = lineSegmentIntersection(p1, p2, p3, p4);
        
        if (intersection) {
          const loopSize = j - i;
          const remainingSize = n - loopSize;
          
          if (loopSize <= remainingSize) {
            const newPoints: Point[] = [];
            for (let k = 0; k <= i; k++) {
              newPoints.push(result[k]);
            }
            newPoints.push(intersection);
            for (let k = j + 1; k < n; k++) {
              newPoints.push(result[k]);
            }
            result = newPoints;
          } else {
            const newPoints: Point[] = [];
            newPoints.push(intersection);
            for (let k = i + 1; k <= j; k++) {
              newPoints.push(result[k]);
            }
            result = newPoints;
          }
          
          changed = true;
          break;
        }
      }
    }
  }
  
  result = fixNearIntersections(result);
  
  return result;
}

function fixNearIntersections(points: Point[]): Point[] {
  if (points.length < 6) return points;
  
  const result: Point[] = [];
  const minDistance = 2;
  
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    let tooClose = false;
    
    for (let j = 0; j < points.length - 1; j++) {
      if (Math.abs(i - j) <= 2 || Math.abs(i - j) >= points.length - 2) continue;
      
      const segStart = points[j];
      const segEnd = points[j + 1];
      
      const dist = pointToSegmentDistance(current, segStart, segEnd);
      
      if (dist < minDistance) {
        tooClose = true;
        break;
      }
    }
    
    if (!tooClose) {
      result.push(current);
    }
  }
  
  return result.length >= 3 ? result : points;
}

function pointToSegmentDistance(p: Point, segStart: Point, segEnd: Point): number {
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  const lengthSq = dx * dx + dy * dy;
  
  if (lengthSq === 0) {
    return Math.sqrt((p.x - segStart.x) ** 2 + (p.y - segStart.y) ** 2);
  }
  
  let t = ((p.x - segStart.x) * dx + (p.y - segStart.y) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  
  const nearestX = segStart.x + t * dx;
  const nearestY = segStart.y + t * dy;
  
  return Math.sqrt((p.x - nearestX) ** 2 + (p.y - nearestY) ** 2);
}

function lineSegmentIntersection(p1: Point, p2: Point, p3: Point, p4: Point): Point | null {
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  
  const cross = d1x * d2y - d1y * d2x;
  
  if (Math.abs(cross) < 0.0001) return null;
  
  const dx = p3.x - p1.x;
  const dy = p3.y - p1.y;
  
  const t = (dx * d2y - dy * d2x) / cross;
  const u = (dx * d1y - dy * d1x) / cross;
  
  const margin = 0.001;
  if (t > margin && t < 1 - margin && u > margin && u < 1 - margin) {
    return {
      x: p1.x + t * d1x,
      y: p1.y + t * d1y
    };
  }
  
  return null;
}

function douglasPeucker(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  
  // Find the point with maximum distance from line between first and last
  let maxDist = 0;
  let maxIndex = 0;
  
  const first = points[0];
  const last = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDist(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }
  
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIndex), epsilon);
    return left.slice(0, -1).concat(right);
  } else {
    return [first, last];
  }
}

function perpendicularDist(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  
  if (dx === 0 && dy === 0) {
    return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
  }
  
  const t = Math.max(0, Math.min(1, 
    ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy)
  ));
  
  const nearestX = lineStart.x + t * dx;
  const nearestY = lineStart.y + t * dy;
  
  return Math.sqrt((point.x - nearestX) ** 2 + (point.y - nearestY) ** 2);
}

function drawContour(ctx: CanvasRenderingContext2D, contour: Point[], color: string, offsetX: number, offsetY: number): void {
  if (contour.length < 3) return;

  // Draw the contour outline
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Add shadow for visibility on any background
  ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 1;

  ctx.beginPath();
  ctx.moveTo(contour[0].x + offsetX, contour[0].y + offsetY);
  
  // Draw smooth curve through points
  for (let i = 1; i < contour.length - 1; i++) {
    const xc = (contour[i].x + contour[i + 1].x) / 2 + offsetX;
    const yc = (contour[i].y + contour[i + 1].y) / 2 + offsetY;
    ctx.quadraticCurveTo(contour[i].x + offsetX, contour[i].y + offsetY, xc, yc);
  }
  
  // Connect to last point and close
  const lastPoint = contour[contour.length - 1];
  ctx.lineTo(lastPoint.x + offsetX, lastPoint.y + offsetY);
  ctx.closePath();
  ctx.stroke();
  
  // Reset shadow
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
}
