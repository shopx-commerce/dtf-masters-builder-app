/**
 * Zustand-backed tool state store.
 *
 * Holds interactive-tool scratch state that (a) is written on a per-frame
 * cadence by the user (slider drags, tolerance nudges, etc.) and
 * (b) is otherwise only consumed by a single reader — either the slider
 * component itself or a model callback fired on click.
 *
 * The historic pattern threaded this state through the editor context
 * bag. Every slider tick regenerated the entire bag, re-rendered the
 * editor view, and invalidated every `useCallback` that closed over the
 * value. For a 60Hz slider drag that meant ~60 whole-editor renders per
 * second. Moving to a dedicated store fixes both problems at once:
 *
 *   - the slider (`controls-section`) subscribes to `useWandTolerance()`
 *     and re-renders on its own — nobody else pays.
 *   - the wand-delete callback in the model reads the current value
 *     imperatively via `getToolSnapshot()` at call time, so the callback
 *     identity stays stable across slider drags.
 *
 * Future hot tool values (halftone strength preview, wand-mode
 * modifiers, etc.) can co-locate here as they get promoted out of the
 * model bag.
 */

import { useMemo } from "react";
import { create } from "zustand";

interface ToolState {
  /** Magic-wand color-tolerance slider value (1–100). */
  wandTolerance: number;
  setWandTolerance: (value: number) => void;
}

export const useToolStore = create<ToolState>((set) => ({
  wandTolerance: 30,
  setWandTolerance: (value) => set({ wandTolerance: value }),
}));

// --------------------------------------------------------------------------
// Granular subscription hooks
// --------------------------------------------------------------------------

/** Subscribes only to the wand tolerance value. */
export const useWandTolerance = () =>
  useToolStore((s) => s.wandTolerance);

/** Stable-identity action bundle for the tool store. */
export function useToolActions() {
  const setWandTolerance = useToolStore((s) => s.setWandTolerance);
  return useMemo(() => ({ setWandTolerance }), [setWandTolerance]);
}

/**
 * Non-reactive snapshot for model callbacks. Reading via `.getState()` at
 * call time (rather than closing over a reactive value) lets the
 * callback's `useCallback` deps stay stable — the slider can move 60
 * times a second without invalidating downstream memoization.
 *
 * Never call at render time.
 */
export function getToolSnapshot(): { wandTolerance: number } {
  const s = useToolStore.getState();
  return { wandTolerance: s.wandTolerance };
}
