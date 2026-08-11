/**
 * Zustand-backed transform store.
 *
 * Two related pieces of state live here:
 *
 *   `designTransform` — the fallback / scratch transform used when no
 *   design is selected, and updated in parallel with the selected design's
 *   own `transform` field so downstream inputs (rotation, size, flip
 *   toggles) can share a single mutation surface. This is the direct
 *   Zustand replacement for the historic `useState<ImageTransform>` inside
 *   `useImageEditorModelStateDesign`.
 *
 *   `active` — a mirror of the *currently active* transform, i.e. the
 *   selected design's `.transform` (or the fallback above when nothing is
 *   selected). The editor model writes to this via an effect whenever the
 *   derived `activeDesignTransform` changes; consumers subscribe with the
 *   field-level hooks below and re-render *only* when the specific field
 *   they care about changes. That keeps small pieces of UI — the rotation
 *   badge, the flip buttons, the DPI readout — off the fan-out path that
 *   fires on every unrelated model change.
 *
 * Why not put `activeDesignTransform` fully in the store?
 * -------------------------------------------------------
 * Its dependencies (`selectedDesign?.transform`, which comes from the
 * `designs` array) still live in the model. Migrating `designs` too would
 * be a much larger refactor and is a separate follow-up. The mirror
 * pattern gets us the read-side re-render isolation without changing how
 * `designs` are managed.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { DEFAULT_DESIGN_TRANSFORM } from "@/components/image-editor/constants";
import type { ImageTransform } from "@/lib/types";

type TransformUpdater = ImageTransform | ((prev: ImageTransform) => ImageTransform);

interface TransformState {
  /** Fallback + scratch transform. Mirrors the historic React state. */
  designTransform: ImageTransform;
  /** Mirror of `activeDesignTransform` from the editor model. */
  active: ImageTransform | null;
  /** React-style setter — accepts a value or an updater callback. */
  setDesignTransform: (updater: TransformUpdater) => void;
  /** Editor model calls this whenever the derived active transform changes. */
  setActive: (transform: ImageTransform | null) => void;
}

export const useTransformStore = create<TransformState>((set, get) => ({
  designTransform: DEFAULT_DESIGN_TRANSFORM,
  active: null,

  setDesignTransform: (updater) => {
    const next =
      typeof updater === "function" ? updater(get().designTransform) : updater;
    set({ designTransform: next });
  },

  setActive: (transform) => {
    // Bail early on identical refs — the mirroring effect in the model
    // fires on any bag re-render but the transform object is memoized
    // upstream, so most calls here are no-ops with the same reference.
    if (transform === get().active) return;
    set({ active: transform });
  },
}));

// --------------------------------------------------------------------------
// Granular subscription hooks
//
// Each hook subscribes only to the slice named in its title. Zustand
// compares selector return values with `Object.is`, so a rotation-only
// hook that returns the rotation number will only trigger a re-render on
// its consumer when the number actually changes — not on every unrelated
// store update, and not on every editor-context re-render.
// --------------------------------------------------------------------------

/** Subscribe to the fallback / scratch transform (updates when it changes). */
export const useDesignTransform = () =>
  useTransformStore((state) => state.designTransform);

/** Subscribe to the active-transform mirror (updates on any of its fields). */
export const useActiveTransform = () =>
  useTransformStore((state) => state.active);

/**
 * Subscribe to a single field of the active transform. Returns `undefined`
 * when no design is active. Fires a re-render only when that field's
 * primitive value changes.
 *
 * @example
 * const rotation = useActiveTransformField("rotation");
 * return <span>{Math.round(rotation ?? 0)}°</span>;
 */
export function useActiveTransformField<K extends keyof ImageTransform>(
  field: K,
): ImageTransform[K] | undefined {
  return useTransformStore((state) =>
    state.active ? state.active[field] : undefined,
  );
}

/**
 * Subscribe to `active != null`. Fires only when a design becomes active
 * or inactive, not on transform value changes. Useful for gating rendering
 * of the transform toolbar.
 */
export const useHasActiveTransform = () =>
  useTransformStore((state) => state.active !== null);

/**
 * Stable-identity action bundle. Zustand guarantees each action reference
 * never changes for the store's lifetime; wrapping them in a memoized
 * object makes it safe to include in `useEffect` / `useCallback`
 * dependency arrays.
 */
export function useTransformActions() {
  const setDesignTransform = useTransformStore((s) => s.setDesignTransform);
  const setActive = useTransformStore((s) => s.setActive);
  return useMemo(
    () => ({ setDesignTransform, setActive }),
    [setDesignTransform, setActive],
  );
}

/**
 * Non-reactive read of the current transform state. Use inside imperative
 * handlers where you need the current value but do not want to subscribe
 * to changes. Never call this at render-time.
 */
export function getTransformSnapshot(): {
  designTransform: ImageTransform;
  active: ImageTransform | null;
} {
  const s = useTransformStore.getState();
  return { designTransform: s.designTransform, active: s.active };
}
