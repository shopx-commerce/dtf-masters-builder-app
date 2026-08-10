/**
 * Persistent "Uploads" library — independent of the crash-recovery draft
 * storage. Every file the user uploads is saved here so the sidebar Uploads
 * panel can offer previously uploaded files for re-adding, even after
 * designs are deleted or a new sheet is started.
 *
 * Storage layout: two stores sharing the same key —
 *   - `meta`:  small records (name, dims, thumbnail data URL) used for
 *              listing/pruning without ever touching the original blobs.
 *   - `blobs`: the original file blob, read only on "Add Here".
 * Save + cap-eviction run inside one readwrite transaction over both stores,
 * so concurrent saves cannot prune against a stale snapshot.
 *
 * Entries are keyed by a file signature (name:size:lastModified:type) —
 * re-uploading the *same file object* refreshes its slot; identical pixels
 * under a different filename intentionally get their own entry.
 *
 * This is preview/library-only storage: adding a file back to the canvas
 * routes through the exact same upload pipeline as a fresh upload, so
 * export quality, DPI handling, and cart behavior are untouched.
 */

const DATABASE_NAME = "sticker-editor-uploads";
// v2: split single "uploads" store into meta/blobs. Browsers that opened an
// intermediate build may hold a v1 database without the new stores, which
// made every transaction throw. The upgrade handler drops the legacy store.
const DATABASE_VERSION = 2;
const META_STORE = "meta";
const BLOB_STORE = "blobs";
const MAX_LIBRARY_ENTRIES = 30;
const THUMBNAIL_MAX_EDGE = 128;

export const UPLOADS_LIBRARY_CHANGED_EVENT = "dtf:uploads-library-changed";

export interface UploadLibraryEntry {
  key: string;
  name: string;
  type: string;
  lastModified: number;
  addedAt: number;
  /** Small PNG data URL for the panel; absent when rasterization failed (e.g. PDFs). */
  thumbnail?: string;
  width?: number;
  height?: number;
}

interface UploadBlobRecord {
  key: string;
  blob: Blob;
}

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
      if (db.objectStoreNames.contains("uploads")) {
        db.deleteObjectStore("uploads");
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(BLOB_STORE)) {
        db.createObjectStore(BLOB_STORE, { keyPath: "key" });
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
 * Save an uploaded file into the library (fire-and-forget safe).
 * Re-uploading the same file refreshes its `addedAt` so it moves to the
 * front instead of duplicating. The put and the cap-eviction happen in a
 * single readwrite transaction over both stores: `getAll` on the meta store
 * inside the transaction sees the just-written record, so concurrent saves
 * each prune against their own consistent snapshot and the freshly saved
 * entry (newest `addedAt`) is never the eviction victim.
 */
export async function saveUploadToLibrary(file: File): Promise<void> {
  try {
    const key = fileSignature(file);
    const thumb = await makeThumbnail(file);
    const meta: UploadLibraryEntry = {
      key,
      name: file.name,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
      addedAt: Date.now(),
      thumbnail: thumb?.dataUrl,
      width: thumb?.width,
      height: thumb?.height,
    };
    const blobRecord: UploadBlobRecord = { key, blob: file };
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([META_STORE, BLOB_STORE], "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Could not save upload"));
      tx.oncomplete = () => resolve();
      const metaStore = tx.objectStore(META_STORE);
      const blobStore = tx.objectStore(BLOB_STORE);
      metaStore.put(meta);
      blobStore.put(blobRecord);
      // Evict oldest entries beyond the cap, atomically with the put.
      const listRequest = metaStore.getAll() as IDBRequest<UploadLibraryEntry[]>;
      listRequest.onsuccess = () => {
        const all = listRequest.result;
        if (all.length <= MAX_LIBRARY_ENTRIES) return;
        const excess = all
          .sort((a, b) => a.addedAt - b.addedAt)
          .slice(0, all.length - MAX_LIBRARY_ENTRIES);
        for (const record of excess) {
          if (record.key === key) continue; // never evict the entry just saved
          metaStore.delete(record.key);
          blobStore.delete(record.key);
        }
      };
    });
    notifyChanged();
  } catch (error) {
    // Library persistence is best-effort; never let it break an upload.
    console.warn("[uploads-library] save failed", error);
  }
}

/** Newest-first listing. Reads only the small meta store — no blobs. */
export async function listLibraryUploads(): Promise<UploadLibraryEntry[]> {
  try {
    const db = await openDatabase();
    const all = await requestResult<UploadLibraryEntry[]>(
      db.transaction(META_STORE, "readonly").objectStore(META_STORE).getAll(),
    );
    return all.sort((a, b) => b.addedAt - a.addedAt);
  } catch (error) {
    console.warn("[uploads-library] list failed", error);
    return [];
  }
}

/** Reconstruct the original File for re-adding to the canvas. */
export async function getLibraryUploadFile(key: string): Promise<File | null> {
  try {
    const db = await openDatabase();
    const tx = db.transaction([META_STORE, BLOB_STORE], "readonly");
    const [meta, blobRecord] = await Promise.all([
      requestResult<UploadLibraryEntry | undefined>(tx.objectStore(META_STORE).get(key)),
      requestResult<UploadBlobRecord | undefined>(tx.objectStore(BLOB_STORE).get(key)),
    ]);
    if (!meta || !blobRecord?.blob || blobRecord.blob.size === 0) return null;
    return new File([blobRecord.blob], meta.name, {
      type: meta.type,
      lastModified: meta.lastModified,
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
      const tx = db.transaction([META_STORE, BLOB_STORE], "readwrite");
      tx.onerror = () => reject(tx.error ?? new Error("Could not remove upload"));
      tx.oncomplete = () => resolve();
      tx.objectStore(META_STORE).delete(key);
      tx.objectStore(BLOB_STORE).delete(key);
    });
    notifyChanged();
  } catch (error) {
    console.warn("[uploads-library] remove failed", error);
  }
}
