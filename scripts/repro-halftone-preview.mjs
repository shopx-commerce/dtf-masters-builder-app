// Dev-only repro driver: launches headless Chrome, builds a design on the
// test builder, applies an appearance edit (halftone / magic wand / white BG),
// zooms in, and captures selected vs deselected screenshots of the same crop.
//
//   node scripts/repro-halftone-preview.mjs <label> [halftone|wand|whitebg]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const LABEL = process.argv[2] ?? 'run';
const MODE = process.argv[3] ?? 'halftone';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-repro');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-'));

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
async function shot(name, clip) {
  const params = { format: 'png' };
  if (clip) params.clip = { ...clip, scale: 1 };
  const r = await send('Page.captureScreenshot', params);
  const p = path.join(OUT, `${LABEL}-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  →', p);
  return r.data;
}

/** Hand a screenshot back to the page so Chrome decodes it, then measure the
 *  artwork's right edge and any transparent gap eating into it. */
async function measureEdge(b64, tag, band) {
  return evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const { data, width } = x.getImageData(0, 0, img.width, img.height);
    const isInk = (i) => data[i] > 140 && data[i+1] < 130 && data[i+2] < 130;
    const rows = ${JSON.stringify(band.rows)};
    const x0 = ${band.x0}, x1 = ${band.x1};
    const edges = [], gaps = [];
    for (const y of rows) {
      let last = -1;
      for (let px = x0; px < x1; px++) if (isInk((y * width + px) * 4)) last = px;
      edges.push(last);
      // Count ink-free columns in the 40px immediately left of the edge.
      let holes = 0;
      if (last > x0 + 40) {
        for (let px = last - 40; px < last; px++) {
          let any = false;
          for (let dy = -6; dy <= 6; dy++) if (isInk(((y + dy) * width + px) * 4)) { any = true; break; }
          if (!any) holes++;
        }
      }
      gaps.push(holes);
    }
    return { tag: ${JSON.stringify(tag)}, edges, gapColumns: gaps };
  })()`);
}
const wheel = (x, y, deltaY, ctrl) => send('Input.dispatchMouseEvent', {
  type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0, pointerType: 'mouse',
});
const clickByText = (txt) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().includes(${JSON.stringify(txt)}));
  if (!b) return 'missing';
  b.click();
  return 'clicked';
})()`);
const zoomPct = () => evaluate(
  `(() => { const t=[...document.querySelectorAll('span,div')].map(n=>n.textContent).find(t=>/^\\d+%$/.test((t||'').trim())); return t?parseInt(t):0; })()`,
);
const geometry = () => evaluate(`(() => {
  const main = document.querySelector('.preview-canvas-area canvas.z-10');
  const ov = document.querySelector('.preview-canvas-area canvas.z-20');
  const r = e => e ? (({x,y,width,height}) => ({x:+x.toFixed(2),y:+y.toFixed(2),width:+width.toFixed(2),height:+height.toFixed(2)}))(e.getBoundingClientRect()) : null;
  const cs = main && getComputedStyle(main);
  const border = cs ? parseFloat(cs.borderLeftWidth) : 0;
  const mr = r(main);
  const or = r(ov);
  let scale = null, expectedOverlayX = null, offsetPx = null;
  if (mr && ov) {
    // CSS zoom factor = rendered border-box width / layout border-box width.
    scale = mr.width / (main.offsetWidth);
    // Wrapper origin = main border-box left minus its 3px inset. The overlay
    // must land on the canvas PIXEL SURFACE, i.e. inset + border into the
    // wrapper, plus the design's offset within that surface.
    const wrapperX = mr.x - 3 * scale;
    const designX = parseFloat(ov.style.left) - (3 + border);
    expectedOverlayX = wrapperX + (3 + border + designX) * scale;
    offsetPx = +(or.x - expectedOverlayX).toFixed(2);
  }
  return { main: mr, overlay: or, overlayBuffer: ov ? [ov.width, ov.height] : null,
           overlayStyle: ov ? { left: ov.style.left, top: ov.style.top, clip: ov.style.clipPath } : null,
           borderPx: border, scale: scale && +scale.toFixed(4),
           expectedOverlayX: expectedOverlayX && +expectedOverlayX.toFixed(2), offsetPx };
})()`);

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

  await send('Page.navigate', { url: 'http://localhost:5000/test-builder?stress=1' });
  await sleep(9000);

  if (MODE === 'halftone') {
    console.log('halftone menu:', await clickByText('Halftone'));
    await sleep(700);
    console.log('black garment:', await clickByText('Black garment'));
    await sleep(4500);
  } else if (MODE === 'whitebg') {
    console.log('white bg:', await clickByText('White BG'));
    await sleep(4500);
  } else if (MODE === 'pixelclean') {
    console.log('pixel clean:', await clickByText('Pixel Clean'));
    await sleep(4500);
  } else if (MODE === 'wand') {
    console.log('magic wand:', await clickByText('Magic Wand'));
    await sleep(1000);
    // Tap inside the design so the wand actually deletes a region.
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 367, y: 247, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 367, y: 247, button: 'left', clickCount: 1 });
    await sleep(3500);
    // Re-select: the wand tap may drop selection.
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 367, y: 247, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 367, y: 247, button: 'left', clickCount: 1 });
    await sleep(800);
  }

  await clickByText('Focus');
  await sleep(1200);
  const area = await evaluate(`(() => { const r = document.querySelector('.preview-canvas-area').getBoundingClientRect(); return { cx: r.left + r.width/2, cy: r.top + r.height/2 }; })()`);
  for (let i = 0; i < 18; i++) {
    await wheel(area.cx, area.cy, -120, true);
    await sleep(120);
    if (await zoomPct() >= 420) break;
  }
  await sleep(1600);

  // The Halftone button is disabled unless a design is selected — use it as a
  // selection probe so a "no artifact" result can't be a false negative.
  const selected = await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.innerText||'').trim().includes('Halftone')); return b ? !b.disabled : null; })()`,
  );
  const g = await geometry();
  console.log(`zoom ${await zoomPct()}% · designSelected=${selected} · geometry:`, JSON.stringify(g));
  if (g.offsetPx !== null) {
    console.log(`  OVERLAY MISALIGNMENT: ${g.offsetPx}px on screen (${(g.offsetPx / g.scale).toFixed(2)} CSS px pre-zoom)`);
  }

  // Crop the design's right edge and the glyph area — where the artifact shows.
  const clipRight = g.overlay
    ? { x: Math.round(g.overlay.x + g.overlay.width - 120), y: Math.round(Math.max(140, g.overlay.y + 100)), width: 220, height: 320 }
    : null;
  const clipLeft = { x: 226, y: 200, width: 260, height: 300 };

  const band = { rows: [220, 300, 380, 440], x0: 240, x1: 1020 };
  const selShot = await shot('selected-full');
  if (clipRight) await shot('selected-rightedge', clipRight);
  await shot('selected-leftglyph', clipLeft);
  const selEdge = await measureEdge(selShot, 'selected', band);

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
  await sleep(900);
  console.log('overlay after deselect:', await evaluate(`!!document.querySelector('.preview-canvas-area canvas.z-20')`));
  const deselShot = await shot('deselected-full');
  if (clipRight) await shot('deselected-rightedge', clipRight);
  await shot('deselected-leftglyph', clipLeft);
  const deselEdge = await measureEdge(deselShot, 'deselected', band);

  console.log('\nARTWORK RIGHT EDGE (screen px) — selected vs deselected must match');
  console.log('  selected  :', JSON.stringify(selEdge));
  console.log('  deselected:', JSON.stringify(deselEdge));
  const shift = selEdge.edges.map((e, i) => e - deselEdge.edges[i]);
  console.log('  edge delta:', JSON.stringify(shift));
  console.log('  gap columns while selected:', JSON.stringify(selEdge.gapColumns), '(0 = no hole in the artwork)');
  console.log('done');
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
