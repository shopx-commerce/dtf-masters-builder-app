// Dev-only repro driver for the draft-recovery re-framing bug.
//
// Uploads a PNG whose artwork is a small off-centre red square inside a large
// transparent canvas, measures where that red lands on the artboard, forces a
// draft save, reloads, recovers the draft, and measures again. If recovery is
// faithful the two measurements match.
//
//   node scripts/repro-draft-reframe.mjs <label>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const LABEL = process.argv[2] ?? 'run';
const SRC = Number(process.env.SRC_DIM || 3000);
const ART = Number(process.env.ART_DIM || 1200);
const ART_X = Number(process.env.ART_X || 200);
const ART_Y = Number(process.env.ART_Y || 200);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-draft-reframe');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-draft-'));

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
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `${LABEL}-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  screenshot →', p);
}

const MAKE_AND_DROP = `(async () => {
  const c = document.createElement('canvas');
  c.width = ${SRC}; c.height = ${SRC};
  const x = c.getContext('2d');
  x.clearRect(0, 0, ${SRC}, ${SRC});
  x.fillStyle = '#e01b1b';
  x.fillRect(${ART_X}, ${ART_Y}, ${ART}, ${ART});
  // Corner marker so a flip/rotation would be visible too.
  x.fillStyle = '#1b3fe0';
  x.fillRect(${ART_X}, ${ART_Y}, ${Math.round(ART / 6)}, ${Math.round(ART / 6)});
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  c.width = 0; c.height = 0;
  const file = new File([blob], 'margin-test.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = [...document.querySelectorAll('input[type=file]')]
    .find(el => (el.accept || '').includes('png'));
  if (!input) return { ok: false, why: 'no file input' };
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, bytes: blob.size };
})()`;

/** Red/blue artwork bbox on the main artboard canvas, in backing-store px. */
const MEASURE = `(() => {
  const canvases = [...document.querySelectorAll('canvas')]
    .filter(c => c.width > 200 && c.height > 200);
  if (!canvases.length) return { ok: false, why: 'no canvas' };
  const main = canvases.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
  const ctx = main.getContext('2d');
  let d;
  try { d = ctx.getImageData(0, 0, main.width, main.height).data; }
  catch (e) { return { ok: false, why: 'getImageData: ' + e.message }; }
  let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, redPx = 0;
  let bMinX = 1e9, bMinY = 1e9, bMaxX = -1, bMaxY = -1;
  for (let y = 0; y < main.height; y++) {
    for (let px = 0; px < main.width; px++) {
      const i = (y * main.width + px) * 4;
      const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
      if (a < 40) continue;
      const isRed = r > 150 && g < 110 && b < 110;
      const isBlue = b > 150 && r < 110 && g < 110;
      if (isRed || isBlue) {
        redPx++;
        if (px < minX) minX = px; if (px > maxX) maxX = px;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      if (isBlue) {
        if (px < bMinX) bMinX = px; if (px > bMaxX) bMaxX = px;
        if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
      }
    }
  }
  const sizeInputs = [...document.querySelectorAll('input')]
    .map(el => ({ v: el.value, aria: el.getAttribute('aria-label') || '', id: el.id || '', name: el.name || '', type: el.type }))
    .filter(o => o.type !== 'file');
  return {
    ok: maxX >= 0,
    canvas: { w: main.width, h: main.height, cssW: Math.round(main.getBoundingClientRect().width) },
    artwork: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    marker: bMaxX >= 0 ? { x: bMinX, y: bMinY, w: bMaxX - bMinX + 1, h: bMaxY - bMinY + 1 } : null,
    inkPx: redPx,
    inputs: sizeInputs,
  };
})()`;

/** What the draft actually holds: stored geometry + the blob's real pixel size. */
const READ_DRAFT = `(async () => {
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open('sticker-editor-drafts');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const db = await open();
  const get = (store, key) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readonly');
    const rq = tx.objectStore(store).get(key);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  const draft = await get('drafts', 'current');
  if (!draft) return { ok: false, why: 'no draft record' };
  const out = [];
  for (const d of draft.designs) {
    const rec = await get('files', d.fileKey);
    let dims = null;
    if (rec) {
      const url = URL.createObjectURL(rec.blob);
      const img = new Image();
      await new Promise(r => { img.onload = r; img.onerror = r; img.src = url; });
      dims = { w: img.naturalWidth, h: img.naturalHeight };
      URL.revokeObjectURL(url);
    }
    out.push({
      name: d.name, fileName: d.fileName, fileType: d.fileType,
      widthInches: d.widthInches, heightInches: d.heightInches,
      originalWidth: d.originalWidth, originalHeight: d.originalHeight,
      dpi: d.dpi, transform: d.transform,
      blobBytes: rec ? rec.blob.size : null,
      storedImagePixels: dims,
      hasExportCropField: 'exportCrop' in d,
    });
  }
  return { ok: true, savedAt: draft.savedAt, designs: out };
})()`;

/** Restore through the real module, to see the ImageInfo the editor receives. */
const RESTORE_DIRECT = `(async () => {
  const mod = await import('/src/lib/editor-draft-storage.ts');
  const draft = await mod.getCurrentEditorDraft();
  if (!draft) return { ok: false, why: 'no draft' };
  const restored = await mod.restoreEditorDraft(draft);
  return {
    ok: true,
    missingDesignCount: restored.missingDesignCount,
    designs: restored.designs.map(d => ({
      widthInches: d.widthInches,
      heightInches: d.heightInches,
      previewPixels: [d.imageInfo.image.naturalWidth, d.imageInfo.image.naturalHeight],
      originalWidth: d.imageInfo.originalWidth,
      originalHeight: d.imageInfo.originalHeight,
      fileBytes: d.imageInfo.file.size,
      exportBlobBytes: d.imageInfo.exportBlob ? d.imageInfo.exportBlob.size : null,
      exportCrop: d.imageInfo.exportCrop ?? null,
    })),
  };
})()`;

const clickByText = (txt) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().includes(${JSON.stringify(txt)}));
  if (!b) return 'missing';
  if (b.disabled) return 'disabled';
  b.click();
  return 'clicked';
})()`);

async function waitFor(expr, label, tries = 60, gap = 500) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expr)) return true;
    await sleep(gap);
  }
  console.log(`  !! timed out waiting for ${label}`);
  return false;
}

function report(tag, m) {
  console.log(`\n[${tag}]`);
  if (!m.ok) { console.log('  MEASURE FAILED:', m.why ?? JSON.stringify(m)); return; }
  const { canvas, artwork, marker, inkPx } = m;
  const pctW = ((artwork.w / canvas.w) * 100).toFixed(2);
  const pctH = ((artwork.h / canvas.h) * 100).toFixed(2);
  console.log(`  canvas ${canvas.w}x${canvas.h} (css ${canvas.cssW})`);
  console.log(`  artwork bbox  x=${artwork.x} y=${artwork.y} w=${artwork.w} h=${artwork.h}` +
              `  (${pctW}% x ${pctH}% of artboard)  inkPx=${inkPx}`);
  if (marker) console.log(`  blue marker   x=${marker.x} y=${marker.y} w=${marker.w} h=${marker.h}`);
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
  send('Log.enable').catch(() => {});
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.method === 'Runtime.consoleAPICalled') {
      const txt = (msg.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (/draft|error|failed|warn/i.test(txt)) console.log('  [page]', txt.slice(0, 240));
    }
  });

  console.log(`source ${SRC}x${SRC}, artwork ${ART}x${ART} at (${ART_X},${ART_Y})`);
  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await waitFor(`!!document.querySelector('input[type=file]')`, 'editor mount');
  await sleep(2500);

  console.log('drop:', JSON.stringify(await evaluate(MAKE_AND_DROP)));
  await waitFor(`(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(c => c.width > 200 && c.height > 200);
    if (!cs.length) return false;
    const m = cs.reduce((a,b) => a.width*a.height >= b.width*b.height ? a : b);
    const d = m.getContext('2d').getImageData(0,0,m.width,m.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) return true;
    return false;
  })()`, 'design on artboard', 80);
  await sleep(1500);

  const before = await evaluate(MEASURE);
  report('BEFORE — live session', before);
  console.log('  size inputs:', JSON.stringify(before.inputs));
  await shot('01-before');

  // Debounce is 750 ms + an idle callback with a 2 s timeout.
  await sleep(5000);
  const draft = await evaluate(READ_DRAFT);
  console.log('\n[DRAFT ON DISK]');
  console.log(JSON.stringify(draft, null, 2));
  console.log('\n[RESTORED IMAGEINFO — straight from the module]');
  console.log(JSON.stringify(await evaluate(RESTORE_DIRECT), null, 2));

  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await waitFor(`!!document.querySelector('input[type=file]')`, 'editor remount');
  await sleep(2500);
  console.log('\nrecover button:', await clickByText('Recover draft'));
  await waitFor(`(() => {
    const cs = [...document.querySelectorAll('canvas')].filter(c => c.width > 200 && c.height > 200);
    if (!cs.length) return false;
    const m = cs.reduce((a,b) => a.width*a.height >= b.width*b.height ? a : b);
    const d = m.getContext('2d').getImageData(0,0,m.width,m.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) return true;
    return false;
  })()`, 'design after recovery', 80);
  await sleep(2000);

  const after = await evaluate(MEASURE);
  report('AFTER — recovered draft', after);
  console.log('  size inputs:', JSON.stringify(after.inputs));
  await shot('02-after');

  if (before.ok && after.ok) {
    const sw = after.artwork.w / before.artwork.w;
    const sh = after.artwork.h / before.artwork.h;
    console.log('\n=== VERDICT ===');
    console.log(`  artwork width  ${before.artwork.w} → ${after.artwork.w} px  (x${sw.toFixed(3)})`);
    console.log(`  artwork height ${before.artwork.h} → ${after.artwork.h} px  (x${sh.toFixed(3)})`);
    console.log(`  artwork origin (${before.artwork.x},${before.artwork.y}) → (${after.artwork.x},${after.artwork.y})`);
    const drift = Math.abs(sw - 1) > 0.02 || Math.abs(sh - 1) > 0.02 ||
      Math.abs(after.artwork.x - before.artwork.x) > 3 || Math.abs(after.artwork.y - before.artwork.y) > 3;
    console.log(drift ? '  >>> RE-FRAMED: recovery changed the artwork geometry.'
                      : '  >>> FAITHFUL: recovery preserved the artwork geometry.');
    console.log(`  expected ratio if the full bitmap is stretched into the box: ${(ART / SRC).toFixed(3)}`);
  }
  console.log('\ndone');
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
