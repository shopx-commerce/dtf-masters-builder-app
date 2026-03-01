import { useCallback, useState, useEffect, useRef } from "react";
import { Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/i18n";
import { useMetric } from "@/lib/format-length";
import type { ImageInfo, ResizeSettings } from "./image-editor";

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const ACCEPTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.pdf'];
const GRADIENT_COLORS = [
  { bg: 'rgb(34, 197, 94)', glow: 'rgba(34, 197, 94, 0.5)' },
  { bg: 'rgb(234, 179, 8)', glow: 'rgba(234, 179, 8, 0.5)' },
  { bg: 'rgb(249, 115, 22)', glow: 'rgba(249, 115, 22, 0.5)' },
  { bg: 'rgb(236, 72, 153)', glow: 'rgba(236, 72, 153, 0.5)' },
];

interface UploadSectionProps {
  onImageUpload: (file: File, image: HTMLImageElement | null) => void;
  onBatchStart?: (fileCount: number) => void;
  imageInfo?: ImageInfo | null;
  resizeSettings?: ResizeSettings | null;
}

export default function UploadSection({ onImageUpload, onBatchStart, imageInfo }: UploadSectionProps) {
  const { toast } = useToast();
  const { t, lang } = useLanguage();
  const metric = useMetric(lang);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileUpload = useCallback(async (file: File) => {
    const ext = file.name.toLowerCase();
    const isPdf = file.type === 'application/pdf' || ext.endsWith('.pdf');
    const isImage = ACCEPTED_TYPES.includes(file.type) || ACCEPTED_EXTENSIONS.some(e => ext.endsWith(e));

    if (!isImage && !isPdf) {
      toast({ title: t("toast.unsupportedFormat"), description: t("toast.unsupportedFormatDesc"), variant: "destructive" });
      return;
    }

    if (isPdf) {
      onImageUpload(file, null as unknown as HTMLImageElement);
      return;
    }

    const img = new Image();
    const originalUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(originalUrl);

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
            variant: "destructive",
          });
        }
      }

      const isPng = file.type === 'image/png' || ext.endsWith('.png');
      if (!isPng) {
        const cvs = document.createElement('canvas');
        cvs.width = img.width;
        cvs.height = img.height;
        const cctx = cvs.getContext('2d');
        if (!cctx) { onImageUpload(file, img); return; }
        cctx.drawImage(img, 0, 0);
        cvs.toBlob((blob) => {
          if (!blob) { onImageUpload(file, img); return; }
          const pngFile = new File([blob], file.name.replace(/\.\w+$/, '.png'), { type: 'image/png' });
          const pngImg = new Image();
          const u = URL.createObjectURL(blob);
          pngImg.onload = () => { URL.revokeObjectURL(u); onImageUpload(pngFile, pngImg); };
          pngImg.onerror = () => { URL.revokeObjectURL(u); onImageUpload(file, img); };
          pngImg.src = u;
        }, 'image/png');
      } else {
        onImageUpload(file, img);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(originalUrl);
      toast({ title: t("toast.failedLoad"), description: t("toast.failedLoadDesc"), variant: "destructive" });
    };
    img.src = originalUrl;
  }, [onImageUpload, toast, t]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 1) onBatchStart?.(files.length);
    for (const file of files) {
      handleFileUpload(file);
    }
  }, [handleFileUpload, onBatchStart]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const files = Array.from(e.target.files);
      if (files.length > 1) onBatchStart?.(files.length);
      for (const file of files) {
        handleFileUpload(file);
      }
    }
    e.target.value = '';
  }, [handleFileUpload, onBatchStart]);

  const isEmptyState = !imageInfo;

  const [colorIndex, setColorIndex] = useState(0);

  useEffect(() => {
    if (!isEmptyState) return;
    const interval = setInterval(() => {
      setColorIndex(prev => (prev + 1) % GRADIENT_COLORS.length);
    }, 2000);
    return () => clearInterval(interval);
  }, [isEmptyState]);

  const currentColor = GRADIENT_COLORS[colorIndex];

  return (
    <div className={isEmptyState ? 'w-full' : 'flex-shrink-0'}>
      <div 
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onClick={() => fileInputRef.current?.click()}
        className={`
          text-center cursor-pointer
          ${isEmptyState 
            ? 'rounded-2xl p-10 hover:scale-[1.02] transform transition-transform duration-300' 
            : 'rounded-md bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 px-5 py-1 shadow-md shadow-cyan-500/20 hover:shadow-cyan-400/30'
          }
        `}
        style={isEmptyState ? {
          background: currentColor.bg,
          boxShadow: `0 0 50px ${currentColor.glow}, 0 0 100px ${currentColor.glow}, 0 8px 32px rgba(0,0,0,0.2)`,
          transition: 'background 1.5s ease-in-out, box-shadow 1.5s ease-in-out',
        } : undefined}
      >
        <div className={`flex items-center ${isEmptyState ? 'flex-col' : 'gap-1.5'}`}>
          {isEmptyState && (
            <>
              <div className="w-20 h-20 rounded-2xl bg-white/30 backdrop-blur-sm shadow-inner flex items-center justify-center mb-5 border border-white/40">
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
          {!isEmptyState && (
            <Upload className="w-3.5 h-3.5 text-white" />
          )}
          {!isEmptyState && (
            <p className={`font-medium text-white whitespace-nowrap ${metric ? 'text-[10px]' : 'text-[11px]'}`}>
              {t("editor.addDesigns")}
            </p>
          )}
        </div>
        <input 
          type="file" 
          ref={fileInputRef}
          className="hidden" 
          accept=".png,.jpg,.jpeg,.webp,.pdf,image/png,image/jpeg,image/webp,application/pdf" 
          multiple
          onChange={handleFileInputChange}
        />
      </div>

      {isEmptyState && (
        <p className="text-center mt-4 text-sm font-medium text-gray-600">
          {t("upload.poweredBy")} <span className="text-cyan-600 font-semibold">ANYNEST APP</span>
        </p>
      )}
    </div>
  );
}
