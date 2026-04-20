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

/** Plain-text display: "$29.34 USD" (appends USD when the API string has no currency code). */
export function formatVariantPriceForDisplay(raw: string): string {
  const t = raw.trim();
  if (!t) return '';
  const withDollar = t.startsWith('$') ? t : `$${t}`;
  if (/\b(USD|EUR|GBP|CAD|AUD)\b/i.test(withDollar)) return withDollar;
  return `${withDollar} USD`;
}
