import { useCallback, useState, useEffect, useRef } from "react";
import { Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/i18n";
import { useMetric } from "@/lib/format-length";
import { runWithConcurrency, resolveUploadConcurrency } from "@/lib/upload-queue";
import { checkPixelBudget, formatMegapixels, MAX_UPLOAD_MEGAPIXELS } from "@/lib/image-budget";
import type { ImageInfo, ResizeSettings } from "./image-editor";

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'image/svg+xml', 'application/postscript', 'application/eps', 'application/x-eps'];
const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.svg', '.eps'];
const GRADIENT_COLORS = [
  { bg: 'rgb(34, 197, 94)', glow: 'rgba(34, 197, 94, 0.5)' },
  { bg: 'rgb(234, 179, 8)', glow: 'rgba(234, 179, 8, 0.5)' },
  { bg: 'rgb(249, 115, 22)', glow: 'rgba(249, 115, 22, 0.5)' },
  { bg: 'rgb(236, 72, 153)', glow: 'rgba(236, 72, 153, 0.5)' },
];

interface UploadSectionProps {
  /** Returns a promise so the outer concurrency queue can wait for each
   *  file's processing to complete before starting the next. Callers may
   *  return `void` for legacy behaviour; the queue will treat that as
   *  "done immediately". */
  onImageUpload: (file: File, image: HTMLImageElement | null) => void | Promise<void>;
  onBatchStart?: (fileCount: number) => void;
  imageInfo?: ImageInfo | null;
  resizeSettings?: ResizeSettings | null;
  /** Shopify embed: always use compact toolbar button, never the full "Make a Gangsheet" hero */
  embedCompact?: boolean;
}

export default function UploadSection({ onImageUpload, onBatchStart, imageInfo, embedCompact = false }: UploadSectionProps) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const metric = useMetric(lang);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    const isSvg = file.type === 'image/svg+xml' || ext.endsWith('.svg');
    const isEps = ext.endsWith('.eps') || file.type === 'application/postscript' || file.type === 'application/eps' || file.type === 'application/x-eps';
    const isImage = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.some(e => ext.endsWith(e));

    if (!isImage && !isPdf && !isSvg && !isEps) {
      toast({ title: t("toast.unsupportedFormat"), description: t("toast.unsupportedFormatDesc"), variant: "destructive" });
      return;
    }

    if (isPdf || isSvg || isEps) {
      // Vector formats bypass the per-file rasterisation done here.
      // `handleFileUploadUnified` in the model owns the pdf.js /
      // sanitised-SVG / EPS-reject pipeline. Awaited so the batch queue
      // does not release this slot until the vector parse finishes —
      // otherwise 20 dropped PDFs would spin up 20 pdf.js workers in
      // parallel, blowing past the tab memory limit.
      await onImageUpload(file, null as unknown as HTMLImageElement);
      return;
    }

    // Decode the raster metadata up front so we can enforce a megapixel
    // budget *before* creating full-resolution canvases. iOS Safari caps
    // a single canvas at 4096 × 4096 — above that `drawImage` silently
    // no-ops and the user sees a black upload. A 200 MP scan can also
    // crash the tab outright on any mobile browser.
    await new Promise<void>((resolve) => {
      const img = new Image();
      img.decoding = "async";
      const originalUrl = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(originalUrl);

        const budget = checkPixelBudget(img.naturalWidth || img.width, img.naturalHeight || img.height);
        if (!budget.ok) {
          toast({
            title: t("toast.imageTooLarge"),
            description: t("toast.imageTooLargeDesc", {
              size: formatMegapixels(budget.megapixels),
              max: `${MAX_UPLOAD_MEGAPIXELS} MP`,
            }),
            variant: "destructive",
          });
          resolve();
          return;
        }

        // Cheap transparency probe on a 512 px thumbnail. Bounded so this
        // never allocates more than ~1 MB even when the source is huge.
        const c = document.createElement('canvas');
        c.width = Math.min(img.width, 512);
        c.height = Math.min(img.height, 512);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          let hasTransparency = false;
          for (let i = 3; i < data.length; i += 16) {
            if (data[i] < 250) { hasTransparency = true; break; }
          }
          if (!hasTransparency) {
            toast({
              title: t("toast.solidBg"),
              description: t("toast.solidBgDesc"),
              variant: "warning",
            });
          }
        }
        // Explicit zero-size to free the thumbnail canvas before the
        // (potentially much larger) full-res conversion below.
        c.width = 0; c.height = 0;

        const isPng = file.type === 'image/png' || ext.endsWith('.png');
        if (!isPng) {
          const cvs = document.createElement('canvas');
          cvs.width = img.width;
          cvs.height = img.height;
          const cctx = cvs.getContext('2d');
          if (!cctx) { void Promise.resolve(onImageUpload(file, img)).finally(resolve); return; }
          cctx.drawImage(img, 0, 0);
          cvs.toBlob((blob) => {
            cvs.width = 0; cvs.height = 0;
            if (!blob) { void Promise.resolve(onImageUpload(file, img)).finally(resolve); return; }
            const pngFile = new File([blob], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
            const pngImg = new Image();
            pngImg.decoding = "async";
            const u = URL.createObjectURL(blob);
            pngImg.onload = () => {
              URL.revokeObjectURL(u);
              void Promise.resolve(onImageUpload(pngFile, pngImg)).finally(resolve);
            };
            pngImg.onerror = () => {
              URL.revokeObjectURL(u);
              void Promise.resolve(onImageUpload(file, img)).finally(resolve);
            };
            pngImg.src = u;
          }, 'image/png');
        } else {
          void Promise.resolve(onImageUpload(file, img)).finally(resolve);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(originalUrl);
        toast({ title: t("toast.failedLoad"), description: t("toast.failedLoadDesc"), variant: "destructive" });
        resolve();
      };
      img.src = originalUrl;
    });
  }, [onImageUpload, toast, t]);

  const processBatch = useCallback(async (files: File[]) => {
    if (files.length > 1) onBatchStart?.(files.length);
    // Bounded concurrency: 1 file at a time on mobile, 2 on desktop.
    // The pre-existing parallel `for (const f of files) handleFileUpload(f)`
    // was the direct cause of iOS Safari OOM crashes when a user dropped
    // more than a handful of PNGs. See lib/upload-queue.ts for defaults.
    await runWithConcurrency(files, (file) => handleFileUpload(file), {
      concurrency: resolveUploadConcurrency(),
      onError: (error, file) => {
        console.error(`Upload failed for ${file.name}:`, error);
      },
    });
  }, [handleFileUpload, onBatchStart]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    void processBatch(Array.from(e.dataTransfer.files));
  }, [processBatch]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void processBatch(Array.from(e.target.files));
    }
    e.target.value = '';
  }, [processBatch]);

  const showHero = !imageInfo && !embedCompact;

  const [colorIndex, setColorIndex] = useState(0);

  useEffect(() => {
    if (!showHero) return;
    const interval = setInterval(() => {
      setColorIndex(prev => (prev + 1) % GRADIENT_COLORS.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [showHero]);

  const currentColor = GRADIENT_COLORS[colorIndex];

  return (
    <div className={showHero ? 'w-full' : 'flex-shrink-0'}>
      <div 
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
        className={`
          text-center cursor-pointer
          ${showHero 
            ? 'rounded-2xl p-10 hover:scale-[1.02] transform transition-transform duration-300' 
            : 'rounded-lg bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 px-5 py-2 shadow-md shadow-cyan-500/20 hover:shadow-cyan-400/30'
          }
        `}
        style={showHero ? {
          background: currentColor.bg,
          boxShadow: `0 0 30px ${currentColor.glow}, 0 8px 24px rgba(0,0,0,0.15)`,
          transition: 'background 1.5s ease-in-out, box-shadow 1.5s ease-in-out',
        } : undefined}
      >
        <div className={`flex items-center ${showHero ? 'flex-col' : 'gap-1.5'}`}>
          {showHero && (
            <>
              <div className="w-20 h-20 rounded-2xl bg-white/30 shadow-inner flex items-center justify-center mb-5 border border-white/40">
                <Upload className="w-10 h-10 text-white drop-shadow-lg" />
              </div>
              <p className="font-bold text-white text-2xl mb-1 drop-shadow-sm tracking-wide">
                {t("upload.makeGangsheet")}
              </p>
              <p className="text-sm text-white/80 mb-4">
                {t("upload.preferredFormat")}&nbsp;:&nbsp; <span className="font-semibold text-white">{t("upload.pngTransparent")}</span>
              </p>
            </>
          )}
          {!showHero && (
            <Upload className="w-4 h-4 text-white" />
          )}
          {!showHero && (
            <p className={`font-semibold text-white whitespace-nowrap ${metric ? 'text-[11px]' : 'text-xs'}`}>
              {t("editor.addDesigns")}
            </p>
          )}
        </div>
        <input 
          type="file" 
          ref={fileInputRef}
          className="hidden" 
          accept=".png,.jpg,.jpeg,.webp,.pdf,.svg,image/png,image/jpeg,image/webp,image/svg+xml,application/pdf"
          multiple
          onChange={handleFileInputChange}
        />
      </div>

      {showHero && (
        <p className="text-center mt-4 text-sm font-medium text-gray-600">
          {t("upload.poweredBy")} <span className="text-cyan-600 font-semibold">ANYNEST APP</span>
        </p>
      )}
    </div>
  );
}
