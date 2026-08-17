import type { DesignItem, ImageInfo, ImageTransform } from "@/lib/types";
import type { VectorInkBox } from "@/lib/vector-trim";
import { capRestoredPreview } from "@/lib/draft-preview-cap";
import { broadcastDraftPurge } from "@/lib/draft-tab-ownership";

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
 *
 * 2: the persisted blob is now the design's content-cropped preview rather than
 *    the raw upload. Version 1 records pair a *cropped* `widthInches` with an
 *    *uncropped* blob, so restoring one stretches the whole bitmap into the
 *    artwork's box — the artwork comes back smaller and re-centred, and the
 *    recovered sheet prints differently from the one that was built. There is no
 *    way to tell that apart from an intentionally uncropped upload, so those
 *    records are dropped instead of restored wrongly.
 *
 *    Also in 2: a vector design's retained source (`originalPdfData` bytes, or
 *    `svgSource` text) moved out of this record and into the file store beside
 *    the image blobs, keyed by `pdfKey` / `svgKey`. It is folded into the same
 *    version rather than given a 3 of its own because version 2 has not shipped
 *    — no build carrying it has been committed, let alone deployed — and every
 *    bump discards unsent work, so bumping twice for two changes that reach
 *    customers together would cost drafts for no benefit.
 *
 *    Also in 2, for the same unshipped-schema reason: `designGap` became
 *    nullable so the "Auto" setting survives the round trip instead of being
 *    flattened to 0, and `manualHeightFloor` joined `artboardHeight`. Both are
 *    tolerant of absence on read, so a record written by an earlier build of
 *    this same unshipped version still restores.
 *
 *    Also in 2, again for the same reason: `submittedAt` marks a sheet that has
 *    reached the cart. It is optional and only ever read as "is it a number",
 *    so a record written by an earlier build of version 2 — which has none —
 *    reads as not-submitted and restores exactly as it did before.
 */
export const CURRENT_DRAFT_SCHEMA_VERSION = 2;

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

/**
 * Whether a draft belongs to the product the customer is looking at.
 *
 * `profileId` was written into every record and never read back, and the record
 * key is `current` regardless of product — so a customer who built a hot-peel
 * sheet and then opened a different product (`/uv-dtf`, say) was offered their
 * hot-peel work and could restore its geometry onto the wrong film. That is a
 * wrong-order risk, not a presentation wrinkle: the sheet size, placements and
 * DPI expectations all belong to the other product.
 *
 * A non-matching draft is **hidden, not discarded**. The customer is very likely
 * to go back to the product they were building for, and deleting a stranger's
 * sheet because they glanced at another page would destroy work over a
 * navigation. It still ages out through the normal 7-day expiry, which runs
 * ahead of this check, so hiding does not make it immortal.
 *
 * A record with no readable `profileId` counts as non-matching: it cannot be
 * shown to be safe for this product, and hiding it costs nothing permanent.
 */
export function isEditorDraftForProfile(
  draft: Pick<EditorDraft, "profileId">,
  profileId: string,
): boolean {
  return typeof draft.profileId === "string" && draft.profileId === profileId;
}

/**
 * Whether this record is a sheet the customer has already sent to the cart.
 *
 * Such a record is **kept but not offered**. Not offered because the customer
 * did not leave this work unfinished — they ordered it, and being asked to
 * "recover" it on their next visit reads as though the order did not go
 * through. Kept because `done` from the storefront shell means the cart request
 * returned, which is not the same as the order being paid for: if checkout
 * later fails, the sheet is still on disk and can be recovered by hand instead
 * of having been destroyed at the moment of least evidence.
 *
 * It is not immortal. The 7-day expiry runs *ahead* of this check on every
 * entry point, so a submitted record and its blobs are reclaimed on exactly the
 * same schedule as any other, and the next real edit overwrites it outright.
 *
 * A missing or unreadable stamp counts as not-submitted, which is the safe
 * direction: the customer is offered work they may not need rather than
 * silently denied work they do.
 */
export function isEditorDraftSubmitted(
  draft: Pick<EditorDraft, "submittedAt">,
  now: number = Date.now(),
): boolean {
  const submittedAt = draft.submittedAt;
  if (typeof submittedAt !== "number" || !Number.isFinite(submittedAt) || submittedAt <= 0) {
    return false;
  }
  // A stamp from the future is a wrong clock, not a signal, and treating it as
  // one would suppress recovery for a sheet that was never submitted.
  return submittedAt <= now + DRAFT_MAX_AGE_MS;
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
  /**
   * File-store keys for the design's retained vector source, kept so a restored
   * draft still exports vector artwork at print resolution rather than from the
   * import preview.
   *
   * The bytes themselves used to live in this record. That made them part of
   * what every page load deserialises, because the availability check reads the
   * whole record before it can decide whether to offer anything — so a couple of
   * large vector imports became a permanent per-load cost that nothing but
   * clearing site data removed. In the file store they are fetched only when a
   * design is actually restored or repaired.
   */
  pdfKey?: string;
  svgKey?: string;
  /** Without this a restored vector design would re-render its whole page into
   *  the trimmed artwork's box at export. */
  vectorInkBox?: VectorInkBox;
  groupId?: string;
  editSplit?: string;
}

export interface EditorDraft {
  schemaVersion: typeof CURRENT_DRAFT_SCHEMA_VERSION;
  savedAt: number;
  /**
   * When this sheet was confirmed into the cart, or absent if it never was.
   *
   * Written by `markCurrentEditorDraftSubmitted` onto whatever record is on
   * disk; deliberately *not* produced by `buildEditorDraft`, so the very next
   * save the customer's editing triggers writes a record without it and
   * recovery resumes. That is the whole of "keep editing and the stamp clears"
   * — there is no separate un-stamp path to keep in step.
   */
  submittedAt?: number;
  profileId: string;
  artboardWidth: number;
  artboardHeight: number;
  /**
   * Height the customer picked by hand, which auto-shrink treats as a floor. Persisted
   * beside `artboardHeight` for the same reason the undo snapshot carries it: a reload that
   * restored the height without the pick leaves the sheet at 120" with nothing defending it,
   * so the next delete drops the customer to the smallest fitting rung and silently discards
   * the size they chose on purpose. `null` is "no pick".
   *
   * Restoring a stale one is safe in the only direction that matters — the floor can block a
   * shrink but can never grow the sheet.
   */
  manualHeightFloor: number | null;
  quantity: number;
  /**
   * `null` is the "Auto" margin setting, which is emphatically **not** 0: Auto means the
   * sheet-edge margin falls back to `DEFAULT_SHEET_MARGIN` and the packer picks its own gap,
   * whereas 0 is a customer asking for designs butted together. Writing Auto as 0 made the
   * two indistinguishable on the way back in, so a restored draft reseated artwork flush
   * against the sheet edge and rendered the margin dropdown blank.
   */
  designGap: number | null;
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
 *
 * What happens to it afterwards is deliberately *asymmetric* — see
 * `classifyDraftVersion`.
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
 * still ages out through the normal 7-day expiry, so it is not immortal either.
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
 *  touches the design. Such a design is dropped and reported through
 *  `missingDesignCount` rather than restored. */
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
 * the caller's earlier read, for the same reason file-store reconciliation
 * happens inside the write transaction: between the read and this delete another
 * tab may have replaced the obsolete record with a current one and written blobs
 * for it, and deleting then would take that tab's artwork with it. Re-checking
 * under the transaction makes the delete unconditionally safe — it can only ever
 * destroy a record that no build in play can read.
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
  if (isUsableDraft(value)) return value;
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

/**
 * Vector source keys that are known to be **on disk but unreadable right now**,
 * by design id.
 *
 * The failure this exists for: `blob.arrayBuffer()` on a large PDF (the import
 * ceiling is 100 MB) can fail transiently — an allocation that does not land
 * under memory pressure. The design still restores, just without
 * `originalPdfData`. Nothing was wrong with the blob, but the *next* autosave
 * then built a record with no `pdfKey` in it, because `storeVectorSource` has no
 * bytes to write, and the reconciliation sweep in `writeDraft` deletes every key
 * the record no longer names. One transient read failure therefore converted the
 * design from vector print quality to preview quality permanently, for that
 * recovery and every future one, with the blob deleted from under exactly the
 * key that would have been reused.
 *
 * So the key is remembered and carried into the next record even with no bytes
 * behind it. That keeps the blob alive for a later session to retry, and it is
 * *precise* rather than a blanket exemption from the sweep: see
 * `retainedVectorKey` for the two conditions under which the key is allowed
 * through, both of which are needed to keep a genuinely superseded blob
 * collectable.
 */
const unreadableVectorKeys = new Map<string, { pdfKey?: string; svgKey?: string }>();

function rememberUnreadableVectorKeys(
  designId: string,
  keys: { pdfKey?: string; svgKey?: string },
): void {
  if (keys.pdfKey || keys.svgKey) unreadableVectorKeys.set(designId, keys);
  // A read that succeeded — or found nothing there at all — retires the entry:
  // in the first case the bytes are back and the normal path writes the key, in
  // the second there is no blob left to protect.
  else unreadableVectorKeys.delete(designId);
}

/**
 * Pulls a vector design's retained source back out of the file store. Only
 * reached when a design is genuinely being restored or repaired, which is the
 * whole point of it no longer living in the draft record.
 *
 * A missing record loses print resolution but not the design: its raster
 * preview is still there, so export falls back to the preview exactly as it does
 * for a vector import whose re-rasterise fails. That shortfall is reported to
 * the customer through the same reduced-quality count as any other, because it
 * is measured from the pixels the restored design actually has.
 *
 * The two reads are separately guarded rather than sharing one `try`, so a PDF
 * that fails does not also skip an SVG that would have succeeded.
 */
async function loadStoredVectorSource(stored: StoredDraftDesign): Promise<{
  originalPdfData?: ArrayBuffer;
  svgSource?: string;
}> {
  const result: { originalPdfData?: ArrayBuffer; svgSource?: string } = {};
  let unreadablePdfKey: string | undefined;
  let unreadableSvgKey: string | undefined;
  if (stored.pdfKey) {
    try {
      const record = await getDraftFile(stored.pdfKey);
      if (record?.blob) result.originalPdfData = await record.blob.arrayBuffer();
    } catch (error) {
      // A *present* blob we could not read. `getDraftFile` returning null is not
      // this case and deliberately does not land here: there is nothing on disk
      // to hold on to, so the key should be allowed to go.
      unreadablePdfKey = stored.pdfKey;
      console.warn("[editor-draft] vector source restore failed", stored.pdfKey, error);
    }
  }
  if (stored.svgKey) {
    try {
      const record = await getDraftFile(stored.svgKey);
      if (record?.blob) result.svgSource = await record.blob.text();
    } catch (error) {
      unreadableSvgKey = stored.svgKey;
      console.warn("[editor-draft] vector source restore failed", stored.svgKey, error);
    }
  }
  rememberUnreadableVectorKeys(stored.id, {
    pdfKey: unreadablePdfKey,
    svgKey: unreadableSvgKey,
  });
  return result;
}

interface RestoredStoredImage {
  info: ImageInfo;
  /**
   * Dimensions of the persisted blob, *before* the preview cap. This is the
   * print source a restored design has, so it is what the achievable print
   * resolution has to be measured from — `info.originalWidth` is the capped
   * preview and would understate it.
   */
  sourcePixelWidth: number;
  sourcePixelHeight: number;
}

async function restoreStoredDesignImage(
  stored: StoredDraftDesign,
): Promise<RestoredStoredImage | null> {
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
    const sourcePixelWidth = image.naturalWidth || image.width;
    const sourcePixelHeight = image.naturalHeight || image.height;
    const vector = await loadStoredVectorSource(stored);
    // The stored blob is the design's uncapped pixels, so the preview rebuilt
    // from it is capped the way the upload path caps it and the blob itself
    // becomes the print source — otherwise a restored sheet holds previews an
    // order of magnitude larger than the session that saved it, and export
    // falls back to upscaling the preview.
    const capped = await capRestoredPreview(image, fileRecord.blob, {
      preserveCleanAlpha: stored.alphaThresholded || stored.halftoned,
    });
    return {
      info: {
        file,
        image: capped.image,
        originalWidth: capped.width,
        originalHeight: capped.height,
        dpi: stored.dpi,
        isPDF: stored.isPDF,
        originalPdfData: vector.originalPdfData,
        svgSource: vector.svgSource,
        exportBlob: capped.exportBlob,
        vectorInkBox: stored.vectorInkBox,
      },
      sourcePixelWidth,
      sourcePixelHeight,
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
  return (await restoreStoredDesignImage(stored))?.info ?? null;
}

/**
 * Every file-store key the draft still needs. The reconciliation below deletes
 * whatever this does not list, so a vector source omitted from it would be swept
 * away on the very next save and the design would silently lose print
 * resolution — which is why it is derived here rather than spelled out inline.
 */
function referencedFileKeys(draft: EditorDraft): string[] {
  const keys: string[] = [];
  for (const design of draft.designs) {
    keys.push(design.fileKey);
    if (design.pdfKey) keys.push(design.pdfKey);
    if (design.svgKey) keys.push(design.svgKey);
  }
  return keys;
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
 * crash is not what we want to hand back on the customer's next visit, and the
 * unmount flush would otherwise do exactly that: React tears the tree down when
 * an error reaches the boundary, effect cleanups run, and the crashing state is
 * written over the last good draft. Cleared when the customer dismisses the
 * crash screen, so an unrelated one-off render error does not cost them
 * persistence for the rest of the session.
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
      // happens — pdf.js transfers whatever buffer it is handed. Retrying that
      // on a fresh connection fails identically, so treating it as staleness
      // discarded the cached connection on *every* subsequent save and quietly
      // gave up the synchronous-commit guarantee the unload flush depends on.
      // Quota exhaustion is in the same category and for the same reason: a
      // `put()` that throws because the origin is full throws identically on a
      // fresh connection, so treating it as staleness would drop the cached
      // connection on every save for as long as the customer stays over quota —
      // giving up the synchronous-commit guarantee precisely when their work is
      // least safe.
      if ((error as DOMException | null)?.name === "DataCloneError" || isDraftQuotaError(error)) {
        return Promise.reject(error);
      }
      // Connection went stale (schema upgrade in another tab, eviction).
      releaseCachedDatabase();
    }
  }
  return openDatabase().then(database => writeDraft(database, draft, files));
}

/**
 * Last-resort recovery for a customer whose saved draft is stopping them using
 * the app at all. Prefers emptying the stores over dropping the database:
 * `deleteDatabase` blocks behind any connection another tab still holds, while
 * a readwrite transaction does not. The delete is the fallback for when the
 * database cannot be opened at all — most plausibly a `VersionError` from a
 * build rolled back below the stored `DATABASE_VERSION`.
 *
 * Deliberately **not** gated on `isDraftOwner()`, unlike `deleteCurrentEditorDraft`'s
 * other callers. This is the escape hatch from a crash loop, and the tab that
 * crashed is quite often the one that lost the election — gating it there would
 * leave that customer with a broken editor and a button that does nothing, which
 * is a worse failure than the one the gate prevents. The record is shared
 * though, so the other tabs are told instead: they hear `purge` and re-save
 * their own state (see `broadcastDraftPurge` and `subscribeDraftPurge`), which
 * turns "the healthy tab's work was destroyed" into "the healthy tab wrote it
 * again a moment later".
 *
 * The announcement is deliberately after the delete rather than before it, so a
 * peer's re-save cannot land in the middle of the clear and be swept away by it.
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
  // Announced on this path too. `deleteDatabase` may well have been blocked by
  // the very tab that needs to hear about it, but a peer that re-saves after a
  // blocked delete is harmless — it writes into the database it is still holding
  // open — whereas a peer that is *not* told carries on trusting a record that
  // may be gone.
  broadcastDraftPurge();
}

/**
 * Stamps the stored draft as sent to the cart, instead of deleting it.
 *
 * The record and **every blob behind it stay exactly where they are**. That is
 * the point of this function existing rather than the caller calling
 * `deleteCurrentEditorDraft`: `done` from the storefront shell most likely means
 * the cart request returned 200, which is not evidence the order is durable, and
 * a customer whose checkout then fails should still have their sheet. The
 * file store is deliberately not touched at all — not written, not reconciled —
 * because reconciliation is what would collect the artwork this is trying to
 * preserve, and there is nothing new to write.
 *
 * Read-modify-write inside one `readwrite` transaction, so a save landing at the
 * same moment either loses to it or overwrites it wholesale; it can never
 * interleave and produce a record that is half one and half the other.
 *
 * Returns whether a record was actually stamped. Nothing to stamp is a normal
 * outcome — a non-owner tab, or a sheet that never reached disk — so it is
 * reported rather than thrown.
 */
export async function markCurrentEditorDraftSubmitted(
  submittedAt: number = Date.now(),
): Promise<boolean> {
  const database = await openDatabase();
  return await new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    let stamped = false;
    const fail = () => reject(transaction.error ?? new Error("Could not mark the draft submitted"));
    transaction.onerror = fail;
    transaction.onabort = fail;
    transaction.oncomplete = () => resolve(stamped);

    const store = transaction.objectStore(DRAFT_STORE);
    const read = store.get(CURRENT_DRAFT_KEY);
    read.onsuccess = () => {
      const existing = read.result;
      // Only a record this build can read. An obsolete one is garbage that
      // `getCurrentEditorDraft` will collect, and a record written by a *newer*
      // deploy is not ours to add fields to.
      if (!isUsableDraft(existing)) return;
      stamped = true;
      store.put({ ...existing, submittedAt }, CURRENT_DRAFT_KEY);
    };
  });
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
    // `fileKey`s — which missed anything orphaned by an earlier save, and read
    // the draft in a *separate* transaction that a concurrent save could win.
    transaction.objectStore(FILE_STORE).clear();
  });
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
 * Size of whatever vector source the design retains, or 0 for a raster design.
 * A detached `ArrayBuffer` reports zero length, which is the right answer here:
 * pdf.js transfers whatever buffer it is handed, and a transferred one is no
 * longer a print source.
 */
function vectorSourceByteLength(info: ImageInfo): number {
  if (info.svgSource) return info.svgSource.length;
  try {
    return info.originalPdfData?.byteLength ?? 0;
  } catch {
    return 0;
  }
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
 * changes to them are already captured by the surrounding metadata. A vector
 * source contributes its *size* only, for the same reason: enough to notice one
 * appearing, disappearing, or being replaced, without reading the bytes.
 */
export function computeDraftSignature(
  profileId: string,
  designs: DesignItem[],
  artboardWidth: number,
  artboardHeight: number,
  manualHeightFloor: number | null,
  quantity: number,
  designGap: number | undefined,
  selectedDesignId: string | null,
  selectedDesignIds: Set<string>,
): string {
  const parts: string[] = [
    profileId,
    String(artboardWidth),
    String(artboardHeight),
    // Picking the height the sheet is already on records a floor without moving the sheet,
    // so this has to be part of the signature or that pick never reaches disk.
    String(manualHeightFloor),
    String(quantity),
    // `String(undefined)` is "undefined", which is what keeps Auto distinguishable from 0
    // here as well — otherwise switching between them would not trigger a save.
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
      design.editSplit ?? "",
      fileSignature(info.file),
      info.originalWidth,
      info.originalHeight,
      info.dpi,
      info.isPDF ? 1 : 0,
      vectorSourceByteLength(info),
    ].join(":"));
  }
  return parts.join("|");
}

/**
 * Whether an unreadable-but-present key may be named in the record being written,
 * which is what keeps the reconciliation sweep from deleting the blob behind it.
 *
 * One condition, and it is the whole leak-prevention argument: the key has to be
 * *exactly* the key this design would write today. `vectorBase` folds in
 * `fileSignature(file)`, so any edit that mints new pixels — background removal,
 * halftone, crop, upscale — moves the key, the old one fails this test, and the
 * superseded blob is collected on that same save. A design that has left the
 * sheet is never asked about at all. So a blob survives only while the design
 * that owns it is still there with the source it had when the read failed.
 */
function retainedVectorKey(
  candidate: string | undefined,
  vectorBase: string,
  suffix: string,
): string | undefined {
  if (!candidate) return undefined;
  return candidate === `${vectorBase}:${suffix}` ? candidate : undefined;
}

export function buildEditorDraft(
  profileId: string,
  designs: DesignItem[],
  artboardWidth: number,
  artboardHeight: number,
  manualHeightFloor: number | null,
  quantity: number,
  designGap: number | undefined,
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

    // Vector sources become blobs beside the image so the draft *record* stays
    // small. Keyed off the same file signature as the preview, so an edit that
    // discards the vector geometry and mints a new preview also strands the old
    // source for the reconciliation pass to collect.
    //
    // Errors are swallowed rather than propagated: this runs inside the unload
    // flush, and a design whose buffer pdf.js has since transferred must cost
    // that one design its print resolution, not the whole sheet its save.
    const vectorBase = `current:${design.id}:vector:${fileSignature(file)}`;
    const storeVectorSource = (
      suffix: string,
      type: string,
      part: () => BlobPart | null,
    ): string | undefined => {
      try {
        const content = part();
        if (content === null) return undefined;
        const key = `${vectorBase}:${suffix}`;
        files.push({
          key,
          blob: new Blob([content], { type }),
          name: `${file.name}.source.${suffix}`,
          type,
          lastModified: file.lastModified,
        });
        return key;
      } catch (error) {
        console.warn("[editor-draft] could not persist vector source", design.id, suffix, error);
        return undefined;
      }
    };
    // Falling back to a remembered key is what stops a transient read failure
    // from being a permanent one — the bytes are absent from memory, but the
    // blob is still on disk and naming it here is what keeps it there.
    const retained = unreadableVectorKeys.get(design.id);
    const pdfKey = storeVectorSource("pdf", "application/pdf", () => {
      const bytes = imageInfo.originalPdfData;
      return bytes && bytes.byteLength > 0 ? bytes : null;
    }) ?? retainedVectorKey(retained?.pdfKey, vectorBase, "pdf");
    const svgKey = storeVectorSource("svg", "image/svg+xml", () =>
      imageInfo.svgSource ? imageInfo.svgSource : null,
    ) ?? retainedVectorKey(retained?.svgKey, vectorBase, "svg");

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
      editSplit: design.editSplit,
      fileKey,
      fileName: file.name,
      fileType: file.type || "application/octet-stream",
      fileLastModified: file.lastModified,
      originalWidth: imageInfo.originalWidth,
      originalHeight: imageInfo.originalHeight,
      dpi: imageInfo.dpi,
      isPDF: imageInfo.isPDF,
      pdfKey,
      svgKey,
      vectorInkBox: imageInfo.vectorInkBox,
    };
  });

  // Bound the side table. A design that has gone from the sheet can never have
  // its key carried forward again, so the entry is dead weight.
  if (unreadableVectorKeys.size > 0) {
    const liveIds = new Set(designs.map(design => design.id));
    for (const id of unreadableVectorKeys.keys()) {
      if (!liveIds.has(id)) unreadableVectorKeys.delete(id);
    }
  }

  return {
    draft: {
      // No `submittedAt`: this record is what the customer has on screen now, so
      // writing it is itself the evidence that they carried on working after a
      // submit. See `EditorDraft.submittedAt`.
      schemaVersion: CURRENT_DRAFT_SCHEMA_VERSION,
      savedAt: Date.now(),
      profileId,
      artboardWidth,
      artboardHeight,
      manualHeightFloor,
      quantity,
      // `undefined` would survive a structured clone, but `null` says "Auto" out loud in a
      // record a human may end up reading in the IndexedDB inspector.
      designGap: designGap ?? null,
      selectedDesignId,
      selectedDesignIds: Array.from(selectedDesignIds),
      designs: storedDesigns,
    },
    files,
  };
}

/**
 * The DPI below which the editor badges a design amber. Restoring a design into
 * this band when it was above it is the case worth interrupting the customer
 * for, so the threshold is shared rather than guessed at.
 */
const RESTORED_LOW_DPI_THRESHOLD = 277;

/**
 * Rounding tolerance. `widthInches` is derived from the source pixel count by a
 * division, so multiplying back never lands exactly and a strict comparison
 * would flag every design.
 */
const SOURCE_PIXEL_TOLERANCE = 0.98;

/**
 * Whether a restored design prints materially worse than the one that was saved.
 *
 * A draft persists the design's *preview* blob, and for a server-prepared upload
 * (anything over 40 MP) that preview is smaller than the original the session was
 * printing from. Recovery therefore promotes the preview to print source, and
 * artwork placed large enough comes back well below print resolution — measured
 * as low as ~154 DPI, squarely inside the amber band the editor already warns
 * about. The storage stays as it is — persisting originals routinely blows the
 * quota — but a design that fails this bar is left OFF the restored sheet
 * entirely. That is the owner's rule: recovery must never hand back artwork
 * below print quality, because a sheet full of soft copies has to be deleted
 * one by one before rebuilding, which is worse than just starting fresh.
 *
 * Two conditions, both required:
 *   1. the persisted blob really does hold fewer pixels than the saving session's
 *      print source did — otherwise nothing was lost and there is nothing to say;
 *   2. what is left cannot reach `RESTORED_LOW_DPI_THRESHOLD` at the size the
 *      design is actually placed at — otherwise the loss is invisible in print
 *      and warning about it would just be noise.
 *
 * A design with a vector source is exempt: it re-rasterises from geometry at
 * whatever size it is placed, so its pixel count says nothing about print
 * quality. A design whose vector source did *not* come back is not exempt, and
 * that is deliberate — it is now printing from its preview like any other.
 */
function isPrintQualityReduced(
  stored: StoredDraftDesign,
  restored: ImageInfo,
  sourcePixelWidth: number,
  sourcePixelHeight: number,
): boolean {
  if (restored.svgSource) return false;
  if (restored.originalPdfData && restored.originalPdfData.byteLength > 0) return false;
  if (!isPositiveFinite(sourcePixelWidth) || !isPositiveFinite(sourcePixelHeight)) return false;
  if (!isPositiveFinite(stored.dpi)) return false;

  // `widthInches` was computed as sourcePixels / dpi at upload, so multiplying
  // back recovers the pixel count the session's print source had.
  const savedPixelWidth = stored.widthInches * stored.dpi;
  const savedPixelHeight = stored.heightInches * stored.dpi;
  const lostPixels =
    sourcePixelWidth < savedPixelWidth * SOURCE_PIXEL_TOLERANCE ||
    sourcePixelHeight < savedPixelHeight * SOURCE_PIXEL_TOLERANCE;
  if (!lostPixels) return false;

  const scale = stored.transform.s;
  const placedWidth = stored.widthInches * scale;
  const placedHeight = stored.heightInches * scale;
  if (!isPositiveFinite(placedWidth) || !isPositiveFinite(placedHeight)) return false;
  const achievableDpi = Math.min(
    sourcePixelWidth / placedWidth,
    sourcePixelHeight / placedHeight,
  );
  return achievableDpi < RESTORED_LOW_DPI_THRESHOLD;
}

/**
 * Unlike the sheet scalars a bad gap has an obvious safe value, so it is repaired rather than
 * the whole draft being thrown away over it.
 *
 * Absent, null and non-finite all come back as Auto, and so does a negative one. Auto rather
 * than 0 is the deliberate part: 0 is a real setting the customer can choose, and using it as
 * the repair value for garbage is exactly what put ink on the sheet edge. Auto is the value
 * that behaves sensibly whatever the record held.
 */
function restoredDesignGap(stored: EditorDraft["designGap"]): number | undefined {
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored < 0) return undefined;
  return stored;
}

/** Anything that is not a usable height is "no pick", which is the state that lets the sheet
 *  shrink freely — so a broken value costs the customer nothing but the pin. */
function restoredManualHeightFloor(stored: EditorDraft["manualHeightFloor"]): number | null {
  return isPositiveFinite(stored) ? stored : null;
}

export async function restoreEditorDraft(draft: EditorDraft): Promise<{
  designs: DesignItem[];
  selectedDesignId: string | null;
  selectedDesignIds: Set<string>;
  artboardWidth: number;
  artboardHeight: number;
  manualHeightFloor: number | null;
  quantity: number;
  /** `undefined` is the "Auto" setting — see `EditorDraft.designGap`. */
  designGap: number | undefined;
  /**
   * Designs in the draft whose stored image could not be reloaded. They are
   * dropped from the result, so the caller has to tell the customer rather than
   * hand back a sheet that is quietly missing artwork.
   */
  missingDesignCount: number;
  /**
   * Designs whose stored image survived only below the print resolution they
   * were built at. They are NOT restored — see `isPrintQualityReduced` for the
   * policy — so the caller has to tell the customer to upload those originals
   * again, not that they are on the sheet.
   */
  reducedQualityDesignCount: number;
}> {
  const restoredDesigns: DesignItem[] = [];
  let reducedQualityDesignCount = 0;
  for (const stored of draft.designs) {
    if (!hasUsableGeometry(stored)) {
      console.warn("[editor-draft] dropping design with unusable geometry", stored?.id);
      continue;
    }
    const restored = await restoreStoredDesignImage(stored);
    if (!restored) continue;
    const { info: imageInfo } = restored;
    if (isPrintQualityReduced(stored, imageInfo, restored.sourcePixelWidth, restored.sourcePixelHeight)) {
      reducedQualityDesignCount += 1;
      continue;
    }
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
      editSplit: stored.editSplit,
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
    manualHeightFloor: restoredManualHeightFloor(draft.manualHeightFloor),
    quantity: draft.quantity,
    designGap: restoredDesignGap(draft.designGap),
    // Quality-withheld designs get their own count; without the subtraction
    // they would double as "missing artwork" in the caller's toasts.
    missingDesignCount: draft.designs.length - restoredDesigns.length - reducedQualityDesignCount,
    reducedQualityDesignCount,
  };
}