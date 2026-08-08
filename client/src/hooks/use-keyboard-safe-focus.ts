import { useEffect } from "react";

/**
 * Keeps the focused form control clear of an on-screen keyboard.
 *
 * The editor shell is `100dvh` with `overflow: hidden`, so when a software
 * keyboard opens over the bottom of the screen there is nowhere for the page
 * to scroll and the focused field can end up permanently occluded — the user
 * types blind, which is indistinguishable from the keyboard not working.
 *
 * The mechanism is deliberately the smallest one that can work: while the
 * keyboard is up, the focused field's nearest scrolling ancestor gets a
 * temporary `max-height` that ends just above the keyboard, and is then
 * scrolled so the field sits inside it. Shrinking a container that is already
 * `overflow-y: auto` is what gives it the scrollable extent it otherwise
 * lacks; nothing above the keyboard line moves, because the content is
 * top-aligned and only the slack below it is taken away.
 *
 * Deliberately *not* used:
 *  - a transform on the panel — `image-editor-view` already drives the mobile
 *    controls/preview slide with `translateX` on an ancestor of these fields,
 *    and a second transform would either fight it or have to be composed by
 *    hand;
 *  - resizing the app shell to `visualViewport.height` — the preview canvas
 *    sizes itself from its container, so changing shell height mid-session
 *    risks a re-layout and a zoom change while the user is typing. Only a
 *    sibling of the canvas column is touched here.
 *
 * Inert wherever there is no `visualViewport` and wherever the visual viewport
 * does not actually shrink, so desktop and any device without a software
 * keyboard never enter the adjusting path. No user-agent sniffing.
 */

/** Below this, a visual-viewport shrink is browser chrome (the URL bar), not a keyboard. */
const MIN_KEYBOARD_INSET_PX = 120;

/** Gap left between the focused control and the top of the keyboard. */
const CLEARANCE_PX = 12;

/** Depth limit on the scrollable-ancestor walk. */
const MAX_CONTAINERS = 4;

const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function acceptsKeyboard(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLSelectElement) return !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !NON_TEXT_INPUT_TYPES.has(el.type);
  }
  return el.isContentEditable;
}

/**
 * The shortest a container can be squeezed to and still do its job: hold the
 * focused control plus the gap the scroll step leaves under it.
 *
 * This floor used to be a flat 96px, which described a comfortable scroll
 * window rather than the question being asked, and on a landscape phone it
 * inverted the hook's purpose. Those viewports are 375–430 CSS px tall, a
 * landscape keyboard with its accessory bar takes 200–221 of that, and the
 * column holding the size fields starts 90px down — leaving 67–88px, under the
 * flat floor. The hook declined and the field stayed under the keyboard, which
 * is the outcome the floor existed to prevent, not to cause.
 *
 * Measured against the control, the test is the real one, and it cannot be
 * satisfied by a window too small to be worth having: below this the field
 * cannot be brought into view by any amount of scrolling, and at or above it,
 * it always can.
 */
function minUsefulHeight(focused: HTMLElement): number {
  return focused.getBoundingClientRect().height + CLEARANCE_PX;
}

function scrollableAncestors(el: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    if (found.length >= MAX_CONTAINERS) break;
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      found.push(node);
    }
    node = node.parentElement;
  }
  return found;
}

interface AdjustedContainer {
  el: HTMLElement;
  /** The inline value to put back — `""` when there was no inline `max-height`. */
  maxHeight: string;
  scrollTop: number;
}

export function useKeyboardSafeFocus(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    let adjusted: AdjustedContainer[] = [];
    let frame = 0;

    const rollBack = () => {
      // Outermost last: restoring an outer container's height can move the
      // inner ones, so undo from the inside out.
      for (let i = adjusted.length - 1; i >= 0; i--) {
        adjusted[i].el.style.maxHeight = adjusted[i].maxHeight;
        adjusted[i].el.scrollTop = adjusted[i].scrollTop;
      }
      adjusted = [];
    };

    const sync = () => {
      frame = 0;

      // Always measure from the untouched layout, so repeated keyboard
      // resize/scroll events can never compound the adjustment.
      rollBack();

      const focused = document.activeElement;
      const inset =
        document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      if (inset < MIN_KEYBOARD_INSET_PX || !acceptsKeyboard(focused)) return;

      const visibleBottom = viewport.offsetTop + viewport.height;
      const minContainer = minUsefulHeight(focused);
      const next: AdjustedContainer[] = [];

      for (const container of scrollableAncestors(focused)) {
        if (focused.getBoundingClientRect().bottom + CLEARANCE_PX <= visibleBottom) break;

        const box = container.getBoundingClientRect();
        const room = visibleBottom - CLEARANCE_PX - box.top;
        // `room >= box.height` means this container already ends above the
        // keyboard and shrinking it buys nothing; `room` too small means it
        // starts under the keyboard. Either way, try a larger ancestor.
        if (room < minContainer || room >= box.height) continue;

        next.push({
          el: container,
          maxHeight: container.style.maxHeight,
          scrollTop: container.scrollTop,
        });
        container.style.maxHeight = `${room}px`;

        const overshoot =
          focused.getBoundingClientRect().bottom +
          CLEARANCE_PX -
          container.getBoundingClientRect().bottom;
        if (overshoot > 0) container.scrollTop += overshoot;
      }

      adjusted = next;
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(sync);
    };

    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule, true);
    document.addEventListener("focusout", schedule, true);
    window.addEventListener("orientationchange", schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("focusout", schedule, true);
      window.removeEventListener("orientationchange", schedule);
      rollBack();
    };
  }, []);
}
