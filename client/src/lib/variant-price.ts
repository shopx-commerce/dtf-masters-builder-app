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
export function formatVariantPriceForDisplay(raw: string): string {
  const t = raw.trim().replace(/\s+(USD|EUR|GBP|CAD|AUD)\s*$/i, '').trim();
  if (!t) return '';
  return t.startsWith('$') ? t : `$${t}`;
}
