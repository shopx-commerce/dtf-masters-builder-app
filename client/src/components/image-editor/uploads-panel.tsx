import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Plus, Upload, X } from "lucide-react";
import {
  UPLOADS_LIBRARY_CHANGED_EVENT,
  getLibraryUploadFile,
  listLibraryUploads,
  removeLibraryUpload,
  type UploadLibraryEntry,
} from "@/lib/uploads-library";

interface UploadsPanelProps {
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** Routes the stored file through the normal upload pipeline (same as a fresh upload). */
  onAddFile: (file: File) => Promise<void>;
  onUnavailable: () => void;
}

/**
 * Collapsed-under-Layers "Uploads" section: thumbnails of previously
 * uploaded files (persisted in IndexedDB across sessions/sheets) with an
 * "Add Here" action that re-adds the original file to the canvas.
 *
 * Starts minimized — only the header row shows until it is clicked — so the
 * Layers list above keeps the sidebar space.
 */
export function UploadsPanel({ t, onAddFile, onUnavailable }: UploadsPanelProps) {
  const [entries, setEntries] = useState<UploadLibraryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [addingKey, setAddingKey] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listLibraryUploads().then(setEntries);
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(UPLOADS_LIBRARY_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(UPLOADS_LIBRARY_CHANGED_EVENT, refresh);
  }, [refresh]);

  const handleAdd = useCallback(async (entry: UploadLibraryEntry) => {
    if (addingKey) return;
    setAddingKey(entry.key);
    try {
      const file = await getLibraryUploadFile(entry.key);
      if (!file) {
        onUnavailable();
        void removeLibraryUpload(entry.key);
        return;
      }
      await onAddFile(file);
    } finally {
      setAddingKey(null);
    }
  }, [addingKey, onAddFile, onUnavailable]);

  if (entries.length === 0) return null;

  return (
    // Deliberately styled differently from the Layers panel (gray, dashed
    // border, compact rows) with a divider above, so clients don't mistake
    // old uploads for active layers on the sheet.
    <div className="mt-3 border-t-2 border-gray-300 pt-3" data-testid="uploads-panel-wrapper">
      <div className="bg-gray-50 rounded-lg border border-dashed border-gray-300 overflow-hidden" data-testid="uploads-panel">
        <button
          onClick={() => setExpanded(prev => !prev)}
          className="flex w-full items-center gap-2 px-3 py-1.5 min-w-0 text-left"
          data-testid="uploads-panel-toggle"
        >
          <Upload className="h-4 w-4 flex-shrink-0 text-gray-400" strokeWidth={2.25} />
          <span className="flex-1 truncate text-sm font-semibold text-gray-500">{t("editor.uploads")}</span>
          <span className="flex-shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-bold tabular-nums text-gray-600">{entries.length}</span>
        </button>
        {expanded && (
        <div
          className="layers-scroll border-t border-dashed border-gray-300 max-h-[200px] overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#9ca3af transparent" }}
        >
          {entries.map(entry => (
            <div
              key={entry.key}
              className="group flex items-center gap-2 border-b border-gray-200 px-3 py-1.5 last:border-b-0"
              data-testid={`uploads-entry-${entry.key}`}
            >
              <div
                className="h-8 w-8 flex-shrink-0 overflow-hidden rounded border border-gray-200"
                style={{
                  backgroundImage:
                    "linear-gradient(45deg,#e5e7eb 25%,transparent 25%,transparent 75%,#e5e7eb 75%),linear-gradient(45deg,#e5e7eb 25%,transparent 25%,transparent 75%,#e5e7eb 75%)",
                  backgroundSize: "10px 10px",
                  backgroundPosition: "0 0,5px 5px",
                  backgroundColor: "#f9fafb",
                }}
              >
                {entry.thumbnail ? (
                  <img
                    src={entry.thumbnail}
                    alt={entry.name}
                    className="h-full w-full object-contain"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-white">
                    <FileText className="h-4 w-4 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-gray-700" title={entry.name}>{entry.name}</div>
                {entry.width && entry.height ? (
                  <div className="text-[10px] text-gray-400 tabular-nums">{entry.width}×{entry.height}px</div>
                ) : null}
              </div>
              <button
                onClick={() => void handleAdd(entry)}
                disabled={addingKey !== null}
                className="flex flex-shrink-0 items-center gap-1 rounded-md border border-cyan-500 bg-white px-2 py-1 text-xs font-bold text-cyan-600 transition-colors hover:bg-cyan-50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                data-testid={`uploads-add-${entry.key}`}
              >
                {addingKey === entry.key
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />}
                <span>{t("editor.uploadsAddHere")}</span>
              </button>
              <button
                onClick={() => void removeLibraryUpload(entry.key)}
                className="flex-shrink-0 rounded p-1 text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-600"
                title={t("editor.uploadsRemove")}
                data-testid={`uploads-remove-${entry.key}`}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
        )}
      </div>
    </div>
  );
}
