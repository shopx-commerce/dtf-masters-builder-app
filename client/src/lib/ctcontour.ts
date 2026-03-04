import { StrokeSettings } from "@/components/image-editor";

export interface CTContourOptions {
  strokeSettings: StrokeSettings;
  precision: number;
  threshold: number;
  simplification: number;
}

export function createCTContour(
  image: HTMLImageElement,
  options: CTContourOptions
): HTMLCanvasElement {
  const { strokeSettings, precision = 1.0, threshold = 128, simplification = 2.0 } = options;
  
  // Create working canvas
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  
  canvas.width = image.width;
  canvas.height = image.height;
  
  // Draw image to extract pixel data
  ctx.drawImage(image, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  
  // Generate CTContour paths
  const contours = generateCTContours(imageData, threshold, precision, simplification);
  
  // Clear canvas and redraw with contours
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw original image
  ctx.drawImage(image, 0, 0);
  
  if (strokeSettings.enabled && contours.length > 0) {
    // Draw CTContour outlines
    drawCTContours(ctx, contours, strokeSettings);
  }
  
  return canvas;
}

interface CTPoint {
  x: number;
  y: number;
  direction: number;
  curvature: number;
}

interface CTContour {
  points: CTPoint[];
  area: number;
  perimeter: number;
  clockwise: boolean;
}

function generateCTContours(
  imageData: ImageData,
  threshold: number,
  precision: number,
  simplification: number
): CTContour[] {
  const { data, width, height } = imageData;
  
  // Create binary mask
  const binaryMask = createBinaryMask(data, width, height, threshold);
  
  // Find all contours using CTContour algorithm
  const contours = traceCTContours(binaryMask, width, height, precision);
  
  // Simplify contours
  const simplifiedContours = contours.map(contour => 
    simplifyCTContour(contour, simplification)
  );
  
  // Filter out small contours and return largest ones
  return simplifiedContours
    .filter(contour => contour.area > 50) // Reduced threshold for better performance
    .sort((a, b) => b.area - a.area) // Sort by area, largest first
    .slice(0, 5); // Limit to 5 largest contours for performance
}

function createBinaryMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  
  for (let i = 0; i < mask.length; i++) {
    const pixelIndex = i * 4;
    const alpha = data[pixelIndex + 3];
    mask[i] = alpha >= threshold ? 1 : 0;
  }
  
  return mask;
}

function traceCTContours(
  mask: Uint8Array,
  width: number,
  height: number,
  precision: number
): CTContour[] {
  const contours: CTContour[] = [];
  const visited = new Uint8Array(width * height);
  
  // Scan for contour starting points with step optimization
  const step = Math.max(1, Math.floor(precision));
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const index = y * width + x;
      
      if (mask[index] === 1 && visited[index] === 0) {
        // Found unvisited foreground pixel, trace contour
        const contour = traceSingleCTContour(mask, visited, width, height, x, y, precision);
        if (contour && contour.points.length > 3) {
          contours.push(contour);
        }
      }
    }
  }
  
  return contours;
}

function traceSingleCTContour(
  mask: Uint8Array,
  visited: Uint8Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  precision: number
): CTContour | null {
  const points: CTPoint[] = [];
  let currentX = startX;
  let currentY = startY;
  let direction = 0; // 0=right, 1=down, 2=left, 3=up
  
  // Direction vectors: right, down, left, up
  const dx = [1, 0, -1, 0];
  const dy = [0, 1, 0, -1];
  
  const startIndex = startY * width + startX;
  let totalArea = 0;
  let perimeter = 0;
  
  do {
    const currentIndex = currentY * width + currentX;
    visited[currentIndex] = 1;
    
    // Calculate local curvature
    const curvature = calculateLocalCurvature(mask, width, height, currentX, currentY);
    
    points.push({
      x: currentX,
      y: currentY,
      direction,
      curvature
    });
    
    // Find next contour point using 8-connectivity
    let found = false;
    for (let i = 0; i < 8; i++) {
      const checkDir = (direction + i) % 8;
      const newX = currentX + getDirectionX(checkDir);
      const newY = currentY + getDirectionY(checkDir);
      
      if (isValidContourPoint(mask, width, height, newX, newY)) {
        currentX = newX;
        currentY = newY;
        direction = checkDir;
        perimeter += i === 0 || i === 2 || i === 4 || i === 6 ? 1 : Math.SQRT2;
        found = true;
        break;
      }
    }
    
    if (!found) break;
    
    // Calculate area contribution (using shoelace formula)
    if (points.length > 1) {
      const prev = points[points.length - 2];
      totalArea += (prev.x * currentY - currentX * prev.y);
    }
    
  } while (!(currentX === startX && currentY === startY) && points.length < width * height);
  
  if (points.length < 4) return null;
  
  // Close the contour
  if (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    totalArea += (last.x * first.y - first.x * last.y);
  }
  
  totalArea = Math.abs(totalArea) / 2;
  const clockwise = totalArea < 0;
  
  return {
    points,
    area: Math.abs(totalArea),
    perimeter,
    clockwise
  };
}

function calculateLocalCurvature(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  // Calculate curvature using discrete approximation
  let curvature = 0;
  const radius = 2;
  
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance > 0 && distance <= radius) {
          const index = ny * width + nx;
          const weight = 1 / (distance * distance);
          curvature += mask[index] * weight;
        }
      }
    }
  }
  
  return curvature;
}

function getDirectionX(direction: number): number {
  const dirs = [1, 1, 0, -1, -1, -1, 0, 1];
  return dirs[direction];
}

function getDirectionY(direction: number): number {
  const dirs = [0, 1, 1, 1, 0, -1, -1, -1];
  return dirs[direction];
}

function isValidContourPoint(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number
): boolean {
  if (x < 0 || x >= width || y < 0 || y >= height) return false;
  
  const index = y * width + x;
  return mask[index] === 1;
}

function simplifyCTContour(contour: CTContour, tolerance: number): CTContour {
  if (contour.points.length <= 3) return contour;
  
  // Use Ramer-Douglas-Peucker algorithm with curvature awareness
  const simplified = rdpSimplifyWithCurvature(contour.points, tolerance);
  
  return {
    ...contour,
    points: simplified
  };
}

function rdpSimplifyWithCurvature(points: CTPoint[], tolerance: number): CTPoint[] {
  if (points.length <= 2) return points;
  
  let maxDistance = 0;
  let maxIndex = 0;
  const start = points[0];
  const end = points[points.length - 1];
  
  for (let i = 1; i < points.length - 1; i++) {
    const point = points[i];
    
    // Calculate distance from line
    const distance = pointToLineDistance(point, start, end);
    
    // Weight distance by curvature (preserve high-curvature points)
    const weightedDistance = distance * (1 + point.curvature * 0.5);
    
    if (weightedDistance > maxDistance) {
      maxDistance = weightedDistance;
      maxIndex = i;
    }
  }
  
  if (maxDistance > tolerance) {
    // Recursively simplify
    const left = rdpSimplifyWithCurvature(points.slice(0, maxIndex + 1), tolerance);
    const right = rdpSimplifyWithCurvature(points.slice(maxIndex), tolerance);
    
    return left.slice(0, -1).concat(right);
  } else {
    return [start, end];
  }
}

function pointToLineDistance(point: CTPoint, lineStart: CTPoint, lineEnd: CTPoint): number {
  const A = lineEnd.x - lineStart.x;
  const B = lineEnd.y - lineStart.y;
  const C = point.x - lineStart.x;
  const D = point.y - lineStart.y;
  
  const dot = A * C + B * D;
  const lenSq = A * A + B * B;
  
  if (lenSq === 0) return Math.sqrt(C * C + D * D);
  
  const param = dot / lenSq;
  
  let xx, yy;
  if (param < 0) {
    xx = lineStart.x;
    yy = lineStart.y;
  } else if (param > 1) {
    xx = lineEnd.x;
    yy = lineEnd.y;
  } else {
    xx = lineStart.x + param * A;
    yy = lineStart.y + param * B;
  }
  
  const dx = point.x - xx;
  const dy = point.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

function drawCTContours(
  ctx: CanvasRenderingContext2D,
  contours: CTContour[],
  strokeSettings: StrokeSettings
): void {
  ctx.strokeStyle = strokeSettings.color;
  ctx.lineWidth = strokeSettings.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  // Draw multiple passes for solid, clean outlines
  for (let pass = 0; pass < 3; pass++) {
    for (const contour of contours) {
      if (contour.points.length < 3) continue;
      
      ctx.beginPath();
      const firstPoint = contour.points[0];
      ctx.moveTo(firstPoint.x, firstPoint.y);
      
      // Use smooth curves for better quality
      for (let i = 1; i < contour.points.length; i++) {
        const point = contour.points[i];
        const prevPoint = contour.points[i - 1];
        
        // Use quadratic curves for high-curvature areas
        if (point.curvature > 0.5 && i < contour.points.length - 1) {
          const nextPoint = contour.points[i + 1];
          const cpX = point.x;
          const cpY = point.y;
          const endX = (point.x + nextPoint.x) / 2;
          const endY = (point.y + nextPoint.y) / 2;
          
          ctx.quadraticCurveTo(cpX, cpY, endX, endY);
          i++; // Skip next point as we've used it
        } else {
          ctx.lineTo(point.x, point.y);
        }
      }
      
      ctx.closePath();
      ctx.stroke();
    }
  }
}