/**
 * Content signature for a rendered gangsheet.
 *
 * Two arrangements with the same signature must produce pixel-identical output, so this MUST cover
 * every field the renderer reads. Missing a field means a real visual change goes undetected —
 * which shows up as a stale cart preview or a skipped re-export on update.
 *
 * Shared deliberately: the Add-to-Cart reuse check and the cart-preview upload cache both key off
 * this. If they drifted, the preview cache could report a hit for an arrangement the export path
 * considers different, and the cart would show a thumbnail of the wrong layout.
 */
import type { DesignItem } from "@/lib/types";

function roundSig(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6) : "x";
}

export function designContentSignature(
  designs: DesignItem[],
  artboardWidth: number,
  artboardHeight: number,
): string {
  const parts = [`ab:${roundSig(artboardWidth)}x${roundSig(artboardHeight)}`];
  for (const d of designs) {
    const f = d.imageInfo?.file;
    const fileSig = f ? `${f.name}:${f.size}:${f.lastModified}` : "";
    const t = d.transform;
    parts.push(
      `${d.id}|${roundSig(d.widthInches)}|${roundSig(d.heightInches)}|${roundSig(t.nx)}|${roundSig(t.ny)}|${roundSig(t.s)}|${roundSig(t.rotation)}|${t.flipX ? 1 : 0}|${t.flipY ? 1 : 0}|${d.alphaThresholded ? 1 : 0}|${d.printFileName ? 1 : 0}|${String(d.name || "")}|${fileSig}`,
    );
  }
  return parts.join("~");
}
