/**
 * Shape of JSON passed from Shopify theme (?shopStickerSettings=…)
 * Must stay compatible with custom-sticker-app `app/sticker-settings.defaults.js`.
 */

import {
  calcStickerPrice,
  snapQuantityToOptions,
  type PricingTier,
} from "./pricing";

export type { PricingTier };

export interface SizePreset {
  label: string;
  width: number;
  height: number;
}

export interface ShopStickerSettings {
  version: number;
  sizes: {
    minWidth: number;
    minHeight: number;
    maxWidth: number;
    maxHeight: number;
    enableCustomSize: boolean;
    presets: SizePreset[];
  };
  pricing: {
    tiers: PricingTier[];
    quantityOptions: number[];
    minOrderPrice: number;
    extraFeeFlat: number;
  };
  finish: Record<string, { enabled: boolean; adjustment: number }>;
  lamination: Record<string, { enabled: boolean; adjustment: number }>;
  defaults: {
    finish: string;
    lamination: string;
    quantity: number;
    widthIn: number;
    heightIn: number;
  };
  currencyCode: string;
}

export function parseShopStickerSettingsFromSearch(
  search: string,
): ShopStickerSettings | null {
  try {
    const params = new URLSearchParams(
      search.startsWith("?") ? search.slice(1) : search,
    );
    const raw = params.get("shopStickerSettings");
    if (!raw?.trim()) return null;
    const parsed = JSON.parse(raw) as ShopStickerSettings;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.version !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function roundCents(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Variant-price anchor fee — only for the default size/qty the embed synced. */
function shouldApplyExtraFeeFlat(
  settings: ShopStickerSettings,
  args: { widthIn: number; heightIn: number; qty: number },
  snappedQty: number,
): boolean {
  const extra = Number(settings.pricing?.extraFeeFlat) || 0;
  if (extra === 0) return false;
  const d = settings.defaults;
  if (!d) return false;
  const defaultQty = snapQuantityToOptions(
    d.quantity,
    settings.pricing.quantityOptions,
  );
  return (
    Math.abs(args.widthIn - d.widthIn) < 0.04 &&
    Math.abs(args.heightIn - d.heightIn) < 0.04 &&
    snappedQty === defaultQty
  );
}

/** Display-only total (server recomputes on draft order). */
export function computeShopDisplayTotal(
  settings: ShopStickerSettings | null,
  args: {
    widthIn: number;
    heightIn: number;
    qty: number;
    finish: string;
    lamination: string;
  },
): number {
  const tiers = settings?.pricing?.tiers?.length
    ? settings.pricing.tiers
    : undefined;
  const qty = tiers
    ? snapQuantityToOptions(args.qty, settings!.pricing.quantityOptions)
    : Math.max(1, Math.round(args.qty));

  const base = calcStickerPrice(args.widthIn, args.heightIn, qty, tiers);
  if (!settings) return base.total;

  const finishKey =
    settings.finish?.[args.finish]?.enabled === true
      ? args.finish
      : settings.defaults?.finish || "glossy";
  const lamKey =
    settings.lamination?.[args.lamination]?.enabled === true
      ? args.lamination
      : settings.defaults?.lamination || "none";

  const finishAdj = Number(settings.finish?.[finishKey]?.adjustment) || 0;
  const lamAdj = Number(settings.lamination?.[lamKey]?.adjustment) || 0;
  const extra = shouldApplyExtraFeeFlat(settings, args, qty)
    ? Number(settings.pricing?.extraFeeFlat) || 0
    : 0;
  let total = roundCents(base.total + finishAdj + lamAdj + extra);
  const minOrder = Number(settings.pricing?.minOrderPrice) || 0;
  if (minOrder > 0 && total < minOrder) total = roundCents(minOrder);
  return total;
}

export function clampDimension(
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
