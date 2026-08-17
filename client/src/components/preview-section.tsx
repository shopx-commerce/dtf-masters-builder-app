import { useEffect, useLayoutEffect, useRef, forwardRef, useImperativeHandle, useState, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { ZoomIn, ZoomOut, RotateCcw, ScanSearch, Focus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/lib/i18n";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatLength, formatDimensions } from "@/lib/format-length";
import { Button } from "@/components/ui/button";
import { ImageInfo, ResizeSettings, type ImageTransform, type DesignItem } from "./image-editor";
import { RotationBadge } from "./image-editor/rotation-badge";
import { computeLayerRect } from "@/lib/types";
import { inkInset } from "@/lib/nest-core";
import { getDesignNestMask } from "@/lib/nest-mask";
import {
  drawPrintLabel,
  labelReadsUpsideDown,
  type PrintLabelLayout,
} from "@/lib/print-label";
import { getDesignLabel, getStampExtraAtSize } from "./image-editor/utils";

const BASE_DPI_SCALE = 2;
const HIGH_QUALITY_DETAIL_ZOOM = 3;
const HIGH_QUALITY_DETAIL_MAX_AREA = 4_000_000;
const HIGH_QUALITY_DETAIL_MAX_EDGE = 4096;
// The preview canvas is inset inside the zoom wrapper and draws its border
// OUTSIDE the pixel surface (`box-sizing: content-box`), so the surface —
// the space `computeLayerRect` returns coordinates in — starts at
// inset + border. Overlays aligned to the artwork must use that same origin.
const PREVIEW_CANVAS_INSET = 3;
const PREVIEW_CANVAS_BORDER = 3;
const PREVIEW_SURFACE_ORIGIN = PREVIEW_CANVAS_INSET + PREVIEW_CANVAS_BORDER;
/** Thickness of the inch-ruler strips pinned to the top and left of the canvas area. */
const RULER_GUTTER_PX = 18;
/**
 * Breathing room between a ruler and the sheet. The sheet must never sit under
 * a ruler: the strip hides the sheet's own edge, and customers read that as
 * their artwork being cropped.
 */
const SHEET_RULER_GAP_PX = 4;
/** Left offset the paper box already carries on mobile, via `containerRef`. */
const MOBILE_CONTAINER_MARGIN_LEFT = 6;
const MOBILE_CANVAS_PAD_TOP = RULER_GUTTER_PX + SHEET_RULER_GAP_PX;
const MOBILE_CANVAS_PAD_LEFT = MOBILE_CANVAS_PAD_TOP - MOBILE_CONTAINER_MARGIN_LEFT;
const MOBILE_CANVAS_PAD_BOTTOM = 12;
const DESKTOP_CANVAS_PAD = 12;
/**
 * The full drawn width of a selection resize handle, in screen CSS px, before
 * it is capped against the size of the artwork it decorates. A single-selection
 * square and a multi-selection circle both read as this across at any zoom.
 *
 * All four corners are the same size: the bottom-right used to paint at 2x on
 * touch, which on a phone made it 40 CSS px across — 80% of an 8in design and
 * over 250% of a 1in one — while the other three stayed 20. Touch gets a
 * slightly larger glyph than pointer devices, and hit-testing keeps its own,
 * larger radius — see `hitTestHandles` — so the drawn size never dictates how
 * big the grab area is.
 */
const TOUCH_HANDLE_FULL_PX = 16;
const DESKTOP_HANDLE_FULL_PX = 12;
/**
 * Pointer-device hit-test ring radii, as multiples of the *drawn* handle half-extent
 * above. Keeping them relative to the drawn size is right for a mouse, which can land
 * on a 12 CSS px glyph unaided: the hit tests previously hardcoded a base of 10,
 * which silently became an orphaned copy of the touch handle size when the pointer handle
 * shrank to 6. Desktop then hit-tested resize out to 14px around a 6px glyph and rotate out
 * to 30px, so a click 15-30px outside a corner — aiming to start a marquee — rotated the
 * design instead, with nothing drawn to explain why.
 */
const HANDLE_HIT_BOOST = 1.4;
const HANDLE_ROTATE_RING = 3.0;
/**
 * Touch hit-test ring radii, in screen CSS px from the corner — absolute, not a
 * multiple of the drawn glyph.
 *
 * A multiple ties the thumb target to however large the design happens to be drawn.
 * At 1.4x a 20 CSS px glyph earned a 28 CSS px resize target, well under the 44 CSS px
 * minimum, and everything from 28 out to 60 was rotate rather than a bigger resize —
 * so shrinking the glyph for legibility shrank the target with it. 22 gives the 44
 * across that a thumb needs at any design size. The rotate band has to be absolute
 * too: 3x22 would reach 132 CSS px on a 159 CSS px phone canvas and swallow the whole
 * design.
 */
const TOUCH_RESIZE_HIT_R_CSS_PX = 22;
const TOUCH_ROTATE_OUTER_R_CSS_PX = 34;
/**
 * Garment colours the sheet can be previewed against — the answer to "how will this look
 * on a black shirt". Shared by the desktop row and the phone's compact picker so the two
 * cannot drift apart.
 */
const BACKDROP_COLORS = [
  { color: 'transparent', label: 'Transparent' },
  { color: '#ffffff', label: 'White' },
  { color: '#d1d5db', label: 'Light Gray' },
  { color: '#6b7280', label: 'Gray' },
  { color: '#000000', label: 'Black' },
];
/**
 * Floor on the drawn handle, as a full width/diameter in screen CSS px. Kept in
 * screen space (not canvas-buffer space) so zooming out cannot shrink a handle
 * into an invisible sliver the way a buffer-relative floor did.
 */
const MIN_HANDLE_CSS_PX = 8;
/** Below this zoom the canvas is genuinely zoomed out and handles stay compact. */
const LOW_ZOOM_HANDLE_MAX_ZOOM = 0.5;
/**
 * Full drawn width of a handle below `LOW_ZOOM_HANDLE_MAX_ZOOM`, in screen CSS px.
 * A flat CSS size rather than a fraction of the normal one, because a fractional
 * scale compounds with the zoom that triggered it: 0.25x of a design-relative
 * handle drew a 0.4 CSS px sliver at 10% zoom.
 */
const LOW_ZOOM_HANDLE_FULL_CSS_PX = 8;
/**
 * Short on-screen edge, in CSS px, below which a design is decorated with its
 * outline alone and no corner handles at all.
 *
 * Under this size the floor above is what sets the handle, not the artwork, so
 * the four corners stop describing the selection and start hiding it: at 20 CSS
 * px they cover more of the design than the design shows of itself. An outline
 * still says "selected", the body still drags, the sizing fields still resize,
 * and zooming in brings the handles back — `minEdgeCssPx` is measured on screen,
 * so magnifying the artwork is what earns the corners.
 */
const OUTLINE_ONLY_BELOW_CSS_PX = 24;
/**
 * Half the drawn extent of a handle, in screen CSS px, or `0` to mean "draw the
 * outline and no handles" — see `OUTLINE_ONLY_BELOW_CSS_PX`. Callers must treat
 * zero as a signal and skip both the glyph and its hit ring, or they leave an
 * invisible target behind.
 *
 * `minEdgeCssPx` is the shorter on-screen edge of the design or group box being
 * decorated, so something far smaller than a full-size handle shrinks its
 * handles instead of disappearing underneath them, down to `MIN_HANDLE_CSS_PX`.
 * `shareOfEdge` is the share of that edge one handle may span, and differs
 * between a single design and a group box.
 *
 * That share used to be applied to the half-extent while being documented as the
 * share of the edge, so every handle spanned twice what it claimed: 50% of a
 * single design's short edge rather than 25%, which is why handles read as
 * growing as artwork shrank. They were not growing — they held a fixed and far
 * too generous proportion while the design fell away beneath them.
 */
function getHandleHalfCssPx(
  minEdgeCssPx: number,
  zoom: number,
  touch: boolean,
  shareOfEdge: number,
): number {
  if (minEdgeCssPx < OUTLINE_ONLY_BELOW_CSS_PX) return 0;
  const base = touch ? TOUCH_HANDLE_FULL_PX : DESKTOP_HANDLE_FULL_PX;
  const full = Math.max(MIN_HANDLE_CSS_PX, Math.min(base, minEdgeCssPx * shareOfEdge));
  const capped = zoom < LOW_ZOOM_HANDLE_MAX_ZOOM
    ? Math.min(full, LOW_ZOOM_HANDLE_FULL_CSS_PX)
    : full;
  return capped / 2;
}

/**
 * Whether a selection is drawn large enough on screen to carry a rotate band.
 *
 * That band is an invisible annulus around each corner — 22 to 34 CSS px on
 * touch. Once the short on-screen edge drops below twice the outer radius the
 * four bands meet across the middle of the artwork, and there is no longer any
 * part of the design that is not also a rotate target. A 4in design on a 24.5in
 * sheet is 56 CSS px wide on a phone, and its centre sits about 31 CSS px from
 * the nearest corner: inside the band. Tapping the middle of it to drag rotated
 * it instead, with nothing on screen to explain why.
 *
 * Below the threshold there is no rotation at all. The measurement is taken on
 * screen rather than in inches, so zooming in is what earns it back — the same
 * bargain `OUTLINE_ONLY_BELOW_CSS_PX` strikes for the corner glyphs, and the
 * reason this is a gate rather than the removal of a feature.
 */
function selectionCanRotate(minEdgeCssPx: number, rotateOuterCssPx: number): boolean {
  return minEdgeCssPx >= rotateOuterCssPx * 2;
}
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

/** CSS pixel size of the preview “paper” from the gray viewport and artboard aspect (same math as resize handler). */
function computePreviewDimensions(
  availW: number,
  availH: number,
  artboardWidth: number,
  artboardHeight: number,
  fitWidthOnly = false,
): { w: number; h: number } | null {
  if (availW <= 0 || availH <= 0 || artboardHeight <= 0) return null;
  const artboardAspect = artboardWidth / artboardHeight;
  // On narrow mobile preview + side panel layouts, a hard 200px minimum can overflow.
  const minEdge = isNarrowViewport() ? 120 : 200;
  let w: number;
  let h: number;
  if (fitWidthOnly) {
    // The paper is allowed to run past the bottom of the viewport so a longer
    // sheet grows downward into scrollable space instead of being squeezed
    // into the visible height. See `topAlignRef`.
    w = Math.round(Math.max(minEdge, availW));
    h = Math.round(w / artboardAspect);
  } else if (availW / availH > artboardAspect) {
    h = Math.round(Math.max(minEdge, availH));
    w = Math.round(h * artboardAspect);
  } else {
    w = Math.round(Math.max(minEdge, availW));
    h = Math.round(w / artboardAspect);
  }
  return { w, h };
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

/**
 * How long an overlap check may run before its worker is assumed dead rather than slow.
 *
 * A worker that dies without dispatching `error` — what a Safari or Firefox worker OOM
 * looks like — would otherwise leave the red overlap highlighting stuck on whatever it
 * last said, with no listener ever removed and no fallback ever run.
 */
const OVERLAP_TIMEOUT_MS = 60_000;

interface PreviewSectionProps {
  imageInfo: ImageInfo | null;
  resizeSettings: ResizeSettings;
  artboardWidth?: number;
  artboardHeight?: number;
  designTransform?: ImageTransform;
  onTransformChange?: (transform: ImageTransform) => void;
  designs?: DesignItem[];
  /**
   * Bumped by the editor each time an auto-arrange commits new positions, which is the cue to
   * slide the designs into them instead of having them appear there. A counter rather than a
   * flag because consecutive arranges have to be distinguishable, and because diffing the
   * designs could not tell an arrange apart from a drag.
   */
  arrangeEpoch?: number;
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
  activeSpotChannel?: string | null;
  onWandTap?: (nx: number, ny: number, designId: string) => void;
  panModeActive?: boolean;
  onPanModeChange?: (active: boolean) => void;
  selectionZoomActive?: boolean;
  onSelectionZoomChange?: (active: boolean) => void;
  wandDeleteActive?: boolean;
  onWandDeleteTap?: (nx: number, ny: number, designId: string) => void;
  onWandDeactivate?: () => void;
  /**
   * Called once with a function that fits the view to the selected design —
   * the Focus button's action, made available to the parent.
   *
   * Must be referentially stable, since it is an effect dependency.
   */
  onRegisterFocus?: (focus: () => void) => void;
  bottomToolbarContainer?: HTMLElement | null;
  /**
   * Somewhere else to put the backdrop colour swatches.
   *
   * They normally ride along at the right-hand end of the bottom toolbar, but
   * that row is 390px wide on a phone and the swatches are 135 of them. Given a
   * container, they go there instead and the toolbar keeps only the view
   * controls, which is what buys the room for the labelled undo/redo beside it.
   */
  backdropSwatchContainer?: HTMLElement | null;
}

const PreviewSection = forwardRef<HTMLCanvasElement, PreviewSectionProps>(
  ({ imageInfo, resizeSettings, artboardWidth = 24.5, artboardHeight = 12, designTransform, onTransformChange, designs = [], arrangeEpoch = 0, selectedDesignId, selectedDesignIds = new Set(), onSelectDesign, onMultiSelect, onMultiDragDelta, onMultiResizeDelta, onMultiRotateDelta, onDuplicateSelected, onInteractionEnd, onExpandArtboard, onDesignContextMenu, spotPreviewData, activeSpotChannel, onWandTap, panModeActive = false, onPanModeChange, selectionZoomActive: selectionZoomActiveProp, onSelectionZoomChange, bottomToolbarContainer, backdropSwatchContainer, wandDeleteActive = false, onWandDeleteTap, onWandDeactivate, onRegisterFocus }, ref) => {
    const { toast } = useToast();
    const { t, lang } = useLanguage();
    const isMobile = useIsMobile();
    /**
     * Phones anchor the gangsheet to the top of the viewport and scroll it,
     * rather than centring it and shrinking it to fit.
     *
     * Centring strands a band of empty grey above a short sheet, and on a phone
     * — where the layers sheet already covers the lower half — that band is
     * most of the usable canvas. Fitting a long sheet to the viewport height is
     * just as wasteful the other way: a 120 inch sheet becomes a thin strip.
     * Anchored to the top the sheet takes the full width, starts just under the
     * ruler, and extends downward into scrollable space as it grows.
     *
     * Held in a ref because the camera callbacks below are deliberately
     * dependency-free; reading it live avoids rebuilding them, and avoids the
     * stale closures that adding a dependency here would risk.
     */
    const topAlignRef = useRef(isMobile);
    topAlignRef.current = isMobile;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const detailCanvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const resizeLimitToastRef = useRef(0);
    const zoomMax = Math.max(10, Math.ceil(artboardHeight / Math.max(artboardWidth, 0.1)) * 3);
    const zoomMaxRef = useRef(zoomMax);
    zoomMaxRef.current = zoomMax;
    const [zoom, setZoom] = useState(1);
    // The DPI tier bump (crisper canvas buffer at higher zoom) is deferred
    // until zoom settles: applying it mid-gesture resizes the canvas buffer
    // and forces a full composite rebuild on every tier crossing, which makes
    // wheel/pinch zoom stutter. During the gesture the existing buffer is
    // simply scaled by CSS; ~160ms after the last zoom change we re-render
    // one crisp frame at the final tier. Preview-only — exports untouched.
    const [zoomDpiTier, setZoomDpiTier] = useState(1);
    const zoomTierTimerRef = useRef<number | null>(null);
    useEffect(() => {
      const nextTier = zoom <= 2 ? 1 : zoom <= 5 ? 2 : 3;
      if (nextTier === zoomDpiTier && zoomTierTimerRef.current == null) return;
      if (zoomTierTimerRef.current != null) window.clearTimeout(zoomTierTimerRef.current);
      zoomTierTimerRef.current = window.setTimeout(() => {
        zoomTierTimerRef.current = null;
        const z = zoomRef.current;
        setZoomDpiTier(z <= 2 ? 1 : z <= 5 ? 2 : 3);
      }, 160);
      return () => {
        if (zoomTierTimerRef.current != null) {
          window.clearTimeout(zoomTierTimerRef.current);
          zoomTierTimerRef.current = null;
        }
      };
    }, [zoom, zoomDpiTier]);
    const highQualityDetailZoomActive = zoom >= HIGH_QUALITY_DETAIL_ZOOM;
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
    // A queued-but-uncommitted zoom (rAF-throttled wheel/pinch) must not be
    // clobbered by a re-render triggered by something else (e.g. a pan
    // commit) that still carries the previous zoom state value.
    const pendingZoomCommitRef = useRef<number | null>(null);
    if (pendingZoomCommitRef.current == null) zoomRef.current = zoom;
    const [selectionZoomActiveInternal, setSelectionZoomActiveInternal] = useState(false);
    const selectionZoomActive = selectionZoomActiveProp !== undefined ? selectionZoomActiveProp : selectionZoomActiveInternal;
    const setSelectionZoomActive = useCallback((valOrFn: boolean | ((prev: boolean) => boolean)) => {
      const newVal = typeof valOrFn === 'function' ? valOrFn(selectionZoomActive) : valOrFn;
      setSelectionZoomActiveInternal(newVal);
      onSelectionZoomChange?.(newVal);
    }, [selectionZoomActive, onSelectionZoomChange]);
    const selectionZoomActiveRef = useRef(false);
    selectionZoomActiveRef.current = selectionZoomActive;
    const [moveMode, setMoveMode] = useState(false);
    const moveModeRef = useRef(false);
    const wandDeleteActiveRef = useRef(wandDeleteActive);
    wandDeleteActiveRef.current = wandDeleteActive;
    const activeSpotChannelRef = useRef(activeSpotChannel);
    activeSpotChannelRef.current = activeSpotChannel;
    const onWandTapRef = useRef(onWandTap);
    onWandTapRef.current = onWandTap;
    const panModeActiveRef = useRef(panModeActive);
    panModeActiveRef.current = panModeActive;
    const onWandDeactivateRef = useRef(onWandDeactivate);
    onWandDeactivateRef.current = onWandDeactivate;
    moveModeRef.current = moveMode;
    function setPreviewCursor(cursor: string) {
      const area = canvasAreaRef.current;
      if (!area) return;
      area.style.cursor = wandDeleteActiveRef.current ? "crosshair" : cursor;
    }
    const isSelectionZoomDragging = useRef(false);
    const suppressTransitionRef = useRef(false);
    const selZoomScreenStartRef = useRef<{x: number; y: number}>({x: 0, y: 0});
    const [selZoomRect, setSelZoomRect] = useState<{x: number; y: number; w: number; h: number} | null>(null);
    const selZoomRectRef = useRef(selZoomRect);
    selZoomRectRef.current = selZoomRect;
    const canvasAreaRef = useRef<HTMLDivElement>(null);
    const topRulerRef = useRef<HTMLCanvasElement>(null);
    const leftRulerRef = useRef<HTMLCanvasElement>(null);
    const rulerSigRef = useRef('');
    /** Restarts the ruler tracking loop; see the ruler effect for why it sleeps. */
    const rulerWakeRef = useRef<(() => void) | null>(null);
    const dpiScaleRef = useRef(BASE_DPI_SCALE);
    const lastImageRef = useRef<string | null>(null);
    /** Start at 0×0 so we never paint a wrong aspect (e.g. 360×360) before the first measure — that was the visible “snap”. */
    const [previewDims, setPreviewDims] = useState({ width: 0, height: 0 });
    const previewDimsRef = useRef(previewDims);
    previewDimsRef.current = previewDims;
    /** Skip noisy sub-pixel changes from ResizeObserver / mobile toolbar. */
    const lastStablePreviewDimsRef = useRef<{ w: number; h: number } | null>(null);
    /** Only auto–fit zoom when preview size or artboard actually changes (not on every parent re-render). */
    const lastViewportFitSigRef = useRef<string>('');
    /** The first measured viewport is the only layout measurement allowed to establish the initial zoom. */
    const hasInitialViewportFitRef = useRef(false);
    const spotPulseRef = useRef(1);
    const spotOverlayCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
    const createSpotOverlayCanvasRef = useRef<((source?: HTMLImageElement | HTMLCanvasElement) => HTMLCanvasElement | null) | null>(null);

    /**
     * The two fit zooms for the current viewport.
     *
     * `minZoom` shows the whole sheet and is the floor the user may zoom out
     * to. `initialZoom` is where a fresh or reset view starts. They differ only
     * on the top-anchored mobile view, which starts at full width and lets a
     * long sheet run below the fold — shrinking a 120 inch gangsheet to fit a
     * phone's height would leave an unreadable strip. Zooming out to see the
     * whole thing is still available there, it just isn't the starting point.
     */
    const computeFitZooms = useCallback((): { minZoom: number; initialZoom: number } | null => {
      const area = canvasAreaRef.current;
      const dims = previewDimsRef.current;
      if (!area || dims.width <= 0 || dims.height <= 0) return null;
      const padFraction = 0.03;
      const padX = Math.max(4, Math.round(dims.width * padFraction));
      const padY = Math.max(4, Math.round(dims.height * padFraction));
      const availW = area.clientWidth - padX * 2;
      const availH = area.clientHeight - padY * 2;
      if (availW <= 0 || availH <= 0) return null;
      const snap = (v: number) =>
        Math.max(ZOOM_MIN_ABSOLUTE, Math.min(zoomMaxRef.current, Math.round(v * 20) / 20));
      const minZoom = snap(Math.min(1, availW / dims.width, availH / dims.height));
      const initialZoom = topAlignRef.current ? snap(Math.min(1, availW / dims.width)) : minZoom;
      return { minZoom, initialZoom };
    }, []);

    /** Minimum zoom = fit entire sheet in the gray preview viewport (canvas area), never using the paper box (same as previewDims — that wrongly kept zoom ~1 and looked “zoomed in”). */
    const getMinZoom = useCallback(
      () => computeFitZooms()?.minZoom ?? ZOOM_MIN_ABSOLUTE,
      [computeFitZooms],
    );

    const syncPreviewSizeFromWrapper = useCallback(() => {
      const wrapper = canvasAreaRef.current;
      if (!wrapper) return;
      const availW = wrapper.clientWidth - 48;
      const availH = wrapper.clientHeight - 48;
      const computed = computePreviewDimensions(availW, availH, artboardWidth, artboardHeight, topAlignRef.current);
      if (!computed) return;
      const { w, h } = computed;
      const prev = lastStablePreviewDimsRef.current;
      const eps = isNarrowViewport() ? 8 : 5;
      if (prev && Math.abs(w - prev.w) < eps && Math.abs(h - prev.h) < eps) return;
      lastStablePreviewDimsRef.current = { w, h };
      const fitWidthZoom = availW / Math.max(1, w);
      const baseDPI = fitWidthZoom > 1.5 ? Math.ceil(fitWidthZoom * 1.25) : BASE_DPI_SCALE;
      dpiScaleRef.current = Math.max(BASE_DPI_SCALE, baseDPI);
      previewDimsRef.current = { width: w, height: h };
      setPreviewDims({ width: w, height: h });
    }, [artboardWidth, artboardHeight]);

    const minZoomRef = useRef(1);
    const showFullSheetDimensions =
      zoom <= minZoomRef.current + 0.01 &&
      Math.abs(panX) < 1 &&
      Math.abs(panY) < 1;

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

    useEffect(() => {
      const area = canvasAreaRef.current;
      if (!area) return;
      const frame = requestAnimationFrame(() => {
        if (!canvasAreaRef.current) return;
        if (wandDeleteActiveRef.current) {
          canvasAreaRef.current.style.cursor = "crosshair";
        } else if (!selectionZoomActiveRef.current) {
          setPreviewCursor(getIdleCursor());
        }
      });
      return () => cancelAnimationFrame(frame);
    }, [wandDeleteActive, selectionZoomActive, zoom, moveMode, getIdleCursor]);


    const getOverscrollPx = useCallback((axis: 'x' | 'y') => {
      const el = canvasAreaRef.current;
      const dims = previewDimsRef.current;
      const v = axis === 'x'
        ? (el ? el.clientWidth : dims.width)
        : (el ? el.clientHeight : dims.height);
      return Math.min(120, Math.max(48, v * 0.3));
    }, []);

    /**
     * The range `panX`/`panY` may occupy, in pre-scale CSS pixels.
     *
     * Centred axes are symmetric: pan 0 puts the middle of the sheet in the
     * middle of the viewport, so the sheet can travel equally far either way.
     * The top-anchored vertical axis is not: pan 0 already has the sheet's top
     * edge against the top of the viewport, so the whole usable range runs
     * negative, far enough to bring the bottom edge into view. That asymmetry
     * is why this returns a pair rather than a single maximum.
     */
    const getPanBounds = useCallback((axis: 'x' | 'y', z: number) => {
      const dims = previewDimsRef.current;
      const el = canvasAreaRef.current;
      if (axis === 'x') {
        const vw = el ? el.clientWidth : dims.width;
        const overflow = dims.width / 2 - vw / (2 * z);
        const max = overflow > 0 ? overflow + getOverscrollPx('x') / z : 0;
        return { min: -max, max };
      }
      const vh = el ? el.clientHeight : dims.height;
      if (!topAlignRef.current) {
        const overflow = dims.height / 2 - vh / (2 * z);
        const max = overflow > 0 ? overflow + getOverscrollPx('y') / z : 0;
        return { min: -max, max };
      }
      // Only the band below the top ruler is usable, so that — not the whole
      // area — is what has to be filled before there is anything to scroll to.
      const usable = vh - MOBILE_CANVAS_PAD_TOP - MOBILE_CANVAS_PAD_BOTTOM;
      const hidden = dims.height - usable / z;
      if (hidden <= 0) return { min: 0, max: 0 };
      // Hard stop at the top rather than the usual overscroll slack. Nothing
      // springs a rubber-banded pan back here, so any slack above the sheet is
      // slack the user can leave behind — which is the empty band this view
      // exists to get rid of. Scrolling down still gets the usual give.
      return { min: -hidden - getOverscrollPx('y') / z, max: 0 };
    }, [getOverscrollPx]);

    const clampPanValue = useCallback((px: number, py: number, z: number) => {
      const bx = getPanBounds('x', z);
      const by = getPanBounds('y', z);
      return {
        x: Math.max(bx.min, Math.min(bx.max, px)),
        y: Math.max(by.min, Math.min(by.max, py)),
      };
    }, [getPanBounds]);

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
      const { min, max } = getPanBounds(axis, z);
      const { maxScroll } = getScrollMetrics(axis, z);
      const span = max - min;
      if (span <= 0 || maxScroll <= 0) return 0;
      const t = Math.max(0, Math.min(1, (max - panVal) / span));
      return t * maxScroll;
    }, [getPanBounds, getScrollMetrics]);

    const scrollToPan = useCallback((axis: 'x' | 'y', scrollVal: number, z: number) => {
      const { min, max } = getPanBounds(axis, z);
      const { maxScroll } = getScrollMetrics(axis, z);
      const span = max - min;
      if (span <= 0 || maxScroll <= 0) return 0;
      const t = Math.max(0, Math.min(1, scrollVal / maxScroll));
      return max - t * span;
    }, [getPanBounds, getScrollMetrics]);

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
    /**
     * How long the render function itself takes, as distinct from the frame
     * cadence around it. Cadence answers "are we keeping up"; this answers "is
     * the canvas work the reason we are not", which is the only one of the two
     * that says whether moving the dragged design to its own layer would help.
     */
    const renderPerfSamplesRef = useRef<number[]>([]);
    /**
     * Static-composite rebuilds within the current gesture. A drag should cost
     * exactly two: one when the selected design leaves the composite, one when
     * it rejoins. Anything above that is a signature being invalidated
     * mid-gesture, which is a different bug from a slow frame.
     */
    const compositeRebuildsRef = useRef(0);
    const dragPerfGestureRef = useRef<string | null>(null);
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

    // Zoom commits are rAF-throttled just like pan: wheel and pinch events can
    // fire far faster than the display refresh rate, and each setZoom triggers
    // a full React re-render of this (large) component. zoomRef is updated
    // synchronously so all handlers see the latest value immediately.
    const zoomCommitRafRef = useRef<number | null>(null);
    const queueZoomCommit = useCallback((z: number) => {
      zoomRef.current = z;
      pendingZoomCommitRef.current = z;
      if (zoomCommitRafRef.current != null) return;
      zoomCommitRafRef.current = requestAnimationFrame(() => {
        zoomCommitRafRef.current = null;
        const next = pendingZoomCommitRef.current;
        if (next == null) return;
        pendingZoomCommitRef.current = null;
        setZoom(next);
      });
    }, []);
    // Immediate zoom commit for one-shot actions (fit, reset, focus, toolbar
    // +/-): cancels any queued wheel/pinch commit so a stale rAF value can't
    // overwrite the requested zoom, syncs zoomRef, and sets state directly.
    const commitZoomNow = useCallback((z: number) => {
      if (zoomCommitRafRef.current != null) {
        cancelAnimationFrame(zoomCommitRafRef.current);
        zoomCommitRafRef.current = null;
      }
      pendingZoomCommitRef.current = null;
      zoomRef.current = z;
      setZoom(z);
    }, []);
    useEffect(() => () => {
      if (zoomCommitRafRef.current != null) cancelAnimationFrame(zoomCommitRafRef.current);
      pendingZoomCommitRef.current = null;
    }, []);

    const AUTOPAN_EDGE = 60;
    const AUTOPAN_MAX_SPEED = 8;
    /**
     * How stale the canvas-area rect may get while auto-pan is running.
     *
     * Auto-pan starts on the first move of any drag and ticks until the pointer is released,
     * so reading the rect each frame billed the whole gesture a forced layout — even for the
     * overwhelming majority of drags that never come near an edge. The rect only moves when
     * the window resizes or the page scrolls, neither of which happens mid-drag, so a short
     * lease is indistinguishable from reading it fresh.
     */
    const AUTOPAN_RECT_MAX_AGE_MS = 200;

    const stopAutoPan = useCallback(() => {
      autoPanActiveRef.current = false;
      autoPanRectRef.current = null;
      if (autoPanRafRef.current != null) {
        cancelAnimationFrame(autoPanRafRef.current);
        autoPanRafRef.current = null;
      }
    }, []);

    const tickAutoPan = useCallback(() => {
      if (!autoPanActiveRef.current) return;
      const el = canvasAreaRef.current;
      if (!el) { stopAutoPan(); return; }

      const now = performance.now();
      let rect = autoPanRectRef.current;
      if (rect === null || now - autoPanRectAtRef.current > AUTOPAN_RECT_MAX_AGE_MS) {
        rect = el.getBoundingClientRect();
        autoPanRectRef.current = rect;
        autoPanRectAtRef.current = now;
      }
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
        autoPanRectRef.current = null;
        autoPanRafRef.current = requestAnimationFrame(tickAutoPan);
      }
    }, [tickAutoPan]);
    // A drag interrupted by unmount — a route change, or the mobile sheet closing mid-gesture
    // — would otherwise leave this loop ticking against a detached element.
    useEffect(() => () => stopAutoPan(), [stopAutoPan]);

    const updateAutoPanMouse = useCallback((clientX: number, clientY: number) => {
      autoPanMouseRef.current = { x: clientX, y: clientY };
    }, []);

    useEffect(() => {
      if (!showDragPerfDebug) return;
      /**
       * Which gesture is being measured. Panning and design dragging stress
       * completely different paths — panning is a CSS transform and touches no
       * canvas at all, dragging re-renders — so reporting them under one label
       * would average two unrelated things together.
       */
      const activeGesture = (): string | null => {
        if (isPanningRef.current) return 'pan';
        if (scrollDragRef.current) return 'scrollbar';
        if (isMultiDragRef.current) return 'group drag';
        if (isMultiResizeRef.current) return 'group resize';
        if (isMultiRotateRef.current) return 'group rotate';
        if (isDraggingRef.current) return 'drag';
        if (isResizingRef.current) return 'resize';
        if (isRotatingRef.current) return 'rotate';
        return null;
      };
      // Median rather than mean: a stalled frame or a one-off composite rebuild
      // drags a mean far away from what the gesture actually feels like, and
      // the p95 already covers the tail.
      const stats = (samples: number[]) => {
        const sorted = [...samples].sort((a, b) => a - b);
        return {
          med: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
        };
      };
      const loop = (ts: number) => {
        const gesture = activeGesture();
        // Counters are per-gesture, so a boundary clears them. Without this the
        // idle 60fps frames before a drag sit in the window and flatter the
        // average for the first two seconds of it.
        if (gesture !== dragPerfGestureRef.current) {
          dragPerfGestureRef.current = gesture;
          dragPerfSamplesRef.current.length = 0;
          renderPerfSamplesRef.current.length = 0;
          compositeRebuildsRef.current = 0;
          if (!gesture) setDragPerfText('');
        }

        const prev = dragPerfLastTsRef.current;
        if (gesture && prev != null) {
          const dt = ts - prev;
          if (dt > 0 && dt < 1000) {
            const samples = dragPerfSamplesRef.current;
            samples.push(dt);
            if (samples.length > 120) samples.shift();
          }
        }
        dragPerfLastTsRef.current = ts;

        if (gesture && ts - dragPerfLastCommitRef.current > 250) {
          const frames = dragPerfSamplesRef.current;
          if (frames.length > 0) {
            const f = stats(frames);
            const renders = renderPerfSamplesRef.current;
            const r = renders.length > 0 ? stats(renders) : null;
            setDragPerfText(
              `${gesture} ${Math.round(f.med > 0 ? 1000 / f.med : 0)}fps` +
              ` | frame med ${f.med.toFixed(1)} p95 ${f.p95.toFixed(1)}ms` +
              (r ? ` | render med ${r.med.toFixed(1)} p95 ${r.p95.toFixed(1)}ms x${renders.length}` : ' | render —') +
              ` | rebuilds ${compositeRebuildsRef.current}`,
            );
            dragPerfLastCommitRef.current = ts;
          }
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
    }, [showDragPerfDebug]);
    const renderRef = useRef<(() => void) | null>(null);
    
    const checkerboardPatternRef = useRef<{width: number; height: number; pattern: CanvasPattern} | null>(null);
    const lastCanvasDimsRef = useRef<{width: number; height: number}>({width: 0, height: 0});
    // Cached composite of all non-selected designs (+ background). Rebuilt
    // only when its signature changes (designs list, transforms, canvas dims,
    // overlap set, or previewBgColor). During drag we blit this cache in a
    // single drawImage call instead of iterating N designs per frame —
    // ~5–10× faster on multi-design gangsheets on mid-range mobile devices.
    const staticCompositeRef = useRef<{ canvas: HTMLCanvasElement; signature: string } | null>(null);

    // Dev-only A/B for viewport culling. `?cullprobe=1` makes every composite
    // rebuild happen twice — once drawing every design as we ship today, once
    // drawing only the designs whose bounds intersect the visible part of the
    // sheet — and records both timings on `window.__cullProbe`. The second
    // pass goes to a scratch canvas so the visible result is unchanged.
    // Doubles rebuild cost while enabled; never runs in production.
    const cullProbeEnabled = useRef(
      import.meta.env.DEV && typeof window !== 'undefined'
        && new URLSearchParams(window.location.search).get('cullprobe') === '1',
    ).current;
    const cullProbeCanvasRef = useRef<HTMLCanvasElement | null>(null);
    
    const [editingRotation, setEditingRotation] = useState(false);
    const [rotationInput, setRotationInput] = useState('0');
    const [overlappingDesigns, setOverlappingDesigns] = useState<Set<string>>(new Set());
    // Bumped when a group gesture ends, purely to force one final render pass
    // so the static composite is rebuilt without the mid-gesture exclusions.
    const [interactionEpoch, setInteractionEpoch] = useState(0);
    const [previewBgColor, setPreviewBgColor] = useState('transparent');
    // Phone only: the compact backdrop button's menu, and where to put it. See
    // `backdropSwatchCompact`.
    const [backdropMenuOpen, setBackdropMenuOpen] = useState(false);
    const [backdropMenuAt, setBackdropMenuAt] = useState<{ top: number; right: number } | null>(null);
    const backdropButtonRef = useRef<HTMLButtonElement>(null);
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
    const handleInteractionMoveRef = useRef<((cx: number, cy: number, alt?: boolean) => void) | null>(null);
    const handleInteractionEndRef = useRef<(() => void) | null>(null);

    const autoPanRafRef = useRef<number | null>(null);
    const autoPanMouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
    const autoPanActiveRef = useRef(false);
    const autoPanRectRef = useRef<DOMRect | null>(null);
    const autoPanRectAtRef = useRef(0);

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

    const canvasRectCacheRef = useRef<DOMRect | null>(null);
    const moveRafRef = useRef<number | null>(null);
    const pendingMoveRef = useRef<{ cx: number; cy: number; alt?: boolean } | null>(null);

    /** True while any gesture is under way, in which case the sheet is already repainting. */
    const isInteractionActive = useCallback(() => (
      isDraggingRef.current || isResizingRef.current || isRotatingRef.current ||
      isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current ||
      isPanningRef.current || scrollDragRef.current !== null
    ), []);

    /**
     * The single frame loop for continuous animations over the sheet.
     *
     * Two things animate independently — the spot-colour pulse and the bottom-edge expand
     * glow — and each used to own a `requestAnimationFrame` that called `renderRef` itself.
     * Alive together they drew the whole sheet twice per frame, on top of whatever the React
     * render effect was already drawing for the gesture underneath. Animators register here
     * instead: they are ticked together and the sheet is repainted at most once per frame.
     *
     * A tick returns whether it needs the sheet repainted, which lets an animation update its
     * value without forcing a draw — the way the spot pulse behaves mid-gesture, when the
     * render effect is going to repaint anyway and would pick the new value up regardless.
     */
    const animatorsRef = useRef<Map<string, (now: number) => boolean>>(new Map());
    const animatorRafRef = useRef<number | null>(null);

    const runAnimatorFrame = useCallback((now: number) => {
      animatorRafRef.current = null;
      const animators = animatorsRef.current;
      if (animators.size === 0) return;
      let needsRepaint = false;
      for (const tick of animators.values()) {
        if (tick(now)) needsRepaint = true;
      }
      if (needsRepaint) renderRef.current?.();
      if (animators.size > 0) {
        animatorRafRef.current = requestAnimationFrame(runAnimatorFrame);
      }
    }, []);

    const startAnimator = useCallback((key: string, tick: (now: number) => boolean) => {
      animatorsRef.current.set(key, tick);
      if (animatorRafRef.current === null) {
        animatorRafRef.current = requestAnimationFrame(runAnimatorFrame);
      }
    }, [runAnimatorFrame]);

    const stopAnimator = useCallback((key: string) => {
      animatorsRef.current.delete(key);
      if (animatorsRef.current.size === 0 && animatorRafRef.current !== null) {
        cancelAnimationFrame(animatorRafRef.current);
        animatorRafRef.current = null;
      }
    }, []);

    useEffect(() => () => {
      animatorsRef.current.clear();
      if (animatorRafRef.current !== null) {
        cancelAnimationFrame(animatorRafRef.current);
        animatorRafRef.current = null;
      }
    }, []);

    const bottomGlowRef = useRef(0);
    const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const expandTimerStartRef = useRef<number>(0);
    const onExpandArtboardRef = useRef(onExpandArtboard);
    onExpandArtboardRef.current = onExpandArtboard;
    const bottomGlowActiveRef = useRef(false);

    const startBottomGlow = useCallback(() => {
      if (bottomGlowActiveRef.current) return;
      bottomGlowActiveRef.current = true;
      expandTimerStartRef.current = Date.now();
      startAnimator('bottomGlow', () => {
        if (!bottomGlowActiveRef.current) return false;
        const elapsed = Date.now() - expandTimerStartRef.current;
        bottomGlowRef.current = Math.min(1, elapsed / 1900);
        return true;
      });
      expandTimerRef.current = setTimeout(() => {
        onExpandArtboardRef.current?.();
        stopBottomGlow();
      }, 1900);
    }, [startAnimator]);

    const stopBottomGlow = useCallback(() => {
      // The drag path calls this on every pointer-move frame, so an
      // unconditional render here doubled the render count for a whole drag
      // even though there was nothing to clear. Only repaint when the glow
      // was actually on screen.
      const hadGlow = bottomGlowActiveRef.current || bottomGlowRef.current !== 0;
      bottomGlowActiveRef.current = false;
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
      stopAnimator('bottomGlow');
      bottomGlowRef.current = 0;
      if (hadGlow) renderRef.current?.();
    }, [stopAnimator]);
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
      const z = Math.max(ZOOM_MIN_ABSOLUTE, zoomRef.current);
      const canvasBuf = canvasRef.current;
      const dims = previewDimsRef.current;
      const actualDpi = canvasBuf && dims.width > 0
        ? canvasBuf.width / dims.width
        : dpiScaleRef.current;
      // Canvas-buffer px per screen CSS px, the only conversion between the space the
      // rings are specified in and the space `px`/`py` arrive in.
      const bufferPerCss = actualDpi / z;
      // Touch grabs an absolute number of CSS px, so a legible glyph and a thumb-sized
      // target are independent. A mouse keeps its rings proportional to the drawn glyph
      // so that a click well outside a corner still falls through to the marquee.
      const designMinCss = Math.min(rect.width, rect.height) / bufferPerCss;
      const drawnHalf = getHandleHalfCssPx(designMinCss, z, isMobile, 0.25);
      // Nothing drawn, nothing to grab. The absolute touch rings below do not
      // depend on the glyph, so without this an outline-only design would keep
      // four invisible 44 CSS px targets and swallow the drag that moves it.
      if (drawnHalf === 0) return null;
      // Radii in CSS px first, then converted: the rotate gate below compares a
      // radius against an edge and both have to be in the same space.
      const resizeRCss = isMobile ? TOUCH_RESIZE_HIT_R_CSS_PX : drawnHalf * HANDLE_HIT_BOOST;
      const rotateOuterRCss = isMobile ? TOUCH_ROTATE_OUTER_R_CSS_PX : drawnHalf * HANDLE_ROTATE_RING;
      const resizeR = resizeRCss * bufferPerCss;
      const rotateOuterR = rotateOuterRCss * bufferPerCss;

      // Nearest corner in range, not the first in tl/tr/br/bl order. An absolute touch
      // ring is wider than a small design — a 44 CSS px target on a 25 CSS px design
      // overlaps all four corners — so a first-match loop would resolve every grab to
      // the top-left and leave the other three corners unreachable.
      let best: { type: 'resize' | 'rotate'; id: string } | null = null;
      let bestD = Infinity;
      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        if (d < resizeR && d < bestD) {
          best = { type: 'resize', id: h.id };
          bestD = d;
        }
      }
      // Resize wins outright when both rings are in range.
      if (best) return best;

      // Too small on screen for rotation to be anything but a trap.
      if (!selectionCanRotate(designMinCss, rotateOuterRCss)) return null;
      // Rotation is a gesture made *around* artwork, not on it — this is where
      // every other editor puts it. Returning null hands the point back to the
      // caller, which drags the body with it.
      if (isClickInDesignInterior(px, py)) return null;

      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        if (d >= resizeR && d < rotateOuterR && d < bestD) {
          best = { type: 'rotate', id: `rot-${h.id}` };
          bestD = d;
        }
      }

      return best;
    }, [getHandlePositions, getDesignRect, isMobile, isClickInDesignInterior]);

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
      const z = Math.max(ZOOM_MIN_ABSOLUTE, zoomRef.current);
      const bbox = getMultiSelectionBBox();
      const canvasBuf = canvasRef.current;
      const dims = previewDimsRef.current;
      const actualDpi = canvasBuf && dims.width > 0
        ? canvasBuf.width / dims.width
        : dpiScaleRef.current;
      const bufferPerCss = actualDpi / z;
      const groupMin = bbox ? Math.min(bbox.width, bbox.height) : actualDpi * 20;
      // Same split as single selection: absolute CSS radii for touch, glyph-relative
      // rings for a mouse. The group draw at `drawSelectionHandles` shares the base.
      const groupMinCss = groupMin / bufferPerCss;
      const drawnHalf = getHandleHalfCssPx(groupMinCss, z, isMobile, 0.15);
      // Nothing drawn, nothing to grab — see `hitTestHandles`.
      if (drawnHalf === 0) return null;
      const resizeRCss = isMobile ? TOUCH_RESIZE_HIT_R_CSS_PX : drawnHalf * HANDLE_HIT_BOOST;
      const rotateOuterRCss = isMobile ? TOUCH_ROTATE_OUTER_R_CSS_PX : drawnHalf * HANDLE_ROTATE_RING;
      const resizeR = resizeRCss * bufferPerCss;
      const rotateOuterR = rotateOuterRCss * bufferPerCss;

      // Nearest corner in range — see `hitTestHandles`.
      let best: { type: 'resize' | 'rotate'; id: string } | null = null;
      let bestD = Infinity;
      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        if (d < resizeR && d < bestD) {
          best = { type: 'resize', id: h.id };
          bestD = d;
        }
      }
      if (best) return best;

      // Both rotate guards from `hitTestHandles`. A group needs them more, not
      // less: nothing here prefers a drag over a handle the way the single
      // selection's interior check does, so a rotate hit in the middle of a
      // group box was the end of the matter and the group could not be moved.
      if (!selectionCanRotate(groupMinCss, rotateOuterRCss)) return null;
      if (bbox) {
        // The group box is axis-aligned, so this is the same margin rule as
        // `isClickInDesignInterior` without the rotation transform.
        const margin = Math.min(10, groupMinCss * 0.25) * bufferPerCss;
        const gcx = bbox.x + bbox.width / 2;
        const gcy = bbox.y + bbox.height / 2;
        if (
          Math.abs(px - gcx) <= bbox.width / 2 - margin &&
          Math.abs(py - gcy) <= bbox.height / 2 - margin
        ) return null;
      }

      for (const h of handles) {
        const d = Math.sqrt((px - h.x) ** 2 + (py - h.y) ** 2);
        if (d >= resizeR && d < rotateOuterR && d < bestD) {
          best = { type: 'rotate', id: `rot-${h.id}` };
          bestD = d;
        }
      }

      return best;
    }, [getMultiHandlePositions, getMultiSelectionBBox, isMobile]);

    const canvasToLocal = useCallback((clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const canvasRect = canvasRectCacheRef.current || canvas.getBoundingClientRect();
      // `getBoundingClientRect` returns the BORDER box, but the canvas draws its border
      // outside the pixel surface under `content-box`, so the rect covers
      // PREVIEW_CANVAS_BORDER more than the surface on every side. Left uncorrected the
      // mapping is affine-wrong: exact only at the centre and off by the border at either
      // edge, which zoom multiplies into ~24 screen px at 8x.
      //
      // The border cannot be subtracted as a constant, because the rect is a SCREEN
      // measurement taken through the wrapper's `scale(zoom)` — the border occupies
      // `PREVIEW_CANVAS_BORDER * zoom` screen px. Taking it as a fraction of the layout
      // border-box instead is zoom-agnostic, and stays correct mid-zoom-transition when
      // `zoomRef` has not yet caught up with the rendered transform.
      //
      // This belongs here and not at the cache site: `canvasRectCacheRef` holds the raw
      // rect and the drag handlers read it for their own (delta-based) math.
      const dims = previewDimsRef.current;
      const layoutW = dims.width + 2 * PREVIEW_CANVAS_BORDER;
      const layoutH = dims.height + 2 * PREVIEW_CANVAS_BORDER;
      if (dims.width <= 0 || dims.height <= 0) return { x: 0, y: 0 };
      const surfaceW = canvasRect.width * (dims.width / layoutW);
      const surfaceH = canvasRect.height * (dims.height / layoutH);
      const borderX = canvasRect.width * (PREVIEW_CANVAS_BORDER / layoutW);
      const borderY = canvasRect.height * (PREVIEW_CANVAS_BORDER / layoutH);
      if (surfaceW <= 0 || surfaceH <= 0) return { x: 0, y: 0 };
      const x = ((clientX - canvasRect.left - borderX) / surfaceW) * canvas.width;
      const y = ((clientY - canvasRect.top - borderY) / surfaceH) * canvas.height;
      return { x, y };
    }, []);

    const getMaxScaleForArtboard = useCallback((t: ImageTransform, wInches?: number, hInches?: number): number => {
      const wi = wInches ?? resizeSettings.widthInches;
      const hi = hInches ?? resizeSettings.heightInches;
      if (!wi || !hi) return 10;
      const rad = (t.rotation * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const selDesign = designs.find(d => d.id === selectedDesignId);

      // The label rides below the artwork, so the rectangle being fitted is `wi × (hi + band)`.
      // The band is already in film inches and does not scale with `s`, so it comes off the
      // sheet before the division rather than being folded into the height. Without this a
      // design scaled to the sheet edge prints its label off the film.
      const rotW = wi * cos + hi * sin;
      const rotH = wi * sin + hi * cos;
      const solve = (band: number) => Math.max(0, Math.min(
        (artboardWidth - band * sin) / rotW,
        (artboardHeight - band * cos) / rotH,
      ));

      const first = solve(0);
      if (!selDesign?.printFileName) return first;
      // Sized at the scale the artwork alone allows. The band is a fraction of an inch against a
      // sheet measured in feet, so one correction is the end of it.
      const band = getStampExtraAtSize(selDesign, wi * first, hi * first);
      return band > 0 ? solve(band) : first;
    }, [artboardWidth, artboardHeight, resizeSettings.widthInches, resizeSettings.heightInches, designs, selectedDesignId]);

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

      const selDesign = designs.find(d => d.id === selectedDesignId);
      // Whatever the label actually needs at this scale, which is nothing at all when it sits
      // inside the artwork's own corner. Reading it from the design rather than recomputing the
      // formula here is what keeps the draggable area and the drawn label in agreement.
      const stampExtra = selDesign
        ? getStampExtraAtSize(selDesign, wi * clamped.s, hi * clamped.s)
        : 0;
      const stampExtraPx = (stampExtra / artboardHeight) * canvas.height;

      const rect = computeLayerRect(iw, ih, clamped, canvas.width, canvas.height, artboardWidth, artboardHeight, wi, hi);
      const rad = (clamped.rotation * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);
      const hw = rect.width / 2;
      const hh = rect.height / 2;
      const corners = [
        { x: -hw, y: -hh },
        { x:  hw, y: -hh },
        { x:  hw, y:  hh + stampExtraPx },
        { x: -hw, y:  hh + stampExtraPx },
      ];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        const rx = c.x * cosA - c.y * sinA;
        const ry = c.x * sinA + c.y * cosA;
        if (rx < minX) minX = rx;
        if (rx > maxX) maxX = rx;
        if (ry < minY) minY = ry;
        if (ry > maxY) maxY = ry;
      }

      const cx = clamped.nx * canvas.width;
      const cy = clamped.ny * canvas.height;

      let newCx = cx;
      let newCy = cy;

      const totalW = maxX - minX;
      const totalH = maxY - minY;
      if (totalW <= canvas.width) {
        if (cx + minX < 0) newCx = -minX;
        if (cx + maxX > canvas.width) newCx = canvas.width - maxX;
      } else {
        newCx = Math.max(canvas.width - maxX, Math.min(-minX, cx));
      }
      if (totalH <= canvas.height) {
        if (cy + minY < 0) newCy = -minY;
        if (cy + maxY > canvas.height) newCy = canvas.height - maxY;
      } else {
        newCy = Math.max(canvas.height - maxY, Math.min(-minY, cy));
      }

      return { ...clamped, nx: newCx / canvas.width, ny: newCy / canvas.height };
    }, [imageInfo, artboardWidth, artboardHeight, resizeSettings.widthInches, resizeSettings.heightInches, getMaxScaleForArtboard, designs, selectedDesignId]);

    const overlappingDesignsRef = useRef(overlappingDesigns);
    overlappingDesignsRef.current = overlappingDesigns;

    const overlapWorkerRef = useRef<Worker | null>(null);
    const overlapRequestIdRef = useRef(0);
    const overlapHandlerRef = useRef<((ev: MessageEvent) => void) | null>(null);
    const overlapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
        if (overlapTimerRef.current) clearTimeout(overlapTimerRef.current);
        overlapTimerRef.current = null;
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

      const designRects: Array<{id: string; left: number; top: number; right: number; bottom: number; design: DesignItem; rect: {x: number; y: number; width: number; height: number}; label: PrintLabelLayout | null}> = [];
      for (const d of designs) {
        const rect = computeLayerRect(
          d.imageInfo.image.width, d.imageInfo.image.height,
          d.transform, sw, sh,
          artboardWidth, artboardHeight,
          d.widthInches, d.heightInches,
        );
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const rad = d.transform.rotation * Math.PI / 180;
        const cosA = Math.cos(rad);
        const sinA = Math.sin(rad);
        const hw = rect.width / 2, hh = rect.height / 2;
        // Inset to the artwork before rotating. A nested design's transparent margin is
        // allowed to sit over a neighbour or past the sheet edge, so flagging the image box
        // would mark correctly nested layouts as out of bounds and overlapping.
        const artW = d.widthInches * d.transform.s;
        const artH = d.heightInches * d.transform.s;
        const built = getDesignNestMask({
          image: d.imageInfo.image,
          artW,
          artH,
          labelName: d.printFileName ? d.name : undefined,
          flipX: d.transform.flipX,
          flipY: d.transform.flipY,
          sourceKey: d.imageInfo.image.src,
        });
        // The mask already covers the label wherever it ended up, so the band comes from the
        // same decision that drew it rather than a formula that assumes it went below.
        const stampInches = built?.label?.bandInches ?? 0;
        const stampPx = (stampInches / artboardHeight) * sh;
        const inset = inkInset(built?.mask, artW, artH + stampInches, 0);
        const pxPerInchX = artW > 0 ? rect.width / artW : 0;
        const pxPerInchY = artH > 0 ? rect.height / artH : 0;
        const left = -hw + inset.left * pxPerInchX;
        const right = hw - inset.right * pxPerInchX;
        const top = -hh + inset.top * pxPerInchY;
        const bottom = hh + stampPx - inset.bottom * pxPerInchY;
        const corners = [
          { x: left, y: top },
          { x: right, y: top },
          { x: right, y: bottom },
          { x: left, y: bottom },
        ];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const c of corners) {
          const rx = c.x * cosA - c.y * sinA;
          const ry = c.x * sinA + c.y * cosA;
          if (rx < minX) minX = rx;
          if (rx > maxX) maxX = rx;
          if (ry < minY) minY = ry;
          if (ry > maxY) maxY = ry;
        }
        designRects.push({
          id: d.id, left: cx + minX, top: cy + minY, right: cx + maxX, bottom: cy + maxY,
          design: d, rect, label: built?.label ?? null,
        });
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
        /**
         * One decode per distinct (source, footprint) pair, at the size the worker
         * actually draws.
         *
         * This used to be one full-resolution `createImageBitmap` per overlapping
         * design. Both halves of that were waste. The worker rasterises into
         * `drawW x drawH` on a canvas already scaled to a quarter — a couple of
         * hundred pixels a side — so decoding a 1200x750 upload gave it eighty
         * times the pixels it was about to throw away. And a sheet of copies is
         * the same handful of images over and over: duplicating a design to 165
         * copies measured 133 decodes of 4 distinct images, 64 megapixels, and a
         * 1365ms frame in which the editor did not respond at all.
         *
         * Decoding to the footprint costs the resample either way — `drawImage`
         * was doing it in the worker — so this moves the work rather than adding
         * it, and hands the worker a bitmap it can blit.
         */
        const slotByKey = new Map<string, number>();
        const decodes: Array<{ image: HTMLImageElement; w: number; h: number }> = [];
        const slotByDesign = new Map<number, number>();
        for (const idx of neededArr) {
          const dr = designRects[idx];
          const img = dr.design.imageInfo.image;
          const naturalW = img.naturalWidth || img.width || 1;
          const naturalH = img.naturalHeight || img.height || 1;
          // Never upscale: past the natural size the extra pixels are invented,
          // and the decoder charges for them.
          const w = Math.max(1, Math.min(Math.ceil(dr.rect.width), naturalW));
          const h = Math.max(1, Math.min(Math.ceil(dr.rect.height), naturalH));
          const key = `${img.src}|${w}x${h}`;
          let slot = slotByKey.get(key);
          if (slot === undefined) {
            slot = decodes.length;
            slotByKey.set(key, slot);
            decodes.push({ image: img, w, h });
          }
          slotByDesign.set(idx, slot);
        }
        overlapRequestIdRef.current += 1;
        const myRequestId = overlapRequestIdRef.current;
        Promise.all(decodes.map(({ image, w, h }) => createImageBitmap(image, {
          resizeWidth: w,
          resizeHeight: h,
          // Matches the quality `drawImage` gave these before, and the test
          // downstream is "is any alpha above 20", not a visual comparison.
          resizeQuality: 'low',
        }))).then(bitmaps => {
          const workerDesigns = designRects.map((dr, idx) => {
            // Same rect the label is drawn from, converted into the pixels this pass works in.
            // The artwork's own drawn height is the honest scale factor here: `rect.height` is
            // the artwork, and the label's coordinates are relative to the artwork's centre.
            const artH = dr.design.heightInches * dr.design.transform.s;
            const pxPerInch = artH > 0 ? dr.rect.height / artH : 0;
            const box = dr.label && pxPerInch > 0 ? {
              x: dr.label.rect.x * pxPerInch,
              y: dr.label.rect.y * pxPerInch,
              w: dr.label.rect.width * pxPerInch,
              h: dr.label.rect.height * pxPerInch,
            } : undefined;
            return {
              id: dr.id,
              left: dr.left, top: dr.top, right: dr.right, bottom: dr.bottom,
              // An index into the shared `bitmaps` array rather than a bitmap of
              // its own: copies share one, and a transferred bitmap can only be
              // sent once anyway.
              bitmapIndex: slotByDesign.get(idx) ?? -1,
              drawX: dr.rect.x, drawY: dr.rect.y,
              drawW: dr.rect.width, drawH: dr.rect.height,
              rotation: dr.design.transform.rotation,
              cx: dr.rect.x + dr.rect.width / 2,
              cy: dr.rect.y + dr.rect.height / 2,
              labelBox: box,
            };
          });

          const finish = () => {
            worker.removeEventListener('message', handler);
            worker.removeEventListener('error', onWorkerFailure);
            worker.removeEventListener('messageerror', onWorkerFailure);
            clearTimeout(timer);
            if (overlapTimerRef.current === timer) overlapTimerRef.current = null;
            if (overlapHandlerRef.current === handler) overlapHandlerRef.current = null;
          };
          const handler = (ev: MessageEvent) => {
            if (ev.data.type === 'result') {
              finish();
              if (myRequestId !== overlapRequestIdRef.current) return;
              const workerOverlapping = new Set<string>(ev.data.overlapping as string[]);
              for (const id of outOfBounds) workerOverlapping.add(id);
              const prev = overlappingDesignsRef.current;
              if (workerOverlapping.size !== prev.size || Array.from(workerOverlapping).some(id => !prev.has(id))) {
                setOverlappingDesigns(workerOverlapping);
              }
            } else if (ev.data.type === 'error') {
              // An in-band error is a caught exception inside a worker that is still
              // alive, so it costs one fallback pass and nothing more.
              finish();
              const err = (ev.data as { error?: string }).error;
              console.warn('Overlap worker error:', err);
              runMainThreadOverlap();
            }
          };
          /**
           * Stop using the worker for the rest of the session and answer on the main
           * thread instead. A worker that crashed or went silent will not get better, and
           * keeping it would cost every later check the full timeout before falling back;
           * nulling the ref sends them straight down the main-thread path, the same way
           * the halftone bridge disables its worker after a crash.
           */
          const abandonWorker = (reason: string) => {
            finish();
            console.warn(`Overlap worker abandoned (${reason}) — using main thread.`);
            worker.terminate();
            if (overlapWorkerRef.current === worker) overlapWorkerRef.current = null;
            if (myRequestId === overlapRequestIdRef.current) runMainThreadOverlap();
          };
          // `messageerror` fires when a reply cannot be deserialised. It never reaches
          // `handler`, so without it the check would wait out the whole timeout.
          const onWorkerFailure = (ev: Event) => abandonWorker(
            ev.type === 'messageerror' ? 'unreadable reply' : ((ev as ErrorEvent).message || 'error event'),
          );
          const timer = setTimeout(() => {
            if (myRequestId !== overlapRequestIdRef.current) { finish(); return; }
            abandonWorker(`no reply in ${OVERLAP_TIMEOUT_MS}ms`);
          }, OVERLAP_TIMEOUT_MS);
          overlapTimerRef.current = timer;
          overlapHandlerRef.current = handler;
          worker.addEventListener('message', handler);
          worker.addEventListener('error', onWorkerFailure);
          worker.addEventListener('messageerror', onWorkerFailure);
          try {
            worker.postMessage({ type: 'check', designs: workerDesigns, bitmaps, sw, sh }, bitmaps as Transferable[]);
          } catch (err) {
            finish();
            // The transfer did not happen, so these are still ours to release.
            for (const b of bitmaps) { try { b.close(); } catch { /* already gone */ } }
            console.warn('Overlap worker post failed:', err);
            runMainThreadOverlap();
          }
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
        const mtScale = 0.5;
        const mtw = Math.max(30, Math.round(sw * mtScale));
        const mth = Math.max(15, Math.round(sh * mtScale));
        const alphaBuffers = new Map<number, Uint8ClampedArray>();
        const offscreen = document.createElement('canvas');
        offscreen.width = mtw;
        offscreen.height = mth;
        const octx = offscreen.getContext('2d', { willReadFrequently: true });
        if (!octx) return;
        for (const idx of needed) {
          const d = designRects[idx].design;
          octx.clearRect(0, 0, mtw, mth);
          const rect = computeLayerRect(
            d.imageInfo.image.width, d.imageInfo.image.height,
            d.transform, mtw, mth,
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
            const label = designRects[idx].label;
            const artH = d.heightInches * d.transform.s;
            if (label && artH > 0) {
              const pxPerInch = rect.height / artH;
              octx.fillStyle = 'rgba(0,0,0,1)';
              octx.fillRect(
                label.rect.x * pxPerInch, label.rect.y * pxPerInch,
                label.rect.width * pxPerInch, label.rect.height * pxPerInch,
              );
            }
            octx.restore();
            alphaBuffers.set(idx, new Uint8ClampedArray(octx.getImageData(0, 0, mtw, mth).data));
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
          setPreviewCursor('move');
          return;
        }

        const multiHit = hitTestMultiHandles(local.x, local.y);
        if (multiHit && altKey && hitIdMulti && selectedDesignIds.has(hitIdMulti)) {
          altKeyAtDragStartRef.current = true;
          isMultiDragRef.current = true;
          multiDragStartRef.current = { x: clientX, y: clientY };
          altDragDuplicatedRef.current = false;
          setPreviewCursor('move');
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

        // Touch used to skip this and let a resize ring win anywhere it reached, which was
        // survivable while the ring was 1.4x a small glyph. An absolute 22 CSS px ring
        // covers a 4in design outright on a phone, so without the interior preference a
        // design under ~5in could no longer be dragged at all. The margin inside
        // `isClickInDesignInterior` scales with the design, so a tiny design still has
        // effectively no interior and stays resizable everywhere.
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
        if (!canvasRectCacheRef.current) canvasRectCacheRef.current = canvas.getBoundingClientRect();
        const canvasRect = canvasRectCacheRef.current;
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
        if (!canvasRectCacheRef.current) canvasRectCacheRef.current = canvas.getBoundingClientRect();
        const canvasRect = canvasRectCacheRef.current;
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
        renderRef.current?.();

        if (canvas && onExpandArtboard) {
          const selDesign = designs.find(d => d.id === selectedDesignId);
          if (selDesign) {
            const wi = selDesign.widthInches * newTransform.s;
            const hi = selDesign.heightInches * newTransform.s;
            const stampEx = getStampExtraAtSize(selDesign, wi, hi);
            const rad = (newTransform.rotation * Math.PI) / 180;
            const cosA = Math.cos(rad);
            const sinA = Math.sin(rad);
            const hw2 = wi / 2, hh2 = hi / 2;
            const stampCorners = [
              { x: -hw2, y: -hh2 }, { x: hw2, y: -hh2 },
              { x: hw2, y: hh2 + stampEx }, { x: -hw2, y: hh2 + stampEx },
            ];
            let maxRy = -Infinity;
            for (const c of stampCorners) {
              const ry = c.x * sinA + c.y * cosA;
              if (ry > maxRy) maxRy = ry;
            }
            const bottomEdge = newTransform.ny + maxRy / artboardHeight;

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
        renderRef.current?.();
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
        renderRef.current?.();
      }
    }, [onTransformChange, canvasToLocal, clampTransformToArtboard, getMaxScaleForArtboard, toast, onMultiDragDelta, onMultiResizeDelta, onMultiRotateDelta, onDuplicateSelected, startBottomGlow, stopBottomGlow, startAutoPan, designs, selectedDesignId, artboardHeight]);
    handleInteractionMoveRef.current = handleInteractionMove;

    useEffect(() => {
      if (scrollDragRef.current || isPanningRef.current) return;
      if (isDraggingRef.current || isResizingRef.current || isRotatingRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current) return;
      if (overlapCheckTimerRef.current) clearTimeout(overlapCheckTimerRef.current);
      overlapCheckTimerRef.current = setTimeout(() => {
        if (scrollDragRef.current || isPanningRef.current) return;
        if (isDraggingRef.current || isResizingRef.current || isRotatingRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current) return;
        checkPixelOverlap();
      }, 150);
      return () => { if (overlapCheckTimerRef.current) clearTimeout(overlapCheckTimerRef.current); };
    }, [checkPixelOverlap]);

    const handleInteractionEnd = useCallback(() => {
      stopAutoPan();
      if (moveRafRef.current != null) { cancelAnimationFrame(moveRafRef.current); moveRafRef.current = null; }
      const pm = pendingMoveRef.current;
      pendingMoveRef.current = null;
      if (pm) handleInteractionMoveRef.current?.(pm.cx, pm.cy, pm.alt);
      canvasRectCacheRef.current = null;

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
        // Group gestures exclude the selected companions from the static
        // composite and draw them per-frame instead, so releasing the pointer
        // MUST re-run the render effect to bake them back in at full quality.
        // Nothing else here guarantees that: `checkPixelOverlap` only commits
        // state when the overlap set actually changes, and a group gesture
        // does not go through `onTransformChange`. Without this the last
        // mid-gesture frame stayed on screen — which for a group drag left
        // the companions at ghost alpha after the pointer came up.
        if (wasGroupInteracting) setInteractionEpoch(e => e + 1);
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
      if (wasInteracting) onTransformChangeRef.current?.(transformRef.current);
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
      // Canvas mousedown prevents the browser's normal focus transition, so
      // explicitly blur active form controls before selection changes.
      const activeEl = document.activeElement;
      if (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement) {
        activeEl.blur();
      }
      // Ensure keyboard scope is active on mousedown (fixes first-upload case where mouseenter never fired)
      isKeyboardScopeActiveRef.current = true;
      altKeyRef.current = e.altKey;
      if (selectionZoomActiveRef.current) return;
      if ((e.target as HTMLElement).closest('[data-scrollbar]')) return;
      if (e.button === 0 && activeSpotChannelRef.current && onWandTapRef.current && !panModeActiveRef.current) {
        const local = canvasToLocal(e.clientX, e.clientY);
        const hitId = findDesignAtPoint(local.x, local.y);
        const design = hitId ? designs.find(d => d.id === hitId) : undefined;
        const canvas = canvasRef.current;
        if (hitId && design && canvas) {
          const rect = computeLayerRect(design.imageInfo.image.width, design.imageInfo.image.height, design.transform, canvas.width, canvas.height, artboardWidth, artboardHeight, design.widthInches, design.heightInches);
          const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
          const rad = -(design.transform.rotation * Math.PI) / 180;
          const dx = local.x - cx, dy = local.y - cy;
          const nx = 0.5 + (dx * Math.cos(rad) - dy * Math.sin(rad)) / rect.width;
          const ny = 0.5 + (dx * Math.sin(rad) + dy * Math.cos(rad)) / rect.height;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) onWandTapRef.current(nx, ny, hitId);
        }
        return;
      }
      if (e.button === 0 && wandDeleteActive && onWandDeleteTap) {
        const local = canvasToLocal(e.clientX, e.clientY);
        const hitId = findDesignAtPoint(local.x, local.y);
        const design = hitId ? designs.find(d => d.id === hitId) : undefined;
        const canvas = canvasRef.current;
        if (hitId && design && canvas) {
          const rect = computeLayerRect(
            design.imageInfo.image.width,
            design.imageInfo.image.height,
            design.transform,
            canvas.width,
            canvas.height,
            artboardWidth,
            artboardHeight,
            design.widthInches,
            design.heightInches,
          );
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const rad = -(design.transform.rotation * Math.PI) / 180;
          const dx = local.x - cx;
          const dy = local.y - cy;
          const nx = 0.5 + (dx * Math.cos(rad) - dy * Math.sin(rad)) / rect.width;
          const ny = 0.5 + (dx * Math.sin(rad) + dy * Math.cos(rad)) / rect.height;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
            onWandDeleteTap(nx, ny, hitId);
          }
        }
        return;
      }
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
    }, [handleInteractionStart, panX, panY, isHorizOverflow, wandDeleteActive, onWandDeleteTap, canvasToLocal, findDesignAtPoint, designs, artboardWidth, artboardHeight]);

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
      if (wandDeleteActiveRef.current || selectionZoomActiveRef.current) return;
      if (isPanningRef.current) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        const rawPx = panStartRef.current.px + dx / zoom;
        const rawPy = panStartRef.current.py + dy / zoom;
        const clamped = clampPanValue(rawPx, rawPy, zoom);
        queuePanStateCommit(clamped.x, clamped.y);
        return;
      }
      // Active interactions are serviced exclusively by the window-level
      // `mousemove` listener, which coalesces through requestAnimationFrame.
      // Handling them here too ran `handleInteractionMove` (and therefore a
      // full canvas render) a second time for every mouse event while the
      // pointer was over the canvas — measured as 2 renders per pointer move
      // during a resize and 4 during a drag. Bail out so the rAF-coalesced
      // path is the only one.
      if (isMarqueeRef.current || isMultiDragRef.current || isMultiResizeRef.current || isMultiRotateRef.current || isDraggingRef.current || isResizingRef.current || isRotatingRef.current) {
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
        setPreviewCursor(spaceDownRef.current ? 'grab' : getIdleCursor());
        return;
      }
      handleInteractionEnd();
    }, [handleInteractionEnd, isHorizOverflow]);

    const handleMouseEnter = useCallback(() => {
      isKeyboardScopeActiveRef.current = true;
    }, []);

    const handleMouseLeave = useCallback(() => {
      if (wandDeleteActiveRef.current) return;
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
        commitZoomNow(newZoom);
        queuePanStateCommit(clamped.x, clamped.y);
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
    const pinchStartCenterRef = useRef({ x: 0, y: 0 });
    const isPinchingRef = useRef(false);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
      if ((e.target as HTMLElement).closest('[data-scrollbar]')) return;
      if (e.touches.length === 2) {
        if (e.nativeEvent.cancelable) e.preventDefault();
        if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
        isPinchingRef.current = true;
        isPanningRef.current = false;
        const areaRect = canvasAreaRef.current?.getBoundingClientRect();
        if (areaRect) {
          pinchStartCenterRef.current = {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - (areaRect.left + areaRect.width / 2),
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - (areaRect.top + areaRect.height / 2),
          };
        }
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
        pinchStartZoomRef.current = zoom;
        pinchStartPanRef.current = { x: panX, y: panY };
        return;
      }
      if (e.touches.length !== 1) return;
      if (e.nativeEvent.cancelable) e.preventDefault();
      if (activeSpotChannelRef.current && onWandTapRef.current && !panModeActiveRef.current) {
        const local = canvasToLocal(e.touches[0].clientX, e.touches[0].clientY);
        const hitId = findDesignAtPoint(local.x, local.y);
        const design = hitId ? designs.find(d => d.id === hitId) : undefined;
        const canvas = canvasRef.current;
        if (hitId && design && canvas) {
          const rect = computeLayerRect(
            design.imageInfo.image.width, design.imageInfo.image.height, design.transform,
            canvas.width, canvas.height, artboardWidth, artboardHeight,
            design.widthInches, design.heightInches
          );
          const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
          const rad = -(design.transform.rotation * Math.PI) / 180;
          const dx = local.x - cx, dy = local.y - cy;
          const nx = 0.5 + (dx * Math.cos(rad) - dy * Math.sin(rad)) / rect.width;
          const ny = 0.5 + (dx * Math.sin(rad) + dy * Math.cos(rad)) / rect.height;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) onWandTapRef.current(nx, ny, hitId);
        }
        return;
      }
      if (wandDeleteActive && onWandDeleteTap) {
        const local = canvasToLocal(e.touches[0].clientX, e.touches[0].clientY);
        const hitId = findDesignAtPoint(local.x, local.y);
        const design = hitId ? designs.find(d => d.id === hitId) : undefined;
        const canvas = canvasRef.current;
        if (hitId && design && canvas) {
          const rect = computeLayerRect(
            design.imageInfo.image.width, design.imageInfo.image.height, design.transform,
            canvas.width, canvas.height, artboardWidth, artboardHeight,
            design.widthInches, design.heightInches
          );
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const rad = -(design.transform.rotation * Math.PI) / 180;
          const dx = local.x - cx, dy = local.y - cy;
          const nx = 0.5 + (dx * Math.cos(rad) - dy * Math.sin(rad)) / rect.width;
          const ny = 0.5 + (dx * Math.sin(rad) + dy * Math.cos(rad)) / rect.height;
          if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) onWandDeleteTap(nx, ny, hitId);
        }
        return;
      }
      if (isHorizOverflow() && !moveModeRef.current) {
        const local = canvasToLocal(e.touches[0].clientX, e.touches[0].clientY);
        const handleHit = selectedDesignId ? hitTestHandles(local.x, local.y) : null;
        const multiHit = selectedDesignIds.size > 1 ? hitTestMultiHandles(local.x, local.y) : null;
        const hitDesign = findDesignAtPoint(local.x, local.y);
        if (!handleHit && !multiHit && !hitDesign) {
          isPanningRef.current = true;
          panStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, px: panX, py: panY };
          return;
        }
      }
      handleInteractionStart(e.touches[0].clientX, e.touches[0].clientY);
    }, [handleInteractionStart, panX, panY, zoom, isHorizOverflow, canvasToLocal, hitTestHandles, hitTestMultiHandles, selectedDesignId, selectedDesignIds, findDesignAtPoint, wandDeleteActive, onWandDeleteTap, onWandDeactivate]);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
      if (isPinchingRef.current && e.touches.length === 2) {
        if (e.nativeEvent.cancelable) e.preventDefault();
        const dx = e.touches[1].clientX - e.touches[0].clientX;
        const dy = e.touches[1].clientY - e.touches[0].clientY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const ratio = dist / Math.max(1, pinchStartDistRef.current);
        const effectiveMin = minZoomRef.current;
        const newZoom = Math.max(effectiveMin, Math.min(zoomMaxRef.current, pinchStartZoomRef.current * ratio));
        const anchor = pinchStartCenterRef.current;
        const startZoom = pinchStartZoomRef.current;
        const anchoredPanX = pinchStartPanRef.current.x + anchor.x * (1 / newZoom - 1 / startZoom);
        const anchoredPanY = pinchStartPanRef.current.y + anchor.y * (1 / newZoom - 1 / startZoom);
        const clamped = clampPanValue(anchoredPanX, anchoredPanY, newZoom);
        queueZoomCommit(newZoom);
        queuePanStateCommit(clamped.x, clamped.y);
        return;
      }
      if (e.touches.length !== 1) return;
      if (e.nativeEvent.cancelable) e.preventDefault();
      if (wandDeleteActiveRef.current) return;
      if (isPanningRef.current) {
        const dx = e.touches[0].clientX - panStartRef.current.x;
        const dy = e.touches[0].clientY - panStartRef.current.y;
        const rawPx = panStartRef.current.px + dx / zoom;
        const rawPy = panStartRef.current.py + dy / zoom;
        const clamped = clampPanValue(rawPx, rawPy, zoom);
        queuePanStateCommit(clamped.x, clamped.y);
        return;
      }
      pendingMoveRef.current = { cx: e.touches[0].clientX, cy: e.touches[0].clientY };
      if (moveRafRef.current == null) {
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = null;
          const pm = pendingMoveRef.current;
          if (!pm) return;
          pendingMoveRef.current = null;
          handleInteractionMove(pm.cx, pm.cy);
        });
      }
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
    
    // Fit entire sheet in the gray preview viewport (same behavior as changing sheet size — not the old paper-box math).
    const fitToView = useCallback((forceReset = false) => {
      suppressTransitionRef.current = true;
      const fit = computeFitZooms();
      if (!fit) {
        suppressTransitionRef.current = false;
        return;
      }
      minZoomRef.current = fit.minZoom;
      const z = fit.initialZoom;
      const shouldInitialFit = !hasInitialViewportFitRef.current;
      hasInitialViewportFitRef.current = true;
      if (forceReset || shouldInitialFit) {
        commitZoomNow(z);
        queuePanStateCommit(0, 0);
      } else {
        // Selecting a design can change the surrounding controls and cause
        // the preview to be measured again. That is a layout change, not a
        // user request to reset the view: preserve the current zoom and only
        // keep the existing pan valid for the new bounds.
        const preservedZoom = zoomRef.current;
        const clamped = clampPanValue(panXRef.current, panYRef.current, preservedZoom);
        queuePanStateCommit(clamped.x, clamped.y);
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          suppressTransitionRef.current = false;
        });
      });
    }, []);

    // Reset view to fit the full gangsheet in view
    const resetView = useCallback(() => {
      fitToView(true);
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

      // Pan 0 means different things on the two vertical models — the
      // artboard's middle at the viewport's middle when centred, its top edge
      // at the viewport's top when anchored — so bringing the design's centre
      // to the middle of the viewport takes a different offset for each.
      const rawPx = -(t.nx - 0.5) * dims.width;
      const rawPy = topAlignRef.current
        ? el.clientHeight / (2 * newZoom) - t.ny * dims.height
        : -(t.ny - 0.5) * dims.height;
      const clamped = clampPanValue(rawPx, rawPy, newZoom);
      commitZoomNow(newZoom);
      queuePanStateCommit(clamped.x, clamped.y);
      setMoveMode(true);
    }, [selectedDesignId, designs, artboardWidth, artboardHeight, clampPanValue]);

    /**
     * Read by the imperative handle, which is built once and so cannot close
     * over `zoomToSelected` directly without freezing the first selection.
     */
    const zoomToSelectedRef = useRef(zoomToSelected);
    zoomToSelectedRef.current = zoomToSelected;

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
          const jumpPan = scrollToPan(axis, jumpScroll, zoom);
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
        const nextPan = scrollToPan(drag.axis, nextScroll, z);
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
    }, [zoom, getScrollMetrics, panToScroll, scrollToPan, queuePanStateCommit]);

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
          const clamped = clampPanValue(rawPx, rawPy, z);
          queuePanStateCommit(clamped.x, clamped.y);
          return;
        }
        pendingMoveRef.current = { cx: e.clientX, cy: e.clientY, alt: e.altKey };
        if (moveRafRef.current == null) {
          moveRafRef.current = requestAnimationFrame(() => {
            moveRafRef.current = null;
            const pm = pendingMoveRef.current;
            if (!pm) return;
            pendingMoveRef.current = null;
            handleInteractionMoveRef.current?.(pm.cx, pm.cy, pm.alt);
          });
        }
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

    const prevArtboardSigRef = useRef<string | null>(null);
    useEffect(() => {
      const sig = `${artboardWidth},${artboardHeight}`;
      if (prevArtboardSigRef.current === sig) return;
      prevArtboardSigRef.current = sig;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          fitToView();
        }),
      );
    }, [artboardWidth, artboardHeight, fitToView]);

    useEffect(() => {
      const el = canvasAreaRef.current;
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();

        // Ctrl/Cmd+wheel OR pinch-to-zoom (browsers set ctrlKey for pinch): ZOOM
        if (e.ctrlKey || e.metaKey) {
          if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
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
          // Anchor against the viewport center, not the transformed canvas
          // center. The latter moves with pan and causes zoom to pull the
          // design back toward the page center after hand-panning.
          const viewportRect = el.getBoundingClientRect();
          const cursorX = e.clientX - (viewportRect.left + viewportRect.width / 2);
          const cursorY = e.clientY - (viewportRect.top + viewportRect.height / 2);

          const oldPx = panXRef.current;
          const oldPy = panYRef.current;
          const rawPanX = oldPx + cursorX * (1 / newZoom - 1 / oldZoom);
          const rawPanY = oldPy + cursorY * (1 / newZoom - 1 / oldZoom);
          const clamped = clampPanValue(rawPanX, rawPanY, newZoom);
          const dims = previewDimsRef.current;

          queueZoomCommit(newZoom);
          queuePanStateCommit(clamped.x, clamped.y);
          if (!selectionZoomActiveRef.current && !isPanningRef.current) {
            el.style.cursor = (newZoom * dims.width > el.clientWidth * 1.05 && !moveModeRef.current) ? 'grab' : 'default';
          }
          return;
        }

        // Plain wheel: scroll/pan (Shift+wheel → horizontal)
        const z = zoomRef.current;
        const rawDx = e.shiftKey ? e.deltaY : e.deltaX;
        const rawDy = e.shiftKey ? 0 : e.deltaY;
        const newPanX = panXRef.current - rawDx / z;
        const newPanY = panYRef.current - rawDy / z;
        const clamped = clampPanValue(newPanX, newPanY, z);
        if (clamped.x === panXRef.current && clamped.y === panYRef.current) return;
        queuePanStateCommit(clamped.x, clamped.y);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => {
        el.removeEventListener('wheel', onWheel);
        if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
      };
    }, []);

    useEffect(() => {
      if (!imageInfo) {
        lastImageRef.current = null;
        return;
      }

      const imageKey = `${imageInfo.image.src}-${imageInfo.image.width}-${imageInfo.image.height}`;
      if (lastImageRef.current === imageKey) return;
      lastImageRef.current = imageKey;
    }, [imageInfo]);

    // Desktop: measure before paint. Mobile: skip — the preview flex area often has a *smaller* height on the first
    // layout pass (parent column, safe-area, pb-16), then grows a frame later → “small sheet then jumps bigger”.
    // First mobile measure runs in useEffect after a short rAF chain instead.
    useLayoutEffect(() => {
      if (isNarrowViewport()) return;
      lastStablePreviewDimsRef.current = null;
      syncPreviewSizeFromWrapper();
    }, [syncPreviewSizeFromWrapper]);

    // Same “minimized” fit as after changing sheet size, but before paint (no zoom-in-then-snap). Does not run on every render.
    // On narrow: quantize the signature so Safari/RO 1–6px wobble doesn’t re-run fit+pan reset (felt as “bounce”).
    useLayoutEffect(() => {
      if (previewDims.width <= 0 || previewDims.height <= 0) return;
      const w = previewDims.width;
      const h = previewDims.height;
      const sig = isNarrowViewport()
        ? `${Math.round(w / 8) * 8}x${Math.round(h / 8) * 8}@${artboardWidth}x${artboardHeight}`
        : `${w}x${h}@${artboardWidth}x${artboardHeight}`;
      if (lastViewportFitSigRef.current === sig) return;
      lastViewportFitSigRef.current = sig;
      const area = canvasAreaRef.current;
      if (!area) return;
      suppressTransitionRef.current = true;
      const fit = computeFitZooms();
      if (!fit) {
        suppressTransitionRef.current = false;
        return;
      }
      minZoomRef.current = fit.minZoom;
      const z = fit.initialZoom;
      const shouldInitialViewportFit = !hasInitialViewportFitRef.current;
      hasInitialViewportFitRef.current = true;
      if (shouldInitialViewportFit) {
        commitZoomNow(z);
        queuePanStateCommit(0, 0);
      } else {
        // Selecting a design can resize the surrounding controls by a few
        // pixels. That measurement change must not undo a user's zoomed view.
        // Preserve zoom and only clamp it/pan if the new viewport is smaller.
        // The floor is the whole-sheet zoom, not the starting zoom: on mobile
        // the two differ, and using the starting zoom here would yank a user
        // who had deliberately zoomed out back to full width.
        const preservedZoom = Math.max(fit.minZoom, Math.min(zoomMaxRef.current, zoomRef.current));
        const clamped = clampPanValue(panXRef.current, panYRef.current, preservedZoom);
        commitZoomNow(preservedZoom);
        queuePanStateCommit(clamped.x, clamped.y);
      }
      const clearSuppress = () => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            suppressTransitionRef.current = false;
          });
        });
      };
      if (isNarrowViewport()) {
        requestAnimationFrame(clearSuppress);
      } else {
        clearSuppress();
      }
    }, [previewDims.width, previewDims.height, artboardWidth, artboardHeight, clampPanValue, computeFitZooms]);

    useEffect(() => {
      const wrapper = canvasAreaRef.current;
      if (!wrapper) return;

      let cancelled = false;
      let resizeRafId: number | null = null;
      let resizeDebounceId: ReturnType<typeof setTimeout> | null = null;

      const runSync = () => {
        if (cancelled) return;
        if (resizeRafId != null) return;
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = null;
          syncPreviewSizeFromWrapper();
        });
      };

      const scheduleResize = () => {
        const ms = isNarrowViewport() ? 150 : 50;
        if (resizeDebounceId != null) clearTimeout(resizeDebounceId);
        resizeDebounceId = setTimeout(() => {
          resizeDebounceId = null;
          runSync();
        }, ms);
      };

      const observer = new ResizeObserver(() => {
        scheduleResize();
      });

      const vv = typeof window !== 'undefined' ? window.visualViewport : null;
      const onVisualViewport = () => {
        scheduleResize();
      };

      const narrow = isNarrowViewport();
      let bootstrapOuterRaf: number | null = null;

      const attachResizeListeners = () => {
        observer.observe(wrapper);
        if (vv) vv.addEventListener('resize', onVisualViewport);
      };

      if (narrow) {
        // Wait until flex + insets + parent padding have settled; avoid RO firing first with a too-small height.
        bootstrapOuterRaf = requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              if (cancelled) return;
              lastStablePreviewDimsRef.current = null;
              syncPreviewSizeFromWrapper();
              attachResizeListeners();
            });
          });
        });
      } else {
        syncPreviewSizeFromWrapper();
        attachResizeListeners();
      }

      return () => {
        cancelled = true;
        observer.disconnect();
        if (resizeDebounceId != null) clearTimeout(resizeDebounceId);
        if (resizeRafId != null) cancelAnimationFrame(resizeRafId);
        if (vv) {
          vv.removeEventListener('resize', onVisualViewport);
        }
        if (bootstrapOuterRaf != null) cancelAnimationFrame(bootstrapOuterRaf);
      };
    }, [syncPreviewSizeFromWrapper]);

    useImperativeHandle(ref, () => {
      const canvas = canvasRef.current;
      if (!canvas) return null as any;
      (canvas as any).getViewportCenterNormalized = () => {
        const dims = previewDimsRef.current;
        const z = zoomRef.current;
        const px = panXRef.current;
        const py = panYRef.current;
        const el = canvasAreaRef.current;
        const vh = el ? el.clientHeight : dims.height;
        const nx = 0.5 - px / Math.max(1, dims.width);
        const ny = topAlignRef.current
          ? (vh / (2 * z) - py) / Math.max(1, dims.height)
          : 0.5 - py / Math.max(1, dims.height);
        return { nx: Math.max(0.05, Math.min(0.95, nx)), ny: Math.max(0.05, Math.min(0.95, ny)) };
      };
      return canvas;
    }, []);

    /**
     * Hand the parent the same action the Focus button performs — fit the view
     * to the selected design.
     *
     * Registered through a callback rather than hung off the imperative handle
     * above, which is built once with no dependencies and captures
     * `canvasRef.current` before this canvas exists; it resolves to `null` and
     * never re-runs, so anything attached there is unreachable. An effect runs
     * after the canvas is mounted and re-registers whenever the parent's
     * callback changes.
     */
    useEffect(() => {
      onRegisterFocus?.(() => zoomToSelectedRef.current());
    }, [onRegisterFocus]);

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
        stopAnimator('spotPulse');
        spotOverlayCacheRef.current = null;
        if (renderRef.current) renderRef.current();
        return;
      }
      const hasAny = spotPreviewData?.colors?.some(c => c.spotFluorY || c.spotFluorM || c.spotFluorG || c.spotFluorOrange || c.spotWhite || c.spotGloss);
      if (!hasAny) {
        spotPulseRef.current = 1;
        stopAnimator('spotPulse');
        spotOverlayCacheRef.current = null;
        if (renderRef.current) renderRef.current();
        return;
      }
      let startTime: number | null = null;
      let lastFrameTime = 0;
      const FRAME_INTERVAL = 1000 / 30;
      startAnimator('spotPulse', (timestamp) => {
        if (startTime === null) startTime = timestamp;
        if (timestamp - lastFrameTime < FRAME_INTERVAL) return false;
        lastFrameTime = timestamp;
        const elapsed = (timestamp - startTime) / 1000;
        spotPulseRef.current = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(elapsed * Math.PI * 1.5));
        // Mid-gesture the sheet is already being repainted every frame and will read the
        // new pulse value on its way through. Asking for a draw here would paint the whole
        // sheet a second time to show a highlight that is about to be drawn anyway.
        return !isInteractionActive();
      });
      return () => {
        stopAnimator('spotPulse');
        spotPulseRef.current = 1;
      };
    }, [spotPreviewData, startAnimator, stopAnimator, isInteractionActive]);

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
      const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
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

    // Preview-only mipmap cache: designs are usually drawn far below source
    // resolution, and letting drawImage downscale a multi-megapixel bitmap on
    // every composite rebuild / drag frame is the dominant per-draw cost. We
    // cache a half/quarter/eighth-size copy (power-of-two buckets, so any
    // final draw downscales at most 2x) and draw from that instead. Export
    // and cart rendering never touch this path, so production files keep
    // full source quality.
    const mipmapCacheRef = useRef<Map<string, { canvas: HTMLCanvasElement; image: HTMLImageElement; pixels: number }>>(new Map());
    const mipmapTotalPixelsRef = useRef(0);
    // Aggregate budget: ~16 MP of RGBA backing store (~64 MB) across all mips
    // so the cache can never balloon on mobile; LRU-evicted beyond that.
    const MIPMAP_MAX_TOTAL_PIXELS = 16_000_000;
    const getPreviewDrawSource = useCallback((image: HTMLImageElement, targetW: number, targetH: number): CanvasImageSource => {
      const sw = image.naturalWidth || image.width;
      const sh = image.naturalHeight || image.height;
      if (!sw || !sh || !image.src) return image;
      const ratio = Math.max(targetW / sw, targetH / sh);
      // Not shrinking by at least 2x → drawing the source directly is fine.
      if (!(ratio > 0) || ratio > 0.5) return image;
      const bucket = Math.min(0.5, Math.max(1 / 8, Math.pow(2, Math.ceil(Math.log2(ratio)))));
      const key = `${image.src}|${bucket}`;
      const cache = mipmapCacheRef.current;
      const hit = cache.get(key);
      // A hit is only valid if it was built from this exact image element —
      // if the design's image was replaced (even under the same URL), the
      // identity check forces a rebuild so we never serve stale pixels.
      if (hit && hit.image === image) {
        // LRU bump
        cache.delete(key);
        cache.set(key, hit);
        return hit.canvas;
      }
      if (hit) {
        cache.delete(key);
        mipmapTotalPixelsRef.current -= hit.pixels;
      }
      const mw = Math.max(1, Math.round(sw * bucket));
      const mh = Math.max(1, Math.round(sh * bucket));
      const pixels = mw * mh;
      if (pixels > 4_000_000) return image;
      const c = document.createElement('canvas');
      c.width = mw;
      c.height = mh;
      const cx = c.getContext('2d');
      if (!cx) return image;
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(image, 0, 0, mw, mh);
      cache.set(key, { canvas: c, image, pixels });
      mipmapTotalPixelsRef.current += pixels;
      while (mipmapTotalPixelsRef.current > MIPMAP_MAX_TOTAL_PIXELS && cache.size > 1) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey == null) break;
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        if (oldest) mipmapTotalPixelsRef.current -= oldest.pixels;
      }
      return c;
    }, []);

    const drawSingleDesign = useCallback((
      ctx: CanvasRenderingContext2D,
      design: DesignItem,
      cw: number,
      ch: number,
      /** Draw the design somewhere other than where it is, for the post-arrange slide. */
      transformOverride?: ImageTransform,
    ) => {
      const transform = transformOverride ?? design.transform;
      const rect = computeLayerRect(
        design.imageInfo.image.width, design.imageInfo.image.height,
        transform, cw, ch,
        artboardWidth, artboardHeight,
        design.widthInches, design.heightInches,
      );
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      ctx.save();
      if (design.alphaThresholded) ctx.imageSmoothingEnabled = false;
      ctx.translate(cx, cy);
      ctx.rotate((transform.rotation * Math.PI) / 180);
      ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
      // Alpha-thresholded designs intentionally draw unsmoothed from source
      // to keep crisp sticker edges — skip the mipmap for them.
      const drawSrc = design.alphaThresholded
        ? design.imageInfo.image
        : getPreviewDrawSource(design.imageInfo.image, rect.width, rect.height);
      ctx.drawImage(drawSrc, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
      const label = getDesignLabel(design);
      if (label) {
        // Undo the flip so the name is never mirrored. The label's coordinates are defined in
        // this unflipped space, which is also the space the nest mask reserved it in.
        ctx.scale(transform.flipX ? -1 : 1, transform.flipY ? -1 : 1);
        const artH = design.heightInches * transform.s;
        if (artH > 0) {
          drawPrintLabel(ctx, label, rect.height / artH, labelReadsUpsideDown(transform.rotation));
        }
      }
      ctx.restore();
    }, [artboardWidth, artboardHeight, getPreviewDrawSource]);

    const selectedDetailDesign = selectedDesignId
      ? designs.find(design => design.id === selectedDesignId) ?? null
      : null;
    const selectedDetailImage = selectedDetailDesign?.imageInfo.image ?? null;
    // The pixel-preserving overlay canvas exists to keep halftone dot patterns
    // crisp at high zoom (its render path uses imageRendering: pixelated).
    // Alpha-thresholded (transparent-PNG sticker) designs do NOT need the
    // overlay: `drawImageWithResizePreview` already disables smoothing for
    // them, so their clean alpha edges are preserved by the main canvas.
    // Using nearest-neighbor scaling for full-color stickers made them look
    // blocky when selected at zoom >= 3.
    // The overlay is only lossless when the full halftone raster fits within
    // its size caps. Large 300-DPI halftones would otherwise be nearest-
    // neighbor DOWNSCALED into the overlay canvas, shredding the dot pattern
    // (looks washed out / speckled while selected) — and combined with the
    // inset(6px) clip the design also looked cropped. For oversized rasters,
    // skip the overlay entirely: the main-canvas path renders the halftone
    // exactly like the deselected composite does.
    const detailSourceWidth = selectedDetailImage?.naturalWidth || selectedDetailImage?.width || 0;
    const detailSourceHeight = selectedDetailImage?.naturalHeight || selectedDetailImage?.height || 0;
    const detailOverlayLossless =
      detailSourceWidth > 0 &&
      detailSourceHeight > 0 &&
      detailSourceWidth * detailSourceHeight <= HIGH_QUALITY_DETAIL_MAX_AREA &&
      Math.max(detailSourceWidth, detailSourceHeight) <= HIGH_QUALITY_DETAIL_MAX_EDGE;
    const showHighQualityDetail =
      highQualityDetailZoomActive &&
      Boolean(selectedDetailDesign?.halftoned) &&
      Boolean(selectedDetailImage?.complete) &&
      detailOverlayLossless;

    // Render only the selected binary-raster design at source resolution (within
    // a bounded area). The whole-sheet canvas remains capped and fast; this
    // focused layer prevents CSS zoom interpolation from softening halftone dots.
    useEffect(() => {
      const canvas = detailCanvasRef.current;
      if (!canvas || !showHighQualityDetail || !selectedDetailDesign || !selectedDetailImage) return;

      const sourceWidth = selectedDetailImage.naturalWidth || selectedDetailImage.width;
      const sourceHeight = selectedDetailImage.naturalHeight || selectedDetailImage.height;
      if (!sourceWidth || !sourceHeight) return;

      // `showHighQualityDetail` guarantees the source fits within the
      // MAX_AREA / MAX_EDGE caps, so the overlay always renders 1:1 —
      // downscaling here would shred the halftone dot pattern.
      const rasterWidth = Math.max(1, Math.round(sourceWidth));
      const rasterHeight = Math.max(1, Math.round(sourceHeight));

      canvas.width = rasterWidth;
      canvas.height = rasterHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, rasterWidth, rasterHeight);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(selectedDetailImage, 0, 0, rasterWidth, rasterHeight);
    }, [
      showHighQualityDetail,
      selectedDetailDesign?.id,
      selectedDetailImage,
      selectedDetailImage?.naturalWidth,
      selectedDetailImage?.naturalHeight,
    ]);

    /**
     * Sliding designs into the places an auto-arrange chose for them.
     *
     * An arrange can move most of the sheet at once, and committing that in a single frame
     * reads as the editor glitching rather than as it packing — which is the substance of the
     * report that adding copies "feels buggy". Interpolating the positions for a fifth of a
     * second turns exactly the same work into something the eye can follow.
     *
     * Designs mid-slide are handled the way a dragged group already is: kept out of the static
     * composite so it stays cached, then drawn over it once per frame at their interpolated
     * positions. Writing the interpolated values back into `designs` would instead change every
     * entry of the composite signature on every frame and rebuild the whole sheet at 60 fps,
     * which is considerably worse than the jump it set out to smooth.
     */
    const ARRANGE_SLIDE_MS = 200;
    /**
     * Above this many designs the slide is skipped and the layout snaps as it used to.
     *
     * A frame costs one draw per sliding design, so this bounds the very cost the composite
     * cache exists to avoid. A sheet this full is also one where each design is small enough
     * that the motion reads as noise rather than as movement.
     */
    const ARRANGE_SLIDE_MAX_DESIGNS = 120;
    /** Movement smaller than this fraction of the sheet is not worth animating. */
    const ARRANGE_SLIDE_MIN_DELTA = 0.002;

    type ArrangeSlide = {
      startedAt: number;
      /** Where each design sat before the arrange. Missing for designs that are new. */
      from: Map<string, ImageTransform>;
      /** Designs that did not exist beforehand, which fade up rather than travel. */
      fadeIn: Set<string>;
      /** Eased 0..1, read by the draw pass. */
      progress: number;
    };
    const arrangeSlideRef = useRef<ArrangeSlide | null>(null);
    const prevTransformsRef = useRef<Map<string, ImageTransform>>(new Map());

    /** Part-way between two transforms. Size and mirroring come from the destination. */
    const lerpTransform = (from: ImageTransform, to: ImageTransform, p: number): ImageTransform => {
      // Rotation takes the short way round. Without this a 350 degree design settling at 0
      // spins most of a full turn to travel ten degrees.
      const turn = ((((to.rotation - from.rotation) % 360) + 540) % 360) - 180;
      return {
        ...to,
        nx: from.nx + (to.nx - from.nx) * p,
        ny: from.ny + (to.ny - from.ny) * p,
        s: from.s + (to.s - from.s) * p,
        rotation: from.rotation + turn * p,
      };
    };

    const slidHandledEpochRef = useRef(0);

    useEffect(() => {
      // Only an arrange arms a slide. This effect also re-runs whenever `designs` changes —
      // a drag, a resize, a halftone — and every one of those would otherwise look like a
      // move worth animating, because the snapshot below is by then one commit behind.
      if (arrangeEpoch <= 0 || arrangeEpoch === slidHandledEpochRef.current) return;
      slidHandledEpochRef.current = arrangeEpoch;
      if (designs.length === 0 || designs.length > ARRANGE_SLIDE_MAX_DESIGNS) return;
      // Someone mid-gesture is already watching their design move under the pointer; the
      // arrange has no business animating the sheet out from under that.
      if (isInteractionActive()) return;
      if (typeof window !== 'undefined'
        && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

      const previous = prevTransformsRef.current;
      const running = arrangeSlideRef.current;
      const from = new Map<string, ImageTransform>();
      const fadeIn = new Set<string>();
      let travelling = 0;
      for (const d of designs) {
        // A slide already in flight has designs part-way to their last destination, and
        // `previous` holds that destination rather than where they are actually drawn. Starting
        // the new slide from what is on screen is what keeps a held-down `+` reading as one
        // continuous reflow instead of a series of twitches backwards.
        const interrupted = running?.from.get(d.id);
        const was = interrupted
          ? lerpTransform(interrupted, previous.get(d.id) ?? d.transform, running!.progress)
          : previous.get(d.id);
        if (!was) { fadeIn.add(d.id); continue; }
        from.set(d.id, was);
        if (Math.abs(was.nx - d.transform.nx) > ARRANGE_SLIDE_MIN_DELTA
          || Math.abs(was.ny - d.transform.ny) > ARRANGE_SLIDE_MIN_DELTA
          || was.rotation !== d.transform.rotation) travelling++;
      }
      // An arrange that anchored everything it touched has nothing to show.
      if (travelling === 0 && fadeIn.size === 0) return;

      arrangeSlideRef.current = { startedAt: performance.now(), from, fadeIn, progress: 0 };
      startAnimator('arrangeSlide', now => {
        const slide = arrangeSlideRef.current;
        if (!slide) { stopAnimator('arrangeSlide'); return false; }
        const linear = Math.min(1, (now - slide.startedAt) / ARRANGE_SLIDE_MS);
        // Quick off the mark and settling gently, which reads as the sheet coming to rest
        // rather than as everything travelling at one speed.
        slide.progress = 1 - Math.pow(1 - linear, 3);
        if (linear >= 1) {
          arrangeSlideRef.current = null;
          stopAnimator('arrangeSlide');
          // One clean pass, so the settled designs go back into the cached composite instead
          // of being redrawn one by one for the rest of the session.
          setInteractionEpoch(e => e + 1);
        }
        return true;
      });
    }, [arrangeEpoch, designs, isInteractionActive, startAnimator, stopAnimator]);

    // Remembered after every change to the designs, so the next arrange knows where things
    // were. Declared after the effect above on purpose: React runs effects in order within a
    // commit, and this one overwrites precisely what that one reads.
    useEffect(() => {
      const snapshot = new Map<string, ImageTransform>();
      for (const d of designs) snapshot.set(d.id, d.transform);
      prevTransformsRef.current = snapshot;
    }, [designs]);

    useEffect(() => {
      if (!canvasRef.current) return;

      // The per-design portion of the static-composite signature only depends
      // on values that are dependencies of this effect (designs,
      // selectedDesignId, overlappingDesigns). Compute it once per effect run
      // instead of re-hashing every design on every drag/render frame — with
      // many designs the per-frame string build was itself a hot-path cost.
      const multiSelectionKey = Array.from(selectedDesignIds).sort().join(',');
      // While a group interaction is active, multi-selected companions are
      // excluded from the static composite and drawn per-frame on top.
      // Group drag/resize/rotate all commit `designs` on every pointer move,
      // so leaving their transforms in the signature would invalidate — and
      // fully rebuild — the composite on every frame. Excluding them keeps
      // the composite cacheable for the whole gesture (rebuilds only at
      // gesture start/stop).
      //
      // Resize and rotate were previously left out of this, which meant a
      // group resize rebuilt the full-resolution composite of every
      // unselected design on every frame while a group drag rebuilt it
      // twice for the entire gesture. The exclusion is purely about which
      // canvas the companions are drawn onto; the ghost alpha below is a
      // separate, drag-only visual treatment.
      const groupTransforming = isMultiResizeRef.current || isMultiRotateRef.current;
      const movingExcluded = (isDraggingRef.current || isMultiDragRef.current || groupTransforming) && selectedDesignIds.size > 1
        ? selectedDesignIds
        : null;
      // Designs mid-slide leave the composite for the same reason a dragged group does: their
      // positions change every frame, so baking them would rebuild the whole sheet 60 times a
      // second. Taken from a ref rather than state so the arrange's very first paint already
      // excludes them — the effect that arms the slide runs before this one in the same commit.
      const slide = arrangeSlideRef.current;
      const slidingIds = slide
        ? new Set(designs.filter(d => slide.from.has(d.id) || slide.fadeIn.has(d.id)).map(d => d.id))
        : null;
      const compositeExcluded = movingExcluded && slidingIds
        ? new Set([...movingExcluded, ...slidingIds])
        : (movingExcluded ?? slidingIds);
      let staticSignatureBody = '';
      for (const d of designs) {
        if (d.id === selectedDesignId) continue;
        if (compositeExcluded?.has(d.id)) continue;
        const t = d.transform;
        staticSignatureBody += `${d.id}:${d.imageInfo.image.src ?? d.imageInfo.image.width}:${t.nx.toFixed(4)},${t.ny.toFixed(4)},${t.s.toFixed(4)},${t.rotation.toFixed(2)},${t.flipX?1:0},${t.flipY?1:0}:${d.widthInches.toFixed(4)}x${d.heightInches.toFixed(4)}:${d.printFileName?1:0}:${d.alphaThresholded?1:0}:${overlappingDesigns.has(d.id)?1:0};`;
      }

      const doRender = () => {
      try {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      if (previewDims.width <= 0 || previewDims.height <= 0) return;

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
        // Canvas dimensions changed → composite geometry is stale.
        staticCompositeRef.current = null;
      } else {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      }

      // Adaptive quality: bilinear downscale is expensive on mid-range
      // Android and older iPhones. During drag/resize/rotate the visual
      // difference between 'low' and 'high' is imperceptible at 60 fps, so
      // drop to 'low' while interacting and restore 'high' on the next
      // idle frame (mouseUp triggers a fresh render pass).
      const isMoving = isDraggingRef.current || isMultiDragRef.current;
      const isInteracting = isMoving || isResizingRef.current || isRotatingRef.current
        || isMultiResizeRef.current || isMultiRotateRef.current
        || isPanningRef.current;
      ctx.imageSmoothingEnabled = true;
      // The slide borrows the drag path's economies for its two hundred milliseconds: nobody
      // is judging edge quality on a sheet that is still moving, and the clean pass at the end
      // restores it.
      ctx.imageSmoothingQuality = isInteracting || slidingIds ? 'low' : 'high';

      // Build a fingerprint of the static-composite state (everything
      // except the currently-selected design, which is drawn separately
      // below because its transform mutates via `transformRef` on every
      // drag frame). If unchanged, we blit the cached bitmap in a single
      // drawImage call.
      // `mv` (build scale + ghost alpha), `gx` (whether multi-selected
      // companions are baked in at all) and the multi-selection key all
      // participate in the signature, so starting or ending a group gesture
      // invalidates the cache and forces one clean rebuild.
      const signature = `${canvasWidth}x${canvasHeight}|${previewBgColor}|${artboardWidth}x${artboardHeight}|sel:${selectedDesignId ?? '-'}|mv:${isMoving ? 1 : 0}|gx:${movingExcluded ? 1 : 0}|sl:${slidingIds ? 1 : 0}|msel:${multiSelectionKey}|${staticSignatureBody}`;

      const cached = staticCompositeRef.current;
      if (cached && cached.signature === signature) {
        // The cached composite may have been built at reduced resolution
        // (mid-drag) — always blit stretched to the full canvas.
        ctx.drawImage(cached.canvas, 0, 0, canvasWidth, canvasHeight);
      } else {
        // Rebuild the composite off-screen so the on-screen canvas never
        // shows a half-drawn state (avoids the flicker that would result
        // from clearing then drawing 30+ images on the visible ctx).
        //
        // While a drag is active the composite is built at half resolution:
        // the rebuild only happens at drag start (mv flips in the signature),
        // and on very full sheets a full-res rebuild there is the visible
        // hitch when picking a design up. The half-res version is blitted
        // upscaled for the drag's duration; releasing the pointer flips mv
        // back, invalidating the signature and triggering one full-quality
        // rebuild. Preview-only — exports untouched.
        const buildScale = isMoving || slidingIds ? 0.5 : 1;
        const compW = Math.max(1, Math.round(canvasWidth * buildScale));
        const compH = Math.max(1, Math.round(canvasHeight * buildScale));
        const composite = cached?.canvas ?? document.createElement('canvas');
        if (composite.width !== compW) composite.width = compW;
        if (composite.height !== compH) composite.height = compH;
        const cctx = composite.getContext('2d');
        if (!cctx) {
          drawStaticSceneInto(ctx, canvasWidth, canvasHeight);
        } else {
          cctx.clearRect(0, 0, compW, compH);
          cctx.imageSmoothingEnabled = true;
          cctx.imageSmoothingQuality = 'high';
          const rebuildStart = cullProbeEnabled ? performance.now() : 0;
          drawStaticSceneInto(cctx, compW, compH);
          if (cullProbeEnabled) recordCullProbe(performance.now() - rebuildStart, canvas, compW, compH);
          compositeRebuildsRef.current++;
          staticCompositeRef.current = { canvas: composite, signature };
          ctx.drawImage(composite, 0, 0, canvasWidth, canvasHeight);
        }
      }

      // Multi-selected companions render per-frame on top of the cached
      // composite. While *dragging* they are semi-transparent so the user can
      // see where they are landing. A group resize or rotate deliberately
      // keeps them fully opaque at full smoothing quality: the customer is
      // judging size and fit against the sheet, so fidelity matters more than
      // the ghost cue there. Preview-only — exports untouched.
      if (movingExcluded) {
        const prevQuality = ctx.imageSmoothingQuality;
        if (isMoving) ctx.globalAlpha = 0.77;
        else ctx.imageSmoothingQuality = 'high';
        for (const design of designs) {
          if (design.id === selectedDesignId) continue;
          if (!movingExcluded.has(design.id)) continue;
          drawSingleDesign(ctx, design, canvasWidth, canvasHeight);
        }
        ctx.globalAlpha = 1;
        ctx.imageSmoothingQuality = prevQuality;
      }

      // Designs on their way to the places the arrange chose. Drawn over the composite at
      // interpolated positions rather than baked into it; the composite behind them holds only
      // the parts of the sheet that are staying put.
      if (slide && slidingIds) {
        const p = slide.progress;
        for (const design of designs) {
          // The selected design has its own draw path below, fed by `transformRef`, and that
          // ref belongs to the drag machinery. After a duplicate the selection is the new copy,
          // which appears rather than travels, so leaving it out costs nothing there.
          if (design.id === selectedDesignId) continue;
          if (!slidingIds.has(design.id)) continue;
          const was = slide.from.get(design.id);
          if (!was) {
            // Did not exist before the arrange, so it is a fresh copy. Travelling from nowhere
            // means nothing; it fades up where it landed instead.
            ctx.globalAlpha = p;
            drawSingleDesign(ctx, design, canvasWidth, canvasHeight);
            ctx.globalAlpha = 1;
            continue;
          }
          drawSingleDesign(ctx, design, canvasWidth, canvasHeight, lerpTransform(was, design.transform, p));
        }
      }

      /** Rotation-aware bounding box of a design, in destination pixels. */
      function designIntersects(
        design: DesignItem,
        cw: number,
        ch: number,
        r: { x0: number; y0: number; x1: number; y1: number },
      ) {
        const rect = computeLayerRect(
          design.imageInfo.image.width, design.imageInfo.image.height,
          design.transform, cw, ch,
          artboardWidth, artboardHeight,
          design.widthInches, design.heightInches,
        );
        const rad = (design.transform.rotation * Math.PI) / 180;
        const c = Math.abs(Math.cos(rad));
        const s = Math.abs(Math.sin(rad));
        const halfW = (rect.width * c + rect.height * s) / 2;
        const halfH = (rect.width * s + rect.height * c) / 2;
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        return cx + halfW >= r.x0 && cx - halfW <= r.x1
          && cy + halfH >= r.y0 && cy - halfH <= r.y1;
      }

      /**
       * Re-runs the rebuild we just did, this time skipping designs outside
       * the visible slice of the sheet, and logs both timings. Scratch canvas
       * only — nothing here reaches the screen.
       */
      function recordCullProbe(fullMs: number, sheetCanvas: HTMLCanvasElement, cw: number, ch: number) {
        const area = canvasAreaRef.current;
        if (!area) return;
        const areaRect = area.getBoundingClientRect();
        const sheetRect = sheetCanvas.getBoundingClientRect();
        if (sheetRect.width <= 0 || sheetRect.height <= 0) return;
        // Visible slice of the sheet, expressed in destination pixels.
        const toX = (clientX: number) => ((clientX - sheetRect.left) / sheetRect.width) * cw;
        const toY = (clientY: number) => ((clientY - sheetRect.top) / sheetRect.height) * ch;
        const visibleRect = {
          x0: toX(Math.max(areaRect.left, sheetRect.left)),
          y0: toY(Math.max(areaRect.top, sheetRect.top)),
          x1: toX(Math.min(areaRect.right, sheetRect.right)),
          y1: toY(Math.min(areaRect.bottom, sheetRect.bottom)),
        };

        let considered = 0;
        let visible = 0;
        for (const design of designs) {
          if (design.id === selectedDesignId) continue;
          if (movingExcluded?.has(design.id)) continue;
          considered++;
          if (designIntersects(design, cw, ch, visibleRect)) visible++;
        }

        let scratch = cullProbeCanvasRef.current;
        if (!scratch) {
          scratch = document.createElement('canvas');
          cullProbeCanvasRef.current = scratch;
        }
        if (scratch.width !== cw) scratch.width = cw;
        if (scratch.height !== ch) scratch.height = ch;
        const sctx = scratch.getContext('2d');
        if (!sctx) return;
        sctx.clearRect(0, 0, cw, ch);
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        const culledStart = performance.now();
        drawStaticSceneInto(sctx, cw, ch, visibleRect);
        const culledMs = performance.now() - culledStart;

        const w = window as unknown as { __cullProbe?: unknown[] };
        if (!w.__cullProbe) w.__cullProbe = [];
        w.__cullProbe.push({
          fullMs: Math.round(fullMs * 100) / 100,
          culledMs: Math.round(culledMs * 100) / 100,
          considered,
          visible,
          sheet: `${artboardWidth}x${artboardHeight}`,
          buffer: `${cw}x${ch}`,
          zoom: Math.round(zoomRef.current * 100) / 100,
        });
      }

      function drawStaticSceneInto(
        dctx: CanvasRenderingContext2D,
        cw: number,
        ch: number,
        // Dev probe only. When set, designs whose bounds fall entirely outside
        // this rect (in dctx pixels) are skipped.
        visibleRect?: { x0: number; y0: number; x1: number; y1: number } | null,
      ) {
        if (previewBgColor === 'transparent') {
          const pattern = getCheckerboardPattern(dctx, cw, ch);
          if (pattern) {
            dctx.fillStyle = pattern;
            dctx.fillRect(0, 0, cw, ch);
          }
        } else {
          dctx.fillStyle = previewBgColor;
          dctx.fillRect(0, 0, cw, ch);
        }
        for (const design of designs) {
          if (design.id === selectedDesignId) continue;
          // Moving companions and designs mid-slide are drawn per-frame on top
          // of the composite (see below), not baked into it.
          if (compositeExcluded?.has(design.id)) continue;
          if (visibleRect && !designIntersects(design, cw, ch, visibleRect)) continue;
          drawSingleDesign(dctx, design, cw, ch);
          if (overlappingDesigns.has(design.id)) {
            const rect = computeLayerRect(
              design.imageInfo.image.width, design.imageInfo.image.height,
              design.transform, cw, ch,
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
            dctx.save();
            dctx.strokeStyle = '#ff0000';
            dctx.lineWidth = 2 * dpiScaleRef.current;
            dctx.setLineDash([6 * dpiScaleRef.current, 3 * dpiScaleRef.current]);
            dctx.beginPath();
            dctx.moveTo(corners[0].x, corners[0].y);
            for (let ci = 1; ci < corners.length; ci++) dctx.lineTo(corners[ci].x, corners[ci].y);
            dctx.closePath();
            dctx.stroke();
            dctx.setLineDash([]);
            dctx.restore();
          }
        }
      }

      if (!imageInfo || !selectedDesignId) return;

      // Ghost the primary dragged design so the underlying sheet shows
      // through; full opacity returns the moment the pointer is released.
      if (isMoving) ctx.globalAlpha = 0.72;
      drawImageWithResizePreview(ctx, canvas.width, canvas.height);
      if (isMoving) ctx.globalAlpha = 1;

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

          // Resize handles at corners — all four the same size.
          const zHandles = Math.max(ZOOM_MIN_ABSOLUTE, zoomRef.current);
          const actualDpi = canvasWidth / Math.max(1, previewDims.width);
          const bufferPerCss = actualDpi / zHandles;
          const groupMin = Math.min(groupBBox.width, groupBBox.height);
          const handleR = getHandleHalfCssPx(groupMin / bufferPerCss, zHandles, isMobile, 0.15) * bufferPerCss;
          const groupHandles = [
            { x: groupBBox.x, y: groupBBox.y },
            { x: groupBBox.x + groupBBox.width, y: groupBBox.y },
            { x: groupBBox.x + groupBBox.width, y: groupBBox.y + groupBBox.height },
            { x: groupBBox.x, y: groupBBox.y + groupBBox.height },
          ];
          // Zero means the box is too small to wear handles; the dashed outline
          // above is then the whole affordance.
          for (const gh of handleR > 0 ? groupHandles : []) {
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 1.5 * inv;
            ctx.beginPath();
            ctx.arc(gh.x, gh.y, handleR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }

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
      // Timing wraps the render rather than living inside it, so the measured
      // path is exactly what ships when the flag is off.
      const render = showDragPerfDebug
        ? () => {
            const t0 = performance.now();
            doRender();
            const samples = renderPerfSamplesRef.current;
            samples.push(performance.now() - t0);
            if (samples.length > 120) samples.shift();
          }
        : doRender;
      renderRef.current = render;
      render();
    }, [imageInfo, resizeSettings, previewDims.height, previewDims.width, artboardWidth, artboardHeight, designTransform, designs, selectedDesignId, selectedDesignIds, drawSingleDesign, overlappingDesigns, previewBgColor, zoomDpiTier, isMobile, interactionEpoch]);

    const drawImageWithResizePreview = (ctx: CanvasRenderingContext2D, canvasWidth: number, canvasHeight: number) => {
      if (!imageInfo) return;

      const t = transformRef.current;
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
      // The HD detail overlay canvas (when active) draws the selected image on
      // top with `imageRendering: pixelated` and an `inset(6px)` clip that
      // keeps the handles visible. Drawing the whole image on the main canvas
      // as well caused a doubled/ghost seam (two differently-filtered rasters
      // stacked), but skipping it entirely left the 6px clip ring EMPTY — the
      // selected design looked cropped. Compromise: when the overlay is
      // active, clip the main-canvas draw to just that perimeter ring so the
      // overlay exclusively owns the interior and the edge artwork is intact.
      {
        ctx.save();
        if (showHighQualityDetail) {
          // 6 CSS px (the overlay's clip inset) converted to canvas pixels.
          const insetPx = 6 * (canvasWidth / Math.max(1, previewDims.width));
          ctx.beginPath();
          ctx.rect(-rect.width / 2, -rect.height / 2, rect.width, rect.height);
          ctx.rect(
            -rect.width / 2 + insetPx,
            -rect.height / 2 + insetPx,
            Math.max(0, rect.width - insetPx * 2),
            Math.max(0, rect.height - insetPx * 2),
          );
          ctx.clip('evenodd');
        }
        const drawSrc = selDesign?.alphaThresholded
          ? imageInfo.image
          : getPreviewDrawSource(imageInfo.image, rect.width, rect.height);
        ctx.drawImage(drawSrc, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
        ctx.restore();
      }
      const overlayCanvas = createSpotOverlayCanvasRef.current?.(imageInfo.image) ?? null;
      if (overlayCanvas) {
        ctx.globalAlpha = spotPulseRef.current * 0.7;
        ctx.drawImage(overlayCanvas, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
        ctx.globalAlpha = 1;
      }
      const selLabel = selDesign ? getDesignLabel(selDesign) : null;
      if (selDesign && selLabel) {
        ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
        const artH = selDesign.heightInches * t.s;
        if (artH > 0) {
          drawPrintLabel(ctx, selLabel, rect.height / artH, labelReadsUpsideDown(t.rotation));
        }
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
      // Keep handles usable at normal sizes, but cap them proportionally when
      // a very tall sheet makes the selected design tiny on screen.
      const canvasBuf = canvasRef.current;
      const dims = previewDimsRef.current;
      const actualDpi = canvasBuf && dims.width > 0
        ? canvasBuf.width / dims.width
        : dpiScaleRef.current;
      const zHandles = Math.max(ZOOM_MIN_ABSOLUTE, zoomRef.current);
      const bufferPerCss = actualDpi / zHandles;
      const designMin = Math.min(rect.width, rect.height);

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

      // All four corners are the same size; the bottom-right no longer doubles on touch.
      // Zero means the design is too small to wear handles without being buried by
      // them, and the outline drawn above is the whole selection affordance.
      const handleSize = getHandleHalfCssPx(designMin / bufferPerCss, zHandles, isMobile, 0.25) * bufferPerCss;
      const r = Math.max(1, handleSize * 0.30);
      const borderW = 1.5 * inv;
      for (const p of handleSize > 0 ? pts : []) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rad);
        ctx.shadowColor = 'rgba(0,0,0,0.25)';
        ctx.shadowBlur = 3 * inv;
        ctx.shadowOffsetY = 1 * inv;
        ctx.beginPath();
        ctx.roundRect(-handleSize, -handleSize, handleSize * 2, handleSize * 2, r);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = borderW;
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();
    };

    // ---- Rulers: inch tick strips pinned to the top/left edges of the ----
    // ---- preview area. Overlay-only: they track the sheet's on-screen ----
    // ---- rect whenever something wakes them, and never touch          ----
    // ---- interaction, render, or export code.                         ----
    useEffect(() => {
      const RULER = 18;
      let raf = 0;

      const pickSteps = (ppi: number): { minor: number; label: number } => {
        const candidates = [0.125, 0.25, 0.5, 1, 2, 5, 10, 20];
        const minor = candidates.find(s => s * ppi >= 7) ?? 20;
        const label = candidates.find(s => s >= minor && s * ppi >= 26) ?? 20;
        return { minor, label };
      };

      const drawStrip = (
        canvas: HTMLCanvasElement,
        axis: 'x' | 'y',
        stripLen: number,          // CSS px length of the strip
        contentStart: number,      // sheet edge position in area coords
        contentLen: number,        // sheet length on screen
        inches: number,            // sheet length in inches
      ) => {
        const dpr = window.devicePixelRatio || 1;
        const w = axis === 'x' ? stripLen : RULER;
        const h = axis === 'x' ? RULER : stripLen;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(h * dpr);
        }
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(249,250,251,0.94)';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#d1d5db';
        ctx.beginPath();
        if (axis === 'x') { ctx.moveTo(0, RULER - 0.5); ctx.lineTo(w, RULER - 0.5); }
        else { ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, h); }
        ctx.stroke();
        if (contentLen <= 0 || inches <= 0) return;

        const ppi = contentLen / inches;
        const { minor, label } = pickSteps(ppi);
        // Ruler strip starts at RULER px inside the area, so shift coords.
        const origin = contentStart - RULER;
        ctx.fillStyle = '#4b5563';
        ctx.strokeStyle = '#9ca3af';
        ctx.font = '8px system-ui, sans-serif';
        ctx.textBaseline = 'top';

        // One path for every tick on the strip, stroked once at the end.
        //
        // Each tick used to open and stroke its own path. `pickSteps` aims for a tick every
        // ~7px, so a 1400px-wide sheet is ~200 separate `stroke()` calls on the horizontal
        // strip alone, repeated on the vertical, and repeated again on every frame of a zoom
        // or pan because the signature changes each frame. They all share one colour and one
        // width, so the split bought nothing. `fillText` does not disturb the current path,
        // so labels can still be drawn inside the loop.
        ctx.beginPath();

        const drawTick = (inch: number, isLabel: boolean, forceLabelText?: string) => {
          const pos = origin + inch * ppi;
          if (pos < -20 || pos > stripLen + 20) return;
          const len = isLabel ? 7 : inch % (minor * 2) === 0 ? 5 : 3.5;
          if (axis === 'x') {
            const px = Math.round(pos) + 0.5;
            ctx.moveTo(px, RULER - 1);
            ctx.lineTo(px, RULER - 1 - len);
          } else {
            const py = Math.round(pos) + 0.5;
            ctx.moveTo(RULER - 1, py);
            ctx.lineTo(RULER - 1 - len, py);
          }
          if (isLabel) {
            const text = forceLabelText ?? String(Math.round(inch * 100) / 100);
            if (axis === 'x') {
              ctx.textAlign = inch >= inches ? 'right' : 'left';
              ctx.fillText(text, Math.round(pos) + (inch >= inches ? -2 : 2), 2);
            } else {
              ctx.textAlign = 'left';
              const ty = Math.round(pos) + (inch >= inches ? -9 : 2);
              ctx.fillText(text, 1, ty);
            }
          }
        };

        for (let inch = 0; inch < inches; inch += minor) {
          const isLabel = Math.abs(inch / label - Math.round(inch / label)) < 1e-6
            // Leave room for the exact far-edge label (e.g. "24.5").
            && (inches - inch) * ppi > 22;
          drawTick(inch, isLabel);
        }
        // Always mark the far edge with its exact value (e.g. 24.5).
        drawTick(inches, true);
        ctx.stroke();
      };

      const measure = () => {
        const area = canvasAreaRef.current;
        const sheet = canvasRef.current;
        if (!area || !sheet) return null;
        const areaRect = area.getBoundingClientRect();
        const rect = sheet.getBoundingClientRect();
        if (areaRect.width <= 0 || rect.width <= 0) return null;
        // rect includes the 3px white border on each side, scaled by zoom.
        const dims = previewDimsRef.current;
        const scale = dims.width > 0 ? rect.width / (dims.width + 6) : 1;
        const contentLeft = rect.left - areaRect.left + 3 * scale;
        const contentTop = rect.top - areaRect.top + 3 * scale;
        const contentW = rect.width - 6 * scale;
        const contentH = rect.height - 6 * scale;
        const sig = [
          areaRect.width, areaRect.height, contentLeft, contentTop, contentW, contentH,
          artboardWidth, artboardHeight, window.devicePixelRatio || 1,
        ].map(v => Math.round(v * 10) / 10).join('|');
        return { sig, areaRect, contentLeft, contentTop, contentW, contentH };
      };

      const draw = (m: NonNullable<ReturnType<typeof measure>>) => {
        const topC = topRulerRef.current;
        const leftC = leftRulerRef.current;
        if (!topC || !leftC) return;
        rulerSigRef.current = m.sig;
        drawStrip(topC, 'x', Math.max(1, m.areaRect.width - RULER), m.contentLeft, m.contentW, artboardWidth);
        drawStrip(leftC, 'y', Math.max(1, m.areaRect.height - RULER), m.contentTop, m.contentH, artboardHeight);
      };

      // The loop used to run for the lifetime of the editor, reading two
      // bounding rects every frame and almost always discarding the result.
      // That forced a layout on every frame even while nothing moved, and it
      // cost the most during a group drag, where React is mutating the DOM
      // each frame so every forced layout is a fresh one.
      //
      // Now it sleeps. Anything that can move the sheet wakes it, and it keeps
      // ticking until the geometry has been still for long enough to have
      // ridden out a CSS transition, which is the one kind of movement that
      // arrives without an event per frame.
      const STILL_FRAMES = 24;
      let still = 0;

      const tick = () => {
        const m = measure();
        if (m && m.sig !== rulerSigRef.current) {
          draw(m);
          still = 0;
        } else {
          still++;
        }
        if (still > STILL_FRAMES) { raf = 0; return; }
        raf = requestAnimationFrame(tick);
      };

      const wake = () => {
        still = 0;
        if (raf) return;
        raf = requestAnimationFrame(tick);
      };
      rulerWakeRef.current = wake;

      // Backstop for movement with no wake trigger at all — an ancestor
      // reflow that shifts the area without resizing it, say. Two reads a
      // second instead of sixty, and it only wakes the loop if something
      // really did move.
      const safety = window.setInterval(() => {
        if (raf) return;
        const m = measure();
        if (m && m.sig !== rulerSigRef.current) wake();
      }, 500);

      const ro = new ResizeObserver(wake);
      if (canvasAreaRef.current) ro.observe(canvasAreaRef.current);
      if (canvasRef.current) ro.observe(canvasRef.current);
      window.addEventListener('resize', wake);
      window.addEventListener('orientationchange', wake);
      const areaEl = canvasAreaRef.current;
      areaEl?.addEventListener('transitionend', wake);

      wake();
      return () => {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        window.clearInterval(safety);
        ro.disconnect();
        window.removeEventListener('resize', wake);
        window.removeEventListener('orientationchange', wake);
        areaEl?.removeEventListener('transitionend', wake);
        rulerWakeRef.current = null;
        rulerSigRef.current = '';
      };
    }, [artboardWidth, artboardHeight]);

    // Pan, zoom and sheet-size changes move the sheet without resizing
    // anything the observers watch, so they wake the rulers explicitly.
    useEffect(() => {
      rulerWakeRef.current?.();
    }, [panX, panY, zoom, previewDims.width, previewDims.height, isMobile]);

    const swatchFill = (color: string) =>
      color === 'transparent'
        ? 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 6px 6px'
        : color;

    const swatchButton = (color: string, label: string, size: number, onPick?: () => void) => (
      <button
        key={color}
        onClick={() => { setPreviewBgColor(color); onPick?.(); }}
        className={`rounded-full border-2 transition-all ${previewBgColor === color ? 'border-cyan-400 scale-110' : 'border-gray-300 hover:border-gray-500'}`}
        title={label}
        /* These are bare coloured circles with no text in them, so the name and
           the selected state have to come from here. */
        aria-label={`Preview on ${label}`}
        aria-pressed={previewBgColor === color}
        style={{ width: size, height: size, background: swatchFill(color) }}
      />
    );

    const backdropSwatches = (
      <div className={`flex items-center ${isMobile ? 'gap-1.5' : 'gap-1'} flex-shrink-0`}>
        {BACKDROP_COLORS.map(({ color, label }) => swatchButton(color, label, isMobile ? 22 : 18))}
      </div>
    );

    const currentBackdrop =
      BACKDROP_COLORS.find(c => c.color === previewBgColor) ?? BACKDROP_COLORS[0];

    /**
     * The phone's version: one button wearing the current colour, opening the five.
     *
     * The view bar has 64px to spare beside the zoom group and the row of five needs 138,
     * so inline was a choice between dropping colours and shrinking the targets below the
     * point you can reliably hit them. A single swatch costs 44 and gives up neither.
     *
     * The menu is `position: fixed` in a body portal rather than absolutely positioned
     * here, because its anchor lives inside the view bar's horizontal scroll container and
     * anything positioned within that gets clipped by it.
     */
    const backdropSwatchCompact = (
      <>
        <button
          ref={backdropButtonRef}
          type="button"
          onClick={() => {
            const r = backdropButtonRef.current?.getBoundingClientRect();
            if (r) setBackdropMenuAt({ top: Math.round(r.bottom + 6), right: Math.round(window.innerWidth - r.right) });
            setBackdropMenuOpen(v => !v);
          }}
          className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border transition-colors coarse:h-11 coarse:w-11 ${backdropMenuOpen ? 'border-cyan-500 bg-cyan-50' : 'border-gray-300 bg-white hover:bg-gray-50'}`}
          title={`Preview on ${currentBackdrop.label}`}
          aria-label={`Preview on ${currentBackdrop.label}`}
          aria-expanded={backdropMenuOpen}
          data-testid="backdrop-swatch-button"
        >
          <span
            className="h-5 w-5 rounded-full border-2 border-gray-400"
            style={{ background: swatchFill(currentBackdrop.color) }}
          />
        </button>
        {backdropMenuOpen && backdropMenuAt && createPortal(
          <>
            {/* Swallows the tap that dismisses, so choosing "somewhere else" does
                not also press whatever was underneath. */}
            <div className="fixed inset-0 z-[60]" onClick={() => setBackdropMenuOpen(false)} />
            <div
              className="fixed z-[61] flex items-center gap-2.5 rounded-lg border border-gray-300 bg-white p-2.5 shadow-xl"
              style={{ top: backdropMenuAt.top, right: backdropMenuAt.right }}
              data-testid="backdrop-swatch-menu"
            >
              {BACKDROP_COLORS.map(({ color, label }) =>
                swatchButton(color, label, 28, () => setBackdropMenuOpen(false)))}
            </div>
          </>,
          document.body,
        )}
      </>
    );

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
          data-wand-active={wandDeleteActive ? "true" : "false"}
          className={`preview-canvas-area flex-1 min-h-0 flex ${isMobile ? 'items-start justify-start' : 'items-center justify-center'} bg-gray-100 relative overflow-hidden cursor-default`}
          style={{
            userSelect: 'none',
            touchAction: 'none',
            overscrollBehavior: 'none',
            // The rulers are absolutely positioned against the border box, so
            // padding here is what keeps the sheet clear of them.
            ...(isMobile
              ? {
                  paddingTop: MOBILE_CANVAS_PAD_TOP,
                  paddingLeft: MOBILE_CANVAS_PAD_LEFT,
                  paddingRight: 0,
                  paddingBottom: MOBILE_CANVAS_PAD_BOTTOM,
                }
              : { padding: DESKTOP_CANVAS_PAD }),
          }}
        >
          {previewDims.width > 0 && previewDims.height > 0 ? (
          <>
          {/* Inch rulers pinned to the top/left edges (overlay only) */}
          <canvas ref={topRulerRef} className="absolute z-30 pointer-events-none" style={{ left: RULER_GUTTER_PX, top: 0 }} />
          <canvas ref={leftRulerRef} className="absolute z-30 pointer-events-none" style={{ left: 0, top: RULER_GUTTER_PX }} />
          <div className="absolute z-30 pointer-events-none border-b border-r border-gray-300" style={{ left: 0, top: 0, width: RULER_GUTTER_PX, height: RULER_GUTTER_PX, background: 'rgba(249,250,251,0.94)' }} />
          <div className="relative" style={{ paddingBottom: 16, paddingRight: 24 }}>
            <div 
              ref={containerRef}
              className="relative flex items-center justify-center"
              style={{ 
                width: previewDims.width,
                height: previewDims.height,
                backgroundColor: 'transparent',
                marginLeft: isMobile ? 6 : 0,
              }}
            >
              <div
                className="relative flex-shrink-0"
                style={{ 
                  width: previewDims.width + 6,
                  height: previewDims.height + 6,
                  transform: `scale(${zoom}) translate(${panX}px, ${panY}px)`,
                  // Anchored views scale away from the top edge so the sheet
                  // stays pinned there and grows downward; centred views scale
                  // about the middle as before.
                  transformOrigin: isMobile ? 'top center' : 'center',
                  willChange: 'transform',
                  transition: isMobile || isWheelZoomingRef.current || isPanningRef.current || suppressTransitionRef.current || activeScrollAxis ? 'none' : 'transform 0.15s ease-out',
                }}
              >
                <canvas
                  ref={canvasRef}
                  className="absolute z-10 block"
                  style={{
                    left: PREVIEW_CANVAS_INSET,
                    top: PREVIEW_CANVAS_INSET,
                    width: previewDims.width,
                    height: previewDims.height,
                    border: `${PREVIEW_CANVAS_BORDER}px solid #ffffff`,
                    outline: '2px solid #000000',
                    boxSizing: 'content-box',
                    pointerEvents: 'none',
                  }}
                />
                {showHighQualityDetail && selectedDetailDesign && (
                  (() => {
                    const detailRect = computeLayerRect(
                      selectedDetailImage?.naturalWidth || selectedDetailImage?.width || 1,
                      selectedDetailImage?.naturalHeight || selectedDetailImage?.height || 1,
                      selectedDetailDesign.transform,
                      previewDims.width,
                      previewDims.height,
                      artboardWidth,
                      artboardHeight,
                      selectedDetailDesign.widthInches,
                      selectedDetailDesign.heightInches,
                    );
                    return (
                      <canvas
                        key={`${selectedDetailDesign.id}:${selectedDetailImage?.src || ''}`}
                        ref={detailCanvasRef}
                        aria-hidden="true"
                        className="absolute z-20 pointer-events-none block"
                        style={{
                          left: PREVIEW_SURFACE_ORIGIN + detailRect.x,
                          top: PREVIEW_SURFACE_ORIGIN + detailRect.y,
                          width: detailRect.width,
                          height: detailRect.height,
                          transformOrigin: 'center',
                          transform: `rotate(${selectedDetailDesign.transform.rotation}deg) scale(${selectedDetailDesign.transform.flipX ? -1 : 1}, ${selectedDetailDesign.transform.flipY ? -1 : 1})`,
                          imageRendering: 'pixelated',
                          // Leave the edge chrome exposed so the existing
                          // resize/rotate handles remain visible above the
                          // focused pixel-preserving layer.
                          clipPath: 'inset(6px)',
                        }}
                      />
                    );
                  })()
                )}
              </div>
              
              {!imageInfo && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-gray-300 text-sm opacity-50">Upload a design</p>
                </div>
              )}


            </div>
            {showFullSheetDimensions && (
              <>
                <div className="absolute bottom-0 left-0 right-3.5 flex justify-center pointer-events-none">
                  <span className={`text-gray-700 font-semibold tracking-wide ${lang === 'en' ? 'text-[11px]' : 'text-[10px]'}`} style={{ transform: 'translateY(2px)' }}>{formatLength(artboardWidth, lang)}{lang === "en" ? '"' : ""}</span>
                </div>
                <div className="absolute right-1 top-0 bottom-4 flex items-center pointer-events-none">
                  <span className={`text-gray-700 font-semibold tracking-wide ${lang === 'en' ? 'text-[11px]' : 'text-[10px]'}`} style={{ writingMode: 'vertical-rl' }}>{formatLength(artboardHeight, lang)}{lang === "en" ? '"' : ""}</span>
                </div>
              </>
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
          </>
          ) : null}
        </div>

        {/* Bottom toolbar */}
        {(bottomToolbarContainer ? createPortal(
        /* No background, border or vertical padding when portalled: the host
           supplies them, and doubling the padding of a bar this tall comes
           straight off the canvas. */
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${isMobile ? 'justify-start overflow-x-auto [scrollbar-width:thin]' : 'justify-between'}`}>
              {/* Unpadded on the phone: the host bar already has its own, and
                  with Focus present this row is within a few pixels of the
                  390px edge — see the width note on `backdropSwatchContainer`. */}
              <div className={`flex items-center gap-1.5 min-w-0 ${isMobile ? 'flex-shrink-0' : 'flex-1 px-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]'}`}>
                {selectedDesignId && designTransform && (
                  <>
                    {!isMobile && (
                      <>
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
                          <RotationBadge
                            title={t("preview.editRotation")}
                            onEdit={(r) => {
                              setRotationInput(String(Math.round(r)));
                              setEditingRotation(true);
                            }}
                          />
                        )}
                        <div className="w-px h-3.5 bg-gray-300" />
                      </>
                    )}
                  </>
                )}
                {isMobile && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      resetView();
                    }}
                    /* Labelled "Reset" (asked for explicitly). The width the
                       two history labels once fought over is free now that
                       Undo/Redo are icon pills, so this is the one word in
                       the cluster — and the action most worth naming. */
                    className="min-h-[40px] h-10 flex-shrink-0 px-2.5 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 text-gray-700 whitespace-nowrap text-[12px] font-semibold flex items-center justify-center"
                    title={t("preview.resetView")}
                    aria-label={t("preview.resetView")}
                  >
                    <RotateCcw className="h-4 w-4 mr-1 flex-shrink-0" />
                    {t("preview.reset")}
                  </Button>
                )}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-[44px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-10 w-11 sm:h-8 sm:w-9 coarse:!h-10 coarse:!w-11 coarse:!min-w-[44px] p-0 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 flex items-center justify-center"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      const newZ = Math.max(zoom / ZOOM_BUTTON_FACTOR, minZoomRef.current);
                      const clamped = clampPanValue(panX, panY, newZ);
                      commitZoomNow(newZ);
                      queuePanStateCommit(clamped.x, clamped.y);
                      if (canvasAreaRef.current) {
                        const el = canvasAreaRef.current;
                        el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                      }
                    }}
                    title={t("preview.zoomOut")}
                  >
                    <ZoomOut className="h-5 w-5 sm:h-4 sm:w-4 coarse:!h-5 coarse:!w-5 text-gray-700" />
                  </Button>
                  {/* Hidden on a 320px phone, where the bar cannot hold Undo, Redo,
                      four 44px controls, the backdrop picker and a readout — and of
                      those, a number you can only read is the one whose absence costs
                      least. Wider phones keep it. It doubles as the reset button:
                      tapping the percentage snaps the view back to fit. */}
                  <button
                    type="button"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      resetView();
                    }}
                    className="h-10 sm:h-8 coarse:!h-10 min-w-[46px] rounded-md border border-gray-300 bg-white px-1.5 text-[12px] font-semibold tabular-nums text-gray-700 shadow-sm hover:bg-gray-100 max-[359px]:hidden"
                    title={t("preview.resetView")}
                    aria-label={t("preview.resetView")}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-w-[44px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-10 w-11 sm:h-8 sm:w-9 coarse:!h-10 coarse:!w-11 coarse:!min-w-[44px] p-0 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 flex items-center justify-center"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      const newZ = Math.min(zoom * ZOOM_BUTTON_FACTOR, zoomMax);
                      const clamped = clampPanValue(panX, panY, newZ);
                      commitZoomNow(newZ);
                      queuePanStateCommit(clamped.x, clamped.y);
                      if (canvasAreaRef.current) {
                        const el = canvasAreaRef.current;
                        el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                      }
                    }}
                    title={t("preview.zoomIn")}
                  >
                    <ZoomIn className="h-5 w-5 sm:h-4 sm:w-4 coarse:!h-5 coarse:!w-5 text-gray-700" />
                  </Button>
                </div>
                <div className="w-px h-3.5 bg-gray-300" />
                {!isMobile && (
                  <Button 
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectionZoomActive(prev => !prev)}
                     className={`h-7 px-2 hover:bg-gray-200 rounded whitespace-nowrap ${lang !== 'en' ? 'text-[11px]' : 'text-[12px]'} ${selectionZoomActive ? 'bg-cyan-500/20 text-cyan-600' : 'text-gray-700'} flex items-center font-medium`}
                    title={t("preview.selectionZoom")}
                  >
                    <ScanSearch className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                    {t("preview.selectToZoom")}
                  </Button>
                )}
                {!isMobile && (
                  <Button 
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      resetView();
                    }}
                     className={`h-8 coarse:!h-10 px-2.5 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 text-gray-700 whitespace-nowrap ${lang !== 'en' ? 'text-[11px]' : 'text-[12px]'} font-semibold`}
                    title={t("preview.resetView")}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1 flex-shrink-0" />
                    {t("preview.reset")}
                  </Button>
                )}
                {selectedDesignId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={zoomToSelected}
                     className={`${isMobile ? 'min-h-[40px] h-10 px-2 flex-shrink-0 justify-center rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 font-semibold' : 'h-7 px-2 rounded hover:bg-gray-200 font-medium'} text-gray-700 whitespace-nowrap ${lang !== 'en' ? 'text-[11px]' : 'text-[12px]'} flex items-center`}
                    title={t("preview.focusTitle")}
                  >
                    <Focus className={`${isMobile ? 'h-4 w-4 mr-1' : 'h-2.5 w-2.5 mr-0.5'} flex-shrink-0`} />
                    {t("preview.focus")}
                  </Button>
                )}
              </div>

              {/* No swatches here. The only caller that portals this toolbar
                  is the phone, and it gives them a home of their own — see
                  `backdropSwatchContainer`. They are absent, rather than
                  conditional on that container existing, because the container
                  is a sheet that spends most of its life closed and the
                  swatches would flit back into this row every time it shut. */}
            </div>,
            bottomToolbarContainer
          ) : (
            <div className={`flex-shrink-0 flex items-center gap-2 bg-gray-100 border-t border-gray-200 px-2 py-1.5 lg:px-3 lg:py-1.5 min-w-0 ${isMobile ? 'justify-start overflow-x-auto [scrollbar-width:thin]' : 'justify-between'}`}>
              <div className={`flex items-center gap-1.5 min-w-0 px-1 ${isMobile ? 'flex-shrink-0' : 'flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]'}`}>
                {selectedDesignId && designTransform && (
                  <>
                    {!isMobile && (
                      <>
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
                          <RotationBadge
                            className="text-[11px] text-gray-600 font-medium cursor-pointer hover:text-gray-900 tabular-nums"
                            title={t("preview.editRotation")}
                            onEdit={(r) => {
                              setRotationInput(String(Math.round(r)));
                              setEditingRotation(true);
                            }}
                          />
                        )}
                        <div className="w-px h-3.5 bg-gray-300" />
                      </>
                    )}
                  </>
                )}
                {isMobile && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={resetView}
                    className="min-w-[44px] min-h-[40px] h-10 px-2.5 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 text-gray-700 whitespace-nowrap text-[12px] font-semibold flex items-center justify-center"
                    title={t("preview.resetView")}
                  >
                    <RotateCcw className="h-4 w-4 mr-1 flex-shrink-0" />
                    {t("preview.reset")}
                  </Button>
                )}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button variant="ghost" size="sm" className="min-w-[44px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-10 w-11 sm:h-8 sm:w-9 coarse:!h-10 coarse:!w-11 coarse:!min-w-[44px] p-0 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 flex items-center justify-center" onClick={() => {
                    if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                    const newZ = Math.max(zoom / ZOOM_BUTTON_FACTOR, minZoomRef.current);
                    const clamped = clampPanValue(panX, panY, newZ);
                    commitZoomNow(newZ);
                    queuePanStateCommit(clamped.x, clamped.y);
                    if (canvasAreaRef.current) {
                      const el = canvasAreaRef.current;
                      el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                    }
                  }} title={t("preview.zoomOut")}>
                    <ZoomOut className="h-5 w-5 sm:h-4 sm:w-4 coarse:!h-5 coarse:!w-5 text-gray-700" />
                  </Button>
                  {/* The percentage readout doubles as the reset button: tapping
                      it snaps the view back to fit, which is much easier to hit
                      than a separate tiny Reset. */}
                  <button
                    type="button"
                    onClick={() => {
                      if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                      resetView();
                    }}
                    className="h-10 sm:h-8 coarse:!h-10 min-w-[46px] rounded-md border border-gray-300 bg-white px-1.5 text-[12px] font-semibold tabular-nums text-gray-700 shadow-sm hover:bg-gray-100"
                    title={t("preview.resetView")}
                    aria-label={t("preview.resetView")}
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                  <Button variant="ghost" size="sm" className="min-w-[44px] min-h-[40px] sm:min-w-0 sm:min-h-0 h-10 w-11 sm:h-8 sm:w-9 coarse:!h-10 coarse:!w-11 coarse:!min-w-[44px] p-0 rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 flex items-center justify-center" onClick={() => {
                    if (wandDeleteActiveRef.current) onWandDeactivateRef.current?.();
                    const newZ = Math.min(zoom * ZOOM_BUTTON_FACTOR, zoomMax);
                    const clamped = clampPanValue(panX, panY, newZ);
                    commitZoomNow(newZ);
                    queuePanStateCommit(clamped.x, clamped.y);
                    if (canvasAreaRef.current) {
                      const el = canvasAreaRef.current;
                      el.style.cursor = (newZ * previewDims.width > el.clientWidth * 1.05 && !moveMode) ? 'grab' : 'default';
                    }
                  }} title={t("preview.zoomIn")}>
                    <ZoomIn className="h-5 w-5 sm:h-4 sm:w-4 coarse:!h-5 coarse:!w-5 text-gray-700" />
                  </Button>
                </div>
                <div className="w-px h-3.5 bg-gray-300" />
                {!isMobile && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectionZoomActive(prev => !prev)}
                    className={`h-6 px-1.5 hover:bg-gray-200 rounded whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} ${selectionZoomActive ? 'bg-cyan-500/20 text-cyan-400' : 'text-gray-600'} flex items-center`}
                    title={t("preview.selectionZoom")}
                  >
                    <ScanSearch className="h-2.5 w-2.5 mr-0.5 flex-shrink-0" />
                    {t("preview.selectToZoom")}
                  </Button>
                )}
                {!isMobile && (
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
                )}
                {selectedDesignId && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={zoomToSelected}
                    className={`${isMobile ? 'min-h-[40px] h-10 px-2 flex-shrink-0 justify-center rounded-md border border-gray-300 bg-white shadow-sm hover:bg-gray-100 font-semibold' : 'h-6 px-1.5 rounded hover:bg-gray-200'} text-gray-600 whitespace-nowrap ${lang !== 'en' ? 'text-[10px]' : 'text-[11px]'} flex items-center`}
                    title={t("preview.focusTitle")}
                  >
                    <Focus className={`${isMobile ? 'h-4 w-4 mr-1' : 'h-2.5 w-2.5 mr-0.5'} flex-shrink-0`} />
                    {t("preview.focus")}
                  </Button>
                )}
              </div>
              {backdropSwatches}
            </div>
          ))}

        {backdropSwatchContainer ? createPortal(backdropSwatchCompact, backdropSwatchContainer) : null}

        {/* Keyboard shortcut hints */}
        <div className="hidden lg:flex touchonly:!hidden flex-shrink-0 flex-wrap items-center justify-center gap-x-4 bg-gray-100/90 border-t border-gray-200/80 px-3 py-0.5 text-[9px] text-gray-600">
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

// Wrap in `React.memo` so unrelated view re-renders (mode toggles,
// halftone menu open/close, etc.) skip re-rendering this ~4000-line
// canvas component when all of its props are shallow-equal. The view
// carefully stabilizes callback props via `useCallback` at the call site
// so memo's shallow-compare has a real chance to short-circuit.
const MemoizedPreviewSection = memo(PreviewSection);
export default MemoizedPreviewSection;
