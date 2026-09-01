export type PricingTier = {
  qtyMin: number;
  base: number;
  rate: number;
  minPer: number;
};

const PRICING_TIERS: PricingTier[] = [
  { qtyMin: 1000, base: 0.06, rate: 0.0092, minPer: 0.1 },
  { qtyMin: 500, base: 0.09, rate: 0.0086, minPer: 0.12 },
  { qtyMin: 300, base: 0.11, rate: 0.0074, minPer: 0.15 },
  { qtyMin: 200, base: 0.12, rate: 0.01, minPer: 0.175 },
  { qtyMin: 100, base: 0.15, rate: 0.018, minPer: 0.26 },
  { qtyMin: 50, base: 0.23, rate: 0.028, minPer: 0.38 },
  { qtyMin: 25, base: 0.52, rate: 0.027, minPer: 0.6 },
];

export const QUANTITY_OPTIONS = [
  25, 50, 100, 150, 200, 250, 300, 350, 500, 750, 1000,
];

function roundCents(x: number): number {
  return Math.round(x * 100) / 100;
}

function normalizeTiers(tiers: PricingTier[]): PricingTier[] {
  return [...tiers].sort((a, b) => b.qtyMin - a.qtyMin);
}

function pickTier(qty: number, tiers: PricingTier[]) {
  const t = normalizeTiers(tiers);
  return t.find((row) => qty >= row.qtyMin) || t[t.length - 1];
}

/**
 * Snap quantity to closest allowed value (shop list or legacy defaults).
 */
export function snapQuantityToOptions(
  qty: number,
  quantityOptions?: number[],
): number {
  const list =
    Array.isArray(quantityOptions) && quantityOptions.length > 0
      ? quantityOptions.map((q) => Math.round(Number(q))).filter((q) => q >= 1)
      : [...QUANTITY_OPTIONS];
  const q = Math.max(1, Math.round(Number(qty) || list[0]));
  return list.reduce((prev, curr) =>
    Math.abs(curr - q) < Math.abs(prev - q) ? curr : prev,
  );
}

/**
 * @param tiers optional; defaults to built-in legacy tiers (standalone designer).
 */
export function calcStickerPrice(
  widthIn: number,
  heightIn: number,
  qty: number,
  tiers?: PricingTier[],
): {
  perSticker: number;
  total: number;
  area: number;
  tierUsed: number;
} {
  widthIn = Number(widthIn);
  heightIn = Number(heightIn);
  qty = Math.max(1, Math.round(qty));

  const tierList =
    tiers && tiers.length > 0 ? tiers : PRICING_TIERS;

  if (
    !Number.isFinite(widthIn) ||
    !Number.isFinite(heightIn) ||
    widthIn <= 0 ||
    heightIn <= 0
  ) {
    return { perSticker: 0, total: 0, area: 0, tierUsed: 0 };
  }

  const area = widthIn * heightIn;
  const tier = pickTier(qty, tierList);

  const perStickerRaw = tier.base + tier.rate * area;
  const perSticker = roundCents(Math.max(tier.minPer, perStickerRaw));
  const total = roundCents(perSticker * qty);

  return {
    area: roundCents(area),
    perSticker,
    total,
    tierUsed: tier.qtyMin,
  };
}

export function getClosestQuantity(qty: number): number {
  return snapQuantityToOptions(qty, QUANTITY_OPTIONS);
}
