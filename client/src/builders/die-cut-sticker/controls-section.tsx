import { useState, useEffect, useRef, useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  StrokeSettings,
  ResizeSettings,
  ImageInfo,
  ShapeSettings,
  StickerSize,
  CutlineVisibility,
} from "./image-editor";
import type { DetectedAlgorithm } from "@/lib/contour-worker-manager";
import { useToast } from "@/hooks/use-toast";
import { generateContourPDFBase64 } from "@/lib/contour-outline";
import { generateShapePDFBase64 } from "@/lib/shape-outline";
import { getContourWorkerManager } from "@/lib/contour-worker-manager";
import type { ShopStickerSettings, SizePreset } from "@/lib/shop-sticker-settings";
import {
  computeShopDisplayTotal,
  clampDimension,
} from "@/lib/shop-sticker-settings";
import {
  runDieCutCheckout,
  type DieCutShopifyVariant,
} from "./die-cut-checkout";
import {
  ChevronLeft,
  ChevronRight,
  Upload,
  Ruler,
  Shapes,
  Check,
  Sparkles,
  ShoppingCart,
  ExternalLink,
  RotateCcw,
  Star,
  Shield,
  Link2,
  Truck,
  Zap,
  Clock,
  Package,
  Download,
} from "lucide-react";

interface EmbedStickerOptions {
  size: string;
  quantity: number;
}

interface ControlsSectionProps {
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  stickerSize: StickerSize;
  quantity: number;
  onQuantityChange: (qty: number) => void;
  onStrokeChange: (settings: Partial<StrokeSettings>) => void;
  onResizeChange: (settings: Partial<ResizeSettings>) => void;
  onShapeChange: (settings: Partial<ShapeSettings>) => void;
  onStickerSizeChange: (size: StickerSize, customDimensions?: { widthInches: number; heightInches: number }) => void;
  onDownload: (
    downloadType?:
      | "standard"
      | "highres"
      | "vector"
      | "cutcontour"
      | "design-only"
      | "download-package",
    format?: "png" | "pdf" | "eps" | "svg",
  ) => void;
  isProcessing: boolean;
  imageInfo: ImageInfo | null;
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  currentStep?: number;
  onStepChange?: (step: number) => void;
  onRemoveBackground?: (threshold: number) => void;
  isRemovingBackground?: boolean;
  cutlineVisibility?: CutlineVisibility;
  onCutlineVisibilityChange?: (v: CutlineVisibility) => void;
  hasOriginalImage?: boolean;
  showOriginalImage?: boolean;
  onToggleOriginalImage?: () => void;
  onClearImage?: () => void;
  isEmbedMode?: boolean;
  embedStickerOptions?: EmbedStickerOptions | null;
  embedControlStep?: "style" | "options";
  onEmbedControlStepChange?: (step: "style" | "options") => void;
  embedParentOrigin?: string;
  embedReturnUrl?: string;
  customerId?: string;
  customerEmail?: string;
  productHandle?: string;
  variantId?: string;
  variants?: DieCutShopifyVariant[];
  shopDomain?: string;
  fullWidth?: boolean;
  detectedAlgorithm?: DetectedAlgorithm;
  shopStickerSettings?: ShopStickerSettings | null;
}

type WizardStep = 1 | 2 | 3;

const STEPS = [
  { number: 1, label: "Upload", icon: Upload },
  { number: 2, label: "Size & Qty", icon: Ruler },
  { number: 3, label: "Design", icon: Shapes },
];

const CelebrationAnimation = () => {
  const [show, setShow] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShow(false), 2000);
    return () => clearTimeout(timer);
  }, []);
  if (!show) return null;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {[...Array(12)].map((_, i) => (
        <div
          key={i}
          className="absolute animate-bounce"
          style={{
            left: `${10 + i * 8}%`,
            top: `${Math.random() * 30}%`,
            animationDelay: `${i * 0.1}s`,
            animationDuration: `${0.5 + Math.random() * 0.5}s`,
          }}
        >
          <Sparkles className={`w-4 h-4 ${i % 3 === 0 ? "text-yellow-400" : i % 3 === 1 ? "text-white" : "text-blue-400"}`} />
        </div>
      ))}
    </div>
  );
};

function computeDieCutDisplayTotal(
  settings: ShopStickerSettings | null,
  args: {
    widthInches: number;
    heightInches: number;
    quantity: number;
    finish: string;
    lamination: string;
    variants?: DieCutShopifyVariant[];
  },
): number {
  // Matches the original Sticker Outline app: the builder price is ALWAYS the
  // size × qty formula (with any extraFeeFlat sync from the product page).
  // Variant matching (matchDieCutVariant) only decides which Shopify cart
  // variant is used at checkout — it never overrides the displayed price.
  return computeShopDisplayTotal(settings, {
    widthIn: args.widthInches,
    heightIn: args.heightInches,
    qty: args.quantity,
    finish: args.finish,
    lamination: args.lamination,
  });
}

const PricingDisplay = ({
  widthInches,
  heightInches,
  quantity,
  shopStickerSettings,
  finish,
  lamination,
  variants,
}: {
  widthInches: number;
  heightInches: number;
  quantity: number;
  shopStickerSettings: ShopStickerSettings | null;
  finish: string;
  lamination: string;
  variants?: DieCutShopifyVariant[];
}) => {
  const total = computeDieCutDisplayTotal(shopStickerSettings, {
    widthInches,
    heightInches,
    quantity,
    finish,
    lamination,
    variants,
  });
  if (total <= 0) return null;

  return (
    <div className="rounded-xl p-5 text-center" style={{ background: "linear-gradient(135deg, rgba(37, 99, 235, 0.12) 0%, rgba(37, 99, 235, 0.04) 100%)", border: "1px solid rgba(37, 99, 235, 0.2)" }}>
      <p className="font-extrabold font-heading tracking-tight leading-none" style={{ color: "#111827", fontSize: "2.75rem" }}>
        ${total.toFixed(2)}
      </p>
      <p className="text-sm font-semibold mt-2.5" style={{ color: "#6B7280" }}>
        {quantity} Stickers ({widthInches}" × {heightInches}")
      </p>
      <p className="text-xs mt-1.5" style={{ color: "#9CA3AF" }}>
        ${(total / Math.max(1, quantity)).toFixed(2)} per sticker
      </p>

      <p className="text-xs font-semibold mt-4" style={{ color: "#22C55E" }}>
        <Clock className="w-3 h-3 inline mr-1" style={{ color: "#22C55E" }} />
        Order today for next-day production.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 mt-3 text-[11px] font-bold" style={{ color: "#6B7280" }}>
        <span className="flex items-center gap-1">
          <Zap className="w-3 h-3" style={{ color: "#2563EB" }} />
          24–48hr Production
        </span>
        <span className="flex items-center gap-1">
          <Truck className="w-3 h-3" style={{ color: "#2563EB" }} />
          Local Pickup
        </span>
      </div>
    </div>
  );
};

const FILL_COLORS = ["#ffffff", "#000000", "#ff0000", "#0000ff", "#ffff00", "#00ff00"];

const ColorPicker = ({ value, onChange, accentColor = "#2563EB" }: { value: string; onChange: (c: string) => void; accentColor?: string }) => (
  <div className="flex flex-wrap gap-1.5 items-center">
    {FILL_COLORS.map((color) => (
      <button
        key={color}
        onClick={() => onChange(color)}
        className="w-7 h-7 rounded-md transition-all flex-shrink-0"
        style={{
          backgroundColor: color,
          border: value === color ? `2px solid ${accentColor}` : "1px solid #CBD5E1",
          boxShadow: value === color ? `0 0 8px ${accentColor}55` : "none",
          transform: value === color ? "scale(1.15)" : "scale(1)",
        }}
      />
    ))}
    <div className="relative">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-7 h-7 rounded-md cursor-pointer opacity-0 absolute inset-0"
      />
      <div className="w-7 h-7 rounded-md bg-gradient-to-br from-red-400 via-green-400 to-blue-400 flex items-center justify-center" style={{ border: "1px solid #CBD5E1" }}>
        <span className="text-white text-[9px] font-bold drop-shadow">+</span>
      </div>
    </div>
  </div>
);

export default function ControlsSection({
  strokeSettings,
  resizeSettings,
  shapeSettings,
  stickerSize,
  quantity,
  onQuantityChange: setQuantity,
  onStrokeChange,
  onResizeChange,
  onShapeChange,
  onStickerSizeChange,
  onDownload,
  isProcessing,
  imageInfo,
  canvasRef,
  currentStep: currentStepProp,
  onStepChange,
  onRemoveBackground,
  isRemovingBackground,
  cutlineVisibility = 'normal',
  onCutlineVisibilityChange,
  hasOriginalImage,
  showOriginalImage,
  onToggleOriginalImage,
  onClearImage,
  isEmbedMode = false,
  embedStickerOptions = null,
  embedControlStep = "style",
  onEmbedControlStepChange,
  embedParentOrigin,
  embedReturnUrl,
  customerId,
  customerEmail,
  productHandle,
  variantId,
  variants,
  shopDomain,
  fullWidth = false,
  detectedAlgorithm,
  shopStickerSettings = null,
}: ControlsSectionProps) {
  const { toast } = useToast();
  const [finish, setFinish] = useState(
    () => shopStickerSettings?.defaults?.finish ?? "glossy",
  );
  const [lamination, setLamination] = useState(
    () => shopStickerSettings?.defaults?.lamination ?? "none",
  );
  const shopDefaultsSyncedRef = useRef(false);
  useEffect(() => {
    if (!shopStickerSettings) return;
    if (shopDefaultsSyncedRef.current) return;
    shopDefaultsSyncedRef.current = true;
    setFinish(shopStickerSettings.defaults?.finish ?? "glossy");
    setLamination(shopStickerSettings.defaults?.lamination ?? "none");
  }, [shopStickerSettings]);

  const sizePresets = useMemo(() => {
    const ps = shopStickerSettings?.sizes?.presets;
    if (Array.isArray(ps) && ps.length > 0) return ps;
    return [2, 3, 4, 5, 6].map((n) => ({
      label: `${n}"`,
      width: n,
      height: n,
    }));
  }, [shopStickerSettings]);

  const qtyGrid = useMemo(() => {
    const o = shopStickerSettings?.pricing?.quantityOptions;
    if (Array.isArray(o) && o.length) {
      return Array.from(
        new Set(
          o
            .map((x) => Math.round(Number(x)))
            .filter((x) => !Number.isNaN(x) && x >= 1),
        ),
      )
        .sort((a, b) => a - b)
        .slice(0, 5);
    }
    return [25, 50, 100, 250, 500];
  }, [shopStickerSettings]);

  const maxQtyLimit = useMemo(() => {
    const o = shopStickerSettings?.pricing?.quantityOptions;
    if (Array.isArray(o) && o.length)
      return Math.max(
        ...o
          .map((x) => Math.round(Number(x)))
          .filter((x) => !Number.isNaN(x) && x >= 1),
      );
    return 1000;
  }, [shopStickerSettings]);

  const minQtyLimit = useMemo(() => {
    const o = shopStickerSettings?.pricing?.quantityOptions;
    if (Array.isArray(o) && o.length)
      return Math.min(
        ...o
          .map((x) => Math.round(Number(x)))
          .filter((x) => !Number.isNaN(x) && x >= 1),
      );
    return 25;
  }, [shopStickerSettings]);

  const minW = shopStickerSettings?.sizes?.minWidth ?? 0.5;
  const maxW = shopStickerSettings?.sizes?.maxWidth ?? 20;
  const minH = shopStickerSettings?.sizes?.minHeight ?? 0.5;
  const maxH = shopStickerSettings?.sizes?.maxHeight ?? 20;
  const customSizeAllowed =
    shopStickerSettings?.sizes?.enableCustomSize !== false;

  const currentStep = (currentStepProp || 1) as WizardStep;
  const [showCelebration, setShowCelebration] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [designSent, setDesignSent] = useState(false);
  const [referenceCode, setReferenceCode] = useState<string>("");
  const [designUrl, setDesignUrl] = useState<string>("");
  const stickyRef = useRef<HTMLDivElement>(null);
  const [showSticky, setShowSticky] = useState(false);

  const setCurrentStep = (step: WizardStep) => {
    onStepChange?.(step);
  };

  const canProceedToStep2 = !!imageInfo;
  const canProceedToStep3 = canProceedToStep2;
  const prevImageRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (embedStickerOptions?.size) {
      const sizeNum = parseFloat(embedStickerOptions.size);
      if (!Number.isNaN(sizeNum) && sizeNum > 0) {
        onStickerSizeChange(sizeNum as StickerSize);
      }
    }
  }, [embedStickerOptions?.size, onStickerSizeChange]);

  useEffect(() => {
    if (imageInfo) {
      if (prevImageRef.current !== imageInfo.image) {
        prevImageRef.current = imageInfo.image;
        if (isEmbedMode && embedStickerOptions?.size) {
          setCurrentStep(3);
        } else if (currentStep === 1) {
          setCurrentStep(2);
        }
      }
    }
  }, [imageInfo, isEmbedMode, embedStickerOptions?.size]);

  // Sticky order summary scroll detection
  useEffect(() => {
    if (isEmbedMode || currentStep < 3) return;
    const onScroll = () => {
      if (stickyRef.current) {
        const rect = stickyRef.current.getBoundingClientRect();
        setShowSticky(rect.bottom < 0);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isEmbedMode, currentStep]);

  const handleCutStyleSelect = (style: "contour" | "shape" | "none") => {
    if (style === "contour") {
      onStrokeChange({ enabled: true });
      onShapeChange({ enabled: false });
    } else if (style === "shape") {
      onShapeChange({ enabled: true });
      onStrokeChange({ enabled: false });
    } else {
      onStrokeChange({ enabled: false });
      onShapeChange({ enabled: false });
    }
  };

  const goToStep = (step: WizardStep) => {
    if (step === 2 && !canProceedToStep2) return;
    if (step === 3 && !canProceedToStep3) return;
    setCurrentStep(step);
  };

  const nextStep = () => {
    if (currentStep < 3) goToStep((currentStep + 1) as WizardStep);
  };

  const prevStep = () => {
    if (currentStep > 1) setCurrentStep((currentStep - 1) as WizardStep);
  };

  const readFileAsDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read image file"));
      reader.readAsDataURL(file);
    });

  const handleProceedToCheckout = async () => {
    setIsSending(true);
    try {
      let pdfBase64 = "";

      if (imageInfo?.image) {
        if (strokeSettings.enabled) {
          const workerManager = getContourWorkerManager();
          const cachedData = workerManager.getCachedContourData();
          const result = await generateContourPDFBase64(imageInfo.image, strokeSettings, resizeSettings, cachedData || undefined);
          pdfBase64 = result || "";
        } else if (shapeSettings.enabled) {
          const result = await generateShapePDFBase64(imageInfo.image, shapeSettings, resizeSettings);
          pdfBase64 = result || "";
        }
      }

      if (!pdfBase64) throw new Error("Failed to generate PDF. Please try again.");

      const previewDataUrl = canvasRef?.current?.toDataURL?.("image/png") || null;
      const total = computeDieCutDisplayTotal(shopStickerSettings, {
        widthInches: resizeSettings.widthInches,
        heightInches: resizeSettings.heightInches,
        quantity,
        finish,
        lamination,
        variants,
      });

      const result = await runDieCutCheckout({
        pdfBase64,
        previewDataUrl,
        stickerSizeLabel: `${resizeSettings.widthInches}" × ${resizeSettings.heightInches}"`,
        widthInches: resizeSettings.widthInches,
        heightInches: resizeSettings.heightInches,
        quantity,
        outlineType: strokeSettings.enabled ? "contour" : shapeSettings.enabled ? "shape" : "none",
        finish,
        lamination,
        displayTotal: total,
        variantId,
        variants,
        shopDomain,
        productHandle,
        imageName: imageInfo?.file?.name || undefined,
        customerId,
        customerEmail,
        onProgress: (msg) => {
          /* progress surfaces via button spinner text */
          console.log("[die-cut checkout]", msg);
        },
      });

      setReferenceCode(result.referenceCode);
      setDesignUrl(result.designUrl || result.productionUrl || "");

      toast({
        title: result.usedShellAtc ? "Added to Cart!" : "Design Ready!",
        description: result.usedShellAtc
          ? "Your stickers were added to the cart. You can keep shopping."
          : "Your design is saved with a reference code. Open from the storefront product page to Add to Cart.",
      });
      setDesignSent(true);
      setShowCelebration(true);
      setTimeout(() => setShowCelebration(false), 2500);
    } catch (error) {
      console.error("Error saving design:", error);
      toast({ title: "Error Saving Design", description: error instanceof Error ? error.message : "Please try again later.", variant: "destructive" });
    } finally {
      setIsSending(false);
    }
  };

  const buildCartUrl = () => {
    if (typeof window === "undefined") return "/cart";
    try {
      if (window.top && window.top !== window) {
        return `${window.top.location.origin}/cart`;
      }
    } catch {
      /* cross-origin */
    }
    return embedReturnUrl?.trim() || "/cart";
  };

  const displayTotal = computeDieCutDisplayTotal(shopStickerSettings, {
    widthInches: resizeSettings.widthInches,
    heightInches: resizeSettings.heightInches,
    quantity,
    finish,
    lamination,
    variants,
  });

  // === CTA + Social Proof Block (reused in step 3 and sticky) ===
  const CTABlock = ({ compact = false }: { compact?: boolean }) => (
    <div className="relative">
      {showCelebration && <CelebrationAnimation />}
      {!designSent ? (
        <>
          <button
            onClick={handleProceedToCheckout}
            disabled={isSending}
            className="w-full py-4 rounded-xl font-extrabold text-lg flex items-center justify-center gap-2 disabled:opacity-50 transition-all duration-300"
            style={{
              background: "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)",
              color: "#FFFFFF",
              boxShadow: "0 4px 25px rgba(37, 99, 235, 0.4), 0 0 40px rgba(37, 99, 235, 0.15)",
              fontSize: compact ? "15px" : "18px",
              padding: compact ? "12px 16px" : "18px 20px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 6px 35px rgba(37, 99, 235, 0.6), 0 0 60px rgba(37, 99, 235, 0.25)";
              e.currentTarget.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 4px 25px rgba(37, 99, 235, 0.4), 0 0 40px rgba(37, 99, 235, 0.15)";
              e.currentTarget.style.transform = "translateY(0)";
            }}
          >
            {isSending ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Preparing Your Stickers...
              </>
            ) : (
              <>
                <ShoppingCart className="w-5 h-5" />
                Add to Cart – ${displayTotal.toFixed(2)}
              </>
            )}
          </button>

          {!compact && (
            <div className="mt-3 space-y-1.5 text-center">
              <div className="flex items-center justify-center gap-1 text-sm font-bold" style={{ color: "#FBBF24" }}>
                <Star className="w-4 h-4 fill-current" />
                <Star className="w-4 h-4 fill-current" />
                <Star className="w-4 h-4 fill-current" />
                <Star className="w-4 h-4 fill-current" />
                <Star className="w-3.5 h-3.5 fill-current opacity-80" />
                <span className="ml-1">4.9/5 from 800+ Customers</span>
              </div>
              <p className="text-xs italic" style={{ color: "#6B7280" }}>
                "Super fast and amazing quality!" – Maria R.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="rounded-xl p-4" style={{ backgroundColor: "rgba(37, 99, 235, 0.1)", border: "1px solid rgba(37, 99, 235, 0.3)" }}>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center" style={{ backgroundColor: "#2563EB" }}>
              <Check className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <h4 className="font-bold text-lg mb-1" style={{ color: "#2563EB" }}>Added to Cart!</h4>
              <p className="text-sm mb-3" style={{ color: "#6B7280" }}>
                Your die-cut design is saved to Cloudflare R2. Continue shopping or open your cart.
              </p>
              <a
                href={buildCartUrl()}
                target={isEmbedMode ? "_parent" : "_self"}
                rel="noopener noreferrer"
                className="block w-full py-4 rounded-xl text-lg font-bold text-center text-white transition-all"
                style={{ background: "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)", boxShadow: "0 4px 25px rgba(37, 99, 235, 0.4)" }}
              >
                View Cart
                <ExternalLink className="w-5 h-5 ml-2 inline" />
              </a>
              {referenceCode && (
                <p className="text-xs text-center mt-3" style={{ color: "#9CA3AF" }}>
                  Reference: <span className="font-mono font-bold">{referenceCode}</span>
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // === Step Indicator ===
  const StepIndicator = () => (
    <div className="mb-6">
      <div className="flex items-center justify-between gap-1 relative">
        <div className="absolute top-5 left-[16.6%] right-[16.6%] h-[2px]" style={{ backgroundColor: "rgba(37, 99, 235, 0.15)" }}>
          <div
            className="h-full transition-all duration-500 rounded-full"
            style={{
              background: "linear-gradient(90deg, #2563EB, #3B82F6)",
              width: currentStep === 1 ? "0%" : currentStep === 2 ? "50%" : "100%",
            }}
          />
        </div>
        {STEPS.map((step) => {
          const isActive = currentStep === step.number;
          const isCompleted = currentStep > step.number;
          const canGoForward = (step.number === 2 && canProceedToStep2) || (step.number === 3 && canProceedToStep3);
          const isClickable = isCompleted || step.number === currentStep || canGoForward;
          return (
            <button
              key={step.number}
              type="button"
              onClick={() => {
                if (step.number < currentStep) goToStep(step.number as WizardStep);
                else if (canGoForward) goToStep(step.number as WizardStep);
              }}
              disabled={!isClickable}
              className={`flex-1 flex flex-col items-center gap-1 py-1 rounded-lg transition-all relative z-10 ${isClickable ? "hover:bg-gray-100 cursor-pointer" : "opacity-25 cursor-not-allowed"}`}
            >
              <span
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold transition-all"
                style={{
                  background: isActive ? "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)" : isCompleted ? "#2563EB" : "#E2E8F0",
                  border: isActive ? "2px solid #60A5FA" : isCompleted ? "2px solid #2563EB" : "2px solid #CBD5E1",
                  color: isActive || isCompleted ? "#FFFFFF" : "#9CA3AF",
                  boxShadow: isActive ? "0 0 20px rgba(37, 99, 235, 0.5)" : "none",
                }}
              >
                {isCompleted ? <Check className="w-4 h-4" /> : step.number}
              </span>
              <span className="text-[11px] font-bold tracking-wide" style={{ color: isActive ? "#2563EB" : isCompleted ? "#2563EB" : "#9CA3AF" }}>
                {step.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );

  // === Step 1: Upload ===
  const renderStep1 = () => (
    <div className="rounded-xl p-6" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
      {imageInfo ? (
        <div className="text-center space-y-4">
          <div className="rounded-lg p-4" style={{ backgroundColor: "rgba(37, 99, 235, 0.08)", border: "1px solid rgba(37, 99, 235, 0.2)" }}>
            <Check className="w-8 h-8 mx-auto mb-2" style={{ color: "#2563EB" }} />
            <p className="font-bold text-base" style={{ color: "#2563EB" }}>Image uploaded</p>
            <p className="text-sm mt-1" style={{ color: "#9CA3AF" }}>{imageInfo.file.name}</p>
          </div>
          {onClearImage && (
            <Button onClick={onClearImage} variant="outline" size="sm" className="w-full border-gray-300 text-gray-500 hover:bg-gray-100 hover:text-gray-700">
              <RotateCcw className="w-3 h-3 mr-2" /> Upload Different Image
            </Button>
          )}
        </div>
      ) : (
        <div className="text-center">
          <Upload className="w-10 h-10 mx-auto mb-3" style={{ color: "#2563EB" }} />
          <h3 className="text-lg font-bold mb-2 font-heading tracking-wide" style={{ color: "#111827" }}>Step 1</h3>
          <p className="text-sm" style={{ color: "#9CA3AF" }}>Upload your artwork to get started.</p>
        </div>
      )}
    </div>
  );

  // === Step 2: Size & Qty ===
  const [customSizeMode, setCustomSizeMode] = useState(false);
  const [customWidth, setCustomWidth] = useState(resizeSettings.widthInches.toString());
  const [customHeight, setCustomHeight] = useState(resizeSettings.heightInches.toString());

  const presetMatches = (p: SizePreset) =>
    Math.abs(resizeSettings.widthInches - p.width) < 0.04 &&
    Math.abs(resizeSettings.heightInches - p.height) < 0.04;
  const isPresetSizeSelected = sizePresets.some((p) => presetMatches(p));
  const isCustomSize = customSizeMode || !isPresetSizeSelected;

  const imageAspectRatio = imageInfo ? imageInfo.image.width / imageInfo.image.height : 1;

  const handleCustomWidthChange = (val: string) => {
    setCustomWidth(val);
    const w = parseFloat(val);
    if (!Number.isNaN(w)) {
      const wc = clampDimension(w, minW, maxW);
      const hRaw = wc / imageAspectRatio;
      const hc = clampDimension(parseFloat(hRaw.toFixed(2)), minH, maxH);
      setCustomHeight(hc.toString());
    }
  };

  const handleCustomHeightChange = (val: string) => {
    setCustomHeight(val);
    const h = parseFloat(val);
    if (!Number.isNaN(h)) {
      const hc = clampDimension(h, minH, maxH);
      const wRaw = hc * imageAspectRatio;
      const wc = clampDimension(parseFloat(wRaw.toFixed(2)), minW, maxW);
      setCustomWidth(wc.toString());
    }
  };

  const handleCustomSizeApply = () => {
    const w = parseFloat(customWidth);
    const h = parseFloat(customHeight);
    if (!Number.isNaN(w) && !Number.isNaN(h)) {
      const wc = clampDimension(w, minW, maxW);
      const hc = clampDimension(h, minH, maxH);
      if (!customSizeAllowed && shopStickerSettings?.sizes?.presets?.length) {
        const ok = shopStickerSettings.sizes.presets.some(
          (p) =>
            Math.abs(p.width - wc) < 0.02 && Math.abs(p.height - hc) < 0.02,
        );
        if (!ok) {
          toast({
            title: "Size not allowed",
            description: "Choose one of the preset sizes for this store.",
            variant: "destructive",
          });
          return;
        }
      }
      const maxDim = Math.max(wc, hc);
      onStickerSizeChange(maxDim as StickerSize, {
        widthInches: parseFloat(wc.toFixed(2)),
        heightInches: parseFloat(hc.toFixed(2)),
      });
    }
  };

  const applyShopPresetSize = (p: SizePreset) => {
    setCustomSizeMode(false);
    const maxD = Math.max(p.width, p.height);
    onStickerSizeChange(maxD as StickerSize, {
      widthInches: p.width,
      heightInches: p.height,
    });
  };

  const sizeButtons = (
    <div>
      <div className="grid grid-cols-6 gap-2">
        {sizePresets.map((p) => {
          const selected = !customSizeMode && presetMatches(p);
          const label = p.label || `${p.width}×${p.height}`;
          return (
            <button
              key={`${p.width}x${p.height}`}
              type="button"
              onClick={() => applyShopPresetSize(p)}
              className="relative rounded-2xl py-3.5 text-center transition-all font-bold text-sm"
              style={{
                background: selected ? "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)" : "#E2E8F0",
                border: selected ? "2px solid #60A5FA" : "1px solid #D1D5DB",
                color: selected ? "#FFFFFF" : "#6B7280",
                boxShadow: selected ? "0 0 18px rgba(37, 99, 235, 0.35)" : "none",
              }}
            >
              {p.width === 3 && p.height === 3 && !selected && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 text-[7px] font-extrabold px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{ backgroundColor: "#2563EB", color: "#FFFFFF" }}>
                  Popular
                </span>
              )}
              {label}
            </button>
          );
        })}
        {customSizeAllowed && (
        <button
          type="button"
          onClick={() => {
            setCustomSizeMode(true);
            const ar = imageInfo ? imageInfo.image.width / imageInfo.image.height : 1;
            const w = clampDimension(resizeSettings.widthInches, minW, maxW);
            const h = clampDimension(parseFloat((w / ar).toFixed(1)), minH, maxH);
            setCustomWidth(w.toFixed(1));
            setCustomHeight(h.toString());
          }}
          className="rounded-2xl py-3.5 text-center transition-all font-bold text-sm"
          style={{
            background: customSizeMode || isCustomSize ? "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)" : "#E2E8F0",
            border: customSizeMode || isCustomSize ? "2px solid #60A5FA" : "1px solid #D1D5DB",
            color: customSizeMode || isCustomSize ? "#FFFFFF" : "#6B7280",
            boxShadow: customSizeMode || isCustomSize ? "0 0 18px rgba(37, 99, 235, 0.35)" : "none",
          }}
        >
          Custom
        </button>
        )}
      </div>
      {customSizeMode && customSizeAllowed && (
        <div className="mt-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-xs font-semibold mb-1 block" style={{ color: "#6B7280" }}>Width (in)</label>
              <input
                type="number"
                min={minW}
                max={maxW}
                step="0.1"
                value={customWidth}
                onChange={(e) => handleCustomWidthChange(e.target.value)}
                onBlur={handleCustomSizeApply}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCustomSizeApply(); }}
                className="w-full rounded-lg px-3 py-2 text-sm font-semibold"
                style={{ backgroundColor: "#F8FAFC", border: "1px solid #CBD5E1", color: "#111827" }}
              />
            </div>
            <div className="flex flex-col items-center pb-2">
              <Link2 className="w-4 h-4" style={{ color: "#3B82F6" }} />
            </div>
            <div className="flex-1">
              <label className="text-xs font-semibold mb-1 block" style={{ color: "#6B7280" }}>Height (in)</label>
              <input
                type="number"
                min={minH}
                max={maxH}
                step="0.1"
                value={customHeight}
                onChange={(e) => handleCustomHeightChange(e.target.value)}
                onBlur={handleCustomSizeApply}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCustomSizeApply(); }}
                className="w-full rounded-lg px-3 py-2 text-sm font-semibold"
                style={{ backgroundColor: "#F8FAFC", border: "1px solid #CBD5E1", color: "#111827" }}
              />
            </div>
            <button
              type="button"
              onClick={handleCustomSizeApply}
              className="rounded-lg px-4 py-2 text-sm font-bold transition-all"
              style={{ background: "linear-gradient(135deg, #3B82F6, #1D4ED8)", color: "#FFFFFF" }}
            >
              Apply
            </button>
          </div>
          <p className="text-xs mt-1.5 flex items-center gap-1" style={{ color: "#9CA3AF" }}>
            <Link2 className="w-3 h-3" /> Proportions locked to keep your design undistorted
          </p>
        </div>
      )}
    </div>
  );

  const isCustomQty = !qtyGrid.includes(quantity);
  const [customQtyMode, setCustomQtyMode] = useState(false);
  const [customQtyInput, setCustomQtyInput] = useState(quantity.toString());

  const handleCustomQtyApply = () => {
    const q = parseInt(customQtyInput, 10);
    if (!Number.isNaN(q) && q >= minQtyLimit) {
      setQuantity(Math.min(maxQtyLimit, q));
    } else if (!Number.isNaN(q) && q >= 1 && q < minQtyLimit) {
      setCustomQtyInput(String(minQtyLimit));
      setQuantity(minQtyLimit);
    }
  };

  const handlePresetQtyClick = (q: number) => {
    setCustomQtyMode(false);
    setQuantity(q);
  };

  const quantityButtons = (
    <>
      <div className="grid grid-cols-6 gap-2">
        {qtyGrid.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => handlePresetQtyClick(q)}
            className="rounded-2xl py-2.5 text-center transition-all font-bold text-sm"
            style={{
              background: !customQtyMode && quantity === q ? "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)" : "#E2E8F0",
              border: !customQtyMode && quantity === q ? "2px solid #60A5FA" : "1px solid #D1D5DB",
              color: !customQtyMode && quantity === q ? "#FFFFFF" : "#6B7280",
              boxShadow: !customQtyMode && quantity === q ? "0 0 12px rgba(37, 99, 235, 0.3)" : "none",
            }}
          >
            {q}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            setCustomQtyMode(true);
            setCustomQtyInput(quantity.toString());
          }}
          className="rounded-2xl py-2.5 text-center transition-all font-bold text-sm"
          style={{
            background: customQtyMode || isCustomQty ? "linear-gradient(135deg, #3B82F6 0%, #1D4ED8 100%)" : "#E2E8F0",
            border: customQtyMode || isCustomQty ? "2px solid #60A5FA" : "1px solid #D1D5DB",
            color: customQtyMode || isCustomQty ? "#FFFFFF" : "#6B7280",
            boxShadow: customQtyMode || isCustomQty ? "0 0 12px rgba(37, 99, 235, 0.3)" : "none",
          }}
        >
          Custom
        </button>
      </div>
      {customQtyMode && (
        <div className="mt-3 flex items-end gap-2">
          <div className="flex-1">
            <label className="text-xs font-semibold mb-1 block" style={{ color: "#6B7280" }}>Quantity</label>
            <input
              type="number"
              min={minQtyLimit}
              max={maxQtyLimit}
              step="1"
              value={customQtyInput}
              onChange={(e) => setCustomQtyInput(e.target.value)}
              onBlur={handleCustomQtyApply}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCustomQtyApply(); }}
              className="w-full rounded-lg px-3 py-2 text-sm font-semibold"
              style={{ backgroundColor: "#F8FAFC", border: "1px solid #CBD5E1", color: "#111827" }}
            />
          </div>
          <button
            type="button"
            onClick={handleCustomQtyApply}
            className="rounded-lg px-4 py-2 text-sm font-bold transition-all"
            style={{ background: "linear-gradient(135deg, #3B82F6, #1D4ED8)", color: "#FFFFFF" }}
          >
            Apply
          </button>
        </div>
      )}
    </>
  );

  const finishLamBlock =
    shopStickerSettings &&
    (shopStickerSettings.finish || shopStickerSettings.lamination) ? (
      <div
        className="rounded-xl p-4 space-y-4"
        style={{ backgroundColor: "#FFFFFF", border: "1px solid #E2E8F0" }}
      >
        <div>
          <p
            className="text-xs font-bold mb-2"
            style={{ color: "#374151" }}
          >
            Finish
          </p>
          <div className="flex flex-wrap gap-2">
            {(["glossy", "matte"] as const).map((key) => {
              const cfg = shopStickerSettings.finish?.[key];
              if (!cfg?.enabled) return null;
              const active = finish === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFinish(key)}
                  className="rounded-lg px-3 py-2 text-xs font-bold capitalize transition-all"
                  style={{
                    background: active
                      ? "linear-gradient(135deg, #2563EB, #1D4ED8)"
                      : "#F1F5F9",
                    color: active ? "#FFFFFF" : "#64748B",
                    border: active ? "1px solid #60A5FA" : "1px solid #CBD5E1",
                  }}
                >
                  {key}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <p
            className="text-xs font-bold mb-2"
            style={{ color: "#374151" }}
          >
            Lamination
          </p>
          <div className="flex flex-wrap gap-2">
            {(["none", "gloss", "matte"] as const).map((key) => {
              const cfg = shopStickerSettings.lamination?.[key];
              if (!cfg?.enabled) return null;
              const active = lamination === key;
              const label =
                key === "none" ? "None" : key === "gloss" ? "Gloss" : "Matte";
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setLamination(key)}
                  className="rounded-lg px-3 py-2 text-xs font-bold transition-all"
                  style={{
                    background: active
                      ? "linear-gradient(135deg, #2563EB, #1D4ED8)"
                      : "#F1F5F9",
                    color: active ? "#FFFFFF" : "#64748B",
                    border: active ? "1px solid #60A5FA" : "1px solid #CBD5E1",
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    ) : null;

  const continueButton = (
    <button
      onClick={() => { if (customSizeMode) handleCustomSizeApply(); if (customQtyMode) handleCustomQtyApply(); setCurrentStep(3); }}
      className="w-full py-5 rounded-xl text-base font-bold flex items-center justify-center gap-2 transition-all cursor-pointer"
      style={{
        background: "linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)",
        color: "#FFFFFF",
        boxShadow: "0 0 20px rgba(37, 99, 235, 0.35), 0 4px 15px rgba(0,0,0,0.2)",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.transform = "scale(1.02)"; e.currentTarget.style.boxShadow = "0 0 30px rgba(37, 99, 235, 0.5), 0 6px 20px rgba(0,0,0,0.25)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.transform = "scale(1)"; e.currentTarget.style.boxShadow = "0 0 20px rgba(37, 99, 235, 0.35), 0 4px 15px rgba(0,0,0,0.2)"; }}
    >
      Continue to Design <ChevronRight className="w-4 h-4" />
    </button>
  );

  const backButton = (
    <button
      onClick={prevStep}
      className="w-full py-2.5 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-colors hover:bg-gray-100"
      style={{ border: "1px solid #CBD5E1", color: "#6B7280" }}
    >
      <ChevronLeft className="w-4 h-4" /> Back
    </button>
  );

  const renderStep2 = () => {
    if (fullWidth) {
      return (
        <div className="rounded-xl p-6" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex flex-col gap-4">
              {imageInfo && (
                <div className="flex items-center gap-3 rounded-lg p-3" style={{ backgroundColor: "rgba(37, 99, 235, 0.05)", border: "1px solid rgba(37, 99, 235, 0.1)", boxShadow: "0 2px 12px rgba(0,0,0,0.15)" }}>
                  <div className="relative flex-shrink-0">
                    <div className="w-20 h-20 rounded-lg overflow-hidden border-2" style={{ borderColor: "rgba(37, 99, 235, 0.5)", boxShadow: "0 4px 15px rgba(0,0,0,0.2)" }}>
                      <img src={imageInfo.image.src} alt="Uploaded design" className="w-full h-full object-contain" style={{ backgroundColor: "#E2E8F0" }} />
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: "#22C55E" }}>
                      <svg className="w-3 h-3 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-bold" style={{ color: "#374151" }}>Image Ready</p>
                    <p className="text-xs mt-0.5" style={{ color: "#9CA3AF" }}>{imageInfo.file.name.substring(0, 25)}{imageInfo.file.name.length > 25 ? "..." : ""}</p>
                  </div>
                </div>
              )}
              <div>
                <h3 className="text-base font-bold mb-1 font-heading tracking-wide" style={{ color: "#111827" }}>Sticker Size</h3>
                <p className="text-xs mb-3" style={{ color: "#9CA3AF" }}>Max width or height — keeps proportions.</p>
                {sizeButtons}
              </div>
              {backButton}
            </div>

            <div className="flex flex-col">
              <div>
                <h3 className="text-base font-bold mb-1 font-heading tracking-wide" style={{ color: "#111827" }}>Quantity</h3>
                <p className="text-xs mb-3" style={{ color: "#9CA3AF" }}>Order more & save per sticker.</p>
                {quantityButtons}
              </div>
              {finishLamBlock}
              <div className="flex-1 flex items-center justify-center pt-4">
                <p className="preview-coming-text text-2xl font-extrabold tracking-wide">
                  ✨ Preview coming up! ✨
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <PricingDisplay
                widthInches={resizeSettings.widthInches}
                heightInches={resizeSettings.heightInches}
                quantity={quantity}
                shopStickerSettings={shopStickerSettings}
                finish={finish}
                lamination={lamination}
                variants={variants}
              />
              {continueButton}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-xl p-6 space-y-6" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
        <div>
          <h3 className="text-base font-bold mb-1 font-heading tracking-wide" style={{ color: "#111827" }}>Sticker Size</h3>
          <p className="text-xs mb-3" style={{ color: "#9CA3AF" }}>Max width or height — keeps proportions.</p>
          {sizeButtons}
        </div>
        <div>
          <h3 className="text-base font-bold mb-1 font-heading tracking-wide" style={{ color: "#111827" }}>Quantity</h3>
          <p className="text-xs mb-3" style={{ color: "#9CA3AF" }}>Order more & save per sticker.</p>
          {quantityButtons}
        </div>
        {finishLamBlock}
        <PricingDisplay
          widthInches={resizeSettings.widthInches}
          heightInches={resizeSettings.heightInches}
          quantity={quantity}
          shopStickerSettings={shopStickerSettings}
          finish={finish}
          lamination={lamination}
          variants={variants}
        />
        {continueButton}
        <div className="text-center py-8">
          <p className="preview-coming-text text-2xl font-extrabold tracking-wide">
            ✨ Preview coming up! ✨
          </p>
        </div>
      </div>
    );
  };

  // === Step 3: Design ===
  const renderStep3 = () => {
    const isContour = strokeSettings.enabled;
    const isShape = shapeSettings.enabled;

    return (
      <div className="space-y-5" ref={stickyRef}>
        <div>
          <p className="text-sm font-bold mb-3 font-heading tracking-wide text-center" style={{ color: "#111827" }}>
            How should we cut your sticker?
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => handleCutStyleSelect("contour")}
              className="p-4 rounded-xl transition-all text-center group"
              style={{
                backgroundColor: isContour ? "rgba(37, 99, 235, 0.12)" : "#F1F5F9",
                border: isContour ? "2px solid #2563EB" : "1px solid #E2E8F0",
                boxShadow: isContour ? "0 0 25px rgba(37, 99, 235, 0.2)" : "none",
              }}
            >
              <div className="w-14 h-14 mx-auto mb-2">
                <svg viewBox="0 0 64 64" className="w-full h-full">
                  <path d="M32 8 L38 24 L56 24 L42 36 L48 52 L32 42 L16 52 L22 36 L8 24 L26 24 Z" fill="none" stroke={isContour ? "#60A5FA" : "#9CA3AF"} strokeWidth="2" strokeDasharray="4 2" transform="scale(1.15) translate(-4, -4)" />
                  <path d="M32 8 L38 24 L56 24 L42 36 L48 52 L32 42 L16 52 L22 36 L8 24 L26 24 Z" fill={isContour ? "#2563EB" : "#CBD5E1"} />
                </svg>
              </div>
              <p className="text-sm font-bold" style={{ color: isContour ? "#2563EB" : "#6B7280" }}>Contour Cut</p>
              <p className="text-[10px] mt-0.5 italic" style={{ color: "#9CA3AF" }}>Most popular for logos</p>
            </button>

            <button
              onClick={() => handleCutStyleSelect("shape")}
              className="p-4 rounded-xl transition-all text-center group"
              style={{
                backgroundColor: isShape ? "rgba(37, 99, 235, 0.12)" : "#F1F5F9",
                border: isShape ? "2px solid #2563EB" : "1px solid #E2E8F0",
                boxShadow: isShape ? "0 0 25px rgba(37, 99, 235, 0.2)" : "none",
              }}
            >
              <div className="w-14 h-14 mx-auto mb-2">
                <svg viewBox="0 0 64 64" className="w-full h-full">
                  <circle cx="32" cy="32" r="28" fill="none" stroke={isShape ? "#60A5FA" : "#9CA3AF"} strokeWidth="2" strokeDasharray="4 2" />
                  <rect x="20" y="20" width="24" height="24" rx="2" fill={isShape ? "#2563EB" : "#CBD5E1"} />
                </svg>
              </div>
              <p className="text-sm font-bold" style={{ color: isShape ? "#2563EB" : "#6B7280" }}>Shape Cut</p>
              <p className="text-[10px] mt-0.5 italic" style={{ color: "#9CA3AF" }}>Best for simple designs</p>
            </button>
          </div>
        </div>

        {imageInfo && onRemoveBackground && (
          <>
            <button
              onClick={() => onRemoveBackground(95)}
              disabled={isRemovingBackground}
              className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-bold text-sm text-white transition-all hover:opacity-90 active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: "linear-gradient(135deg, #3B82F6 0%, #8B5CF6 50%, #EC4899 100%)", boxShadow: "0 4px 15px rgba(59, 130, 246, 0.3)" }}
            >
              {isRemovingBackground ? (
                <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> Removing Background...</>
              ) : (
                <><Sparkles className="w-4 h-4" /> Remove White Background</>
              )}
            </button>
            <p className="text-[11px] text-center -mt-1" style={{ color: "#EF4444" }}>It will remove all white background from your design</p>
            {hasOriginalImage && onToggleOriginalImage && (
              <button
                onClick={onToggleOriginalImage}
                className="w-full mt-2 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all"
                style={{
                  backgroundColor: showOriginalImage ? "rgba(37, 99, 235, 0.1)" : "#F1F5F9",
                  border: showOriginalImage ? "1px solid #60A5FA" : "1px solid #CBD5E1",
                  color: showOriginalImage ? "#2563EB" : "#6B7280",
                }}
              >
                {showOriginalImage ? "Showing original — tap to see result" : "Compare: Show original image"}
              </button>
            )}
          </>
        )}

        {(isContour || isShape) && onCutlineVisibilityChange && (
          <div className="flex items-center justify-between rounded-lg px-3 py-2" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
            <span className="text-xs font-bold" style={{ color: "#64748B" }}>Cutline preview</span>
            <div className="flex gap-1">
              {([
                { value: 'thin' as CutlineVisibility, label: 'Thin' },
                { value: 'normal' as CutlineVisibility, label: 'Normal' },
                { value: 'bold' as CutlineVisibility, label: 'Bold' },
              ]).map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => onCutlineVisibilityChange(opt.value)}
                  className="px-2 py-1 rounded text-[10px] font-bold transition-all"
                  style={{
                    backgroundColor: cutlineVisibility === opt.value ? "#2563EB" : "transparent",
                    color: cutlineVisibility === opt.value ? "#FFFFFF" : "#9CA3AF",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {isContour && (
          <div className="rounded-xl p-5 space-y-5" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
            <div>
              <p className="text-sm font-bold mb-1" style={{ color: "#2563EB" }}>Border thickness</p>
              <p className="text-[11px] mb-2.5" style={{ color: "#9CA3AF" }}>Distance from artwork to cut edge</p>
              {(() => {
                const isMultiObject = detectedAlgorithm === 'scattered';
                const options = isMultiObject
                  ? [
                      { value: "0.07", label: "Tight" },
                      { value: "0.14", label: "Medium" },
                      { value: "0.25", label: "Large" },
                    ]
                  : [
                      { value: "0.02", label: "Tiny" },
                      { value: "0.04", label: "Small" },
                      { value: "0.07", label: "Med" },
                      { value: "0.14", label: "Large" },
                      { value: "0.25", label: "XL" },
                    ];
                return (
                  <div className={`grid gap-1.5 ${isMultiObject ? 'grid-cols-3' : 'grid-cols-5'}`}>
                    {options.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => onStrokeChange({ width: parseFloat(opt.value) })}
                        className="rounded-lg text-xs font-bold py-2.5 transition-all text-center"
                        style={{
                          background: strokeSettings.width.toString() === opt.value ? "linear-gradient(135deg, #2563EB, #1D4ED8)" : "#E2E8F0",
                          border: strokeSettings.width.toString() === opt.value ? "1px solid #60A5FA" : "1px solid #CBD5E1",
                          color: strokeSettings.width.toString() === opt.value ? "#FFFFFF" : "#6B7280",
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div>
              <p className="text-sm font-bold mb-1" style={{ color: "#2563EB" }}>Printed background / bleed fill</p>
              <p className="text-[11px] mb-2.5" style={{ color: "#9CA3AF" }}>This color prints in the border area (bleed)</p>
              <ColorPicker value={strokeSettings.backgroundColor} onChange={(c) => onStrokeChange({ backgroundColor: c })} accentColor="#2563EB" />
            </div>
          </div>
        )}

        {isShape && (
          <div className="rounded-xl p-5 space-y-6" style={{ backgroundColor: "#F8FAFC", border: "1px solid #E2E8F0" }}>
            <div>
              <p className="text-sm font-bold mb-2.5" style={{ color: "#2563EB" }}>Shape</p>
              <div className="grid grid-cols-4 gap-2">
                {(["square", "rectangle", "circle", "oval"] as const).map((type) => (
                  <button
                    key={type}
                    onClick={() => onShapeChange({ type })}
                    className="p-3 rounded-xl transition-all flex flex-col items-center justify-center gap-1.5 hover:scale-105"
                    style={{
                      backgroundColor: shapeSettings.type === type ? "rgba(37, 99, 235, 0.15)" : "#F1F5F9",
                      border: shapeSettings.type === type ? "2px solid #2563EB" : "1px solid #E2E8F0",
                      boxShadow: shapeSettings.type === type ? "0 0 12px rgba(37, 99, 235, 0.2)" : "none",
                    }}
                  >
                    <div
                      style={{ backgroundColor: shapeSettings.type === type ? "#2563EB" : "#9CA3AF" }}
                      className={`${type === "square" ? "w-8 h-8 rounded" : type === "rectangle" ? "w-10 h-7 rounded" : type === "circle" ? "w-8 h-8 rounded-full" : "w-10 h-7 rounded-full"}`}
                    />
                    <p className="text-[10px] font-bold capitalize" style={{ color: shapeSettings.type === type ? "#2563EB" : "#9CA3AF" }}>{type}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-bold mb-2.5" style={{ color: "#2563EB" }}>Border thickness</p>
              <div className={`grid gap-1.5 ${shapeSettings.type === "circle" || shapeSettings.type === "oval" ? "grid-cols-5" : "grid-cols-4"}`}>
                {(shapeSettings.type === "circle" || shapeSettings.type === "oval"
                  ? [{ value: "0", label: "Zero" }, { value: "0.03", label: "Tiny" }, { value: "0.09", label: "Small" }, { value: "0.15", label: "Med" }, { value: "0.2", label: "Large" }]
                  : [{ value: "0.0625", label: "Tiny" }, { value: "0.125", label: "Small" }, { value: "0.1875", label: "Med" }, { value: "0.25", label: "Large" }]
                ).map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => onShapeChange({ offset: parseFloat(opt.value) })}
                    className="rounded-lg text-xs font-bold py-2.5 transition-all text-center"
                    style={{
                      background: shapeSettings.offset.toString() === opt.value ? "linear-gradient(135deg, #2563EB, #1D4ED8)" : "#E2E8F0",
                      border: shapeSettings.offset.toString() === opt.value ? "1px solid #60A5FA" : "1px solid #CBD5E1",
                      color: shapeSettings.offset.toString() === opt.value ? "#FFFFFF" : "#6B7280",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="text-sm font-bold mb-2.5" style={{ color: "#2563EB" }}>Printed background / bleed fill</p>
              <ColorPicker value={shapeSettings.fillColor} onChange={(c) => onShapeChange({ fillColor: c })} accentColor="#2563EB" />
            </div>
          </div>
        )}

        {(isContour || isShape) && (
          <>
            <PricingDisplay
              widthInches={resizeSettings.widthInches}
              heightInches={resizeSettings.heightInches}
              quantity={quantity}
              shopStickerSettings={shopStickerSettings}
              finish={finish}
              lamination={lamination}
              variants={variants}
            />
            <CTABlock />
          </>
        )}
      </div>
    );
  };

  // ========== LAYOUT (same for embed and desktop) ==========
  return (
    <div className="pb-20 md:pb-0">
      <StepIndicator />

      <div className="space-y-3">
        {currentStep >= 1 && (currentStep === 1 ? renderStep1() : (
          <button
            onClick={() => goToStep(1)}
            className="w-full text-left p-3 rounded-lg transition-all flex items-center justify-between group"
            style={{ backgroundColor: "#F1F5F9", border: "1px solid #E2E8F0" }}
          >
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs" style={{ backgroundColor: "#2563EB" }}>
                <Check className="w-3 h-3" />
              </span>
              <span className="text-sm font-semibold" style={{ color: "#6B7280" }}>
                {imageInfo?.file.name ? imageInfo.file.name.substring(0, 20) + (imageInfo.file.name.length > 20 ? "..." : "") : "Upload"}
              </span>
            </div>
            <span className="text-xs font-bold group-hover:underline" style={{ color: "#60A5FA" }}>Edit</span>
          </button>
        ))}

        {canProceedToStep2 && currentStep >= 2 && (currentStep === 2 ? renderStep2() : (
          <button
            onClick={() => goToStep(2)}
            className="w-full text-left p-3 rounded-lg transition-all flex items-center justify-between group"
            style={{ backgroundColor: "#F1F5F9", border: "1px solid #E2E8F0" }}
          >
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs" style={{ backgroundColor: "#2563EB" }}>
                <Check className="w-3 h-3" />
              </span>
              <span className="text-sm font-semibold" style={{ color: "#6B7280" }}>
                {resizeSettings.widthInches}" × {resizeSettings.heightInches}" · {quantity} stickers
              </span>
            </div>
            <span className="text-xs font-bold group-hover:underline" style={{ color: "#60A5FA" }}>Edit</span>
          </button>
        ))}

        {canProceedToStep3 && currentStep >= 3 && renderStep3()}
      </div>

      {!(fullWidth && currentStep === 2) && (currentStep > 1 || (currentStep < 3 && canProceedToStep2)) && (
        <div className="flex justify-between items-center mt-5 gap-3">
          {currentStep > 1 ? (
            <button
              onClick={prevStep}
              className="flex-1 py-2.5 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-colors hover:bg-gray-100"
              style={{ border: "1px solid #CBD5E1", color: "#6B7280" }}
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          ) : <div className="flex-1" />}

          {currentStep < 3 && (
            <button
              onClick={nextStep}
              disabled={(currentStep === 1 && !canProceedToStep2) || (currentStep === 2 && !canProceedToStep3)}
              className="flex-1 py-2.5 px-4 rounded-lg text-sm font-bold flex items-center justify-center gap-1 transition-all disabled:opacity-30"
              style={{
                background: ((currentStep === 1 && canProceedToStep2) || (currentStep === 2 && canProceedToStep3))
                  ? "linear-gradient(135deg, #2563EB, #1D4ED8)" : "#CBD5E1",
                color: ((currentStep === 1 && canProceedToStep2) || (currentStep === 2 && canProceedToStep3)) ? "#FFFFFF" : "#9CA3AF",
              }}
            >
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* Sticky Order Summary */}
      {showSticky && currentStep === 3 && (strokeSettings.enabled || shapeSettings.enabled) && !isEmbedMode && (
        <div
          className="fixed bottom-0 left-0 right-0 z-50 px-4 py-3"
          style={{
            background: "linear-gradient(180deg, rgba(255, 255, 255, 0.97) 0%, #FFFFFF 100%)",
            borderTop: "1px solid #E2E8F0",
            backdropFilter: "blur(12px)",
          }}
        >
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm" style={{ color: "#6B7280" }}>
              <Package className="w-4 h-4" style={{ color: "#2563EB" }} />
              <span className="font-semibold">{resizeSettings.widthInches}" × {resizeSettings.heightInches}" · {quantity} stickers</span>
              <span className="font-extrabold text-lg" style={{ color: "#111827" }}>${displayTotal.toFixed(2)}</span>
            </div>
            <button
              onClick={designSent ? undefined : handleProceedToCheckout}
              disabled={isSending}
              className="px-6 py-2.5 rounded-lg font-bold text-sm disabled:opacity-50"
              style={{ background: "linear-gradient(135deg, #2563EB, #1D4ED8)", color: "#FFFFFF", boxShadow: "0 4px 15px rgba(37, 99, 235, 0.35)" }}
            >
              {isSending ? "Saving..." : designSent ? "Added ✓" : `Add to Cart – $${displayTotal.toFixed(2)}`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
