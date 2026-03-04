import type { Language } from "./i18n";

const INCH_TO_CM = 2.54;

/** Returns true when lang uses metric (cm/m) */
export function useMetric(lang: Language): boolean {
  return lang === "es" || lang === "fr";
}

/**
 * Format length for display. For en: "X.XX" (inches, no unit).
 * For es/fr: "X.X cm" when < 100 cm, else "X.XX m".
 */
export function formatLength(inches: number, lang: Language): string {
  if (lang === "en") {
    return inches.toFixed(2);
  }
  const cm = inches * INCH_TO_CM;
  if (cm >= 100) {
    return `${(cm / 100).toFixed(2)} m`;
  }
  return `${cm.toFixed(1)} cm`;
}

/**
 * Same as formatLength but for cases where we need the full display string
 * (e.g. "24.5" for en vs "62.23 cm" for es/fr). Used when the unit is not
 * appended separately.
 */
export function formatLengthForDisplay(inches: number, lang: Language): string {
  return formatLength(inches, lang);
}

/**
 * Format dimensions as "W × H" for display.
 */
export function formatDimensions(
  widthInches: number,
  heightInches: number,
  lang: Language
): string {
  const w = formatLength(widthInches, lang);
  const h = formatLength(heightInches, lang);
  if (lang === "en") {
    return `${w}" × ${h}"`;
  }
  return `${w} × ${h}`;
}

/** Convert cm to inches */
export function cmToInches(cm: number): number {
  return cm / INCH_TO_CM;
}

/** Unit suffix for display: " for en, " cm" or " m" for es/fr */
export function getUnitSuffix(inches: number, lang: Language): string {
  if (lang === "en") return '"';
  const cm = inches * INCH_TO_CM;
  return cm >= 100 ? " m" : " cm";
}
