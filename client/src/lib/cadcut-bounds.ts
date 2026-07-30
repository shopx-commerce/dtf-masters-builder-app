import { ShapeSettings } from "@/components/image-editor";

export interface CadCutBounds {
  isWithinBounds: boolean;
  overlapPixels: number;
  designBounds: { x: number; y: number; width: number; height: number };
  shapeBounds: { x: number; y: number; width: number; height: number };
}

export function checkCadCutBounds(
  image: HTMLImageElement,
  shapeSettings: ShapeSettings,
  shapeWidthPixels: number,
  shapeHeightPixels: number
): CadCutBounds {
  // Create a simple canvas to analyze the image bounds
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  
  canvas.width = image.width;
  canvas.height = image.height;
  ctx.drawImage(image, 0, 0);
  
  // Get image data for analysis
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  // Find actual content bounds (non-transparent pixels)
  let minX = canvas.width, minY = canvas.height;
  let maxX = 0, maxY = 0;
  let hasContent = false;
  
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const idx = (y * canvas.width + x) * 4;
      const alpha = data[idx + 3];
      
      if (alpha > 50) { // Consider pixels with alpha > 50 as content
        hasContent = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  
  if (!hasContent) {
    return {
      isWithinBounds: true,
      overlapPixels: 0,
      designBounds: { x: 0, y: 0, width: 0, height: 0 },
      shapeBounds: getShapePixelBounds(shapeSettings, shapeWidthPixels, shapeHeightPixels)
    };
  }
  
  const designBounds = {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
  
  const shapeBounds = getShapePixelBounds(shapeSettings, shapeWidthPixels, shapeHeightPixels);
  
  // Calculate if design fits within shape bounds
  const designCenterX = designBounds.x + designBounds.width / 2;
  const designCenterY = designBounds.y + designBounds.height / 2;
  
  // Center the design in the shape
  const shapeCenterX = shapeBounds.x + shapeBounds.width / 2;
  const shapeCenterY = shapeBounds.y + shapeBounds.height / 2;
  
  // Calculate offset needed to center design
  const offsetX = shapeCenterX - designCenterX;
  const offsetY = shapeCenterY - designCenterY;
  
  // Adjust design bounds to centered position
  const centeredDesignBounds = {
    x: designBounds.x + offsetX,
    y: designBounds.y + offsetY,
    width: designBounds.width,
    height: designBounds.height
  };
  
  // Check if centered design fits within shape
  const isWithinBounds = checkBoundsContainment(centeredDesignBounds, shapeBounds, shapeSettings);
  
  // Calculate overlap pixels if out of bounds
  let overlapPixels = 0;
  if (!isWithinBounds) {
    overlapPixels = calculateOverlapPixels(centeredDesignBounds, shapeBounds, shapeSettings);
  }
  
  return {
    isWithinBounds,
    overlapPixels,
    designBounds: centeredDesignBounds,
    shapeBounds
  };
}

function getShapePixelBounds(
  shapeSettings: ShapeSettings,
  shapeWidthPixels: number,
  shapeHeightPixels: number
): { x: number; y: number; width: number; height: number } {
  const centerX = shapeWidthPixels / 2;
  const centerY = shapeHeightPixels / 2;
  
  if (shapeSettings.type === 'circle') {
    const radius = Math.min(shapeWidthPixels, shapeHeightPixels) / 2;
    return {
      x: centerX - radius,
      y: centerY - radius,
      width: radius * 2,
      height: radius * 2
    };
  } else if (shapeSettings.type === 'oval') {
    return {
      x: 0,
      y: 0,
      width: shapeWidthPixels,
      height: shapeHeightPixels
    };
  } else if (shapeSettings.type === 'square' || shapeSettings.type === 'rounded-square') {
    const size = Math.min(shapeWidthPixels, shapeHeightPixels);
    return {
      x: centerX - size / 2,
      y: centerY - size / 2,
      width: size,
      height: size
    };
  } else { // rectangle or rounded-rectangle
    return {
      x: 0,
      y: 0,
      width: shapeWidthPixels,
      height: shapeHeightPixels
    };
  }
}

function checkBoundsContainment(
  designBounds: { x: number; y: number; width: number; height: number },
  shapeBounds: { x: number; y: number; width: number; height: number },
  shapeSettings: ShapeSettings
): boolean {
  if (shapeSettings.type === 'circle') {
    // Check if all corners of design rectangle are within circle
    const centerX = shapeBounds.x + shapeBounds.width / 2;
    const centerY = shapeBounds.y + shapeBounds.height / 2;
    const radius = shapeBounds.width / 2;
    
    const corners = [
      { x: designBounds.x, y: designBounds.y },
      { x: designBounds.x + designBounds.width, y: designBounds.y },
      { x: designBounds.x, y: designBounds.y + designBounds.height },
      { x: designBounds.x + designBounds.width, y: designBounds.y + designBounds.height }
    ];
    
    return corners.every(corner => {
      const dx = corner.x - centerX;
      const dy = corner.y - centerY;
      return (dx * dx + dy * dy) <= (radius * radius);
    });
  } else if (shapeSettings.type === 'oval') {
    // Check if all corners are within ellipse
    const centerX = shapeBounds.x + shapeBounds.width / 2;
    const centerY = shapeBounds.y + shapeBounds.height / 2;
    const radiusX = shapeBounds.width / 2;
    const radiusY = shapeBounds.height / 2;
    
    const corners = [
      { x: designBounds.x, y: designBounds.y },
      { x: designBounds.x + designBounds.width, y: designBounds.y },
      { x: designBounds.x, y: designBounds.y + designBounds.height },
      { x: designBounds.x + designBounds.width, y: designBounds.y + designBounds.height }
    ];
    
    return corners.every(corner => {
      const dx = (corner.x - centerX) / radiusX;
      const dy = (corner.y - centerY) / radiusY;
      return (dx * dx + dy * dy) <= 1;
    });
  } else {
    // Square, rounded-square, rectangle, rounded-rectangle: simple bounding box check
    return (
      designBounds.x >= shapeBounds.x &&
      designBounds.y >= shapeBounds.y &&
      designBounds.x + designBounds.width <= shapeBounds.x + shapeBounds.width &&
      designBounds.y + designBounds.height <= shapeBounds.y + shapeBounds.height
    );
  }
}

function calculateOverlapPixels(
  designBounds: { x: number; y: number; width: number; height: number },
  shapeBounds: { x: number; y: number; width: number; height: number },
  shapeSettings: ShapeSettings
): number {
  // Simple calculation - count pixels outside shape bounds
  const overlapLeft = Math.max(0, shapeBounds.x - designBounds.x);
  const overlapRight = Math.max(0, (designBounds.x + designBounds.width) - (shapeBounds.x + shapeBounds.width));
  const overlapTop = Math.max(0, shapeBounds.y - designBounds.y);
  const overlapBottom = Math.max(0, (designBounds.y + designBounds.height) - (shapeBounds.y + shapeBounds.height));
  
  return (overlapLeft + overlapRight) * designBounds.height + 
         (overlapTop + overlapBottom) * designBounds.width;
}

export function applyCadCutClipping(
  ctx: CanvasRenderingContext2D,
  shapeSettings: ShapeSettings,
  shapeWidth: number,
  shapeHeight: number,
  pixelsPerInch: number = 72
): void {
  const centerX = shapeWidth / 2;
  const centerY = shapeHeight / 2;
  
  ctx.save();
  ctx.beginPath();
  
  // Calculate corner radius in pixels from inches
  const cornerRadius = (shapeSettings.cornerRadius || 0.25) * pixelsPerInch;
  
  if (shapeSettings.type === 'circle') {
    const radius = Math.min(shapeWidth, shapeHeight) / 2;
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  } else if (shapeSettings.type === 'oval') {
    const radiusX = shapeWidth / 2;
    const radiusY = shapeHeight / 2;
    ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
  } else if (shapeSettings.type === 'square') {
    const size = Math.min(shapeWidth, shapeHeight);
    const startX = centerX - size / 2;
    const startY = centerY - size / 2;
    ctx.rect(startX, startY, size, size);
  } else if (shapeSettings.type === 'rounded-square') {
    const size = Math.min(shapeWidth, shapeHeight);
    const startX = centerX - size / 2;
    const startY = centerY - size / 2;
    ctx.roundRect(startX, startY, size, size, cornerRadius);
  } else if (shapeSettings.type === 'rounded-rectangle') {
    ctx.roundRect(0, 0, shapeWidth, shapeHeight, cornerRadius);
  } else { // rectangle
    ctx.rect(0, 0, shapeWidth, shapeHeight);
  }
  
  ctx.clip();
}