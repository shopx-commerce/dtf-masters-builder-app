import assert from "node:assert/strict";
import { decode, encode } from "fast-png";
import { analyzeColorChangePng, recolorPng } from "../client/src/lib/color-change-core.ts";

const source = { r: 24, g: 91, b: 173 };
const target = { r: 218, g: 58, b: 42 };

function png(data: number[], width: number, height: number, channels = 4, depth = 8): Uint8Array {
  return encode({ width, height, data: new Uint8Array(data), channels, depth: depth as 8 });
}

function rgba(bytes: Uint8Array): Uint8Array {
  const result = decode(bytes);
  assert.equal(result.channels, 4);
  return result.data as Uint8Array;
}

function assertAlphaEquals(before: Uint8Array, after: Uint8Array): void {
  for (let i = 3; i < before.length; i += 4) assert.equal(after[i], before[i], `alpha differs at pixel ${i / 4}`);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function physicalChunk(x: number, y: number): Uint8Array {
  const chunk = new Uint8Array(21);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, 9);
  chunk.set([112, 72, 89, 115], 4);
  view.setUint32(8, x);
  view.setUint32(12, y);
  chunk[16] = 1;
  view.setUint32(17, crc32(chunk.subarray(4, 17)));
  return chunk;
}

function withPhysicalResolution(bytes: Uint8Array, x: number, y: number): Uint8Array {
  const chunk = physicalChunk(x, y);
  const output = new Uint8Array(bytes.length + chunk.length);
  output.set(bytes.subarray(0, 33));
  output.set(chunk, 33);
  output.set(bytes.subarray(33), 33 + chunk.length);
  return output;
}

// Includes low-alpha anti-aliased edges and arbitrary transparent RGB. The
// latter must neither affect eligibility nor be modified.
const fixturePixels = new Uint8Array([
  24, 91, 173, 255, 24, 91, 173, 47,
  220, 10, 99, 0, 24, 91, 173, 1,
  3, 240, 8, 0, 24, 91, 173, 128,
]);
const fixture = encode({ width: 3, height: 2, data: fixturePixels, channels: 4, depth: 8 });
const analysis = analyzeColorChangePng(fixture);
assert.deepEqual(analysis, { eligible: true, sourceColor: source, width: 3, height: 2 });
const recolored = recolorPng(fixture, target);
assert.equal(recolored.ok, true);
if (!recolored.ok) throw new Error(recolored.reason);
const recoloredPixels = rgba(recolored.png);
assertAlphaEquals(fixturePixels, recoloredPixels);
for (let i = 0; i < fixturePixels.length; i += 4) {
  if (fixturePixels[i + 3]) assert.deepEqual([...recoloredPixels.subarray(i, i + 3)], [target.r, target.g, target.b]);
  else assert.deepEqual([...recoloredPixels.subarray(i, i + 3)], [...fixturePixels.subarray(i, i + 3)]);
}

// Recolouring an already recoloured image produces exactly the same pixels as
// recolouring the original directly to the final ink.
const finalTarget = { r: 12, g: 205, b: 77 };
const twice = recolorPng(recolored.png, finalTarget);
const direct = recolorPng(fixture, finalTarget);
assert(twice.ok && direct.ok);
assert.deepEqual([...rgba(twice.png)], [...rgba(direct.png)]);

const withDpi = withPhysicalResolution(fixture, 11811, 11811);
const withDpiRecolored = recolorPng(withDpi, target);
assert(withDpiRecolored.ok);
assert.deepEqual(
  [...withDpiRecolored.png.subarray(33, 54)],
  [...withDpi.subarray(33, 54)],
  "pHYs resolution chunk must be preserved exactly",
);

// Crop is the authoritative output frame; outside pixels are ignored.
const cropped = recolorPng(fixture, target, { x: 1, y: 0, width: 2, height: 2 });
assert(cropped.ok);
assert.deepEqual([cropped.width, cropped.height], [2, 2]);
const cropPixels = rgba(cropped.png);
assert.deepEqual([...cropPixels.subarray(3, 4)], [47]);
assert.deepEqual([...cropPixels.subarray(7, 8)], [0]);
assert.equal(analyzeColorChangePng(fixture, { x: 2, y: 1, width: 2, height: 1 }).reason, "invalid-crop");

assert.equal(analyzeColorChangePng(new Uint8Array()).reason, "empty-input");
assert.equal(analyzeColorChangePng(png([1, 2, 3], 1, 1, 3)).reason, "no-alpha-channel");
assert.equal(analyzeColorChangePng(png([24, 91, 173, 255, 80, 40, 10, 255], 2, 1)).reason, "multiple-visible-colors");
assert.equal(analyzeColorChangePng(png([24, 91, 173, 255, 25, 91, 173, 64], 2, 1)).reason, "multiple-visible-colors");
assert.equal(analyzeColorChangePng(png([24, 91, 173, 0], 1, 1)).reason, "no-visible-pixels");
const sixteenBit = encode({
  width: 1, height: 1, data: new Uint16Array([0x1800, 0x5b00, 0xad00, 0xffff]), channels: 4, depth: 16,
});
assert.equal(analyzeColorChangePng(sixteenBit).reason, "unsupported-bit-depth");
const indexed = encode({
  width: 2, height: 1, data: new Uint8Array([0, 1]), channels: 1, depth: 8,
  palette: [[24, 91, 173, 255], [201, 3, 111, 0]],
});
assert.equal(analyzeColorChangePng(indexed).eligible, true, "indexed tRNS is supported");

// Neutral ink remains valid in RGBA and grayscale+alpha. Low alpha must not
// make the source look like a matte, while actual grayscale shading is refused.
const blackRgba = png([0, 0, 0, 255, 0, 0, 0, 9], 2, 1);
assert.deepEqual(analyzeColorChangePng(blackRgba), {
  eligible: true, sourceColor: { r: 0, g: 0, b: 0 }, width: 2, height: 1,
});
const blackGrayAlpha = png([0, 255, 0, 14], 2, 1, 2);
assert.deepEqual(analyzeColorChangePng(blackGrayAlpha), {
  eligible: true, sourceColor: { r: 0, g: 0, b: 0 }, width: 2, height: 1,
});
const grayShading = png([0, 255, 15, 14], 2, 1, 2);
assert.equal(analyzeColorChangePng(grayShading).reason, "multiple-visible-colors");

// A tiny hand-made APNG marker is enough for the core's structural APNG guard.
const animated = new Uint8Array(fixture.length + 20);
animated.set(fixture.subarray(0, 33));
animated.set([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 33);
animated.set(fixture.subarray(33), 53);
assert.equal(analyzeColorChangePng(animated).reason, "animated-png");

console.log("color-change-core verifier passed");