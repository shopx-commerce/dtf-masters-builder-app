import type { DesignItem, ImageInfo, ImageTransform } from "@/lib/types";

const DATABASE_NAME = "sticker-editor-drafts";
const DATABASE_VERSION = 1;
const DRAFT_STORE = "drafts";
const FILE_STORE = "files";
const CURRENT_DRAFT_KEY = "current";

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
}

export interface EditorDraft {
  schemaVersion: 1;
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Could not open draft storage"));
    request.onsuccess = () => resolve(request.result);
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
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error("Draft storage request failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

export async function getCurrentEditorDraft(): Promise<EditorDraft | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(DRAFT_STORE, "readonly");
    return await requestResult<EditorDraft | undefined>(
      transaction.objectStore(DRAFT_STORE).get(CURRENT_DRAFT_KEY),
    ).then(value => value ?? null);
  } finally {
    database.close();
  }
}

export async function getDraftFile(key: string): Promise<DraftFileRecord | null> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(FILE_STORE, "readonly");
    return await requestResult<DraftFileRecord | undefined>(
      transaction.objectStore(FILE_STORE).get(key),
    ).then(value => value ?? null);
  } finally {
    database.close();
  }
}

export async function saveCurrentEditorDraft(
  draft: EditorDraft,
  files: DraftFileRecord[],
): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([DRAFT_STORE, FILE_STORE], "readwrite");
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not save editor draft"));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(DRAFT_STORE).put(draft, CURRENT_DRAFT_KEY);
      const fileStore = transaction.objectStore(FILE_STORE);
      for (const file of files) fileStore.put(file);
    });
  } finally {
    database.close();
  }
}

export async function deleteCurrentEditorDraft(): Promise<void> {
  const database = await openDatabase();
  try {
    const draft = await getCurrentEditorDraftFromDatabase(database);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction([DRAFT_STORE, FILE_STORE], "readwrite");
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete editor draft"));
      transaction.oncomplete = () => resolve();
      transaction.objectStore(DRAFT_STORE).delete(CURRENT_DRAFT_KEY);
      if (draft) {
        const fileStore = transaction.objectStore(FILE_STORE);
        for (const design of draft.designs) fileStore.delete(design.fileKey);
      }
    });
  } finally {
    database.close();
  }
}

async function getCurrentEditorDraftFromDatabase(database: IDBDatabase): Promise<EditorDraft | null> {
  const transaction = database.transaction(DRAFT_STORE, "readonly");
  return await requestResult<EditorDraft | undefined>(
    transaction.objectStore(DRAFT_STORE).get(CURRENT_DRAFT_KEY),
  ).then(value => value ?? null);
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
      schemaVersion: 1,
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
    const fileRecord = await getDraftFile(stored.fileKey);
    if (!fileRecord) continue;
    const file = new File([fileRecord.blob], stored.fileName, {
      type: stored.fileType,
      lastModified: stored.fileLastModified,
    });
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`Could not restore ${stored.fileName}`));
        image.src = objectUrl;
      });
      restoredDesigns.push({
        id: stored.id,
        name: stored.name,
        imageInfo: {
          file,
          image,
          originalWidth: stored.originalWidth,
          originalHeight: stored.originalHeight,
          dpi: stored.dpi,
          isPDF: stored.isPDF,
          originalPdfData: stored.originalPdfData,
        },
        originalDPI: stored.originalDPI,
        widthInches: stored.widthInches,
        heightInches: stored.heightInches,
        transform: { ...stored.transform },
        alphaThresholded: stored.alphaThresholded,
        halftoned: stored.halftoned,
        halftoneSettings: stored.halftoneSettings,
        printFileName: stored.printFileName,
      });
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      console.warn("[editor-draft] skipped unreadable file", error);
    }
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