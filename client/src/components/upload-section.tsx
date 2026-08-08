import { useCallback, useState, useEffect, useRef } from "react";
import { Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/i18n";
import { useMetric } from "@/lib/format-length";
import { runWithConcurrency, resolveUploadConcurrency } from "@/lib/upload-queue";
import {
  describeBudgetRejection,
  importRasterForEditor,
  type PreparedRaster,
} from "@/lib/prepare-raster-upload";
// From the module rather than the `image-editor` barrel: that barrel renders
// the editor view, which imports this file, so a value import would be a cycle.
import { injectPngDpi, readDeclaredDpi } from "./image-editor/utils";
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
  onImageUpload: (
    file: File,
    image: HTMLImageElement | null,
    opts?: { prepared?: PreparedRaster },
  ) => void | Promise<void>;
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

  // Preparing a large source is silent: print quality is unaffected either
  // way, so there is nothing here worth interrupting the customer for. The
  // solid-background warning below is different — it is actionable, and the
  // inline path has always shown it.
  const deliverPrepared = useCallback(async (prepared: PreparedRaster) => {
    // Hand back the original file, not the preview: DPI metadata and the
    // Uploads library both need the source the customer actually picked.
    await onImageUpload(prepared.sourceBlob as File, prepared.previewImage, { prepared });
    if (!prepared.hasTransparency) {
      toast({
        title: t("toast.solidBg"),
        description: t("toast.solidBgDesc"),
        variant: "warning",
      });
    }
  }, [onImageUpload, toast, t]);

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

    try {
      await importRasterForEditor(file, {
        onPrepared: deliverPrepared,
        onInline: async (rasterFile, img) => {
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
          c.width = 0; c.height = 0;

          const isPng = rasterFile.type === 'image/png' || rasterFile.name.toLowerCase().endsWith('.png');
          if (!isPng) {
            // A canvas PNG carries no pHYs chunk, so re-encoding here destroys
            // whatever resolution the original container declared — and every
            // reader downstream (the model's DPI resolve, the uploads library,
            // /api/image-info) only ever sees the converted file. So read the
            // declaration off the original bytes first and stamp it into the
            // PNG, which keeps the file self-describing instead of correct at
            // one call site. A 1024 px JPEG declaring 300 DPI is 3.41" of
            // artwork; without this it lands as 14.22" at 72 DPI.
            const declared = await readDeclaredDpi(rasterFile);

            const cvs = document.createElement('canvas');
            cvs.width = img.width;
            cvs.height = img.height;
            const cctx = cvs.getContext('2d', { willReadFrequently: true });
            if (!cctx) {
              await onImageUpload(rasterFile, img);
              return;
            }
            cctx.drawImage(img, 0, 0);
            const rawBlob = await new Promise<Blob | null>((resolve) => cvs.toBlob(resolve, 'image/png'));
            cvs.width = 0; cvs.height = 0;
            if (!rawBlob) {
              await onImageUpload(rasterFile, img);
              return;
            }
            // Only stamp what the file actually declared. A source that declared
            // nothing must stay undeclared: the model tells "declared 72" from
            // "declared nothing" and defaults them differently, and inventing a
            // number here would erase that distinction permanently.
            const blob = declared.dpi != null
              ? await injectPngDpi(rawBlob, declared.dpi).catch(() => rawBlob)
              : rawBlob;
            const pngFile = new File([blob], rasterFile.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
            const pngImg = await new Promise<HTMLImageElement>((resolve, reject) => {
              const pi = new Image();
              pi.decoding = "async";
              const u = URL.createObjectURL(blob);
              pi.onload = () => { URL.revokeObjectURL(u); resolve(pi); };
              pi.onerror = () => { URL.revokeObjectURL(u); reject(new Error("PNG convert failed")); };
              pi.src = u;
            }).catch(async () => {
              await onImageUpload(rasterFile, img);
              return null;
            });
            if (!pngImg) return;
            await onImageUpload(pngFile, pngImg);
            return;
          }
          await onImageUpload(rasterFile, img);
        },
        onReject: (reason, megapixels) => {
          if (reason === "unreadable_dimensions") {
            toast({ title: t("toast.invalidImage"), description: t("toast.invalidImageDesc"), variant: "destructive" });
            return;
          }
          const { sizeLabel, maxLabel } = describeBudgetRejection(reason, megapixels, file.size);
          toast({
            title: t("toast.imageTooLarge"),
            description: t("toast.imageTooLargeDesc", { size: sizeLabel, max: maxLabel }),
            variant: "destructive",
          });
        },
        onPrepareError: (error) => {
          console.error("[upload] prepare failed:", error);
        },
      });
    } catch (err) {
      console.error("[upload] raster import failed:", err);
      toast({
        title: t("toast.uploadFailed"),
        description: err instanceof Error ? err.message : t("toast.uploadFailedDesc"),
        variant: "destructive",
      });
    }
  }, [onImageUpload, deliverPrepared, toast, t]);

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
