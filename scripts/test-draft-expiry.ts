/**
 * Boundary tests for the draft age cutoff. Run with:  npx tsx scripts/test-draft-expiry.ts
 *
 * Exercises the real exported helper rather than a copy of it, so the constant
 * and the comparison can't drift apart.
 */
import assert from "node:assert/strict";
import { DRAFT_MAX_AGE_MS, isEditorDraftExpired } from "../client/src/lib/editor-draft-storage";

const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);
const at = (savedAt: unknown) =>
  isEditorDraftExpired({ savedAt } as { savedAt: number }, NOW);

const cases: Array<[string, unknown, boolean]> = [
  ["7 days is exactly the constant", DRAFT_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000 === DRAFT_MAX_AGE_MS],
  ["saved a second ago", NOW - 1_000, false],
  ["saved 6 days 23h ago", NOW - (7 * 24 - 1) * 3_600_000, false],
  ["saved exactly at the cutoff", NOW - DRAFT_MAX_AGE_MS, false],
  ["saved 1 ms past the cutoff", NOW - DRAFT_MAX_AGE_MS - 1, true],
  ["saved 30 days ago", NOW - 30 * 24 * 3_600_000, true],
  // Fail-safe branches: an unusable timestamp must never destroy work.
  ["future-dated (clock corrected backwards)", NOW + 30 * 24 * 3_600_000, false],
  ["missing savedAt", undefined, false],
  ["null savedAt", null, false],
  ["NaN savedAt", Number.NaN, false],
  ["Infinity savedAt", Number.POSITIVE_INFINITY, false],
  ["zero savedAt", 0, false],
  ["negative savedAt", -1, false],
  ["string savedAt from a corrupt record", "2026-08-01", false],
];

let failures = 0;
for (const [label, savedAt, expected] of cases) {
  const actual = label.startsWith("7 days is") ? (savedAt === DRAFT_MAX_AGE_MS) : at(savedAt);
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} → expired=${actual}`);
}

// `Date.now()` default argument must behave the same as an explicit clock.
assert.equal(isEditorDraftExpired({ savedAt: Date.now() }), false);
assert.equal(isEditorDraftExpired({ savedAt: Date.now() - DRAFT_MAX_AGE_MS - 5_000 }), true);
console.log(`  PASS  default clock matches explicit clock`);

console.log(`\n${cases.length + 1 - failures}/${cases.length + 1} checks passed`);
process.exit(failures ? 1 : 0);
