export interface ImageInfo {
  file: File;
  image: HTMLImageElement;
  originalWidth: number;
  originalHeight: number;
  dpi: number;
  isPDF?: boolean;
  originalPdfData?: ArrayBuffer;
  /** Full-resolution PNG (post-crop, pre-downsample) preserved for HD export.
   *  `image` above is capped at MAX_STORED_IMAGE_DIMENSION for preview memory;
   *  the export path decodes this blob just-in-time to keep 300 DPI at print
   *  sizes larger than the preview cap. */
  exportBlob?: Blob;
}

export interface ResizeSettings {
  widthInches: number;
  heightInches: number;
  maintainAspectRatio: boolean;
  outputDPI: number;
}

export interface ImageTransform {
  nx: number;
  ny: number;
  s: number;
  rotation: number;
  flipX?: boolean;
  flipY?: boolean;
}

export type HalftoneStrength = 'light' | 'balanced' | 'strong';

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
  /** Set by the halftone tool. Export pipeline pre-cleans halftoned designs to
   *  guarantee binary alpha (0 or 255) and uses nearest-neighbour scaling so
   *  bilinear interpolation cannot reintroduce semi-transparent edge pixels. */
  halftoned?: boolean;
  /** Settings used to rebuild the halftone when its physical size changes. */
  halftoneSettings?: HalftoneSettings;
  /** Original pixels kept in memory so resizing never halftones the halftone. */
  halftoneSourceImage?: HTMLImageElement;
  printFileName?: boolean;
  /**
   * User-defined group membership. Designs sharing the same `groupId` are
   * treated as a single unit by:
   *   - selection (clicking any member selects the whole group)
   *   - auto-arrange (the group is packed as one super-item whose bounding
   *     box is preserved so intra-group layout stays intact)
   *
   * `undefined` means "not grouped". Empty string is not valid — always
   * omit the field instead. This design uses a shared id (rather than a
   * separate `groups: Map<id, Set<id>>` structure) because it round-trips
   * through the existing snapshot + draft-persistence pipelines without a
   * migration, and because there is no case in the app where a design
   * belongs to more than one group at once.
   */
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
