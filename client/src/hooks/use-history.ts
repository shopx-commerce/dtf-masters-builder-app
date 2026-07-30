import { useRef, useCallback } from "react";

export interface HistorySnapshot {
  designsJson: string;
  selectedDesignId: string | null;
  imageInfoMap?: Map<string, unknown>;
  artboardWidth?: number;
  artboardHeight?: number;
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
