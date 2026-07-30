import { useEffect, useRef, forwardRef, useImperativeHandle, useState, useCallback } from "react";
import { ZoomIn, ZoomOut, RotateCcw, ImageIcon, Palette, Loader2, Maximize2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ImageInfo, StrokeSettings, ResizeSettings, ShapeSettings } from "./image-editor";
import { SpotPreviewData } from "./controls-section";
import { CadCutBounds } from "@/lib/cadcut-bounds";
import { processContourInWorker } from "@/lib/contour-worker-manager";
import { calculateShapeDimensions } from "@/lib/shape-outline";
import { cropImageToContent, getImageBounds, createEdgeBleedCanvas } from "@/lib/image-crop";
import { convertPolygonToCurves, gaussianSmoothContour } from "@/lib/clipper-path";

interface PreviewSectionProps {
  imageInfo: ImageInfo | null;
  strokeSettings: StrokeSettings;
  resizeSettings: ResizeSettings;
  shapeSettings: ShapeSettings;
  cadCutBounds?: CadCutBounds | null;
  spotPreviewData?: SpotPreviewData;
  showCutLineInfo?: boolean;
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  ({ imageInfo, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, spotPreviewData, showCutLineInfo }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [zoom, setZoom] = useState(1);
    const [panX, setPanX] = useState(0); // -100 to 100 (percent offset)
    const [panY, setPanY] = useState(0); // -100 to 100 (percent offset)
    const [backgroundColor, setBackgroundColor] = useState("transparent");
    const lastImageRef = useRef<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [processingProgress, setProcessingProgress] = useState(0);
    const contourCacheRef = useRef<{key: string; canvas: HTMLCanvasElement} | null>(null);
    const processingIdRef = useRef(0);
    const [showHighlight, setShowHighlight] = useState(false);
    const lastSettingsRef = useRef<string>('');
    const contourDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Store the last rendered image position for spot overlay alignment
    const lastImageRenderRef = useRef<{x: number; y: number; width: number; height: number} | null>(null);
    const [previewDims, setPreviewDims] = useState({ width: 360, height: 360 });
    
    // Drag-to-pan state
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{x: number; y: number; panX: number; panY: number} | null>(null);
    
    // Drag-to-pan handlers
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      if (zoom === 1) return; // Only allow panning when zoomed
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        panX,
        panY
      };
    }, [zoom, panX, panY]);
    
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
      if (!isDragging || !dragStartRef.current) return;
      
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;
      
      // Convert pixel movement to pan percentage (400px canvas = 100%)
      const sensitivity = 0.6; // Increased 20% for faster panning
      const newPanX = Math.max(-100, Math.min(100, dragStartRef.current.panX + (deltaX * sensitivity)));
      const newPanY = Math.max(-100, Math.min(100, dragStartRef.current.panY + (deltaY * sensitivity)));
      
      setPanX(newPanX);
      setPanY(newPanY);
    }, [isDragging]);
    
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
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      if (zoom === 1 || e.touches.length !== 1) return;
      e.preventDefault(); // Prevent scroll interference when zoomed
      const touch = e.touches[0];
      setIsDragging(true);
      dragStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        panX,
        panY
      };
    }, [zoom, panX, panY]);
    
    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      if (!isDragging || !dragStartRef.current || e.touches.length !== 1) return;
      e.preventDefault(); // Prevent scrolling while panning
      const touch = e.touches[0];
      
      const deltaX = touch.clientX - dragStartRef.current.x;
      const deltaY = touch.clientY - dragStartRef.current.y;
      
      // Reduced sensitivity for mobile (50% of desktop) for more precise control
      const sensitivity = 0.3;
      const newPanX = Math.max(-100, Math.min(100, dragStartRef.current.panX + (deltaX * sensitivity)));
      const newPanY = Math.max(-100, Math.min(100, dragStartRef.current.panY + (deltaY * sensitivity)));
      
      setPanX(newPanX);
      setPanY(newPanY);
    }, [isDragging]);
    
    const handleTouchEnd = useCallback(() => {
      setIsDragging(false);
      dragStartRef.current = null;
    }, []);
    
    // Fit to View: calculate zoom to fit canvas within container and reset pan
    const fitToView = useCallback(() => {
      if (!containerRef.current) return;
      const viewPadding = Math.max(4, Math.round(Math.min(previewDims.width, previewDims.height) * 0.03));
      const containerWidth = containerRef.current.clientWidth - viewPadding * 2;
      const containerHeight = containerRef.current.clientHeight - viewPadding * 2;
      const scaleX = containerWidth / previewDims.width;
      const scaleY = containerHeight / previewDims.height;
      const fitZoom = Math.min(scaleX, scaleY, 1); // max at 100%
      setZoom(Math.max(0.2, Math.round(fitZoom * 20) / 20)); // round to 5% steps
      setPanX(0);
      setPanY(0);
    }, [previewDims.height, previewDims.width]);
    
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
      setZoom(prev => Math.max(0.2, Math.min(3, prev + delta)));
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
      const hasMinimalEmptySpace = checkImageHasMinimalEmptySpace(imageInfo.image);
      if (hasMinimalEmptySpace) {
        setZoom(0.75);
      } else {
        setZoom(1);
      }
    }, [imageInfo]);

    useEffect(() => {
      if (!containerRef.current) return;
      const updateSize = () => {
        const width = containerRef.current?.clientWidth || 0;
        const height = containerRef.current?.clientHeight || 0;
        const safeWidth = Math.max(220, Math.min(720, width));
        const safeHeight = Math.max(220, Math.min(720, height));
        setPreviewDims({
          width: safeWidth || 360,
          height: safeHeight || 360
        });
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(containerRef.current);
      return () => observer.disconnect();
    }, []);
    
    // Check if image content extends close to the edges (minimal empty space)
    const checkImageHasMinimalEmptySpace = (image: HTMLImageElement): boolean => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        
        canvas.width = image.width;
        canvas.height = image.height;
        ctx.drawImage(image, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // Check edges for content - if content is within 5% of any edge, it's "no empty space"
        const margin = Math.max(5, Math.floor(Math.min(canvas.width, canvas.height) * 0.05));
        
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
            if (data[idx + 3] > 128) { // Alpha > 128
              hasContentNearTop = true;
              break;
            }
          }
        }
        
        // Check bottom edge
        for (let y = canvas.height - margin; y < canvas.height && !hasContentNearBottom; y++) {
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
        for (let x = canvas.width - margin; x < canvas.width && !hasContentNearRight; x++) {
          for (let y = 0; y < canvas.height; y += step) {
            const idx = (y * canvas.width + x) * 4;
            if (data[idx + 3] > 128) {
              hasContentNearRight = true;
              break;
            }
          }
        }
        
        // If content is near 3+ edges, consider it "no empty space"
        const edgesWithContent = [hasContentNearTop, hasContentNearBottom, hasContentNearLeft, hasContentNearRight].filter(Boolean).length;
        return edgesWithContent >= 3;
      } catch {
        return false;
      }
    };
    
    const getColorName = (color: string) => {
      const colorMap: Record<string, string> = {
        "transparent": "Transparent",
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

    // Version bump forces cache invalidation when worker code changes
    const CONTOUR_CACHE_VERSION = 7;
    const generateContourCacheKey = useCallback(() => {
      if (!imageInfo) return '';
      return `v${CONTOUR_CACHE_VERSION}-${imageInfo.image.src}-${strokeSettings.width}-${strokeSettings.alphaThreshold}-${strokeSettings.closeSmallGaps}-${strokeSettings.closeBigGaps}-${strokeSettings.backgroundColor}-${strokeSettings.useCustomBackground}-${resizeSettings.widthInches}-${resizeSettings.heightInches}`;
    }, [imageInfo, strokeSettings.width, strokeSettings.alphaThreshold, strokeSettings.closeSmallGaps, strokeSettings.closeBigGaps, strokeSettings.backgroundColor, strokeSettings.useCustomBackground, resizeSettings.widthInches, resizeSettings.heightInches]);

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

        const previewStrokeSettings = { ...strokeSettings, color: '#FF00FF' };
        const workerResizeSettings = {
          widthInches: resizeSettings.widthInches,
          heightInches: resizeSettings.heightInches,
          maintainAspectRatio: resizeSettings.maintainAspectRatio,
          outputDPI: 100
        };

        processContourInWorker(
          imageInfo.image,
          previewStrokeSettings,
          workerResizeSettings,
          (progress) => {
            if (processingIdRef.current === currentId) {
              setProcessingProgress(progress);
            }
          }
        ).then((contourCanvas) => {
          if (processingIdRef.current === currentId) {
            contourCacheRef.current = { key: cacheKey, canvas: contourCanvas };
            setIsProcessing(false);
          }
        }).catch((error) => {
          console.error('Contour processing error:', error);
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
    }, [imageInfo, strokeSettings, resizeSettings, shapeSettings.enabled, generateContourCacheKey]);

    useEffect(() => {
      if (!canvasRef.current || !imageInfo) return;

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Square canvas to match square container - image will be centered inside
      const canvasWidth = previewDims.width;
      const canvasHeight = previewDims.height;
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;

      // Determine which background color to use:
      // - For PDFs with CutContour, use strokeSettings.backgroundColor
      // - For regular images, use local backgroundColor state
      const hasPdfCutContour = imageInfo.isPDF && imageInfo.pdfCutContourInfo?.hasCutContour;
      const effectiveBackgroundColor = hasPdfCutContour 
        ? strokeSettings.backgroundColor 
        : backgroundColor;

      // For PDFs with CutContour, we need special rendering to clip background to the cut path
      if (hasPdfCutContour && imageInfo.pdfCutContourInfo) {
        const cutContourInfo = imageInfo.pdfCutContourInfo;
        const hasExtractedPaths = cutContourInfo.cutContourPoints && cutContourInfo.cutContourPoints.length > 0;
        const viewPadding = Math.max(4, Math.round(Math.min(canvasWidth, canvasHeight) * 0.03));
        const availableWidth = canvas.width - (viewPadding * 2);
        const availableHeight = canvas.height - (viewPadding * 2);
        
        // Get actual content bounds of the rendered PDF (removes empty space and white background)
        const contentBounds = getImageBounds(imageInfo.image, true);
        
        // Use content bounds for sizing, not full PDF page size
        const contentWidth = contentBounds.width;
        const contentHeight = contentBounds.height;
        const scaleX = availableWidth / contentWidth;
        const scaleY = availableHeight / contentHeight;
        const scale = Math.min(scaleX, scaleY);
        
        const scaledWidth = contentWidth * scale;
        const scaledHeight = contentHeight * scale;
        const offsetX = viewPadding + (availableWidth - scaledWidth) / 2;
        const offsetY = viewPadding + (availableHeight - scaledHeight) / 2;
        
        // Store content bounds offset for image drawing
        const contentOffsetX = contentBounds.x;
        const contentOffsetY = contentBounds.y;
        
        // Bleed offset based on content scale (0.10 inches at render DPI)
        const bleedInches = 0.10;
        const renderDPI = imageInfo.pdfCutContourInfo.pageWidth ? 
          (imageInfo.image.naturalWidth / (imageInfo.pdfCutContourInfo.pageWidth / 72 * 72)) : 300;
        const bleedPixelsAtRender = bleedInches * renderDPI;
        const bleedPixels = bleedPixelsAtRender * scale;
        
        // First draw checkerboard background for transparency indication
        const gridSize = 10;
        const lightColor = '#e8e8e8';
        const darkColor = '#d0d0d0';
        for (let y = 0; y < canvas.height; y += gridSize) {
          for (let x = 0; x < canvas.width; x += gridSize) {
            const isEven = ((x / gridSize) + (y / gridSize)) % 2 === 0;
            ctx.fillStyle = isEven ? lightColor : darkColor;
            ctx.fillRect(x, y, gridSize, gridSize);
          }
        }
        
        // Create clipping path - use extracted paths if available, otherwise use image bounds
        ctx.save();
        ctx.beginPath();
        
        if (hasExtractedPaths) {
          // Use extracted CutContour paths with bleed expansion
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            
            // Calculate centroid of path for offset direction
            let cx = 0, cy = 0;
            for (const pt of path) {
              cx += offsetX + pt.x * scale;
              cy += offsetY + pt.y * scale;
            }
            cx /= path.length;
            cy /= path.length;
            
            // Draw path with bleed expansion (offset away from centroid)
            const firstX = offsetX + path[0].x * scale;
            const firstY = offsetY + path[0].y * scale;
            const firstDist = Math.sqrt((firstX - cx) ** 2 + (firstY - cy) ** 2);
            const firstExpandX = firstDist > 0 ? (firstX - cx) / firstDist * bleedPixels : 0;
            const firstExpandY = firstDist > 0 ? (firstY - cy) / firstDist * bleedPixels : 0;
            
            ctx.moveTo(firstX + firstExpandX, firstY + firstExpandY);
            
            for (let i = 1; i < path.length; i++) {
              const px = offsetX + path[i].x * scale;
              const py = offsetY + path[i].y * scale;
              const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
              const expandX = dist > 0 ? (px - cx) / dist * bleedPixels : 0;
              const expandY = dist > 0 ? (py - cy) / dist * bleedPixels : 0;
              ctx.lineTo(px + expandX, py + expandY);
            }
            ctx.closePath();
          }
        } else {
          // Fallback: use image bounds with bleed for clipping
          const clipX = offsetX - bleedPixels;
          const clipY = offsetY - bleedPixels;
          const clipW = scaledWidth + bleedPixels * 2;
          const clipH = scaledHeight + bleedPixels * 2;
          ctx.rect(clipX, clipY, clipW, clipH);
          ctx.closePath();
          
          // Fill background color for the fallback rect area directly
          if (effectiveBackgroundColor !== "transparent") {
            if (effectiveBackgroundColor === "holographic") {
              const gradient = ctx.createLinearGradient(clipX, clipY, clipX + clipW, clipY + clipH);
              gradient.addColorStop(0, '#C8C8D0');
              gradient.addColorStop(0.17, '#E8B8B8');
              gradient.addColorStop(0.34, '#B8D8E8');
              gradient.addColorStop(0.51, '#E8D0F0');
              gradient.addColorStop(0.68, '#B0C8E0');
              gradient.addColorStop(0.85, '#C0B0D8');
              gradient.addColorStop(1, '#C8C8D0');
              ctx.fillStyle = gradient;
            } else {
              ctx.fillStyle = effectiveBackgroundColor;
            }
            ctx.fillRect(clipX, clipY, clipW, clipH);
          }
          
          // Clip and draw only the content portion of the image
          ctx.clip();
          ctx.drawImage(
            imageInfo.image,
            contentOffsetX, contentOffsetY, contentWidth, contentHeight,
            offsetX, offsetY, scaledWidth, scaledHeight
          );
          ctx.restore();
          
          // Draw image bounds as cut indicator
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
          return; // Early return for fallback case
        }
        
        // For extracted paths: fill the path, then clip for the image
        if (effectiveBackgroundColor !== "transparent") {
          if (effectiveBackgroundColor === "holographic") {
            const bounds = ctx.getTransform();
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fill();
        }
        
        ctx.clip();
        
        // Draw only the content portion of the image inside the clipped region
        ctx.drawImage(
          imageInfo.image,
          contentOffsetX, contentOffsetY, contentWidth, contentHeight,
          offsetX, offsetY, scaledWidth, scaledHeight
        );
        
        ctx.restore();
        
        // Draw the CutContour path indicator (magenta dashed line) with curve detection
        if (hasExtractedPaths) {
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          
          for (const path of cutContourInfo.cutContourPoints) {
            if (path.length < 2) continue;
            ctx.beginPath();
            
            // Smooth the contour first to reduce jagged edges from alpha tracing
            const smoothedPath = gaussianSmoothContour(path, 2);
            
            // Convert path to curves for smooth rendering (60+ point curves)
            const segments = convertPolygonToCurves(smoothedPath, 70);
            
            for (const seg of segments) {
              if (seg.type === 'move' && seg.point) {
                ctx.moveTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'line' && seg.point) {
                ctx.lineTo(offsetX + seg.point.x * scale, offsetY + seg.point.y * scale);
              } else if (seg.type === 'curve' && seg.cp1 && seg.cp2 && seg.end) {
                ctx.bezierCurveTo(
                  offsetX + seg.cp1.x * scale, offsetY + seg.cp1.y * scale,
                  offsetX + seg.cp2.x * scale, offsetY + seg.cp2.y * scale,
                  offsetX + seg.end.x * scale, offsetY + seg.end.y * scale
                );
              }
            }
            
            ctx.closePath();
            ctx.stroke();
          }
          
          ctx.restore();
        } else {
          // Draw image bounds as cut indicator when no paths extracted
          ctx.save();
          ctx.strokeStyle = '#FF00FF';
          ctx.lineWidth = 2;
          ctx.setLineDash([5, 5]);
          ctx.strokeRect(offsetX, offsetY, scaledWidth, scaledHeight);
          ctx.restore();
        }
      } else {
        // Regular image rendering (non-PDF or no CutContour)
        
        // For shape mode, always use a solid light background to show cut area
        if (shapeSettings.enabled) {
          ctx.fillStyle = '#f0f0f0';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          drawShapePreview(ctx, canvas.width, canvas.height);
        } else if (effectiveBackgroundColor === "transparent") {
          // Draw transparency grid pattern (light grey checkerboard)
          const gridSize = 10;
          const lightColor = '#e8e8e8';
          const darkColor = '#d0d0d0';
          
          for (let y = 0; y < canvas.height; y += gridSize) {
            for (let x = 0; x < canvas.width; x += gridSize) {
              const isEven = ((x / gridSize) + (y / gridSize)) % 2 === 0;
              ctx.fillStyle = isEven ? lightColor : darkColor;
              ctx.fillRect(x, y, gridSize, gridSize);
            }
          }
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        } else {
          if (effectiveBackgroundColor === "holographic") {
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, '#C8C8D0');
            gradient.addColorStop(0.17, '#E8B8B8');
            gradient.addColorStop(0.34, '#B8D8E8');
            gradient.addColorStop(0.51, '#E8D0F0');
            gradient.addColorStop(0.68, '#B0C8E0');
            gradient.addColorStop(0.85, '#C0B0D8');
            gradient.addColorStop(1, '#C8C8D0');
            ctx.fillStyle = gradient;
          } else {
            ctx.fillStyle = effectiveBackgroundColor;
          }
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          drawImageWithResizePreview(ctx, canvas.width, canvas.height);
        }

      }
    }, [imageInfo, strokeSettings, resizeSettings, shapeSettings, cadCutBounds, backgroundColor, isProcessing, spotPreviewData, previewDims.height, previewDims.width]);

    // Helper function to create spot color overlay canvas from original image
    const createSpotOverlayCanvas = (): HTMLCanvasElement | null => {
      if (!imageInfo || !spotPreviewData?.enabled) return null;
      
      const whiteColors = spotPreviewData.colors.filter(c => c.spotWhite);
      const glossColors = spotPreviewData.colors.filter(c => c.spotGloss);
      
      if (whiteColors.length === 0 && glossColors.length === 0) return null;
      
      // Create canvas with original image data
      const srcCanvas = document.createElement('canvas');
      const srcCtx = srcCanvas.getContext('2d');
      if (!srcCtx) return null;
      
      srcCanvas.width = imageInfo.image.width;
      srcCanvas.height = imageInfo.image.height;
      srcCtx.drawImage(imageInfo.image, 0, 0);
      const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
      
      // Create overlay canvas
      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = srcCanvas.width;
      overlayCanvas.height = srcCanvas.height;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) return null;
      
      const overlayData = overlayCtx.createImageData(srcCanvas.width, srcCanvas.height);
      
      const colorMatches = (pixelR: number, pixelG: number, pixelB: number, targetHex: string, tolerance: number = 30) => {
        const r = parseInt(targetHex.slice(1, 3), 16);
        const g = parseInt(targetHex.slice(3, 5), 16);
        const b = parseInt(targetHex.slice(5, 7), 16);
        return Math.abs(pixelR - r) <= tolerance && 
               Math.abs(pixelG - g) <= tolerance && 
               Math.abs(pixelB - b) <= tolerance;
      };
      
      for (let y = 0; y < srcCanvas.height; y++) {
        for (let x = 0; x < srcCanvas.width; x++) {
          const idx = (y * srcCanvas.width + x) * 4;
          const r = srcData.data[idx];
          const g = srcData.data[idx + 1];
          const b = srcData.data[idx + 2];
          const a = srcData.data[idx + 3];
          
          if (a < 128) continue;
          
          for (const wc of whiteColors) {
            if (colorMatches(r, g, b, wc.hex)) {
              overlayData.data[idx] = 255;
              overlayData.data[idx + 1] = 255;
              overlayData.data[idx + 2] = 255;
              overlayData.data[idx + 3] = 255;
              break;
            }
          }
          
          if (overlayData.data[idx + 3] === 0) {
            for (const gc of glossColors) {
              if (colorMatches(r, g, b, gc.hex)) {
                overlayData.data[idx] = 180;
                overlayData.data[idx + 1] = 180;
                overlayData.data[idx + 2] = 190;
                overlayData.data[idx + 3] = 255;
                break;
              }
            }
          }
        }
      }
      
      overlayCtx.putImageData(overlayData, 0, 0);
      return overlayCanvas;
    };

    useEffect(() => {
      if (!imageInfo) return;
      const settingsKey = `${strokeSettings.enabled}-${strokeSettings.width}-${shapeSettings.enabled}-${shapeSettings.type}-${resizeSettings.widthInches}`;
      if (lastSettingsRef.current && lastSettingsRef.current !== settingsKey) {
        setShowHighlight(true);
        const timer = setTimeout(() => setShowHighlight(false), 500);
        return () => clearTimeout(timer);
      }
      lastSettingsRef.current = settingsKey;
    }, [imageInfo, strokeSettings.enabled, strokeSettings.width, shapeSettings.enabled, shapeSettings.type, resizeSettings.widthInches]);

    const drawShapePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const shapeDims = calculateShapeDimensions(
        resizeSettings.widthInches,
        resizeSettings.heightInches,
        shapeSettings.type,
        shapeSettings.offset
      );

      const bleedInches = 0.10; // 0.10" bleed around the shape
      const padding = Math.max(4, Math.round(Math.min(canvasWidth, canvasHeight) * 0.03));
      const availableWidth = canvasWidth - (padding * 2);
      const availableHeight = canvasHeight - (padding * 2);
      const shapeAspect = shapeDims.widthInches / shapeDims.heightInches;
      
      let shapeWidth, shapeHeight;
      if (shapeAspect > (availableWidth / availableHeight)) {
        shapeWidth = availableWidth;
        shapeHeight = availableWidth / shapeAspect;
      } else {
        shapeHeight = availableHeight;
        shapeWidth = availableHeight * shapeAspect;
      }

      const shapeX = (canvasWidth - shapeWidth) / 2;
      const shapeY = (canvasHeight - shapeHeight) / 2;
      
      // Calculate bleed in pixels based on shape scale (only if bleed is enabled)
      const shapePixelsPerInch = Math.min(shapeWidth / shapeDims.widthInches, shapeHeight / shapeDims.heightInches);
      const bleedPixels = shapeSettings.bleedEnabled ? bleedInches * shapePixelsPerInch : 0;
      
      const cornerRadiusPixels = (shapeSettings.cornerRadius || 0.25) * shapePixelsPerInch;
      
      // Prepare source image for edge bleeding
      const croppedCanvas = cropImageToContent(imageInfo.image);
      const sourceImage = croppedCanvas ? croppedCanvas : imageInfo.image;
      
      // Image dimensions within the shape
      let imageWidth = resizeSettings.widthInches * shapePixelsPerInch;
      let imageHeight = resizeSettings.heightInches * shapePixelsPerInch;
      
      // For circles and ovals, scale down the image so it fits entirely inside the shape
      // A rectangle fits inside a circle when its diagonal ≤ diameter
      // For an oval, the inscribed rectangle must satisfy (w/2/a)² + (h/2/b)² ≤ 1
      if (shapeSettings.type === 'circle') {
        const radius = Math.min(shapeWidth, shapeHeight) / 2;
        const diameter = radius * 2;
        const diagonal = Math.sqrt(imageWidth * imageWidth + imageHeight * imageHeight);
        if (diagonal > diameter) {
          const scale = diameter / diagonal;
          imageWidth *= scale;
          imageHeight *= scale;
        }
      } else if (shapeSettings.type === 'oval') {
        const a = shapeWidth / 2;  // horizontal semi-axis
        const b = shapeHeight / 2; // vertical semi-axis
        // Check if rectangle corners exceed ellipse boundary
        // Corner at (imageWidth/2, imageHeight/2) must satisfy (x/a)² + (y/b)² ≤ 1
        const halfW = imageWidth / 2;
        const halfH = imageHeight / 2;
        const ellipseCheck = (halfW / a) ** 2 + (halfH / b) ** 2;
        if (ellipseCheck > 1) {
          const scale = 1 / Math.sqrt(ellipseCheck);
          imageWidth *= scale;
          imageHeight *= scale;
        }
      }
      
      const imageX = shapeX + (shapeWidth - imageWidth) / 2;
      const imageY = shapeY + (shapeHeight - imageHeight) / 2;
      
      console.log('[MainRender] Image at:', imageX.toFixed(1), imageY.toFixed(1), 'size:', imageWidth.toFixed(1), imageHeight.toFixed(1));
      
      // Draw background with bleed or fill
      if (shapeSettings.bleedEnabled) {
        // Solid color bleed mode - draw bleed area with bleedColor first
        ctx.fillStyle = shapeSettings.bleedColor || '#FFFFFF';
        ctx.beginPath();
        
        if (shapeSettings.type === 'circle') {
          const radius = Math.min(shapeWidth, shapeHeight) / 2 + bleedPixels;
          ctx.arc(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, radius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          ctx.ellipse(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, shapeWidth / 2 + bleedPixels, shapeHeight / 2 + bleedPixels, 0, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.rect(shapeX + (shapeWidth - size) / 2 - bleedPixels, shapeY + (shapeHeight - size) / 2 - bleedPixels, size + bleedPixels * 2, size + bleedPixels * 2);
        } else if (shapeSettings.type === 'rounded-square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.roundRect(shapeX + (shapeWidth - size) / 2 - bleedPixels, shapeY + (shapeHeight - size) / 2 - bleedPixels, size + bleedPixels * 2, size + bleedPixels * 2, cornerRadiusPixels);
        } else if (shapeSettings.type === 'rounded-rectangle') {
          ctx.roundRect(shapeX - bleedPixels, shapeY - bleedPixels, shapeWidth + bleedPixels * 2, shapeHeight + bleedPixels * 2, cornerRadiusPixels);
        } else {
          ctx.rect(shapeX - bleedPixels, shapeY - bleedPixels, shapeWidth + bleedPixels * 2, shapeHeight + bleedPixels * 2);
        }
        ctx.fill();
        
        // Then draw the fill color on top (within the cut line)
        // Handle holographic fill with animated rainbow gradient for preview
        if (shapeSettings.fillColor === 'holographic') {
          const gradient = ctx.createLinearGradient(shapeX, shapeY, shapeX + shapeWidth, shapeY + shapeHeight);
          gradient.addColorStop(0, '#C8C8D0');
          gradient.addColorStop(0.17, '#E8B8B8');
          gradient.addColorStop(0.34, '#B8D8E8');
          gradient.addColorStop(0.51, '#E8D0F0');
          gradient.addColorStop(0.68, '#B0C8E0');
          gradient.addColorStop(0.85, '#C0B0D8');
          gradient.addColorStop(1, '#C8C8D0');
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = shapeSettings.fillColor;
        }
        ctx.beginPath();
        
        if (shapeSettings.type === 'circle') {
          const radius = Math.min(shapeWidth, shapeHeight) / 2;
          ctx.arc(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, radius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          ctx.ellipse(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, shapeWidth / 2, shapeHeight / 2, 0, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.rect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size);
        } else if (shapeSettings.type === 'rounded-square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.roundRect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size, cornerRadiusPixels);
        } else if (shapeSettings.type === 'rounded-rectangle') {
          ctx.roundRect(shapeX, shapeY, shapeWidth, shapeHeight, cornerRadiusPixels);
        } else {
          ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
        }
        ctx.fill();
      } else {
        // Solid fill mode
        // Handle holographic fill with rainbow gradient for preview
        if (shapeSettings.fillColor === 'holographic') {
          const gradient = ctx.createLinearGradient(shapeX, shapeY, shapeX + shapeWidth, shapeY + shapeHeight);
          gradient.addColorStop(0, '#C8C8D0');
          gradient.addColorStop(0.17, '#E8B8B8');
          gradient.addColorStop(0.34, '#B8D8E8');
          gradient.addColorStop(0.51, '#E8D0F0');
          gradient.addColorStop(0.68, '#B0C8E0');
          gradient.addColorStop(0.85, '#C0B0D8');
          gradient.addColorStop(1, '#C8C8D0');
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = shapeSettings.fillColor;
        }
        ctx.beginPath();
        
        if (shapeSettings.type === 'circle') {
          const radius = Math.min(shapeWidth, shapeHeight) / 2;
          ctx.arc(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, radius, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'oval') {
          ctx.ellipse(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, shapeWidth / 2, shapeHeight / 2, 0, 0, Math.PI * 2);
        } else if (shapeSettings.type === 'square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.rect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size);
        } else if (shapeSettings.type === 'rounded-square') {
          const size = Math.min(shapeWidth, shapeHeight);
          ctx.roundRect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size, cornerRadiusPixels);
        } else if (shapeSettings.type === 'rounded-rectangle') {
          ctx.roundRect(shapeX, shapeY, shapeWidth, shapeHeight, cornerRadiusPixels);
        } else {
          ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
        }
        
        ctx.fill();
      }
      
      // Draw CutContour outline at exact cut position (without bleed)
      ctx.strokeStyle = '#FF00FF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      
      if (shapeSettings.type === 'circle') {
        const radius = Math.min(shapeWidth, shapeHeight) / 2;
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      } else if (shapeSettings.type === 'oval') {
        const centerX = shapeX + shapeWidth / 2;
        const centerY = shapeY + shapeHeight / 2;
        const radiusX = shapeWidth / 2;
        const radiusY = shapeHeight / 2;
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
      } else if (shapeSettings.type === 'square') {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.rect(startX, startY, size, size);
      } else if (shapeSettings.type === 'rounded-square') {
        const size = Math.min(shapeWidth, shapeHeight);
        const startX = shapeX + (shapeWidth - size) / 2;
        const startY = shapeY + (shapeHeight - size) / 2;
        ctx.roundRect(startX, startY, size, size, cornerRadiusPixels);
      } else if (shapeSettings.type === 'rounded-rectangle') {
        ctx.roundRect(shapeX, shapeY, shapeWidth, shapeHeight, cornerRadiusPixels);
      } else {
        ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
      }
      
      ctx.stroke();

      // Draw the original image on top (clipped to cut line)
      ctx.save();
      ctx.beginPath();
      
      if (shapeSettings.type === 'circle') {
        const radius = Math.min(shapeWidth, shapeHeight) / 2;
        ctx.arc(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, radius, 0, Math.PI * 2);
      } else if (shapeSettings.type === 'oval') {
        ctx.ellipse(shapeX + shapeWidth / 2, shapeY + shapeHeight / 2, shapeWidth / 2, shapeHeight / 2, 0, 0, Math.PI * 2);
      } else if (shapeSettings.type === 'square') {
        const size = Math.min(shapeWidth, shapeHeight);
        ctx.rect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size);
      } else if (shapeSettings.type === 'rounded-square') {
        const size = Math.min(shapeWidth, shapeHeight);
        ctx.roundRect(shapeX + (shapeWidth - size) / 2, shapeY + (shapeHeight - size) / 2, size, size, cornerRadiusPixels);
      } else if (shapeSettings.type === 'rounded-rectangle') {
        ctx.roundRect(shapeX, shapeY, shapeWidth, shapeHeight, cornerRadiusPixels);
      } else {
        ctx.rect(shapeX, shapeY, shapeWidth, shapeHeight);
      }
      
      ctx.clip();
      ctx.drawImage(sourceImage, imageX, imageY, imageWidth, imageHeight);
      
      // Draw spot color overlay on top of the image (still clipped to shape)
      const spotOverlay = createSpotOverlayCanvas();
      if (spotOverlay) {
        ctx.drawImage(spotOverlay, imageX, imageY, imageWidth, imageHeight);
      }
      
      ctx.restore();
    };

    const drawImageWithResizePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const viewPadding = Math.max(4, Math.round(Math.min(canvasWidth, canvasHeight) * 0.03));
      const availableWidth = canvasWidth - (viewPadding * 2);
      const availableHeight = canvasHeight - (viewPadding * 2);
      
      if (strokeSettings.enabled && contourCacheRef.current?.canvas && !isProcessing) {
        const contourCanvas = contourCacheRef.current.canvas;
        
        const contourAspectRatio = contourCanvas.width / contourCanvas.height;
        
        let contourWidth, contourHeight;
        if (contourAspectRatio > (availableWidth / availableHeight)) {
          contourWidth = availableWidth;
          contourHeight = availableWidth / contourAspectRatio;
        } else {
          contourHeight = availableHeight;
          contourWidth = availableHeight * contourAspectRatio;
        }
        
        const contourX = (canvasWidth - contourWidth) / 2;
        const contourY = (canvasHeight - contourHeight) / 2;
        
        // If holographic is selected, replace the white placeholder with holographic gradient
        if (strokeSettings.backgroundColor === 'holographic') {
          // Create a temporary canvas to apply the holographic effect
          const tempCanvas = document.createElement('canvas');
          tempCanvas.width = contourCanvas.width;
          tempCanvas.height = contourCanvas.height;
          const tempCtx = tempCanvas.getContext('2d')!;
          
          // Draw the contour canvas (which has white background as placeholder)
          tempCtx.drawImage(contourCanvas, 0, 0);
          
          // Get image data to replace white pixels with gradient
          const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
          const pixels = imageData.data;
          
          // Create gradient canvas
          const gradientCanvas = document.createElement('canvas');
          gradientCanvas.width = tempCanvas.width;
          gradientCanvas.height = tempCanvas.height;
          const gradCtx = gradientCanvas.getContext('2d')!;
          const gradient = gradCtx.createLinearGradient(0, 0, gradientCanvas.width, gradientCanvas.height);
          gradient.addColorStop(0, '#C8C8D0');
          gradient.addColorStop(0.17, '#E8B8B8');
          gradient.addColorStop(0.34, '#B8D8E8');
          gradient.addColorStop(0.51, '#E8D0F0');
          gradient.addColorStop(0.68, '#B0C8E0');
          gradient.addColorStop(0.85, '#C0B0D8');
          gradient.addColorStop(1, '#C8C8D0');
          gradCtx.fillStyle = gradient;
          gradCtx.fillRect(0, 0, gradientCanvas.width, gradientCanvas.height);
          const gradientData = gradCtx.getImageData(0, 0, gradientCanvas.width, gradientCanvas.height);
          const gradPixels = gradientData.data;
          
          // Replace white/near-white pixels with gradient colors
          for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const a = pixels[i + 3];
            
            // Check if pixel is white/near-white (the placeholder background)
            if (a > 200 && r > 240 && g > 240 && b > 240) {
              pixels[i] = gradPixels[i];
              pixels[i + 1] = gradPixels[i + 1];
              pixels[i + 2] = gradPixels[i + 2];
            }
          }
          
          tempCtx.putImageData(imageData, 0, 0);
          ctx.drawImage(tempCanvas, contourX, contourY, contourWidth, contourHeight);
        } else {
          ctx.drawImage(contourCanvas, contourX, contourY, contourWidth, contourHeight);
        }
        
        // Draw spot color overlay at exact image position within contour
        const spotOverlay = createSpotOverlayCanvas();
        if (spotOverlay) {
          // Calculate padding directly from actual canvas dimensions (most reliable)
          // contourCanvas.width = image.width + (padding * 2)
          // So: padding = (contourCanvas.width - image.width) / 2
          const paddingX = (contourCanvas.width - imageInfo.image.width) / 2;
          const paddingY = (contourCanvas.height - imageInfo.image.height) / 2;
          
          const scaleX = contourWidth / contourCanvas.width;
          const scaleY = contourHeight / contourCanvas.height;
          
          const spotX = contourX + (paddingX * scaleX);
          const spotY = contourY + (paddingY * scaleY);
          const spotWidth = imageInfo.image.width * scaleX;
          const spotHeight = imageInfo.image.height * scaleY;
          
          ctx.drawImage(spotOverlay, spotX, spotY, spotWidth, spotHeight);
        }
      } else {
        const aspectRatio = imageInfo.image.width / imageInfo.image.height;
        let displayWidth, displayHeight;
        if (aspectRatio > (availableWidth / availableHeight)) {
          displayWidth = availableWidth;
          displayHeight = availableWidth / aspectRatio;
        } else {
          displayHeight = availableHeight;
          displayWidth = availableHeight * aspectRatio;
        }
        
        const displayX = (canvasWidth - displayWidth) / 2;
        const displayY = (canvasHeight - displayHeight) / 2;
        
        ctx.drawImage(imageInfo.image, displayX, displayY, displayWidth, displayHeight);
        
        // Draw spot color overlay at exact same position
        const spotOverlay = createSpotOverlayCanvas();
        if (spotOverlay) {
          ctx.drawImage(spotOverlay, displayX, displayY, displayWidth, displayHeight);
        }
      }
    };

    const getBackgroundStyle = () => {
      // For PDFs with CutContour, use strokeSettings.backgroundColor
      const hasPdfCutContour = imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour;
      const effectiveBg = hasPdfCutContour ? strokeSettings.backgroundColor : backgroundColor;
      if (effectiveBg === "transparent") {
        return "checkerboard";
      }
      return "";
    };

    const getBackgroundColor = () => {
      // For PDFs with CutContour, use strokeSettings.backgroundColor
      const hasPdfCutContour = imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour;
      const effectiveBg = hasPdfCutContour ? strokeSettings.backgroundColor : backgroundColor;
      if (effectiveBg === "transparent") {
        return "transparent";
      }
      return effectiveBg;
    };

    return (
      <div className="w-full">
        <Card className="bg-white border-gray-100 shadow-sm rounded-2xl overflow-hidden">
          <CardContent className="p-3 sm:p-4">
            {/* Hide preview color selector for PDFs with CutContour - they use PDF Options instead */}
            {!(imageInfo?.isPDF && imageInfo?.pdfCutContourInfo?.hasCutContour) && (
              <div className="mb-3 flex items-center gap-3 bg-gray-50/70 p-2 rounded-lg">
                <Palette className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-600">Preview</span>
                <Select value={backgroundColor} onValueChange={setBackgroundColor}>
                  <SelectTrigger className="w-28 h-8 text-sm bg-white border-gray-200 rounded-md">
                    <SelectValue>{getColorName(backgroundColor)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="transparent">Transparent</SelectItem>
                    <SelectItem value="#ffffff">White</SelectItem>
                    <SelectItem value="#000000">Black</SelectItem>
                    <SelectItem value="#f3f4f6">Light Gray</SelectItem>
                    <SelectItem value="#1f2937">Dark Gray</SelectItem>
                    <SelectItem value="#3b82f6">Blue</SelectItem>
                    <SelectItem value="#ef4444">Red</SelectItem>
                    <SelectItem value="#10b981">Green</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex flex-col items-start">
              <div className="flex w-full">
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
                  className={`relative w-full max-w-[720px] rounded-xl border border-gray-200 flex items-center justify-center ${getBackgroundStyle()} ${zoom !== 1 ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-zoom-in'} transition-all duration-300 ${showHighlight ? 'ring-4 ring-cyan-400 ring-opacity-75' : ''}`}
                  style={{ 
                    width: '100%',
                    height: '100%',
                    aspectRatio: imageInfo ? `${imageInfo.image.width} / ${imageInfo.image.height}` : '1 / 1',
                    maxHeight: '70vh',
                    backgroundColor: getBackgroundColor(),
                    overflow: 'hidden',
                    userSelect: 'none',
                    touchAction: zoom !== 1 ? 'none' : 'auto'
                  }}
                >
                <canvas 
                  ref={canvasRef}
                  className="relative z-10 block transition-all duration-200"
                  style={{ 
                    maxWidth: '100%',
                    maxHeight: '100%',
                    transform: `translate(${panX}%, ${panY}%) scale(${zoom})`,
                    transformOrigin: 'center'
                  }}
                />
                
                {!imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center">
                      <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                      <p className="text-gray-500">Upload an image to see preview</p>
                    </div>
                  </div>
                )}
                
                {isProcessing && imageInfo && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30 z-20">
                    <div className="text-center">
                      <Loader2 className="w-8 h-8 text-white mx-auto mb-2 animate-spin" />
                      <p className="text-white text-sm">Processing... {processingProgress}%</p>
                    </div>
                  </div>
                )}
                </div>
                
                {zoom !== 1 && (
                  <div className="hidden md:flex w-2 flex-col ml-1" style={{ height: `${previewDims.height}px` }}>
                    <div 
                      className="flex-1 bg-gray-300/60 rounded relative cursor-pointer"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const y = (e.clientY - rect.top) / rect.height;
                        setPanY(100 - (y * 200));
                      }}
                    >
                      <div 
                        className="absolute left-0 right-0 h-12 bg-gray-500 hover:bg-cyan-500 rounded transition-colors"
                        style={{ top: `${((100 - panY) / 200) * 100}%`, transform: 'translateY(-50%)' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const startY = e.clientY;
                          const startPan = panY;
                          const parent = e.currentTarget.parentElement!;
                          const height = parent.getBoundingClientRect().height;
                          
                          const onMove = (ev: MouseEvent) => {
                            const delta = (ev.clientY - startY) / height * 200;
                            setPanY(Math.max(-100, Math.min(100, startPan - delta)));
                          };
                          const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                          };
                          document.addEventListener('mousemove', onMove);
                          document.addEventListener('mouseup', onUp);
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
              
              <div className="flex">
                {zoom !== 1 && (
                  <div className="hidden md:flex h-2 mt-1" style={{ width: `${previewDims.width}px` }}>
                    <div 
                      className="flex-1 bg-gray-300/60 rounded relative cursor-pointer"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const x = (e.clientX - rect.left) / rect.width;
                        setPanX((x * 200) - 100);
                      }}
                    >
                      <div 
                        className="absolute top-0 bottom-0 w-12 bg-gray-500 hover:bg-cyan-500 rounded transition-colors"
                        style={{ left: `${((panX + 100) / 200) * 100}%`, transform: 'translateX(-50%)' }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          const startX = e.clientX;
                          const startPan = panX;
                          const parent = e.currentTarget.parentElement!;
                          const width = parent.getBoundingClientRect().width;
                          
                          const onMove = (ev: MouseEvent) => {
                            const delta = (ev.clientX - startX) / width * 200;
                            setPanX(Math.max(-100, Math.min(100, startPan + delta)));
                          };
                          const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                          };
                          document.addEventListener('mousemove', onMove);
                          document.addEventListener('mouseup', onUp);
                        }}
                      />
                    </div>
                  </div>
                )}
                {zoom !== 1 && <div className="hidden md:block w-2 h-2 mt-1 ml-1" />}
              </div>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-center gap-1.5 bg-gray-50/50 rounded-lg p-1.5 border border-gray-100">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom(prev => Math.max(prev - 0.1, 0.2))}
                  className="h-7 w-7 p-0 hover:bg-gray-100 rounded-md"
                  title="Zoom Out"
                >
                  <ZoomOut className="h-3.5 w-3.5 text-gray-500" />
                </Button>
                
                <span className="text-xs text-gray-500 min-w-[42px] text-center font-medium">
                  {Math.round(zoom * 100)}%
                </span>
                
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setZoom(prev => Math.min(prev + 0.1, 3))}
                  className="h-7 w-7 p-0 hover:bg-gray-100 rounded-md"
                  title="Zoom In"
                >
                  <ZoomIn className="h-3.5 w-3.5 text-gray-500" />
                </Button>
                
                <div className="w-px h-4 bg-gray-200 mx-0.5" />
                
                <Button 
                  variant="ghost"
                  size="sm"
                  onClick={fitToView}
                  className="h-7 px-2 hover:bg-gray-100 rounded-md text-gray-500 text-xs"
                  title="Fit to View"
                >
                  <Maximize2 className="h-3 w-3 mr-1" />
                  Fit
                </Button>
                
                <Button 
                  variant="ghost"
                  size="sm"
                  onClick={resetView}
                  className="h-7 px-2 hover:bg-gray-100 rounded-md text-gray-500 text-xs"
                  title="Reset"
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Reset
                </Button>
              </div>
            </div>

          </CardContent>
        </Card>
      </div>
    );
  }
);

PreviewSection.displayName = 'PreviewSection';

export default PreviewSection;
