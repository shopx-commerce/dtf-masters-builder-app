import { useEffect, useRef, forwardRef, useImperativeHandle, useState, useCallback, useMemo } from "react";
import { ZoomIn, ZoomOut, RotateCcw, ScanSearch, MousePointer2, Focus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatLength, formatDimensions } from "@/lib/format-length";
import { Button } from "@/components/ui/button";
import { ImageInfo, ResizeSettings, type ImageTransform, type DesignItem } from "./image-editor";
import { computeLayerRect } from "@/lib/types";

const BASE_DPI_SCALE = 2;
const ZOOM_MIN_ABSOLUTE = 0.1;
const ZOOM_WHEEL_FACTOR = 1.1;
const ZOOM_BUTTON_FACTOR = 1.2;
const ROTATE_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke-linecap='round'%3E%3Cpath d='M4 12a8 8 0 0 1 14.93-4' stroke='%23000' stroke-width='4'/%3E%3Cpath d='m19 4 0 4-4 0' stroke='%23000' stroke-width='4'/%3E%3Cpath d='M20 12a8 8 0 0 1-14.93 4' stroke='%23000' stroke-width='4'/%3E%3Cpath d='m5 20 0-4 4 0' stroke='%23000' stroke-width='4'/%3E%3Cpath d='M4 12a8 8 0 0 1 14.93-4' stroke='white' stroke-width='2'/%3E%3Cpath d='m19 4 0 4-4 0' stroke='white' stroke-width='2'/%3E%3Cpath d='M20 12a8 8 0 0 1-14.93 4' stroke='white' stroke-width='2'/%3E%3Cpath d='m5 20 0-4 4 0' stroke='white' stroke-width='2'/%3E%3C/svg%3E") 11 11, pointer`;

function getResizeCursor(handleId: string, rotationDeg: number): string {
  const baseMap: Record<string, number> = { tl: 315, tr: 45, br: 135, bl: 225 };
  const base = baseMap[handleId] ?? 135;
  const angle = ((base + rotationDeg) % 360 + 360) % 360;
  if (angle >= 337.5 || angle < 22.5) return 'n-resize';
  if (angle >= 22.5 && angle < 67.5) return 'ne-resize';
  if (angle >= 67.5 && angle < 112.5) return 'e-resize';
  if (angle >= 112.5 && angle < 157.5) return 'se-resize';
  if (angle >= 157.5 && angle < 202.5) return 's-resize';
  if (angle >= 202.5 && angle < 247.5) return 'sw-resize';
  if (angle >= 247.5 && angle < 292.5) return 'w-resize';
  return 'nw-resize';
}

interface PreviewSectionProps {
  imageInfo: ImageInfo | null;
  resizeSettings: ResizeSettings;
  artboardWidth?: number;
  artboardHeight?: number;
  designTransform?: ImageTransform;
  onTransformChange?: (transform: ImageTransform) => void;
  designs?: DesignItem[];
  selectedDesignId?: string | null;
  selectedDesignIds?: Set<string>;
  onSelectDesign?: (id: string | null) => void;
  onMultiSelect?: (ids: string[]) => void;
  onMultiDragDelta?: (dnx: number, dny: number) => void;
  onMultiResizeDelta?: (scaleRatio: number, centerNx: number, centerNy: number) => void;
  onMultiRotateDelta?: (angleDeg: number, centerNx: number, centerNy: number) => void;
  onDuplicateSelected?: () => string[];
  onInteractionEnd?: () => void;
  onExpandArtboard?: () => void;
  onDesignContextMenu?: (x: number, y: number, designId: string | null) => void;
  spotPreviewData?: { enabled: boolean; colors: Array<{ hex: string; rgb: { r: number; g: number; b: number }; spotWhite?: boolean; spotGloss?: boolean; spotFluorY?: boolean; spotFluorM?: boolean; spotFluorG?: boolean; spotFluorOrange?: boolean }> };
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  ({ imageInfo, resizeSettings, artboardWidth = 24.5, artboardHeight = 12, designTransform, onTransformChange, designs = [], selectedDesignId, selectedDesignIds = new Set(), onSelectDesign, onMultiSelect, onMultiDragDelta, onMultiResizeDelta, onMultiRotateDelta, onDuplicateSelected, onInteractionEnd, onExpandArtboard, onDesignContextMenu, spotPreviewData }, ref) => {
    const { toast } = useToast();
    const { t, lang } = useLanguage();
    const isMobile = useIsMobile();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const resizeLimitToastRef = useRef(0);
    const zoomMax = Math.max(10, Math.ceil(artboardHeight / Math.max(artboardWidth, 0.1)) * 3);
    const zoomMaxRef = useRef(zoomMax);
    zoomMaxRef.current = zoomMax;
    const [zoom, setZoom] = useState(1);
    const zoomDpiTier = useMemo(() => (zoom <= 2 ? 1 : zoom <= 5 ? 2 : 3), [zoom]);
    const [panX, setPanX] = useState(0);
    const [panY, setPanY] = useState(0);
    const zoomRef = useRef(zoom);
    const panXRef = useRef(panX);
    const panYRef = useRef(panY);
    const pendingPanCommitRef = useRef<{ x: number; y: number } | null>(null);
    const panCommitRafRef = useRef<number | null>(null);
    const scrollDragRef = useRef<{ axis: 'x' | 'y'; startMouse: number; startScroll: number; maxScroll: number; scrollable: number } | null>(null);
    const nativeScrollRef = useRef<HTMLDivElement>(null);
    const syncingScrollRef = useRef(false);
    zoomRef.current = zoom;
    if (!scrollDragRef.current) {
      panXRef.current = panX;
      panYRef.current = panY;
    }
    const [selectionZoomActive, setSelectionZoomActive] = useState(false);
    const selectionZoomActiveRef = useRef(false);
    selectionZoomActiveRef.current = selectionZoomActive;
    const [moveMode, setMoveMode] = useState(false);
    const moveModeRef = useRef(false);
    moveModeRef.current = moveMode;
    const isSelectionZoomDragging = useRef(false);
    const suppressTransitionRef = useRef(false);
    const selZoomScreenStartRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const [selZoomRect, setSelZoomRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);
    const selZoomRectRef = useRef(selZoomRect);
    selZoomRectRef.current = selZoomRect;
    const canvasAreaRef = useRef<HTMLDivElement>(null);
    const dpiScaleRef = useRef(BASE_DPI_SCALE);
    const lastImageRef = useRef<string | null>(null);
    const [previewDims, setPreviewDims] = useState({ width: 360, height: 360 });
    const previewDimsRef = useRef(previewDims);
    previewDimsRef.current = previewDims;
    const spotPulseRef = useRef(1);
    const spotAnimFrameRef = useRef<number | null>(null);
    const spotOverlayCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
    const createSpotOverlayCanvasRef = useRef<((source?: HTMLImageElement | HTMLCanvasElement) => HTMLCanvasElement | null) | null>(null);

    const getMinZoom = useCallback(() => {
      const container = containerRef.current;
      if (!container) return ZOOM_MIN_ABSOLUTE;
      const dims = previewDimsRef.current;
      const padFraction = 0.03;
      const padX = Math.max(4, Math.round(dims.width * padFraction));
      const padY = Math.max(4, Math.round(dims.height * padFraction));
      const availW = container.clientWidth - padX * 2;
      const availH = container.clientHeight - padY * 2;
      if (availW <= 0 || availH <= 0 || dims.width <= 0 || dims.height <= 0) return ZOOM_MIN_ABSOLUTE;
      const fitScale = Math.min(availW / dims.width, availH / dims.height);
      return Math.max(ZOOM_MIN_ABSOLUTE, Math.round(fitScale * 20) / 20);
    }, []);
    const minZoomRef = useRef(1);

    // True when artboard width overflows viewport (left-click panning takes priority over design interaction)
    const isHorizOverflow = useCallback(() => {
      const el = canvasAreaRef.current;
      if (!el) return false;
      return zoomRef.current * previewDimsRef.current.width > el.clientWidth * 1.05;
    }, []);

    const getIdleCursor = useCallback(() => {
      if (isHorizOverflow() && !moveModeRef.current) return 'grab';
      return 'default';
    }, [isHorizOverflow]);


    const clampPanValue = useCallback((px: number, py: number, z: number) => {
      const dims = previewDimsRef.current;
      const el = canvasAreaRef.current;
      const vw = el ? el.clientWidth : dims.width;
      const vh = el ? el.clientHeight : dims.height;
      const maxPanX = Math.max(0, dims.width / 2 - vw / (2 * z));
      const maxPanY = Math.max(0, dims.height / 2 - vh / (2 * z));
      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, px)),
        y: Math.max(-maxPanY, Math.min(maxPanY, py)),
      };
    }, []);

    const getMaxPan = useCallback((axis: 'x' | 'y', z: number) => {
      const dims = previewDimsRef.current;
      const el = canvasAreaRef.current;
      if (axis === 'x') {
        const vw = el ? el.clientWidth : dims.width;
        return Math.max(0, dims.width / 2 - vw / (2 * z));
      } else {
        const vh = el ? el.clientHeight : dims.height;
        return Math.max(0, dims.height / 2 - vh / (2 * z));
      }
    }, []);

    const getScrollMetrics = useCallback((axis: 'x' | 'y', z: number) => {
      const dims = previewDimsRef.current;
      const el = canvasAreaRef.current;
      const viewport = axis === 'x'
        ? (el ? el.clientWidth : dims.width)
        : (el ? el.clientHeight : dims.height);
      const rendered = z * (axis === 'x' ? dims.width : dims.height);
      const maxScroll = Math.max(0, rendered - viewport);
      const rawThumbFrac = rendered > 0 ? Math.min(1, viewport / rendered) : 1;
      return { viewport, rendered, maxScroll, rawThumbFrac };
    }, []);

    const panToScroll = useCallback((axis: 'x' | 'y', panVal: number, z: number) => {
      const maxPan = getMaxPan(axis, z);
      const { maxScroll } = getScrollMetrics(axis, z);
      if (maxPan <= 0 || maxScroll <= 0) return 0;
      const t = Math.max(0, Math.min(1, (maxPan - panVal) / (2 * maxPan)));
      return t * maxScroll;
    }, [getMaxPan, getScrollMetrics]);

    const scrollToPan = useCallback((axis: 'x' | 'y', scrollVal: number, z: number) => {
      const maxPan = getMaxPan(axis, z);
      const { maxScroll } = getScrollMetrics(axis, z);
      if (maxPan <= 0 || maxScroll <= 0) return 0;
      const t = Math.max(0, Math.min(1, scrollVal / maxScroll));
      return maxPan * (1 - 2 * t);
    }, [getMaxPan, getScrollMetrics]);

    const [scrollbarHover, setScrollbarHover] = useState<'x' | 'y' | null>(null);
    const [activeScrollAxis, setActiveScrollAxis] = useState<'x' | 'y' | null>(null);
    const showDragPerfDebug = useMemo(() => {
      if (!import.meta.env.DEV || typeof window === 'undefined') return false;
      const params = new URLSearchParams(window.location.search);
      return params.get('dragPerf') === '1';
    }, []);
    const [dragPerfText, setDragPerfText] = useState('');
    const dragPerfRafRef = useRef<number | null>(null);
    const dragPerfLastTsRef = useRef<number | null>(null);
    const dragPerfSamplesRef = useRef<number[]>([]);
    const dragPerfLastCommitRef = useRef(0);
    const queuePanStateCommit = useCallback((x: number, y: number) => {
      panXRef.current = x;
      panYRef.current = y;
      pendingPanCommitRef.current = { x, y };
      if (panCommitRafRef.current != null) return;
      panCommitRafRef.current = requestAnimationFrame(() => {
        panCommitRafRef.current = null;
        const next = pendingPanCommitRef.current;
        if (!next) return;
        setPanX(next.x);
        setPanY(next.y);
      });
    }, []);

    const AUTOPAN_EDGE = 60;
    const AUTOPAN_MAX_SPEED = 8;

    const stopAutoPan = useCallback(() => {
      autoPanActiveRef.current = false;
      if (autoPanRafRef.current != null) {
        cancelAnimationFrame(autoPanRafRef.current);
        autoPanRafRef.current = null;
      }
    }, []);

    const tickAutoPan = useCallback(() => {
      if (!autoPanActiveRef.current) return;
      const el = canvasAreaRef.current;
      if (!el) { stopAutoPan(); return; }

      const rect = el.getBoundingClientRect();
      const mx = autoPanMouseRef.current.x;
      const my = autoPanMouseRef.current.y;
      const z = zoomRef.current;

      let dx = 0;
      let dy = 0;

      const distLeft = mx - rect.left;
      const distRight = rect.right - mx;
      const distTop = my - rect.top;
      const distBottom = rect.bottom - my;

      if (distLeft < AUTOPAN_EDGE) dx = AUTOPAN_MAX_SPEED * (1 - distLeft / AUTOPAN_EDGE);
      else if (distRight < AUTOPAN_EDGE) dx = -AUTOPAN_MAX_SPEED * (1 - distRight / AUTOPAN_EDGE);
      if (distTop < AUTOPAN_EDGE) dy = AUTOPAN_MAX_SPEED * (1 - distTop / AUTOPAN_EDGE);
      else if (distBottom < AUTOPAN_EDGE) dy = -AUTOPAN_MAX_SPEED * (1 - distBottom / AUTOPAN_EDGE);

      if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1) {
        autoPanRafRef.current = requestAnimationFrame(tickAutoPan);
        return;
      }

      const oldPx = panXRef.current;
      const oldPy = panYRef.current;
      const rawPx = oldPx + dx / z;
      const rawPy = oldPy + dy / z;
      const clamped = clampPanValue(rawPx, rawPy, z);

      const actualDpx = clamped.x - oldPx;
      const actualDpy = clamped.y - oldPy;
      const panChanged = Math.abs(actualDpx) > 0.01 || Math.abs(actualDpy) > 0.01;

      if (panChanged) {
        queuePanStateCommit(clamped.x, clamped.y);

        const screenShiftX = actualDpx * z;
        const screenShiftY = actualDpy * z;

        if (isDraggingRef.current) {
          dragStartMouseRef.current = {
            x: dragStartMouseRef.current.x + screenShiftX,
            y: dragStartMouseRef.current.y + screenShiftY,
          };
        }

        if (isMultiDragRef.current) {
          multiDragStartRef.current = {
            x: multiDragStartRef.current.x + screenShiftX,
            y: multiDragStartRef.current.y + screenShiftY,
          };
        }

        handleInteractionMoveRef.current?.(mx, my);
      }

      autoPanRafRef.current = requestAnimationFrame(tickAutoPan);
    }, [clampPanValue, queuePanStateCommit, stopAutoPan]);

    const startAutoPan = useCallback((clientX: number, clientY: number) => {
      autoPanMouseRef.current = { x: clientX, y: clientY };
      if (!autoPanActiveRef.current) {
        autoPanActiveRef.current = true;
        autoPanRafRef.current = requestAnimationFrame(tickAutoPan);
      }
    }, [tickAutoPan]);

    const updateAutoPanMouse = useCallback((clientX: number, clientY: number) => {
      autoPanMouseRef.current = { x: clientX, y: clientY };
    }, []);

    useEffect(() => {
      if (!showDragPerfDebug) return;
      const loop = (ts: number) => {
        const prev = dragPerfLastTsRef.current;
        if (prev != null) {
          const dt = ts - prev;
          if (dt > 0 && dt < 1000) {
            const samples = dragPerfSamplesRef.current;
            samples.push(dt);
            if (samples.length > 120) samples.shift();
          }
        }
        dragPerfLastTsRef.current = ts;

        const active = !!scrollDragRef.current || isPanningRef.current;
        if (active && ts - dragPerfLastCommitRef.current > 250) {
          const samples = dragPerfSamplesRef.current;
          if (samples.length > 0) {
            const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
            const fps = avgMs > 0 ? 1000 / avgMs : 0;
            const p95 = [...samples].sort((a, b) => a - b)[Math.max(0, Math.floor(samples.length * 0.95) - 1)];
            setDragPerfText(`drag fps ${Math.round(fps)} | avg ${avgMs.toFixed(1)}ms | p95 ${p95.toFixed(1)}ms`);
            dragPerfLastCommitRef.current = ts;
          }
        } else if (!active && dragPerfText) {
          setDragPerfText('');
        }

        dragPerfRafRef.current = requestAnimationFrame(loop);
      };
      dragPerfRafRef.current = requestAnimationFrame(loop);
      return () => {
        if (dragPerfRafRef.current != null) {
          cancelAnimationFrame(dragPerfRafRef.current);
          dragPerfRafRef.current = null;
        }
      };
    }, [dragPerfText, showDragPerfDebug]);
    const renderRef = useRef<(() => void) | null>(null);
    
    const checkerboardPatternRef = useRef<{width: number; height: number; pattern: CanvasPattern} | null>(null);
    const lastCanvasDimsRef = useRef<{width: number; height: number}>({width: 0, height: 0});
    
    const [editingRotation, setEditingRotation] = useState(false);
    const [rotationInput, setRotationInput] = useState('0');
    const [overlappingDesigns, setOverlappingDesigns] = useState<Set<string>>(new Set());
    const [previewBgColor, setPreviewBgColor] = useState('#d1d5db');
    const isDraggingRef = useRef(false);
    const isResizingRef = useRef(false);
    const isRotatingRef = useRef(false);
    const activeResizeHandleRef = useRef<string>('br');
    const shiftKeyRef = useRef(false);
    const isPanningRef = useRef(false);
    const panStartRef = useRef<{x: number; y: number; px: number; py: number}>({x: 0, y: 0, px: 0, py: 0});
    const spaceDownRef = useRef(false);
    const isKeyboardScopeActiveRef = useRef(false);
    const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isWheelZoomingRef = useRef(false);
    const snapGuidesRef = useRef<Array<{axis: 'x' | 'y'; pos: number}>>([]);
    const dragStartMouseRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const dragStartTransformRef = useRef<ImageTransform>({nx: 0.5, ny: 0.5, s: 1, rotation: 0});
    const resizeStartDistRef = useRef(0);
    const resizeStartSRef = useRef(1);
    const resizeCommittedRef = useRef(false);
    const resizeStartScreenCenterRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const rotateStartAngleRef = useRef(0);
    const rotateStartRotationRef = useRef(0);
    const rotateStartCanvasCenterRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const transformRef = useRef<ImageTransform>(designTransform || {nx: 0.5, ny: 0.5, s: 1, rotation: 0});
    const onTransformChangeRef = useRef(onTransformChange);
    onTransformChangeRef.current = onTransformChange;
    const handleInteractionMoveRef = useRef<((cx: number, cy: number) => void) | null>(null);
    const handleInteractionEndRef = useRef<(() => void) | null>(null);

    const autoPanRafRef = useRef<number | null>(null);
    const autoPanMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const autoPanActiveRef = useRef(false);

    const isMarqueeRef = useRef(false);
    const marqueeStartRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const marqueeEndRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const [marqueeRect, setMarqueeRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);
    const marqueeScreenStartRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const [marqueeScreenRect, setMarqueeScreenRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);

    const isMultiDragRef = useRef(false);
    const multiDragStartRef = useRef<{x: number; y: number}>({x: 0, y: 0});

    const isMultiResizeRef = useRef(false);
    const isMultiRotateRef = useRef(false);
    const multiResizeStartDistRef = useRef(0);
    const multiResizeStartScreenCenterRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const multiRotateStartAngleRef = useRef(0);
    const multiGroupCenterBufferRef = useRef<{x: number; y: number}>({x: 0, y: 0});

    const overlapCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const bottomGlowRef = useRef(0);
    const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const expandTimerStartRef = useRef<number>(0);
    const glowAnimRef = useRef<number | null>(null);
    const onExpandArtboardRef = useRef(onExpandArtboard);
    onExpandArtboardRef.current = onExpandArtboard;
    const bottomGlowActiveRef = useRef(false);

    const startBottomGlow = useCallback(() => {
      if (bottomGlowActiveRef.current) return;
      bottomGlowActiveRef.current = true;
      expandTimerStartRef.current = Date.now();
      const tick = () => {
        if (!bottomGlowActiveRef.current) return;
        const elapsed = Date.now() - expandTimerStartRef.current;
        bottomGlowRef.current = Math.min(1, elapsed / 1900);
        renderRef.current?.();
        glowAnimRef.current = requestAnimationFrame(tick);
      };
      glowAnimRef.current = requestAnimationFrame(tick);
      expandTimerRef.current = setTimeout(() => {
        onExpandArtboardRef.current?.();
        stopBottomGlow();
      }, 1900);
    }, []);

    const stopBottomGlow = useCallback(() => {
      bottomGlowActiveRef.current = false;
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
      if (glowAnimRef.current !== null) {
        cancelAnimationFrame(glowAnimRef.current);
        glowAnimRef.current = null;
      }
      bottomGlowRef.current = 0;
      renderRef.current?.();
    }, []);
    useEffect(() => () => stopBottomGlow(), [stopBottomGlow]);

    const altDragDuplicatedRef = useRef(false);
    const altKeyRef = useRef(false);
    const altKeyAtDragStartRef = useRef(false);

    useEffect(() => {
      transformRef.current = designTransform || { nx: 0.5, ny: 0.5, s: 1, rotation: 0 };
    }, [designTransform]);

    useEffect(() => {
      const onKeyDown = (e: KeyboardEvent) => {
        // Always track Alt globally so alt+drag duplication is reliable
        altKeyRef.current = e.altKey;
        const dupFromKey = (isDraggingRef.current || isMultiDragRef.current) && e.altKey && !altDragDuplicatedRef.current;
        if (dupFromKey) {
          e.preventDefault();
          altDragDuplicatedRef.current = true;
          onDuplicateSelected?.();
        }

        if (e.key === 'Escape' && selectionZoomActiveRef.current) {
          setSelectionZoomActive(false);
          isSelectionZoomDragging.current = false;
          setSelZoomRect(null);
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = getIdleCursor();
          return;
        }
        if (!isKeyboardScopeActiveRef.current) return;
        shiftKeyRef.current = e.shiftKey;
        if (e.code === 'Space' && !spaceDownRef.current) {
          spaceDownRef.current = true;
          e.preventDefault();
        }
      };
      const onKeyUp = (e: KeyboardEvent) => {
        // Keep Alt state in sync even if keyboard scope is inactive
        altKeyRef.current = e.altKey;
        if (!isKeyboardScopeActiveRef.current) return;
        shiftKeyRef.current = e.shiftKey;
        if (e.code === 'Space') {
          spaceDownRef.current = false;
          isPanningRef.current = false;
          if (canvasAreaRef.current && !selectionZoomActiveRef.current) {
            canvasAreaRef.current.style.cursor = getIdleCursor();
          }
        }
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
    }, [onDuplicateSelected]);

    const getDesignRect = useCallback(() => {
      if (!imageInfo || !designTransform) return null;
      const canvas = canvasRef.current;
      if (!canvas) return null;
      return computeLayerRect(
        imageInfo.image.width, imageInfo.image.height,
        transformRef.current,
        canvas.width, canvas.height,
        artboardWidth, artboardHeight,
        resizeSettings.widthInches, resizeSettings.heightInches,
      );
    }, [imageInfo, designTransform, artboardWidth, artboardHeight, resizeSettings.widthInches, resizeSettings.heightInches]);

    const hitTestDesign = useCallback((px: number, py: number): boolean => {
      const rect = getDesignRect();
      if (!rect) return false;
      const t = transformRef.current;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rad = -(t.rotation * Math.PI) / 180;
      const dx = px - cx;
      const dy = py - cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      return Math.abs(lx) <= rect.width / 2 && Math.abs(ly) <= rect.height / 2;
    }, [getDesignRect]);

    const isClickInDesignInterior = useCallback((px: number, py: number): boolean => {
      const rect = getDesignRect();
      if (!rect) return false;
      const z = Math.max(0.25, zoomRef.current);
      const inv = dpiScaleRef.current / z;
      const margin = Math.min(10 * inv, Math.min(rect.width, rect.height) * 0.25);
      const t = transformRef.current;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const rad = -(t.rotation * Math.PI) / 180;
      const dx = px - cx;
      const dy = py - cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      return Math.abs(lx) <= (rect.width / 2 - margin) && Math.abs(ly) <= (rect.height / 2 - margin);
    }, [getDesignRect]);

    const getHandlePositions = useCallback(() => {
      const rect = getDesignRect();
      if (!rect) return [];
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const hw = rect.width / 2;
      const hh = rect.height / 2;
      const rad = (transformRef.current.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const corners = [
        { lx: -hw, ly: -hh, id: 'tl' },
        { lx: hw, ly: -hh, id: 'tr' },
        { lx: hw, ly: hh, id: 'br' },
        { lx: -hw, ly: hh, id: 'bl' },
      ];
      return corners.map(c => ({
        x: cx + c.lx * cos - c.ly * sin,
        y: cy + c.lx * sin + c.ly * cos,
        id: c.id,
      }));
    }, [getDesignRect]);

    const hitTestHandles = useCallback((px: number, py: number): { type: 'resize' | 'rotate'; id: string } | null => {
      const handles = getHandlePositions();
      if (handles.length === 0) return null;
      const rect = getDesignRect();
      if (!rect) return null;
      const z = Math.max(0.25, zoomRef.current);
      const inv = dpiScaleRef.current / z;
      const resizeR = 7 * inv;
      const rotateOuterR = 18 * inv;

      const tl = handles.find(h => h.id === 'tl');
      const tr = handles.find(h => h.id === 'tr');
      if (tl && tr) {
        const topMidX = (tl.x + tr.x) / 2;
        const topMidY = (tl.y + tr.y) / 2;
        const rad = (transformRef.current.rotation * Math.PI) / 180;
        const rotDist = 24 * inv;
        const rotHandleX = topMidX + (-Math.sin(rad)) * rotDist;
        const rotHandleY = topMidY + (-Math.cos(rad)) * rotDist;
        if (Math.sqrt((px - rotHandleX) ** 2 + (py - rotHandleY) ** 2) < resizeR) {
          return { type: 'rotate', id: 'rot-top' };
        }
      }

      const brResizeR = isMobile ? resizeR * 2 : resizeR;
      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        const r = h.id === 'br' ? brResizeR : resizeR;
        if (d < r) {
          return { type: 'resize', id: h.id };
        }
      }

      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        const r = h.id === 'br' ? brResizeR : resizeR;
        if (d >= r && d < rotateOuterR) {
          return { type: 'rotate', id: `rot-${h.id}` };
        }
      }

      return null;
    }, [getHandlePositions, getDesignRect, isMobile]);

    // Group bounding box in canvas buffer space for multi-selection
    const getMultiSelectionBBox = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas || selectedDesignIds.size < 2) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const d of designs) {
        if (!selectedDesignIds.has(d.id)) continue;
        const r = computeLayerRect(
          d.imageInfo.image.width, d.imageInfo.image.height,
          d.transform, canvas.width, canvas.height,
          artboardWidth, artboardHeight, d.widthInches, d.heightInches,
        );
        const cx = r.x + r.width / 2;
        const cy = r.y + r.height / 2;
        const hw = r.width / 2;
        const hh = r.height / 2;
        const rad = (d.transform.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const corners = [
          { lx: -hw, ly: -hh }, { lx: hw, ly: -hh },
          { lx: hw, ly: hh }, { lx: -hw, ly: hh },
        ];
        for (const c of corners) {
          const px = cx + c.lx * cos - c.ly * sin;
          const py = cy + c.lx * sin + c.ly * cos;
          minX = Math.min(minX, px);
          minY = Math.min(minY, py);
          maxX = Math.max(maxX, px);
          maxY = Math.max(maxY, py);
        }
      }
      if (!isFinite(minX)) return null;
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }, [designs, selectedDesignIds, artboardWidth, artboardHeight]);

    const getMultiHandlePositions = useCallback(() => {
      const bbox = getMultiSelectionBBox();
      if (!bbox) return [];
      return [
        { x: bbox.x, y: bbox.y, id: 'tl' },
        { x: bbox.x + bbox.width, y: bbox.y, id: 'tr' },
        { x: bbox.x + bbox.width, y: bbox.y + bbox.height, id: 'br' },
        { x: bbox.x, y: bbox.y + bbox.height, id: 'bl' },
      ];
    }, [getMultiSelectionBBox]);

    const hitTestMultiHandles = useCallback((px: number, py: number): { type: 'resize' | 'rotate'; id: string } | null => {
      const handles = getMultiHandlePositions();
      if (handles.length === 0) return null;
      const z = Math.max(0.25, zoomRef.current);
      const inv = dpiScaleRef.current / z;
      const resizeR = 9 * inv;
      const rotateOuterR = 20 * inv;

      // Rotation handle at top-center
      const tl = handles.find(h => h.id === 'tl');
      const tr = handles.find(h => h.id === 'tr');
      if (tl && tr) {
        const topMidX = (tl.x + tr.x) / 2;
        const topMidY = (tl.y + tr.y) / 2;
        const rotDist = 26 * inv;
        const rotHandleX = topMidX;
        const rotHandleY = topMidY - rotDist;
        if (Math.sqrt((px - rotHandleX) ** 2 + (py - rotHandleY) ** 2) < resizeR) {
          return { type: 'rotate', id: 'rot-top' };
        }
      }

      const brResizeR = isMobile ? resizeR * 2 : resizeR;
      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        const r = h.id === 'br' ? brResizeR : resizeR;
        if (d < r) {
          return { type: 'resize', id: h.id };
        }
      }

      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        const r = h.id === 'br' ? brResizeR : resizeR;
        if (d >= r && d < rotateOuterR) {
          return { type: 'rotate', id: `rot-${h.id}` };
        }
      }

      return null;
    }, [getMultiHandlePositions, isMobile]);

    const canvasToLocal = useCallback((clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const canvasRect = canvas.getBoundingClientRect();
      const x = ((clientX - canvasRect.left) / canvasRect.width) * canvas.width;
      const y = ((clientY - canvasRect.top) / canvasRect.height) * canvas.height;
      return { x, y };
    }, []);

    const getMaxScaleForArtboard = useCallback((t: ImageTransform, wInches?: number, hInches?: number): number => {
      const wi = wInches ?? resizeSettings.widthInches;
      const hi = hInches ?? resizeSettings.heightInches;
      if (!wi || !hi) return 10;
      const rad = (t.rotation * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const rotW = wi * cos + hi * sin;
      const rotH = wi * sin + hi * cos;
      const maxSx = artboardWidth / rotW;
      const maxSy = artboardHeight / rotH;
      return Math.min(maxSx, maxSy);
    }, [artboardWidth, artboardHeight, resizeSettings.widthInches, resizeSettings.heightInches]);

    const clampTransformToArtboard = useCallback((t: ImageTransform, opts?: { clampScale?: boolean; imgW?: number; imgH?: number; wInches?: number; hInches?: number }): ImageTransform => {
      const canvas = canvasRef.current;
      const iw = opts?.imgW ?? imageInfo?.image.width;
      const ih = opts?.imgH ?? imageInfo?.image.height;
      const wi = opts?.wInches ?? resizeSettings.widthInches;
      const hi = opts?.hInches ?? resizeSettings.heightInches;
      const shouldClampScale = opts?.clampScale ?? false;
      if (!canvas || !iw || !ih) return t;

      let clamped = t;
      if (shouldClampScale) {
        const maxS = getMaxScaleForArtboard(t, wi, hi);
        const clampedS = Math.min(t.s, maxS);
        if (clampedS !== t.s) clamped = { ...t, s: clampedS };
      }

      const rect = computeLayerRect(iw, ih, clamped, canvas.width, canvas.height, artboardWidth, artboardHeight, wi, hi);
      const rad = (clamped.rotation * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const rotW = rect.width * cos + rect.height * sin;
      const rotH = rect.width * sin + rect.height * cos;

      const cx = clamped.nx * canvas.width;
      const cy = clamped.ny * canvas.height;
      const halfW = rotW / 2;
      const halfH = rotH / 2;

      let newCx = cx;
      let newCy = cy;

      // If the design fits within the artboard, clamp normally.
      // If it's too large, allow positioning anywhere within the artboard
      // center range so the user can still drag it.
      if (rotW <= canvas.width) {
        if (cx - halfW < 0) newCx = halfW;
        if (cx + halfW > canvas.width) newCx = canvas.width - halfW;
      } else {
        newCx = Math.max(canvas.width - halfW, Math.min(halfW, cx));
      }
      if (rotH <= canvas.height) {
        if (cy - halfH < 0) newCy = halfH;
        if (cy + halfH > canvas.height) newCy = canvas.height - halfH;
      } else {
        newCy = Math.max(canvas.height - halfH, Math.min(halfH, cy));
      }

      return { ...clamped, nx: newCx / canvas.width, ny: newCy / canvas.height };
    }, [imageInfo, artboardWidth, artboardHeight, resizeSettings.widthInches, resizeSettings.heightInches, getMaxScaleForArtboard]);

    const overlappingDesignsRef = useRef(overlappingDesigns);
    overlappingDesignsRef.current = overlappingDesigns;

    const overlapWorkerRef = useRef<Worker | null>(null);
    const overlapRequestIdRef = useRef(0);
    const overlapHandlerRef = useRef<((ev: MessageEvent) => void) | null>(null);
    useEffect(() => {
      try {
        overlapWorkerRef.current = new Worker(
          new URL('../lib/overlap-worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch { /* OffscreenCanvas not supported — fallback to main thread */ }
      return () => {
        const w = overlapWorkerRef.current;
        const h = overlapHandlerRef.current;
        if (w && h) w.removeEventListener('message', h);
        overlapHandlerRef.current = null;
        overlapWorkerRef.current?.terminate();
      };
    }, []);

    const checkPixelOverlap = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (designs.length === 0) {
        if (overlappingDesignsRef.current.size > 0) {
          setOverlappingDesigns(new Set());
        }
        return;
      }

      const scale = 0.25;
      const sw = Math.max(60, Math.round(canvas.width * scale));
      const sh = Math.max(30, Math.round(canvas.height * scale));

      const designRects: Array<{id: string; left: number; top: number; right: number; bottom: number; design: DesignItem; rect: {x: number; y: number; width: number; height: number}}> = [];
      for (const d of designs) {
        const rect = computeLayerRect(
          d.imageInfo.image.width, d.imageInfo.image.height,
          d.transform, sw, sh,
          artboardWidth, artboardHeight,
          d.widthInches, d.heightInches,
        );
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const rad = Math.abs(d.transform.rotation * Math.PI / 180);
        const cos = Math.abs(Math.cos(rad));
        const sin = Math.abs(Math.sin(rad));
        const rotW = rect.width * cos + rect.height * sin;
        const rotH = rect.width * sin + rect.height * cos;
        designRects.push({ id: d.id, left: cx - rotW / 2, top: cy - rotH / 2, right: cx + rotW / 2, bottom: cy + rotH / 2, design: d, rect });
      }

      const outOfBounds = new Set<string>();
      for (const dr of designRects) {
        if (dr.left < -1 || dr.top < -1 || dr.right > sw + 1 || dr.bottom > sh + 1) {
          outOfBounds.add(dr.id);
        }
      }

      if (designs.length < 2) {
        const prev = overlappingDesignsRef.current;
        if (outOfBounds.size !== prev.size || Array.from(outOfBounds).some(id => !prev.has(id))) {
          setOverlappingDesigns(outOfBounds);
        }
        return;
      }

      const aabbPairs: [number, number][] = [];
      for (let i = 0; i < designRects.length; i++) {
        for (let j = i + 1; j < designRects.length; j++) {
          const a = designRects[i], b = designRects[j];
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
            aabbPairs.push([i, j]);
          }
        }
      }

      if (aabbPairs.length === 0 && outOfBounds.size === 0) {
        if (overlappingDesignsRef.current.size > 0) setOverlappingDesigns(new Set());
        return;
      }
      if (aabbPairs.length === 0) {
        const prev = overlappingDesignsRef.current;
        if (outOfBounds.size !== prev.size || Array.from(outOfBounds).some(id => !prev.has(id))) {
          setOverlappingDesigns(outOfBounds);
        }
        return;
      }

      const neededSet = new Set<number>();
      for (const [i, j] of aabbPairs) { neededSet.add(i); neededSet.add(j); }

      const worker = overlapWorkerRef.current;
      if (worker && typeof createImageBitmap !== 'undefined') {
        const neededArr = Array.from(neededSet);
        const bitmapPromises = neededArr.map(async (idx) => {
          const d = designRects[idx].design;
          const bmp = await createImageBitmap(d.imageInfo.image);
          return { idx, bmp };
        });
        overlapRequestIdRef.current += 1;
        const myRequestId = overlapRequestIdRef.current;
        Promise.all(bitmapPromises).then(bitmaps => {
          const bmpMap = new Map(bitmaps.map(b => [b.idx, b.bmp]));
          const workerDesigns = designRects.map((dr, idx) => ({
            id: dr.id,
            left: dr.left, top: dr.top, right: dr.right, bottom: dr.bottom,
            imgBitmap: bmpMap.get(idx) ?? (null as unknown as ImageBitmap),
            drawX: dr.rect.x, drawY: dr.rect.y,
            drawW: dr.rect.width, drawH: dr.rect.height,
            rotation: dr.design.transform.rotation,
            cx: dr.rect.x + dr.rect.width / 2,
            cy: dr.rect.y + dr.rect.height / 2,
          }));

          const handler = (ev: MessageEvent) => {
            if (ev.data.type === 'result') {
              worker.removeEventListener('message', handler);
              overlapHandlerRef.current = null;
              if (myRequestId !== overlapRequestIdRef.current) return;
              const workerOverlapping = new Set<string>(ev.data.overlapping as string[]);
              for (const id of outOfBounds) workerOverlapping.add(id);
              const prev = overlappingDesignsRef.current;
              if (workerOverlapping.size !== prev.size || Array.from(workerOverlapping).some(id => !prev.has(id))) {
                setOverlappingDesigns(workerOverlapping);
              }
            } else if (ev.data.type === 'error') {
              worker.removeEventListener('message', handler);
              overlapHandlerRef.current = null;
              const err = (ev.data as { error?: string }).error;
              console.warn('Overlap worker error:', err);
              runMainThreadOverlap();
            }
          };
          overlapHandlerRef.current = handler;
          worker.addEventListener('message', handler);
          const transferable = Array.from(bmpMap.values());
          worker.postMessage({ type: 'check', designs: workerDesigns, sw, sh }, transferable as Transferable[]);
        }).catch((err) => {
          if (myRequestId !== overlapRequestIdRef.current) return;
          console.warn('Overlap worker fallback:', err);
          runMainThreadOverlap();
        });
        return;
      }

      runMainThreadOverlap();

      function runMainThreadOverlap() {
        try {
        const needed = Array.from(neededSet);
        const alphaBuffers = new Map<number, Uint8ClampedArray>();
        for (const idx of needed) {
          const d = designRects[idx].design;
          const offscreen = document.createElement('canvas');
          offscreen.width = sw;
          offscreen.height = sh;
          const octx = offscreen.getContext('2d');
          if (!octx) continue;
          const rect = computeLayerRect(
            d.imageInfo.image.width, d.imageInfo.image.height,
            d.transform, sw, sh,
            artboardWidth, artboardHeight,
            d.widthInches, d.heightInches,
          );
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          octx.save();
          octx.translate(cx, cy);
          octx.rotate((d.transform.rotation * Math.PI) / 180);
          try {
            octx.drawImage(d.imageInfo.image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
            octx.restore();
            alphaBuffers.set(idx, octx.getImageData(0, 0, sw, sh).data);
          } catch { octx.restore(); continue; }
        }

        const overlapping = new Set<string>(outOfBounds);
        for (const [i, j] of aabbPairs) {
          const a = alphaBuffers.get(i);
          const b = alphaBuffers.get(j);
          if (!a || !b) continue;
          let found = false;
          for (let p = 3; p < a.length; p += 16) {
            if (a[p] > 20 && b[p] > 20) { found = true; break; }
          }
          if (!found) {
            for (let p = 3; p < a.length; p += 4) {
              if (a[p] > 20 && b[p] > 20) { found = true; break; }
            }
          }
          if (found) {
            overlapping.add(designRects[i].id);
            overlapping.add(designRects[j].id);
          }
        }

        const prev = overlappingDesignsRef.current;
        if (overlapping.size !== prev.size || Array.from(overlapping).some(id => !prev.has(id))) {
          setOverlappingDesigns(overlapping);
        }
        } catch (err) { console.warn('Main-thread overlap detection failed:', err); }
      }
    }, [designs, artboardWidth, artboardHeight]);

    const findDesignAtPoint = useCallback((px: number, py: number): string | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      for (let i = designs.length - 1; i >= 0; i--) {
        const d = designs[i];
        const rect = computeLayerRect(
          d.imageInfo.image.width, d.imageInfo.image.height,
          d.transform, canvas.width, canvas.height,
          artboardWidth, artboardHeight,
          d.widthInches, d.heightInches,
        );
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const rad = -(d.transform.rotation * Math.PI) / 180;
        const dx = px - cx;
        const dy = py - cy;
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        if (Math.abs(lx) <= rect.width / 2 && Math.abs(ly) <= rect.height / 2) {
          return d.id;
        }
      }
      return null;
    }, [designs, artboardWidth, artboardHeight]);

    const handleInteractionStart = useCallback((clientX: number, clientY: number, ctrlKey = false, altKey = false) => {
      const local = canvasToLocal(clientX, clientY);
      const canvas = canvasRef.current;
      if (!canvas) return;

      // Ctrl+Click toggles multi-selection on any design
      if (ctrlKey) {
        const hitId = findDesignAtPoint(local.x, local.y);
        if (hitId) {
          const current = new Set(selectedDesignIds);
          if (selectedDesignId && !current.has(selectedDesignId)) current.add(selectedDesignId);
          if (current.has(hitId)) {
            current.delete(hitId);
          } else {
            current.add(hitId);
          }
          onMultiSelect?.(Array.from(current));
          return;
        }
      }

      // Group handles take priority when multiple designs are selected
      if (selectedDesignIds.size > 1) {
        // When Alt is held, prefer multi-drag (for alt+drag duplicate) over group handles
        const hitIdMulti = findDesignAtPoint(local.x, local.y);
        if (altKey && hitIdMulti && selectedDesignIds.has(hitIdMulti)) {
          altKeyAtDragStartRef.current = true;
          isMultiDragRef.current = true;
          multiDragStartRef.current = { x: clientX, y: clientY };
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          return;
        }

        const multiHit = hitTestMultiHandles(local.x, local.y);
        if (multiHit && altKey && hitIdMulti && selectedDesignIds.has(hitIdMulti)) {
          altKeyAtDragStartRef.current = true;
          isMultiDragRef.current = true;
          multiDragStartRef.current = { x: clientX, y: clientY };
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          return;
        }
        if (multiHit) {
          const bbox = getMultiSelectionBBox();
          if (bbox && canvas) {
            const gcx = bbox.x + bbox.width / 2;
            const gcy = bbox.y + bbox.height / 2;
            multiGroupCenterBufferRef.current = { x: gcx, y: gcy };
            const canvasRect = canvas.getBoundingClientRect();
            const screenGcx = canvasRect.left + (gcx / canvas.width) * canvasRect.width;
            const screenGcy = canvasRect.top + (gcy / canvas.height) * canvasRect.height;

            if (multiHit.type === 'resize') {
              isMultiResizeRef.current = true;
              resizeCommittedRef.current = false;
              multiResizeStartScreenCenterRef.current = { x: screenGcx, y: screenGcy };
              multiResizeStartDistRef.current = Math.sqrt((clientX - screenGcx) ** 2 + (clientY - screenGcy) ** 2);
              activeResizeHandleRef.current = multiHit.id;
              if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = getResizeCursor(multiHit.id, 0);
            } else {
              isMultiRotateRef.current = true;
              multiRotateStartAngleRef.current = Math.atan2(local.y - gcy, local.x - gcx);
              if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = ROTATE_CURSOR;
            }
          }
          return;
        }

        // Multi-drag: click on any selected design body
        const hitId = findDesignAtPoint(local.x, local.y);
        if (hitId && selectedDesignIds.has(hitId)) {
          isMultiDragRef.current = true;
          multiDragStartRef.current = { x: clientX, y: clientY };
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          return;
        }

        // Click on unselected design or empty space — break multi-selection
        if (hitId) {
          onSelectDesign?.(hitId);
          return;
        }
        onSelectDesign?.(null);
        isMarqueeRef.current = true;
        marqueeStartRef.current = { x: local.x, y: local.y };
        marqueeEndRef.current = { x: local.x, y: local.y };
        setMarqueeRect(null);
        { const area = canvasAreaRef.current;
          if (area) {
            const ar = area.getBoundingClientRect();
            marqueeScreenStartRef.current = { x: clientX - ar.left, y: clientY - ar.top };
            area.style.cursor = 'crosshair';
          }
        }
        setMarqueeScreenRect(null);
        return;
      }

      if (selectedDesignId && imageInfo && onTransformChange) {
        const hitD = hitTestDesign(local.x, local.y);
        const hitIdAtPoint = findDesignAtPoint(local.x, local.y);
        // When Alt is held, prefer drag (for alt+drag duplicate) over resize/rotate handles
        if (altKey && (hitD || hitIdAtPoint === selectedDesignId)) {
          altKeyAtDragStartRef.current = true;
          isDraggingRef.current = true;
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          dragStartMouseRef.current = { x: clientX, y: clientY };
          dragStartTransformRef.current = { ...transformRef.current };
          return;
        }

        const handleHit = hitTestHandles(local.x, local.y);

        // When Alt is held, prefer drag (duplicate) even when clicking on a handle
        if (handleHit && altKey) {
          isDraggingRef.current = true;
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          dragStartMouseRef.current = { x: clientX, y: clientY };
          dragStartTransformRef.current = { ...transformRef.current };
          return;
        }

        if (handleHit && handleHit.type === 'resize' && isClickInDesignInterior(local.x, local.y)) {
          altKeyAtDragStartRef.current = false;
          isDraggingRef.current = true;
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          dragStartMouseRef.current = { x: clientX, y: clientY };
          dragStartTransformRef.current = { ...transformRef.current };
          return;
        }

        if (handleHit) {
          if (handleHit.type === 'resize') {
            isResizingRef.current = true;
            resizeCommittedRef.current = false;
            activeResizeHandleRef.current = handleHit.id;
            if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = getResizeCursor(handleHit.id, transformRef.current.rotation);
            const rect = getDesignRect();
            if (rect && canvas) {
              const cx = rect.x + rect.width / 2;
              const cy = rect.y + rect.height / 2;
              const canvasRect = canvas.getBoundingClientRect();
              const screenCx = canvasRect.left + (cx / canvas.width) * canvasRect.width;
              const screenCy = canvasRect.top + (cy / canvas.height) * canvasRect.height;
              resizeStartScreenCenterRef.current = { x: screenCx, y: screenCy };
              resizeStartDistRef.current = Math.sqrt((clientX - screenCx) ** 2 + (clientY - screenCy) ** 2);
              resizeStartSRef.current = transformRef.current.s;
            }
          } else {
            isRotatingRef.current = true;
            if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = ROTATE_CURSOR;
            const rect = getDesignRect();
            if (rect) {
              const cx = rect.x + rect.width / 2;
              const cy = rect.y + rect.height / 2;
              rotateStartCanvasCenterRef.current = { x: cx, y: cy };
              rotateStartAngleRef.current = Math.atan2(local.y - cy, local.x - cx);
              rotateStartRotationRef.current = transformRef.current.rotation;
            }
          }
          return;
        }

        if (hitD) {
          altKeyAtDragStartRef.current = false;
          isDraggingRef.current = true;
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          dragStartMouseRef.current = { x: clientX, y: clientY };
          dragStartTransformRef.current = { ...transformRef.current };
          return;
        }
      }

      const hitId = findDesignAtPoint(local.x, local.y);

      if (hitId) {
        if (hitId !== selectedDesignId) {
          if (altKey && onSelectDesign && onTransformChange) {
            const design = designs.find(d => d.id === hitId);
            if (design) {
              altKeyAtDragStartRef.current = true;
              onSelectDesign(hitId);
              const t = { ...design.transform };
              transformRef.current = t;
              dragStartTransformRef.current = t;
              isDraggingRef.current = true;
              altDragDuplicatedRef.current = false;
              dragStartMouseRef.current = { x: clientX, y: clientY };
              if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
              return;
            }
          }
          onSelectDesign?.(hitId);
        } else {
          altKeyAtDragStartRef.current = altKey;
          isDraggingRef.current = true;
          altDragDuplicatedRef.current = false;
          if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'move';
          dragStartMouseRef.current = { x: clientX, y: clientY };
          dragStartTransformRef.current = { ...transformRef.current };
        }
        return;
      }

      onSelectDesign?.(null);
      isMarqueeRef.current = true;
      marqueeStartRef.current = { x: local.x, y: local.y };
      marqueeEndRef.current = { x: local.x, y: local.y };
      setMarqueeRect(null);
      { const area = canvasAreaRef.current;
        if (area) {
          const ar = area.getBoundingClientRect();
          marqueeScreenStartRef.current = { x: clientX - ar.left, y: clientY - ar.top };
          area.style.cursor = 'crosshair';
        }
      }
      setMarqueeScreenRect(null);
    }, [imageInfo, onTransformChange, canvasToLocal, hitTestHandles, hitTestDesign, isClickInDesignInterior, getDesignRect, selectedDesignId, selectedDesignIds, findDesignAtPoint, onSelectDesign, onMultiSelect, hitTestMultiHandles, getMultiSelectionBBox, designs]);

    const handleInteractionMove = useCallback((clientX: number, clientY: number, altKeyFromEvent?: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      if (isMarqueeRef.current) {
        const local = canvasToLocal(clientX, clientY);
        marqueeEndRef.current = { x: local.x, y: local.y };
        const sx = marqueeStartRef.current.x;
        const sy = marqueeStartRef.current.y;
        setMarqueeRect({
          x: Math.min(sx, local.x),
          y: Math.min(sy, local.y),
          w: Math.abs(local.x - sx),
          h: Math.abs(local.y - sy),
        });
        const area = canvasAreaRef.current;
        if (area) {
          const ar = area.getBoundingClientRect();
          const cx = clientX - ar.left;
          const cy = clientY - ar.top;
          const ssx = marqueeScreenStartRef.current.x;
          const ssy = marqueeScreenStartRef.current.y;
          setMarqueeScreenRect({
            x: Math.min(ssx, cx),
            y: Math.min(ssy, cy),
            w: Math.abs(cx - ssx),
            h: Math.abs(cy - ssy),
          });
        }
        return;
      }

      if (isMultiDragRef.current) {
        if (altKeyFromEvent !== undefined) altKeyRef.current = altKeyFromEvent;
        const altPressed = altKeyFromEvent ?? altKeyRef.current ?? altKeyAtDragStartRef.current;
        if (altPressed && !altDragDuplicatedRef.current) {
          altDragDuplicatedRef.current = true;
          onDuplicateSelected?.();
        }
        const canvasRect = canvas.getBoundingClientRect();
        const dx = clientX - multiDragStartRef.current.x;
        const dy = clientY - multiDragStartRef.current.y;
        const dnx = dx / canvasRect.width;
        const dny = dy / canvasRect.height;
        multiDragStartRef.current = { x: clientX, y: clientY };
        onMultiDragDelta?.(dnx, dny);

        // Bottom-edge expand detection for multi-drag
        if (canvas && onExpandArtboard) {
          const expandThreshold = 1 - 2 / artboardHeight;
          let anyNearBottom = false;
          for (const d of designs) {
            if (!selectedDesignIds.has(d.id) && d.id !== selectedDesignId) continue;
            const wi = d.widthInches * d.transform.s;
            const hi = d.heightInches * d.transform.s;
            const rad = (d.transform.rotation * Math.PI) / 180;
            const rotH = wi * Math.abs(Math.sin(rad)) + hi * Math.abs(Math.cos(rad));
            const bottomEdge = (d.transform.ny + dny) + (rotH / 2) / artboardHeight;
            if (bottomEdge >= expandThreshold) { anyNearBottom = true; break; }
          }
          if (anyNearBottom) startBottomGlow(); else stopBottomGlow();
        }

        startAutoPan(clientX, clientY);
        return;
      }

      if (isMultiResizeRef.current) {
        const RESIZE_DAMPING = 30;
        const scr = multiResizeStartScreenCenterRef.current;
        const dist = Math.sqrt((clientX - scr.x) ** 2 + (clientY - scr.y) ** 2);
        const ratio = (dist + RESIZE_DAMPING) / (multiResizeStartDistRef.current + RESIZE_DAMPING);
        if (!resizeCommittedRef.current && Math.abs(ratio - 1) < 0.04) return;
        resizeCommittedRef.current = true;
        const gc = multiGroupCenterBufferRef.current;
        const gcNx = gc.x / canvas.width;
        const gcNy = gc.y / canvas.height;
        onMultiResizeDelta?.(ratio, gcNx, gcNy);
        return;
      }

      if (isMultiRotateRef.current) {
        const local = canvasToLocal(clientX, clientY);
        const gc = multiGroupCenterBufferRef.current;
        const angle = Math.atan2(local.y - gc.y, local.x - gc.x);
        let deltaDeg = ((angle - multiRotateStartAngleRef.current) * 180) / Math.PI;
        if (shiftKeyRef.current) {
          deltaDeg = Math.round(deltaDeg / 15) * 15;
        }
        const gcNx = gc.x / canvas.width;
        const gcNy = gc.y / canvas.height;
        onMultiRotateDelta?.(deltaDeg, gcNx, gcNy);
        return;
      }

      if (!onTransformChange) return;

      if (isDraggingRef.current) {
        if (altKeyFromEvent !== undefined) altKeyRef.current = altKeyFromEvent;
        const altPressed = altKeyFromEvent ?? altKeyRef.current ?? altKeyAtDragStartRef.current;
        if (altPressed && !altDragDuplicatedRef.current) {
          altDragDuplicatedRef.current = true;
          onDuplicateSelected?.();
        }
        const canvasRect = canvas.getBoundingClientRect();
        const dx = clientX - dragStartMouseRef.current.x;
        const dy = clientY - dragStartMouseRef.current.y;
        const dnx = dx / canvasRect.width;
        const dny = dy / canvasRect.height;
        let unclamped = {
          ...dragStartTransformRef.current,
          nx: dragStartTransformRef.current.nx + dnx,
          ny: dragStartTransformRef.current.ny + dny,
        };

        // Smart guides snapping
        const SNAP_THRESHOLD = 0.008;
        const guides: Array<{axis: 'x' | 'y'; pos: number}> = [];
        const snapTargetsX = [0.5]; // artboard center
        const snapTargetsY = [0.5];

        for (const d of designs) {
          if (d.id === selectedDesignId) continue;
          snapTargetsX.push(d.transform.nx);
          snapTargetsY.push(d.transform.ny);
        }

        let snappedNx = unclamped.nx;
        let snappedNy = unclamped.ny;
        let bestDx = SNAP_THRESHOLD;
        let bestTx: number | null = null;
        for (const tx of snapTargetsX) {
          const dx = Math.abs(unclamped.nx - tx);
          if (dx < bestDx) {
            bestDx = dx;
            bestTx = tx;
          }
        }
        if (bestTx !== null) {
          snappedNx = bestTx;
          guides.push({ axis: 'x', pos: bestTx });
        }
        let bestDy = SNAP_THRESHOLD;
        let bestTy: number | null = null;
        for (const ty of snapTargetsY) {
          const dy = Math.abs(unclamped.ny - ty);
          if (dy < bestDy) {
            bestDy = dy;
            bestTy = ty;
          }
        }
        if (bestTy !== null) {
          snappedNy = bestTy;
          guides.push({ axis: 'y', pos: bestTy });
        }
        unclamped = { ...unclamped, nx: snappedNx, ny: snappedNy };
        snapGuidesRef.current = guides;

        const newTransform = clampTransformToArtboard(unclamped);
        transformRef.current = newTransform;
        onTransformChangeRef.current?.(newTransform);

        // Bottom-edge expand detection
        if (canvas && onExpandArtboard) {
          const selDesign = designs.find(d => d.id === selectedDesignId);
          if (selDesign) {
            const wi = selDesign.widthInches * newTransform.s;
            const hi = selDesign.heightInches * newTransform.s;
            const rad = (newTransform.rotation * Math.PI) / 180;
            const cosR = Math.abs(Math.cos(rad));
            const sinR = Math.abs(Math.sin(rad));
            const rotH = wi * sinR + hi * cosR;
            const bottomEdge = newTransform.ny + (rotH / 2) / artboardHeight;

            const expandThreshold = 1 - 2 / artboardHeight;
            if (bottomEdge >= expandThreshold) {
              startBottomGlow();
            } else {
              stopBottomGlow();
            }
          }
        } else {
          stopBottomGlow();
        }
        startAutoPan(clientX, clientY);
      } else if (isResizingRef.current) {
        const RESIZE_DAMPING = 30;
        const scr = resizeStartScreenCenterRef.current;
        const dist = Math.sqrt((clientX - scr.x) ** 2 + (clientY - scr.y) ** 2);
        const ratio = (dist + RESIZE_DAMPING) / (resizeStartDistRef.current + RESIZE_DAMPING);
        if (!resizeCommittedRef.current && Math.abs(ratio - 1) < 0.04) return;
        resizeCommittedRef.current = true;
        const maxS = getMaxScaleForArtboard(transformRef.current);
        const rawS = resizeStartSRef.current * ratio;
        const newS = Math.max(0.1, Math.min(maxS, rawS));
        if (rawS > maxS && Date.now() - resizeLimitToastRef.current > 3000) {
          resizeLimitToastRef.current = Date.now();
          toast({ title: "Design fills the sheet", description: "Try a larger gangsheet size to fit bigger designs." });
        }
        const unclamped = { ...transformRef.current, s: newS };
        const newTransform = clampTransformToArtboard(unclamped, { clampScale: true });
        transformRef.current = newTransform;
        onTransformChangeRef.current?.(newTransform);
      } else if (isRotatingRef.current) {
        const local = canvasToLocal(clientX, clientY);
        const rc = rotateStartCanvasCenterRef.current;
        const angle = Math.atan2(local.y - rc.y, local.x - rc.x);
        const delta = ((angle - rotateStartAngleRef.current) * 180) / Math.PI;
        let newRot = rotateStartRotationRef.current + delta;
        newRot = ((newRot % 360) + 360) % 360;
        if (shiftKeyRef.current) {
          newRot = Math.round(newRot / 15) * 15;
        }
        const rotated = { ...transformRef.current, rotation: Math.round(newRot) };
        const newTransform = clampTransformToArtboard(rotated);
        transformRef.current = newTransform;
        onTransformChangeRef.current?.(newTransform);
      }
    }, [onTransformChange, canvasToLocal, clampTransformToArtboard, getMaxScaleForArtboard, toast, onMultiDragDelta, onMultiResizeDelta, onMultiRotateDelta, onDuplicateSelected, startBottomGlow, stopBottomGlow, startAutoPan, designs, selectedDesignId, artboardHeight]);
    handleInteractionMoveRef.current = handleInteractionMove;

    useEffect(() => {
      if (scrollDragRef.current || isPanningRef.current) return;
      if (overlapCheckTimerRef.current) clearTimeout(overlapCheckTimerRef.current);
      overlapCheckTimerRef.current = setTimeout(() => {
        if (scrollDragRef.current || isPanningRef.current) return;
        checkPixelOverlap();
      }, 150);
      return () => { if (overlapCheckTimerRef.current) clearTimeout(overlapCheckTimerRef.current); };
    }, [checkPixelOverlap]);

    const handleInteractionEnd = useCallback(() => {
      stopAutoPan();

      if (isMarqueeRef.current) {
        isMarqueeRef.current = false;
        // Compute final rect from refs (not state) to avoid stale-frame lag
        const s = marqueeStartRef.current;
        const e = marqueeEndRef.current;
        const mr = { x: Math.min(s.x, e.x), y: Math.min(s.y, e.y), w: Math.abs(e.x - s.x), h: Math.abs(e.y - s.y) };
        setMarqueeRect(null);
        setMarqueeScreenRect(null);
        if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'default';
        const cvs = canvasRef.current;
        if (mr && mr.w > 4 && mr.h > 4 && cvs) {
          const hitIds: string[] = [];
          for (const d of designs) {
            const rect = computeLayerRect(
              d.imageInfo.image.width, d.imageInfo.image.height,
              d.transform, cvs.width, cvs.height,
              artboardWidth, artboardHeight,
              d.widthInches, d.heightInches,
            );
            const dcx = rect.x + rect.width / 2;
            const dcy = rect.y + rect.height / 2;
            const rad = (d.transform.rotation * Math.PI) / 180;
            const cosR = Math.abs(Math.cos(rad));
            const sinR = Math.abs(Math.sin(rad));
            const dhw = (rect.width * cosR + rect.height * sinR) / 2;
            const dhh = (rect.width * sinR + rect.height * cosR) / 2;
            if (dcx + dhw > mr.x && dcx - dhw < mr.x + mr.w &&
                dcy + dhh > mr.y && dcy - dhh < mr.y + mr.h) {
              hitIds.push(d.id);
            }
          }
          if (hitIds.length > 0) {
            onMultiSelect?.(hitIds);
          }
        }
        return;
      }

      if (isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current) {
        const wasGroupInteracting = isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current;
        isMultiDragRef.current = false;
        isMultiResizeRef.current = false;
        isMultiRotateRef.current = false;
        resizeCommittedRef.current = false;
        altDragDuplicatedRef.current = false;
        altKeyAtDragStartRef.current = false;
        stopBottomGlow();
        if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = getIdleCursor();
        checkPixelOverlap();
        if (wasGroupInteracting) onInteractionEnd?.();
        return;
      }

      const wasInteracting = isDraggingRef.current || isResizingRef.current || isRotatingRef.current;
      isDraggingRef.current = false;
      isResizingRef.current = false;
      isRotatingRef.current = false;
      resizeCommittedRef.current = false;
      altDragDuplicatedRef.current = false;
      altKeyAtDragStartRef.current = false;
      snapGuidesRef.current = [];
      stopBottomGlow();
      if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = getIdleCursor();
      checkPixelOverlap();
      if (wasInteracting) onInteractionEnd?.();
    }, [checkPixelOverlap, onInteractionEnd, designs, artboardWidth, artboardHeight, onMultiSelect, stopBottomGlow, stopAutoPan]);
    handleInteractionEndRef.current = handleInteractionEnd;

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      if (!onDesignContextMenu) return;
      const local = canvasToLocal(e.clientX, e.clientY);
      const hitId = findDesignAtPoint(local.x, local.y);
      onDesignContextMenu(e.clientX, e.clientY, hitId);
    }, [canvasToLocal, findDesignAtPoint, onDesignContextMenu]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      // Ensure keyboard scope is active on mousedown (fixes first-upload case where mouseenter never fired)
      isKeyboardScopeActiveRef.current = true;
      altKeyRef.current = e.altKey;
      if (selectionZoomActiveRef.current) return;
      if ((e.target as HTMLElement).closest('[data-scrollbar]')) return;
      if (e.button === 1 || (e.button === 0 && spaceDownRef.current)) {
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
        if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'grabbing';
        return;
      }
      // When artboard overflows horizontally and move mode is off, left-click pans
      if (e.button === 0 && isHorizOverflow() && !moveModeRef.current) {
        isPanningRef.current = true;
        panStartRef.current = { x: e.clientX, y: e.clientY, px: panX, py: panY };
        if (canvasAreaRef.current) canvasAreaRef.current.style.cursor = 'grabbing';
        return;
      }
      handleInteractionStart(e.clientX, e.clientY, e.ctrlKey || e.metaKey, e.altKey);
    }, [handleInteractionStart, panX, panY, isHorizOverflow]);

    const handleDoubleClick = useCallback((e: React.MouseEvent) => {
      if (!selectedDesignId || !onTransformChange) return;
      const local = canvasToLocal(e.clientX, e.clientY);
      const handleHit = hitTestHandles(local.x, local.y);
      if (handleHit?.type === 'rotate') {
        const updated = { ...transformRef.current, rotation: 0 };
        transformRef.current = updated;
        onTransformChange(updated);
      }
    }, [selectedDesignId, onTransformChange, canvasToLocal, hitTestHandles]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
      if (selectionZoomActiveRef.current) return;
      if (isPanningRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        const rawPx = panStartRef.current.px + dx / zoom;
        const rawPy = panStartRef.current.py + dy / zoom;
        const clamped = clampPanValue(rawPx, rawPy, zoom);
        setPanX(clamped.x);
        setPanY(clamped.y);
        return;
      }
      if (isMarqueeRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current || isDraggingRef.current || isResizingRef.current || isRotatingRef.current) {
        handleInteractionMove(e.clientX, e.clientY, e.altKey);
        return;
      }
      if (!canvasAreaRef.current) return;
      if (spaceDownRef.current) {
        canvasAreaRef.current.style.cursor = 'grab';
        return;
      }
      if (isHorizOverflow() && !moveModeRef.current) {
        canvasAreaRef.current.style.cursor = 'grab';
        return;
      }
      const local = canvasToLocal(e.clientX, e.clientY);
      // Group handle hover cursor
      if (selectedDesignIds.size > 1) {
        const multiHit = hitTestMultiHandles(local.x, local.y);
        if (multiHit) {
          canvasAreaRef.current.style.cursor = multiHit.type === 'resize'
            ? getResizeCursor(multiHit.id, 0)
            : ROTATE_CURSOR;
          return;
        }
      }
      if (imageInfo && selectedDesignId) {
        const handleHit = hitTestHandles(local.x, local.y);
        if (handleHit) {
          canvasAreaRef.current.style.cursor = handleHit.type === 'resize'
            ? getResizeCursor(handleHit.id, transformRef.current.rotation)
            : ROTATE_CURSOR;
          return;
        }
        if (hitTestDesign(local.x, local.y)) {
          canvasAreaRef.current.style.cursor = 'move';
          return;
        }
      }
      const hitId = findDesignAtPoint(local.x, local.y);
      canvasAreaRef.current.style.cursor = hitId ? 'pointer' : 'default';
    }, [handleInteractionMove, canvasToLocal, imageInfo, selectedDesignId, selectedDesignIds, hitTestHandles, hitTestMultiHandles, hitTestDesign, findDesignAtPoint, zoom, clampPanValue]);

    const handleMouseUp = useCallback(() => {
      if (isPanningRef.current) {
        isPanningRef.current = false;
        if (canvasAreaRef.current) {
          canvasAreaRef.current.style.cursor = spaceDownRef.current ? 'grab' : getIdleCursor();
        }
        return;
      }
      handleInteractionEnd();
    }, [handleInteractionEnd, isHorizOverflow]);

    const handleMouseEnter = useCallback(() => {
      isKeyboardScopeActiveRef.current = true;
    }, []);

    const handleMouseLeave = useCallback(() => {
      isKeyboardScopeActiveRef.current = false;
      spaceDownRef.current = false;
      const hasActiveInteraction = isPanningRef.current || isDraggingRef.current || isResizingRef.current || isRotatingRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current || isMarqueeRef.current;
      if (hasActiveInteraction) return;
    }, []);

    useEffect(() => {
      const area = canvasAreaRef.current;
      if (!area) return;
      if (!selectionZoomActive) {
        area.style.cursor = '';
        return;
      }
      area.style.cursor = 'crosshair';

      const onDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        if ((e.target as HTMLElement).closest('[data-scrollbar]')) return;
        e.preventDefault();
        e.stopPropagation();
        isSelectionZoomDragging.current = true;
        const areaRect = area.getBoundingClientRect();
        selZoomScreenStartRef.current = { x: e.clientX - areaRect.left, y: e.clientY - areaRect.top };
        setSelZoomRect(null);
      };

      const onMove = (e: MouseEvent) => {
        if (!isSelectionZoomDragging.current) return;
        const areaRect = area.getBoundingClientRect();
        const cx = e.clientX - areaRect.left;
        const cy = e.clientY - areaRect.top;
        const sx = selZoomScreenStartRef.current.x;
        const sy = selZoomScreenStartRef.current.y;
        setSelZoomRect({
          x: Math.min(sx, cx),
          y: Math.min(sy, cy),
          w: Math.abs(cx - sx),
          h: Math.abs(cy - sy),
        });
      };

      const onUp = () => {
        if (!isSelectionZoomDragging.current) return;
        isSelectionZoomDragging.current = false;
        const rect = selZoomRectRef.current;
        setSelZoomRect(null);
        setSelectionZoomActive(false);

        if (!rect || rect.w < 8 || rect.h < 8) {
          area.style.cursor = getIdleCursor();
          return;
        }
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const canvasRect = canvas.getBoundingClientRect();
        const areaRect = area.getBoundingClientRect();

        const selL = rect.x + areaRect.left;
        const selT = rect.y + areaRect.top;
        const selR = selL + rect.w;
        const selB = selT + rect.h;
        const clampedL = Math.max(selL, canvasRect.left);
        const clampedT = Math.max(selT, canvasRect.top);
        const clampedR = Math.min(selR, canvasRect.right);
        const clampedB = Math.min(selB, canvasRect.bottom);
        const clampedW = clampedR - clampedL;
        const clampedH = clampedB - clampedT;
        if (clampedW < 4 || clampedH < 4) return;

        const screenCx = clampedL + clampedW / 2;
        const screenCy = clampedT + clampedH / 2;
        const localCx = ((screenCx - canvasRect.left) / canvasRect.width) * canvas.width;
        const localCy = ((screenCy - canvasRect.top) / canvasRect.height) * canvas.height;
        const selLocalW = (clampedW / canvasRect.width) * canvas.width;
        const selLocalH = (clampedH / canvasRect.height) * canvas.height;

        const dims = previewDimsRef.current;
        const dpi = canvas.width / Math.max(1, dims.width);
        const vw = area.clientWidth;
        const vh = area.clientHeight;
        const scaleX = (vw * dpi) / selLocalW;
        const scaleY = (vh * dpi) / selLocalH;
        const newZoom = Math.max(minZoomRef.current, Math.min(zoomMaxRef.current, Math.min(scaleX, scaleY)));
        const selCenterCSS_X = localCx / dpi;
        const selCenterCSS_Y = localCy / dpi;
        const newPanX = dims.width / 2 - selCenterCSS_X;
        const newPanY = dims.height / 2 - selCenterCSS_Y;
        const clamped = clampPanValue(newPanX, newPanY, newZoom);
        suppressTransitionRef.current = true;
        setZoom(newZoom);
        setPanX(clamped.x);
        setPanY(clamped.y);
        requestAnimationFrame(() => { suppressTransitionRef.current = false; });
        area.style.cursor = (newZoom * previewDimsRef.current.width > area.clientWidth * 1.05 && !moveModeRef.current) ? 'grab' : 'default';
      };

      area.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      return () => {
        area.removeEventListener('mousedown', onDown, true);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        area.style.cursor = '';
      };
    }, [selectionZoomActive, clampPanValue]);


    const pinchStartDistRef = useRef(0);
    const pinchStartZoomRef = useRef(1);
    const pinchStartPanRef = useRef({ x: 0, y: 0 });
    const isPinchingRef = useRef(false);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      if ((e.target as HTMLElement).closest('[data-scrollbar]')) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        isPinchingRef.current = true;
        isPanningRef.current = false;
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoom;
        pinchStartPanRef.current = { x: panX, y: panY };
        return;
      }
      if (e.touches.length !== 1) return;
      e.preventDefault();
      if (isHorizOverflow() && !moveModeRef.current) {
        isPanningRef.current = true;
        panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, px: panX, py: panY };
        return;
      }
      handleInteractionStart(e.touches[0].clientX, e.touches[0].clientY);
    }, [handleInteractionStart, panX, panY, zoom, isHorizOverflow]);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      if (isPinchingRef.current && e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ratio = dist / Math.max(1, pinchStartDistRef.current);
        const effectiveMin = minZoomRef.current;
        const newZoom = Math.max(effectiveMin, Math.min(zoomMaxRef.current, pinchStartZoomRef.current * ratio));
        const clamped = clampPanValue(pinchStartPanRef.current.x, pinchStartPanRef.current.y, newZoom);
        setZoom(newZoom);
        setPanX(clamped.x);
        setPanY(clamped.y);
        return;
      }
      if (e.touches.length !== 1) return;
      e.preventDefault();
      if (isPanningRef.current) {
        const dx = e.touches[0].clientX - panStartRef.current.x;
        const dy = e.touches[0].clientY - panStartRef.current.y;
        const rawPx = panStartRef.current.px + dx / zoom;
        const rawPy = panStartRef.current.py + dy / zoom;
        const clamped = clampPanValue(rawPx, rawPy, zoom);
        setPanX(clamped.x);
        setPanY(clamped.y);
        return;
      }
      handleInteractionMove(e.touches[0].clientX, e.touches[0].clientY);
    }, [handleInteractionMove, zoom, clampPanValue]);

    const handleTouchEnd = useCallback(() => {
      if (isPinchingRef.current) {
        isPinchingRef.current = false;
        return;
      }
      if (isPanningRef.current) {
        isPanningRef.current = false;
        return;
      }
      handleInteractionEnd();
    }, [handleInteractionEnd]);
    
    // Fit to View: calculate zoom to fit canvas within container and reset pan
    const fitToView = useCallback(() => {
      if (!containerRef.current) return;
      const viewPadding = Math.max(4, Math.round(Math.min(previewDims.width, previewDims.height) * 0.03));
      const containerWidth = containerRef.current.clientWidth - viewPadding * 2;
      const containerHeight = containerRef.current.clientHeight - viewPadding * 2;
      const scaleX = containerWidth / previewDims.width;
      const scaleY = containerHeight / previewDims.height;
      const fitZoom = Math.min(scaleX, scaleY);
      setZoom(Math.max(minZoomRef.current, Math.min(zoomMaxRef.current, Math.round(fitZoom * 20) / 20)));
      setPanX(0);
      setPanY(0);
    }, [previewDims.height, previewDims.width]);

    // Fit Width: zoom so the full artboard width fills the viewport, pan to top
    const fitWidth = useCallback(() => {
      const el = canvasAreaRef.current;
      if (!el) return;
      const availW = el.clientWidth - 24;
      const vh = el.clientHeight;
      const widthZoom = availW / Math.max(1, previewDims.width);
      const newZoom = Math.max(minZoomRef.current, Math.min(zoomMaxRef.current, Math.round(widthZoom * 20) / 20));
      // Pan so artboard top aligns with viewport top:
      // (-h/2 + panY) * zoom = -vh/2  →  panY = h/2 - vh/(2*zoom)
      const topPanY = previewDims.height / 2 - vh / (2 * newZoom);
      const maxPanY = Math.max(0, previewDims.height / 2 - vh / (2 * newZoom));
      const clampedPanY = Math.max(-maxPanY, Math.min(maxPanY, topPanY));
      setZoom(newZoom);
      setPanX(0);
      setPanY(clampedPanY);
    }, [previewDims.width, previewDims.height]);

    // Reset view to fit the full gangsheet in view
    const resetView = useCallback(() => {
      fitToView();
      if (canvasAreaRef.current && !selectionZoomActiveRef.current) {
        requestAnimationFrame(() => {
          if (canvasAreaRef.current) {
            canvasAreaRef.current.style.cursor = getIdleCursor();
          }
        });
      }
    }, [fitToView, getIdleCursor]);

    const zoomToSelected = useCallback(() => {
      const el = canvasAreaRef.current;
      if (!el || !selectedDesignId) return;
      const design = designs.find(d => d.id === selectedDesignId);
      if (!design) return;
      const t = design.transform;
      const wi = design.widthInches * t.s;
      const hi = design.heightInches * t.s;
      const rad = (t.rotation * Math.PI) / 180;
      const cosR = Math.abs(Math.cos(rad));
      const sinR = Math.abs(Math.sin(rad));
      const rotW = wi * cosR + hi * sinR;
      const rotH = wi * sinR + hi * cosR;

      const dims = previewDimsRef.current;
      const designCssW = (rotW / artboardWidth) * dims.width;
      const designCssH = (rotH / artboardHeight) * dims.height;

      const viewW = el.clientWidth - 60;
      const viewH = el.clientHeight - 60;
      const fitZoom = Math.min(viewW / Math.max(1, designCssW), viewH / Math.max(1, designCssH));
      const newZoom = Math.max(minZoomRef.current, Math.min(zoomMaxRef.current, fitZoom));

      const designCenterX = (t.nx - 0.5) * dims.width;
      const designCenterY = (t.ny - 0.5) * dims.height;
      const rawPx = -designCenterX;
      const rawPy = -designCenterY;
      const clamped = clampPanValue(rawPx, rawPy, newZoom);
      setZoom(newZoom);
      setPanX(clamped.x);
      setPanY(clamped.y);
      setMoveMode(true);
    }, [selectedDesignId, designs, artboardWidth, artboardHeight, clampPanValue]);

    // Pointer-capture based scrollbar drag — self-contained, no global listeners needed.
    const handleScrollbarPointerDown = useCallback((axis: 'x' | 'y', e: React.PointerEvent<HTMLDivElement>, isThumb: boolean) => {
      if (selectionZoomActiveRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);

      setActiveScrollAxis(axis);
      document.body.style.cursor = 'default';

      const { maxScroll, rawThumbFrac } = getScrollMetrics(axis, zoom);
      const area = canvasAreaRef.current;
      const trackEl = isThumb ? target.parentElement : target.querySelector('[style]');
      let trackSize = trackEl ? (axis === 'x' ? trackEl.clientWidth : trackEl.clientHeight) : 0;
      if (trackSize < 20 && area) {
        const margin = 36;
        trackSize = axis === 'x' ? Math.max(20, area.clientWidth - 4 - margin) : Math.max(20, area.clientHeight - 4 - margin);
      }
      const minThumbPx = 32;
      const effectiveThumbFrac = Math.max(rawThumbFrac, minThumbPx / Math.max(1, trackSize));
      const thumbPx = Math.max(minThumbPx, effectiveThumbFrac * trackSize);
      const scrollable = Math.max(1, trackSize - thumbPx);

      // Derive startScroll from current pan state
      const startScroll = panToScroll(axis, axis === 'x' ? panXRef.current : panYRef.current, zoom);

      // For track clicks (not thumb), jump to click position first
      if (!isThumb && maxScroll > 0) {
        const rect = (trackEl || target).getBoundingClientRect();
        const pointerPos = axis === 'x' ? (e.clientX - rect.left) : (e.clientY - rect.top);
        const edgeTol = 4;
        const scrollRatio = maxScroll > 0 ? Math.max(0, Math.min(1, startScroll / maxScroll)) : 0;
        const thumbStart = scrollRatio * scrollable;
        const thumbEnd = thumbStart + thumbPx;
        const isInsideThumb = pointerPos >= (thumbStart - edgeTol) && pointerPos <= (thumbEnd + edgeTol);
        if (!isInsideThumb) {
          const jumpScroll = Math.max(0, Math.min(maxScroll, ((pointerPos - thumbPx / 2) / scrollable) * maxScroll));
          const mp = getMaxPan(axis, zoom);
          const t = maxScroll > 0 ? Math.max(0, Math.min(1, jumpScroll / maxScroll)) : 0;
          const jumpPan = mp > 0 ? mp * (1 - 2 * t) : 0;
          if (axis === 'x') { panXRef.current = jumpPan; setPanX(jumpPan); }
          else { panYRef.current = jumpPan; setPanY(jumpPan); }
        }
      }

      const dragStartScroll = panToScroll(axis, axis === 'x' ? panXRef.current : panYRef.current, zoom);
      const startMouse = axis === 'x' ? e.clientX : e.clientY;

      scrollDragRef.current = { axis, startMouse, startScroll: dragStartScroll, maxScroll, scrollable };

      const onPointerMove = (ev: PointerEvent) => {
        const drag = scrollDragRef.current;
        if (!drag) return;
        const delta = (drag.axis === 'x' ? ev.clientX : ev.clientY) - drag.startMouse;
        const raw = drag.startScroll + (delta / drag.scrollable) * drag.maxScroll;
        const nextScroll = Math.max(0, Math.min(drag.maxScroll, raw));
        const z = zoomRef.current;
        const mp = getMaxPan(drag.axis, z);
        const ms = drag.maxScroll;
        let nextPan = 0;
        if (mp > 0 && ms > 0) {
          const t = Math.max(0, Math.min(1, nextScroll / ms));
          nextPan = mp * (1 - 2 * t);
        }
        const nextX = drag.axis === 'x' ? nextPan : panXRef.current;
        const nextY = drag.axis === 'y' ? nextPan : panYRef.current;
        // Sync native scroll element
        const el = nativeScrollRef.current;
        if (el) {
          syncingScrollRef.current = true;
          if (drag.axis === 'x') el.scrollLeft = nextScroll;
          else el.scrollTop = nextScroll;
          syncingScrollRef.current = false;
        }
        queuePanStateCommit(nextX, nextY);
      };

      const onPointerUp = () => {
        target.removeEventListener('pointermove', onPointerMove);
        target.removeEventListener('pointerup', onPointerUp);
        target.removeEventListener('lostpointercapture', onPointerUp);
        suppressTransitionRef.current = true;
        scrollDragRef.current = null;
        setActiveScrollAxis(null);
        document.body.style.cursor = '';
        queuePanStateCommit(panXRef.current, panYRef.current);
        setScrollbarHover(null);
        requestAnimationFrame(() => { suppressTransitionRef.current = false; });
      };

      target.addEventListener('pointermove', onPointerMove);
      target.addEventListener('pointerup', onPointerUp);
      target.addEventListener('lostpointercapture', onPointerUp);
    }, [zoom, getScrollMetrics, panToScroll, getMaxPan, queuePanStateCommit]);

    // Keep native scroll element in sync with pan state
    useEffect(() => {
      const el = nativeScrollRef.current;
      if (!el) return;
      const z = zoomRef.current;
      const sx = panToScroll('x', panXRef.current, z);
      const sy = panToScroll('y', panYRef.current, z);
      syncingScrollRef.current = true;
      el.scrollLeft = sx;
      el.scrollTop = sy;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    }, [panToScroll]);

    // Global listeners: continue design drag/resize/rotate if mouse leaves canvas area
    useEffect(() => {
      const onGlobalMove = (e: MouseEvent) => {
        if (scrollDragRef.current) return;
        const active = isPanningRef.current || isDraggingRef.current || isResizingRef.current || isRotatingRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current || isMarqueeRef.current;
        if (!active) return;
        if (isPanningRef.current) {
          const dx = e.clientX - panStartRef.current.x;
          const dy = e.clientY - panStartRef.current.y;
          const z = zoomRef.current;
          const rawPx = panStartRef.current.px + dx / z;
          const rawPy = panStartRef.current.py + dy / z;
          const dims = previewDimsRef.current;
          const el = canvasAreaRef.current;
          const vw = el ? el.clientWidth : dims.width;
          const vh = el ? el.clientHeight : dims.height;
          const maxPanX = Math.max(0, dims.width / 2 - vw / (2 * z));
          const maxPanY = Math.max(0, dims.height / 2 - vh / (2 * z));
          setPanX(Math.max(-maxPanX, Math.min(maxPanX, rawPx)));
          setPanY(Math.max(-maxPanY, Math.min(maxPanY, rawPy)));
          return;
        }
        handleInteractionMoveRef.current?.(e.clientX, e.clientY, e.altKey);
      };
      const onGlobalUp = () => {
        const active = isPanningRef.current || isDraggingRef.current || isResizingRef.current || isRotatingRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current || isMarqueeRef.current;
        if (!active) return;
        if (isPanningRef.current) {
          isPanningRef.current = false;
          if (canvasAreaRef.current) {
            canvasAreaRef.current.style.cursor = getIdleCursor();
          }
          return;
        }
        handleInteractionEndRef.current?.();
      };
      window.addEventListener('mousemove', onGlobalMove);
      window.addEventListener('mouseup', onGlobalUp);
      return () => {
        window.removeEventListener('mousemove', onGlobalMove);
        window.removeEventListener('mouseup', onGlobalUp);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Old handleScrollTrackClick/handleScrollThumbDown removed — replaced by handleScrollbarPointerDown above

    useEffect(() => {
      const el = nativeScrollRef.current;
      if (!el) return;
      const sx = panToScroll('x', panX, zoom);
      const sy = panToScroll('y', panY, zoom);
      syncingScrollRef.current = true;
      el.scrollLeft = sx;
      el.scrollTop = sy;
      requestAnimationFrame(() => { syncingScrollRef.current = false; });
    }, [panX, panY, zoom, panToScroll]);

    useEffect(() => {
      return () => {
        if (panCommitRafRef.current != null) {
          cancelAnimationFrame(panCommitRafRef.current);
          panCommitRafRef.current = null;
        }
      };
    }, []);

    const prevArtboardHeightRef = useRef(artboardHeight);
    useEffect(() => {
      if (prevArtboardHeightRef.current !== artboardHeight) {
        prevArtboardHeightRef.current = artboardHeight;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (artboardHeight > artboardWidth * 2) {
            fitWidth();
          } else {
            fitToView();
          }
        }));
      }
    }, [artboardHeight, artboardWidth, fitToView, fitWidth]);

    useEffect(() => {
      const el = canvasAreaRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();

        // Ctrl/Cmd+wheel OR pinch-to-zoom (browsers set ctrlKey for pinch): ZOOM
        if (e.ctrlKey || e.metaKey) {
          isWheelZoomingRef.current = true;
          if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
          wheelTimeoutRef.current = setTimeout(() => { isWheelZoomingRef.current = false; }, 200);

          const oldZoom = zoomRef.current;
          const factor = e.deltaY > 0 ? 1 / ZOOM_WHEEL_FACTOR : ZOOM_WHEEL_FACTOR;
          const effectiveMin = minZoomRef.current;
          const newZoom = Math.max(effectiveMin, Math.min(zoomMaxRef.current, oldZoom * factor));
          if (newZoom === oldZoom) return;

          const canvas = canvasRef.current;
          if (!canvas) return;
          const rect = canvas.getBoundingClientRect();
          const cursorX = e.clientX - (rect.left + rect.width / 2);
          const cursorY = e.clientY - (rect.top + rect.height / 2);

          const oldPx = panXRef.current;
          const oldPy = panYRef.current;
          const rawPanX = oldPx + cursorX * (1 / newZoom - 1 / oldZoom);
          const rawPanY = oldPy + cursorY * (1 / newZoom - 1 / oldZoom);
          const dims = previewDimsRef.current;
          const vw = el.clientWidth;
          const vh = el.clientHeight;
          const maxPx = Math.max(0, dims.width / 2 - vw / (2 * newZoom));
          const maxPy = Math.max(0, dims.height / 2 - vh / (2 * newZoom));
          const clampedPanX = Math.max(-maxPx, Math.min(maxPx, rawPanX));
          const clampedPanY = Math.max(-maxPy, Math.min(maxPy, rawPanY));

          setZoom(newZoom);
          setPanX(clampedPanX);
          setPanY(clampedPanY);
          if (!selectionZoomActiveRef.current && !isPanningRef.current) {
            el.style.cursor = (newZoom * dims.width > el.clientWidth * 1.05 && !moveModeRef.current) ? 'grab' : 'default';
          }
          return;
        }

        // Plain wheel: scroll/pan (Shift+wheel → horizontal)
        const z = zoomRef.current;
        const dims = previewDimsRef.current;
        const vw = el.clientWidth;
        const vh = el.clientHeight;
        const rawDx = e.shiftKey ? e.deltaY : e.deltaX;
        const rawDy = e.shiftKey ? 0 : e.deltaY;
        const newPanX = panXRef.current - rawDx / z;
        const newPanY = panYRef.current - rawDy / z;
        const maxPx = Math.max(0, dims.width / 2 - vw / (2 * z));
        const maxPy = Math.max(0, dims.height / 2 - vh / (2 * z));
        const clampedPanX = Math.max(-maxPx, Math.min(maxPx, newPanX));
        const clampedPanY = Math.max(-maxPy, Math.min(maxPy, newPanY));
        if (clampedPanX === panXRef.current && clampedPanY === panYRef.current) return;
        panXRef.current = clampedPanX;
        panYRef.current = clampedPanY;
        setPanX(clampedPanX);
        setPanY(clampedPanY);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        el.removeEventListener('wheel', onWheel);
        if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
      };
    }, []);
    
    // Reset zoom only on the very first design (empty → 1 design transition)
    const hasEverHadDesignRef = useRef(false);
    useEffect(() => {
      if (!imageInfo) {
        lastImageRef.current = null;
        return;
      }
      
      const imageKey = `${imageInfo.image.src}-${imageInfo.image.width}-${imageInfo.image.height}`;
      if (lastImageRef.current === imageKey) return;
      lastImageRef.current = imageKey;

      if (!hasEverHadDesignRef.current) {
        hasEverHadDesignRef.current = true;
        requestAnimationFrame(() => fitToView());
      }
    }, [imageInfo, fitToView]);

    useEffect(() => {
      const wrapper = canvasAreaRef.current;
      if (!wrapper) return;
      const updateSize = () => {
        const availW = wrapper.clientWidth - 48;
        const availH = wrapper.clientHeight - 48;
        if (availW <= 0 || availH <= 0) return;
        const artboardAspect = artboardWidth / artboardHeight;
        let w: number, h: number;
        if (availW / availH > artboardAspect) {
          h = Math.round(Math.max(200, availH));
          w = Math.round(h * artboardAspect);
        } else {
          w = Math.round(Math.max(200, availW));
          h = Math.round(w / artboardAspect);
        }

        const fitWidthZoom = availW / Math.max(1, w);
        const baseDPI = fitWidthZoom > 1.5
          ? Math.ceil(fitWidthZoom * 1.25)
          : BASE_DPI_SCALE;
        dpiScaleRef.current = Math.max(BASE_DPI_SCALE, baseDPI);

        setPreviewDims({ width: w, height: h });
        requestAnimationFrame(() => { minZoomRef.current = getMinZoom(); });
      };
      updateSize();
      const observer = new ResizeObserver(updateSize);
      observer.observe(wrapper);
      return () => observer.disconnect();
    }, [artboardWidth, artboardHeight]);
    
    useImperativeHandle(ref, () => {
      const canvas = canvasRef.current;
      if (!canvas) return null as any;
      (canvas as any).getViewportCenterNormalized = () => {
        const dims = previewDimsRef.current;
        const z = zoomRef.current;
        const px = panXRef.current;
        const py = panYRef.current;
        const nx = 0.5 - px / Math.max(1, dims.width);
        const ny = 0.5 - py / Math.max(1, dims.height);
        return { nx: Math.max(0.05, Math.min(0.95, nx)), ny: Math.max(0.05, Math.min(0.95, ny)) };
      };
      return canvas;
    }, []);

    const getCheckerboardPattern = (ctx: CanvasRenderingContext2D, w: number, h: number): CanvasPattern | null => {
      if (checkerboardPatternRef.current?.width === w && checkerboardPatternRef.current?.height === h) {
        return checkerboardPatternRef.current.pattern;
      }
      const gridSize = 10;
      const patternCanvas = document.createElement('canvas');
      patternCanvas.width = gridSize * 2;
      patternCanvas.height = gridSize * 2;
      const pCtx = patternCanvas.getContext('2d');
      if (!pCtx) return null;
      pCtx.fillStyle = '#e8e8e8';
      pCtx.fillRect(0, 0, gridSize * 2, gridSize * 2);
      pCtx.fillStyle = '#d0d0d0';
      pCtx.fillRect(gridSize, 0, gridSize, gridSize);
      pCtx.fillRect(0, gridSize, gridSize, gridSize);
      const pattern = ctx.createPattern(patternCanvas, 'repeat');
      if (pattern) {
        checkerboardPatternRef.current = { width: w, height: h, pattern };
      }
      return pattern;
    };

    // Spot color preview overlay
    useEffect(() => {
      if (!spotPreviewData?.enabled) {
        spotPulseRef.current = 1;
        if (spotAnimFrameRef.current !== null) {
          cancelAnimationFrame(spotAnimFrameRef.current);
          spotAnimFrameRef.current = null;
        }
        spotOverlayCacheRef.current = null;
        if (renderRef.current) renderRef.current();
        return;
      }
      const hasAny = spotPreviewData?.colors?.some(c => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange || c.spotWhite || c.spotGloss);
      if (!hasAny) {
        spotPulseRef.current = 1;
        if (spotAnimFrameRef.current !== null) { cancelAnimationFrame(spotAnimFrameRef.current); spotAnimFrameRef.current = null; }
        spotOverlayCacheRef.current = null;
        if (renderRef.current) renderRef.current();
        return;
      }
      let startTime: number | null = null;
      let lastFrameTime = 0;
      const FRAME_INTERVAL = 1000 / 30;
      const animate = (timestamp: number) => {
        if (startTime === null) startTime = timestamp;
        if (timestamp - lastFrameTime >= FRAME_INTERVAL) {
          lastFrameTime = timestamp;
          const elapsed = (timestamp - startTime) / 1000;
          spotPulseRef.current = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(elapsed * Math.PI * 1.5));
          if (renderRef.current) renderRef.current();
        }
        spotAnimFrameRef.current = requestAnimationFrame(animate);
      };
      spotAnimFrameRef.current = requestAnimationFrame(animate);
      return () => {
        if (spotAnimFrameRef.current !== null) { cancelAnimationFrame(spotAnimFrameRef.current); spotAnimFrameRef.current = null; }
        spotPulseRef.current = 1;
      };
    }, [spotPreviewData]);

    const createSpotOverlayCanvas = useCallback((source?: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement | null => {
      if (!imageInfo || !spotPreviewData?.enabled) return null;
      const allColors = spotPreviewData.colors;
      if (!allColors || allColors.length === 0) return null;

      const fluorY = allColors.filter(c => c.spotFluorY);
      const fluorM = allColors.filter(c => c.spotFluorM);
      const fluorG = allColors.filter(c => c.spotFluorG);
      const fluorOr = allColors.filter(c => c.spotFluorOrange);
      if (fluorY.length === 0 && fluorM.length === 0 && fluorG.length === 0 && fluorOr.length === 0) return null;

      const img = source || imageInfo.image;
      const imgIdentity = (img as HTMLImageElement).src || `${img.width}x${img.height}`;
      const cacheKey = `${imgIdentity}-fy:${fluorY.map(c=>c.hex).join(',')}-fm:${fluorM.map(c=>c.hex).join(',')}-fg:${fluorG.map(c=>c.hex).join(',')}-fo:${fluorOr.map(c=>c.hex).join(',')}`;
      if (spotOverlayCacheRef.current?.key === cacheKey) return spotOverlayCacheRef.current.canvas;

      let ow = img.width, oh = img.height;

      const srcCanvas = document.createElement('canvas');
      srcCanvas.width = ow;
      srcCanvas.height = oh;
      const srcCtx = srcCanvas.getContext('2d');
      if (!srcCtx) return null;
      srcCtx.drawImage(img, 0, 0, ow, oh);
      let srcData: ImageData;
      try { srcData = srcCtx.getImageData(0, 0, ow, oh); } catch { return null; }

      const overlayCanvas = document.createElement('canvas');
      overlayCanvas.width = ow;
      overlayCanvas.height = oh;
      const overlayCtx = overlayCanvas.getContext('2d');
      if (!overlayCtx) return null;
      const overlayData = overlayCtx.createImageData(ow, oh);

      const parseHex = (hex: string) => ({
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
      });

      const allColorsParsed = allColors.map(c => ({
        ...parseHex(c.hex),
        hex: c.hex,
      }));
      const markedHexMap = new Map<string, { oR: number; oG: number; oB: number }>();
      for (const c of fluorY) markedHexMap.set(c.hex, { oR: 223, oG: 255, oB: 0 });
      for (const c of fluorM) markedHexMap.set(c.hex, { oR: 255, oG: 0, oB: 255 });
      for (const c of fluorG) markedHexMap.set(c.hex, { oR: 57, oG: 255, oB: 20 });
      for (const c of fluorOr) markedHexMap.set(c.hex, { oR: 255, oG: 102, oB: 0 });

      const colorTolerance = 80;
      const directTolerance = 100;
      const alphaThreshold = 128;
      const pixels = srcData.data;
      const out = overlayData.data;

      for (let idx = 0; idx < pixels.length; idx += 4) {
        if (pixels[idx + 3] < alphaThreshold) continue;
        const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];

        let closestHex = '';
        let closestDist = Infinity;
        for (const ac of allColorsParsed) {
          const dr = r - ac.r, dg = g - ac.g, db = b - ac.b;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist < closestDist) { closestDist = dist; closestHex = ac.hex; }
        }

        if (closestDist < colorTolerance && markedHexMap.has(closestHex)) {
          const markedRgb = parseHex(closestHex);
          const dr = r - markedRgb.r, dg = g - markedRgb.g, db = b - markedRgb.b;
          if (Math.sqrt(dr * dr + dg * dg + db * db) < directTolerance) {
            const overlay = markedHexMap.get(closestHex)!;
            out[idx] = overlay.oR;
            out[idx + 1] = overlay.oG;
            out[idx + 2] = overlay.oB;
            out[idx + 3] = 255;
          }
        }
      }

      overlayCtx.putImageData(overlayData, 0, 0);
      spotOverlayCacheRef.current = { key: cacheKey, canvas: overlayCanvas };
      return overlayCanvas;
    }, [imageInfo, spotPreviewData]);

    createSpotOverlayCanvasRef.current = createSpotOverlayCanvas;

    const drawSingleDesign = useCallback((ctx: CanvasRenderingContext2D, design: DesignItem, cw: number, ch: number) => {
      const rect = computeLayerRect(
        design.imageInfo.image.width, design.imageInfo.image.height,
        design.transform, cw, ch,
        artboardWidth, artboardHeight,
        design.widthInches, design.heightInches,
      );
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      ctx.save();
      if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
      ctx.translate(cx, cy);
      ctx.rotate((design.transform.rotation * Math.PI) / 180);
      ctx.scale(design.transform.flipX ? -1 : 1, design.transform.flipY ? -1 : 1);
      ctx.drawImage(design.imageInfo.image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
      ctx.restore();
    }, [artboardWidth, artboardHeight]);

    useEffect(() => {
      if (!canvasRef.current || (!imageInfo && designs.length === 0)) return;

      const doRender = () => {
      try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const maxBufferArea = 8_000_000;
      const effectiveDPI = Math.max(BASE_DPI_SCALE, dpiScaleRef.current * zoomDpiTier);
      let canvasWidth = Math.round(previewDims.width * effectiveDPI);
      let canvasHeight = Math.round(previewDims.height * effectiveDPI);
      if (canvasWidth * canvasHeight > maxBufferArea) {
        const scale = Math.sqrt(maxBufferArea / (canvasWidth * canvasHeight));
        canvasWidth = Math.round(canvasWidth * scale);
        canvasHeight = Math.round(canvasHeight * scale);
      }
      if (lastCanvasDimsRef.current.width !== canvasWidth || lastCanvasDimsRef.current.height !== canvasHeight) {
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        lastCanvasDimsRef.current = { width: canvasWidth, height: canvasHeight };
      } else {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      if (previewBgColor === 'transparent') {
        const pattern = getCheckerboardPattern(ctx, canvasWidth, canvasHeight);
        if (pattern) {
          ctx.fillStyle = pattern;
          ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        }
      } else {
        ctx.fillStyle = previewBgColor;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
      }

      ctx.save();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = Math.max(1, 2 * dpiScaleRef.current);
      ctx.strokeRect(0.5, 0.5, canvasWidth - 1, canvasHeight - 1);
      ctx.restore();

      for (const design of designs) {
        if (design.id === selectedDesignId) continue;
        drawSingleDesign(ctx, design, canvasWidth, canvasHeight);
        if (overlappingDesigns.has(design.id)) {
          const rect = computeLayerRect(
            design.imageInfo.image.width, design.imageInfo.image.height,
            design.transform, canvasWidth, canvasHeight,
            artboardWidth, artboardHeight,
            design.widthInches, design.heightInches,
          );
          const dcx = rect.x + rect.width / 2;
          const dcy = rect.y + rect.height / 2;
          const drad = (design.transform.rotation * Math.PI) / 180;
          const dcos = Math.cos(drad);
          const dsin = Math.sin(drad);
          const hw = rect.width / 2;
          const hh = rect.height / 2;
          const corners = [
            { x: dcx + (-hw) * dcos - (-hh) * dsin, y: dcy + (-hw) * dsin + (-hh) * dcos },
            { x: dcx + hw * dcos - (-hh) * dsin, y: dcy + hw * dsin + (-hh) * dcos },
            { x: dcx + hw * dcos - hh * dsin, y: dcy + hw * dsin + hh * dcos },
            { x: dcx + (-hw) * dcos - hh * dsin, y: dcy + (-hw) * dsin + hh * dcos },
          ];
          ctx.save();
          ctx.strokeStyle = '#ff0000';
          ctx.lineWidth = 2 * dpiScaleRef.current;
          ctx.setLineDash([6 * dpiScaleRef.current, 3 * dpiScaleRef.current]);
          ctx.beginPath();
          ctx.moveTo(corners[0].x, corners[0].y);
          for (let ci = 1; ci < corners.length; ci++) ctx.lineTo(corners[ci].x, corners[ci].y);
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }
      }

      if (!imageInfo || !selectedDesignId) return;

      drawImageWithResizePreview(ctx, canvas.width, canvas.height);

      // Draw smart alignment guides
      if (snapGuidesRef.current.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#f472b6';
        ctx.lineWidth = 1 * dpiScaleRef.current;
        ctx.setLineDash([4 * dpiScaleRef.current, 4 * dpiScaleRef.current]);
        ctx.globalAlpha = 0.8;
        for (const guide of snapGuidesRef.current) {
          ctx.beginPath();
          if (guide.axis === 'x') {
            const px = guide.pos * canvasWidth;
            ctx.moveTo(px, 0);
            ctx.lineTo(px, canvasHeight);
          } else {
            const py = guide.pos * canvasHeight;
            ctx.moveTo(0, py);
            ctx.lineTo(canvasWidth, py);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.restore();
      }
      
      
      
      // Marquee selection is rendered as a DOM overlay for instant feedback

      if (selectedDesignIds.size > 1) {
        const z = Math.max(0.25, zoomRef.current);
        const inv = dpiScaleRef.current / z;
        for (const d of designs) {
          if (!selectedDesignIds.has(d.id)) continue;
          const r = computeLayerRect(
            d.imageInfo.image.width, d.imageInfo.image.height,
            d.transform, canvasWidth, canvasHeight,
            artboardWidth, artboardHeight, d.widthInches, d.heightInches,
          );
          const cx2 = r.x + r.width / 2;
          const cy2 = r.y + r.height / 2;
          const hw2 = r.width / 2;
          const hh2 = r.height / 2;
          const rad2 = (d.transform.rotation * Math.PI) / 180;
          const cos2 = Math.cos(rad2);
          const sin2 = Math.sin(rad2);
          const corners2 = [
            { lx: -hw2, ly: -hh2 }, { lx: hw2, ly: -hh2 },
            { lx: hw2, ly: hh2 }, { lx: -hw2, ly: hh2 },
          ];
          const pts2 = corners2.map(c => ({
            x: cx2 + c.lx * cos2 - c.ly * sin2,
            y: cy2 + c.lx * sin2 + c.ly * cos2,
          }));
          ctx.save();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.5 * inv;
          ctx.setLineDash([3 * inv, 3 * inv]);
          ctx.globalAlpha = 0.6;
          ctx.beginPath();
          ctx.moveTo(pts2[0].x, pts2[0].y);
          for (let i = 1; i < pts2.length; i++) ctx.lineTo(pts2[i].x, pts2[i].y);
          ctx.closePath();
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.restore();
        }

        // Draw group bounding box and handles
        const groupBBox = getMultiSelectionBBox();
        if (groupBBox) {
          ctx.save();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.5 * inv;
          ctx.setLineDash([5 * inv, 4 * inv]);
          ctx.strokeRect(groupBBox.x, groupBBox.y, groupBBox.width, groupBBox.height);
          ctx.setLineDash([]);
          ctx.restore();

          // Resize handles at corners (br is 2x on mobile for easier touch)
          const handleR = 4.5 * inv;
          const brHandleR = isMobile ? handleR * 2 : handleR;
          const groupHandles = [
            { x: groupBBox.x, y: groupBBox.y },
            { x: groupBBox.x + groupBBox.width, y: groupBBox.y },
            { x: groupBBox.x + groupBBox.width, y: groupBBox.y + groupBBox.height },
            { x: groupBBox.x, y: groupBBox.y + groupBBox.height },
          ];
          for (let i = 0; i < groupHandles.length; i++) {
            const gh = groupHandles[i];
            const r = i === 2 ? brHandleR : handleR;
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 1.5 * inv;
            ctx.beginPath();
            ctx.arc(gh.x, gh.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }

          // Rotation handle at top-center
          const rotDist = 26 * inv;
          const topMidX = groupBBox.x + groupBBox.width / 2;
          const topMidY = groupBBox.y;
          const rotHandleX = topMidX;
          const rotHandleY = topMidY - rotDist;
          ctx.save();
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1 * inv;
          ctx.beginPath();
          ctx.moveTo(topMidX, topMidY);
          ctx.lineTo(rotHandleX, rotHandleY);
          ctx.stroke();
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#22d3ee';
          ctx.lineWidth = 1.5 * inv;
          ctx.beginPath();
          ctx.arc(rotHandleX, rotHandleY, handleR, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      }

      // Draw bottom-edge glow when user is dragging near the bottom (read from ref to avoid re-creating this effect)
      const glowVal = bottomGlowRef.current;
      if (glowVal > 0 && onExpandArtboard) {
        ctx.save();
        const glowH = canvasHeight * 0.18;
        const grad = ctx.createLinearGradient(0, canvasHeight - glowH, 0, canvasHeight);
        const alpha = 0.15 + glowVal * 0.45;
        grad.addColorStop(0, 'rgba(6, 182, 212, 0)');
        grad.addColorStop(0.5, `rgba(6, 182, 212, ${(alpha * 0.5).toFixed(3)})`);
        grad.addColorStop(1, `rgba(6, 182, 212, ${alpha.toFixed(3)})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, canvasHeight - glowH, canvasWidth, glowH);

        const barH = 4 * dpiScaleRef.current;
        ctx.fillStyle = `rgba(34, 211, 238, ${(0.6 + glowVal * 0.4).toFixed(2)})`;
        ctx.fillRect(0, canvasHeight - barH, canvasWidth * glowVal, barH);

        const fontSize = Math.max(11, 13 * dpiScaleRef.current);
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = `rgba(255, 255, 255, ${(0.5 + glowVal * 0.5).toFixed(2)})`;
        const seconds = Math.max(0, 2 - Math.round(glowVal * 2));
        ctx.fillText(
          seconds > 0 ? `Expand sheet in ${seconds}s…` : 'Expanding…',
          canvasWidth / 2,
          canvasHeight - barH - 6 * dpiScaleRef.current,
        );
        ctx.restore();
      }

      } catch (err) { console.warn('Render error:', err); }
      };
      renderRef.current = doRender;
      doRender();
    }, [imageInfo, resizeSettings, previewDims.height, previewDims.width, artboardWidth, artboardHeight, designTransform, designs, selectedDesignId, selectedDesignIds, drawSingleDesign, overlappingDesigns, previewBgColor, zoomDpiTier, isMobile]);

    const drawImageWithResizePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const t = designTransform || { nx: 0.5, ny: 0.5, s: 1, rotation: 0 };
      const rect = computeLayerRect(
        imageInfo.image.width, imageInfo.image.height,
        t,
        canvasWidth, canvasHeight,
        artboardWidth, artboardHeight,
        resizeSettings.widthInches, resizeSettings.heightInches,
      );

      const selDesign = selectedDesignId ? designs.find(d => d.id === selectedDesignId) : null;
      ctx.save();
      if (selDesign?.alphaThresholded) ctx.imageSmoothingEnabled = false;
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      ctx.translate(cx, cy);
      ctx.rotate((t.rotation * Math.PI) / 180);
      ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
      ctx.drawImage(imageInfo.image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
      const overlayCanvas = createSpotOverlayCanvasRef.current?.(imageInfo.image) ?? null;
      if (overlayCanvas) {
        ctx.globalAlpha = spotPulseRef.current * 0.7;
        ctx.drawImage(overlayCanvas, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      drawSelectionHandles(ctx, rect, t);
    };

    const drawSelectionHandles = (ctx: CanvasRenderingContext2D, rect: {x: number; y: number; width: number; height: number}, t: ImageTransform) => {
      const isOverlap = selectedDesignId ? overlappingDesigns.has(selectedDesignId) : false;
      const accentColor = isOverlap ? '#ff4444' : '#22d3ee';
      const accentGlow = isOverlap ? 'rgba(255,68,68,0.3)' : 'rgba(34,211,238,0.25)';
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const hw = rect.width / 2;
      const hh = rect.height / 2;
      const rad = (t.rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const z = Math.max(0.25, zoomRef.current);
      const inv = dpiScaleRef.current / z;

      const corners = [
        { lx: -hw, ly: -hh },
        { lx: hw, ly: -hh },
        { lx: hw, ly: hh },
        { lx: -hw, ly: hh },
      ];
      const pts = corners.map(c => ({
        x: cx + c.lx * cos - c.ly * sin,
        y: cy + c.lx * sin + c.ly * cos,
      }));

      ctx.save();

      ctx.shadowColor = accentGlow;
      ctx.shadowBlur = 8 * inv;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5 * inv;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (isOverlap) {
        const fontSize = Math.round(11 * inv);
        ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
        ctx.fillStyle = '#ff4444';
        ctx.textAlign = 'center';
        const botMidX = (pts[2].x + pts[3].x) / 2;
        const botMidY = (pts[2].y + pts[3].y) / 2;
        const offsetDown = 14 * inv;
        const labelX = botMidX + sin * offsetDown;
        const labelY = botMidY + cos * offsetDown;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText('Overlapping', labelX, labelY);
        ctx.restore();
      }

      const handleSize = 5 * inv;
      const handleR = 1.5 * inv;
      const borderW = 1.5 * inv;
      const brHandleSize = isMobile ? handleSize * 2 : handleSize;
      const brHandleR = isMobile ? handleR * 2 : handleR;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const isBr = i === 2;
        const sz = isBr ? brHandleSize : handleSize;
        const r = isBr ? brHandleR : handleR;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rad);
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 3 * inv;
        ctx.shadowOffsetY = 1 * inv;
        ctx.beginPath();
        ctx.roundRect(-sz, -sz, sz * 2, sz * 2, r);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = borderW;
        ctx.stroke();
        ctx.restore();
      }

      const topMidX = (pts[0].x + pts[1].x) / 2;
      const topMidY = (pts[0].y + pts[1].y) / 2;
      const rotDist = 24 * inv;
      const upDirX = -sin;
      const upDirY = -cos;
      const rotHandleX = topMidX + upDirX * rotDist;
      const rotHandleY = topMidY + upDirY * rotDist;

      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1 * inv;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(topMidX, topMidY);
      ctx.lineTo(rotHandleX, rotHandleY);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 3 * inv;
      ctx.shadowOffsetY = 1 * inv;
      const rotR = 6 * inv;
      ctx.beginPath();
      ctx.arc(rotHandleX, rotHandleY, rotR, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = borderW;
      ctx.stroke();
      ctx.restore();

      ctx.save();
      ctx.translate(rotHandleX, rotHandleY);
      ctx.rotate(rad);
      const arrowR = 3.5 * inv;
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.2 * inv;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, arrowR, -Math.PI * 0.7, Math.PI * 0.4);
      ctx.stroke();
      const tipAngle = Math.PI * 0.4;
      const tipX = arrowR * Math.cos(tipAngle);
      const tipY = arrowR * Math.sin(tipAngle);
      const aLen = 2.5 * inv;
      ctx.beginPath();
      ctx.moveTo(tipX + aLen * Math.cos(tipAngle - 0.3), tipY + aLen * Math.sin(tipAngle - 0.3));
      ctx.lineTo(tipX, tipY);
      ctx.lineTo(tipX + aLen * Math.cos(tipAngle + Math.PI * 0.5), tipY + aLen * Math.sin(tipAngle + Math.PI * 0.5));
      ctx.stroke();
      ctx.restore();

      ctx.restore();
    };

    return (
      <div className="h-full flex flex-col">
        {/* Canvas area - fills available height */}
        <div
          ref={canvasAreaRef}
          onMouseDown={handleMouseDown}
          onContextMenu={handleContextMenu}
          onDoubleClick={handleDoubleClick}
          onMouseMove={handleMouseMove}
          onMouseEnter={handleMouseEnter}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          className="flex-1 min-h-0 flex items-center justify-center bg-gray-100 p-3 relative overflow-hidden cursor-default"
          style={{ userSelect: 'none', touchAction: 'none' }}
        >
          <div className="relative" style={{ paddingBottom: Math.abs(zoom - 1) < 0.03 ? 16 : 0, paddingRight: Math.abs(zoom - 1) < 0.03 ? 14 : 0 }}>
            <div 
              ref={containerRef}
              className={`relative flex items-center justify-center ${Math.abs(zoom - 1) < 0.03 ? 'rounded-lg border border-gray-300' : ''}`}
              style={{ 
                width: previewDims.width,
                height: previewDims.height,
                backgroundColor: 'transparent',
              }}
            >
              <canvas 
                ref={canvasRef}
                className="relative z-10 block"
                style={{ 
                  width: previewDims.width,
                  height: previewDims.height,
                  maxWidth: '100%',
                  maxHeight: '100%',
                  transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
                  transformOrigin: 'center',
                  willChange: 'transform',
                  transition: isWheelZoomingRef.current || isPanningRef.current || suppressTransitionRef.current || activeScrollAxis ? 'none' : 'transform 0.15s ease-out',
                  pointerEvents: 'none',
                }}
              />
              
              {!imageInfo && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-gray-300 text-sm opacity-50">Upload a design</p>
                </div>
              )}


            </div>
            {Math.abs(zoom - 1) < 0.03 && (
              <div className="absolute bottom-0 left-0 right-3.5 flex justify-center pointer-events-none">
                <span className={`text-gray-600 font-medium tracking-wide ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`}>{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
              </div>
            )}
            {Math.abs(zoom - 1) < 0.03 && (
              <div className="absolute right-0 top-0 bottom-4 flex items-center pointer-events-none">
                <span className={`text-gray-600 font-medium tracking-wide ${lang === 'en' ? 'text-[10px]' : 'text-[9px]'}`} style={{ writingMode: 'vertical-rl' }}>{formatLength(artboardHeight, lang)}{lang === "en" ? '"' : ""}</span>
              </div>
            )}
          </div>
          {/* Horizontal scrollbar */}
          {(() => {
            const { rawThumbFrac } = getScrollMetrics('x', zoom);
            if (rawThumbFrac >= 0.98) return null;
            const isActive = activeScrollAxis === 'x';
            const isHovered = scrollbarHover === 'x';
            const trackH = isActive ? 20 : isHovered ? 16 : 12;
            const hRight = (scrollbarHover === 'y' || activeScrollAxis === 'y') ? 38 : 34;
            const vw = canvasAreaRef.current?.clientWidth || 500;
            const trackWEst = vw - 4 - hRight;
            const thumbFrac = Math.max(rawThumbFrac, 32 / Math.max(1, trackWEst));
            const { maxScroll } = getScrollMetrics('x', zoom);
            const scrollX = panToScroll('x', panX, zoom);
            const t = maxScroll > 0 ? Math.max(0, Math.min(1, scrollX / maxScroll)) : 0.5;
            const thumbLeft = t * (1 - thumbFrac);
            return (
              <div
                data-scrollbar
                className="absolute z-30"
                style={{
                  bottom: 0,
                  left: 4,
                  right: (scrollbarHover === 'y' || activeScrollAxis === 'y') ? 36 : 32,
                  height: isActive ? 36 : 32,
                  display: 'flex',
                  alignItems: 'flex-end',
                  paddingBottom: isActive ? 0 : 1,
                  pointerEvents: 'auto',
                  cursor: 'default',
                }}
                onPointerDown={(e) => handleScrollbarPointerDown('x', e, false)}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseEnter={() => setScrollbarHover('x')}
                onMouseLeave={() => { if (!activeScrollAxis) setScrollbarHover(null); }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    height: trackH,
                    borderRadius: trackH / 2,
                    backgroundColor: isActive ? 'rgba(56, 189, 248, 0.25)' : isHovered ? 'rgba(148, 163, 184, 0.22)' : 'rgba(100, 116, 139, 0.18)',
                    boxShadow: isActive ? '0 0 0 1px rgba(56,189,248,0.55), 0 0 12px rgba(56,189,248,0.35)' : 'inset 0 0 0 1px rgba(148,163,184,0.22)',
                    transition: 'height 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease',
                  }}
                >
                  <div
                    data-scrollbar
                    data-scrollbar-thumb-x=""
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: `${thumbLeft * 100}%`,
                      width: `${thumbFrac * 100}%`,
                      height: '100%',
                      borderRadius: trackH / 2,
                      background: isActive
                        ? 'linear-gradient(180deg, rgba(125,211,252,0.96), rgba(56,189,248,0.88))'
                        : isHovered
                          ? 'linear-gradient(180deg, rgba(226,232,240,0.88), rgba(148,163,184,0.82))'
                          : 'linear-gradient(180deg, rgba(203,213,225,0.72), rgba(148,163,184,0.65))',
                      boxShadow: isActive ? '0 0 0 1px rgba(186,230,253,0.6), 0 0 10px rgba(56,189,248,0.45)' : '0 0 0 1px rgba(148,163,184,0.35)',
                      cursor: 'default',
                      transform: isActive ? 'scaleY(1.08)' : 'scaleY(1)',
                      transition: 'background 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease',
                      pointerEvents: 'auto',
                    }}
                    onPointerDown={(e) => handleScrollbarPointerDown('x', e, true)}
                  />
                </div>
              </div>
            );
          })()}

          {/* Vertical scrollbar */}
          {(() => {
            const { rawThumbFrac } = getScrollMetrics('y', zoom);
            if (rawThumbFrac >= 0.98) return null;
            const isActive = activeScrollAxis === 'y';
            const isHovered = scrollbarHover === 'y';
            const trackW = isActive ? 20 : isHovered ? 16 : 12;
            const vBottom = (scrollbarHover === 'x' || activeScrollAxis === 'x') ? 38 : 34;
            const vh = canvasAreaRef.current?.clientHeight || 400;
            const trackHEst = vh - 4 - vBottom;
            const thumbFrac = Math.max(rawThumbFrac, 32 / Math.max(1, trackHEst));
            const { maxScroll } = getScrollMetrics('y', zoom);
            const scrollY = panToScroll('y', panY, zoom);
            const t = maxScroll > 0 ? Math.max(0, Math.min(1, scrollY / maxScroll)) : 0.5;
            const thumbTop = t * (1 - thumbFrac);
            return (
              <div
                data-scrollbar
                className="absolute z-30"
                style={{
                  right: 0,
                  top: 4,
                  bottom: (scrollbarHover === 'x' || activeScrollAxis === 'x') ? 34 : 30,
                  width: isActive ? 36 : 32,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  paddingRight: isActive ? 0 : 1,
                  pointerEvents: 'auto',
                  cursor: 'default',
                }}
                onPointerDown={(e) => handleScrollbarPointerDown('y', e, false)}
                onMouseMove={(e) => e.stopPropagation()}
                onMouseEnter={() => setScrollbarHover('y')}
                onMouseLeave={() => { if (!activeScrollAxis) setScrollbarHover(null); }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: trackW,
                    height: '100%',
                    borderRadius: trackW / 2,
                    backgroundColor: isActive ? 'rgba(56, 189, 248, 0.25)' : isHovered ? 'rgba(148, 163, 184, 0.22)' : 'rgba(100, 116, 139, 0.18)',
                    boxShadow: isActive ? '0 0 0 1px rgba(56,189,248,0.55), 0 0 12px rgba(56,189,248,0.35)' : 'inset 0 0 0 1px rgba(148,163,184,0.22)',
                    transition: 'width 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease',
                  }}
                >
                  <div
                    data-scrollbar
                    data-scrollbar-thumb-y=""
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: `${thumbTop * 100}%`,
                      height: `${thumbFrac * 100}%`,
                      width: '100%',
                      borderRadius: trackW / 2,
                      background: isActive
                        ? 'linear-gradient(90deg, rgba(125,211,252,0.96), rgba(56,189,248,0.88))'
                        : isHovered
                          ? 'linear-gradient(90deg, rgba(226,232,240,0.88), rgba(148,163,184,0.82))'
                          : 'linear-gradient(90deg, rgba(203,213,225,0.72), rgba(148,163,184,0.65))',
                      boxShadow: isActive ? '0 0 0 1px rgba(186,230,253,0.6), 0 0 10px rgba(56,189,248,0.45)' : '0 0 0 1px rgba(148,163,184,0.35)',
                      cursor: 'default',
                      transform: isActive ? 'scaleX(1.08)' : 'scaleX(1)',
                      transition: 'background 0.12s ease, box-shadow 0.12s ease, transform 0.12s ease',
                      pointerEvents: 'auto',
                    }}
                    onPointerDown={(e) => handleScrollbarPointerDown('y', e, true)}
                  />
                </div>
              </div>
            );
          })()}

          {/* Native-like scroll source (hidden, drives pan/zoom viewport math) */}
          <div
            ref={nativeScrollRef}
            aria-hidden
            tabIndex={-1}
            className="native-scroll-hidden"
            style={{
              position: 'absolute',
              inset: 0,
              overflow: 'auto',
              opacity: 0,
              pointerEvents: 'none',
              zIndex: -1,
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (syncingScrollRef.current || isPanningRef.current || scrollDragRef.current || selectionZoomActiveRef.current) return;
              const z = zoomRef.current;
              const nextX = scrollToPan('x', el.scrollLeft, z);
              const nextY = scrollToPan('y', el.scrollTop, z);
              queuePanStateCommit(nextX, nextY);
            }}
          >
            <div style={{ width: Math.max(1, zoom * previewDims.width), height: Math.max(1, zoom * previewDims.height) }} />
          </div>

          {selZoomRect && (
            <div
              className="absolute pointer-events-none z-50"
              style={{
                left: selZoomRect.x,
                top: selZoomRect.y,
                width: selZoomRect.w,
                height: selZoomRect.h,
                border: '2px dashed #f59e0b',
                backgroundColor: 'rgba(245, 158, 11, 0.10)',
                borderRadius: 2,
              }}
            />
          )}
          {marqueeScreenRect && marqueeScreenRect.w > 2 && marqueeScreenRect.h > 2 && (
            <div
              className="absolute pointer-events-none z-40"
              style={{
                left: marqueeScreenRect.x,
                top: marqueeScreenRect.y,
                width: marqueeScreenRect.w,
                height: marqueeScreenRect.h,
                border: '1.5px solid #22d3ee',
                backgroundColor: 'rgba(34, 211, 238, 0.10)',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.25), inset 0 0 0 1px rgba(34,211,238,0.15)',
                borderRadius: 2,
              }}
            />
          )}
          {showDragPerfDebug && dragPerfText && (
            <div
              className="absolute top-2 right-2 z-50 pointer-events-none"
              style={{
                fontSize: 11,
                lineHeight: '14px',
                color: '#bae6fd',
                background: 'rgba(2, 6, 23, 0.78)',
                border: '1px solid rgba(56, 189, 248, 0.45)',
                borderRadius: 6,
                padding: '4px 8px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {dragPerfText}
            </div>
          )}
        </div>

        {/* Bottom toolbar */}
        <div className="flex-shrink-0 flex items-center justify-between gap-2 bg-gray-100 border-t border-gray-200 px-2 py-1.5 lg:px-3 lg:py-1.5 min-w-0">
              <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto overflow-y-hidden flex-1 [scrollbar-width:thin]">
                {selectedDesignId && designTransform && (
                  <>
                    <span className={`font-medium tabular-nums text-gray-600 ${lang !== 'en' ? 'text-[10px] max-w-[110px] truncate sm:max-w-none' : 'text-[11px]'}`}>
                      {formatDimensions(
                        resizeSettings.widthInches * (designTransform.s || 1),
                        resizeSettings.heightInches * (designTransform.s || 1),
                        lang
                      )}
                    </span>
                    <div className="w-px h-3.5 bg-gray-300" />
                    {editingRotation ? (
                      <input
                        type="number"
                        className="w-12 h-5 bg-gray-100 text-[11px] text-gray-900 text-center rounded border border-gray-300 outline-none"
                        value={rotationInput}
                        autoFocus
                        onChange={(e) => setRotationInput(e.target.value)}
                        onBlur={() => {
                          setEditingRotation(false);
                          const val = parseFloat(rotationInput);
                          if (!isNaN(val) && onTransformChange) {
                            onTransformChange({ ...designTransform, rotation: ((val % 360) + 360) % 360 });
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        }}
                      />
                    ) : (
                      <span
                        className="text-[11px] text-gray-600 font-medium cursor-pointer hover:text-gray-900 tabular-nums"
                        title={t("preview.editRotation")}
                        onClick={() => {
                          setRotationInput(String(Math.round(designTransform.rotation || 0)));
                          setEditingRotation(true);
                        }}
                      >
                        {Math.round(designTransform.rotation || 0)}°
                      </span>
                    )}
                    <div className="w-px h-3.5 bg-gray-300" />
                  </>
                )}
                <div className="flex items-center gap-0.5 flex-shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-8 w-8 sm:h-6 sm:w-6 p-0 hover:bg-gray-200 rounded flex items-center justify-center"
                    onClick={() => {
                      const newZ = Math.max(zoom / ZOOM_BUTTON_FACTOR, minZoomRef.current);
                      const clamped = clampPanValue(panX, panY, newZ);
                      setZoom(newZ);
                      queuePanStateCommit(clamped.x, clamped.y);
                      if (canvasAreaRef.current) {
                        const el = canvasAreaRef.current;
                        el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                      }
                    }}
                    title={t("preview.zoomOut")}
                  >
                    <ZoomOut className="h-3 w-3 text-gray-600" />
                  </Button>
                  <span className="text-[11px] text-gray-600 min-w-[36px] text-center font-medium tabular-nums">
                    {Math.round(zoom * 100)}%
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-[40px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-8 w-8 sm:h-6 sm:w-6 p-0 hover:bg-gray-200 rounded flex items-center justify-center"
                    onClick={() => {
                      const newZ = Math.min(zoom * ZOOM_BUTTON_FACTOR, zoomMax);
                      const clamped = clampPanValue(panX, panY, newZ);
                      setZoom(newZ);
                      queuePanStateCommit(clamped.x, clamped.y);
                      if (canvasAreaRef.current) {
                        const el = canvasAreaRef.current;
                        el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                      }
                    }}
                    title={t("preview.zoomIn")}
                  >
                    <ZoomIn className="h-3 w-3 text-gray-600" />
                  </Button>
                </div>
                <div className="w-px h-3.5 bg-gray-300" />
                <Button 
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectionZoomActive(prev => !prev)}
                  className={`h-6 px-1.5 hover:bg-gray-200 rounded whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ${selectionZoomActive ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-600'}`}
                  title={t("preview.selectionZoom")}
                >
                  <ScanSearch className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                  {t("preview.selectToZoom")}
                </Button>
                <Button 
                  variant="ghost"
                  size="sm"
                  onClick={resetView}
                  className={`h-6 px-1.5 hover:bg-gray-200 rounded text-gray-600 whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'}`}
                  title={t("preview.resetView")}
                >
                  <RotateCcw className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                  {t("preview.reset")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMoveMode(prev => {
                      const next = !prev;
                      if (canvasAreaRef.current) {
                        canvasAreaRef.current.style.cursor = (isHorizOverflow() && !next) ? 'grab' : 'default';
                      }
                      return next;
                    });
                  }}
                  className={`h-6 px-1.5 hover:bg-gray-200 rounded whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ${moveMode ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-600'}`}
                  title={t("preview.moveMode")}
                >
                  <MousePointer2 className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                  {t("preview.move")}
                </Button>
                {selectedDesignId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={zoomToSelected}
                    className={`h-6 px-1.5 hover:bg-gray-200 rounded text-gray-600 whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'}`}
                    title={t("preview.focusTitle")}
                  >
                    <Focus className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                    {t("preview.focus")}
                  </Button>
                )}
              </div>

              <div className="flex items-center gap-1 flex-shrink-0">
                {[
                  { color: 'transparent', label: 'Transparent' },
                  { color: '#ffffff', label: 'White' },
                  { color: '#d1d5db', label: 'Light Gray' },
                  { color: '#6b7280', label: 'Gray' },
                  { color: '#000000', label: 'Black' },
                ].map(({ color, label }) => (
                  <button
                    key={color}
                    onClick={() => setPreviewBgColor(color)}
                    className={`w-4.5 h-4.5 rounded-full border-2 transition-all ${previewBgColor === color ? 'border-cyan-400 scale-110' : 'border-gray-300 hover:border-gray-500'}`}
                    title={label}
                    style={{
                      width: 18,
                      height: 18,
                      background: color === 'transparent'
                        ? 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 6px 6px'
                        : color
                    }}
                  />
                ))}
              </div>
            </div>

        {/* Keyboard shortcut hints */}
        <div className="hidden lg:flex flex-shrink-0 items-center justify-center gap-4 bg-gray-100/90 border-t border-gray-200/80 px-3 py-0.5 text-[9px] text-gray-600">
          {[
            ['Ctrl+Z', 'Undo'], ['Ctrl+C/V', 'Copy/Paste'],
            ['Alt+Drag', 'Duplicate'], ['Drag Empty', 'Select'],
            ['Arrows', 'Nudge'], ['Ctrl+Scroll', 'Zoom'], ['Space+Drag', 'Pan'],
          ].map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="px-1 py-px rounded bg-gray-200/60 text-gray-600 font-mono">{key}</kbd>
              <span>{label}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }
);

PreviewSection.displayName = 'PreviewSection';

export default PreviewSection;
