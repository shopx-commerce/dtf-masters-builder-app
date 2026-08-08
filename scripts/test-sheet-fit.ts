/**
 * Tests for gangsheet auto-shrink sizing.
 *
 * Run: npx tsx scripts/test-sheet-fit.ts
 *
 * The property that matters most is the last suite: whatever this plans, the artwork must
 * still be inside the sheet afterwards. Auto-shrink runs without asking and changes which
 * Shopify variant the customer is charged for, so a wrong answer here either bills for film
 * nobody needed or silently crops someone's order.
 */
import {
  DEFAULT_SHEET_MARGIN,
  fitHeightForBand,
  planBandReseat,
  planSheetShrink,
  type InkBand,
} from "../client/src/lib/sheet-fit";

const HEIGHTS = [12, 24, 36, 48, 60, 72, 84, 96, 120, 160, 240, 340];

let failures = 0;
let checks = 0;

function check(label: string, actual: unknown, expected: unknown) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
  }
}

function checkTrue(label: string, cond: boolean) {
  check(label, cond, true);
}

console.log("\nfitHeightForBand — picking the size to buy");
check("11.5\" of art + 0.25 margins fits 12\"", fitHeightForBand(11.5, 0.25, HEIGHTS), 12);
check("11.6\" of art needs 24\" once margins are added", fitHeightForBand(11.6, 0.25, HEIGHTS), 24);
check("art exactly filling the sheet edge to edge still fits", fitHeightForBand(12, 0, HEIGHTS), 12);
check("nothing in the list is tall enough", fitHeightForBand(400, 0.25, HEIGHTS), null);
check("zero-height band takes the smallest sheet", fitHeightForBand(0, 0.25, HEIGHTS), 12);
check("a bigger margin can push it up a size", fitHeightForBand(11.5, 1, HEIGHTS), 24);

console.log("\nfitHeightForBand — float slop must not cost a whole size");
// 11.5 as a sum of tenths is 11.499999999999998, and doubling 0.25 is exact; the danger is the
// other direction, where the sum overshoots the boundary by a hair.
const slop = 11.5 + Number.EPSILON * 8;
check("a band a few ULPs over the boundary still fits 12\"", fitHeightForBand(slop, 0.25, HEIGHTS), 12);
check("a genuinely oversized band is not swallowed by the epsilon", fitHeightForBand(11.5001, 0.25, HEIGHTS), 24);

console.log("\nplanSheetShrink — when to act");
const band = (minY: number, maxY: number): InkBand => ({ minY, maxY });

check(
  "10\" of art on a 48\" sheet drops to 12\"",
  planSheetShrink({ band: band(2, 12), currentHeight: 48, margin: 0.25, heights: HEIGHTS }),
  { height: 12, shift: 1.75 },
);
check(
  "already on the smallest sheet that fits",
  planSheetShrink({ band: band(0.25, 11.5), currentHeight: 12, margin: 0.25, heights: HEIGHTS }),
  null,
);
check(
  "art needs every inch it has",
  planSheetShrink({ band: band(0.25, 47.75), currentHeight: 48, margin: 0.25, heights: HEIGHTS }),
  null,
);
check(
  "overflowing art never shrinks",
  planSheetShrink({ band: band(0, 60), currentHeight: 48, margin: 0.25, heights: HEIGHTS }),
  null,
);
check(
  "no list entry small enough",
  planSheetShrink({ band: band(0, 400), currentHeight: 340, margin: 0.25, heights: HEIGHTS }),
  null,
);

console.log("\nplanSheetShrink — never grows the sheet");
for (const [label, b, cur] of [
  ["art far taller than the sheet", band(0, 100), 24],
  ["art just over the sheet", band(0, 25), 24],
] as Array<[string, InkBand, number]>) {
  const plan = planSheetShrink({ band: b, currentHeight: cur, margin: 0.25, heights: HEIGHTS });
  checkTrue(`${label} → no plan, or a strictly smaller height`, plan === null || plan.height < cur);
}

console.log("\nplanSheetShrink — a hand-picked height is a floor");
check(
  "floor blocks the drop below what the customer chose",
  planSheetShrink({ band: band(2, 12), currentHeight: 48, margin: 0.25, heights: HEIGHTS, manualFloor: 36 }),
  { height: 36, shift: 1.75 },
);
check(
  "floor equal to the current height means no change at all",
  planSheetShrink({ band: band(2, 12), currentHeight: 36, margin: 0.25, heights: HEIGHTS, manualFloor: 36 }),
  null,
);
check(
  "a floor above the current height never grows the sheet",
  planSheetShrink({ band: band(2, 12), currentHeight: 24, margin: 0.25, heights: HEIGHTS, manualFloor: 96 }),
  null,
);
check(
  "a floor below what fits does not override the artwork",
  planSheetShrink({ band: band(0, 30), currentHeight: 96, margin: 0.25, heights: HEIGHTS, manualFloor: 12 }),
  { height: 36, shift: -0.25 },
);

console.log("\nplanBandReseat — getting ink off the top edge without buying film");
check(
  "a flush top row is pushed down to the margin",
  planBandReseat({ band: band(0, 20), currentHeight: 48, margin: 0.25 }),
  { shift: -0.25 },
);
check(
  "ink already clear of the margin is left alone",
  planBandReseat({ band: band(2, 20), currentHeight: 48, margin: 0.25 }),
  null,
);
check(
  "ink exactly on the margin is left alone",
  planBandReseat({ band: band(0.25, 20), currentHeight: 48, margin: 0.25 }),
  null,
);
check(
  "ink hanging off the top is pulled back on",
  planBandReseat({ band: band(-0.5, 20), currentHeight: 48, margin: 0.25 }),
  { shift: -0.75 },
);
check(
  "a sheet with exactly enough room still reseats",
  planBandReseat({ band: band(0, 11.5), currentHeight: 12, margin: 0.25 }),
  { shift: -0.25 },
);
check(
  "a sheet too tight for both margins splits the slack instead of buying film",
  planBandReseat({ band: band(0, 11.75), currentHeight: 12, margin: 0.25 }),
  { shift: -0.125 },
);
check(
  "artwork taller than the sheet has no slack to redistribute",
  planBandReseat({ band: band(0, 13), currentHeight: 12, margin: 0.25 }),
  null,
);
check(
  "a zero margin has nothing to reseat",
  planBandReseat({ band: band(0, 20), currentHeight: 48, margin: 0 }),
  null,
);

console.log("\nplanBandReseat — safety properties");
{
  let planned = 0;
  let violations = 0;
  let notIdempotent = 0;
  let movedUp = 0;
  for (let top = -2; top <= 40; top += 0.7) {
    for (let h = 0; h <= 55; h += 1.3) {
      for (const margin of [0, 0.125, 0.25, 0.5, 1]) {
        for (const current of [12, 24, 48, 96, 240]) {
          const b = band(top, top + h);
          const plan = planBandReseat({ band: b, currentHeight: current, margin });
          if (!plan) continue;
          planned++;
          if (plan.shift > 0) movedUp++;

          // On a sheet with room the band clears the full margin; on a tighter one it settles
          // for half the slack, which is still symmetric and still off the edge.
          const inset = Math.min(margin, (current - h) / 2);
          const movedTop = b.minY - plan.shift;
          const movedBottom = b.maxY - plan.shift;
          if (movedTop < inset - 1e-9) violations++;
          else if (movedBottom > current - inset + 1e-9) violations++;

          const second = planBandReseat({
            band: { minY: movedTop, maxY: movedBottom },
            currentHeight: current,
            margin,
          });
          if (second !== null) notIdempotent++;
        }
      }
    }
  }
  console.log(`  swept ${planned} reseat plans`);
  checkTrue("every reseat leaves ink clear of both edges", violations === 0);
  checkTrue("no reseat can be applied a second time", notIdempotent === 0);
  checkTrue("a reseat never drags artwork upwards", movedUp === 0);
  checkTrue("the sweep actually exercised the reseat path", planned > 500);
}

console.log("\nreseat and shrink agree about where the top of the band goes");
{
  // The whole point of the pair: whichever of the two acts, the artwork ends up the same
  // distance from the top edge — the full margin wherever the sheet has room for it. Only the
  // sheets too tight to hold both margins settle for less, and those are counted separately so
  // a regression that quietly started shortchanging roomy sheets would still show up.
  let disagreements = 0;
  let covered = 0;
  let tight = 0;
  for (let top = 0; top <= 30; top += 0.9) {
    for (let h = 0.5; h <= 40; h += 1.1) {
      for (const margin of [0.125, 0.25, 0.5]) {
        for (const current of [12, 24, 48, 96]) {
          const b = band(top, top + h);
          const shrink = planSheetShrink({ band: b, currentHeight: current, margin, heights: HEIGHTS });
          const shift = shrink
            ? shrink.shift
            : planBandReseat({ band: b, currentHeight: current, margin })?.shift;
          if (shift === undefined) continue;

          const landsAt = b.minY - shift;
          if (!shrink && h + margin * 2 > current) {
            tight++;
            if (Math.abs(landsAt - (current - h) / 2) > 1e-9) disagreements++;
            continue;
          }
          covered++;
          if (Math.abs(landsAt - margin) > 1e-9) disagreements++;
        }
      }
    }
  }
  console.log(`  compared ${covered} sheets with room to spare, plus ${tight} too tight for both margins`);
  checkTrue("both paths land the band exactly `margin` below the top", disagreements === 0);
  checkTrue("the comparison covered sheets of both kinds", covered > 500 && tight > 0);
}

console.log("\nauto margin falls back to the packer default");
check(
  "undefined gap uses DEFAULT_SHEET_MARGIN",
  fitHeightForBand(11.5, DEFAULT_SHEET_MARGIN, HEIGHTS),
  12,
);

console.log("\nsafety property — artwork always lands inside the shorter sheet");
{
  // Sweep bands across a range of positions, sizes and margins. For every case that plans a
  // shrink, apply the translation the way the editor does and assert the artwork is still on
  // the sheet, and that a second pass finds nothing left to do.
  let planned = 0;
  let violations = 0;
  let notIdempotent = 0;
  for (let top = 0; top <= 40; top += 1.3) {
    for (let h = 0.5; h <= 55; h += 1.7) {
      for (const margin of [0, 0.125, 0.25, 0.5, 1]) {
        for (const current of [24, 48, 96, 240]) {
          const b = band(top, top + h);
          const plan = planSheetShrink({ band: b, currentHeight: current, margin, heights: HEIGHTS });
          if (!plan) continue;
          planned++;

          const movedTop = b.minY - plan.shift;
          const movedBottom = b.maxY - plan.shift;
          // Inside the new sheet, with the margin honoured at both edges.
          if (movedTop < margin - 1e-9) violations++;
          else if (movedBottom > plan.height - margin + 1e-9) violations++;

          const second = planSheetShrink({
            band: { minY: movedTop, maxY: movedBottom },
            currentHeight: plan.height,
            margin,
            heights: HEIGHTS,
          });
          if (second !== null) notIdempotent++;
        }
      }
    }
  }
  console.log(`  swept ${planned} shrink plans`);
  checkTrue("every plan leaves the artwork on the sheet", violations === 0);
  checkTrue("no plan can be shrunk a second time", notIdempotent === 0);
  checkTrue("the sweep actually exercised the shrink path", planned > 500);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}
