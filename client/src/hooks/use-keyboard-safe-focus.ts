import { useEffect } from "react";
import { isTrustedShellMessage, sanitizeShellKeyboardInset } from "@/lib/shell-message";

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
 *
 * Measuring the keyboard locally only works in a top-level document, which is
 * what `/test-builder` is and what the storefront embed is not. A child
 * browsing context has no visual viewport distinct from its layout viewport, so
 * inside the iframe `visualViewport.height` is always
 * `documentElement.clientHeight` and `offsetTop` is always 0 — the difference
 * below is identically zero however tall the iframe is, and a keyboard opening
 * over the storefront is neither visible nor announced there. That fails inert
 * rather than backwards, which is the right way round, but it does mean the
 * shell has to say so: see `SHELL_CONFIG_TYPE` below for what it must post.
 */

/** Below this, a visual-viewport shrink is browser chrome (the URL bar), not a keyboard. */
const MIN_KEYBOARD_INSET_PX = 120;

/** Gap left between the focused control and the top of the keyboard. */
const CLEARANCE_PX = 12;

/** Depth limit on the scrollable-ancestor walk. */
const MAX_CONTAINERS = 4;

/**
 * How the storefront shell reports the keyboard, since this frame cannot see it.
 *
 * ===================================================================
 * THEME CONTRACT — `dtf-builder-shell-config`, field `keyboardInset`
 *
 *   iframe.contentWindow.postMessage(
 *     { type: "dtf-builder-shell-config", keyboardInset: n }, builderOrigin);
 *
 *  - Posted by the window that *directly embeds* this frame, and only that
 *    window: `event.source` must be `window.parent`, which the browser sets and
 *    nothing can forge. A nested embed has to relay through the middle frame.
 *  - `n` is how many CSS pixels of *this iframe's* viewport the keyboard covers,
 *    counted from the iframe's bottom edge — not the keyboard's height on the
 *    screen. The shell computes it from the numbers only a top-level document
 *    has:
 *      const vv = window.visualViewport;
 *      const box = iframe.getBoundingClientRect();
 *      const n = Math.max(0, box.bottom - (vv.offsetTop + vv.height));
 *    Framing it as an overlap is what makes it exact for any iframe height and
 *    any scroll position, rather than only for a full-height embed. It also
 *    means the number is not a keyboard height and will not look like one on an
 *    embed taller than the screen — and that a shell that posts a keyboard
 *    height by mistake under-reports, which leaves this inert rather than
 *    shrinking things with no keyboard present.
 *  - A finite number, 0..8192. A numeric string is rejected, not coerced.
 *    Rejected values leave the previously accepted one in place.
 *  - Level-triggered, not edge-triggered: post on every `visualViewport`
 *    `resize` and `scroll`, and post `0` when the keyboard closes. Nothing here
 *    times the value out, so a shell that reports the opening and not the
 *    closing leaves a stale claim behind until the field is blurred.
 *  - Idempotent. Re-posting the same number does nothing; the same message may
 *    carry `viewportWidth` and `uploadUrl`, and a message that omits
 *    `keyboardInset` leaves a previously accepted inset alone.
 * ===================================================================
 */
const SHELL_CONFIG_TYPE = "dtf-builder-shell-config";

/**
 * Module scope, not component state: the shell posts on its own schedule and the
 * message can arrive before this hook mounts.
 */
let shellKeyboardInset: number | null = null;
const insetSubscribers = new Set<() => void>();
let listeningForShellConfig = false;

function handleShellConfig(event: MessageEvent): void {
  const data = event.data as { type?: unknown; keyboardInset?: unknown } | null;
  if (!data || typeof data !== "object") return;
  if (data.type !== SHELL_CONFIG_TYPE) return;
  if (!("keyboardInset" in data)) return;
  if (!isTrustedShellMessage(event, "shell-keyboard-inset")) return;
  const inset = sanitizeShellKeyboardInset(data.keyboardInset);
  if (inset === null || inset === shellKeyboardInset) return;
  shellKeyboardInset = inset;
  for (const notify of insetSubscribers) notify();
}

/**
 * The shell's last accepted keyboard inset, or `null` if it has never posted
 * one. Exported for the mobile tool sheet, which cannot be rescued by the
 * mechanism below — see `MIN_KEYBOARD_INSET_PX` and the walk in `sync`: every
 * scrolling ancestor of a field inside a bottom-anchored sheet *starts* below
 * the keyboard, so there is no height to take away. The sheet moves itself
 * instead, and reads the inset from here so it agrees with this hook rather
 * than repeating its trust checks.
 */
export function getShellKeyboardInset(): number | null {
  return shellKeyboardInset;
}

export function subscribeShellKeyboardInset(onChange: () => void): () => void {
  if (!listeningForShellConfig) {
    listeningForShellConfig = true;
    window.addEventListener("message", handleShellConfig);
  }
  insetSubscribers.add(onChange);
  return () => {
    insetSubscribers.delete(onChange);
  };
}

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
 * How much of the gap a container can afford, given the distance between its
 * top and the keyboard.
 *
 * The floor here used to be a flat 96px, which described a comfortable scroll
 * window rather than the question being asked, and on a landscape phone it
 * inverted the hook's purpose. Those viewports are 375–430 CSS px tall, a
 * landscape keyboard with its accessory bar takes 200–221 of that, and the
 * column holding the size fields starts 90px down — leaving 67–88px, under the
 * flat floor. The hook declined and the field stayed under the keyboard, which
 * is the outcome the floor existed to prevent, not to cause.
 *
 * Measuring against the control instead asks the real question, but a fixed
 * clearance still charges for it twice — once shrinking the container short of
 * the keyboard and again scrolling the field short of the container's own
 * bottom — so a container needed the field's height plus 24px, and one pixel
 * under that the hook declined *entirely* and the field went back to being
 * ~475px under the keyboard. There is no cliff there worth defending: a field
 * flush against the keyboard is completely readable and typable, so the gap is
 * given up a pixel at a time and only a container that cannot show the whole
 * control is worth declining for.
 *
 * It stops at the control's own height rather than clipping it. Showing a
 * part-control would extend the reach by about 13px before the line of text
 * being typed is itself cut — less than the uncertainty in the published
 * keyboard heights this exists to survive — in exchange for a rendered state,
 * half a field in a sliver of a panel, that nothing has confirmed is usable.
 */
function affordableClearance(available: number, fieldHeight: number): number {
  return Math.max(0, Math.min(CLEARANCE_PX, Math.floor((available - fieldHeight) / 2)));
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

      // Precedence: the shell's number whenever it has sent one, this frame's
      // own measurement otherwise. The local subtraction is only meaningful at
      // top level — see the file comment — but that is also the only place
      // nothing is posting, so the two never compete.
      const shellInset = shellKeyboardInset;
      const inset =
        shellInset ??
        document.documentElement.clientHeight - viewport.height - viewport.offsetTop;
      // The same threshold either way, so a shell cannot make this engage with a
      // number too small to be a keyboard.
      if (inset < MIN_KEYBOARD_INSET_PX || !acceptsKeyboard(focused)) return;

      // Both forms count from the bottom of *this* frame: the shell is asked for
      // the keyboard's overlap with the iframe, not for its height on screen.
      const visibleBottom =
        shellInset === null
          ? viewport.offsetTop + viewport.height
          : document.documentElement.clientHeight - shellInset;
      const next: AdjustedContainer[] = [];

      for (const container of scrollableAncestors(focused)) {
        const box = container.getBoundingClientRect();
        const fieldHeight = focused.getBoundingClientRect().height;
        // One clearance for this container, used by all three steps below. They
        // have to agree: the scroll step aims the field at a gap above the
        // container's bottom that the shrink step must have left room for.
        const clearance = affordableClearance(visibleBottom - box.top, fieldHeight);

        if (focused.getBoundingClientRect().bottom + clearance <= visibleBottom) break;

        const room = visibleBottom - clearance - box.top;
        // `room >= box.height` means this container already ends above the
        // keyboard and shrinking it buys nothing; short of the control plus the
        // gap the scroll step leaves under it, the container begins too close to
        // the keyboard to reveal the field at all. Either way, try a larger
        // ancestor.
        if (room < fieldHeight + clearance || room >= box.height) continue;

        next.push({
          el: container,
          maxHeight: container.style.maxHeight,
          scrollTop: container.scrollTop,
        });
        container.style.maxHeight = `${room}px`;

        const overshoot =
          focused.getBoundingClientRect().bottom +
          clearance -
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
    const unsubscribeShell = subscribeShellKeyboardInset(schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      unsubscribeShell();
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule, true);
      document.removeEventListener("focusout", schedule, true);
      window.removeEventListener("orientationchange", schedule);
      rollBack();
    };
  }, []);
}
