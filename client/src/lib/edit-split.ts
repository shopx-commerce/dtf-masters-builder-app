import type { DesignItem } from "./types";

/**
 * Layer-row identity + the edit-split rule.
 *
 * The layers panel groups designs into rows by name and printed size, so "the
 * same artwork at the same size" reads as one row with a copy count. Editing
 * the pixels of one copy (halftone, upscale, pixel clean, crop) makes it a
 * different-looking design that would otherwise keep hiding behind its row's
 * shared thumbnail and controls. `stampEditSplit` gives copies that diverged
 * a fresh `editSplit` tag, and the tag is part of the row key — so an edited
 * copy moves into its own row exactly the way a resized copy already does
 * (a resize splits via the size half of the key, a pixel edit via the tag).
 *
 * Kept beside the type rather than in the editor model so the grouping in
 * `layerRows` and the stamping in the edit tools import one definition and
 * can never drift apart.
 */

/** Strips the duplicate suffix so copies group with their source design (same grammar the duplicate flow writes). */
export const baseNameOf = (name: string): string => name.replace(/ copy( \d+)?$/, "");

/** Effective printed size to 1/100" — the precision at which two copies count as "the same size". */
export const sizeKeyOf = (d: Pick<DesignItem, "widthInches" | "heightInches" | "transform">): string =>
  `${(d.widthInches * d.transform.s).toFixed(2)}x${(d.heightInches * d.transform.s).toFixed(2)}`;

/**
 * The layers-panel row a design belongs to. The first two segments are the
 * user-visible name and size; the third is the edit-split tag, present only
 * on copies that were pixel-edited away from their siblings.
 */
export const rowKeyOf = (d: DesignItem): string =>
  `${baseNameOf(d.name)}::${sizeKeyOf(d)}::${d.editSplit ?? ""}`;

/**
 * Pixel-mutating tools that split a copy out of its row. Transform-only
 * operations (move, rotate, flip) deliberately never split: they are cheap
 * reversible toggles on the same pixels, not a different-looking design.
 */
export type EditSplitTool = "halftone" | "upscale" | "clean" | "crop" | "color";

/** Row-badge translation key per tool — parenthesized labels in the same style as `editor.resized`. */
export const EDIT_SPLIT_BADGE_KEYS: Record<EditSplitTool, string> = {
  halftone: "editor.editHalftoned",
  upscale: "editor.editUpscaled",
  clean: "editor.editCleaned",
  crop: "editor.editCropped",
  color: "editor.editRecolored",
};

/** Which tool split this design out, for the row badge. `undefined` for never-split designs or unknown tags. */
export function editSplitToolOf(tag: string | undefined): EditSplitTool | undefined {
  const tool = tag ? tag.split(":", 1)[0] : undefined;
  return tool === "halftone" || tool === "upscale" || tool === "clean" || tool === "crop" || tool === "color"
    ? tool
    : undefined;
}

let stampSeq = 0;

/**
 * Applies the split rule to a freshly edited designs array.
 *
 * For every current row: if the edit touched SOME of its members but not all,
 * the touched ones get one shared fresh tag — they leave together as a new
 * row, and the untouched siblings keep the original look and row. A row
 * edited uniformly (all copies cleaned at once, a lone design halftoned, a
 * system rebuild re-screening what it already screened) is left exactly as it
 * was: the look did not diverge, so there is nothing to split.
 *
 * Tags are unique per call and never reused, so two copies edited in separate
 * gestures stay in separate rows even if the results happen to look alike —
 * matching how a customer thinks about "the copy I just edited".
 *
 * Returns the input array unchanged (same reference) when nothing diverged.
 */
export function stampEditSplit(
  designs: DesignItem[],
  editedIds: ReadonlySet<string>,
  tool: EditSplitTool,
): DesignItem[] {
  const rows = new Map<string, DesignItem[]>();
  for (const d of designs) {
    const key = rowKeyOf(d);
    const row = rows.get(key);
    if (row) row.push(d);
    else rows.set(key, [d]);
  }
  const retag = new Set<string>();
  for (const members of rows.values()) {
    const edited = members.filter((m) => editedIds.has(m.id));
    if (edited.length > 0 && edited.length < members.length) {
      for (const m of edited) retag.add(m.id);
    }
  }
  if (retag.size === 0) return designs;
  const tag = `${tool}:${Date.now().toString(36)}-${++stampSeq}`;
  return designs.map((d) => (retag.has(d.id) ? { ...d, editSplit: tag } : d));
}
