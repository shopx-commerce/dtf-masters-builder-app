export type DetectedShape = 'circle' | 'oval' | 'square' | 'rectangle' | 'irregular';

export interface ShapeDetectionResult {
  shape: DetectedShape;
  confidence: number;
  aspectRatio: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function detectShape(image: HTMLImageElement, alphaThreshold: number = 128): ShapeDetectionResult {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { shape: 'irregular', confidence: 0, aspectRatio: 1, boundingBox: { x: 0, y: 0, width: 0, height: 0 } };
  }

  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;

  let minX = width, maxX = 0, minY = height, maxY = 0;
  let opaqueCount = 0;
  const edgePixels: { x: number; y: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha >= alphaThreshold) {
        opaqueCount++;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        
        if (isEdgePixel(data, width, height, x, y, alphaThreshold)) {
          edgePixels.push({ x, y });
        }
      }
    }
  }

  if (opaqueCount === 0 || edgePixels.length < 20) {
    return { shape: 'irregular', confidence: 0, aspectRatio: 1, boundingBox: { x: 0, y: 0, width: 0, height: 0 } };
  }

  const boundingBox = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };

  const aspectRatio = boundingBox.width / boundingBox.height;
  const boundingBoxArea = boundingBox.width * boundingBox.height;
  const fillRatio = opaqueCount / boundingBoxArea;

  const centerX = minX + boundingBox.width / 2;
  const centerY = minY + boundingBox.height / 2;
  const radiusX = boundingBox.width / 2;
  const radiusY = boundingBox.height / 2;

  const isSquareAspect = aspectRatio >= 0.92 && aspectRatio <= 1.08;

  let ellipseMatchCount = 0;
  let rectMatchCount = 0;
  let totalEdgeDeviation = 0;
  let rectEdgeDeviation = 0;

  for (const pixel of edgePixels) {
    const nx = (pixel.x - centerX) / radiusX;
    const ny = (pixel.y - centerY) / radiusY;
    const ellipseDist = Math.abs(Math.sqrt(nx * nx + ny * ny) - 1);
    
    if (ellipseDist < 0.08) {
      ellipseMatchCount++;
    }
    totalEdgeDeviation += ellipseDist;

    const distToLeft = Math.abs(pixel.x - minX);
    const distToRight = Math.abs(pixel.x - maxX);
    const distToTop = Math.abs(pixel.y - minY);
    const distToBottom = Math.abs(pixel.y - maxY);
    const minDistToEdge = Math.min(distToLeft, distToRight, distToTop, distToBottom);
    
    if (minDistToEdge <= 2) {
      rectMatchCount++;
    }
    rectEdgeDeviation += minDistToEdge;
  }

  const ellipseEdgeMatch = ellipseMatchCount / edgePixels.length;
  const rectEdgeMatch = rectMatchCount / edgePixels.length;
  const avgEllipseDeviation = totalEdgeDeviation / edgePixels.length;
  const avgRectDeviation = rectEdgeDeviation / edgePixels.length;

  const expectedEllipseFill = Math.PI / 4;
  const ellipseFillDiff = Math.abs(fillRatio - expectedEllipseFill);
  const rectFillDiff = Math.abs(fillRatio - 1.0);

  const ellipseFillMatch = ellipseFillDiff < 0.08;
  const rectFillMatch = rectFillDiff < 0.05;

  const ellipseScore = ellipseEdgeMatch >= 0.85 && ellipseFillMatch && avgEllipseDeviation < 0.12
    ? ellipseEdgeMatch * 0.7 + (1 - ellipseFillDiff / expectedEllipseFill) * 0.3
    : 0;

  const rectScore = rectEdgeMatch >= 0.90 && rectFillMatch && avgRectDeviation < 3
    ? rectEdgeMatch * 0.7 + fillRatio * 0.3
    : 0;

  const confidenceThreshold = 0.88;

  if (ellipseScore >= confidenceThreshold && ellipseScore > rectScore) {
    if (isSquareAspect) {
      return { shape: 'circle', confidence: ellipseScore, aspectRatio, boundingBox };
    } else {
      return { shape: 'oval', confidence: ellipseScore, aspectRatio, boundingBox };
    }
  }

  if (rectScore >= confidenceThreshold) {
    if (isSquareAspect) {
      return { shape: 'square', confidence: rectScore, aspectRatio, boundingBox };
    } else {
      return { shape: 'rectangle', confidence: rectScore, aspectRatio, boundingBox };
    }
  }

  return { shape: 'irregular', confidence: Math.max(ellipseScore, rectScore), aspectRatio, boundingBox };
}

function isEdgePixel(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  alphaThreshold: number
): boolean {
  const currentAlpha = data[(y * width + x) * 4 + 3];
  if (currentAlpha < alphaThreshold) return false;

  const neighbors = [
    [-1, 0], [1, 0], [0, -1], [0, 1]
  ];

  for (const [dx, dy] of neighbors) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
      return true;
    }
    const neighborAlpha = data[(ny * width + nx) * 4 + 3];
    if (neighborAlpha < alphaThreshold) {
      return true;
    }
  }

  return false;
}

export function mapDetectedShapeToType(shape: DetectedShape): 'square' | 'rectangle' | 'circle' | 'oval' | null {
  switch (shape) {
    case 'circle':
      return 'circle';
    case 'oval':
      return 'oval';
    case 'square':
      return 'square';
    case 'rectangle':
      return 'rectangle';
    default:
      return null;
  }
}
