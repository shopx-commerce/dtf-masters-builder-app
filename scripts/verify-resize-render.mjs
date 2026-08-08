// Verification for the drag/resize render-path change. Checks the behaviours
// that could plausibly regress now that active interactions are serviced only
// by the rAF-coalesced window listener, and that a group gesture bakes its
// companions back into the static composite on pointer-up.
//
//   1. mouse drag actually moves a design
//   2. mouse resize actually resizes it, and the committed size lands in the
//      toolbar W field on release
//   3. marquee selection still works (it used the removed synchronous path)
//   4. touch drag and touch resize still work (iOS path, unchanged code)
//   5. after a group resize, the committed frame draws only the composite
//      blit + the primary design, i.e. companions are baked back in at full
//      opacity rather than left ghosted from the last mid-gesture frame
//
//   node scripts/verify-resize-render.mjs [appPort] [designCount]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_PORT = process.argv[2] || '5000';
const DESIGN_COUNT = Number(process.argv[3] || 8);
const PORT = 9600 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-resize-perf');
fs.mkdirSync(OUT, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-verify-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profileDir}`, '--headless=new',
  '--window-size=1600,1000', '--force-device-scale-factor=1',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
let ws, id = 0;
const pending = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const p = path.join(OUT, `verify-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

const INSTRUMENT = `(() => {
  if (window.__vf) return 'already';
  const P = window.__vf = { on: false, reset() { this.frames = []; this.frameOn = 0; this.off = 0; this.comp = 0; this.rr = []; this.sr = []; } };
  P.reset();
  const proto = CanvasRenderingContext2D.prototype;
  const od = proto.drawImage;
  proto.drawImage = function (...a) {
    if (P.on) {
      if (this.canvas && this.canvas.isConnected) P.frameOn++;
      else {
        P.off++;
        // The static composite is the only off-screen canvas sized to the
        // preview buffer (or half of it mid-drag). Layer thumbnails and other
        // scratch canvases are far smaller, so this separates real composite
        // rebuilds from unrelated off-screen work.
        const main = document.querySelector('canvas.z-10');
        if (main && this.canvas) {
          const w = this.canvas.width;
          if (Math.abs(w - main.width) <= 1 || Math.abs(w - Math.round(main.width * 0.5)) <= 1) P.comp++;
        }
      }
    }
    return od.apply(this, a);
  };
  const oc = proto.clearRect;
  proto.clearRect = function (...a) {
    if (P.on && this.canvas && this.canvas.isConnected) {
      P.frames.push(P.frameOn); P.frameOn = 0;
      if (P.frames.length > 400) P.frames.splice(0, 200);
    }
    return oc.apply(this, a);
  };
  const orr = proto.roundRect;
  if (orr) proto.roundRect = function (x, y, w, h, r) {
    try { const t = this.getTransform(); P.rr.push({ w, h, e: t.e, f: t.f }); if (P.rr.length > 200) P.rr.splice(0, 100); } catch (e) {}
    return orr.apply(this, arguments);
  };
  const osr = proto.strokeRect;
  proto.strokeRect = function (x, y, w, h) {
    try { P.sr.push({ x, y, w, h }); if (P.sr.length > 200) P.sr.splice(0, 100); } catch (e) {}
    return osr.apply(this, arguments);
  };
  return 'installed';
})()`;

const SPACE = `(() => {
  const main = document.querySelector('canvas.z-10');
  if (!main) return null;
  const rect = main.getBoundingClientRect();
  const z = rect.width / main.offsetWidth;
  const actualDpi = main.width / parseFloat(main.style.width);
  const border = parseFloat(getComputedStyle(main).borderLeftWidth) || 0;
  return { left: rect.left, top: rect.top, z, screenPerDraw: z / actualDpi, border, bufW: main.width, bufH: main.height };
})()`;
const toScreen = (sp, bx, by) => ({
  x: Math.round(sp.left + sp.border * sp.z + bx * sp.screenPerDraw),
  y: Math.round(sp.top + sp.border * sp.z + by * sp.screenPerDraw),
});

const mouse = (type, x, y, mods = 0) => send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
  clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: mods, pointerType: 'mouse',
});
const click = async (x, y, mods = 0) => {
  await mouse('mouseMoved', x, y, mods); await sleep(40);
  await mouse('mousePressed', x, y, mods); await sleep(60);
  await mouse('mouseReleased', x, y, mods); await sleep(450);
};
const touch = (type, x, y) => send('Input.dispatchTouchEvent', {
  type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 12, radiusY: 12, force: 1 }],
});

const handles = () => evaluate(`(() => {
  if (!window.__vf) return { error: 'no-hook' };
  const c = (window.__vf.rr || []).filter(k => Math.abs(k.w - k.h) < 0.01 && k.w > 0);
  if (c.length < 4) return { error: 'handles(' + c.length + ')' };
  const t = c.slice(-4);
  const xs = t.map(k => k.e), ys = t.map(k => k.f);
  return {
    pts: t.map(k => ({ x: k.e, y: k.f })),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
    cx: (Math.min(...xs) + Math.max(...xs)) / 2,
    cy: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
})()`);
const groupBox = () => evaluate(`(() => {
  if (!window.__vf) return null;
  let best = null;
  for (const c of (window.__vf.sr || []).slice(-24)) if (!best || c.w * c.h > best.w * best.h) best = c;
  return best;
})()`);
const widthField = () => evaluate(`(() => {
  const el = [...document.querySelectorAll('input[type=text]')].find(i => (i.title || '').startsWith('Width (inches)'));
  return el ? parseFloat(el.value) : null;
})()`);
const selectionCount = () => evaluate(`(() => {
  if (!window.__vf) return null;
  let best = null;
  for (const c of (window.__vf.sr || []).slice(-24)) if (!best || c.w * c.h > best.w * best.h) best = c;
  return best ? +(best.w * best.h).toFixed(0) : 0;
})()`);

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
};

/** Re-select the design nearest a predicted screen point, then fall back to a
 *  full grid probe. Gestures move things, so a single blind click is fragile. */
async function reselectNear(sp, x, y) {
  const offsets = [[0, 0], [10, 0], [-10, 0], [0, 10], [0, -10], [18, 18], [-18, -18], [18, -18], [-18, 18], [30, 0], [-30, 0], [0, 30], [0, -30]];
  for (const [dx, dy] of offsets) {
    await evaluate('if (window.__vf) window.__vf.rr = []; "ok"');
    await click(Math.round(x + dx), Math.round(y + dy));
    const h = await handles();
    if (!h.error) return h;
  }
  return await acquire(sp);
}

async function acquire(sp, verbose = false) {
  for (let fy = 0.06; fy <= 0.9; fy += 0.08) {
    for (let fx = 0.08; fx <= 0.94; fx += 0.09) {
      const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
      if (p.y < 0 || p.y > 1000 || p.x < 0 || p.x > 1600) continue;
      await evaluate('if (window.__vf) window.__vf.rr = []; "ok"');
      await click(p.x, p.y);
      const h = await handles();
      if (!h.error) return h;
      if (verbose) console.log(`    probe (${fx.toFixed(2)},${fy.toFixed(2)}) → screen ${p.x},${p.y}: ${h.error}`);
    }
  }
  return null;
}

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await targets()).length) break; } catch {} await sleep(250); }
  const page = (await targets()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/test-builder?stress=${DESIGN_COUNT}` });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const n = await evaluate(`(() => { const e = document.querySelector('.layers-scroll'); return e ? (e.innerText.match(/stress-512px/g) || []).length : 0; })()`).catch(() => 0);
    if (n >= DESIGN_COUNT) { console.log(`sheet ready: ${n} designs`); break; }
  }
  await sleep(2500);
  console.log('instrument:', await evaluate(INSTRUMENT));
  let sp = null;
  for (let i = 0; i < 30; i++) {
    sp = await evaluate(SPACE);
    if (sp && sp.bufW > 10 && Number.isFinite(sp.screenPerDraw)) break;
    sp = null;
    await sleep(1000);
  }
  if (!sp) { console.log('preview canvas never appeared — abort'); await shot('99-no-canvas'); return; }
  console.log('buffer', sp.bufW, 'x', sp.bufH);
  await evaluate('window.__vf.on = true; "ok"');
  await shot('00-sheet');

  console.log('\n1) mouse DRAG moves the design');
  let h = await acquire(sp, true);
  if (!h) { console.log('could not select'); await shot('98-noselect'); return; }
  const c0 = { x: h.cx, y: h.cy };
  let s = toScreen(sp, h.cx, h.cy);
  await mouse('mousePressed', s.x, s.y);
  for (let i = 1; i <= 12; i++) { await mouse('mouseMoved', s.x + i * 4, s.y + i * 2); await sleep(18); }
  await mouse('mouseReleased', s.x + 48, s.y + 24);
  await sleep(900);
  let h1 = await reselectNear(sp, s.x + 48, s.y + 24);
  const moved = !h1 || h1.error ? null : Math.hypot(h1.cx - c0.x, h1.cy - c0.y);
  check('mouse drag moves the design', moved != null && moved > 20,
    moved == null ? 'could not re-select after the drag' : `centre moved ${moved.toFixed(1)} buffer px`);

  console.log('\n2) mouse RESIZE resizes it and commits the size on release');
  if (!h1 || h1.error) h1 = await acquire(sp);
  if (!h1) { console.log('could not select for resize'); return; }
  const wBefore = await widthField();
  const w0 = h1.w;
  let brS = toScreen(sp, h1.pts[2].x, h1.pts[2].y);
  await mouse('mousePressed', brS.x, brS.y);
  for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', brS.x + i * 4, brS.y + i * 3); await sleep(18); }
  await mouse('mouseReleased', brS.x + 64, brS.y + 48);
  await sleep(1000);
  const frames = await evaluate('({ last: window.__vf.frames[window.__vf.frames.length - 1] ?? null, off: window.__vf.off })');
  const hAfter = await handles();
  const wAfter = await widthField();
  check('mouse resize grows the design', !hAfter.error && hAfter.w > w0 * 1.05,
    hAfter.error ? hAfter.error : `bbox width ${w0.toFixed(1)} → ${hAfter.w.toFixed(1)} buffer px`);
  check('resize commits to the toolbar W field', wBefore != null && wAfter != null && wAfter > wBefore,
    `W ${wBefore} → ${wAfter} in`);
  check('committed frame after single resize draws composite + design only',
    frames.last === 2, `committed frame on-screen drawImage count = ${frames.last}`);
  await shot('01-after-mouse-resize');

  console.log('\n3) marquee selection still works');
  // Deselect, then marquee across the whole sheet from just inside the corner.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const tl = toScreen(sp, 4, 4);
  const brFar = toScreen(sp, sp.bufW - 6, sp.bufH * 0.5);
  await evaluate('if (window.__vf) window.__vf.sr = []; "ok"');
  await mouse('mousePressed', tl.x, tl.y);
  for (let i = 1; i <= 20; i++) {
    await mouse('mouseMoved',
      Math.round(tl.x + (brFar.x - tl.x) * i / 20),
      Math.round(tl.y + (brFar.y - tl.y) * i / 20));
    await sleep(18);
  }
  await mouse('mouseReleased', brFar.x, brFar.y);
  await sleep(1200);
  const gb = await groupBox();
  check('marquee drag creates a multi-selection', !!gb && gb.w > 50 && gb.h > 50,
    gb ? `group bbox ${gb.w.toFixed(0)}x${gb.h.toFixed(0)} buffer px` : 'no group bbox drawn');
  await shot('02-marquee');

  console.log('\n4) group RESIZE, and the composite is rebuilt on pointer-up');
  // Build the group with ctrl+click: it gives a primary selection and a group
  // bbox whose corner handle is reliably grabbable, whereas pressing near a
  // marquee-derived corner can start a fresh marquee instead.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const g0 = await acquire(sp);
  let picked = 1;
  if (g0) {
    for (let fy = 0.06; fy <= 0.9 && picked < 5; fy += 0.08) {
      for (let fx = 0.08; fx <= 0.94 && picked < 5; fx += 0.09) {
        const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
        if (p.y < 0 || p.y > 1000) continue;
        if (Math.abs(p.x - toScreen(sp, g0.cx, g0.cy).x) < 14 && Math.abs(p.y - toScreen(sp, g0.cx, g0.cy).y) < 14) continue;
        await evaluate('if (window.__vf) window.__vf.sr = []; "ok"');
        await click(p.x, p.y, 2);
        const b = await groupBox();
        if (b && b.w > 4) picked++;
      }
    }
  }
  const gbCtrl = await groupBox();
  console.log(`  ctrl+click selection: ~${picked} designs, group bbox ${gbCtrl ? gbCtrl.w.toFixed(0) + 'x' + gbCtrl.h.toFixed(0) : 'none'}`);
  if (gbCtrl && gbCtrl.w > 50) {
    const gb = gbCtrl;
    const gbr = toScreen(sp, gb.x + gb.w, gb.y + gb.h);
    await evaluate('window.__vf.reset(); window.__vf.on = true; "ok"');
    await mouse('mousePressed', gbr.x, gbr.y);
    let mid = null;
    for (let i = 1; i <= 20; i++) {
      await mouse('mouseMoved', gbr.x - i * 3, gbr.y - i * 2);
      await sleep(18);
      if (i === 12) mid = await evaluate('({ off: window.__vf.off, frames: window.__vf.frames.length })');
    }
    const during = (await evaluate('({ off: window.__vf.off, comp: window.__vf.comp })'));
    // Zero the counters BEFORE releasing: React flushes the pointer-up state
    // update in a microtask, so the commit render lands well inside the CDP
    // round-trip that a post-release reset would take.
    await evaluate('window.__vf.off = 0; window.__vf.comp = 0; window.__vf.frames = []; window.__vf.frameOn = 0; "ok"');
    await mouse('mouseReleased', gbr.x - 60, gbr.y - 40);
    await sleep(1200);
    const after = await evaluate('(window.__vf.frames.push(window.__vf.frameOn), { off: window.__vf.off, comp: window.__vf.comp, last: window.__vf.frames[window.__vf.frames.length - 1] ?? null, frames: window.__vf.frames.length })');
    const gb2 = await groupBox();
    check('group resize shrinks the group bbox', !!gb2 && gb2.w < gb.w * 0.98,
      gb2 ? `group width ${gb.w.toFixed(0)} → ${gb2.w.toFixed(0)} buffer px` : 'no group bbox after');
    check('group resize does NOT rebuild the composite per frame',
      during.comp / 20 < 2, `${(during.comp / 20).toFixed(2)} composite draws per pointer move (${(during.off / 20).toFixed(2)} total off-screen, the rest is layer-thumbnail work)`);
    check('pointer-up rebuilds the composite with the companions baked in',
      after.comp >= 2 && after.last === 2,
      `${after.comp} composite draws on release, committed frame on-screen draws = ${after.last}`);
    await shot('03-after-group-resize');
  } else {
    check('group resize checks', false, 'no multi-selection to resize');
  }

  console.log('\n5) touch drag and touch resize (iOS path)');
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(500);
  const ht = await acquire(sp);
  if (ht) {
    const ts = toScreen(sp, ht.cx, ht.cy);
    const tc0 = { x: ht.cx, y: ht.cy };
    await touch('touchStart', ts.x, ts.y);
    for (let i = 1; i <= 12; i++) { await touch('touchMove', ts.x + i * 4, ts.y - i * 2); await sleep(20); }
    await touch('touchEnd', ts.x + 48, ts.y - 24);
    await sleep(900);
    const htd = await reselectNear(sp, ts.x + 48, ts.y - 24);
    const tMoved = !htd || htd.error ? null : Math.hypot(htd.cx - tc0.x, htd.cy - tc0.y);
    check('touch drag moves the design', tMoved != null && tMoved > 20,
      tMoved == null ? 'could not re-select after the touch drag' : `centre moved ${tMoved.toFixed(1)} buffer px`);

    if (htd && !htd.error) {
      const tw0 = htd.w;
      const tbr = toScreen(sp, htd.pts[2].x, htd.pts[2].y);
      await touch('touchStart', tbr.x, tbr.y);
      for (let i = 1; i <= 16; i++) { await touch('touchMove', tbr.x + i * 4, tbr.y + i * 3); await sleep(20); }
      await touch('touchEnd', tbr.x + 64, tbr.y + 48);
      await sleep(1000);
      const tFrames = await evaluate('({ last: window.__vf.frames[window.__vf.frames.length - 1] ?? null })');
      const htr = await handles();
      check('touch resize grows the design', !htr.error && htr.w > tw0 * 1.05,
        htr.error ? htr.error : `bbox width ${tw0.toFixed(1)} → ${htr.w.toFixed(1)} buffer px`);
      check('committed frame after touch resize draws composite + design only',
        tFrames.last === 2, `committed frame on-screen drawImage count = ${tFrames.last}`);
    }
    await shot('04-after-touch');
  } else {
    check('touch checks', false, 'could not select a design for the touch tests');
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
  for (const f of failed) console.log(`  FAILED: ${f.name} — ${f.detail}`);
  fs.writeFileSync(path.join(OUT, 'verify-results.json'), JSON.stringify(results, null, 2));
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(300); try { ws?.close(); } catch {} chrome.kill(); process.exit(0);
});
