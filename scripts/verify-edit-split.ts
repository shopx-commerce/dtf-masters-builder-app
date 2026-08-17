/**
 * verify-edit-split.ts — the row-splitting rule for pixel edits on copies.
 *
 * Run: npx tsx scripts/verify-edit-split.ts
 *
 * Covers: editing some copies of a row splits exactly those copies into one
 * new row; uniform edits (whole row, lone design, system rebuilds) split
 * nothing; batch edits leave the batch together; re-editing a previously
 * split copy splits it again; duplicates inherit the tag and group with
 * their split source; tags parse back to the tool that made them.
 */
import {
  stampEditSplit,
  rowKeyOf,
  baseNameOf,
  editSplitToolOf,
  EDIT_SPLIT_BADGE_KEYS,
} from "../client/src/lib/edit-split";
import type { DesignItem } from "../client/src/lib/types";

let failures = 0;
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok" : "FAIL"} - ${label}`);
  if (!ok) failures++;
};

const mk = (id: string, name = "logo", over: Partial<DesignItem> = {}): DesignItem => ({
  id,
  name,
  imageInfo: {} as DesignItem["imageInfo"],
  transform: { nx: 0.5, ny: 0.5, s: 1, rotation: 0, flipX: false, flipY: false } as DesignItem["transform"],
  widthInches: 10,
  heightInches: 8,
  originalDPI: 300,
  ...over,
});

// 1. Editing one copy of three splits exactly that copy.
{
  const designs = [mk("a"), mk("b"), mk("c")];
  const out = stampEditSplit(designs, new Set(["b"]), "halftone");
  const [a, b, c] = out;
  check("edited copy gets a tag", !!b.editSplit);
  check("siblings stay untagged", !a.editSplit && !c.editSplit);
  check("edited copy leaves the row", rowKeyOf(b) !== rowKeyOf(a));
  check("siblings keep one row", rowKeyOf(a) === rowKeyOf(c));
  check("originals not mutated", !designs[1].editSplit);
}

// 2. Editing every copy of a row (uniform look) splits nothing.
{
  const designs = [mk("a"), mk("b"), mk("c")];
  const out = stampEditSplit(designs, new Set(["a", "b", "c"]), "clean");
  check("uniform row edit is a no-op (same reference)", out === designs);
}

// 3. Editing a design that is alone in its row splits nothing.
{
  const designs = [mk("a"), mk("x", "other")];
  const out = stampEditSplit(designs, new Set(["a"]), "upscale");
  check("lone design edit is a no-op (same reference)", out === designs);
}

// 4. A batch edit of a subset stays together as ONE new row.
{
  const designs = [mk("a"), mk("b"), mk("c"), mk("d"), mk("e")];
  const out = stampEditSplit(designs, new Set(["b", "c"]), "clean");
  const [, b, c] = out;
  check("batch subset shares one tag", !!b.editSplit && b.editSplit === c.editSplit);
  check("batch subset forms one row", rowKeyOf(b) === rowKeyOf(c));
  check("batch row differs from source row", rowKeyOf(b) !== rowKeyOf(out[0]));
}

// 5. Re-editing one member of a previously split pair splits again.
{
  const designs = stampEditSplit([mk("a"), mk("b"), mk("c")], new Set(["b", "c"]), "halftone");
  const again = stampEditSplit(designs, new Set(["b"]), "halftone");
  const b = again.find((d) => d.id === "b")!;
  const c = again.find((d) => d.id === "c")!;
  check("re-edited copy gets a fresh tag", !!b.editSplit && b.editSplit !== c.editSplit);
  check("re-edited copy leaves the split row", rowKeyOf(b) !== rowKeyOf(c));
}

// 6. Tags are unique across calls, so separate gestures never merge rows.
{
  const one = stampEditSplit([mk("a"), mk("b")], new Set(["a"]), "crop");
  const two = stampEditSplit([mk("p", "logo2"), mk("q", "logo2")], new Set(["p"]), "crop");
  check("separate gestures produce distinct tags", one[0].editSplit !== two[0].editSplit);
}

// 7. Duplicating a split copy (spread + base name, like the duplicate flow) groups with it.
{
  const [tagged] = stampEditSplit([mk("a"), mk("b")], new Set(["a"]), "halftone");
  const copy: DesignItem = { ...tagged, id: "a2", name: `${baseNameOf(tagged.name)} copy` };
  check("duplicate of a split copy joins its row", rowKeyOf(copy) === rowKeyOf(tagged));
}

// 8. Editing subsets across two rows in one gesture only touches the partial rows.
{
  const designs = [mk("a"), mk("b"), mk("x", "other"), mk("y", "other"), mk("z", "other")];
  const out = stampEditSplit(designs, new Set(["a", "b", "y"]), "clean");
  check("fully edited row untouched", !out[0].editSplit && !out[1].editSplit);
  check("partially edited row split", !!out.find((d) => d.id === "y")!.editSplit);
  check("partial row's siblings untouched", !out.find((d) => d.id === "x")!.editSplit && !out.find((d) => d.id === "z")!.editSplit);
}

// 9. Tags parse back to their tool and every tool has a badge key.
{
  const [tagged] = stampEditSplit([mk("a"), mk("b")], new Set(["a"]), "upscale");
  check("tag parses to its tool", editSplitToolOf(tagged.editSplit) === "upscale");
  check("unknown tags parse to undefined", editSplitToolOf("mystery:1") === undefined && editSplitToolOf(undefined) === undefined);
  check(
    "every tool has a badge key",
    (["halftone", "upscale", "clean", "crop"] as const).every((k) => typeof EDIT_SPLIT_BADGE_KEYS[k] === "string" && EDIT_SPLIT_BADGE_KEYS[k].length > 0),
  );
}

if (failures > 0) {
  console.error(`verify-edit-split: ${failures} FAILED`);
  process.exit(1);
}
console.log("verify-edit-split: PASS");
