/**
 * Persistent "Uploads" library — independent of the crash-recovery draft
 * storage. Every file the user uploads is saved here (keyed by its content
 * signature) so the sidebar Uploads panel can offer previously uploaded
 * files for re-adding, even after designs are deleted or a new sheet is
 * started. Capped at MAX_LIBRARY_ENTRIES; oldest entries are evicted.
 *
 * This is preview/library-only storage: adding a file back to the canvas
 * routes through the exact same upload pipeline as a fresh upload, so
 * export quality, DPI handling, and cart behavior are untouched.
 */

const DATABASE_NAME = "sticker-editor-uploads";
const DATABASE_VERSION = 1;
const UPLOAD_STORE = "uploads";
const MAX_LIBRARY_ENTRIES = 30;
const THUMBNAIL_MAX_EDGE = 128;

export const UPLOADS_LIBRARY_CHANGED_EVENT = "dtf:uploads-library-changed";

export interface UploadLibraryRecord {
  key: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
  addedAt: number;
  /** Small JPEG/PNG data URL for the panel; absent when rasterization failed (e.g. PDFs). */
  thumbnail?: string;
  width?: number;
  height?: number;
}

/** Listing entry without the (potentially large) original blob. */
export type UploadLibraryEntry = Omit<UploadLibraryRecord, "blob">;

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

let _db: IDBDatabase | null = null;
let _dbPromise: Promise<IDBDatabase> | null = null;

function releaseDb() {
  if (_db) { try { _db.close(); } catch { /* already closed */ } }
  _db = null;
  _dbPromise = null;
}

function openDatabase(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => {
      _dbPromise = null;
      reject(request.error ?? new Error("Could not open uploads library"));
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => releaseDb();
      db.onclose = () => { if (_db === db) releaseDb(); };
      _db = db;
      _dbPromise = null;
      resolve(db);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(UPLOAD_STORE)) {
        db.createObjectStore(UPLOAD_STORE, { keyPath: "key" });
      }
    };
  });
  return _dbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Uploads library request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

function fileSignature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function notifyChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(UPLOADS_LIBRARY_CHANGED_EVENT));
  }
}

/**
 * Rasterize a small thumbnail. Works for anything an <img> can decode
 * (PNG/JPEG/WebP and SVG). Returns null for undecodable types (e.g. PDF).
 */
async function makeThumbnail(file: File): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("not decodable"));
      image.src = url;
    });
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, tw, th);
    // PNG keeps transparency visible over the checkerboard panel background.
    return { dataUrl: canvas.toDataURL("image/png"), width: w, height: h };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Save an uploaded file into the library (fire-and-forget safe). Re-uploading
 * the same file refreshes its `addedAt` so it moves to the front instead of
 * duplicating. Evicts the oldest entries beyond MAX_LIBRARY_ENTRIES.
 */
export async function saveUploadToLibrary(file: File): Promise<void> {
  try {
    const key = fileSignature(file);
    const thumb = await makeThumbnail(file);
    const record: UploadLibraryRecord = {
      key,
      blob: file,
      name: file.name,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
      addedAt: Date.now(),
      thumbnail: thumb?.dataUrl,
      width: thumb?.width,
      height: thumb?.height,
    };
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPLOAD_STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Could not save upload"));
      tx.oncomplete = () => resolve();
      tx.objectStore(UPLOAD_STORE).put(record);
    });
    await pruneLibrary(db);
    notifyChanged();
  } catch (error) {
    // Library persistence is best-effort; never let it break an upload.
    console.warn("[uploads-library] save failed", error);
  }
}

async function pruneLibrary(db: IDBDatabase): Promise<void> {
  const all = await requestResult<UploadLibraryRecord[]>(
    db.transaction(UPLOAD_STORE, "readonly").objectStore(UPLOAD_STORE).getAll(),
  );
  if (all.length <= MAX_LIBRARY_ENTRIES) return;
  const excess = all
    .sort((a, b) => a.addedAt - b.addedAt)
    .slice(0, all.length - MAX_LIBRARY_ENTRIES);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(UPLOAD_STORE, "readwrite");
    tx.onerror = () => reject(tx.error ?? new Error("Could not prune uploads"));
    tx.oncomplete = () => resolve();
    const store = tx.objectStore(UPLOAD_STORE);
    for (const record of excess) store.delete(record.key);
  });
}

/** Newest-first metadata listing (no blobs) for the panel. */
export async function listLibraryUploads(): Promise<UploadLibraryEntry[]> {
  try {
    const db = await openDatabase();
    const all = await requestResult<UploadLibraryRecord[]>(
      db.transaction(UPLOAD_STORE, "readonly").objectStore(UPLOAD_STORE).getAll(),
    );
    return all
      .sort((a, b) => b.addedAt - a.addedAt)
      .map(({ blob: _blob, ...entry }) => entry);
  } catch (error) {
    console.warn("[uploads-library] list failed", error);
    return [];
  }
}

/** Reconstruct the original File for re-adding to the canvas. */
export async function getLibraryUploadFile(key: string): Promise<File | null> {
  try {
    const db = await openDatabase();
    const record = await requestResult<UploadLibraryRecord | undefined>(
      db.transaction(UPLOAD_STORE, "readonly").objectStore(UPLOAD_STORE).get(key),
    );
    if (!record || !record.blob || record.blob.size === 0) return null;
    return new File([record.blob], record.name, {
      type: record.type,
      lastModified: record.lastModified,
    });
  } catch (error) {
    console.warn("[uploads-library] read failed", error);
    return null;
  }
}

export async function removeLibraryUpload(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(UPLOAD_STORE, "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Could not remove upload"));
      tx.oncomplete = () => resolve();
      tx.objectStore(UPLOAD_STORE).delete(key);
    });
    notifyChanged();
  } catch (error) {
    console.warn("[uploads-library] remove failed", error);
  }
}
