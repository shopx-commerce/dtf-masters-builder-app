import * as pdfjsLib from 'pdfjs-dist';
import { IOS_SAFE_CANVAS_DIM, MAX_UPLOAD_MEGAPIXELS } from './image-budget';
import { VECTOR_TARGET_DPI, vectorPrintDpi } from './vector-raster-limits';

// The `new URL(..., import.meta.url)` reference below is enough for Vite
// to emit the worker as a separately-addressable asset. The old static
// side-effect import (`import 'pdfjs-dist/build/pdf.worker.min.mjs'`) was
// redundant and forced the ~1 MB worker into the main bundle on some
// build configurations.
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

/**
 * CMap + standard-font data URLs.
 *
 * These are *the* two most-forgotten pdf.js configuration knobs and each
 * one silently corrupts renders when absent:
 *
 *  - `cMapUrl`: pdf.js needs the Adobe CMap tables to decode CJK
 *    (Chinese / Japanese / Korean) character streams. Without them,
 *    every glyph in a CJK PDF renders as a garbled block or is missing
 *    outright. Users uploading Japanese logo art or Chinese kanji
 *    stickers will see empty rectangles instead of text.
 *
 *  - `standardFontDataUrl`: PDF's 14 "standard" fonts (Helvetica,
 *    Times, Courier, Symbol, ZapfDingbats, plus their bold / italic
 *    variants) are *not required* to be embedded in a PDF file — the
 *    spec assumes every reader has them. pdf.js's implementation of
 *    that assumption is to load them from `standard_fonts/` when
 *    referenced. Without this URL, un-embedded standard fonts fall
 *    back to system fonts (whichever the OS picks) OR to path-based
 *    stroke rendering, both of which look *nothing* like the source
 *    PDF.
 *
 * Both asset sets are served from our own origin rather than a public CDN.
 * Correct rendering should not depend on an external host: under a strict
 * Shopify CSP, or on a flaky network, a CDN fetch fails silently and the
 * customer just sees empty boxes where their Japanese text was, or a
 * substituted font that looks nothing like their file. `client/public/pdfjs/`
 * carries a vendored copy of `pdfjs-dist`'s `cmaps/` and `standard_fonts/`,
 * keyed to the installed package version, so Vite serves them from our own
 * origin in dev and copies them into the build output automatically.
 *
 * The cost of these two URLs being wrong is real (text renders as
 * garbage / substituted-font); the cost of them being right on a PDF
 * that doesn't need them is zero (pdf.js only fetches on demand).
 */
const PDF_ASSETS_BASE = `${import.meta.env.BASE_URL}pdfjs`;
const CMAP_URL = `${PDF_ASSETS_BASE}/cmaps/`;
const STANDARD_FONT_DATA_URL = `${PDF_ASSETS_BASE}/standard_fonts/`;

export interface ParsedPDFData {
  image: HTMLImageElement;
  width: number;
  height: number;
  originalPdfData: ArrayBuffer;
  /** Rendered preview as a PNG blob, so callers can treat a PDF upload exactly
   *  like a PNG one — including storing a decodable file for draft recovery,
   *  which an `<img>` cannot do with the original PDF bytes. */
  pngBlob: Blob;
  /** Page 1's own physical size, taken from its PDF geometry rather than
   *  inferred from the preview raster. The preview is clamped for editor
   *  memory, so deriving inches from its pixel count would make a large page
   *  import at the wrong size once the clamp kicked in. */
  widthInches: number;
  heightInches: number;
  /**
   * Print DPI for the imported design — 300, like a raster upload, because the
   * export path re-renders the page at the placement size. Only drops below
   * 300 when the platform's canvas ceiling cannot hold a 300 DPI render of a
   * page this large.
   */
  dpi: number;
  /** DPI of the clamped on-screen preview. Diagnostics only. */
  previewDpi: number;
  /** Total pages in the document. Only page 1 is rasterized for editing;
   *  the caller can surface a "multi-page PDF, using page 1" toast when
   *  `pageCount > 1`. */
  pageCount: number;
  /**
   * True when page 1 contains rendered text runs. Callers use this to
   * warn the user that non-embedded / substituted fonts may make the
   * rasterised output look different from the original — the "convert
   * text to paths / outlines before saving" advice is the standard fix
   * and cuts customer-support tickets for logos with fancy typography.
   *
   * Detection is deliberately coarse: any positive text-run count sets
   * the flag. Distinguishing "text with embedded fonts (safe)" from
   * "text with substituted fonts (risky)" would require walking the
   * font dictionary of every page — the coarse warning trades some
   * false positives for zero false negatives, which is the right
   * balance for a user-facing prompt.
   */
  hasText: boolean;
}

/**
 * Rasterize page 1 of a PDF to an `HTMLImageElement`.
 *
 * Design notes:
 *  - Target DPI is 300, but the render scale is dialled down whenever the
 *    resulting canvas would exceed the iOS-safe canvas ceiling
 *    (`IOS_SAFE_CANVAS_DIM`) or the shared megapixel budget. iOS Safari
 *    silently no-ops `drawImage` above 4096 px per edge, so a 300-DPI
 *    render of a 20 × 20 in poster would produce a black image without
 *    this guard.
 *  - We use `canvas.toBlob('image/png')` — never `toDataURL` — because
 *    base64 doubles memory and stalls the main thread with a single
 *    synchronous string allocation.
 *  - `originalPdfData` is retained for high-quality re-rendering at
 *    export time (the export path can decode again at print size).
 *  - `pdf.destroy()` is called in a `finally` block so parse failures
 *    still release the pdf.js worker's document handle.
 */
export async function parsePDF(file: File): Promise<ParsedPDFData> {
  let pdf: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    const arrayBuffer = await file.arrayBuffer();

    // pdf.js *transfers* whatever we pass as `data` to its worker, which
    // detaches the caller's ArrayBuffer. Passing `arrayBuffer` directly left
    // `originalPdfData` below zero-length and unreadable, so the retained
    // source was useless and drafts persisted an empty buffer. Give the worker
    // a throwaway copy and keep the original intact.
    const workerData = new Uint8Array(arrayBuffer.slice(0));

    pdf = await pdfjsLib.getDocument({
      data: workerData,
      // See PDF_ASSETS_BASE above for why these matter.
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      // Reproducibility over convenience: with `useSystemFonts: true`
      // (the web default) pdf.js will pull whichever Helvetica /
      // Times / Courier the *user's* OS has installed. Two customers
      // uploading the same logo on Windows vs macOS then see subtly
      // different rasterised output, which is confusing on a print
      // preview. Forcing `false` routes un-embedded fonts through the
      // `standard_fonts/` data (loaded via `standardFontDataUrl`
      // above), giving byte-identical output across environments.
      useSystemFonts: false,
    }).promise;
    const pageCount = pdf.numPages;
    const page = await pdf.getPage(1);

    // Text presence probe. Runs before `page.render` so the check has
    // zero effect on render throughput (pdf.js caches the parsed text
    // content for the subsequent render call anyway). We treat any
    // non-whitespace text run as "has text".
    let hasText = false;
    try {
      const textContent = await page.getTextContent();
      hasText = textContent.items.some(item =>
        'str' in item && typeof item.str === 'string' && item.str.trim().length > 0
      );
    } catch {
      // If text extraction fails we default to `false` — a warning we
      // failed to emit is strictly better than a false positive that
      // spooks users on every plain-vector logo.
    }

    // Page geometry at scale 1 is in PDF points, 72 to the inch. This is the
    // page's true physical size and the only trustworthy source for it — the
    // preview raster below gets clamped, so measuring the page from its pixels
    // would shrink a large document once the clamp engaged.
    const pointsViewport = page.getViewport({ scale: 1 });
    const widthInches = Math.max(0.01, pointsViewport.width / 72);
    const heightInches = Math.max(0.01, pointsViewport.height / 72);

    const targetDPI = VECTOR_TARGET_DPI;
    // Point/pixel ratio for pdf.js is `viewport.scale`. `1` means 72 DPI,
    // `targetDPI / 72` means "render at 300 DPI".
    let renderScale = targetDPI / 72;
    const baseViewport = page.getViewport({ scale: renderScale });

    // Guard 1: iOS-safe canvas ceiling.
    const dimensionalScale = Math.min(
      IOS_SAFE_CANVAS_DIM / Math.max(baseViewport.width, 1),
      IOS_SAFE_CANVAS_DIM / Math.max(baseViewport.height, 1),
      1,
    );

    // Guard 2: megapixel budget. Match rasters — huge posters and prints
    // can trip this before the dimensional cap does.
    const previewPixels = baseViewport.width * baseViewport.height;
    const megapixelScale = Math.min(
      Math.sqrt((MAX_UPLOAD_MEGAPIXELS * 1_000_000) / Math.max(previewPixels, 1)),
      1,
    );

    const safetyScale = Math.min(dimensionalScale, megapixelScale);
    if (safetyScale < 1) renderScale *= safetyScale;

    const viewport = page.getViewport({ scale: renderScale });
    const previewDpi = Math.max(1, Math.round(72 * renderScale));

    const canvas = document.createElement('canvas');
    // `viewport.width/height` can carry fractional pixels for
    // arbitrary rotation / scale combos. Canvas dimensions must be
    // integers or Chrome silently truncates and Safari draws to a
    // sub-pixel-aligned buffer that pdf.js then paints outside of.
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error('Could not create canvas context for PDF rendering');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport: viewport,
      background: 'rgba(0,0,0,0)',
      // `intent: 'print'` tells pdf.js to render for print output:
      // annotations that are marked "screen only" get suppressed, and
      // the renderer is more conservative about anti-alias hinting so
      // the raster is faithful to what a real printer would produce
      // from this PDF. Since our downstream is literally a print
      // pipeline, this is the correct mode.
      intent: 'print',
    } as Parameters<typeof page.render>[0]).promise;

    // `toBlob` streams the PNG encode instead of allocating a giant
    // base64 string. Awaited as a promise so we can chain the image load.
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    if (!blob) throw new Error('Failed to encode PDF as PNG');

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.decoding = 'async';
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load rendered PDF image')); };
      img.src = url;
    });

    // Capture pixel dimensions *before* zeroing the canvas — the
    // zeroing below is a deliberate eager-free so the browser can
    // reclaim the decoded pixels while the export pipeline is still
    // holding the loaded `image`, but reading `canvas.width` after
    // that would return 0.
    const renderedWidth = canvas.width;
    const renderedHeight = canvas.height;
    canvas.width = 0;
    canvas.height = 0;

    return {
      image,
      width: renderedWidth,
      height: renderedHeight,
      originalPdfData: arrayBuffer,
      pngBlob: blob,
      widthInches,
      heightInches,
      // Print DPI, not the preview's: the export path re-renders this page at
      // the placement size, so a clamped preview costs nothing at print time.
      dpi: vectorPrintDpi(widthInches, heightInches),
      previewDpi,
      pageCount,
      hasText,
    };
  } finally {
    pdf?.destroy();
  }
}

/**
 * Re-render page 1 of a retained PDF at (at least) the requested pixel size.
 *
 * The import-time raster is a preview clamped to a screen-safe ceiling, so
 * reusing it at print size means upscaling pixels for artwork that is still
 * fully vector. The export path calls this instead, so a design placed at 20
 * inches is drawn from the PDF's own geometry at 300 DPI rather than stretched
 * from a 4096 px preview.
 *
 * Scale is chosen to cover the target box on both axes, never to upsample: the
 * caller resizes the result down to the exact placement box. `clampToMaxEdge`
 * lets the caller impose the platform's canvas ceiling.
 */
export async function rasterisePdfPageToPngBlob(
  pdfData: ArrayBuffer,
  targetWidth: number,
  targetHeight: number,
  clampToMaxEdge: number,
): Promise<Blob> {
  let pdf: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    // Same transfer caveat as parsePDF: pdf.js detaches whatever it is given,
    // and this buffer has to survive for the next design and the next export.
    pdf = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfData.slice(0)),
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
      useSystemFonts: false,
    }).promise;
    const page = await pdf.getPage(1);

    const base = page.getViewport({ scale: 1 });
    let scale = Math.max(
      targetWidth / Math.max(base.width, 1),
      targetHeight / Math.max(base.height, 1),
    );
    const longestEdge = Math.max(base.width, base.height) * scale;
    if (longestEdge > clampToMaxEdge) scale *= clampToMaxEdge / longestEdge;

    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true });
    if (!ctx) throw new Error('Could not create canvas context for PDF rendering');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport,
      background: 'rgba(0,0,0,0)',
      intent: 'print',
    } as Parameters<typeof page.render>[0]).promise;

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/png');
    });
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('Failed to encode PDF page as PNG');
    return blob;
  } finally {
    pdf?.destroy();
  }
}

export function isPDFFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}
