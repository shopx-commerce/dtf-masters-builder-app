// Dev-only driver: does a recovered draft export the same print file?
//
// Uploads a PNG with wide transparent margins whose artwork carries a
// fine-striped band, exports the gangsheet, then saves / reloads / recovers and
// exports again. The exported PNG is measured both times: the artwork's bounding
// box (geometry) and the striped band's run lengths (resolution — an export
// drawn from the capped preview instead of the print source resamples the
// stripes and the run lengths stop being uniform).
//
//   node scripts/verify-draft-export-fidelity.mjs <label>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const LABEL = process.argv[2] ?? 'run';
const SRC = Number(process.env.SRC_DIM || 3000);
const ART = Number(process.env.ART_DIM || 2600);
const ART_X = Number(process.env.ART_X || 150);
const ART_Y = Number(process.env.ART_Y || 250);
const STRIPE = 4;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9431 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-draft-reframe');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-export-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--window-size=1600,1000',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.value;
}

const MAKE_AND_DROP = `(async () => {
  const c = document.createElement('canvas');
  c.width = ${SRC}; c.height = ${SRC};
  const x = c.getContext('2d');
  x.clearRect(0, 0, ${SRC}, ${SRC});
  x.fillStyle = '#e01b1b';
  x.fillRect(${ART_X}, ${ART_Y}, ${ART}, ${ART});
  // Striped band: alternating ${STRIPE}px columns, cleared back to transparent.
  // Its run lengths only survive an export that draws from the print source.
  const bandTop = ${ART_Y} + Math.round(${ART} * 0.4);
  const bandHeight = Math.round(${ART} * 0.2);
  for (let px = ${ART_X}; px < ${ART_X + ART}; px += ${STRIPE} * 2) {
    x.clearRect(px, bandTop, ${STRIPE}, bandHeight);
  }
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = 0; c.height = 0;
  const file = new File([blob], 'stripe-test.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = [...document.querySelectorAll('input[type=file]')]
    .find(el => (el.accept || '').includes('png'));
  if (!input) return { ok: false, why: 'no file input' };
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, bytes: blob.size, band: { top: bandTop, height: bandHeight } };
})()`;

const ARM_DOWNLOAD = `(() => {
  window.__caughtDownload = null;
  if (!window.__downloadPatched) {
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patched() {
      if (this.download && String(this.href).startsWith('blob:')) {
        window.__caughtDownload = this.href;
        return;
      }
      return original.apply(this, arguments);
    };
    window.__downloadPatched = true;
  }
  return true;
})()`;

const CLICK_DOWNLOAD = `(() => {
  const buttons = [...document.querySelectorAll('button')];
  const b = buttons.find(x => /download gangsheet/i.test((x.innerText || '').trim()));
  if (!b) return { ok: false, buttons: buttons.map(x => (x.innerText || '').trim()).filter(Boolean).slice(0, 40) };
  if (b.disabled) return { ok: false, why: 'disabled' };
  b.click();
  return { ok: true };
})()`;

/** Measure the exported sheet: artwork bbox plus striped-band run lengths. */
const MEASURE_EXPORT = `(async () => {
  const url = window.__caughtDownload;
  if (!url) return { ok: false, why: 'no download captured' };
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  const x = c.getContext('2d');
  x.drawImage(bmp, 0, 0);
  bmp.close();
  const { data } = x.getImageData(0, 0, c.width, c.height);
  const W = c.width, H = c.height;
  const isInk = (i) => data[i + 3] > 128 && data[i] > 140 && data[i + 1] < 120 && data[i + 2] < 120;
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, ink = 0;
  for (let y = 0; y < H; y++) {
    for (let px = 0; px < W; px++) {
      const i = (y * W + px) * 4;
      if (!isInk(i)) continue;
      ink++;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { c.width = 0; c.height = 0; return { ok: false, why: 'no artwork in export', sheet: [W, H] }; }
  // The stripe band sits 40%-60% down the artwork; sample its middle row.
  const bandY = Math.round(minY + (maxY - minY) * 0.5);
  const runs = [];
  let current = null, length = 0, partial = 0;
  for (let px = minX; px <= maxX; px++) {
    const i = (bandY * W + px) * 4;
    const a = data[i + 3];
    if (a > 20 && a < 235) partial++;
    const on = a > 128;
    if (current === null) { current = on; length = 1; continue; }
    if (on === current) { length++; continue; }
    runs.push(length);
    current = on;
    length = 1;
  }
  runs.push(length);
  const interior = runs.slice(1, -1);
  const histogram = {};
  for (const r of interior) histogram[r] = (histogram[r] || 0) + 1;
  c.width = 0; c.height = 0;
  return {
    ok: true,
    sheet: [W, H],
    bytes: blob.size,
    artwork: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
    inkPixels: ink,
    band: {
      row: bandY,
      runs: interior.length,
      histogram,
      partialAlphaPixels: partial,
    },
  };
})()`;

async function waitFor(expr, label, tries = 120, gap = 500) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await sleep(gap);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return false;
}
const hasArtwork = `(() => {
  const cs = [...document.querySelectorAll('canvas')].filter(c => c.width > 200 && c.height > 200);
  if (!cs.length) return false;
  const m = cs.reduce((a,b) => a.width*a.height >= b.width*b.height ? a : b);
  const d = m.getContext('2d').getImageData(0,0,m.width,m.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) return true;
  return false;
})()`;

async function exportSheet(tag) {
  await evaluate(ARM_DOWNLOAD);
  const clicked = await evaluate(CLICK_DOWNLOAD);
  if (!clicked.ok) { console.log(`  download click failed (${tag}):`, JSON.stringify(clicked)); return null; }
  await waitFor(`!!window.__caughtDownload`, `export blob (${tag})`, 240, 500);
  const measured = await evaluate(MEASURE_EXPORT);
  console.log(`\n[EXPORT ${tag}]`);
  console.log(JSON.stringify(measured, null, 2));
  return measured;
}

async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await targets()).length) break; } catch {}
    await sleep(250);
  }
  const page = (await targets()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');

  console.log(`source ${SRC}x${SRC}, artwork ${ART}x${ART} at (${ART_X},${ART_Y}), ${STRIPE}px stripes`);
  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await waitFor(`!!document.querySelector('input[type=file]')`, 'editor mount');
  await sleep(2500);
  console.log('drop:', JSON.stringify(await evaluate(MAKE_AND_DROP)));
  await waitFor(hasArtwork, 'design on artboard');
  await sleep(2000);

  const before = await exportSheet('live session');
  await sleep(5000);

  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await waitFor(`!!document.querySelector('input[type=file]')`, 'editor remount');
  await sleep(2500);
  console.log('\nrecover:', await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /recover draft/i.test((x.innerText||'').trim()));
    if (!b) return 'missing'; if (b.disabled) return 'disabled'; b.click(); return 'clicked';
  })()`));
  await waitFor(hasArtwork, 'design after recovery');
  await sleep(2500);
  const after = await exportSheet('recovered draft');

  if (before?.ok && after?.ok) {
    console.log('\n=== EXPORT COMPARISON ===');
    console.log(`  sheet        ${before.sheet.join('x')} → ${after.sheet.join('x')}`);
    console.log(`  artwork box  ${JSON.stringify(before.artwork)} → ${JSON.stringify(after.artwork)}`);
    console.log(`  ink pixels   ${before.inkPixels} → ${after.inkPixels}`);
    console.log(`  stripe runs  ${before.band.runs} → ${after.band.runs}`);
    console.log(`  run lengths  ${JSON.stringify(before.band.histogram)} → ${JSON.stringify(after.band.histogram)}`);
    console.log(`  soft-alpha   ${before.band.partialAlphaPixels} → ${after.band.partialAlphaPixels}`);
    const geomSame =
      Math.abs(before.artwork.w - after.artwork.w) <= 2 &&
      Math.abs(before.artwork.h - after.artwork.h) <= 2 &&
      Math.abs(before.artwork.x - after.artwork.x) <= 2 &&
      Math.abs(before.artwork.y - after.artwork.y) <= 2;
    const sharpSame =
      JSON.stringify(before.band.histogram) === JSON.stringify(after.band.histogram);
    console.log(`  geometry: ${geomSame ? 'MATCH' : 'DIFFERS'} · stripe fidelity: ${sharpSame ? 'MATCH' : 'DIFFERS'}`);
  }
  console.log('\ndone');
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
