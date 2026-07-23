export type ShopifyVariantForPrice = {
  id: string;
  title: string;
  price: string | null;
  height: number | null;
};

export function getSelectedVariantPrice(
  shopifyVariants: ShopifyVariantForPrice[] | undefined,
  artboardHeight: number
): string | null {
  if (!shopifyVariants?.length) return null;
  const h = Number(artboardHeight);
  const byHeight = shopifyVariants.find((v) => v.height != null && Math.abs(v.height - h) < 0.01);
  if (byHeight?.price) return byHeight.price;
  const withPrice = shopifyVariants.find((v) => v.price != null);
  return withPrice?.price ?? null;
}

/** Plain-text display: "$29.34" (symbol only; strips trailing currency words from API strings). */
export function normalizeShopifyPriceForDisplay(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+\.\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return (Number(s) / 100).toFixed(2);
  return s;
}

export function formatVariantPriceForDisplay(raw: string): string {
  const normalized = normalizeShopifyPriceForDisplay(raw) ?? raw;
  const t = normalized.trim().replace(/\s+(USD|EUR|GBP|CAD|AUD)\s*$/i, '').trim();
  const out = !t ? '' : (t.startsWith('$') ? t : `$${t}`);
  return out;
}
