// Dev-only benchmark: compares what the canvas renderer actually does per
// pointer-move frame during a MOVE drag versus a RESIZE drag, for both a
// single-design selection and a multi-design selection.
//
// Why draw-call counting rather than wall-clock alone: canvas2d work in
// headless Chrome is deferred to the compositor, so `performance.now()` around
// a `drawImage` under-reports. The number of `drawImage` calls and the number
// of destination pixels they write is deterministic and is the thing the
// renderer's caching strategy is trying to reduce, so it is the primary
// signal. `Performance.getMetrics` (ScriptDuration / TaskDuration) and a CPU
// profile are collected alongside as corroborating main-thread cost.
//
//   node scripts/bench-resize-perf.mjs [appPort] [designCount] [label]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_PORT = process.argv[2] || '5000';
const DESIGN_COUNT = Number(process.argv[3] || 16);
const LABEL = process.argv[4] || 'run';
const PORT = 9520 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-resize-perf');
fs.mkdirSync(OUT, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-resizeperf-'));

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
  const p = path.join(OUT, `${LABEL}-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}

// ---------------------------------------------------------------- instrument
// Counts canvas work and separates the off-screen static composite (a canvas
// created with document.createElement and never attached, so `isConnected`
// is false) from the on-screen preview canvas.
const INSTRUMENT = `(() => {
  if (window.__rp) { return 'already'; }
  const P = window.__rp = {
    on: false,
    reset() {
      this.di = 0; this.diOn = 0; this.diOff = 0;
      this.pxOn = 0; this.pxOff = 0;
      this.msOn = 0; this.msOff = 0;
      this.clearsOn = 0; this.clearsOff = 0;
      this.gid = 0; this.pid = 0;
      this.newCanvas = 0;
      this.rafGaps = [];
      this.roundRects = [];
      this.strokeRects = [];
      // On-screen drawImage count per render frame. A render frame is
      // delimited by a clearRect on the visible canvas, so the last entry is
      // the committed frame — that is what verifies pointer-up correctness.
      this.frames = [];
      this.frameOn = 0;
    },
  };
  P.reset();

  const proto = CanvasRenderingContext2D.prototype;
  const origDraw = proto.drawImage;
  proto.drawImage = function (src, ...rest) {
    if (!P.on) return origDraw.call(this, src, ...rest);
    // Destination extent: drawImage(img, dx, dy, dw, dh) or the 9-arg form.
    let dw = 0, dh = 0;
    if (rest.length >= 7) { dw = rest[5]; dh = rest[6]; }
    else if (rest.length >= 3) { dw = rest[2]; dh = rest[3]; }
    else { dw = src.width || 0; dh = src.height || 0; }
    const t0 = performance.now();
    const r = origDraw.call(this, src, ...rest);
    const dt = performance.now() - t0;
    const px = Math.abs((dw || 0) * (dh || 0));
    P.di++;
    if (this.canvas && this.canvas.isConnected) { P.diOn++; P.frameOn++; P.pxOn += px; P.msOn += dt; }
    else { P.diOff++; P.pxOff += px; P.msOff += dt; }
    return r;
  };

  const origClear = proto.clearRect;
  proto.clearRect = function (...a) {
    if (P.on) {
      if (this.canvas && this.canvas.isConnected) {
        P.clearsOn++;
        P.frames.push(P.frameOn);
        P.frameOn = 0;
        if (P.frames.length > 400) P.frames.splice(0, 200);
      } else P.clearsOff++;
    }
    return origClear.apply(this, a);
  };

  const origGid = proto.getImageData;
  proto.getImageData = function (...a) { if (P.on) P.gid++; return origGid.apply(this, a); };
  const origPid = proto.putImageData;
  proto.putImageData = function (...a) { if (P.on) P.pid++; return origPid.apply(this, a); };

  const origCreate = document.createElement.bind(document);
  document.createElement = function (tag, ...a) {
    if (P.on && String(tag).toLowerCase() === 'canvas') P.newCanvas++;
    return origCreate(tag, ...a);
  };

  // Selection-handle geometry: the four white corner squares are the only
  // square roundRects the selection layer draws, and the group bbox is the
  // only strokeRect. Both carry the live buffer-space transform.
  const origRound = proto.roundRect;
  if (origRound) {
    proto.roundRect = function (x, y, w, h, r) {
      try {
        const t = this.getTransform();
        P.roundRects.push({ w, h, e: t.e, f: t.f });
        if (P.roundRects.length > 200) P.roundRects.splice(0, 100);
      } catch (e) {}
      return origRound.apply(this, arguments);
    };
  }
  const origStrokeRect = proto.strokeRect;
  proto.strokeRect = function (x, y, w, h) {
    try {
      P.strokeRects.push({ x, y, w, h });
      if (P.strokeRects.length > 200) P.strokeRects.splice(0, 100);
    } catch (e) {}
    return origStrokeRect.apply(this, arguments);
  };

  // rAF cadence during the drag, as a frame-rate proxy.
  let last = null;
  const tick = (ts) => {
    if (P.on && last != null) { const g = ts - last; if (g > 0 && g < 2000) P.rafGaps.push(g); }
    last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'installed';
})()`;

// Buffer-space → screen CSS px, matching the wrapper's CSS zoom transform.
const SPACE = `(() => {
  const main = document.querySelector('canvas.z-10');
  if (!main) return null;
  const rect = main.getBoundingClientRect();
  const z = rect.width / main.offsetWidth;
  const contentW = parseFloat(main.style.width);
  const actualDpi = main.width / contentW;
  const border = parseFloat(getComputedStyle(main).borderLeftWidth) || 0;
  return {
    left: rect.left, top: rect.top, z, actualDpi,
    screenPerDraw: z / actualDpi, border,
    bufW: main.width, bufH: main.height,
  };
})()`;

const toScreen = (sp, bx, by) => ({
  x: Math.round(sp.left + sp.border * sp.z + bx * sp.screenPerDraw),
  y: Math.round(sp.top + sp.border * sp.z + by * sp.screenPerDraw),
});

const clickByText = (txt) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().includes(${JSON.stringify(txt)}));
  if (!b) return 'missing'; b.click(); return 'clicked';
})()`);

const mouse = (type, x, y, opts = {}) => send('Input.dispatchMouseEvent', {
  type, x, y, button: opts.button ?? (type === 'mouseMoved' ? 'none' : 'left'),
  clickCount: type === 'mouseMoved' ? 0 : 1,
  modifiers: opts.modifiers ?? 0, pointerType: 'mouse',
});
const click = async (x, y, modifiers = 0) => {
  await mouse('mouseMoved', x, y);
  await sleep(40);
  await mouse('mousePressed', x, y, { modifiers });
  await sleep(60);
  await mouse('mouseReleased', x, y, { modifiers });
  await sleep(450);
};

// Each stress upload lands as its own layer row, named `stress-512px-NNN.png`.
const designCount = () => evaluate(`(() => {
  const el = document.querySelector('.layers-scroll');
  if (!el) return 0;
  return (el.innerText.match(/stress-512px/g) || []).length;
})()`);

const selectionInfo = () => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().includes('Halftone'));
  return { halftoneEnabled: b ? !b.disabled : null };
})()`);

/** Last 4 square roundRects = the selected design's corner handles. */
const readCornerHandles = () => evaluate(`(() => {
  if (!window.__rp) return { error: 'no-hook' };
  const calls = (window.__rp.roundRects || []).filter(c => Math.abs(c.w - c.h) < 0.01 && c.w > 0);
  if (calls.length < 4) return { error: 'handles(' + calls.length + ')' };
  const t = calls.slice(-4);
  return { pts: t.map(c => ({ x: c.e, y: c.f })), size: t.map(c => c.w) };
})()`);

/** Largest strokeRect = the multi-selection group bbox (buffer space). */
const readGroupBox = () => evaluate(`(() => {
  if (!window.__rp) return { error: 'no-hook' };
  const calls = window.__rp.strokeRects || [];
  if (!calls.length) return { error: 'no-strokeRect' };
  let best = null;
  for (const c of calls.slice(-24)) {
    if (!best || c.w * c.h > best.w * best.h) best = c;
  }
  return { box: best };
})()`);

const metrics = async () => {
  const r = await send('Performance.getMetrics');
  const m = {};
  for (const { name, value } of r.metrics) m[name] = value;
  return m;
};

/**
 * Drive one gesture and collect every metric for it.
 *   start: {x,y} where the pointer goes down
 *   path:  array of {x,y} pointer-move positions
 */
// Another agent editing this repo can trigger a Vite full reload mid-run,
// which wipes the in-page hooks. Re-install rather than crashing.
async function ensureInstrumented() {
  const ok = await evaluate('!!window.__rp');
  if (!ok) {
    const r = await evaluate(INSTRUMENT);
    console.log('  (page reloaded — re-instrumented:', r + ')');
    await sleep(1500);
    return false;
  }
  return true;
}

async function gesture(name, start, pathPts, { modifiers = 0, settleMs = 900 } = {}) {
  await ensureInstrumented();
  await evaluate('window.__rp.reset(); window.__rp.on = false; "ok"');
  await mouse('mouseMoved', start.x, start.y);
  await sleep(120);
  const m0 = await metrics();
  await evaluate('window.__rp.reset(); window.__rp.on = true; "ok"');
  await mouse('mousePressed', start.x, start.y, { modifiers });
  await sleep(30);
  const wall0 = Date.now();
  for (const p of pathPts) {
    await mouse('mouseMoved', p.x, p.y, { modifiers });
    await sleep(16);
  }
  const wallMs = Date.now() - wall0;
  const during = await evaluate('window.__rp ? ({...window.__rp, reset: undefined, roundRects: undefined, strokeRects: undefined}) : null');
  if (!during) { console.log(`  ${name}: page reloaded mid-gesture — result discarded`); await ensureInstrumented(); return { name, aborted: true }; }
  const m1 = await metrics();
  // Release, then let the commit render + any deferred work finish, measured
  // separately so a "defer to pointer-up" change is visible rather than hidden.
  await evaluate('if (window.__rp) window.__rp.reset(); "ok"');
  const relWall0 = Date.now();
  await mouse('mouseReleased', start.x, start.y, { modifiers });
  await sleep(settleMs);
  // Flush the in-progress frame so `frames` ends with the committed render.
  const afterUp = await evaluate('window.__rp ? (window.__rp.frames.push(window.__rp.frameOn), window.__rp.frameOn = 0, {...window.__rp, reset: undefined, roundRects: undefined, strokeRects: undefined}) : null');
  if (!afterUp) { console.log(`  ${name}: page reloaded after release — result discarded`); await ensureInstrumented(); return { name, aborted: true }; }
  const relMs = Date.now() - relWall0;
  await evaluate('if (window.__rp) window.__rp.on = false; "ok"');
  const m2 = await metrics();

  const frames = pathPts.length;
  const gaps = during.rafGaps || [];
  const sorted = [...gaps].sort((a, b) => a - b);
  const row = {
    name,
    pointerMoves: frames,
    wallMs,
    dragScriptMs: +(1000 * (m1.ScriptDuration - m0.ScriptDuration)).toFixed(1),
    dragTaskMs: +(1000 * (m1.TaskDuration - m0.TaskDuration)).toFixed(1),
    dragLayoutMs: +(1000 * (m1.LayoutDuration - m0.LayoutDuration)).toFixed(1),
    upScriptMs: +(1000 * (m2.ScriptDuration - m1.ScriptDuration)).toFixed(1),
    upTaskMs: +(1000 * (m2.TaskDuration - m1.TaskDuration)).toFixed(1),
    drawImagePerFrame: +(during.di / frames).toFixed(2),
    onscreenDrawsPerFrame: +(during.diOn / frames).toFixed(2),
    offscreenDrawsPerFrame: +(during.diOff / frames).toFixed(2),
    onscreenMPxPerFrame: +(during.pxOn / frames / 1e6).toFixed(2),
    offscreenMPxPerFrame: +(during.pxOff / frames / 1e6).toFixed(2),
    offscreenClears: during.clearsOff,
    onscreenClears: during.clearsOn,
    getImageData: during.gid,
    putImageData: during.pid,
    canvasesCreated: during.newCanvas,
    rafFrames: gaps.length,
    rafMedianMs: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : null,
    rafP95Ms: sorted.length ? +sorted[Math.max(0, Math.floor(sorted.length * 0.95) - 1)].toFixed(1) : null,
    releaseWallMs: relMs,
    releaseDrawImages: afterUp.di,
    releaseOffscreenDraws: afterUp.diOff,
    releaseMPx: +((afterUp.pxOn + afterUp.pxOff) / 1e6).toFixed(2),
    // Renders per pointer-move event, and the committed frame's on-screen
    // draw count (2 = composite blit + selected design, i.e. everything else
    // is baked into the cached composite as it should be when idle).
    rendersPerPointerMove: +(during.clearsOn / frames).toFixed(2),
    committedFrameOnscreenDraws: afterUp.frames.length ? afterUp.frames[afterUp.frames.length - 1] : null,
  };
  console.log(`  ${name.padEnd(26)} renders/move ${String(row.rendersPerPointerMove).padStart(5)} · drawImage/frame ${String(row.drawImagePerFrame).padStart(6)} (on ${row.onscreenDrawsPerFrame} / off ${row.offscreenDrawsPerFrame}) · MPx/frame ${String((row.onscreenMPxPerFrame + row.offscreenMPxPerFrame).toFixed(2)).padStart(6)} · script ${String(row.dragScriptMs).padStart(7)}ms task ${String(row.dragTaskMs).padStart(7)}ms · rAF med ${row.rafMedianMs}ms p95 ${row.rafP95Ms}ms · on-up ${row.upScriptMs}ms/${row.releaseDrawImages} draws (off ${row.releaseOffscreenDraws}), committed frame on-screen draws ${row.committedFrameOnscreenDraws}`);
  return row;
}

async function cpuProfile(fn) {
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 120 });
  await send('Profiler.start');
  await fn();
  const { profile } = await send('Profiler.stop');
  await send('Profiler.disable');
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const self = new Map();
  const total = (profile.samples || []).length;
  for (const s of profile.samples || []) {
    const n = byId.get(s);
    if (!n) continue;
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anonymous)'} ${String(cf.url || '').split('/').pop()}:${cf.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + 1);
  }
  const dur = (profile.endTime - profile.startTime) / 1000;
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([k, c]) => ({ fn: k, samples: c, pctOfSamples: +(100 * c / Math.max(1, total)).toFixed(1), msApprox: +(dur * c / Math.max(1, total)).toFixed(1) }));
}

async function main() {
  for (let i = 0; i < 60; i++) { try { if ((await targets()).length) break; } catch {} await sleep(250); }
  const page = (await targets()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Performance.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/test-builder?stress=${DESIGN_COUNT}` });

  // Wait for the sheet to be populated.
  let n = 0;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    n = await designCount().catch(() => 0);
    if (n >= DESIGN_COUNT) break;
  }
  console.log(`sheet ready: ${n} designs (asked ${DESIGN_COUNT})`);
  await sleep(2500);
  console.log('instrument:', await evaluate(INSTRUMENT));
  await shot('00-sheet');

  const sp = await evaluate(SPACE);
  if (!sp) { console.log('no canvas — abort'); return; }
  console.log('canvas space:', JSON.stringify({ z: +sp.z.toFixed(3), actualDpi: +sp.actualDpi.toFixed(2), buf: [sp.bufW, sp.bufH] }));

  const results = [];

  // ---- pick a design to select: probe a coarse grid until handles appear ----
  let anchor = null;
  outer:
  for (let fy = 0.18; fy <= 0.85; fy += 0.16) {
    for (let fx = 0.12; fx <= 0.9; fx += 0.12) {
      const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
      await evaluate('if (window.__rp) window.__rp.roundRects = []; "ok"');
      await click(p.x, p.y);
      const h = await readCornerHandles();
      if (!h.error) { anchor = { p, h }; break outer; }
    }
  }
  if (!anchor) { console.log('could not select a design'); await shot('99-noselect'); return; }
  console.log('selected a design at', JSON.stringify(anchor.p), 'handles', JSON.stringify(anchor.h.pts.map(q => [Math.round(q.x), Math.round(q.y)])));

  const centreBuf = {
    x: (Math.min(...anchor.h.pts.map(q => q.x)) + Math.max(...anchor.h.pts.map(q => q.x))) / 2,
    y: (Math.min(...anchor.h.pts.map(q => q.y)) + Math.max(...anchor.h.pts.map(q => q.y))) / 2,
  };
  const centre = toScreen(sp, centreBuf.x, centreBuf.y);
  const br = toScreen(sp, anchor.h.pts[2].x, anchor.h.pts[2].y);
  console.log('design centre (screen)', JSON.stringify(centre), 'br handle (screen)', JSON.stringify(br));

  const STEPS = 40;

  console.log('\n=== SINGLE-DESIGN SELECTION ===');
  // MOVE: small circular sweep so the design stays on the sheet.
  const movePath = [];
  for (let i = 1; i <= STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    movePath.push({ x: Math.round(centre.x + 26 * Math.cos(a)), y: Math.round(centre.y + 18 * Math.sin(a)) });
  }
  results.push(await gesture('single MOVE', centre, movePath));

  // Re-select (a move can shift things) and re-read the handle.
  await evaluate('if (window.__rp) window.__rp.roundRects = []; "ok"');
  await click(centre.x, centre.y);
  let h2 = await readCornerHandles();
  const br2 = h2.error ? br : toScreen(sp, h2.pts[2].x, h2.pts[2].y);
  // RESIZE: pull the br handle out and back, same number of moves.
  const resizePath = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i <= STEPS / 2 ? i / (STEPS / 2) : 2 - i / (STEPS / 2);
    resizePath.push({ x: Math.round(br2.x + 70 * t), y: Math.round(br2.y + 50 * t) });
  }
  results.push(await gesture('single RESIZE', br2, resizePath));
  await shot('01-after-single');

  console.log('\n=== MULTI-DESIGN SELECTION (ctrl+click 5 designs) ===');
  // Ctrl+click adjacent designs. Probe the grid and ctrl-click every hit.
  await click(centre.x, centre.y);
  let picked = 1;
  for (let fy = 0.15; fy <= 0.9 && picked < 6; fy += 0.13) {
    for (let fx = 0.1; fx <= 0.92 && picked < 6; fx += 0.11) {
      const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
      if (Math.abs(p.x - centre.x) < 12 && Math.abs(p.y - centre.y) < 12) continue;
      await evaluate('if (window.__rp) window.__rp.strokeRects = []; "ok"');
      await click(p.x, p.y, 2);
      const g = await readGroupBox();
      if (!g.error && g.box && g.box.w > 4) picked++;
    }
  }
  const gb = await readGroupBox();
  console.log('group bbox (buffer):', JSON.stringify(gb));
  await shot('02-multiselect');
  if (!gb.error && gb.box) {
    const b = gb.box;
    const gCentre = toScreen(sp, b.x + b.w / 2, b.y + b.h / 2);
    const gBr = toScreen(sp, b.x + b.w, b.y + b.h);
    console.log('group centre', JSON.stringify(gCentre), 'group br handle', JSON.stringify(gBr));

    const gMovePath = [];
    for (let i = 1; i <= STEPS; i++) {
      const a = (i / STEPS) * Math.PI * 2;
      gMovePath.push({ x: Math.round(gCentre.x + 22 * Math.cos(a)), y: Math.round(gCentre.y + 14 * Math.sin(a)) });
    }
    results.push(await gesture('multi MOVE', gCentre, gMovePath));

    const gResizePath = [];
    for (let i = 1; i <= STEPS; i++) {
      const t = i <= STEPS / 2 ? i / (STEPS / 2) : 2 - i / (STEPS / 2);
      // Pull inward: growing a full-sheet group is clamped immediately.
      gResizePath.push({ x: Math.round(gBr.x - 60 * t), y: Math.round(gBr.y - 40 * t) });
    }
    results.push(await gesture('multi RESIZE', gBr, gResizePath));
    await shot('03-after-multi');

    console.log('\n=== CPU PROFILE: multi RESIZE ===');
    const prof = await cpuProfile(async () => {
      await gesture('multi RESIZE (profiled)', gBr, gResizePath);
    });
    for (const r of prof) console.log(`  ${String(r.pctOfSamples).padStart(5)}%  ~${String(r.msApprox).padStart(7)}ms  ${r.fn}`);
    fs.writeFileSync(path.join(OUT, `${LABEL}-profile-multi-resize.json`), JSON.stringify(prof, null, 2));
  } else {
    console.log('multi-selection not established — skipping group gestures');
  }

  console.log('\n=== CPU PROFILE: single RESIZE ===');
  // Re-establish a single-design selection from scratch: the group gestures
  // moved things, so a stale handle position would silently not engage.
  let anchor3 = null;
  outer3:
  for (let fy = 0.18; fy <= 0.85; fy += 0.16) {
    for (let fx = 0.12; fx <= 0.9; fx += 0.12) {
      const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
      await evaluate('if (window.__rp) window.__rp.roundRects = []; "ok"');
      await click(p.x, p.y);
      const h = await readCornerHandles();
      if (!h.error) { anchor3 = h; break outer3; }
    }
  }
  if (!anchor3) { console.log('could not re-select for the single-resize profile'); return; }
  const br3 = toScreen(sp, anchor3.pts[2].x, anchor3.pts[2].y);
  const resizePath3 = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i <= STEPS / 2 ? i / (STEPS / 2) : 2 - i / (STEPS / 2);
    resizePath3.push({ x: Math.round(br3.x + 70 * t), y: Math.round(br3.y + 50 * t) });
  }
  const singleProf = await cpuProfile(async () => {
    results.push(await gesture('single RESIZE (profiled)', br3, resizePath3));
  });
  for (const r of singleProf) console.log(`  ${String(r.pctOfSamples).padStart(5)}%  ~${String(r.msApprox).padStart(7)}ms  ${r.fn}`);
  fs.writeFileSync(path.join(OUT, `${LABEL}-profile-single-resize.json`), JSON.stringify(singleProf, null, 2));

  fs.writeFileSync(path.join(OUT, `${LABEL}-results.json`), JSON.stringify(results, null, 2));
  console.log('\n==== SUMMARY (' + LABEL + `, ${n} designs) ====`);
  console.log('gesture              | renders/move | drawImage/frame | offscreen/frame | MPx/frame | drag script ms | drag task ms | rAF med | rAF p95 | committed frame draws');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(20)} | ${String(r.rendersPerPointerMove).padStart(12)} | ${String(r.drawImagePerFrame).padStart(15)} | ${String(r.offscreenDrawsPerFrame).padStart(15)} | ${String((r.onscreenMPxPerFrame + r.offscreenMPxPerFrame).toFixed(2)).padStart(9)} | ${String(r.dragScriptMs).padStart(14)} | ${String(r.dragTaskMs).padStart(12)} | ${String(r.rafMedianMs).padStart(7)} | ${String(r.rafP95Ms).padStart(7)} | ${String(r.committedFrameOnscreenDraws).padStart(21)}`,
    );
  }
  console.log('\nwrote', path.join(OUT, `${LABEL}-results.json`));
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(300); try { ws?.close(); } catch {} chrome.kill(); process.exit(0);
});
