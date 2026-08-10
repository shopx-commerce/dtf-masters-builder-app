/**
 * R2 object keys for a design's server-side artifacts.
 *
 * These MUST match the proxy's builders in dtf-proxy-r2-upload.server.js
 * (designProductionObjectKey / designPreviewObjectKey) exactly, because the proxy validates the
 * key it is handed against its own allowlist. A key this file builds differently is not silently
 * corrected — since Phase 2 the proxy rejects an unrecognized key with an explicit error rather
 * than substituting a random one, so any drift here surfaces as a failed Add-to-Cart.
 *
 * shopKey must be the value the shell reports (shellShopKeyRef), which is the proxy's own
 * shopKeyFromShop(shop) output. Do NOT derive it from shopDomain here: a custom storefront domain
 * would normalize to something the proxy never produces.
 */

/** Mirrors safeName() in dtf-proxy-r2-upload.server.js. Returns "" when nothing usable is left. */
export function safeKeySegment(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** `designs/<shopKey>/<designId>`, or null when either segment is unusable. */
export function designBasePrefix(
  shopKey: string | null | undefined,
  designId: string | null | undefined,
): string | null {
  const shop = safeKeySegment(shopKey);
  const design = safeKeySegment(designId);
  if (!shop || !design) return null;
  return `designs/${shop}/${design}`;
}

/**
 * Deterministic production key. Null means "no key could be built" — callers must then send no
 * objectKey at all and let the proxy assign one, rather than substituting a filename.
 */
export function designProductionObjectKey(
  shopKey: string | null | undefined,
  designId: string | null | undefined,
): string | null {
  const base = designBasePrefix(shopKey, designId);
  return base ? `${base}/production/gangsheet.png` : null;
}

/** Deterministic cart-preview key. Same null contract as designProductionObjectKey. */
export function designPreviewObjectKey(
  shopKey: string | null | undefined,
  designId: string | null | undefined,
): string | null {
  const base = designBasePrefix(shopKey, designId);
  return base ? `${base}/preview/cart-preview.png` : null;
}
