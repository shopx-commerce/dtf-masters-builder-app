/**
 * Smoke test for POST /api/prepare-raster-upload.
 *
 * Covers the cases where an import pipeline can silently damage artwork:
 *  - a soft drop-shadow ramp fading to alpha 1, which a colour-threshold trim
 *    would clip;
 *  - a 1 px hairline sticking out past the main shape;
 *  - a fully opaque image with a deliberate solid border, which must not be
 *    cropped at all;
 *  - binary (halftone-ready) alpha, which must be reported so the preview is
 *    resampled with nearest rather than smoothed.
 *
 * Usage: node scripts/smoke-prepare-raster.mjs [baseUrl]
 */
import sharp from "sharp";

const BASE = process.argv[2] ?? "http://127.0.0.1:5000";

const results = [];
function check(label, pass, detail) {
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function prepare(png, name) {
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), name);
  const started = Date.now();
  const res = await fetch(`${BASE}/api/prepare-raster-upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const num = (n) => Number(res.headers.get(n));
  const body = Buffer.from(await res.arrayBuffer());
  return {
    elapsed: Date.now() - started,
    body,
    contentType: res.headers.get("Content-Type"),
    sourceW: num("X-Anynest-Source-Width"),
    sourceH: num("X-Anynest-Source-Height"),
    crop: {
      x: num("X-Anynest-Crop-X"), y: num("X-Anynest-Crop-Y"),
      width: num("X-Anynest-Crop-Width"), height: num("X-Anynest-Crop-Height"),
    },
    previewW: num("X-Anynest-Preview-Width"),
    previewH: num("X-Anynest-Preview-Height"),
    binaryAlpha: res.headers.get("X-Anynest-Binary-Alpha") === "1",
    hasTransparency: res.headers.get("X-Anynest-Has-Transparency") === "1",
    sourceMP: num("X-Anynest-Source-MP"),
  };
}

function trueAlphaBox(raw, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (raw[(y * w + x) * 4 + 3] === 0) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
}

// ---------------------------------------------------------------- case 1
// 48 MP cut-out sticker with an anti-aliased shape, a soft shadow ramp and a
// 1 px hairline antenna.
{
  const W = 8000, H = 6000;
  const raw = Buffer.alloc(W * H * 4, 0);
  const SHAPE = { left: 1200, top: 900, right: 5200, bottom: 4100 };
  for (let y = SHAPE.top; y < SHAPE.bottom; y++) for (let x = SHAPE.left; x < SHAPE.right; x++) {
    const i = (y * W + x) * 4;
    raw[i] = 220; raw[i + 1] = 40; raw[i + 2] = 90; raw[i + 3] = 255;
  }
  // Soft shadow hanging off the bottom-right, fading to alpha 1 over 80 px.
  const PAD = 80;
  for (let d = 1; d <= PAD; d++) {
    const a = Math.max(1, Math.round(255 * (1 - d / PAD)));
    for (let x = SHAPE.left + 50; x < SHAPE.right + d && x < W; x++) {
      const i = ((SHAPE.bottom - 1 + d) * W + x) * 4;
      if (raw[i + 3] === 0) raw[i + 3] = a;
    }
    for (let y = SHAPE.top + 50; y < SHAPE.bottom + d && y < H; y++) {
      const i = (y * W + (SHAPE.right - 1 + d)) * 4;
      if (raw[i + 3] === 0) raw[i + 3] = a;
    }
  }
  // 1 px hairline running up from the shape into empty space.
  const HAIRLINE_TOP = 400;
  for (let y = HAIRLINE_TOP; y < SHAPE.top; y++) {
    const i = (y * W + 3000) * 4;
    raw[i] = 20; raw[i + 1] = 20; raw[i + 2] = 20; raw[i + 3] = 255;
  }

  const png = await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  const truth = trueAlphaBox(raw, W, H);
  console.log(`\ncase 1: cut-out sticker ${W}x${H} (${((W * H) / 1e6).toFixed(1)} MP), ${(png.length / 1048576).toFixed(1)} MB`);
  const r = await prepare(png, "sticker.png");
  const previewMeta = await sharp(r.body).metadata();

  check("returns a PNG preview", r.contentType === "image/png", r.contentType);
  check("source dimensions round-trip", r.sourceW === W && r.sourceH === H, `${r.sourceW}x${r.sourceH}`);
  check("content box is exact",
    r.crop.x === truth.left && r.crop.y === truth.top &&
    r.crop.x + r.crop.width === truth.right && r.crop.y + r.crop.height === truth.bottom,
    `got ${r.crop.x},${r.crop.y} ${r.crop.width}x${r.crop.height}; truth ${truth.left},${truth.top} ${truth.right - truth.left}x${truth.bottom - truth.top}`);
  check("hairline is not clipped", r.crop.y <= HAIRLINE_TOP, `crop top ${r.crop.y} vs hairline ${HAIRLINE_TOP}`);
  check("shadow ramp is not clipped",
    r.crop.x + r.crop.width >= SHAPE.right + PAD - 1 && r.crop.y + r.crop.height >= SHAPE.bottom + PAD - 1,
    `crop right ${r.crop.x + r.crop.width}, bottom ${r.crop.y + r.crop.height}`);
  check("empty margin is dropped", r.crop.width < W && r.crop.height < H, `${r.crop.width}x${r.crop.height}`);
  check("preview matches its headers",
    previewMeta.width === r.previewW && previewMeta.height === r.previewH, `${previewMeta.width}x${previewMeta.height}`);
  check("preview fits the inline decode budget",
    Math.max(previewMeta.width, previewMeta.height) <= 4096 && (previewMeta.width * previewMeta.height) / 1e6 <= 40,
    `${previewMeta.width}x${previewMeta.height} = ${((previewMeta.width * previewMeta.height) / 1e6).toFixed(1)} MP`);
  check("preview keeps alpha", previewMeta.hasAlpha === true);
  check("soft alpha is reported as non-binary", r.binaryAlpha === false);
  check("response is far smaller than the upload", r.body.length < png.length,
    `${(r.body.length / 1048576).toFixed(2)} MB down vs ${(png.length / 1048576).toFixed(1)} MB up`);
  console.log(`  (${r.elapsed} ms)`);
}

// ---------------------------------------------------------------- case 2
// Opaque photo-style image with an alpha channel and a deliberate white
// border. Must come back uncropped.
{
  const W = 7000, H = 6500;
  const raw = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const inner = x > 900 && x < W - 900 && y > 900 && y < H - 900;
    raw[i] = inner ? (x % 256) : 255;
    raw[i + 1] = inner ? (y % 256) : 255;
    raw[i + 2] = inner ? 128 : 255;
    raw[i + 3] = 255;
  }
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  console.log(`\ncase 2: opaque + white border ${W}x${H} (${((W * H) / 1e6).toFixed(1)} MP), ${(png.length / 1048576).toFixed(1)} MB`);
  const r = await prepare(png, "photo.png");
  check("solid border is preserved (no crop)",
    r.crop.x === 0 && r.crop.y === 0 && r.crop.width === W && r.crop.height === H,
    `crop ${r.crop.x},${r.crop.y} ${r.crop.width}x${r.crop.height}`);
  // An all-opaque alpha channel trivially satisfies "every value is 0 or 255",
  // and reporting that as binary sent ordinary photos down the hard-edge path:
  // nearest-neighbour preview and pixelated resampling at print size.
  check("fully opaque alpha is not reported as binary", r.binaryAlpha === false,
    `binaryAlpha=${r.binaryAlpha}`);
  check("no transparency reported, so the solid-background warning fires",
    r.hasTransparency === false, `hasTransparency=${r.hasTransparency}`);
  console.log(`  (${r.elapsed} ms)`);
}

// ---------------------------------------------------------------- case 3
// Binary-alpha halftone art: every alpha is exactly 0 or 255.
{
  const W = 7000, H = 6000;
  const raw = Buffer.alloc(W * H * 4, 0);
  for (let y = 500; y < H - 500; y += 3) for (let x = 500; x < W - 500; x += 3) {
    const i = (y * W + x) * 4;
    raw[i] = 10; raw[i + 1] = 10; raw[i + 2] = 10; raw[i + 3] = 255;
  }
  const png = await sharp(raw, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  console.log(`\ncase 3: binary-alpha halftone ${W}x${H} (${((W * H) / 1e6).toFixed(1)} MP), ${(png.length / 1048576).toFixed(1)} MB`);
  const r = await prepare(png, "halftone.png");
  check("binary alpha is detected", r.binaryAlpha === true);
  console.log(`  (${r.elapsed} ms)`);
}

// ---------------------------------------------------------------- case 4
// Over the hard ceiling: must be rejected, not attempted.
{
  const W = 14000, H = 12000; // 168 MP
  const png = await sharp({
    create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  console.log(`\ncase 4: oversized ${W}x${H} (${((W * H) / 1e6).toFixed(0)} MP)`);
  const form = new FormData();
  form.append("image", new Blob([png], { type: "image/png" }), "huge.png");
  const res = await fetch(`${BASE}/api/prepare-raster-upload`, { method: "POST", body: form });
  const text = await res.text();
  check("over-ceiling upload is rejected with a reason", res.status === 400 && /MP/.test(text), `${res.status} ${text.slice(0, 120)}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
