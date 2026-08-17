/**
 * Draws a design's printed filename onto a PDF page.
 *
 * The PDF exports are a third rendering of the same label, alongside the preview canvas and the
 * export worker, and they had drifted furthest: a fixed 0.08 inch font regardless of the design's
 * size, no white background, and a position derived from the design's bounding box rather than
 * from the layout the nester reserved film for — which put the label near the top-left of a
 * rotated design instead of with its artwork.
 *
 * This takes the same `PrintLabelLayout` everything else draws from and only converts coordinates,
 * so a label cannot be in one place on the sheet and another in the production PDF.
 */

import type { PrintLabelLayout } from './print-label';
import { labelReadsUpsideDown } from './print-label';

const POINTS_PER_INCH = 72;

/** The pdf-lib surface this needs, named locally so the module does not import the library. */
interface PdfPageLike {
  drawRectangle: (options: Record<string, unknown>) => void;
  drawText: (text: string, options: Record<string, unknown>) => void;
}

interface PdfFontLike {
  widthOfTextAtSize: (text: string, size: number) => number;
}

export interface PdfLabelPlacement {
  /** The design's centre on the page, in points, y measured up from the bottom. */
  centerXPt: number;
  centerYPt: number;
  /** The design's rotation in degrees, as stored on the transform (clockwise, y down). */
  rotationDeg: number;
  /** Artwork height in inches at its current scale, to scale the layout by. */
  artHeightInches: number;
  /** Drawn artwork height in points, so the label tracks the image actually placed. */
  artHeightPt: number;
}

/**
 * Maps a point in the label's coordinates — inches from the artwork's centre, y down — onto the
 * page, in points with y up.
 *
 * The rotation matrix is the one the page's `drawImage` call already uses, so a label anchored to
 * the artwork's corner lands on that corner however the design is turned.
 */
function toPage(
  lx: number,
  ly: number,
  place: PdfLabelPlacement,
  scalePt: number,
): { x: number; y: number } {
  const rad = (-place.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const px = lx * scalePt;
  const py = ly * scalePt;
  return {
    x: place.centerXPt + px * cos + py * sin,
    y: place.centerYPt + px * sin - py * cos,
  };
}

export function drawPrintLabelOnPdfPage(
  page: PdfPageLike,
  font: PdfFontLike,
  layout: PrintLabelLayout,
  place: PdfLabelPlacement,
  degrees: (angle: number) => unknown,
): void {
  if (!(place.artHeightInches > 0)) return;
  // Points per inch of *label* geometry. Taken from the drawn artwork rather than assumed to be 72
  // so the label stays proportional if the page is ever scaled.
  const scalePt = place.artHeightPt / place.artHeightInches;
  const { rect } = layout;
  const upsideDown = labelReadsUpsideDown(place.rotationDeg);
  const rotate = degrees(-place.rotationDeg + (upsideDown ? 180 : 0));

  // pdf-lib rotates a shape about the point it is anchored at, so the anchor is whichever corner
  // the content grows away from: bottom-left normally, top-right through a half turn.
  const boxAnchor = upsideDown
    ? toPage(rect.x + rect.width, rect.y, place, scalePt)
    : toPage(rect.x, rect.y + rect.height, place, scalePt);
  page.drawRectangle({
    x: boxAnchor.x,
    y: boxAnchor.y,
    width: rect.width * scalePt,
    height: rect.height * scalePt,
    rotate,
    color: { type: 'RGB', red: 1, green: 1, blue: 1 },
  });

  const sizePt = layout.fontInches * scalePt;
  const textWidthPt = font.widthOfTextAtSize(layout.text, sizePt);
  const textWidthInches = textWidthPt / scalePt;
  const startX = rect.x + (rect.width - textWidthInches) / 2;
  // Baselines sit below the visual centre by roughly a third of the em for Helvetica's cap height;
  // exact metrics are not worth an extra font query for a production label.
  const baselineOffset = layout.fontInches * 0.35;
  const centreY = rect.y + rect.height / 2;
  const textAnchor = upsideDown
    ? toPage(startX + textWidthInches, centreY - baselineOffset, place, scalePt)
    : toPage(startX, centreY + baselineOffset, place, scalePt);

  page.drawText(layout.text, {
    x: textAnchor.x,
    y: textAnchor.y,
    size: sizePt,
    font,
    rotate,
    color: { type: 'RGB', red: 0, green: 0, blue: 0 },
  });
}

export { POINTS_PER_INCH };
