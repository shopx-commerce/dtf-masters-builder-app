import {
  useEffect,
  useLayoutEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useState,
  useCallback,
} from "react";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  ImageIcon,
  Loader2,
  Maximize2,
  Check,
  Link2,
  Unlink2,
  Undo2,
  Redo2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import {
  ImageInfo,
  StrokeSettings,
  ResizeSettings,
  ShapeSettings,
  CutlineVisibility,
} from "./image-editor";
import { CadCutBounds } from "@/lib/cadcut-bounds";
import {
  processContourInWorker,
  ContourData,
  DetectedAlgorithm,
} from "@/lib/contour-worker-manager";
import { calculateShapeDimensions } from "@/lib/shape-outline";
import { cropImageToContent, getImageBounds } from "./image-crop";
import { useLanguage } from "@/lib/i18n";

interface PreviewSectionProps {
  imageInfo: ImageInfo | null;
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  cadCutBounds?: CadCutBounds | null;
  isEmbedMode?: boolean;
  onClearImage?: () => void;
  cutlineVisibility?: CutlineVisibility;
  fitTrigger?: number;
  onDetectedAlgorithmChange?: (algorithm: DetectedAlgorithm | undefined) => void;
  onResizeChange?: (settings: Partial<ResizeSettings>) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
}

function InchInput({ value, onCommit, min = 0.5, max = 50, className }: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  className?: string;
}) {
  const [localValue, setLocalValue] = useState(value.toFixed(2));
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!isFocused) setLocalValue(value.toFixed(2));
  }, [value, isFocused]);

  const commit = () => {
    const parsed = parseFloat(localValue);
    if (!isNaN(parsed) && parsed >= min && parsed <= max) {
      onCommit(parsed);
    } else {
      setLocalValue(value.toFixed(2));
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={localValue}
      onChange={(e) => {
        const raw = e.target.value;
        if (/^[0-9]*\.?[0-9]*$/.test(raw)) setLocalValue(raw);
      }}
      onFocus={() => setIsFocused(true)}
      onBlur={() => { setIsFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
      className={className}
    />
  );
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  (
    {
      imageInfo,
      strokeSettings,
      resizeSettings,
      shapeSettings,
      cadCutBounds,
      isEmbedMode = false,
      onClearImage,
      cutlineVisibility = 'normal',
      fitTrigger = 0,
      onDetectedAlgorithmChange,
      onResizeChange,
      onUndo,
      onRedo,
      canUndo = false,
      canRedo = false,
    },
    ref,
  ) => {
    const { t } = useLanguage();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(0.95);
    const [panX, setPanX] = useState(0); // -100 to 100 (percent offset)
    const [panY, setPanY] = useState(0); // -100 to 100 (percent offset)
    const [backgroundColor, setBackgroundColor] = useState("transparent");
    const lastImageRef = useRef<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(0);
    const contourCacheRef = useRef<{
      key: string;
      canvas: HTMLCanvasElement;
      contourData?: ContourData;
      detectedAlgorithm?: DetectedAlgorithm;
    } | null>(null);
    const processingIdRef = useRef(0);
    const imageRevisionRef = useRef(0);
    const [imageRevision, setImageRevision] = useState(0);
    const [showHighlight, setShowHighlight] = useState(false);
    const lastSettingsRef = useRef<string>("");
    const contourDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    const getCutlineParams = useCallback(() => {
      const params = {
        thin: { lineWidth: 0.8, dashPattern: [3, 3] as [number, number], solidWidth: 1 },
        normal: { lineWidth: 1.5, dashPattern: [5, 3] as [number, number], solidWidth: 2 },
        bold: { lineWidth: 3, dashPattern: [7, 4] as [number, number], solidWidth: 3 },
      };
      return params[cutlineVisibility] || params.normal;
    }, [cutlineVisibility]);

    // Marching ants animation state
    const [dashOffset, setDashOffset] = useState(0);
    const animationFrameRef = useRef<number | null>(null);

    // Marching ants animation loop
    useEffect(() => {
      const hasCutPath = strokeSettings.enabled || shapeSettings.enabled;
      if (!hasCutPath || !imageInfo) {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
          animationFrameRef.current = null;
        }
        return;
      }

      let lastTime = 0;
      const animationSpeed = 30; // pixels per second

      const animate = (currentTime: number) => {
        if (lastTime === 0) lastTime = currentTime;
        const deltaTime = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        setDashOffset((prev) => (prev + animationSpeed * deltaTime) % 20);
        animationFrameRef.current = requestAnimationFrame(animate);
      };

      animationFrameRef.current = requestAnimationFrame(animate);

      return () => {
        if (animationFrameRef.current) {
          cancelAnimationFrame(animationFrameRef.current);
        }
      };
    }, [strokeSettings.enabled, shapeSettings.enabled, imageInfo]);

    // Drag-to-pan state
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{
      x: number;
      y: number;
      panX: number;
      panY: number;
    } | null>(null);

    // Drag-to-pan handlers
    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        if (zoom === 1) return; // Only allow panning when zoomed
        e.preventDefault();
        setIsDragging(true);
        dragStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          panX,
          panY,
        };
      },
      [zoom, panX, panY],
    );

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        if (!isDragging || !dragStartRef.current) return;

        const deltaX = e.clientX - dragStartRef.current.x;
        const deltaY = e.clientY - dragStartRef.current.y;

        // Convert pixel movement to pan percentage (400px canvas = 100%)
        const sensitivity = 0.6; // Increased 20% for faster panning
        const newPanX = Math.max(
          -100,
          Math.min(100, dragStartRef.current.panX + deltaX * sensitivity),
        );
        const newPanY = Math.max(
          -100,
          Math.min(100, dragStartRef.current.panY + deltaY * sensitivity),
        );

        setPanX(newPanX);
        setPanY(newPanY);
      },
      [isDragging],
    );

    const handleMouseUp = useCallback(() => {
      setIsDragging(false);
      dragStartRef.current = null;
    }, []);

    const handleMouseLeave = useCallback(() => {
      if (isDragging) {
        setIsDragging(false);
        dragStartRef.current = null;
      }
    }, [isDragging]);

    // Touch handlers for mobile pan
    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        if (zoom === 1 || e.touches.length !== 1) return;
        e.preventDefault(); // Prevent scroll interference when zoomed
        const touch = e.touches[0];
        setIsDragging(true);
        dragStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          panX,
          panY,
        };
      },
      [zoom, panX, panY],
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        if (!isDragging || !dragStartRef.current || e.touches.length !== 1)
          return;
        e.preventDefault(); // Prevent scrolling while panning
        const touch = e.touches[0];

        const deltaX = touch.clientX - dragStartRef.current.x;
        const deltaY = touch.clientY - dragStartRef.current.y;

        // Reduced sensitivity for mobile (50% of desktop) for more precise control
        const sensitivity = 0.3;
        const newPanX = Math.max(
          -100,
          Math.min(100, dragStartRef.current.panX + deltaX * sensitivity),
        );
        const newPanY = Math.max(
          -100,
          Math.min(100, dragStartRef.current.panY + deltaY * sensitivity),
        );

        setPanX(newPanX);
        setPanY(newPanY);
      },
      [isDragging],
    );

    const handleTouchEnd = useCallback(() => {
      setIsDragging(false);
      dragStartRef.current = null;
    }, []);

    // Fit to View: calculate zoom to fit canvas within container and reset pan
    const fitToView = useCallback(() => {
      if (!containerRef.current) return;
      const containerWidth = containerRef.current.clientWidth - 40; // padding
      const containerHeight = containerRef.current.clientHeight - 40;
      const canvasSize = 400; // fixed canvas size
      const scaleX = containerWidth / canvasSize;
      const scaleY = containerHeight / canvasSize;
      const fitZoom = Math.min(scaleX, scaleY, 1); // max at 100%
      setZoom(Math.max(0.2, Math.round(fitZoom * 20) / 20)); // round to 5% steps
      setPanX(0);
      setPanY(0);
    }, []);

    // Reset view to default zoom and pan
    const resetView = useCallback(() => {
      setZoom(1);
      setPanX(0);
      setPanY(0);
    }, []);

    // Mouse wheel zoom handler
    const handleWheel = useCallback((e: React.WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((prev) => Math.max(0.2, Math.min(3, prev + delta)));
    }, []);

    // Auto-set zoom to 75% for images with no empty space around them
    useEffect(() => {
      if (!imageInfo) {
        lastImageRef.current = null;
        return;
      }

      // Only check when image changes
      const imageKey = `${imageInfo.image.src}-${imageInfo.image.width}-${imageInfo.image.height}`;
      if (lastImageRef.current === imageKey) return;
      lastImageRef.current = imageKey;

      // Check if image has minimal empty space around the edges
      const hasMinimalEmptySpace = checkImageHasMinimalEmptySpace(
        imageInfo.image,
      );
      if (hasMinimalEmptySpace) {
        setZoom(0.75);
      } else {
        setZoom(1);
      }
    }, [imageInfo]);

    const fitTriggerRef = useRef(fitTrigger);
    useEffect(() => {
      if (fitTrigger > 0 && fitTrigger !== fitTriggerRef.current) {
        fitTriggerRef.current = fitTrigger;
        fitToView();
      }
    }, [fitTrigger, fitToView]);

    // Check if image content extends close to the edges (minimal empty space)
    const checkImageHasMinimalEmptySpace = (
      image: HTMLImageElement,
    ): boolean => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return false;

        canvas.width = image.width;
        canvas.height = image.height;
        ctx.drawImage(image, 0, 0);

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;

        // Check edges for content - if content is within 5% of any edge, it's "no empty space"
        const margin = Math.max(
          5,
          Math.floor(Math.min(canvas.width, canvas.height) * 0.05),
        );

        let hasContentNearTop = false;
        let hasContentNearBottom = false;
        let hasContentNearLeft = false;
        let hasContentNearRight = false;

        // Sample pixels near edges (every 10th pixel for performance)
        const step = 10;

        // Check top edge
        for (let y = 0; y < margin && !hasContentNearTop; y++) {
          for (let x = 0; x < canvas.width; x += step) {
            const idx = (y * canvas.width + x) * 4;
            if (data[idx + 3] > 128) {
              // Alpha > 128
              hasContentNearTop = true;
              break;
            }
          }
        }

        // Check bottom edge
        for (
          let y = canvas.height - margin;
          y < canvas.height && !hasContentNearBottom;
          y++
        ) {
          for (let x = 0; x < canvas.width; x += step) {
            const idx = (y * canvas.width + x) * 4;
            if (data[idx + 3] > 128) {
              hasContentNearBottom = true;
              break;
            }
          }
        }

        // Check left edge
        for (let x = 0; x < margin && !hasContentNearLeft; x++) {
          for (let y = 0; y < canvas.height; y += step) {
            const idx = (y * canvas.width + x) * 4;
            if (data[idx + 3] > 128) {
              hasContentNearLeft = true;
              break;
            }
          }
        }

        // Check right edge
        for (
          let x = canvas.width - margin;
          x < canvas.width && !hasContentNearRight;
          x++
        ) {
          for (let y = 0; y < canvas.height; y += step) {
            const idx = (y * canvas.width + x) * 4;
            if (data[idx + 3] > 128) {
              hasContentNearRight = true;
              break;
            }
          }
        }

        // If content is near 3+ edges, consider it "no empty space"
        const edgesWithContent = [
          hasContentNearTop,
          hasContentNearBottom,
          hasContentNearLeft,
          hasContentNearRight,
        ].filter(Boolean).length;
        return edgesWithContent >= 3;
      } catch {
        return false;
      }
    };

    const getColorName = (color: string) => {
      const colorMap: Record<string, string> = {
        transparent: "Transparent",
        "#ffffff": "White",
        "#000000": "Black",
        "#f3f4f6": "Light Gray",
        "#1f2937": "Dark Gray",
        "#3b82f6": "Blue",
        "#ef4444": "Red",
        "#10b981": "Green",
      };
      return colorMap[color] || color;
    };

    useImperativeHandle(ref, () => canvasRef.current!, []);

    useEffect(() => {
      imageRevisionRef.current++;
      contourCacheRef.current = null;
      setImageRevision(imageRevisionRef.current);
    }, [imageInfo]);

    // Version bump forces cache invalidation when worker code changes
    const CONTOUR_CACHE_VERSION = 5;
    const generateContourCacheKey = useCallback(() => {
      if (!imageInfo) return "";
      return `v${CONTOUR_CACHE_VERSION}-rev${imageRevision}-${strokeSettings.width}-${strokeSettings.alphaThreshold}-${strokeSettings.autoBridging}-${strokeSettings.autoBridgingThreshold}-${strokeSettings.cornerMode}-${strokeSettings.backgroundColor}-${resizeSettings.widthInches}-${resizeSettings.heightInches}`;
    }, [
      imageInfo,
      imageRevision,
      strokeSettings.width,
      strokeSettings.alphaThreshold,
      strokeSettings.autoBridging,
      strokeSettings.autoBridgingThreshold,
      strokeSettings.cornerMode,
      strokeSettings.backgroundColor,
      resizeSettings.widthInches,
      resizeSettings.heightInches,
    ]);

    useEffect(() => {
      // Clear any pending debounce
      if (contourDebounceRef.current) {
        clearTimeout(contourDebounceRef.current);
        contourDebounceRef.current = null;
      }

      if (!imageInfo || !strokeSettings.enabled || shapeSettings.enabled) {
        contourCacheRef.current = null;
        return;
      }

      const cacheKey = generateContourCacheKey();
      if (contourCacheRef.current?.key === cacheKey) return;
      // Debounce processing to avoid rapid re-renders during slider drags
      contourDebounceRef.current = setTimeout(() => {
        const currentId = ++processingIdRef.current;
        setIsProcessing(true);
        setProcessingProgress(0);

        const previewStrokeSettings = { ...strokeSettings, color: "#FF00FF" };
        const workerResizeSettings = {
          widthInches: resizeSettings.widthInches,
          heightInches: resizeSettings.heightInches,
          maintainAspectRatio: resizeSettings.maintainAspectRatio,
          outputDPI: 100,
        };

        processContourInWorker(
          imageInfo.image,
          previewStrokeSettings,
          workerResizeSettings,
          (progress) => {
            if (processingIdRef.current === currentId) {
              setProcessingProgress(progress);
            }
          },
        )
          .then((result) => {
            if (processingIdRef.current === currentId) {
              contourCacheRef.current = {
                key: cacheKey,
                canvas: result.canvas,
                contourData: result.contourData,
                detectedAlgorithm: result.detectedAlgorithm,
              };
              onDetectedAlgorithmChange?.(result.detectedAlgorithm);
              setIsProcessing(false);
            }
          })
          .catch((error) => {
            console.error("Contour processing error:", error);
            if (processingIdRef.current === currentId) {
              setIsProcessing(false);
            }
          });
      }, 100); // 100ms debounce for smoother slider interaction

      return () => {
        if (contourDebounceRef.current) {
          clearTimeout(contourDebounceRef.current);
        }
      };
    }, [
      imageInfo,
      imageRevision,
      strokeSettings,
      resizeSettings,
      shapeSettings.enabled,
      generateContourCacheKey,
    ]);

    useEffect(() => {
      if (!canvasRef.current || !imageInfo) return;

      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const baseSize = 400;
      canvas.width = baseSize;
      canvas.height = baseSize;

      if (backgroundColor === "transparent") {
        // Draw transparency grid pattern (light grey checkerboard)
        const gridSize = 10;
        const lightColor = "#e8e8e8";
        const darkColor = "#d0d0d0";

        for (let y = 0; y < canvas.height; y += gridSize) {
          for (let x = 0; x < canvas.width; x += gridSize) {
            const isEven = (x / gridSize + y / gridSize) % 2 === 0;
            ctx.fillStyle = isEven ? lightColor : darkColor;
            ctx.fillRect(x, y, gridSize, gridSize);
          }
        }
      } else {
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      if (shapeSettings.enabled) {
        drawShapePreview(ctx, canvas.width, canvas.height);
      } else {
        drawImageWithResizePreview(ctx, canvas.width, canvas.height);
      }
    }, [
      imageInfo,
      strokeSettings,
      resizeSettings,
      shapeSettings,
      cadCutBounds,
      backgroundColor,
      isProcessing,
      dashOffset,
      cutlineVisibility,
    ]);

    useEffect(() => {
      if (!imageInfo) return;
      const settingsKey = `${strokeSettings.enabled}-${strokeSettings.width}-${shapeSettings.enabled}-${shapeSettings.type}-${resizeSettings.widthInches}`;
      if (lastSettingsRef.current && lastSettingsRef.current !== settingsKey) {
        setShowHighlight(true);
        const timer = setTimeout(() => setShowHighlight(false), 500);
        return () => clearTimeout(timer);
      }
      lastSettingsRef.current = settingsKey;
    }, [
      imageInfo,
      strokeSettings.enabled,
      strokeSettings.width,
      shapeSettings.enabled,
      shapeSettings.type,
      resizeSettings.widthInches,
    ]);

    const drawShapePreview = (
      ctx: CanvasRenderingContext2D,
      canvasWidth: number,
      canvasHeight: number,
    ) => {
      if (!imageInfo) return;

      const shapeDims = calculateShapeDimensions(
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        shapeSettings.type,
        shapeSettings.offset,
      );

      const bleedInches = 0.1; // 0.10" bleed around the shape
      const padding = 40;
      const availableWidth = canvasWidth - padding * 2;
      const availableHeight = canvasHeight - padding * 2;
      const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;

      let shapeWidth, shapeHeight;
      if (shapeAspect > availableWidth / availableHeight) {
        shapeWidth = availableWidth;
        shapeHeight = availableWidth / shapeAspect;
      } else {
        shapeHeight = availableHeight;
        shapeWidth = availableHeight * shapeAspect;
      }

      const shapeX = (canvasWidth - shapeWidth) / 2;
      const shapeY = (canvasHeight - shapeHeight) / 2;

      // Calculate bleed in pixels based on shape scale
      const shapePixelsPerInch = Math.min(
        shapeWidth / shapeDims.widthInches,
        shapeHeight / shapeDims.heightInches,
      );
      const bleedPixels = bleedInches * shapePixelsPerInch;

      // Draw background with bleed (larger shape for the fill)
      ctx.fillStyle = shapeSettings.fillColor;
      ctx.beginPath();

      const cornerRadiusPixels =
        (shapeSettings.cornerRadius || 0.25) * shapePixelsPerInch;

      if (shapeSettings.type === "circle") {
        const radius = Math.min(shapeWidth, shapeHeight) / 2 + bleedPixels;
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      } else if (shapeSettings.type === "oval") {
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        const radiusX = shapeWidth / 2 + bleedPixels;
        const radiusY = shapeHeight / 2 + bleedPixels;
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      } else if (shapeSettings.type === "square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2 - bleedPixels;
        const startY = shapeY + (shapeHeight - size) / 2 - bleedPixels;
        ctx.rect(
          startX,
          startY,
          size + bleedPixels * 2,
          size + bleedPixels * 2,
        );
      } else if (shapeSettings.type === "rounded-square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2 - bleedPixels;
        const startY = shapeY + (shapeHeight - size) / 2 - bleedPixels;
        ctx.roundRect(
          startX,
          startY,
          size + bleedPixels * 2,
          size + bleedPixels * 2,
          cornerRadiusPixels,
        );
      } else if (shapeSettings.type === "rounded-rectangle") {
        ctx.roundRect(
          shapeX - bleedPixels,
          shapeY - bleedPixels,
          shapeWidth + bleedPixels * 2,
          shapeHeight + bleedPixels * 2,
          cornerRadiusPixels,
        );
      } else {
        ctx.rect(
          shapeX - bleedPixels,
          shapeY - bleedPixels,
          shapeWidth + bleedPixels * 2,
          shapeHeight + bleedPixels * 2,
        );
      }

      ctx.fill();

      const cutParams = getCutlineParams();
      ctx.strokeStyle = "#FF00FF";
      ctx.lineWidth = cutParams.solidWidth;
      ctx.beginPath();

      if (shapeSettings.type === "circle") {
        const radius = Math.min(shapeWidth, shapeHeight) / 2;
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      } else if (shapeSettings.type === "oval") {
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        const radiusX = shapeWidth / 2;
        const radiusY = shapeHeight / 2;
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      } else if (shapeSettings.type === "square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.rect(startX, startY, size, size);
      } else if (shapeSettings.type === "rounded-square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.roundRect(startX, startY, size, size, cornerRadiusPixels);
      } else if (shapeSettings.type === "rounded-rectangle") {
        ctx.roundRect(
          shapeX,
          shapeY,
          shapeWidth,
          shapeHeight,
          cornerRadiusPixels,
        );
      } else {
        ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
      }

      ctx.stroke();

      ctx.save();
      ctx.setLineDash(cutParams.dashPattern);
      ctx.lineDashOffset = -dashOffset;
      ctx.strokeStyle = "#9333EA";
      ctx.lineWidth = cutParams.lineWidth;
      ctx.stroke();
      ctx.lineDashOffset = -dashOffset + cutParams.dashPattern[0];
      ctx.strokeStyle = "#FFFFFF";
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      const croppedCanvas = cropImageToContent(imageInfo.image);
      const sourceImage = croppedCanvas ? croppedCanvas : imageInfo.image;

      // Reuse shapePixelsPerInch from above for image sizing
      let imageWidth = resizeSettings.widthInches * shapePixelsPerInch;
      let imageHeight = resizeSettings.heightInches * shapePixelsPerInch;

      const imageX = shapeX + (shapeWidth - imageWidth) / 2;
      const imageY = shapeY + (shapeHeight - imageHeight) / 2;

      ctx.save();
      ctx.beginPath();

      if (shapeSettings.type === "circle") {
        const radius = Math.min(shapeWidth, shapeHeight) / 2;
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      } else if (shapeSettings.type === "oval") {
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        const radiusX = shapeWidth / 2;
        const radiusY = shapeHeight / 2;
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      } else if (shapeSettings.type === "square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.rect(startX, startY, size, size);
      } else if (shapeSettings.type === "rounded-square") {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.roundRect(startX, startY, size, size, cornerRadiusPixels);
      } else if (shapeSettings.type === "rounded-rectangle") {
        ctx.roundRect(
          shapeX,
          shapeY,
          shapeWidth,
          shapeHeight,
          cornerRadiusPixels,
        );
      } else {
        ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
      }

      ctx.clip();
      ctx.drawImage(sourceImage, imageX, imageY, imageWidth, imageHeight);
      ctx.restore();
    };

    const drawImageWithResizePreview = (
      ctx: CanvasRenderingContext2D,
      canvasWidth: number,
      canvasHeight: number,
    ) => {
      if (!imageInfo) return;

      const viewPadding = 40;
      const availableWidth = canvasWidth - viewPadding * 2;
      const availableHeight = canvasHeight - viewPadding * 2;

      if (
        strokeSettings.enabled &&
        contourCacheRef.current?.canvas &&
        !isProcessing
      ) {
        const contourCanvas = contourCacheRef.current.canvas;
        const contourData = contourCacheRef.current.contourData;

        const contourAspectRatio = contourCanvas.width / contourCanvas.height;

        let contourWidth, contourHeight;
        if (contourAspectRatio > availableWidth / availableHeight) {
          contourWidth = availableWidth;
          contourHeight = availableWidth / contourAspectRatio;
        } else {
          contourHeight = availableHeight;
          contourWidth = availableHeight * contourAspectRatio;
        }

        const contourX = (canvasWidth - contourWidth) / 2;
        const contourY = (canvasHeight - contourHeight) / 2;

        // Draw the main contour
        ctx.drawImage(
          contourCanvas,
          contourX,
          contourY,
          contourWidth,
          contourHeight,
        );

        const allPaths = contourData?.allPreviewPathPoints && contourData.allPreviewPathPoints.length > 0
          ? contourData.allPreviewPathPoints
          : (contourData?.previewPathPoints && contourData.previewPathPoints.length > 2
              ? [contourData.previewPathPoints]
              : []);

        if (allPaths.length > 0) {
          const displayScaleX = contourWidth / contourCanvas.width;
          const displayScaleY = contourHeight / contourCanvas.height;

          const contourCutParams = getCutlineParams();
          ctx.save();

          ctx.setLineDash(contourCutParams.dashPattern);
          ctx.lineDashOffset = -dashOffset;
          ctx.strokeStyle = "#9333EA";
          ctx.lineWidth = contourCutParams.lineWidth;

          for (const path of allPaths) {
            if (path.length < 2) continue;
            ctx.beginPath();
            // Draw as a polyline directly through the previewPathPoints.  The
            // path is already Chaikin-subdivided and Clipper-welded in the worker
            // so it is smooth.  Do NOT apply gaussianSmoothContour here: it shifts
            // every point toward the mean of its neighbours, pulling the closed
            // contour inward and causing the ants to appear inside the pink cut line.
            ctx.moveTo(contourX + path[0].x * displayScaleX, contourY + path[0].y * displayScaleY);
            for (let si = 1; si < path.length; si++) {
              ctx.lineTo(contourX + path[si].x * displayScaleX, contourY + path[si].y * displayScaleY);
            }
            ctx.closePath();
            ctx.stroke();
          }

          ctx.setLineDash(contourCutParams.dashPattern);
          ctx.lineDashOffset = -dashOffset + contourCutParams.dashPattern[0];
          ctx.strokeStyle = "#FFFFFF";
          for (const path of allPaths) {
            if (path.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(contourX + path[0].x * displayScaleX, contourY + path[0].y * displayScaleY);
            for (let si = 1; si < path.length; si++) {
              ctx.lineTo(contourX + path[si].x * displayScaleX, contourY + path[si].y * displayScaleY);
            }
            ctx.closePath();
            ctx.stroke();
          }

          ctx.setLineDash([]);
          ctx.restore();
        }
      } else {
        const aspectRatio = imageInfo.image.width / imageInfo.image.height;
        let displayWidth, displayHeight;
        if (aspectRatio > availableWidth / availableHeight) {
          displayWidth = availableWidth;
          displayHeight = availableWidth / aspectRatio;
        } else {
          displayHeight = availableHeight;
          displayWidth = availableHeight * aspectRatio;
        }

        const displayX = (canvasWidth - displayWidth) / 2;
        const displayY = (canvasHeight - displayHeight) / 2;

        ctx.drawImage(
          imageInfo.image,
          displayX,
          displayY,
          displayWidth,
          displayHeight,
        );
      }
    };

    const getBackgroundStyle = () => {
      if (backgroundColor === "transparent") {
        return "checkerboard";
      }
      return "";
    };

    const getBackgroundColor = () => {
      if (backgroundColor === "transparent") {
        return "transparent";
      }
      return backgroundColor;
    };

    const BG_SWATCHES = [
      { value: "transparent", label: t("dieCut.preview.transparent") },
      { value: "#ffffff", label: t("dieCut.preview.white") },
      { value: "#f3f4f6", label: t("dieCut.preview.lightGray") },
      { value: "#9ca3af", label: t("dieCut.preview.gray") },
      { value: "#1f2937", label: t("dieCut.preview.darkGray") },
      { value: "#000000", label: t("dieCut.preview.black") },
    ];

    return (
      <div className="lg:col-span-1">
        <Card className="shadow-2xl border-0 overflow-hidden" style={{ backgroundColor: "#FFFFFF", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
          <CardContent className="p-5">
            {/* Top toolbar: inline W/H inputs + lock + size preset + undo/redo + bg swatches */}
            <div className="mb-3 flex items-center gap-1.5 flex-wrap">
              {imageInfo && onResizeChange && (
                <div className="flex items-center gap-1 min-w-0 flex-shrink-0">
                  <span className="text-[10px] text-gray-400 font-medium">W</span>
                  <InchInput
                    value={resizeSettings.widthInches}
                    onCommit={(v) => onResizeChange({ widthInches: v })}
                    className="w-[46px] text-[11px] font-semibold text-gray-700 text-center bg-gray-50 border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                  />
                  <span className="text-[10px] text-gray-400">"</span>
                  <button
                    onClick={() => onResizeChange({ maintainAspectRatio: !resizeSettings.maintainAspectRatio })}
                    className={`p-0.5 rounded transition-colors ${resizeSettings.maintainAspectRatio ? 'text-indigo-500 hover:text-indigo-600' : 'text-gray-300 hover:text-gray-400'}`}
                    title={resizeSettings.maintainAspectRatio ? t("dieCut.preview.unlockRatio") : t("dieCut.preview.lockRatio")}
                  >
                    {resizeSettings.maintainAspectRatio ? <Link2 size={12} /> : <Unlink2 size={12} />}
                  </button>
                  <span className="text-[10px] text-gray-400 font-medium">H</span>
                  <InchInput
                    value={resizeSettings.heightInches}
                    onCommit={(v) => onResizeChange({ heightInches: v })}
                    className="w-[46px] text-[11px] font-semibold text-gray-700 text-center bg-gray-50 border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300"
                  />
                  <span className="text-[10px] text-gray-400">"</span>
                  <div className="relative ml-1">
                    <select
                      className="appearance-none text-[11px] font-semibold text-white bg-gradient-to-r from-indigo-500 to-violet-500 rounded-md pl-2 pr-5 py-1 cursor-pointer hover:from-indigo-400 hover:to-violet-400 transition-all focus:outline-none focus:ring-2 focus:ring-indigo-300 shadow-sm"
                      value=""
                      onChange={(e) => {
                        const longest = parseFloat(e.target.value);
                        if (!longest || !imageInfo) return;
                        const isWider = imageInfo.originalWidth >= imageInfo.originalHeight;
                        if (isWider) {
                          onResizeChange({ widthInches: longest });
                        } else {
                          onResizeChange({ heightInches: longest });
                        }
                      }}
                    >
                      <option value="" disabled className="text-gray-700 bg-white">{t("dieCut.preview.size")}</option>
                      {[2, 3, 4, 5, 6, 8, 10].map(size => (
                        <option key={size} value={size} className="text-gray-700 bg-white">{t("dieCut.preview.sticker", { size })}</option>
                      ))}
                    </select>
                    <svg className="absolute right-1 top-1/2 -translate-y-1/2 w-3 h-3 text-white/70 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-0.5 flex-shrink-0">
                <button
                  onClick={onUndo}
                  disabled={!canUndo}
                  className={`p-1 rounded transition-colors ${canUndo ? 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50' : 'text-gray-200 cursor-default'}`}
                  title={t("editor.undoShort")}
                >
                  <Undo2 size={13} />
                </button>
                <button
                  onClick={onRedo}
                  disabled={!canRedo}
                  className={`p-1 rounded transition-colors ${canRedo ? 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50' : 'text-gray-200 cursor-default'}`}
                  title={t("editor.redoShort")}
                >
                  <Redo2 size={13} />
                </button>
              </div>
              <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                <span className="text-[10px] text-gray-400 font-medium hidden sm:inline">{t("dieCut.preview.background")}</span>
                {BG_SWATCHES.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setBackgroundColor(opt.value)}
                    title={opt.label}
                    className={`w-5 h-5 rounded-full border-2 transition-all flex-shrink-0 ${
                      backgroundColor === opt.value
                        ? 'border-cyan-400 scale-110 shadow-sm'
                        : 'border-gray-200 hover:border-gray-300'
                    } ${opt.value === 'transparent' ? 'checkerboard' : ''}`}
                    style={opt.value !== 'transparent' ? { backgroundColor: opt.value } : undefined}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div
                ref={containerRef}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                className={`relative flex items-center justify-center ${getBackgroundStyle()} ${zoom !== 1 ? (isDragging ? "cursor-grabbing" : "cursor-grab") : "cursor-zoom-in"} flex-1 transition-all duration-300 ${showHighlight ? "ring-4 ring-cyan-400 ring-opacity-75" : ""} rounded-lg border border-gray-600/50`}
                style={{
                  height: "400px",
                  backgroundColor: getBackgroundColor(),
                  overflow: "hidden",
                  userSelect: "none",
                  touchAction: zoom !== 1 ? "none" : "auto",
                }}
              >
                <canvas
                  ref={canvasRef}
                  className="relative z-10 block"
                  style={{
                    width: "400px",
                    height: "400px",
                    maxWidth: "400px",
                    maxHeight: "400px",
                    transform: `translate(${panX}%, ${panY}%) scale(${zoom})`,
                    transformOrigin: "center",
                    filter: imageInfo ? "drop-shadow(0 8px 25px rgba(0,0,0,0.35))" : "none",
                  }}
                />

                {!imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500 mb-4">
                        {t("dieCut.preview.uploadPrompt")}
                      </p>
                      <p className="preview-coming-text text-2xl font-extrabold tracking-wide">
                        {t("dieCut.previewComing")}
                      </p>
                    </div>
                  </div>
                )}

                {isProcessing && imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-white mx-auto mb-2 animate-spin" />
                      <p className="text-white text-sm">
                        {t("dieCut.preview.processing", { percent: processingProgress })}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {zoom !== 1 && (
                <div
                  className="hidden md:flex w-3 flex-col"
                  style={{ height: "400px" }}
                >
                  <div
                    className="flex-1 bg-gray-700/50 rounded-full relative cursor-pointer"
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const y = (e.clientY - rect.top) / rect.height;
                      setPanY(100 - y * 200);
                    }}
                  >
                    <div
                      className="absolute left-0 right-0 h-8 bg-gray-400 hover:bg-gray-300 rounded-full transition-colors"
                      style={{
                        top: `${((100 - panY) / 200) * 100}%`,
                        transform: "translateY(-50%)",
                      }}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        const startY = e.clientY;
                        const startPan = panY;
                        const parent = e.currentTarget.parentElement!;
                        const height = parent.getBoundingClientRect().height;

                        const onMove = (ev: MouseEvent) => {
                          const delta = ((ev.clientY - startY) / height) * 200;
                          setPanY(
                            Math.max(-100, Math.min(100, startPan - delta)),
                          );
                        };
                        const onUp = () => {
                          document.removeEventListener("mousemove", onMove);
                          document.removeEventListener("mouseup", onUp);
                        };
                        document.addEventListener("mousemove", onMove);
                        document.addEventListener("mouseup", onUp);
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            {zoom !== 1 && (
              <div className="hidden md:flex h-3 mt-1">
                <div
                  className="flex-1 bg-gray-700/50 rounded-full relative cursor-pointer"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = (e.clientX - rect.left) / rect.width;
                    setPanX(x * 200 - 100);
                  }}
                >
                  <div
                    className="absolute top-0 bottom-0 w-12 bg-gray-400 hover:bg-gray-300 rounded-full transition-colors"
                    style={{
                      left: `${((panX + 100) / 200) * 100}%`,
                      transform: "translateX(-50%)",
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      const startX = e.clientX;
                      const startPan = panX;
                      const parent = e.currentTarget.parentElement!;
                      const width = parent.getBoundingClientRect().width;

                      const onMove = (ev: MouseEvent) => {
                        const delta = ((ev.clientX - startX) / width) * 200;
                        setPanX(
                          Math.max(-100, Math.min(100, startPan + delta)),
                        );
                      };
                      const onUp = () => {
                        document.removeEventListener("mousemove", onMove);
                        document.removeEventListener("mouseup", onUp);
                      };
                      document.addEventListener("mousemove", onMove);
                      document.addEventListener("mouseup", onUp);
                    }}
                  />
                </div>
                <div className="w-3" />
              </div>
            )}

            {imageInfo && (strokeSettings.enabled || shapeSettings.enabled) && (
              <div className="mt-2 flex items-center justify-center gap-2">
                {isProcessing ? (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1" style={{ backgroundColor: "#FFF7ED", color: "#EA580C", border: "1px solid #FDBA74" }}>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t("dieCut.preview.updatingCutline")}
                  </span>
                ) : (
                  <span className="text-[10px] font-medium px-2 py-0.5 rounded-full flex items-center gap-1" style={{ backgroundColor: "#F0FDF4", color: "#16A34A", border: "1px solid #BBF7D0" }}>
                    <Check className="w-3 h-3" />
                    {t("dieCut.preview.cutlineReady")}
                  </span>
                )}
              </div>
            )}

            <div className="mt-3">
                <div className="flex items-center justify-center gap-1">
                  <button
                    onClick={() => setZoom((prev) => Math.max(prev - 0.1, 0.2))}
                    className="h-7 w-7 flex items-center justify-center rounded-md transition-all text-sm"
                    style={{ backgroundColor: "#F1F5F9", border: "1px solid #CBD5E1", color: "#6B7280" }}
                    title={t("preview.zoomOut")}
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </button>

                  <span className="text-xs min-w-[40px] text-center font-bold" style={{ color: "#64748B" }}>
                    {Math.round(zoom * 100)}%
                  </span>

                  <button
                    onClick={() => setZoom((prev) => Math.min(prev + 0.1, 3))}
                    className="h-7 w-7 flex items-center justify-center rounded-md transition-all text-sm"
                    style={{ backgroundColor: "#F1F5F9", border: "1px solid #CBD5E1", color: "#6B7280" }}
                    title={t("preview.zoomIn")}
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </button>

                  <div className="w-px h-5 mx-1.5" style={{ backgroundColor: "#CBD5E1" }} />

                  <button
                    onClick={fitToView}
                    className="h-7 px-2 flex items-center gap-1 rounded-md transition-all text-[11px] font-bold"
                    style={{ backgroundColor: "#F1F5F9", border: "1px solid #CBD5E1", color: "#6B7280" }}
                    title={t("preview.fitToView")}
                  >
                    <Maximize2 className="h-3 w-3" /> {t("dieCut.preview.fit")}
                  </button>

                  <button
                    onClick={resetView}
                    className="h-7 px-2 flex items-center gap-1 rounded-md transition-all text-[11px] font-bold"
                    style={{ backgroundColor: "#F1F5F9", border: "1px solid #CBD5E1", color: "#6B7280" }}
                    title={t("preview.reset")}
                  >
                    <RotateCcw className="h-3 w-3" /> {t("preview.reset")}
                  </button>
                </div>
              </div>
          </CardContent>
        </Card>
      </div>
    );
  },
);

PreviewSection.displayName = "PreviewSection";

export default PreviewSection;
