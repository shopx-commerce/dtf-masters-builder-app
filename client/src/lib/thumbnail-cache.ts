export function revokeThumbnailCacheEntry(cache: Map<string, string>, key: string): void {
  const value = cache.get(key);
  if (value?.startsWith("blob:")) URL.revokeObjectURL(value);
  cache.delete(key);
}