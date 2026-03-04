export const CLIPPER_SCALE = 100000;

export function calculateClipperTolerances(dpi: number, offsetWidth: number) {
  const pixelsPerPoint = dpi / 72;
  const baseSimplify = Math.max(0.5, offsetWidth * 0.02);
  const arcTolerance = CLIPPER_SCALE * Math.max(0.15, Math.min(0.5, 2.0 / pixelsPerPoint));
  const simplifyTolerance = Math.max(0.3, baseSimplify);
  const miterLimit = 10.0;

  return {
    arcTolerance,
    simplifyTolerance,
    miterLimit
  };
}
