import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import UploadSection, { StickerOptions } from "./upload-section";
import PreviewSection from "./preview-section";
import ControlsSection from "./controls-section";
import { calculateImageDimensions, downloadCanvas } from "@/lib/image-utils";
import { cropImageToContent } from "./image-crop";
import {
  createVectorStroke,
  downloadVectorStroke,
  createVectorPaths,
  type VectorFormat,
} from "@/lib/vector-stroke";
import { createTrueContour } from "@/lib/true-contour";
import { createCTContour } from "@/lib/ctcontour";
import { checkCadCutBounds, type CadCutBounds } from "@/lib/cadcut-bounds";
import {
  downloadContourPDF,
  type CachedContourData,
} from "@/lib/contour-outline";
import { getContourWorkerManager, DetectedAlgorithm } from "@/lib/contour-worker-manager";
import {
  downloadShapePDF,
  calculateShapeDimensions,
} from "@/lib/shape-outline";
import { useDebouncedValue } from "@/hooks/use-debounce";
import { removeBackgroundFromImage } from "@/lib/background-removal";

export type {
  ImageInfo,
  StrokeSettings,
  StrokeMode,
  ResizeSettings,
  ShapeSettings,
  StickerSize,
  CutlineVisibility,
} from "@/lib/types";
import type {
  ImageInfo,
  StrokeSettings,
  StrokeMode,
  ResizeSettings,
  ShapeSettings,
  StickerSize,
  CutlineVisibility,
} from "@/lib/types";
import type { ShopStickerSettings } from "@/lib/shop-sticker-settings";
import { snapQuantityToOptions } from "@/lib/pricing";
import type { DieCutShopifyVariant } from "./die-cut-checkout";
import { useLanguage } from "@/lib/i18n";

function initialQuantityFromShop(
  shop: ShopStickerSettings | null | undefined,
): number {
  if (shop?.pricing?.quantityOptions?.length) {
    return snapQuantityToOptions(
      shop.defaults?.quantity ?? 25,
      shop.pricing.quantityOptions,
    );
  }
  return 25;
}

function initialResizeFromShop(
  shop: ShopStickerSettings | null | undefined,
): ResizeSettings {
  if (shop?.defaults?.widthIn != null && shop?.defaults?.heightIn != null) {
    const w = Number(shop.defaults.widthIn);
    const h = Number(shop.defaults.heightIn);
    if (w > 0 && h > 0) {
      return {
        widthInches: w,
        heightInches: h,
        maintainAspectRatio: true,
        outputDPI: 300,
      };
    }
  }
  return {
    widthInches: 5.0,
    heightInches: 3.8,
    maintainAspectRatio: true,
    outputDPI: 300,
  };
}

function initialStickerSizeFromShop(
  shop: ShopStickerSettings | null | undefined,
): StickerSize {
  if (shop?.defaults?.widthIn != null && shop?.defaults?.heightIn != null) {
    const w = Number(shop.defaults.widthIn);
    const h = Number(shop.defaults.heightIn);
    if (w > 0 && h > 0) return Math.max(w, h) as StickerSize;
  }
  return 3;
}

interface ImageEditorProps {
  shopStickerSettings?: ShopStickerSettings | null;
  isEmbedMode?: boolean;
  embedParentOrigin?: string;
  embedReturnUrl?: string;
  customerId?: string;
  customerEmail?: string;
  productHandle?: string;
  variantId?: string;
  variants?: DieCutShopifyVariant[];
  shopDomain?: string;
  initialImageUrl?: string;
  initialImageName?: string;
  initialStickerSize?: string;
  initialQuantity?: string;
  initialOutlineType?: string;
}

export default function ImageEditor({
  shopStickerSettings = null,
  isEmbedMode = false,
  embedParentOrigin,
  embedReturnUrl,
  customerId,
  customerEmail,
  productHandle,
  variantId,
  variants,
  shopDomain,
  initialImageUrl,
  initialImageName,
  initialStickerSize,
  initialQuantity,
  initialOutlineType,
}: ImageEditorProps) {
  const { t } = useLanguage();
  const [imageInfo, setImageInfo] = useState<ImageInfo | null>(null);
  const [cadCutBounds, setCadCutBounds] = useState<CadCutBounds | null>(null);
  const [strokeSettings, setStrokeSettings] = useState<StrokeSettings>({
    width: 0.14, // Default large offset
    color: "#ffffff",
    enabled: false,
    alphaThreshold: 10, // Very sensitive - detect even semi-transparent pixels
    backgroundColor: "#ffffff",
    useCustomBackground: true,
    cornerMode: 'rounded' as const,
    autoBridging: true,
    autoBridgingThreshold: 0.02,
  });
  const [resizeSettings, setResizeSettings] = useState<ResizeSettings>(() =>
    initialResizeFromShop(shopStickerSettings),
  );
  const [shapeSettings, setShapeSettings] = useState<ShapeSettings>({
    enabled: false,
    type: "square",
    offset: 0.25, // Default "Big" offset around design
    fillColor: "#FFFFFF",
    strokeEnabled: false,
    strokeWidth: 2,
    strokeColor: "#000000",
    cornerRadius: 0.25, // Default corner radius for rounded shapes (in inches)
  });
  const [strokeMode, setStrokeMode] = useState<StrokeMode>("none");
  const [stickerSize, setStickerSize] = useState<StickerSize>(() =>
    initialStickerSizeFromShop(shopStickerSettings),
  );
  const [quantity, setQuantity] = useState<number>(() =>
    initialQuantityFromShop(shopStickerSettings),
  );
  const shopLayoutSyncedRef = useRef(false);
  useEffect(() => {
    if (!shopStickerSettings) return;
    if (shopLayoutSyncedRef.current) return;
    shopLayoutSyncedRef.current = true;
    setResizeSettings(initialResizeFromShop(shopStickerSettings));
    setStickerSize(initialStickerSizeFromShop(shopStickerSettings));
    setQuantity(initialQuantityFromShop(shopStickerSettings));
  }, [shopStickerSettings]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRemovingBackground, setIsRemovingBackground] = useState(false);
  const [cutlineVisibility, setCutlineVisibility] = useState<CutlineVisibility>('normal');
  const [detectedAlgorithm, setDetectedAlgorithm] = useState<DetectedAlgorithm | undefined>(undefined);
  const [originalImageBeforeBgRemoval, setOriginalImageBeforeBgRemoval] = useState<ImageInfo | null>(null);
  const [showOriginalImage, setShowOriginalImage] = useState(false);
  const [fitTrigger, setFitTrigger] = useState(0);
  const [wizardStep, setWizardStep] = useState(1);
  const [embedStickerOptions, setEmbedStickerOptions] =
    useState<StickerOptions | null>(null);
  const initialImageLoadedRef = useRef(false);

  // Clear image and start over
  const handleClearImage = useCallback(() => {
    setImageInfo(null);
    setCadCutBounds(null);
    setDetectedAlgorithm(undefined);
    setWizardStep(1);
    setEmbedStickerOptions(null);
    setOriginalImageBeforeBgRemoval(null);
    setShowOriginalImage(false);
    setStrokeSettings((prev) => ({ ...prev, enabled: false }));
    setShapeSettings((prev) => ({ ...prev, enabled: false }));
  }, []);

  const loadImageFromUrl = useCallback(async (url: string, name?: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Failed to load design image");
    }
    const blob = await response.blob();
    const filename = name || "design.png";
    const file = new File([blob], filename, { type: blob.type || "image/png" });

    const image = new Image();
    const objectUrl = URL.createObjectURL(blob);
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode design image"));
      image.src = objectUrl;
    });
    URL.revokeObjectURL(objectUrl);
    return { file, image };
  }, []);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Debounced settings for heavy processing
  const debouncedStrokeSettings = useDebouncedValue(strokeSettings, 100);
  const debouncedResizeSettings = useDebouncedValue(resizeSettings, 250); // Higher debounce for size changes
  const debouncedShapeSettings = useDebouncedValue(shapeSettings, 100);

  // Function to update CadCut bounds checking - accepts shape settings to avoid stale closure
  const updateCadCutBounds = useCallback(
    (
      shapeWidthInches: number,
      shapeHeightInches: number,
      currentShapeSettings: ShapeSettings,
    ) => {
      if (!imageInfo) {
        setCadCutBounds(null);
        return;
      }

      // Convert inches to pixels for bounds checking
      const shapeWidthPixels = shapeWidthInches * imageInfo.dpi;
      const shapeHeightPixels = shapeHeightInches * imageInfo.dpi;

      const bounds = checkCadCutBounds(
        imageInfo.image,
        currentShapeSettings,
        shapeWidthPixels,
        shapeHeightPixels,
      );

      setCadCutBounds(bounds);
    },
    [imageInfo],
  );

  const handleImageUpload = useCallback(
    (file: File, image: HTMLImageElement, options?: StickerOptions) => {
      try {
        // Store embed sticker options if provided
        if (options) {
          setEmbedStickerOptions(options);
          const sizeNum = parseFloat(options.size);
          if (!Number.isNaN(sizeNum) && sizeNum > 0) {
            setStickerSize(sizeNum as StickerSize);
          }
          if (options.quantity) {
            setQuantity(options.quantity);
          }
        }

        // Validate image size to prevent crashes
        if (image.width * image.height > 160000000) {
          // 160MP limit
          alert(
            "Image is too large. Please upload an image smaller than 160 megapixels.",
          );
          return;
        }

        // Validate image dimensions
        if (image.width <= 0 || image.height <= 0) {
          alert("Invalid image dimensions.");
          return;
        }

        // Automatically crop the image to remove ALL empty space
        const croppedCanvas = cropImageToContent(image);
        if (!croppedCanvas) {
          console.error("Failed to crop image, using original");
          handleFallbackImage(file, image);
          return;
        }

        const croppedImage = new Image();

        croppedImage.onload = () => {
          const dpi = 300; // Default DPI for high-quality printing

          // Create final cropped image info with zero padding
          const newImageInfo: ImageInfo = {
            file,
            image: croppedImage,
            originalWidth: croppedImage.width,
            originalHeight: croppedImage.height,
            dpi,
          };

          setImageInfo(newImageInfo);

          // Auto-detect shape type based on image aspect ratio
          const aspectRatio = croppedImage.width / croppedImage.height;
          let autoShapeType: "square" | "rectangle" | "circle" | "oval" =
            "rectangle";

          // Square: aspect ratio between 0.9 and 1.1 (close to 1:1)
          if (aspectRatio >= 0.9 && aspectRatio <= 1.1) {
            autoShapeType = "square";
          } else {
            // Rectangle for wider or taller images
            autoShapeType = "rectangle";
          }

          // Reset Step 3 (Outline Options) to defaults when new image is uploaded
          setStrokeSettings({
            width: 0.14,
            color: "#ffffff",
            enabled: false,
            alphaThreshold: 10,
            backgroundColor: "#ffffff",
            useCustomBackground: true,
            cornerMode: 'rounded' as const,
            autoBridging: true,
            autoBridgingThreshold: 0.02,
          });

          // Enable shape outline by default with auto-detected shape
          setShapeSettings({
            enabled: true,
            type: autoShapeType,
            offset: 0.125,
            fillColor: "#FFFFFF",
            strokeEnabled: false,
            strokeWidth: 2,
            strokeColor: "#000000",
            cornerRadius: 0.25,
          });

          // Calculate dimensions to exactly match the selected sticker size
          const imgAR = croppedImage.width / croppedImage.height;
          let widthInches: number;
          let heightInches: number;
          if (imgAR >= 1) {
            widthInches = stickerSize;
            heightInches = parseFloat((stickerSize / imgAR).toFixed(2));
          } else {
            heightInches = stickerSize;
            widthInches = parseFloat((stickerSize * imgAR).toFixed(2));
          }

          setResizeSettings((prev) => ({
            ...prev,
            widthInches,
            heightInches,
          }));

          // Initial bounds check using auto-sized shape dimensions
          const shapeDims = calculateShapeDimensions(
            widthInches,
            heightInches,
            shapeSettings.type,
            shapeSettings.offset,
          );
          updateCadCutBounds(
            shapeDims.widthInches,
            shapeDims.heightInches,
            shapeSettings,
          );
        };

        croppedImage.onerror = () => {
          console.error("Error loading cropped image, using original");
          handleFallbackImage(file, image);
        };

        croppedImage.src = croppedCanvas.toDataURL("image/png");
      } catch (error) {
        console.error("Error processing uploaded image:", error);
        handleFallbackImage(file, image);
      }
    },
    [shapeSettings, stickerSize, updateCadCutBounds],
  );

  useEffect(() => {
    if (!initialImageUrl || initialImageLoadedRef.current) return;
    if (imageInfo) return;
    initialImageLoadedRef.current = true;

    const initialOptions: StickerOptions | undefined = initialStickerSize
      ? {
          size: initialStickerSize,
          quantity: initialQuantity ? parseInt(initialQuantity, 10) : 1,
        }
      : undefined;

    loadImageFromUrl(initialImageUrl, initialImageName)
      .then(({ file, image }) => {
        handleImageUpload(file, image, initialOptions);

        if (initialStickerSize) {
          const sizeNum = parseFloat(initialStickerSize);
          if (!Number.isNaN(sizeNum) && sizeNum > 0) {
            setStickerSize(sizeNum as StickerSize);
          }
        }

        if (initialOutlineType === "contour") {
          setStrokeSettings((prev) => ({ ...prev, enabled: true }));
          setShapeSettings((prev) => ({ ...prev, enabled: false }));
        } else if (initialOutlineType === "shape") {
          setShapeSettings((prev) => ({ ...prev, enabled: true }));
          setStrokeSettings((prev) => ({ ...prev, enabled: false }));
        }
      })
      .catch((error) => {
        console.error("Failed to load initial design image:", error);
      });
  }, [
    initialImageUrl,
    initialImageName,
    initialStickerSize,
    initialQuantity,
    initialOutlineType,
    imageInfo,
    loadImageFromUrl,
    handleImageUpload,
  ]);

  const handleFallbackImage = useCallback(
    (file: File, image: HTMLImageElement) => {
      const dpi = 300;

      // Always try to crop even fallback images to remove empty space
      const croppedCanvas = cropImageToContent(image);
      const finalImage = croppedCanvas
        ? (() => {
            const img = new Image();
            img.src = croppedCanvas.toDataURL();
            return img;
          })()
        : image;

      const processImage = () => {
        // Calculate dimensions to exactly match the selected sticker size
        const imgAR2 = finalImage.width / finalImage.height;
        let widthInches: number;
        let heightInches: number;
        if (imgAR2 >= 1) {
          widthInches = stickerSize;
          heightInches = parseFloat((stickerSize / imgAR2).toFixed(2));
        } else {
          heightInches = stickerSize;
          widthInches = parseFloat((stickerSize * imgAR2).toFixed(2));
        }

        const newImageInfo: ImageInfo = {
          file,
          image: finalImage,
          originalWidth: finalImage.width,
          originalHeight: finalImage.height,
          dpi,
        };

        setImageInfo(newImageInfo);

        // Reset Step 3 (Outline Options) to defaults when new image is uploaded
        setStrokeSettings({
          width: 0.14,
          color: "#ffffff",
          enabled: false,
          alphaThreshold: 10,
          backgroundColor: "#ffffff",
          useCustomBackground: true,
          cornerMode: 'rounded' as const,
          autoBridging: true,
          autoBridgingThreshold: 0.02,
        });
        setShapeSettings({
          enabled: false,
          type: "square",
          offset: 0.25,
          fillColor: "#FFFFFF",
          strokeEnabled: false,
          strokeWidth: 2,
          strokeColor: "#000000",
          cornerRadius: 0.25,
        });

        setResizeSettings((prev) => ({
          ...prev,
          widthInches,
          heightInches,
        }));

        // Initial bounds check using auto-sized shape dimensions
        const shapeDims = calculateShapeDimensions(
          widthInches,
          heightInches,
          shapeSettings.type,
          shapeSettings.offset,
        );
        updateCadCutBounds(
          shapeDims.widthInches,
          shapeDims.heightInches,
          shapeSettings,
        );
      };

      if (croppedCanvas) {
        finalImage.onload = processImage;
      } else {
        processImage();
      }
    },
    [shapeSettings, stickerSize, updateCadCutBounds],
  );

  const handleResizeChange = useCallback(
    (newSettings: Partial<ResizeSettings>) => {
      setResizeSettings((prev) => {
        const updated = { ...prev, ...newSettings };

        // Handle aspect ratio maintenance — only recalculate if ONE dimension is provided, not both
        const bothProvided = newSettings.widthInches !== undefined && newSettings.heightInches !== undefined;
        if (
          !bothProvided &&
          updated.maintainAspectRatio &&
          imageInfo &&
          newSettings.widthInches !== undefined
        ) {
          const aspectRatio =
            imageInfo.originalHeight / imageInfo.originalWidth;
          updated.heightInches = parseFloat(
            (newSettings.widthInches * aspectRatio).toFixed(1),
          );
        } else if (
          !bothProvided &&
          updated.maintainAspectRatio &&
          imageInfo &&
          newSettings.heightInches !== undefined
        ) {
          const aspectRatio =
            imageInfo.originalWidth / imageInfo.originalHeight;
          updated.widthInches = parseFloat(
            (newSettings.heightInches * aspectRatio).toFixed(1),
          );
        }

        // Recalculate bounds with auto-sized shape dimensions
        if (shapeSettings.enabled) {
          const shapeDims = calculateShapeDimensions(
            updated.widthInches,
            updated.heightInches,
            shapeSettings.type,
            shapeSettings.offset,
          );
          updateCadCutBounds(
            shapeDims.widthInches,
            shapeDims.heightInches,
            shapeSettings,
          );
        }

        return updated;
      });
    },
    [imageInfo, shapeSettings, updateCadCutBounds],
  );

  const handleStickerSizeChange = useCallback(
    (newSize: StickerSize, customDimensions?: { widthInches: number; heightInches: number }) => {
      setStickerSize(newSize);

      let newWidth: number;
      let newHeight: number;

      if (customDimensions) {
        newWidth = customDimensions.widthInches;
        newHeight = customDimensions.heightInches;
      } else if (imageInfo) {
        const aspectRatio = imageInfo.originalWidth / imageInfo.originalHeight;
        if (aspectRatio >= 1) {
          newWidth = newSize;
          newHeight = parseFloat((newSize / aspectRatio).toFixed(2));
        } else {
          newHeight = newSize;
          newWidth = parseFloat((newSize * aspectRatio).toFixed(2));
        }
      } else {
        return;
      }

      setResizeSettings((prev) => ({
        ...prev,
        widthInches: newWidth,
        heightInches: newHeight,
      }));

      if (shapeSettings.enabled) {
        const shapeDims = calculateShapeDimensions(
          newWidth,
          newHeight,
          shapeSettings.type,
          shapeSettings.offset,
        );
        updateCadCutBounds(
          shapeDims.widthInches,
          shapeDims.heightInches,
          shapeSettings,
        );
      }
    },
    [imageInfo, shapeSettings, updateCadCutBounds],
  );

  const handleRemoveBackground = useCallback(
    async (threshold: number) => {
      if (!imageInfo) return;

      setIsRemovingBackground(true);
      try {
        if (!originalImageBeforeBgRemoval) {
          setOriginalImageBeforeBgRemoval({ ...imageInfo });
        }
        setShowOriginalImage(false);

        const bgRemovedImage = await removeBackgroundFromImage(
          imageInfo.image,
          threshold,
        );

        // Crop to content bounds after background removal so shape fits actual visible content
        const croppedCanvas = cropImageToContent(bgRemovedImage);
        if (!croppedCanvas) {
          console.error("Failed to crop image after background removal");
          setIsRemovingBackground(false);
          return;
        }

        // Convert cropped canvas to image
        const finalImage = await new Promise<HTMLImageElement>(
          (resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = croppedCanvas.toDataURL("image/png");
          },
        );

        const newWidth = finalImage.naturalWidth || finalImage.width;
        const newHeight = finalImage.naturalHeight || finalImage.height;

        // Create new image info with the processed and cropped image
        const newImageInfo: ImageInfo = {
          ...imageInfo,
          image: finalImage,
          originalWidth: newWidth,
          originalHeight: newHeight,
        };

        // Recalculate resize settings based on cropped image dimensions
        const dpi = imageInfo.dpi || 300;
        // Calculate dimensions to exactly match the selected sticker size
        const bgRemoveAR = newWidth / newHeight;
        let widthInches: number;
        let heightInches: number;
        if (bgRemoveAR >= 1) {
          widthInches = stickerSize;
          heightInches = parseFloat((stickerSize / bgRemoveAR).toFixed(2));
        } else {
          heightInches = stickerSize;
          widthInches = parseFloat((stickerSize * bgRemoveAR).toFixed(2));
        }

        setResizeSettings((prev) => ({
          ...prev,
          widthInches,
          heightInches,
        }));

        // Clear contour cache to force recomputation with new image
        const workerManager = getContourWorkerManager();
        workerManager.clearCache();

        // Reset CadCut bounds
        setCadCutBounds(null);

        setImageInfo(newImageInfo);
        setFitTrigger(prev => prev + 1);
      } catch (error) {
        console.error("Error removing background:", error);
      } finally {
        setIsRemovingBackground(false);
      }
    },
    [imageInfo, stickerSize, originalImageBeforeBgRemoval],
  );

  const handleToggleOriginalImage = useCallback(() => {
    if (!originalImageBeforeBgRemoval || !imageInfo) return;
    setShowOriginalImage(prev => !prev);
  }, [originalImageBeforeBgRemoval, imageInfo]);

  const handleStrokeChange = useCallback(
    (newSettings: Partial<StrokeSettings>) => {
      const updated = { ...strokeSettings, ...newSettings };

      if (newSettings.enabled === true) {
        setShapeSettings((prev) => ({ ...prev, enabled: false }));
        setFitTrigger(prev => prev + 1);
      }

      if (newSettings.width !== undefined && newSettings.width !== strokeSettings.width) {
        setFitTrigger(prev => prev + 1);
      }

      setStrokeSettings(updated);
    },
    [strokeSettings],
  );

  const handleShapeChange = useCallback(
    (newSettings: Partial<ShapeSettings>) => {
      let updated = { ...shapeSettings, ...newSettings };

      if (newSettings.enabled === true) {
        setStrokeSettings((prev) => ({ ...prev, enabled: false }));
        setFitTrigger(prev => prev + 1);
      }

      // Auto-reset offset when switching between shape type categories
      if (
        newSettings.type !== undefined &&
        newSettings.type !== shapeSettings.type
      ) {
        const wasCircular =
          shapeSettings.type === "circle" || shapeSettings.type === "oval";
        const isCircular =
          newSettings.type === "circle" || newSettings.type === "oval";

        if (wasCircular !== isCircular) {
          // Switch to appropriate default offset for new shape category
          updated.offset = isCircular ? 0.4 : 0.125; // Tiny for circular, Small for rectangular
        }
      }

      setShapeSettings(updated);

      // Recalculate bounds with auto-sized shape dimensions - pass updated settings to avoid stale closure
      if (updated.enabled && imageInfo) {
        const shapeDims = calculateShapeDimensions(
          resizeSettings.widthInches,
          resizeSettings.heightInches,
          updated.type,
          updated.offset,
        );
        updateCadCutBounds(
          shapeDims.widthInches,
          shapeDims.heightInches,
          updated,
        );
      }
    },
    [shapeSettings, imageInfo, resizeSettings, updateCadCutBounds],
  );

  const handleDownload = useCallback(
    async (
      downloadType:
        | "standard"
        | "highres"
        | "vector"
        | "cutcontour"
        | "design-only"
        | "download-package" = "standard",
      format: VectorFormat = "png",
    ) => {
      if (!imageInfo || !canvasRef.current) return;

      setIsProcessing(true);

      try {
        if (downloadType === "download-package") {
          // Create zip package with original and cutlines
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          if (!ctx) return;

          // Calculate output dimensions using auto-sizing
          const shapeDims = calculateShapeDimensions(
            resizeSettings.widthInches,
            resizeSettings.heightInches,
            shapeSettings.type,
            shapeSettings.offset,
          );
          const outputWidth = shapeDims.widthInches * 300;
          const outputHeight = shapeDims.heightInches * 300;

          canvas.width = outputWidth;
          canvas.height = outputHeight;

          // Draw shape background
          ctx.fillStyle = shapeSettings.fillColor;
          ctx.beginPath();

          if (shapeSettings.type === "circle") {
            const radius = Math.min(outputWidth, outputHeight) / 2;
            const centerX = outputWidth / 2;
            const centerY = outputHeight / 2;
            ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
          } else if (shapeSettings.type === "oval") {
            const centerX = outputWidth / 2;
            const centerY = outputHeight / 2;
            ctx.ellipse(
              centerX,
              centerY,
              outputWidth / 2,
              outputHeight / 2,
              0,
              0,
              Math.PI * 2,
            );
          } else if (shapeSettings.type === "square") {
            const size = Math.min(outputWidth, outputHeight);
            const startX = (outputWidth - size) / 2;
            const startY = (outputHeight - size) / 2;
            ctx.rect(startX, startY, size, size);
          } else {
            ctx.rect(0, 0, outputWidth, outputHeight);
          }

          ctx.fill();

          // Draw cutlines in magenta
          ctx.strokeStyle = "#FF00FF";
          ctx.lineWidth = 2;
          ctx.stroke();

          // Crop image to remove empty space before processing
          const croppedCanvas = cropImageToContent(imageInfo.image);
          const finalImage = croppedCanvas
            ? (() => {
                const img = new Image();
                img.src = croppedCanvas.toDataURL();
                return img;
              })()
            : imageInfo.image;

          // Wait for cropped image to load if created
          if (croppedCanvas) {
            await new Promise((resolve) => {
              finalImage.onload = resolve;
            });
          }

          // Center and draw the cropped image with manual positioning
          const imageAspect = finalImage.width / finalImage.height;
          const shapeAspect = outputWidth / outputHeight;

          let imageWidth, imageHeight;
          if (imageAspect > shapeAspect) {
            imageWidth = outputWidth * 0.8;
            imageHeight = imageWidth / imageAspect;
          } else {
            imageHeight = outputHeight * 0.8;
            imageWidth = imageHeight * imageAspect;
          }

          // Center the design in the shape (no manual offset needed)
          const imageX = (outputWidth - imageWidth) / 2;
          const imageY = (outputHeight - imageHeight) / 2;

          ctx.drawImage(finalImage, imageX, imageY, imageWidth, imageHeight);

          // Download final design only
          const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, "");
          canvas.toBlob((blob) => {
            if (blob) {
              const url = URL.createObjectURL(blob);
              const link = document.createElement("a");
              link.href = url;
              link.download = `${nameWithoutExt}_final_design.png`;
              link.style.display = "none";
              document.body.appendChild(link);
              link.click();
              document.body.removeChild(link);
              URL.revokeObjectURL(url);
            }
          }, "image/png");
        } else if (downloadType === "cutcontour") {
          // Generate magenta vector path along transparent pixel boundaries
          await new Promise((resolve) => setTimeout(resolve, 100)); // UI feedback delay

          const magentaCutCanvas = createVectorStroke(imageInfo.image, {
            strokeSettings: {
              ...strokeSettings,
              color: "#FF00FF",
              enabled: true,
            }, // Force magenta
            exportCutContour: true, // Enable cut contour mode
            vectorQuality: "high", // High quality for precise cutting paths
          });

          // Download the magenta cut contour
          magentaCutCanvas.toBlob((blob: Blob | null) => {
            if (!blob) return;

            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "magenta_cut_contour.png";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
          }, "image/png");

          // Also generate vector formats for cutting machines
          const vectorPaths = createVectorPaths(imageInfo.image, {
            ...strokeSettings,
            color: "#FF00FF",
            enabled: true,
          });

          // Download additional vector formats based on requested format
          if (format === "svg") {
            downloadVectorStroke(
              magentaCutCanvas,
              "cut_contour.svg",
              "svg",
              vectorPaths,
            );
          } else if (format === "eps") {
            downloadVectorStroke(
              magentaCutCanvas,
              "cut_contour.eps",
              "eps",
              vectorPaths,
            );
          }
        } else {
          // Standard download - shape background or contour outline
          const nameWithoutExt = imageInfo.file.name.replace(/\.[^/.]+$/, "");

          if (strokeSettings.enabled) {
            // Contour mode: Download PDF with raster image + vector contour
            const filename = `${nameWithoutExt}_with_contour.pdf`;

            // Get cached contour data from worker manager for fast PDF export
            const workerManager = getContourWorkerManager();
            const cachedData = workerManager.getCachedContourData() as
              | CachedContourData
              | undefined;

            await downloadContourPDF(
              imageInfo.image,
              strokeSettings,
              resizeSettings,
              filename,
              cachedData,
            );
          } else if (shapeSettings.enabled) {
            // Shape background mode: Download PDF with shape + CutContour spot color
            const filename = `${nameWithoutExt}_with_shape.pdf`;
            await downloadShapePDF(
              imageInfo.image,
              shapeSettings,
              resizeSettings,
              filename,
            );
          } else {
            // No mode selected - just download the image
            const dpi = 300;
            const filename = `${nameWithoutExt}.png`;
            await downloadCanvas(
              imageInfo.image,
              strokeSettings,
              resizeSettings.widthInches,
              resizeSettings.heightInches,
              dpi,
              filename,
              undefined,
            );
          }
        }
      } catch (error) {
        console.error("Download failed:", error);
        console.error("Error details:", {
          hasImage: !!imageInfo,
          hasCanvas: !!canvasRef.current,
          shapeSettings,
          resizeSettings,
          strokeSettings,
        });
        alert(
          `${t("toast.downloadFailed")}: ${error instanceof Error ? error.message : t("error.title")}. ${t("toast.downloadFailedDesc")}`,
        );
      } finally {
        setIsProcessing(false);
      }
    },
    [imageInfo, strokeSettings, resizeSettings, shapeSettings, t],
  );

  if (!imageInfo) {
    return (
      <div>
        <UploadSection
          onImageUpload={handleImageUpload}
          imageInfo={imageInfo}
          resizeSettings={resizeSettings}
          showCutLineInfo={false}
        />

        {isProcessing && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-sm mx-4">
              <div className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#1B2A4A]"></div>
                <div className="text-gray-700">
                  <div className="font-medium">{t("dieCut.processingImage")}</div>
                  <div className="text-sm text-gray-500 mt-1">{t("dieCut.processingDescription")}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const controlsProps = {
    strokeSettings,
    resizeSettings,
    shapeSettings,
    stickerSize,
    quantity,
    onQuantityChange: setQuantity,
    onStrokeChange: handleStrokeChange,
    onResizeChange: handleResizeChange,
    onShapeChange: handleShapeChange,
    onStickerSizeChange: handleStickerSizeChange,
    onDownload: handleDownload,
    isProcessing,
    imageInfo,
    canvasRef,
    currentStep: wizardStep,
    onStepChange: setWizardStep,
    onRemoveBackground: handleRemoveBackground,
    isRemovingBackground,
    cutlineVisibility,
    onCutlineVisibilityChange: setCutlineVisibility,
    hasOriginalImage: !!originalImageBeforeBgRemoval,
    showOriginalImage,
    onToggleOriginalImage: handleToggleOriginalImage,
    embedStickerOptions,
    onClearImage: handleClearImage,
    isEmbedMode,
    embedParentOrigin,
    embedReturnUrl,
    customerId,
    customerEmail,
    productHandle,
    variantId,
    variants,
    shopDomain,
    detectedAlgorithm,
    shopStickerSettings,
  };

  if (wizardStep <= 2) {
    return (
      <div>
        <ControlsSection {...controlsProps} fullWidth />

        {isProcessing && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 max-w-sm mx-4">
              <div className="flex items-center space-x-3">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#1B2A4A]"></div>
                <div className="text-gray-700">
                  <div className="font-medium">{t("dieCut.processingImage")}</div>
                  <div className="text-sm text-gray-500 mt-1">{t("dieCut.processingDescription")}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6">
      {/* Left sidebar - Controls (wizard steps) */}
      <div className="lg:col-span-4 xl:col-span-3 order-2 lg:order-1">
        <div className="lg:sticky lg:top-4">
          <ControlsSection {...controlsProps} />
        </div>
      </div>

      {/* Right side - Preview (main area) */}
      <div className="lg:col-span-8 xl:col-span-9 order-1 lg:order-2">
        <div className="relative preview-container">
          <PreviewSection
            ref={canvasRef}
            imageInfo={showOriginalImage && originalImageBeforeBgRemoval ? originalImageBeforeBgRemoval : imageInfo}
            strokeSettings={debouncedStrokeSettings}
            resizeSettings={debouncedResizeSettings}
            shapeSettings={debouncedShapeSettings}
            cadCutBounds={cadCutBounds}
            isEmbedMode={isEmbedMode}
            cutlineVisibility={cutlineVisibility}
            fitTrigger={fitTrigger}
            onDetectedAlgorithmChange={setDetectedAlgorithm}
          />
        </div>
      </div>

      {/* Processing Modal */}
      {isProcessing && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 max-w-sm mx-4">
            <div className="flex items-center space-x-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#1B2A4A]"></div>
              <div className="text-gray-700">
                <div className="font-medium">{t("dieCut.processingImage")}</div>
                <div className="text-sm text-gray-500 mt-1">
                  {t("dieCut.processingDescription")}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
