/** Shopify Ajax (.js) prices are cents; Admin GraphQL uses dollar strings like "164.82". */
export function normalizeShopifyPrice(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+\.\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return (Number(s) / 100).toFixed(2);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return s;
}
