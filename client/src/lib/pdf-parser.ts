import * as pdfjsLib from 'pdfjs-dist';
import 'pdfjs-dist/build/pdf.worker.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export interface ParsedPDFData {
  image: HTMLImageElement;
  width: number;
  height: number;
  originalPdfData: ArrayBuffer;
  dpi: number;
}

export async function parsePDF(file: File): Promise<ParsedPDFData> {
  let pdf: pdfjsLib.PDFDocumentProxy | null = null;
  try {
    const arrayBuffer = await file.arrayBuffer();

    pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);

    const targetDPI = 300;
    const pdfScale = targetDPI / 72;
    const viewport = page.getViewport({ scale: pdfScale });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Could not create canvas context for PDF rendering');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport: viewport,
      background: 'rgba(0,0,0,0)'
    } as any).promise;

    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load rendered PDF image'));
      img.src = canvas.toDataURL('image/png');
    });

    canvas.width = 0;
    canvas.height = 0;

    return {
      image,
      width: viewport.width,
      height: viewport.height,
      originalPdfData: arrayBuffer,
      dpi: targetDPI
    };
  } finally {
    pdf?.destroy();
  }
}

export function isPDFFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
}
