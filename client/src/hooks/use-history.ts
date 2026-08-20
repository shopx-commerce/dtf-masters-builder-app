import { useRef, useCallback } from "react";

export interface HistorySnapshot {
  designsJson: string;
  selectedDesignId: string | null;
  imageInfoMap?: Map<string, unknown>;
  /**
   * The un-screened raster retained by a halftoned design.
   *
   * `imageInfoMap` holds the screened editor/export image. Keeping the source
   * separately is what makes redo deterministic: undoing past the halftone
   * clears the live source, so redo cannot recover it from the current design.
   */
  halftoneSourceMap?: Map<string, HTMLImageElement>;
  artboardWidth?: number;
  artboardHeight?: number;
  /**
   * Height the customer had picked by hand at this point, which auto-shrink treats as a
   * floor. Travels with `artboardHeight` because the two describe the same decision: a
   * snapshot that restored one without the other would leave the sheet pinned to a size
   * nobody chose, or silently un-pin one they did.
   */
  manualHeightFloor?: number | null;
}

const MAX_HISTORY = 50;

export function useHistory() {
  const pastRef = useRef<HistorySnapshot[]>([]);
  const futureRef = useRef<HistorySnapshot[]>([]);
  const isUndoRedoRef = useRef(false);

  const pushSnapshot = useCallback((snapshot: HistorySnapshot) => {
    if (isUndoRedoRef.current) return;
    pastRef.current.push(snapshot);
    if (pastRef.current.length > MAX_HISTORY) {
      pastRef.current.shift();
    }
    futureRef.current = [];
  }, []);

  const undo = useCallback(
    (currentSnapshot: HistorySnapshot): HistorySnapshot | null => {
      if (pastRef.current.length === 0) return null;
      const prev = pastRef.current.pop()!;
      futureRef.current.push(currentSnapshot);
      isUndoRedoRef.current = true;
      return prev;
    },
    []
  );

  const redo = useCallback(
    (currentSnapshot: HistorySnapshot): HistorySnapshot | null => {
      if (futureRef.current.length === 0) return null;
      const next = futureRef.current.pop()!;
      pastRef.current.push(currentSnapshot);
      isUndoRedoRef.current = true;
      return next;
    },
    []
  );

  const clearIsUndoRedo = useCallback(() => {
    isUndoRedoRef.current = false;
  }, []);

  const canUndo = useCallback(() => pastRef.current.length > 0, []);
  const canRedo = useCallback(() => futureRef.current.length > 0, []);

  return { pushSnapshot, undo, redo, clearIsUndoRedo, canUndo, canRedo };
}
