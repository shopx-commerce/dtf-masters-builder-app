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
 */
export function UploadsPanel({ t, onAddFile, onUnavailable }: UploadsPanelProps) {
  const [entries, setEntries] = useState<UploadLibraryEntry[]>([]);
  const [expanded, setExpanded] = useState(true);
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
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden" data-testid="uploads-panel">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="flex w-full items-center gap-3 px-3 py-2.5 min-w-0 text-left"
        data-testid="uploads-panel-toggle"
      >
        <Upload className="h-6 w-6 flex-shrink-0 text-cyan-500" strokeWidth={2.25} />
        <span className="flex-1 truncate text-base font-semibold text-gray-800">{t("editor.uploads")}</span>
        <span className="flex-shrink-0 rounded-full bg-cyan-100 px-2.5 py-1 text-sm font-bold tabular-nums text-cyan-700">{entries.length}</span>
      </button>
      {expanded && (
        <div
          className="layers-scroll border-t border-gray-200 max-h-[280px] overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#9ca3af transparent" }}
        >
          {entries.map(entry => (
            <div
              key={entry.key}
              className="group flex items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0"
              data-testid={`uploads-entry-${entry.key}`}
            >
              <div
                className="h-12 w-12 flex-shrink-0 overflow-hidden rounded border border-gray-200"
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
                    <FileText className="h-6 w-6 text-gray-400" />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-gray-800" title={entry.name}>{entry.name}</div>
                {entry.width && entry.height ? (
                  <div className="text-xs text-gray-500 tabular-nums">{entry.width}×{entry.height}px</div>
                ) : null}
              </div>
              <button
                onClick={() => void handleAdd(entry)}
                disabled={addingKey !== null}
                className="flex flex-shrink-0 items-center gap-1 rounded-md border border-cyan-500 bg-white px-2.5 py-1.5 text-xs font-bold text-cyan-600 transition-colors hover:bg-cyan-50 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
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
  );
}
