/**
 * Proof that trimming a design's empty margin does not move its artwork.
 *
 * When "Remove white background" clears the background it leaves the frame the
 * same size, so the design is then mostly transparent padding. Cropping that
 * away shrinks the design's bounding box, and because a design is positioned by
 * the centre of that box, an asymmetric crop moves the centre — the artwork
 * slides across the sheet unless `geometryAfterTrim` moves the centre back by
 * exactly the right amount.
 *
 * "Exactly the right amount" depends on the design's rotation and flips,
 * because the crop is measured in the artwork's own pixels and the correction
 * has to be applied in sheet inches. That is the part worth checking, and it is
 * pure arithmetic, so it runs here rather than in a browser.
 *
 * The check is direct: take the four corners of the ink, project them onto the
 * sheet the way export draws them, and assert they land in the same place
 * before and after the trim. Everything else — the size staying constant, the
 * DPI badge staying honest — follows from that.
 *
 *   node scripts/verify-trim-geometry.mjs
 */

import { compileDeclarations, extract, readSource as read } from "./lib/extract-ts.mjs";

/** Compile the real geometry function into a module this script can call. */
async function loadTrimGeometry() {
  const source = read("client/src/lib/trim-after-edit.ts");
  return compileDeclarations({
    pieces: [
      extract(source, "MIN_DESIGN_INCHES", "trim-after-edit.ts"),
      extract(source, "geometryAfterTrim", "trim-after-edit.ts"),
    ],
    exports: ["geometryAfterTrim", "MIN_DESIGN_INCHES"],
  });
}

const ARTBOARD_W = 22;
const ARTBOARD_H = 120;

/**
 * Place a point from the design's local space onto the sheet, in inches.
 *
 * Mirrors the draw order in `export-worker.ts`: translate to the design's
 * centre, rotate, then scale (which is where the flips live). Read as a
 * transform of a point that is the reverse — flip, rotate, translate.
 */
function localToSheet(geometry, lx, ly) {
  const t = geometry.transform;
  const x = t.flipX ? -lx : lx;
  const y = t.flipY ? -ly : ly;
  const r = (t.rotation * Math.PI) / 180;
  return {
    x: t.nx * ARTBOARD_W + (x * Math.cos(r) - y * Math.sin(r)),
    y: t.ny * ARTBOARD_H + (x * Math.sin(r) + y * Math.cos(r)),
  };
}

/** The design's drawn size on the sheet, in inches. */
function drawnSize(geometry) {
  return {
    w: geometry.widthInches * geometry.transform.s,
    h: geometry.heightInches * geometry.transform.s,
  };
}

/**
 * A corner of the ink region before the trim, where the ink is a sub-rectangle
 * of the design. `u` and `v` run 0..1 across the ink box.
 */
function inkCornerBefore(geometry, trim, u, v) {
  const { box, sourceWidth, sourceHeight } = trim;
  const { w, h } = drawnSize(geometry);
  return localToSheet(
    geometry,
    -w / 2 + ((box.x + u * box.width) / sourceWidth) * w,
    -h / 2 + ((box.y + v * box.height) / sourceHeight) * h,
  );
}

/** The same corner after the trim, where the ink is now the whole design. */
function inkCornerAfter(geometry, u, v) {
  const { w, h } = drawnSize(geometry);
  return localToSheet(geometry, -w / 2 + u * w, -h / 2 + v * h);
}

/** Largest distance any ink corner moved on the sheet, in inches. */
function cornerDrift(before, trim, after) {
  let worst = 0;
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const a = inkCornerBefore(before, trim, u, v);
    const b = inkCornerAfter(after, u, v);
    worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return worst;
}

function transform(overrides) {
  return { nx: 0.4, ny: 0.3, s: 1, rotation: 0, flipX: false, flipY: false, ...overrides };
}

const results = [];
function check(name, detail, ok) {
  results.push({ name, detail, ok });
  console.log(`${ok ? "pass" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
}

async function main() {
  const { geometryAfterTrim, MIN_DESIGN_INCHES } = await loadTrimGeometry();

  // A margin taken unevenly on every side, on a canvas that is not square, so
  // no symmetry can hide a mixed-up axis.
  const trim = { sourceWidth: 2400, sourceHeight: 1600, box: { x: 300, y: 100, width: 900, height: 1100 } };

  // 17 and 200 degrees are in there so a mistake cannot pass by landing on a
  // right angle, where sin and cos are 0 and 1 and a swapped axis is invisible.
  const rotations = [0, 17, 90, 180, 200, 270, 315];
  const flips = [
    { flipX: false, flipY: false },
    { flipX: true, flipY: false },
    { flipX: false, flipY: true },
    { flipX: true, flipY: true },
  ];
  const scales = [1, 0.45, 2.3];

  let worst = 0;
  let cases = 0;
  for (const rotation of rotations) {
    for (const flip of flips) {
      for (const s of scales) {
        const before = { widthInches: 12, heightInches: 8, transform: transform({ rotation, s, ...flip }) };
        const after = geometryAfterTrim(before, trim, ARTBOARD_W, ARTBOARD_H);
        if (!after) {
          check("artwork holds position", `no geometry returned at ${rotation} deg`, false);
          return report();
        }
        worst = Math.max(worst, cornerDrift(before, trim, after));
        cases++;
      }
    }
  }
  check("artwork holds position", `${cases} placements, worst drift ${worst.toExponential(2)} in`, worst < 1e-9);

  // A design that has been dragged off the sheet's centre, and a box hard
  // against one edge, so the correction is as large as it gets.
  {
    const before = {
      widthInches: 30,
      heightInches: 4,
      transform: transform({ nx: -0.85, ny: 1.6, rotation: 42, s: 1.7, flipX: true }),
    };
    const edgeTrim = { sourceWidth: 3000, sourceHeight: 400, box: { x: 0, y: 260, width: 240, height: 140 } };
    const after = geometryAfterTrim(before, edgeTrim, ARTBOARD_W, ARTBOARD_H);
    const drift = after ? cornerDrift(before, edgeTrim, after) : Infinity;
    check("off-centre design, corner box", `drift ${drift.toExponential(2)} in`, drift < 1e-9);
  }

  // The trim must not change how big the artwork is drawn, only how much empty
  // space its box claims.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({ rotation: 33, s: 1.25 }) };
    const after = geometryAfterTrim(before, trim, ARTBOARD_W, ARTBOARD_H);
    const expectedW = (12 * trim.box.width) / trim.sourceWidth;
    const expectedH = (8 * trim.box.height) / trim.sourceHeight;
    const ok = after
      && Math.abs(after.widthInches - expectedW) < 1e-12
      && Math.abs(after.heightInches - expectedH) < 1e-12
      && after.transform.s === before.transform.s;
    check("size shrinks with the box", `${expectedW.toFixed(3)} x ${expectedH.toFixed(3)} in, scale held`, !!ok);
  }

  // Pixels and inches shrink by the same factor, so pixels-per-inch is
  // unchanged and the DPI badge stays truthful without recomputing it.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({}) };
    const after = geometryAfterTrim(before, trim, ARTBOARD_W, ARTBOARD_H);
    const dpiBefore = trim.sourceWidth / before.widthInches;
    const dpiAfter = trim.box.width / after.widthInches;
    check("reported DPI unchanged", `${dpiBefore.toFixed(2)} -> ${dpiAfter.toFixed(2)}`, Math.abs(dpiBefore - dpiAfter) < 1e-9);
  }

  // Nothing to trim must mean nothing to change, or clicking the button twice
  // would nudge the design each time.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({ rotation: 90 }) };
    const untouched = geometryAfterTrim(before, { sourceWidth: 2400, sourceHeight: 1600, box: null }, ARTBOARD_W, ARTBOARD_H);
    const full = geometryAfterTrim(
      before,
      { sourceWidth: 2400, sourceHeight: 1600, box: { x: 0, y: 0, width: 2400, height: 1600 } },
      ARTBOARD_W,
      ARTBOARD_H,
    );
    check("no-op trims return null", `unmeasured ${untouched}, full frame ${full}`, untouched === null && full === null);
  }

  // A one-pixel box on a huge canvas would otherwise produce a design too small
  // to select or grab a handle on.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({}) };
    const speck = { sourceWidth: 24000, sourceHeight: 16000, box: { x: 11000, y: 8000, width: 1, height: 1 } };
    const after = geometryAfterTrim(before, speck, ARTBOARD_W, ARTBOARD_H);
    const ok = after && after.widthInches === MIN_DESIGN_INCHES && after.heightInches === MIN_DESIGN_INCHES;
    check("degenerate box clamps to minimum", `${MIN_DESIGN_INCHES} in floor applied`, !!ok);
  }

  // Negative control. The centre correction is the entire substance of this
  // function; a version that only resizes has to fail the position assertion,
  // otherwise the assertion is not measuring anything.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({ rotation: 17, s: 1.4 }) };
    const resizeOnly = {
      widthInches: (before.widthInches * trim.box.width) / trim.sourceWidth,
      heightInches: (before.heightInches * trim.box.height) / trim.sourceHeight,
      transform: before.transform,
    };
    const drift = cornerDrift(before, trim, resizeOnly);
    check("negative control", `skipping the centre shift drifts ${drift.toFixed(3)} in`, drift > 0.5);
  }

  // Second negative control: the flips have to be applied before the rotation.
  // Doing it the other way round is the plausible mistake, and it is invisible
  // at 0 and 180 degrees, so it needs an angle that exposes it.
  {
    const before = { widthInches: 12, heightInches: 8, transform: transform({ rotation: 17, flipX: true }) };
    const after = geometryAfterTrim(before, trim, ARTBOARD_W, ARTBOARD_H);
    const fdx = (trim.box.x + trim.box.width / 2) / trim.sourceWidth - 0.5;
    const fdy = (trim.box.y + trim.box.height / 2) / trim.sourceHeight - 0.5;
    const dx = fdx * before.widthInches * before.transform.s;
    const dy = fdy * before.heightInches * before.transform.s;
    const r = (17 * Math.PI) / 180;
    // Rotate first and flip the result: the wrong order.
    const swapped = {
      ...after,
      transform: {
        ...before.transform,
        nx: before.transform.nx - (dx * Math.cos(r) - dy * Math.sin(r)) / ARTBOARD_W,
        ny: before.transform.ny + (dx * Math.sin(r) + dy * Math.cos(r)) / ARTBOARD_H,
      },
    };
    const drift = cornerDrift(before, trim, swapped);
    check("negative control, flip order", `flipping after rotating drifts ${drift.toFixed(3)} in`, drift > 0.01);
  }

  report();
}

function report() {
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("A trim moves the artwork on the sheet.");
    process.exitCode = 1;
    return;
  }
  console.log("Trimming the empty margin leaves the artwork at the same size and place on the sheet.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
