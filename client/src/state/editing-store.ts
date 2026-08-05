/**
 * Zustand-backed editing state store for the layers panel.
 *
 * Historically the "which row is editing its name / its copy-count"
 * scratch state lived in `useImageEditorModelStateDesign` and in
 * `image-editor-view`, then flowed to every `<LayerRow />` as props on
 * every keystroke. Even though each row is `React.memo`-wrapped, the
 * `editingNameValue` / `editingCountValue` props changed on every character
 * — so a rename of one layer forced every row to re-run its render.
 *
 * Moving the state here lets each row subscribe with a per-row selector
 * (`useMyEditingNameValue(rowKey)`) that returns `""` unless *this*
 * specific row is the one being edited. Rows that aren't involved never
 * see a value change, so their memo compare short-circuits and they skip
 * rendering entirely while the user is typing in another row.
 *
 * A secondary benefit: the model no longer regenerates its context bag on
 * every keystroke, so preview-section / controls-section / etc. don't
 * cascade a re-render for what is a purely-local UI concern.
 */

import { useMemo } from "react";
import { create } from "zustand";

interface EditingState {
  /** Row key currently editing its display name, or `null`. */
  editingNameKey: string | null;
  /** Draft value for the name input (only meaningful for `editingNameKey`). */
  editingNameValue: string;
  /** Row key currently editing its copy count, or `null`. */
  editingCountKey: string | null;
  /** Draft value for the count input (only meaningful for `editingCountKey`). */
  editingCountValue: string;

  /** Begin (or update the draft for) a name edit on `rowKey`. */
  beginNameEdit: (rowKey: string, initial: string) => void;
  /** Overwrite just the draft value while still editing the same row. */
  setNameValue: (value: string) => void;
  /** Clear the active name edit. */
  endNameEdit: () => void;

  /** Begin (or update the draft for) a count edit on `rowKey`. */
  beginCountEdit: (rowKey: string, initial: string) => void;
  setCountValue: (value: string) => void;
  endCountEdit: () => void;
}

export const useEditingStore = create<EditingState>((set) => ({
  editingNameKey: null,
  editingNameValue: "",
  editingCountKey: null,
  editingCountValue: "",

  beginNameEdit: (rowKey, initial) =>
    set({ editingNameKey: rowKey, editingNameValue: initial }),
  setNameValue: (value) => set({ editingNameValue: value }),
  endNameEdit: () => set({ editingNameKey: null, editingNameValue: "" }),

  beginCountEdit: (rowKey, initial) =>
    set({ editingCountKey: rowKey, editingCountValue: initial }),
  setCountValue: (value) => set({ editingCountValue: value }),
  endCountEdit: () => set({ editingCountKey: null, editingCountValue: "" }),
}));

// --------------------------------------------------------------------------
// Per-row selector hooks
//
// Each selector's return value is a primitive (`boolean` or `string`) so
// `Object.is` reference equality — Zustand's default equality check — is
// exactly what we want. A row that isn't editing gets a stable `false` /
// stable `""` on every keystroke elsewhere and skips its next render.
// --------------------------------------------------------------------------

/** Fires only when *this row's* editing-name flag flips. */
export const useIsEditingName = (rowKey: string): boolean =>
  useEditingStore((s) => s.editingNameKey === rowKey);

/** Fires only when *this row's* editing-count flag flips. */
export const useIsEditingCount = (rowKey: string): boolean =>
  useEditingStore((s) => s.editingCountKey === rowKey);

/**
 * Fires only when this row is the active name-edit target *and* the draft
 * value changes. Other rows always get `""` and skip re-rendering while
 * the user types elsewhere.
 */
export const useMyEditingNameValue = (rowKey: string): string =>
  useEditingStore((s) => (s.editingNameKey === rowKey ? s.editingNameValue : ""));

/** See {@link useMyEditingNameValue}; count-input variant. */
export const useMyEditingCountValue = (rowKey: string): string =>
  useEditingStore((s) => (s.editingCountKey === rowKey ? s.editingCountValue : ""));

/**
 * Stable-identity action bundle. Zustand action refs are stable for the
 * store's lifetime, so `useMemo` here guarantees the returned object
 * reference doesn't change between renders — safe to include in
 * `useCallback` / `useEffect` dep arrays.
 */
export function useEditingActions() {
  const beginNameEdit = useEditingStore((s) => s.beginNameEdit);
  const setNameValue = useEditingStore((s) => s.setNameValue);
  const endNameEdit = useEditingStore((s) => s.endNameEdit);
  const beginCountEdit = useEditingStore((s) => s.beginCountEdit);
  const setCountValue = useEditingStore((s) => s.setCountValue);
  const endCountEdit = useEditingStore((s) => s.endCountEdit);
  return useMemo(
    () => ({
      beginNameEdit,
      setNameValue,
      endNameEdit,
      beginCountEdit,
      setCountValue,
      endCountEdit,
    }),
    [
      beginNameEdit,
      setNameValue,
      endNameEdit,
      beginCountEdit,
      setCountValue,
      endCountEdit,
    ],
  );
}

/**
 * Non-reactive snapshot for imperative handlers (e.g. read the current
 * draft inside a keyboard shortcut). Never call at render-time.
 */
export function getEditingSnapshot(): {
  editingNameKey: string | null;
  editingNameValue: string;
  editingCountKey: string | null;
  editingCountValue: string;
} {
  const s = useEditingStore.getState();
  return {
    editingNameKey: s.editingNameKey,
    editingNameValue: s.editingNameValue,
    editingCountKey: s.editingCountKey,
    editingCountValue: s.editingCountValue,
  };
}
