export interface PDFCutContourInfo {
  hasCutContour: boolean;
  cutContourPath: Path2D | null;
  cutContourPoints: { x: number; y: number }[][];
  pageWidth: number;
  pageHeight: number;
}

export interface ImageInfo {
  file: File;
  image: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  dpi: number;
  isPDF?: boolean;
  pdfCutContourInfo?: PDFCutContourInfo;
  originalPdfData?: ArrayBuffer;
  /** Full-resolution PNG (post-crop, pre-downsample) preserved for HD export. */
  exportBlob?: Blob;
}

export type ContourCornerMode = "rounded" | "sharp";
export type ContourAlgorithm = "shapes" | "complex";

export interface StrokeSettings {
  width: number;
  color: string;
  enabled: boolean;
  alphaThreshold: number;
  backgroundColor: string;
  useCustomBackground: boolean;
  cornerMode: ContourCornerMode;
  autoBridging: boolean;
  autoBridgingThreshold: number;
  algorithm?: ContourAlgorithm;
}

export type StrokeMode = "none" | "contour" | "shape";

export interface ResizeSettings {
  widthInches: number;
  heightInches: number;
  maintainAspectRatio: boolean;
  outputDPI: number;
}

export interface ShapeSettings {
  enabled: boolean;
  type:
    | "square"
    | "rectangle"
    | "circle"
    | "oval"
    | "rounded-square"
    | "rounded-rectangle";
  offset: number;
  fillColor: string;
  strokeEnabled: boolean;
  strokeWidth: number;
  strokeColor: string;
  cornerRadius?: number;
  bleedEnabled?: boolean;
  bleedColor?: string;
  widthInches?: number;
  heightInches?: number;
  offsetX?: number;
  offsetY?: number;
}

export type CutlineVisibility = "thin" | "normal" | "bold";
export type StickerSize = number;

export const STICKER_SIZES: { value: StickerSize; label: string }[] = [
  { value: 2, label: "2 inch" },
  { value: 2.5, label: "2.5 inch" },
  { value: 3, label: "3 inch" },
  { value: 3.5, label: "3.5 inch" },
  { value: 4, label: "4 inch" },
  { value: 4.5, label: "4.5 inch" },
  { value: 5, label: "5 inch" },
  { value: 5.5, label: "5.5 inch" },
  { value: 6, label: "6 inch" },
];

export interface SpotColorData {
  hex: string;
  rgb: { r: number; g: number; b: number };
  spotWhite: boolean;
  spotGloss: boolean;
}

export interface ImageTransform {
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
}

export type HalftoneStrength = "light" | "balanced" | "strong";

export interface HalftoneSettings {
  color: { r: number; g: number; b: number };
  strength: HalftoneStrength;
}

export interface DesignItem {
  id: string;
  imageInfo: ImageInfo;
  transform: ImageTransform;
  widthInches: number;
  heightInches: number;
  name: string;
  originalDPI: number;
  alphaThresholded?: boolean;
  halftoned?: boolean;
  halftoneSettings?: HalftoneSettings;
  halftoneSourceImage?: HTMLImageElement;
  printFileName?: boolean;
  groupId?: string;
}

export function computeLayerRect(
  imageWidthPx: number,
  imageHeightPx: number,
  transform: ImageTransform,
  artboardWidthPx: number,
  artboardHeightPx: number,
  artboardWidthInches: number,
  artboardHeightInches: number,
  imageWidthInches: number,
  imageHeightInches: number,
): { x: number; y: number; width: number; height: number } {
  const designWidthPx = (imageWidthInches / artboardWidthInches) * artboardWidthPx;
  const designHeightPx = (imageHeightInches / artboardHeightInches) * artboardHeightPx;
  const finalWidth = designWidthPx * transform.s;
  const finalHeight = designHeightPx * transform.s;
  const cx = transform.nx * artboardWidthPx;
  const cy = transform.ny * artboardHeightPx;
  return {
    x: cx - finalWidth / 2,
    y: cy - finalHeight / 2,
    width: finalWidth,
    height: finalHeight,
  };
}
