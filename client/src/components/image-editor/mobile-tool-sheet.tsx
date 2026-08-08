import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { getShellKeyboardInset, subscribeShellKeyboardInset } from "@/hooks/use-keyboard-safe-focus";

export type SheetDetent = "peek" | "half" | "full";

/**
 * Approximates a spring at stiffness 300 / damping 30 — a fast rise with a
 * small settle — without pulling in an animation library. `height` is the
 * animated property on purpose: a `transform` on this element would put the
 * W/H size fields inside a transformed subtree, and `image-editor-view`
 * already drives the controls/preview slide with a `translateX` on a shared
 * ancestor. A second transform there is a known sharp edge for focus and the
 * software keyboard, so the sheet grows instead of sliding.
 */
const SPRING = "cubic-bezier(0.16, 1.06, 0.28, 1)";
const SPRING_MS = 300;

/**
 * Handle strip.
 *
 * The strip is itself a control — tapping it advances the detent — so it is a
 * 44px target rather than the 20px the grip alone would need. It also clips
 * (the sheet is `overflow-hidden`), so a close button placed in it would
 * otherwise lose its top and bottom thirds. Height here is cheap: the sheet
 * overlays the canvas, so nothing inside it costs artwork.
 */
const HANDLE_H = 44;

/** Used until the peek row has been measured. */
const FALLBACK_PEEK_H = 112;

/** Drag has to beat this before the release counts as a drag rather than a tap. */
const TAP_SLOP_PX = 5;

/** Below this, a visual-viewport shrink is browser chrome, not a keyboard. Matches `use-keyboard-safe-focus`. */
const MIN_KEYBOARD_INSET_PX = 120;

/** Gap left between the sheet's bottom edge and the top of the keyboard. */
const KEYBOARD_GAP_PX = 8;

/**
 * Canvas that stays uncovered however tall the sheet's content wants to be.
 *
 * The default suits a sheet you operate *while watching the artwork* — the
 * sizing controls are useless if you cannot see what they are resizing. A sheet
 * that is only a list has no such tie to the canvas and can ask for a smaller
 * strip; see `minCanvasStripPx`.
 */
const MIN_CANVAS_STRIP_PX = 56;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface MobileToolSheetProps {
  /** The sheet exists only while this is true — nothing selected means no sheet at all. */
  open: boolean;
  /** Accessible name for the drag handle. */
  handleLabel: string;
  /** Distinguishes the two sheets in the DOM. */
  testId?: string;
  /**
   * Canvas this sheet promises to leave uncovered, overriding
   * `MIN_CANVAS_STRIP_PX`.
   *
   * Worth setting for a sheet whose content is unrelated to what the canvas is
   * showing. A phone on its side leaves the canvas box about 184px tall, and
   * reserving 56 of those for a strip of artwork nobody is looking at left the
   * layers list a 57px window onto 274px of content — the panel opened without
   * a single layer in view.
   */
  minCanvasStripPx?: number;
  /**
   * How the three detents are sized.
   *
   * `content` measures the peek detent from the content itself, which is right
   * for the contextual tool sheet: peek is exactly as tall as the sizing row it
   * has to show. A summoned panel holding a list has no such natural height —
   * measuring it would put peek at the ceiling and collapse all three detents
   * onto one number — so `fill` derives them from the available height instead.
   */
  sizing?: "content" | "fill";
  /** Detent the sheet opens at. */
  initialDetent?: SheetDetent;
  /**
   * Collapses the sheet to `peek` whenever this number changes.
   *
   * A signal rather than a controlled `detent` prop because the detent is
   * genuinely owned here — the drag handler writes it on every frame — and
   * lifting it would make the parent responsible for driving an animation it
   * knows nothing about. All the parent needs to say is "get out of the way
   * now", which is what a bumped counter says.
   *
   * The caller uses it when a tool has done something the customer needs to
   * see on the artwork: the sheet drops to its strip and the canvas comes back.
   */
  collapseSignal?: number;
  /**
   * Interactive slot at the left of the handle strip, for a close button.
   * Unlike `handleAccessory` this one receives pointer events, so anything put
   * here must stop propagation or it will also start a drag.
   */
  handleLeading?: ReactNode;
  /**
   * Status pinned to the right of the grip, visible at every detent.
   *
   * The handle strip is a centred 36px grip in a full-width row, so most of it
   * is dead space, and a read-only badge parked there costs no height and does
   * not compete with the sizing row for the width that metric units need. It
   * must stay non-interactive: a drag begun anywhere on this strip has to reach
   * the handle beneath it.
   */
  handleAccessory?: ReactNode;
  /**
   * Rendered for the detent currently on screen. Content above the live detent
   * is not rendered rather than merely hidden, so a collapsed sheet cannot hold
   * a control that scrolling could still reach.
   */
  children: (level: SheetDetent) => ReactNode;
}

/**
 * Contextual bottom sheet over the mobile canvas.
 *
 * Overlays rather than occupies: the canvas measures itself from its container
 * and any layout height taken here would shrink it, which is the whole reason
 * the two-column phone layout was replaced.
 */
export default function MobileToolSheet({
  open,
  handleLabel,
  testId = "mobile-tool-sheet",
  sizing = "content",
  initialDetent = "peek",
  collapseSignal = 0,
  minCanvasStripPx = MIN_CANVAS_STRIP_PX,
  handleLeading,
  handleAccessory,
  children,
}: MobileToolSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [detent, setDetent] = useState<SheetDetent>(initialDetent);
  const [dragH, setDragH] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [peekH, setPeekH] = useState(FALLBACK_PEEK_H);
  const [containerH, setContainerH] = useState(0);
  const [lift, setLift] = useState(0);
  const dragRef = useRef<{ startY: number; startH: number; moved: boolean } | null>(null);
  const frameRef = useRef(0);
  const handleH = HANDLE_H;

  // A fresh selection always starts at peek, and grows into it from nothing so
  // the sheet reads as arriving rather than appearing.
  useEffect(() => {
    if (!open) return;
    setDetent(initialDetent);
    setDragH(null);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = requestAnimationFrame(() => setExpanded(true));
    });
    return () => {
      cancelAnimationFrame(frameRef.current);
      setExpanded(false);
    };
  }, [open, initialDetent]);

  // Skips the first run: the initial value is a starting point, not a request
  // to collapse, and honouring it would override `initialDetent`.
  const firstCollapse = useRef(true);
  useEffect(() => {
    if (firstCollapse.current) {
      firstCollapse.current = false;
      return;
    }
    setDetent("peek");
    setDragH(null);
  }, [collapseSignal]);

  // The sheet's own containing block gives the half/full extents.
  useLayoutEffect(() => {
    const parent = sheetRef.current?.parentElement;
    if (!parent) return;
    const read = () => setContainerH(parent.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [open]);

  // Peek is exactly as tall as the sizing row it has to show, measured rather
  // than assumed, so the row can never be clipped by a hard-coded number.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (sizing !== "content" || !el) return;
    const read = () => {
      if (dragRef.current || detent !== "peek") return;
      const h = el.offsetHeight;
      if (h > 0) setPeekH(handleH + h);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [detent, open, sizing, handleH]);

  /**
   * Lift the whole sheet clear of the software keyboard while one of its own
   * fields has focus.
   *
   * `use-keyboard-safe-focus` shrinks the focused field's nearest scrolling
   * ancestor, which works for a column that begins near the top of the screen
   * and cannot work here: every scrolling ancestor inside this sheet begins
   * *below* the keyboard line, so there is no slack to take away. Moving the
   * sheet is the only thing that helps, and it is done with `bottom` rather
   * than a transform so the size fields never land in a transformed subtree.
   */
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const sync = () => {
      frame = 0;
      const el = sheetRef.current;
      if (!el) return;
      const focused = document.activeElement;
      const shellInset = getShellKeyboardInset();
      const inset =
        shellInset ??
        document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      if (
        inset < MIN_KEYBOARD_INSET_PX ||
        !(focused instanceof HTMLElement) ||
        !el.contains(focused)
      ) {
        setLift(0);
        return;
      }
      const visibleBottom =
        shellInset === null
          ? viewport.offsetTop + viewport.height
          : document.documentElement.clientHeight - shellInset;
      // Measured from where the sheet is *now*, so re-running on every
      // keyboard resize settles on the same number instead of compounding.
      const overlap = el.getBoundingClientRect().bottom - visibleBottom + KEYBOARD_GAP_PX;
      setLift((prev) => Math.max(0, prev + overlap));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sync);
    };
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule, true);
    document.addEventListener("focusout", schedule, true);
    const unsubscribeShell = subscribeShellKeyboardInset(schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("focusout", schedule, true);
      unsubscribeShell();
    };
  }, [open]);

  // Never cover the canvas completely. A phone on its side leaves this
  // container about 145px tall, and the sizing row alone is 114 of that
  // (`size-input`'s stepper is deliberately 96px on a coarse pointer), so
  // without a ceiling the peek detent hides the artwork it is describing.
  // Past the ceiling the sheet's own scroll takes over.
  const maxH = Math.max(handleH + 40, (containerH || FALLBACK_PEEK_H * 3) - minCanvasStripPx);
  const peekCapped = sizing === "fill" ? Math.round(maxH * 0.55) : Math.min(peekH, maxH);
  // 0.6 rather than a literal half: at 0.5 the half detent's own content —
  // transform, duplicate, clean, halftone — did not fit and had to be scrolled
  // to, which is the wrong default for the detent that is meant to show them.
  const halfH = sizing === "fill"
    ? Math.round(maxH * 0.8)
    : clamp(Math.round(maxH * 0.6), Math.min(peekCapped + 48, maxH), maxH);
  const fullH = sizing === "fill"
    ? maxH
    : clamp(Math.round(maxH * 0.88), Math.min(halfH + 48, maxH), maxH);
  const heights: Record<SheetDetent, number> = { peek: peekCapped, half: halfH, full: fullH };

  const liveH = expanded ? dragH ?? heights[detent] : 0;
  // Content follows the finger mid-drag and the settled detent otherwise. It
  // cannot be derived from the height alone: on a phone held sideways this
  // container is short enough that the ceiling above collapses all three
  // detents onto the same number, and the tiers would stop meaning anything.
  const level: SheetDetent =
    dragH === null
      ? detent
      : dragH >= (halfH + fullH) / 2
        ? "full"
        : dragH >= (peekCapped + halfH) / 2
          ? "half"
          : "peek";

  const nearest = useCallback(
    (h: number): SheetDetent => {
      const order: SheetDetent[] = ["peek", "half", "full"];
      return order.reduce((best, d) =>
        Math.abs(heights[d] - h) < Math.abs(heights[best] - h) ? d : best,
      "peek");
    },
    [heights.peek, heights.half, heights.full], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const advance = useCallback(() => {
    setDetent((d) => (d === "peek" ? "half" : d === "half" ? "full" : "peek"));
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: heights[detent], moved: false };
    setDragH(heights[detent]);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = d.startY - e.clientY;
    if (Math.abs(dy) > TAP_SLOP_PX) d.moved = true;
    setDragH(clamp(d.startH + dy, Math.min(peekCapped, handleH), fullH));
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.moved) setDetent(nearest(clamp(d.startH + (d.startY - e.clientY), 0, fullH)));
    else advance();
    setDragH(null);
  };

  if (!open) return null;

  return (
    <div
      ref={sheetRef}
      data-testid={testId}
      data-detent={level}
      className="absolute inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-2xl border-t border-gray-200 bg-white shadow-[0_-8px_24px_rgba(15,23,42,0.18)]"
      style={{
        height: liveH,
        // Never past the top of the canvas area: a sheet lifted off the top of
        // its own container would be clipped rather than revealed.
        bottom: Math.min(lift, Math.max(0, maxH - liveH)),
        transition: dragRef.current
          ? "none"
          : `height ${SPRING_MS}ms ${SPRING}, bottom ${SPRING_MS}ms ${SPRING}`,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={handleLabel}
        title={handleLabel}
        data-testid={`${testId}-handle`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            advance();
          }
        }}
        className="relative flex flex-shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
        style={{ height: handleH, touchAction: "none" }}
      >
        <span className="block h-1 w-9 rounded-full bg-gray-300" />
        {handleLeading && (
          <span className="absolute left-1 top-1/2 -translate-y-1/2 flex items-center">{handleLeading}</span>
        )}
        {handleAccessory && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
            {handleAccessory}
          </span>
        )}
      </div>
      <div
        data-testid={`${testId}-scroll`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          ref={contentRef}
          className="flex flex-col gap-2 px-2"
          style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
        >
          {children(level)}
        </div>
      </div>
    </div>
  );
}
