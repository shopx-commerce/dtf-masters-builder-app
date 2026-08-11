import * as React from "react";
import { isTrustedShellMessage, sanitizeShellViewportWidth } from "@/lib/shell-message";
import { isCompactViewport, SHORT_VIEWPORT_BREAKPOINT } from "./use-mobile";

/**
 * Which layout the editor should render: the phone two-panel slider, or the
 * desktop/tablet column.
 *
 * This is deliberately *not* `useIsMobile`. That hook answers "is this a small
 * touch device", which is what target sizing and touch affordances key off, and
 * it must keep reading the real `window`. This one answers "how much room does
 * the editor have", which on a storefront is a different question:
 *
 *  - `window.innerWidth` inside an iframe is the *iframe's* width. A theme that
 *    puts the builder in a padded or `max-width` container can hand an 820px
 *    iPad an iframe under 768px, and the builder then renders the phone layout
 *    on a tablet. The shell can tell us the real viewport width over the
 *    existing `dtf-builder-shell-config` channel, and when it does we prefer it.
 *  - Height always comes from the real `window`. A shell cannot suppress the
 *    short-viewport guard, so a phone on its side keeps the phone layout no
 *    matter what width is claimed.
 *  - Height also decides orientation, which is what puts a tablet held upright
 *    on the phone layout: see `PORTRAIT_TABLET_MAX_WIDTH`.
 *
 * Unlike `useIsMobile` this is correct on the very first render, so the layout
 * does not paint desktop-first and flip.
 */

const SHELL_CONFIG_TYPE = "dtf-builder-shell-config";

/**
 * Module scope, not component state: the message can arrive before or after any
 * particular component mounts, and every consumer must see the same answer.
 */
let shellViewportWidth: number | null = null;

const subscribers = new Set<() => void>();
let listeningForShellConfig = false;

function handleShellConfig(event: MessageEvent): void {
  const data = event.data as { type?: unknown; viewportWidth?: unknown } | null;
  if (!data || typeof data !== "object") return;
  if (data.type !== SHELL_CONFIG_TYPE) return;
  // The same message type carries `uploadUrl`. A config that says nothing about
  // the viewport must leave a previously accepted width in place.
  if (!("viewportWidth" in data)) return;
  if (!isTrustedShellMessage(event, "shell-viewport-width")) return;
  const width = sanitizeShellViewportWidth(data.viewportWidth);
  if (width === null || width === shellViewportWidth) return;
  shellViewportWidth = width;
  for (const notify of subscribers) notify();
}

/**
 * The width the layout should be sized against.
 *
 * An iframe is never wider than the viewport containing it, so a shell can only
 * ever correct this frame's measurement *upward* — `Math.max` makes that an
 * invariant rather than a hope, and it means no shell can force the phone
 * layout onto a wide device. The screen ceiling closes the other direction: a
 * hostile shell claiming 1200px to a 390px-wide phone would otherwise get the
 * stacked layout rendered into a 390px viewport, which is the same dead end
 * this file exists to prevent. `screen.width` is a property of the device, not
 * of the frame, so an embedder cannot influence it; where a browser reports it
 * stale (an older iOS that does not rotate it), the clamp only ever falls back
 * toward this frame's own width, which is the safe direction.
 */
export function effectiveViewportWidth(): number {
  const own = window.innerWidth;
  if (shellViewportWidth === null) return own;
  const screenWidth = window.screen?.width;
  const ceiling =
    typeof screenWidth === "number" && screenWidth > 0 ? screenWidth : Number.POSITIVE_INFINITY;
  return Math.max(own, Math.min(shellViewportWidth, ceiling));
}

/**
 * Shares `isCompactViewport` with `useIsMobile` rather than restating the rule.
 * The two answer different questions but they gate interlocking pieces of the
 * same screen — the bottom bar is pinned by one and its clearance reserved by
 * the other — so they must never disagree about a given viewport.
 *
 * Width may have been corrected upward by the shell; height is always this
 * frame's own. A tablet handed a short iframe therefore reads as landscape and
 * keeps the desktop layout, which is the same answer it gave before and the
 * safe direction: the layout matches the space actually available.
 */
function readMobileLayout(): boolean {
  return isCompactViewport(effectiveViewportWidth(), window.innerHeight);
}

function subscribe(onStoreChange: () => void): () => void {
  if (!listeningForShellConfig) {
    listeningForShellConfig = true;
    window.addEventListener("message", handleShellConfig);
  }
  subscribers.add(onStoreChange);
  window.addEventListener("resize", onStoreChange);
  window.addEventListener("orientationchange", onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
    window.removeEventListener("resize", onStoreChange);
    window.removeEventListener("orientationchange", onStoreChange);
  };
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * `useSyncExternalStore` re-reads the snapshot on every notification and only
 * re-renders when the boolean itself changed, so a resize storm or a repeated
 * shell config costs nothing.
 */
export function useMobileLayout(): boolean {
  return React.useSyncExternalStore(subscribe, readMobileLayout, getServerSnapshot);
}

function readShortViewport(): boolean {
  const height = window.innerHeight;
  return height > 0 && height < SHORT_VIEWPORT_BREAKPOINT;
}

/**
 * A viewport too short to spend height freely — in practice a phone on its side.
 *
 * Height only, and always from the real `window`, for the reason given above: a
 * shell can correct our width but it cannot make the screen taller. Sheets use
 * this to decide how much of themselves to open, since the detent that shows
 * their content in portrait shows a quarter of it here.
 */
export function useShortViewport(): boolean {
  return React.useSyncExternalStore(subscribe, readShortViewport, getServerSnapshot);
}
