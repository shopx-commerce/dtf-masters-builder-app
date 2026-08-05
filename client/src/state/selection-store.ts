/**
 * Zustand-backed selection store.
 *
 * Why this exists
 * ---------------
 * `selectedDesignId` and `selectedDesignIds` are among the highest-churn
 * fields in the editor state — they update on every click in the preview,
 * layers panel, or context menu. Living inside `useImageEditorModel`, they
 * flow through the giant `ImageEditorContext.Provider` value object; every
 * consumer of that context therefore re-renders on every selection change,
 * even components that don't reference selection at all.
 *
 * Zustand's `useStore(selector)` hook subscribes each caller to *only* the
 * slice their selector returns, with reference-equality checks by default.
 * A layer row that reads `useIsRowSelected(ids)` re-renders only when the
 * boolean output flips, not on unrelated state changes elsewhere in the
 * editor model.
 *
 * Backward compatibility
 * ----------------------
 * The existing model still exposes `selectedDesignId` / `selectedDesignIds`
 * on its returned bag. `useImageEditorModelStateDesign` proxies those
 * fields from this store so no other module needs to change its consumption
 * pattern — but components that opt in to the granular selectors gain the
 * re-render isolation.
 */

import { useMemo } from "react";
import { create } from "zustand";

type SelectedIdsUpdater = Set<string> | ((prev: Set<string>) => Set<string>);

interface SelectionState {
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
  /** Direct setter — mirrors React's `useState` setter signature. */
  setSelectedDesignId: (id: string | null) => void;
  /** Direct setter — accepts a `Set` or an updater callback. */
  setSelectedDesignIds: (idsOrUpdater: SelectedIdsUpdater) => void;
  /**
   * Select a single design (or clear). Atomically writes both fields so
   * downstream `useCallback`s see a consistent (id, ids) pair.
   */
  selectOne: (id: string | null) => void;
  /**
   * Select many designs. `selectedDesignId` is set to the last id (mirrors
   * the previous marching-select behavior). Empty array clears selection.
   */
  selectMany: (ids: string[]) => void;
  clearSelection: () => void;
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  selectedDesignId: null,
  selectedDesignIds: new Set<string>(),

  setSelectedDesignId: (id) => set({ selectedDesignId: id }),

  setSelectedDesignIds: (idsOrUpdater) => {
    const next =
      typeof idsOrUpdater === "function"
        ? idsOrUpdater(get().selectedDesignIds)
        : idsOrUpdater;
    set({ selectedDesignIds: next });
  },

  selectOne: (id) => {
    set({
      selectedDesignId: id,
      selectedDesignIds: id ? new Set([id]) : new Set(),
    });
  },

  selectMany: (ids) => {
    const next = new Set(ids);
    let nextId: string | null;
    if (ids.length === 0) nextId = null;
    else if (ids.length === 1) nextId = ids[0];
    else nextId = ids[ids.length - 1];
    set({ selectedDesignIds: next, selectedDesignId: nextId });
  },

  clearSelection: () => {
    set({ selectedDesignId: null, selectedDesignIds: new Set() });
  },
}));

// --------------------------------------------------------------------------
// Granular hooks
//
// These wrap `useSelectionStore(selector)` with named exports so call sites
// read like intent (`useIsDesignSelected(id)`) rather than mechanics
// (`useSelectionStore((s) => s.selectedDesignIds.has(id) || ...)`).
// --------------------------------------------------------------------------

/** Subscribes to `selectedDesignId` only. */
export const useSelectedDesignId = () =>
  useSelectionStore((state) => state.selectedDesignId);

/** Subscribes to the entire `selectedDesignIds` set (re-fires on any change). */
export const useSelectedDesignIds = () =>
  useSelectionStore((state) => state.selectedDesignIds);

/** Subscribes to the number of selected designs. */
export const useSelectedCount = () =>
  useSelectionStore((state) => state.selectedDesignIds.size);

/**
 * Subscribe to whether *this specific design id* is selected. Fires only
 * when the boolean flips — unrelated selection changes are ignored.
 *
 * Falls back to `selectedDesignId === id` when `selectedDesignIds` is empty,
 * matching the fallback used throughout the editor.
 */
export function useIsDesignSelected(id: string): boolean {
  return useSelectionStore(
    (state) =>
      state.selectedDesignIds.has(id) ||
      (state.selectedDesignIds.size === 0 && state.selectedDesignId === id),
  );
}

/**
 * Subscribe to whether *any* of the given design ids are selected. Fires
 * only when the boolean flips — a layer row's `isSelected` won't cause a
 * re-render unless the row itself moves in or out of the selection.
 *
 * Because array identity would defeat the memoization, the selector reads
 * from a stable closure over `ids` created by the caller's `useCallback`.
 */
export function useIsRowSelected(ids: readonly string[]): boolean {
  return useSelectionStore((state) => {
    const { selectedDesignId, selectedDesignIds } = state;
    for (const id of ids) {
      if (selectedDesignIds.has(id)) return true;
      if (selectedDesignIds.size === 0 && selectedDesignId === id) return true;
    }
    return false;
  });
}

/**
 * Return the stable action refs from the store. Zustand guarantees each
 * action reference is stable for the store's lifetime, so we can safely
 * memoize the returned object once — callers can drop it into `useEffect`
 * / `useCallback` dependency arrays without triggering spurious re-runs.
 */
export function useSelectionActions() {
  const setSelectedDesignId = useSelectionStore((s) => s.setSelectedDesignId);
  const setSelectedDesignIds = useSelectionStore((s) => s.setSelectedDesignIds);
  const selectOne = useSelectionStore((s) => s.selectOne);
  const selectMany = useSelectionStore((s) => s.selectMany);
  const clearSelection = useSelectionStore((s) => s.clearSelection);
  return useMemo(
    () => ({
      setSelectedDesignId,
      setSelectedDesignIds,
      selectOne,
      selectMany,
      clearSelection,
    }),
    [setSelectedDesignId, setSelectedDesignIds, selectOne, selectMany, clearSelection],
  );
}

/**
 * Non-reactive read of the current selection. Use inside imperative
 * handlers (e.g. keyboard shortcuts) where you need the current value but
 * do not want to subscribe to changes. Never call this at render-time.
 */
export function getSelectionSnapshot(): {
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
} {
  const s = useSelectionStore.getState();
  return {
    selectedDesignId: s.selectedDesignId,
    selectedDesignIds: s.selectedDesignIds,
  };
}
