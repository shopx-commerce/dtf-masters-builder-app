export interface ExtractedColor {
  hex: string;
  rgb: { r: number; g: number; b: number };
  count: number;
  percentage: number;
  spotWhite: boolean;
  spotGloss: boolean;
  spotFluorY: boolean;
  spotFluorM: boolean;
  spotFluorG: boolean;
  spotFluorOrange: boolean;
  name?: string;
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function colorDistance(c1: { r: number; g: number; b: number }, c2: { r: number; g: number; b: number }): number {
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) +
    Math.pow(c1.g - c2.g, 2) +
    Math.pow(c1.b - c2.b, 2)
  );
}

// Predefined palette of primary, secondary, and neutral colors
// Chromatic colors first (priority), then minimal neutrals
// maxDistance: custom match threshold (lower = stricter, higher = wider matching)
const COLOR_PALETTE: Array<{ name: string; rgb: { r: number; g: number; b: number }; hex: string; isNeutral: boolean; maxDistance?: number }> = [
  // Reds - WIDER matching (maxDistance: 55) to catch various red shades
  { name: 'Red', rgb: { r: 220, g: 30, b: 30 }, hex: '#DC1E1E', isNeutral: false, maxDistance: 55 },
  { name: 'Dark Red', rgb: { r: 139, g: 0, b: 0 }, hex: '#8B0000', isNeutral: false, maxDistance: 55 },
  { name: 'Crimson', rgb: { r: 220, g: 20, b: 60 }, hex: '#DC143C', isNeutral: false, maxDistance: 55 },
  { name: 'Scarlet', rgb: { r: 255, g: 36, b: 0 }, hex: '#FF2400', isNeutral: false, maxDistance: 55 },
  { name: 'Maroon', rgb: { r: 128, g: 0, b: 0 }, hex: '#800000', isNeutral: false, maxDistance: 55 },
  { name: 'Cherry', rgb: { r: 222, g: 49, b: 99 }, hex: '#DE3163', isNeutral: false, maxDistance: 55 },
  { name: 'Coral Red', rgb: { r: 255, g: 64, b: 64 }, hex: '#FF4040', isNeutral: false, maxDistance: 55 },
  { name: 'Brick Red', rgb: { r: 203, g: 65, b: 84 }, hex: '#CB4154', isNeutral: false, maxDistance: 55 },
  
  // Greens - WIDER matching (maxDistance: 55) to catch various green shades
  { name: 'Green', rgb: { r: 50, g: 180, b: 80 }, hex: '#32B450', isNeutral: false, maxDistance: 55 },
  { name: 'Dark Green', rgb: { r: 0, g: 100, b: 0 }, hex: '#006400', isNeutral: false, maxDistance: 55 },
  { name: 'Lime', rgb: { r: 50, g: 205, b: 50 }, hex: '#32CD32', isNeutral: false, maxDistance: 55 },
  { name: 'Forest', rgb: { r: 34, g: 139, b: 34 }, hex: '#228B22', isNeutral: false, maxDistance: 55 },
  { name: 'Olive', rgb: { r: 128, g: 128, b: 0 }, hex: '#808000', isNeutral: false, maxDistance: 55 },
  { name: 'Mint', rgb: { r: 152, g: 255, b: 152 }, hex: '#98FF98', isNeutral: false, maxDistance: 55 },
  { name: 'Sage', rgb: { r: 130, g: 160, b: 120 }, hex: '#82A078', isNeutral: false, maxDistance: 55 },
  { name: 'Kelly Green', rgb: { r: 76, g: 187, b: 23 }, hex: '#4CBB17', isNeutral: false, maxDistance: 55 },
  
  // Blues - VERY WIDE matching (maxDistance: 65) to catch various blue shades
  { name: 'Blue', rgb: { r: 40, g: 100, b: 220 }, hex: '#2864DC', isNeutral: false, maxDistance: 65 },
  { name: 'Electric Blue', rgb: { r: 42, g: 0, b: 239 }, hex: '#2A00EF', isNeutral: false, maxDistance: 65 },
  { name: 'Ultramarine', rgb: { r: 63, g: 0, b: 255 }, hex: '#3F00FF', isNeutral: false, maxDistance: 65 },
  { name: 'Indigo', rgb: { r: 75, g: 0, b: 130 }, hex: '#4B0082', isNeutral: false, maxDistance: 65 },
  { name: 'Navy', rgb: { r: 0, g: 0, b: 128 }, hex: '#000080', isNeutral: false, maxDistance: 65 },
  { name: 'Royal Blue', rgb: { r: 65, g: 105, b: 225 }, hex: '#4169E1', isNeutral: false, maxDistance: 65 },
  { name: 'Cobalt', rgb: { r: 0, g: 71, b: 171 }, hex: '#0047AB', isNeutral: false, maxDistance: 65 },
  { name: 'Sky Blue', rgb: { r: 135, g: 206, b: 235 }, hex: '#87CEEB', isNeutral: false, maxDistance: 65 },
  { name: 'Light Blue', rgb: { r: 173, g: 216, b: 230 }, hex: '#ADD8E6', isNeutral: false, maxDistance: 65 },
  { name: 'Steel Blue', rgb: { r: 70, g: 130, b: 180 }, hex: '#4682B4', isNeutral: false, maxDistance: 65 },
  { name: 'Dark Blue', rgb: { r: 0, g: 0, b: 80 }, hex: '#000050', isNeutral: false, maxDistance: 65 },
  { name: 'Powder Blue', rgb: { r: 176, g: 224, b: 230 }, hex: '#B0E0E6', isNeutral: false, maxDistance: 65 },
  { name: 'Cerulean', rgb: { r: 0, g: 123, b: 167 }, hex: '#007BA7', isNeutral: false, maxDistance: 65 },
  { name: 'Azure', rgb: { r: 0, g: 127, b: 255 }, hex: '#007FFF', isNeutral: false, maxDistance: 65 },
  { name: 'Sapphire', rgb: { r: 15, g: 82, b: 186 }, hex: '#0F52BA', isNeutral: false, maxDistance: 65 },
  { name: 'Cornflower', rgb: { r: 100, g: 149, b: 237 }, hex: '#6495ED', isNeutral: false, maxDistance: 65 },
  { name: 'Periwinkle', rgb: { r: 204, g: 204, b: 255 }, hex: '#CCCCFF', isNeutral: false, maxDistance: 65 },
  
  // Other primary/secondary
  { name: 'Yellow', rgb: { r: 250, g: 210, b: 50 }, hex: '#FAD232', isNeutral: false },
  { name: 'Orange', rgb: { r: 240, g: 120, b: 20 }, hex: '#F07814', isNeutral: false },
  
  // Purples and Lavenders - VERY STRICT matching (maxDistance: 25) for bright purples
  // Dark purples use wider threshold (35) to avoid merging with black
  { name: 'Purple', rgb: { r: 140, g: 60, b: 180 }, hex: '#8C3CB4', isNeutral: false, maxDistance: 25 },
  { name: 'Lavender', rgb: { r: 230, g: 190, b: 230 }, hex: '#E6BEE6', isNeutral: false, maxDistance: 25 },
  { name: 'Violet', rgb: { r: 148, g: 0, b: 211 }, hex: '#9400D3', isNeutral: false, maxDistance: 25 },
  { name: 'Light Purple', rgb: { r: 177, g: 156, b: 217 }, hex: '#B19CD9', isNeutral: false, maxDistance: 25 },
  { name: 'Plum', rgb: { r: 142, g: 69, b: 133 }, hex: '#8E4585', isNeutral: false, maxDistance: 25 },
  // Dark purples - wider threshold to catch dark purple shades before they match black
  { name: 'Dark Purple', rgb: { r: 48, g: 25, b: 52 }, hex: '#301934', isNeutral: false, maxDistance: 35 },
  { name: 'Eggplant', rgb: { r: 65, g: 30, b: 70 }, hex: '#411E46', isNeutral: false, maxDistance: 35 },
  { name: 'Deep Purple', rgb: { r: 75, g: 0, b: 110 }, hex: '#4B006E', isNeutral: false, maxDistance: 35 },
  
  // Golds - WIDER matching (maxDistance: 60) to catch gold-like colors
  { name: 'Gold', rgb: { r: 255, g: 215, b: 0 }, hex: '#FFD700', isNeutral: false, maxDistance: 60 },
  { name: 'Dark Gold', rgb: { r: 184, g: 134, b: 11 }, hex: '#B8860B', isNeutral: false, maxDistance: 60 },
  { name: 'Light Gold', rgb: { r: 250, g: 250, b: 210 }, hex: '#FAFAD2', isNeutral: false, maxDistance: 60 },
  
  // Tertiary colors
  // Magentas and Pinks - VERY WIDE matching (maxDistance: 65) to catch all shades
  { name: 'Magenta', rgb: { r: 255, g: 0, b: 255 }, hex: '#FF00FF', isNeutral: false, maxDistance: 65 },
  { name: 'Hot Pink', rgb: { r: 255, g: 105, b: 180 }, hex: '#FF69B4', isNeutral: false, maxDistance: 65 },
  { name: 'Deep Pink', rgb: { r: 255, g: 20, b: 147 }, hex: '#FF1493', isNeutral: false, maxDistance: 65 },
  { name: 'Fuchsia', rgb: { r: 255, g: 0, b: 128 }, hex: '#FF0080', isNeutral: false, maxDistance: 65 },
  { name: 'Pink', rgb: { r: 255, g: 182, b: 193 }, hex: '#FFB6C1', isNeutral: false, maxDistance: 65 },
  { name: 'Rose', rgb: { r: 255, g: 0, b: 127 }, hex: '#FF007F', isNeutral: false, maxDistance: 65 },
  { name: 'Salmon', rgb: { r: 250, g: 128, b: 114 }, hex: '#FA8072', isNeutral: false, maxDistance: 65 },
  { name: 'Coral', rgb: { r: 255, g: 127, b: 80 }, hex: '#FF7F50', isNeutral: false, maxDistance: 65 },
  { name: 'Light Pink', rgb: { r: 255, g: 182, b: 193 }, hex: '#FFB6C1', isNeutral: false, maxDistance: 65 },
  { name: 'Blush', rgb: { r: 222, g: 93, b: 131 }, hex: '#DE5D83', isNeutral: false, maxDistance: 65 },
  { name: 'Raspberry', rgb: { r: 227, g: 11, b: 92 }, hex: '#E30B5C', isNeutral: false, maxDistance: 65 },
  { name: 'Cerise', rgb: { r: 222, g: 49, b: 99 }, hex: '#DE3163', isNeutral: false, maxDistance: 65 },
  { name: 'Ruby', rgb: { r: 224, g: 17, b: 95 }, hex: '#E0115F', isNeutral: false, maxDistance: 65 },
  { name: 'Orchid', rgb: { r: 218, g: 112, b: 214 }, hex: '#DA70D6', isNeutral: false, maxDistance: 65 },
  { name: 'Pale Pink', rgb: { r: 250, g: 218, b: 221 }, hex: '#FADADD', isNeutral: false, maxDistance: 65 },
  // Teal/Cyan - VERY WIDE matching (maxDistance: 80) to merge similar cyan shades
  { name: 'Cyan', rgb: { r: 35, g: 190, b: 230 }, hex: '#23BEE6', isNeutral: false, maxDistance: 80 },
  { name: 'Teal', rgb: { r: 60, g: 128, b: 140 }, hex: '#3C808C', isNeutral: false, maxDistance: 80 },
  { name: 'Aqua', rgb: { r: 0, g: 255, b: 255 }, hex: '#00FFFF', isNeutral: false, maxDistance: 80 },
  { name: 'Turquoise', rgb: { r: 64, g: 224, b: 208 }, hex: '#40E0D0', isNeutral: false, maxDistance: 80 },
  { name: 'Dark Teal', rgb: { r: 0, g: 100, b: 100 }, hex: '#006464', isNeutral: false, maxDistance: 80 },
  { name: 'Ocean Blue', rgb: { r: 0, g: 119, b: 190 }, hex: '#0077BE', isNeutral: false, maxDistance: 80 },
  { name: 'Seafoam', rgb: { r: 159, g: 226, b: 191 }, hex: '#9FE2BF', isNeutral: false, maxDistance: 80 },
  { name: 'Robin Egg', rgb: { r: 0, g: 204, b: 204 }, hex: '#00CCCC', isNeutral: false, maxDistance: 80 },
  { name: 'Peacock', rgb: { r: 51, g: 161, b: 201 }, hex: '#33A1C9', isNeutral: false, maxDistance: 80 },
  { name: 'Cadet Blue', rgb: { r: 95, g: 158, b: 160 }, hex: '#5F9EA0', isNeutral: false, maxDistance: 80 },
  { name: 'Brown', rgb: { r: 140, g: 80, b: 40 }, hex: '#8C5028', isNeutral: false },
  
  // Skin Tones (for character illustrations like Disney)
  { name: 'Light Skin', rgb: { r: 255, g: 224, b: 189 }, hex: '#FFE0BD', isNeutral: false },
  { name: 'Medium Skin', rgb: { r: 234, g: 192, b: 134 }, hex: '#EAC086', isNeutral: false },
  { name: 'Tan Skin', rgb: { r: 198, g: 134, b: 66 }, hex: '#C68642', isNeutral: false },
  { name: 'Dark Skin', rgb: { r: 141, g: 85, b: 36 }, hex: '#8D5524', isNeutral: false },
  
  // Olive variations (additional to existing Olive in greens)
  { name: 'Dark Olive', rgb: { r: 85, g: 85, b: 0 }, hex: '#555500', isNeutral: false },
  { name: 'Light Olive', rgb: { r: 170, g: 170, b: 85 }, hex: '#AAAA55', isNeutral: false },
  { name: 'Olive Drab', rgb: { r: 107, g: 142, b: 35 }, hex: '#6B8E23', isNeutral: false },
  
  // Minimal neutrals (grouped into 2 black levels + 3 gray levels with wide matching)
  { name: 'Dark Black', rgb: { r: 10, g: 10, b: 10 }, hex: '#0A0A0A', isNeutral: true, maxDistance: 25 },
  { name: 'Light Black', rgb: { r: 40, g: 40, b: 40 }, hex: '#282828', isNeutral: true, maxDistance: 25 },
  { name: 'Dark Gray', rgb: { r: 64, g: 64, b: 64 }, hex: '#404040', isNeutral: true, maxDistance: 40 },
  { name: 'Medium Gray', rgb: { r: 128, g: 128, b: 128 }, hex: '#808080', isNeutral: true, maxDistance: 40 },
  { name: 'Light Gray', rgb: { r: 192, g: 192, b: 192 }, hex: '#C0C0C0', isNeutral: true, maxDistance: 40 },
  // White - WIDER matching (maxDistance: 70) to include super light cream colors
  { name: 'White', rgb: { r: 245, g: 245, b: 245 }, hex: '#F5F5F5', isNeutral: true, maxDistance: 70 },
];

// Default maximum distance to consider a color a valid match
// Colors can override this with their own maxDistance property
const DEFAULT_MAX_COLOR_DISTANCE = 45;

function findClosestPaletteColor(r: number, g: number, b: number): typeof COLOR_PALETTE[0] | null {
  let closest: typeof COLOR_PALETTE[0] | null = null;
  let minDistance = Infinity;
  
  for (const paletteColor of COLOR_PALETTE) {
    const dist = colorDistance({ r, g, b }, paletteColor.rgb);
    // Use per-color maxDistance if defined, otherwise use default
    const maxDist = paletteColor.maxDistance ?? DEFAULT_MAX_COLOR_DISTANCE;
    
    // Only consider this color if within its distance threshold
    if (dist < minDistance && dist <= maxDist) {
      minDistance = dist;
      closest = paletteColor;
    }
  }
  
  return closest;
}

// Detect background color by sampling image corners and edges
function detectBackgroundColor(imageData: ImageData): { r: number; g: number; b: number } | null {
  const { width, height, data } = imageData;
  const sampleSize = Math.min(10, Math.floor(Math.min(width, height) / 10));
  const edgeSamples: Array<{ r: number; g: number; b: number }> = [];
  
  // Sample from all 4 corners
  const cornerPositions = [
    { startX: 0, startY: 0 },
    { startX: width - sampleSize, startY: 0 },
    { startX: 0, startY: height - sampleSize },
    { startX: width - sampleSize, startY: height - sampleSize }
  ];
  
  for (const corner of cornerPositions) {
    for (let dy = 0; dy < sampleSize; dy++) {
      for (let dx = 0; dx < sampleSize; dx++) {
        const x = corner.startX + dx;
        const y = corner.startY + dy;
        const i = (y * width + x) * 4;
        if (data[i + 3] >= 250) {
          edgeSamples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
        }
      }
    }
  }
  
  // If corners are mostly transparent, sample along all 4 edges
  if (edgeSamples.length < 20) {
    // Sample top and bottom edges
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 50))) {
      for (const y of [0, 1, 2, height - 3, height - 2, height - 1]) {
        if (y >= 0 && y < height) {
          const i = (y * width + x) * 4;
          if (data[i + 3] >= 250) {
            edgeSamples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
          }
        }
      }
    }
    // Sample left and right edges
    for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 50))) {
      for (const x of [0, 1, 2, width - 3, width - 2, width - 1]) {
        if (x >= 0 && x < width) {
          const i = (y * width + x) * 4;
          if (data[i + 3] >= 250) {
            edgeSamples.push({ r: data[i], g: data[i + 1], b: data[i + 2] });
          }
        }
      }
    }
  }
  
  console.log(`[ColorExtractor] Edge samples collected: ${edgeSamples.length}`);
  
  if (edgeSamples.length < 20) return null; // Not enough edge samples
  
  // Find the most common color among edge/corner pixels
  const colorCounts = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (const c of edgeSamples) {
    // Quantize to reduce noise (group similar colors)
    const qr = Math.round(c.r / 16) * 16;
    const qg = Math.round(c.g / 16) * 16;
    const qb = Math.round(c.b / 16) * 16;
    const key = `${qr},${qg},${qb}`;
    const existing = colorCounts.get(key);
    if (existing) {
      existing.count++;
      existing.r = (existing.r * (existing.count - 1) + c.r) / existing.count;
      existing.g = (existing.g * (existing.count - 1) + c.g) / existing.count;
      existing.b = (existing.b * (existing.count - 1) + c.b) / existing.count;
    } else {
      colorCounts.set(key, { count: 1, r: c.r, g: c.g, b: c.b });
    }
  }
  
  // Find the dominant corner color
  const entries = Array.from(colorCounts.values());
  const bestEntry = entries.reduce<{ count: number; r: number; g: number; b: number } | null>(
    (best, entry) => (!best || entry.count > best.count) ? entry : best,
    null
  );
  
  // Only consider it a background if it's in at least 50% of edge samples
  if (bestEntry && bestEntry.count >= edgeSamples.length * 0.5) {
    const bgColor = { r: Math.round(bestEntry.r), g: Math.round(bestEntry.g), b: Math.round(bestEntry.b) };
    console.log(`[ColorExtractor] Detected background color: rgb(${bgColor.r}, ${bgColor.g}, ${bgColor.b})`);
    return bgColor;
  }
  
  return null;
}

function nameFromHsl(h: number, s: number, l: number): string {
  if (s < 0.1) {
    if (l < 0.15) return 'Near Black';
    if (l < 0.4) return 'Dark Gray';
    if (l < 0.7) return 'Gray';
    if (l < 0.9) return 'Light Gray';
    return 'Near White';
  }
  const prefix = l < 0.35 ? 'Dark ' : l > 0.7 ? 'Light ' : '';
  if (h < 15 || h >= 345) return prefix + 'Red';
  if (h < 40) return prefix + 'Orange';
  if (h < 65) return prefix + 'Yellow';
  if (h < 160) return prefix + 'Green';
  if (h < 200) return prefix + 'Teal';
  if (h < 260) return prefix + 'Blue';
  if (h < 300) return prefix + 'Purple';
  return prefix + 'Pink';
}

export function extractDominantColors(
  imageData: ImageData,
  maxColors: number = 18,
  minPercentage: number = 0.1
): ExtractedColor[] {
  const totalPx = imageData.data.length / 4;
  let _transparentCount = 0;
  for (let i = 3; i < imageData.data.length; i += 4) {
    if (imageData.data[i] < 250) _transparentCount++;
  }
  const bgColor = (_transparentCount / totalPx > 0.3) ? null : detectBackgroundColor(imageData);
  const bgColorTolerance = 30;
  
  const paletteCounts = new Map<string, { 
    color: typeof COLOR_PALETTE[0]; 
    count: number;
    totalR: number;
    totalG: number;
    totalB: number;
  }>();
  const unmatchedBuckets = new Map<string, {
    count: number;
    totalR: number;
    totalG: number;
    totalB: number;
  }>();
  const data = imageData.data;
  let totalOpaquePixels = 0;

  for (const paletteColor of COLOR_PALETTE) {
    paletteCounts.set(paletteColor.name, { 
      color: paletteColor, 
      count: 0,
      totalR: 0,
      totalG: 0,
      totalB: 0
    });
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (a < 250) continue;
    
    if (bgColor) {
      const bgDist = Math.sqrt(
        (r - bgColor.r) ** 2 + (g - bgColor.g) ** 2 + (b - bgColor.b) ** 2
      );
      if (bgDist <= bgColorTolerance) continue;
    }

    totalOpaquePixels++;

    const closestColor = findClosestPaletteColor(r, g, b);
    if (closestColor) {
      const entry = paletteCounts.get(closestColor.name)!;
      entry.count++;
      entry.totalR += r;
      entry.totalG += g;
      entry.totalB += b;
    } else {
      const qr = Math.round(r / 24) * 24;
      const qg = Math.round(g / 24) * 24;
      const qb = Math.round(b / 24) * 24;
      const key = `${qr},${qg},${qb}`;
      const existing = unmatchedBuckets.get(key);
      if (existing) {
        existing.count++;
        existing.totalR += r;
        existing.totalG += g;
        existing.totalB += b;
      } else {
        unmatchedBuckets.set(key, { count: 1, totalR: r, totalG: g, totalB: b });
      }
    }
  }

  if (totalOpaquePixels === 0) return [];

  const allColors: Array<ExtractedColor & { isNeutral: boolean }> = Array.from(paletteCounts.values())
    .filter(entry => entry.count > 0)
    .map(entry => {
      const avgR = Math.round(entry.totalR / entry.count);
      const avgG = Math.round(entry.totalG / entry.count);
      const avgB = Math.round(entry.totalB / entry.count);
      
      return {
        rgb: { r: avgR, g: avgG, b: avgB },
        hex: rgbToHex(avgR, avgG, avgB),
        count: entry.count,
        percentage: (entry.count / totalOpaquePixels) * 100,
        spotWhite: false,
        spotGloss: false,
        spotFluorY: false,
        spotFluorM: false,
        spotFluorG: false,
        spotFluorOrange: false,
        name: entry.color.name,
        isNeutral: entry.color.isNeutral
      };
    })
    .filter(c => c.percentage >= minPercentage);

  for (const [, bucket] of unmatchedBuckets) {
    const pct = (bucket.count / totalOpaquePixels) * 100;
    if (pct < minPercentage) continue;
    const avgR = Math.round(bucket.totalR / bucket.count);
    const avgG = Math.round(bucket.totalG / bucket.count);
    const avgB = Math.round(bucket.totalB / bucket.count);
    const { h, s, l } = rgbToHsl(avgR, avgG, avgB);
    const isNeutral = s < 0.1;
    
    let merged = false;
    for (const existing of allColors) {
      if (colorDistance(existing.rgb, { r: avgR, g: avgG, b: avgB }) < 35) {
        existing.count += bucket.count;
        existing.percentage += pct;
        existing.rgb = {
          r: Math.round((existing.rgb.r + avgR) / 2),
          g: Math.round((existing.rgb.g + avgG) / 2),
          b: Math.round((existing.rgb.b + avgB) / 2)
        };
        existing.hex = rgbToHex(existing.rgb.r, existing.rgb.g, existing.rgb.b);
        merged = true;
        break;
      }
    }
    if (!merged) {
      allColors.push({
        rgb: { r: avgR, g: avgG, b: avgB },
        hex: rgbToHex(avgR, avgG, avgB),
        count: bucket.count,
        percentage: pct,
        spotWhite: false,
        spotGloss: false,
        spotFluorY: false,
        spotFluorM: false,
        spotFluorG: false,
        spotFluorOrange: false,
        name: nameFromHsl(h, s, l),
        isNeutral
      });
    }
  }

  const sortedColors = allColors.sort((a, b) => b.percentage - a.percentage);

  return sortedColors.map(({ isNeutral, ...color }) => color);
}

export interface ColorGroup {
  label: string;
  colors: ExtractedColor[];
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

export function groupColorsByShade(colors: ExtractedColor[]): ColorGroup[] {
  const groups = new Map<string, ExtractedColor[]>();
  
  for (const color of colors) {
    const { r, g, b } = color.rgb;
    const { h, s, l } = rgbToHsl(r, g, b);
    
    let groupName: string;
    
    if (s < 0.1) {
      if (l < 0.08) groupName = 'Blacks';
      else if (l < 0.35) groupName = 'Dark Greys';
      else if (l < 0.65) groupName = 'Medium Greys';
      else if (l < 0.9) groupName = 'Light Greys';
      else groupName = 'Whites';
    } else if (s < 0.2 && l > 0.85) {
      groupName = 'Whites';
    } else {
      const shade = l < 0.4 ? 'Dark' : l > 0.7 ? 'Light' : '';
      
      if (h < 15 || h >= 345) groupName = shade ? `${shade} Reds` : 'Reds';
      else if (h < 40) groupName = shade ? `${shade} Oranges` : 'Oranges';
      else if (h < 70) groupName = shade ? `${shade} Yellows` : 'Yellows';
      else if (h < 160) groupName = shade ? `${shade} Greens` : 'Greens';
      else if (h < 200) groupName = shade ? `${shade} Teals` : 'Teals';
      else if (h < 260) groupName = shade ? `${shade} Blues` : 'Blues';
      else if (h < 310) groupName = shade ? `${shade} Purples` : 'Purples';
      else groupName = shade ? `${shade} Pinks` : 'Pinks';
    }
    
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName)!.push(color);
  }
  
  const groupOrder = [
    'Reds', 'Light Reds', 'Dark Reds',
    'Oranges', 'Light Oranges', 'Dark Oranges',
    'Yellows', 'Light Yellows', 'Dark Yellows',
    'Greens', 'Light Greens', 'Dark Greens',
    'Teals', 'Light Teals', 'Dark Teals',
    'Blues', 'Light Blues', 'Dark Blues',
    'Purples', 'Light Purples', 'Dark Purples',
    'Pinks', 'Light Pinks', 'Dark Pinks',
    'Whites', 'Light Greys', 'Medium Greys', 'Dark Greys', 'Blacks'
  ];
  
  const result: ColorGroup[] = [];
  for (const label of groupOrder) {
    const colors = groups.get(label);
    if (colors && colors.length > 0) {
      colors.sort((a, b) => b.percentage - a.percentage);
      result.push({ label, colors });
    }
  }
  
  groups.forEach((groupColors, label) => {
    if (!groupOrder.includes(label)) {
      groupColors.sort((a: ExtractedColor, b: ExtractedColor) => b.percentage - a.percentage);
      result.push({ label, colors: groupColors });
    }
  });
  
  return result;
}

export function extractColorsFromCanvas(canvas: HTMLCanvasElement, maxColors: number = 18): ExtractedColor[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) return [];
  
  const sampleSize = Math.min(canvas.width, canvas.height, 300);
  const scaleX = sampleSize / canvas.width;
  const scaleY = sampleSize / canvas.height;
  
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = Math.max(1, Math.floor(canvas.width * scaleX));
  tempCanvas.height = Math.max(1, Math.floor(canvas.height * scaleY));
  const tempCtx = tempCanvas.getContext('2d');
  if (!tempCtx) return [];
  
  tempCtx.drawImage(canvas, 0, 0, tempCanvas.width, tempCanvas.height);
  const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  
  return extractDominantColors(imageData, maxColors);
}

export function extractColorsFromImage(image: HTMLImageElement, maxColors: number = 18): ExtractedColor[] {
  try {
    if (!image.complete || image.width === 0 || image.height === 0) return [];
    
    const MAX_DIM = 512;
    let w = image.width;
    let h = image.height;
    if (Math.max(w, h) > MAX_DIM) {
      const ratio = MAX_DIM / Math.max(w, h);
      w = Math.round(w * ratio);
      h = Math.round(h * ratio);
    }

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    if (!tempCtx) return [];
    
    tempCtx.drawImage(image, 0, 0, w, h);
    const imageData = tempCtx.getImageData(0, 0, w, h);
    
    return extractDominantColors(imageData, maxColors);
  } catch (e) {
    console.warn('[ColorExtractor] extractColorsFromImage failed:', e);
    return [];
  }
}

import ColorExtractionWorker from './color-extraction-worker?worker';

let _colorWorker: Worker | null = null;
function getColorWorker(): Worker | null {
  if (!_colorWorker) {
    try { _colorWorker = new ColorExtractionWorker(); }
    catch { return null; }
  }
  return _colorWorker;
}

export function extractColorsFromImageAsync(image: HTMLImageElement, maxColors: number = 999): Promise<ExtractedColor[]> {
  return new Promise((resolve) => {
    try {
      if (!image.complete || image.width === 0 || image.height === 0) { resolve([]); return; }

      const MAX_DIM = 512;
      let w = image.width, h = image.height;
      if (Math.max(w, h) > MAX_DIM) {
        const ratio = MAX_DIM / Math.max(w, h);
        w = Math.round(w * ratio); h = Math.round(h * ratio);
      }
      const tc = document.createElement('canvas');
      tc.width = w; tc.height = h;
      const ctx = tc.getContext('2d');
      if (!ctx) { resolve(extractColorsFromImage(image, maxColors)); return; }
      ctx.drawImage(image, 0, 0, w, h);
      let imageData: ImageData;
      try {
        imageData = ctx.getImageData(0, 0, w, h);
      } catch (e) {
        console.warn('[ColorExtractor] getImageData failed (possibly tainted canvas):', e);
        resolve([]);
        return;
      }

      const worker = getColorWorker();
      if (!worker) { resolve(extractDominantColors(imageData, maxColors)); return; }

      const buffer = imageData.data.buffer.slice(0);
      const timeout = setTimeout(() => {
        try {
          resolve(extractDominantColors(ctx.getImageData(0, 0, w, h), maxColors));
        } catch {
          resolve(extractDominantColors(imageData, maxColors));
        }
      }, 10000);

      const handler = (e: MessageEvent) => {
        if (e.data.type === 'result') {
          clearTimeout(timeout);
          worker.removeEventListener('message', handler);
          resolve(e.data.colors);
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'extract', pixelBuffer: buffer, width: w, height: h, maxColors, minPercentage: 0.1 }, [buffer]);
    } catch (e) {
      console.warn('[ColorExtractor] extractColorsFromImageAsync failed:', e);
      resolve([]);
    }
  });
}
