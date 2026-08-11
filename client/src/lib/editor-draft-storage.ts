import type { DesignItem, ImageInfo, ImageTransform } from "@/lib/types";
import { capRestoredPreview } from "./draft-preview-cap";
import { broadcastDraftPurge } from "./draft-tab-ownership";

const DATABASE_NAME = "sticker-editor-drafts";
const DATABASE_VERSION = 1;
const DRAFT_STORE = "drafts";
const FILE_STORE = "files";
const CURRENT_DRAFT_KEY = "current";

/**
 * Bump whenever a change to `StoredDraftDesign` / `EditorDraft` would make an
 * already-persisted record restore incorrectly. Records written by a different
 * version are ignored rather than fed through `restoreEditorDraft`, which
 * trusts every field it reads. `DATABASE_VERSION` above is separate and only
 * needs bumping when the *object stores* change.
 */
export const CURRENT_DRAFT_SCHEMA_VERSION = 1;

/**
 * How long a draft stays offerable. Past this the customer has almost
 * certainly moved on, and the record's blobs are the largest thing this
 * origin holds, so it is deleted rather than left to occupy quota — a full
 * quota fails every *future* save, which is the more expensive failure.
 */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Fails safe: an unreadable, missing, or future-dated `savedAt` (a clock
 * that was wrong when the draft was written, or has since been corrected)
 * counts as *not* expired. Offering a draft the customer no longer wants
 * costs them one click; destroying one they do want is unrecoverable.
 */
export function isEditorDraftExpired(
  draft: Pick<EditorDraft, "savedAt">,
  now: number = Date.now(),
): boolean {
  const savedAt = draft.savedAt;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt <= 0) return false;
  return now - savedAt > DRAFT_MAX_AGE_MS;
}

export interface StoredDraftDesign {
  id: string;
  name: string;
  transform: ImageTransform;
  widthInches: number;
  heightInches: number;
  originalDPI: number;
  alphaThresholded?: boolean;
  halftoned?: boolean;
  halftoneSettings?: DesignItem["halftoneSettings"];
  printFileName?: boolean;
  fileKey: string;
  fileName: string;
  fileType: string;
  fileLastModified: number;
  originalWidth: number;
  originalHeight: number;
  dpi: number;
  isPDF?: boolean;
  originalPdfData?: ArrayBuffer;
  groupId?: string;
}

export interface EditorDraft {
  schemaVersion: typeof CURRENT_DRAFT_SCHEMA_VERSION;
  savedAt: number;
  profileId: string;
  artboardWidth: number;
  artboardHeight: number;
  quantity: number;
  designGap: number;
  selectedDesignId: string | null;
  selectedDesignIds: string[];
  designs: StoredDraftDesign[];
}

export interface DraftFileRecord {
  key: string;
  blob: Blob;
  name: string;
  type: string;
  lastModified: number;
}

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

// Cached IDB connection. Opening and closing the database on every save adds
// tens of milliseconds and blocks the next save until the previous one has
// fully committed. Reusing a single connection avoids that, and the
// `versionchange` handler lets another tab upgrade the schema by dropping our
// hold so we don't block the upgrade indefinitely.
let _cachedDb: IDBDatabase | null = null;
let _cachedDbPromise: Promise<IDBDatabase> | null = null;

function releaseCachedDatabase() {
  if (_cachedDb) {
    try { _cachedDb.close(); } catch { /* already closed */ }
  }
  _cachedDb = null;
  _cachedDbPromise = null;
}

function openDatabase(): Promise<IDBDatabase> {
  if (_cachedDb) return Promise.resolve(_cachedDb);
  if (_cachedDbPromise) return _cachedDbPromise;
  _cachedDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => {
      _cachedDbPromise = null;
      reject(request.error ?? new Error("Could not open draft storage"));
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => releaseCachedDatabase();
      database.onclose = () => { if (_cachedDb === database) releaseCachedDatabase(); };
      _cachedDb = database;
      _cachedDbPromise = null;
      resolve(database);
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE);
      }
      if (!database.objectStoreNames.contains(FILE_STORE)) {
        database.createObjectStore(FILE_STORE, { keyPath: "key" });
      }
    };
  });
  return _cachedDbPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Draft storage request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

/**
 * Guards the one place untrusted data enters the editor. A record written by a
 * newer or older build can have fields this build would misread, and restore
 * applies stored geometry verbatim, so an unrecognised record is treated as if
 * no draft existed.
 */
function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * `obsolete` — written by an older schema. No code path in this build can ever
 * read it, so it is pure garbage, and leaving it in place made it *unreclaimable*
 * garbage: the expiry purge only ever sees records that came back from
 * `getCurrentEditorDraft`, which returns null for a mismatch, so a stale record's
 * blobs held quota until the customer cleared site data. A full quota fails every
 * future save, so this is the failure that matters. Deleted, blobs and all.
 *
 * `newer` — written by a *later* deploy. Kept, because the reasoning that made
 * keeping mismatched records right applies in this direction only: the customer
 * may well be back on the newer build (a rollback in progress, a cached older
 * bundle, two tabs on different deploys) and that build can still read it.
 * Destroying it from here would throw away work that is not ours to judge. It
 * still ages out through the normal expiry, so it is not immortal either.
 */
type DraftVersionVerdict = "current" | "obsolete" | "newer" | "unreadable";

function classifyDraftVersion(value: unknown): DraftVersionVerdict {
  if (!value || typeof value !== "object") return "unreadable";
  const version = (value as Partial<EditorDraft>).schemaVersion;
  if (version === CURRENT_DRAFT_SCHEMA_VERSION) return "current";
  if (typeof version === "number" && Number.isFinite(version)) {
    return version < CURRENT_DRAFT_SCHEMA_VERSION ? "obsolete" : "newer";
  }
  // Missing or non-numeric: predates `schemaVersion` entirely, so it is older
  // than 1 by definition rather than something a future build wrote.
  return "obsolete";
}

function isUsableDraft(value: unknown): value is EditorDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<EditorDraft>;
  if (draft.schemaVersion !== CURRENT_DRAFT_SCHEMA_VERSION) {
    console.warn("[editor-draft] ignoring draft written by another schema version", draft.schemaVersion);
    return false;
  }
  if (!Array.isArray(draft.designs) || !Array.isArray(draft.selectedDesignIds)) return false;
  // The sheet scalars are applied to editor state verbatim and there is no
  // sensible value to repair them to from here — a `NaN` artboard height sizes
  // the canvas to nothing and every downstream layout number inherits the
  // `NaN`. An unrestorable record is better treated as no record at all: the
  // customer gets a working empty editor instead of a broken sheet.
  if (!isPositiveFinite(draft.artboardWidth) || !isPositiveFinite(draft.artboardHeight)) {
    console.warn("[editor-draft] ignoring draft with unusable sheet size", draft.artboardWidth, draft.artboardHeight);
    return false;
  }
  if (!isPositiveFinite(draft.quantity)) {
    console.warn("[editor-draft] ignoring draft with unusable quantity", draft.quantity);
    return false;
  }
  return true;
}

/** Geometry is applied straight to the canvas, so a non-finite value here is
 *  not a cosmetic defect — it propagates into every layout calculation that
 *  touches the design. Such a design is dropped rather than restored. */
function hasUsableGeometry(stored: StoredDraftDesign): boolean {
  if (!isPositiveFinite(stored.widthInches) || !isPositiveFinite(stored.heightInches)) return false;
  const t = stored.transform;
  if (!t || typeof t !== "object") return false;
  if (!Number.isFinite(t.nx) || !Number.isFinite(t.ny) || !Number.isFinite(t.rotation)) return false;
  return isPositiveFinite(t.s);
}

/**
 * Deletes the `current` record and every blob behind it, but only while it is
 * still readably obsolete.
 *
 * The version is re-read *inside* the write transaction rather than trusted from
 * the caller's earlier read: between the read and this delete another tab may
 * have replaced the obsolete record with a current one and written blobs for it,
 * and deleting then would take that tab's artwork with it. Re-checking under the
 * transaction makes the delete unconditionally safe — it can only ever destroy a
 * record that no build in play can read.
 *
 * The whole file store goes, not just the keys this record names: every blob
 * belongs to the single `current` draft, so anything else in there was orphaned
 * by an earlier save and is exactly the garbage being collected.
 */
async function purgeObsoleteDraft(database: IDBDatabase): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction([DRAFT_STORE, FILE_STORE], "readwrite");
    let purged = false;
    const fail = () => reject(transaction.error ?? new Error("Could not purge obsolete draft"));
    transaction.onerror = fail;
    transaction.onabort = fail;
    transaction.oncomplete = () => resolve(purged);

    const draftStore = transaction.objectStore(DRAFT_STORE);
    const read = draftStore.get(CURRENT_DRAFT_KEY);
    read.onsuccess = () => {
      if (classifyDraftVersion(read.result) !== "obsolete") return;
      purged = true;
      draftStore.delete(CURRENT_DRAFT_KEY);
      transaction.objectStore(FILE_STORE).clear();
    };
  });
}

export async function getCurrentEditorDraft(): Promise<EditorDraft | null> {
  const database = await openDatabase();
  const transaction = database.transaction(DRAFT_STORE, "readonly");
  const value = await requestResult<unknown>(
    transaction.objectStore(DRAFT_STORE).get(CURRENT_DRAFT_KEY),
  );
  if (isUsableDraft(value)) {
    if (isEditorDraftExpired(value)) {
      // Best-effort reclaim; the customer sees "no draft" either way this tick.
      void deleteCurrentEditorDraft().catch(error => {
        console.warn("[editor-draft] expired draft cleanup failed", error);
      });
      return null;
    }
    return value;
  }
  // Reclaiming happens on the read rather than from the availability effect so
  // that *every* entry point frees the quota, including the flows that return
  // early before they would have offered a draft (edit mode, a remote design).
  if (classifyDraftVersion(value) === "obsolete") {
    await purgeObsoleteDraft(database).then(
      purged => { if (purged) console.warn("[editor-draft] deleted obsolete-schema draft and its blobs"); },
      error => { console.warn("[editor-draft] obsolete draft cleanup failed", error); },
    );
  }
  return null;
}

export async function getDraftFile(key: string): Promise<DraftFileRecord | null> {
  const database = await openDatabase();
  const transaction = database.transaction(FILE_STORE, "readonly");
  return await requestResult<DraftFileRecord | undefined>(
    transaction.objectStore(FILE_STORE).get(key),
  ).then(value => value ?? null);
}

export function isRecoverableImageInfo(info: ImageInfo | null | undefined): boolean {
  return Boolean(
    info?.file &&
    info.file.size > 0 &&
    info.image &&
    info.image.complete &&
    (info.image.naturalWidth || info.image.width) > 0 &&
    (info.image.naturalHeight || info.image.height) > 0,
  );
}

async function restoreStoredDesignImage(stored: StoredDraftDesign): Promise<ImageInfo | null> {
  const fileRecord = await getDraftFile(stored.fileKey);
  if (!fileRecord) return null;

  const file = new File([fileRecord.blob], stored.fileName, {
    type: stored.fileType,
    lastModified: stored.fileLastModified,
  });
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve();
      };
      image.onerror = () => reject(new Error(`Could not restore ${stored.fileName}`));
      image.src = objectUrl;
    });
    // The persisted blob is the design's uncapped pixels (same as the upload
    // path, which keeps `file` at full resolution for export/print). The
    // *preview* the canvas draws is capped the same way upload caps it —
    // otherwise a restored sheet holds decoded previews far larger than the
    // session that saved it. `file` stays untouched, so the export pipeline
    // still has every pixel it had before the reload.
    const capped = await capRestoredPreview(image, fileRecord.blob, {
      preserveCleanAlpha: stored.alphaThresholded || stored.halftoned,
    });
    return {
      file,
      image: capped.image,
      originalWidth: capped.width,
      originalHeight: capped.height,
      dpi: stored.dpi,
      isPDF: stored.isPDF,
      originalPdfData: stored.originalPdfData,
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    console.warn("[editor-draft] targeted image restore failed", error);
    return null;
  }
}

export async function rehydrateDesignImageFromDraft(
  designId: string,
): Promise<ImageInfo | null> {
  const draft = await getCurrentEditorDraft();
  const stored = draft?.designs.find(design => design.id === designId);
  if (!stored) return null;
  return restoreStoredDesignImage(stored);
}

/**
 * Every file-store key the draft still needs. The reconciliation in `writeDraft`
 * deletes whatever this does not list, so it has to be derived rather than
 * spelled out inline — otherwise a key type added later would silently be swept.
 */
function referencedFileKeys(draft: EditorDraft): string[] {
  return draft.designs.map(design => design.fileKey);
}

/**
 * Writes the draft record and reconciles the file store against it: blobs whose
 * key is already on disk are not re-written, and blobs no design references any
 * more are deleted.
 *
 * Both halves deliberately happen inside the write transaction, from the
 * `getAllKeys` callback, rather than being decided by the caller from a cached
 * key set. A cached set is wrong as soon as a second tab of the builder touches
 * the same store: it would claim a blob is on disk that the other tab has since
 * pruned, and the draft would then reference a file record that does not exist —
 * which restore reports as artwork it could not reload.
 */
function writeDraft(
  database: IDBDatabase,
  draft: EditorDraft,
  files: DraftFileRecord[],
): Promise<void> {
  const transaction = database.transaction([DRAFT_STORE, FILE_STORE], "readwrite");
  const settled = new Promise<void>((resolve, reject) => {
    const fail = () => reject(transaction.error ?? new Error("Could not save editor draft"));
    transaction.onerror = fail;
    // Quota exhaustion surfaces as an abort, which would otherwise leave this
    // promise pending forever and hide the failure from the caller.
    transaction.onabort = fail;
    transaction.oncomplete = () => resolve();
  });

  transaction.objectStore(DRAFT_STORE).put(draft, CURRENT_DRAFT_KEY);
  const fileStore = transaction.objectStore(FILE_STORE);
  const referenced = new Set(referencedFileKeys(draft));
  const keysRequest = fileStore.getAllKeys();
  keysRequest.onsuccess = () => {
    const existing = new Set(
      keysRequest.result.filter((key): key is string => typeof key === "string"),
    );
    for (const file of files) {
      if (existing.has(file.key)) continue;
      fileStore.put(file);
    }
    // Deleting a design, replacing its pixels (background removal, halftone,
    // crop) and duplicating all mint new file keys, and nothing removed the old
    // ones — so the store grew for the lifetime of the browser profile until
    // quota exhaustion started failing every future save.
    for (const key of existing) {
      if (referenced.has(key)) continue;
      fileStore.delete(key);
    }
  };

  return settled;
}

/**
 * Set when the app has crashed. The in-memory editor state that produced a
 * crash is not what we want to hand back on the customer's next visit, and an
 * unmount flush would otherwise do exactly that. Cleared when the customer
 * dismisses the crash screen, so an unrelated one-off render error does not
 * cost them persistence for the rest of the session.
 */
let _savesDisabledReason: string | null = null;

export function disableDraftSaves(reason: string): void {
  _savesDisabledReason = reason;
}

export function enableDraftSaves(): void {
  _savesDisabledReason = null;
}

/**
 * Whether a rejected save failed because the origin is out of storage, as opposed
 * to any of the ordinary reasons a transaction aborts.
 *
 * Worth telling apart because the customer's options differ: nothing they do in
 * the editor fixes a full quota, so they have to be told, and retrying the same
 * multi-megabyte write on every keystroke afterwards achieves nothing.
 *
 * Checked more loosely than `name === "QuotaExceededError"` alone on purpose.
 * `code` 22 is the frozen legacy `DOMException.QUOTA_EXCEEDED_ERR` and is the
 * only signal on engines that never set a modern `name`; Safari has reported
 * this condition under the legacy constant name, and Firefox under an internal
 * one. Over-matching here costs a toast the customer would probably want anyway;
 * under-matching costs them the whole warning.
 */
export function isDraftQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  if (
    name === "QuotaExceededError" ||
    name === "QUOTA_EXCEEDED_ERR" ||
    name === "NS_ERROR_DOM_QUOTA_REACHED"
  ) {
    return true;
  }
  if (candidate.code === 22) return true;
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return message.includes("quota") || message.includes("not enough space");
}

export function saveCurrentEditorDraft(
  draft: EditorDraft,
  files: DraftFileRecord[],
): Promise<void> {
  if (_savesDisabledReason) {
    return Promise.reject(new Error(`Draft saving is disabled: ${_savesDisabledReason}`));
  }
  // Deliberately not `async`. A transaction opened before a
  // `visibilitychange` / `pagehide` handler returns is guaranteed by spec to
  // commit even if the page is then torn down; one `await` before
  // `database.transaction(...)` gives that guarantee up, which is the whole
  // reason the unload flush can be trusted. So the cached connection is used
  // synchronously and only a cold start pays the round trip.
  const cached = _cachedDb;
  if (cached) {
    try {
      return writeDraft(cached, draft, files);
    } catch (error) {
      // Only a dead connection is worth retrying on. `put()` also throws
      // synchronously when the value cannot be structured-cloned, and a
      // detached `ArrayBuffer` in `originalPdfData` is the realistic way that
      // happens. Retrying that on a fresh connection fails identically, so
      // treating it as staleness discarded the cached connection on *every*
      // subsequent save and quietly gave up the synchronous-commit guarantee
      // the unload flush depends on. Quota exhaustion is in the same category
      // and for the same reason: a `put()` that throws because the origin is
      // full throws identically on a fresh connection, so treating it as
      // staleness would drop the cached connection on every save for as long
      // as the customer stays over quota.
      if ((error as DOMException | null)?.name === "DataCloneError" || isDraftQuotaError(error)) {
        return Promise.reject(error);
      }
      // Connection went stale (schema upgrade in another tab, eviction).
      releaseCachedDatabase();
    }
  }
  return openDatabase().then(database => writeDraft(database, draft, files));
}

export async function deleteCurrentEditorDraft(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([DRAFT_STORE, FILE_STORE], "readwrite");
    const fail = () => reject(transaction.error ?? new Error("Could not delete editor draft"));
    transaction.onerror = fail;
    transaction.onabort = fail;
    transaction.oncomplete = () => resolve();
    transaction.objectStore(DRAFT_STORE).delete(CURRENT_DRAFT_KEY);
    // Every file record belongs to the single `current` draft, so clearing the
    // store is both simpler and more thorough than walking the draft's own
    // `fileKey`s — which would miss anything orphaned by an earlier save.
    transaction.objectStore(FILE_STORE).clear();
  });
}

/**
 * Last-resort recovery for a customer whose saved draft is stopping them using
 * the app at all (typically a full quota making every save fail). Prefers
 * emptying the stores over dropping the database: `deleteDatabase` blocks
 * behind any connection another tab still holds, while a readwrite transaction
 * does not. The delete is the fallback for when the database cannot be opened
 * at all — most plausibly a `VersionError` from a build rolled back below the
 * stored `DATABASE_VERSION`.
 *
 * Other open tabs are told via `broadcastDraftPurge` so they stop trusting a
 * record that has just been deleted out from under them.
 */
export async function purgeEditorDraftStorage(): Promise<void> {
  try {
    await deleteCurrentEditorDraft();
    broadcastDraftPurge();
    return;
  } catch (error) {
    console.warn("[editor-draft] clear failed, dropping the database instead", error);
  }
  releaseCachedDatabase();
  if (!canUseIndexedDb()) return;
  await new Promise<void>(resolve => {
    const request = window.indexedDB.deleteDatabase(DATABASE_NAME);
    // Any outcome is acceptable; the caller reloads either way and must never
    // be left waiting on a delete that another tab is blocking.
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
    setTimeout(resolve, 2000);
  });
  broadcastDraftPurge();
}

export async function requestPersistentEditorStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
  } catch {
    // Persistence is a best-effort browser permission and is not required.
  }
}

function fileSignature(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

/**
 * Cheap structural signature of the editor state that would be written to
 * IndexedDB. Callers cache the last-emitted signature and skip the debounced
 * save when it matches — React re-renders often produce a new `designs`
 * Array reference without any observable field changing, and saving those
 * to disk is pure overhead.
 *
 * Include every field that appears in `StoredDraftDesign` **except** binary
 * payloads (PDF bytes, image blobs) — those are keyed by `fileSignature`, so
 * changes to them are already captured by the surrounding metadata.
 */
export function computeDraftSignature(
  profileId: string,
  designs: DesignItem[],
  artboardWidth: number,
  artboardHeight: number,
  quantity: number,
  designGap: number,
  selectedDesignId: string | null,
  selectedDesignIds: Set<string>,
): string {
  const parts: string[] = [
    profileId,
    String(artboardWidth),
    String(artboardHeight),
    String(quantity),
    String(designGap),
    selectedDesignId ?? "",
    Array.from(selectedDesignIds).sort().join(","),
  ];
  for (const design of designs) {
    const info = design.imageInfo;
    const t = design.transform;
    parts.push([
      design.id,
      design.name,
      t.nx, t.ny, t.s, t.rotation,
      t.flipX ? 1 : 0,
      t.flipY ? 1 : 0,
      design.widthInches,
      design.heightInches,
      design.originalDPI,
      design.alphaThresholded ? 1 : 0,
      design.halftoned ? 1 : 0,
      design.halftoneSettings
        ? `${design.halftoneSettings.color.r},${design.halftoneSettings.color.g},${design.halftoneSettings.color.b},${design.halftoneSettings.strength}`
        : "-",
      design.printFileName ? 1 : 0,
      design.groupId ?? "",
      fileSignature(info.file),
      info.originalWidth,
      info.originalHeight,
      info.dpi,
      info.isPDF ? 1 : 0,
    ].join(":"));
  }
  return parts.join("|");
}

export function buildEditorDraft(
  profileId: string,
  designs: DesignItem[],
  artboardWidth: number,
  artboardHeight: number,
  quantity: number,
  designGap: number,
  selectedDesignId: string | null,
  selectedDesignIds: Set<string>,
): { draft: EditorDraft; files: DraftFileRecord[] } {
  const files: DraftFileRecord[] = [];
  const storedDesigns = designs.map((design): StoredDraftDesign => {
    const imageInfo = design.imageInfo;
    const file = imageInfo.file;
    const fileKey = `current:${design.id}:${fileSignature(file)}`;
    files.push({
      key: fileKey,
      blob: file,
      name: file.name,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
    });
    return {
      id: design.id,
      name: design.name,
      transform: { ...design.transform },
      widthInches: design.widthInches,
      heightInches: design.heightInches,
      originalDPI: design.originalDPI,
      alphaThresholded: design.alphaThresholded,
      halftoned: design.halftoned,
      halftoneSettings: design.halftoneSettings,
      printFileName: design.printFileName,
      groupId: design.groupId,
      fileKey,
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      fileLastModified: file.lastModified,
      originalWidth: imageInfo.originalWidth,
      originalHeight: imageInfo.originalHeight,
      dpi: imageInfo.dpi,
      isPDF: imageInfo.isPDF,
      originalPdfData: imageInfo.originalPdfData,
    };
  });

  return {
    draft: {
      schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
      savedAt: Date.now(),
      profileId,
      artboardWidth,
      artboardHeight,
      quantity,
      designGap,
      selectedDesignId,
      selectedDesignIds: Array.from(selectedDesignIds),
      designs: storedDesigns,
    },
    files,
  };
}

export async function restoreEditorDraft(draft: EditorDraft): Promise<{
  designs: DesignItem[];
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
  artboardWidth: number;
  artboardHeight: number;
  quantity: number;
  designGap: number;
}> {
  const restoredDesigns: DesignItem[] = [];
  for (const stored of draft.designs) {
    if (!hasUsableGeometry(stored)) {
      console.warn("[editor-draft] dropping design with unusable geometry", stored?.id);
      continue;
    }
    const imageInfo = await restoreStoredDesignImage(stored);
    if (!imageInfo) continue;
    restoredDesigns.push({
      id: stored.id,
      name: stored.name,
      imageInfo,
      originalDPI: stored.originalDPI,
      widthInches: stored.widthInches,
      heightInches: stored.heightInches,
      transform: { ...stored.transform },
      alphaThresholded: stored.alphaThresholded,
      halftoned: stored.halftoned,
      halftoneSettings: stored.halftoneSettings,
      printFileName: stored.printFileName,
      groupId: stored.groupId,
    });
  }

  const validIds = new Set(restoredDesigns.map(design => design.id));
  const selectedDesignId = draft.selectedDesignId && validIds.has(draft.selectedDesignId)
    ? draft.selectedDesignId
    : restoredDesigns[restoredDesigns.length - 1]?.id ?? null;
  const selectedDesignIds = new Set(
    draft.selectedDesignIds.filter(id => validIds.has(id)),
  );
  if (selectedDesignId && selectedDesignIds.size === 0) selectedDesignIds.add(selectedDesignId);

  return {
    designs: restoredDesigns,
    selectedDesignId,
    selectedDesignIds,
    artboardWidth: draft.artboardWidth,
    artboardHeight: draft.artboardHeight,
    quantity: draft.quantity,
    designGap: draft.designGap,
  };
}
