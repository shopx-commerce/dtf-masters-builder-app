/**
 * Bounded LRU cache for layer-panel thumbnails, backed by a plain `Map`.
 *
 * The `useImageEditorModelStateDesign` hook owns a
 * `useRef<Map<string, string>>` where the key is the source image's blob URL
 * (or design id) and the value is either a `blob:` URL from the thumbnail
 * worker or a `data:image/png;base64,…` URL from the main-thread fallback.
 * Without a cap the map grows for the lifetime of the tab — every uploaded
 * design leaves a permanent entry behind, and every `blob:` URL keeps its
 * decoded thumbnail pinned in browser memory.
 *
 * These helpers give the map a bounded size (`MAX_THUMBNAIL_CACHE_ENTRIES`)
 * and revoke `blob:` URLs on eviction so the browser can reclaim them. We
 * rely on `Map`'s insertion-order guarantee: `delete` + `set` bumps a key to
 * the end of iteration, so the oldest entries live at the head and are the
 * ones evicted first.
 */

export const MAX_THUMBNAIL_CACHE_ENTRIES = 200;

function revokeIfBlobUrl(value: string | undefined): void {
  if (value && value.startsWith("blob:")) URL.revokeObjectURL(value);
}

/**
 * Remove an entry and revoke its blob URL (if any). No-op when the key is
 * not present.
 */
export function revokeThumbnailCacheEntry(cache: Map<string, string>, key: string): void {
  const value = cache.get(key);
  revokeIfBlobUrl(value);
  cache.delete(key);
}

/**
 * Look up an entry and mark it most-recently used. Returns `undefined` when
 * the key is not cached. Prefer this over `cache.get(key)` so LRU order
 * stays accurate.
 */
export function getThumbnailCacheEntry(
  cache: Map<string, string>,
  key: string,
): string | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

/**
 * Insert or replace an entry as most-recently used, evicting the oldest
 * entries until the cache size is within `max`. If a `blob:` URL is being
 * displaced by a different `blob:` URL the old one is revoked. Callers
 * should have already created the new URL and pass it in — this helper
 * takes ownership of everything already in the map.
 */
export function setThumbnailCacheEntry(
  cache: Map<string, string>,
  key: string,
  value: string,
  max: number = MAX_THUMBNAIL_CACHE_ENTRIES,
): void {
  const existing = cache.get(key);
  if (existing !== undefined && existing !== value) revokeIfBlobUrl(existing);
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    revokeThumbnailCacheEntry(cache, oldest.value);
  }
}
