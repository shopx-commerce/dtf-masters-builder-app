import { getImageBounds } from "@/lib/image-crop";

export { getImageBounds };

/**
 * Die-cut crop, ported verbatim from the original Sticker Outline app.
 *
 * The shared AnyNest @/lib/image-crop version also strips solid edge
 * backgrounds and crops with no padding, which yields a different aspect
 * ratio (and therefore different default sticker dimensions) than the
 * standalone sticker builder produced for the same upload. Die-cut keeps the
 * original behavior: alpha bounds only, plus a 3px transparent margin so
 * contour tracing has room at the edges.
 */
export function cropImageToContent(
  image: HTMLImageElement,
): HTMLCanvasElement | null {
  try {
    const bounds = getImageBounds(image);

    if (bounds.width <= 0 || bounds.height <= 0) {
      console.warn("Invalid crop bounds, returning null");
      return null;
    }

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.error("Failed to get canvas context");
      return null;
    }

    const edgePad = 3;
    canvas.width = bounds.width + edgePad * 2;
    canvas.height = bounds.height + edgePad * 2;

    ctx.drawImage(
      image,
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      edgePad,
      edgePad,
      bounds.width,
      bounds.height,
    );

    return canvas;
  } catch (error) {
    console.error("Error cropping image:", error);
    return null;
  }
}
