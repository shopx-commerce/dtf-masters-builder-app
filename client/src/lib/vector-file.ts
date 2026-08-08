/**
 * The parts of vector import that cost nothing to load.
 *
 * `svg-parser` pulls in DOMPurify and `pdf-parser` pulls in the whole pdf.js
 * rendering engine, both at module scope, so importing *anything* from either
 * one downloads the engine. The upload path needs two things before it knows a
 * vector is even involved — "is this file an SVG?" and "which typed rejection
 * did the parser throw?" — and neither needs an engine.
 *
 * Keeping them here lets the editor decide it is looking at a PNG, and handle
 * the error cases of a vector import, without ever fetching a parser. The
 * parsers re-export these names so their own callers are unaffected.
 *
 * Nothing in this module may import anything heavier than a type.
 */

import type { SvgExpansionReport } from "./svg-expansion";

export function isSVGFile(file: File): boolean {
  return file.type === "image/svg+xml" || file.name.toLowerCase().endsWith(".svg");
}

export function isEPSFile(file: File): boolean {
  const t = file.type.toLowerCase();
  return (
    file.name.toLowerCase().endsWith(".eps") ||
    t === "application/postscript" ||
    t === "application/eps" ||
    t === "application/x-eps"
  );
}

/**
 * Rejected before any renderer saw it, because resolving its references would
 * ask for more primitives than a real design ever contains.
 *
 * `translationKey` is the string the caller should show. The `message` is an
 * English fallback for logs, not for the customer.
 */
export class SvgTooComplexError extends Error {
  readonly code = "svg_too_complex";
  readonly translationKey = "toast.svgTooComplexDesc";
  readonly titleKey = "toast.svgTooComplex";
  constructor(readonly report: SvgExpansionReport) {
    super(
      `SVG expands to ~${report.effectivePrimitives.toLocaleString()} rendered shapes ` +
        `(${report.expansionFactor}x its source of ${report.sourcePrimitives.toLocaleString()}); ` +
        `limit hit: ${report.reason}`,
    );
    this.name = "SvgTooComplexError";
  }
}
