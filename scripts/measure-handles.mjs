// Dev-only measurement driver for the selection resize handles (the white
// squares with cyan borders drawn on the selected design's bounding box).
//
// Launches headless Chrome, drops a generated square PNG on the builder, then
// records the handles' exact geometry by wrapping CanvasRenderingContext2D
// .roundRect — the handles are the only square round-rects the selection layer
// draws, and the live transform at call time gives their corner positions in
// canvas-buffer units. That is exact, unlike scraping the rendered bitmap.
//
//   node scripts/measure-handles.mjs [appPort] [desktop|mobile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_PORT = process.argv[2] || '5077';
const MODE = process.argv[3] || 'desktop';
const TAG = process.argv[4] || 'before';
// `computePreviewDimensions` floors the sheet box at a 200px edge, so fit-zoom
// (which is also the minimum zoom) only falls below 1 when the canvas area is
// shorter than that. A deliberately squat window is the way to reach the
// sub-0.5 zoom band.
// `useIsMobile` keys off innerWidth < 768, so 760 exercises the touch sizing
// path while still giving a canvas big enough to aim at with real geometry.
const VIEWPORT = MODE === 'mobilehit' ? { width: 760, height: 1000 }
  : MODE === 'mobile' ? { width: 390, height: 844 }
  : MODE === 'lowzoom' ? { width: 1600, height: Number(process.argv[5]) || 390 }
  : { width: 1600, height: 1000 };
const PORT = 9401 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-handles');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-handles-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--headless=new',
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
async function shot(name, clip, scale = 1) {
  const params = { format: 'png' };
  if (clip) params.clip = { ...clip, scale };
  const r = await send('Page.captureScreenshot', params);
  const p = path.join(OUT, `${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  return p;
}
/** Magnified crop centred on the design, so the handles are actually legible. */
async function closeUp(name, centre, box = 200, scale = 3) {
  if (!centre) return null;
  return shot(name, {
    x: Math.max(0, Math.round(centre.x - box / 2)),
    y: Math.max(0, Math.round(centre.y - box / 2)),
    width: box, height: box,
  }, scale);
}
const wheel = (x, y, deltaY, ctrl) => send('Input.dispatchMouseEvent', {
  type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: ctrl ? 2 : 0, pointerType: 'mouse',
});
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(700);
};
const clickByText = (txt) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim().includes(${JSON.stringify(txt)}));
  if (!b) return 'missing'; b.click(); return 'clicked';
})()`);
const clickExact = (txt) => evaluate(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.innerText||'').trim() === ${JSON.stringify(txt)});
  if (!b) return 'missing'; b.click(); return 'clicked';
})()`);
/** Press, move in steps, release — enough for the builder's pointer handlers. */
const dragFrom = async (x0, y0, x1, y1) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none' });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  await sleep(120);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: Math.round(x0 + (x1 - x0) * i / steps),
      y: Math.round(y0 + (y1 - y0) * i / steps),
    });
    await sleep(45);
  }
  await sleep(150);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  await sleep(1200);
};

/** Ctrl+click is how the builder adds a design to a multi-selection. */
const ctrlClick = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers: 2 });
  await sleep(50);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 2 });
  await sleep(70);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 2 });
  await sleep(800);
};
const setCopies = (n) => evaluate(`(() => {
  const el = [...document.querySelectorAll('input')].find(i => (i.title||'') === 'Number of copies');
  if (!el) return 'no-field';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, '${n}');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return 'set';
})()`);

const uploadDesign = () => evaluate(`(async () => {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 600;
  const x = c.getContext('2d');
  x.fillStyle = '#2b2b2b';
  x.beginPath(); x.ellipse(300, 300, 300, 300, 0, 0, Math.PI * 2); x.fill();
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'probe.png', { type: 'image/png' }));
  const inp = document.querySelector('input[type=file]');
  const zone = inp ? inp.closest('div') : document.body;
  zone.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  return 'dropped ' + blob.size + 'b';
})()`);

/**
 * Single-selection handles are square round-rects; multi-selection group
 * handles are circles drawn with `arc`. Hook both and normalise each to a full
 * on-canvas extent plus a position, so one reader can measure either.
 */
const installHook = () => evaluate(`(() => {
  if (window.__handleHook) { window.__handleCalls = []; return 'already'; }
  window.__handleHook = true;
  window.__handleCalls = [];
  const push = (rec) => {
    window.__handleCalls.push(rec);
    if (window.__handleCalls.length > 400) window.__handleCalls.splice(0, 200);
  };
  const origRR = CanvasRenderingContext2D.prototype.roundRect;
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    try {
      if (Math.abs(w - h) < 0.01 && w > 0) {
        const t = this.getTransform();
        push({ kind: 'rect', full: w, x: t.e, y: t.f });
      }
    } catch (e) {}
    return origRR.apply(this, arguments);
  };
  const origArc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function (x, y, r, sa, ea) {
    try {
      if (r > 0 && Math.abs((ea - sa) - Math.PI * 2) < 0.01) {
        const t = this.getTransform();
        push({ kind: 'arc', full: 2 * r * t.a, x: t.a * x + t.e, y: t.d * y + t.f });
      }
    } catch (e) {}
    return origArc.apply(this, arguments);
  };
  return 'installed';
})()`);

const clearCalls = () => evaluate('window.__handleCalls = []; "ok"');

/**
 * Read the most recent frame's four handle round-rects and convert to screen
 * CSS pixels. `screenPerDraw` folds together the canvas DPR-style buffer scale
 * and the wrapper's CSS `transform: scale(zoom)`.
 */
const readHandles = (kind = 'rect') => evaluate(`(() => {
  const KIND = ${JSON.stringify(kind)};
  const main = document.querySelector('canvas.z-10');
  if (!main) return { error: 'no-canvas' };
  const rect = main.getBoundingClientRect();
  const z = rect.width / main.offsetWidth;
  const contentW = parseFloat(main.style.width);
  const actualDpi = main.width / contentW;
  const screenPerDraw = z / actualDpi;

  const all = window.__handleCalls || [];
  // Prefer group circles when a multi-selection is on screen, else the squares.
  const wantArc = KIND === 'arc';
  const calls = all.filter(c => c.kind === (wantArc ? 'arc' : 'rect'));
  if (calls.length < 4) return { error: 'no-handles(' + calls.length + '/' + all.length + ')', zoom: +z.toFixed(4) };
  const tail = calls.slice(-4);
  const sizes = tail.map(c => +c.full.toFixed(3));
  const xs = tail.map(c => c.x), ys = tail.map(c => c.y);
  const bboxW = Math.max(...xs) - Math.min(...xs);
  const bboxH = Math.max(...ys) - Math.min(...ys);
  // Where the design's centre currently sits on screen, so the driver can
  // re-select it after a resize without blind grid-clicking.
  const border = parseFloat(getComputedStyle(main).borderLeftWidth) || 0;
  const centreScreen = {
    x: Math.round(rect.left + border * z + ((Math.min(...xs) + Math.max(...xs)) / 2) * screenPerDraw),
    y: Math.round(rect.top + border * z + ((Math.min(...ys) + Math.max(...ys)) / 2) * screenPerDraw),
  };
  const toScreen = (dx, dy) => ({
    x: rect.left + (parseFloat(getComputedStyle(main).borderLeftWidth) || 0) * z + dx * screenPerDraw,
    y: rect.top + (parseFloat(getComputedStyle(main).borderTopWidth) || 0) * z + dy * screenPerDraw,
  });
  // Corner order matches the draw loop: tl, tr, br, bl.
  const cornersScreen = tail.map(c => { const p = toScreen(c.x, c.y); return { x: +p.x.toFixed(1), y: +p.y.toFixed(1), full: +c.full.toFixed(2) }; });
  const nominal = Math.min(...sizes);          // corner handles (br may be 2x on mobile)
  const largest = Math.max(...sizes);
  const pxPerInch = contentW * z / 24.5;       // sheet is 24.5in wide
  return {
    kind: KIND,
    zoom: +z.toFixed(4),
    actualDpi: +actualDpi.toFixed(3),
    screenPerDraw: +screenPerDraw.toFixed(6),
    handleSizesDraw: sizes,
    handleCssPx: +(nominal * screenPerDraw).toFixed(2),
    largestHandleCssPx: +(largest * screenPerDraw).toFixed(2),
    designWCssPx: +(bboxW * screenPerDraw).toFixed(2),
    designHCssPx: +(bboxH * screenPerDraw).toFixed(2),
    designMinCssPx: +(Math.min(bboxW, bboxH) * screenPerDraw).toFixed(2),
    designInches: +(Math.min(bboxW, bboxH) * screenPerDraw / pxPerInch).toFixed(3),
    centreScreen,
    cornersScreen,
  };
})()`);

const zoomPct = () => evaluate(
  `(() => { const t=[...document.querySelectorAll('span,div')].map(n=>n.textContent).find(t=>/^\\d+%$/.test((t||'').trim())); return t?parseInt(t):0; })()`,
);

/**
 * Nudge the width with the SizeInput stepper buttons (0.1in per click). Much
 * more robust in headless than focusing the field and typing, and it exercises
 * exactly the same commit path.
 */
const stepWidth = async (clicks, dir) => {
  const label = dir > 0 ? 'Increase size' : 'Decrease size';
  for (let i = 0; i < clicks; i++) {
    const r = await evaluate(`(() => {
      const b = document.querySelectorAll('button[aria-label=${JSON.stringify(label)}]')[0];
      if (!b) return 'missing';
      b.click(); return 'ok';
    })()`);
    if (r !== 'ok') return r;
    await sleep(45);
  }
  await sleep(900);
  return 'ok';
};

const currentWidthIn = () => evaluate(`(() => {
  const el = [...document.querySelectorAll('input[type=text]')].find(i => (i.title||'').startsWith('Width (inches)'));
  return el ? parseFloat(el.value) : null;
})()`);

/**
 * Type a width straight into the toolbar field. `SizeInput` now uses a single
 * never-readOnly input that commits on Enter, so this is the direct path; the
 * stepper buttons remain a fallback if the field cannot be driven.
 */
const typeWidth = async (inches) => {
  const start = await evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=text]')]
      .find(i => (i.title || '').startsWith('Width (inches)'));
    if (!el) return 'no-field';
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '${inches}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'typed';
  })()`);
  if (start !== 'typed') return start;
  await sleep(220);                    // let React commit the draft state
  const done = await evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=text]')]
      .find(i => (i.title || '').startsWith('Width (inches)'));
    if (!el) return 'no-field';
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    el.blur();
    return 'committed';
  })()`);
  await sleep(1200);
  return done;
};

/** Drive the width to a target and report what we actually got. */
const goToWidth = async (target) => {
  const before = await currentWidthIn();
  if (before === null) return { error: 'no-field' };
  if (Math.abs(target - before) < 0.06) return { width: before };

  const typed = await typeWidth(target);
  let cur = await currentWidthIn();
  if (typed === 'committed' && cur !== null && Math.abs(cur - target) < 0.06) return { width: cur };

  // Fall back to the +/- steppers.
  for (let guard = 0; guard < 4; guard++) {
    cur = await currentWidthIn();
    if (cur === null) return { error: 'no-field' };
    const delta = target - cur;
    if (Math.abs(delta) < 0.06) return { width: cur };
    const clicks = Math.min(140, Math.round(Math.abs(delta) / 0.1));
    if (clicks === 0) return { width: cur };
    const r = await stepWidth(clicks, Math.sign(delta));
    if (r !== 'ok') {
      const labels = await evaluate(`JSON.stringify([...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean).slice(0, 40))`);
      return { error: `${r} (typed=${typed}, width=${cur}, aria-labels=${labels})` };
    }
  }
  return { width: await currentWidthIn() };
};

/** Type an inch value into the toolbar W field and commit with Enter. */
const setWidthInches = async (inches) => {
  const opened = await evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=text]')]
      .find(i => (i.title || '').startsWith('Width (inches)'));
    if (!el) return 'no-field';
    el.focus();
    return 'focused';
  })()`);
  if (opened !== 'focused') return opened;
  await sleep(250);
  const res = await evaluate(`(() => {
    const el = [...document.querySelectorAll('input[type=text]')]
      .find(i => !i.readOnly && (i.title || '') === 'Width (inches)');
    if (!el) return 'no-edit-field';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, '${inches}');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return 'typed';
  })()`);
  await sleep(1400);
  return res;
};

/**
 * The first design lands at the sheet's top-left, so probe a short diagonal
 * out from that corner rather than sweeping the whole sheet (a broad sweep
 * lands on other chrome and knocks the builder out of its editing state).
 */
async function selectDesign(geo) {
  // Probe in sheet inches rather than screen pixels: the canvas can be 1200px
  // wide at fit-zoom 1 or 80px wide at fit-zoom 0.2, and a fixed pixel diagonal
  // only lands on the design in the former case.
  const SHEET_W_IN = 24.5, SHEET_H_IN = 12;
  for (const d of [1, 0.6, 1.6, 2.4, 3.2, 4.5, 6]) {
    await clearCalls();
    const p = {
      x: Math.round(geo.l + geo.w * (d / SHEET_W_IN)),
      y: Math.round(geo.t + geo.h * (d / SHEET_H_IN)),
    };
    await click(p.x, p.y);
    const n = await evaluate(`(window.__handleCalls||[]).filter(c => c.kind === 'rect').length`);
    if (n >= 4) return p;
  }
  return null;
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
  await send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor: 1, mobile: MODE === 'mobile' || MODE === 'mobilehit' });
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/test-builder` });
  await sleep(10000);
  console.log(`MODE=${MODE} innerWidth=${await evaluate('window.innerWidth')} (mobile path is < 768)`);

  console.log('upload:', await uploadDesign());
  // The raster import is async; wait for the sidebar entry before adding.
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await evaluate(`[...document.querySelectorAll('button')].some(b => (b.innerText||'').includes('Add Here'))`)) break;
  }
  console.log('add-here:', await clickByText('Add Here'));
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await evaluate(`!!document.querySelector('canvas.z-10')`)) break;
  }
  console.log('hook:', await installHook());

  let geo = null;
  for (let i = 0; i < 20; i++) {
    geo = await evaluate(`(() => { const el = document.querySelector('canvas.z-10'); if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 50 ? { l: r.left, t: r.top, w: r.width, h: r.height } : null; })()`);
    if (geo) break;
    await sleep(1000);
  }
  if (!geo) { console.log('no canvas - aborting'); await shot(`${MODE}-no-canvas`); return; }
  console.log('canvas rect:', JSON.stringify(geo));
  let hit = await selectDesign(geo);
  console.log('selected via click at', JSON.stringify(hit));
  const base = await readHandles();
  console.log('baseline:', JSON.stringify(base));
  if (base.centreScreen) hit = base.centreScreen;

  const freshGeo = () => evaluate(`(() => { const el = document.querySelector('canvas.z-10'); if (!el) return null; const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);

  const rows = [];
  const record = async (label, kind = 'rect') => {
    let r = await readHandles(kind);
    if (r.error && hit && kind === 'rect') {
      // Resizing/zooming can drop the selection; click where it last was.
      await clearCalls();
      await click(hit.x, hit.y);
      r = await readHandles(kind);
    }
    if (r.error && kind === 'rect') {
      const g = await freshGeo();
      if (g) { const p = await selectDesign(g); if (p) r = await readHandles(kind); }
    }
    const pct = await zoomPct();
    if (r.centreScreen) hit = r.centreScreen;
    if (r.error) { console.log(`  ${label}: ERROR ${r.error}`); return null; }
    const ratio = 100 * r.handleCssPx / Math.max(0.01, r.designMinCssPx);
    const gap = +(r.designMinCssPx - r.handleCssPx).toFixed(2);
    rows.push({ label, zoomPct: pct, ...r, ratioPct: +ratio.toFixed(1), cornerGapCssPx: gap });
    console.log(`  ${label} [${r.kind}] | zoom ${pct}% (z=${r.zoom}) | box ${r.designWCssPx}x${r.designHCssPx} css (${r.designInches}in) | handle ${r.handleCssPx}px | ${ratio.toFixed(1)}% of box | edge gap ${gap}px | sizes ${JSON.stringify(r.handleSizesDraw)}`);
    return r;
  };

  if (MODE === 'mobilehit') {
    console.log('\n=== E. mobile bottom-right grab area ===');
    console.log('  set 2in:', JSON.stringify(await goToWidth(2)));
    const r0 = await record('mobile-br-baseline');
    if (!r0 || !r0.cornersScreen) { console.log('  cannot read corners'); await shot(`${MODE}-${TAG}-fail`); }
    else {
      const br = r0.cornersScreen[2];
      console.log(`  br handle at ${JSON.stringify(br)} — drawn ${(br.full * r0.screenPerDraw).toFixed(1)} css px wide`);
      // Old grab radius was 1.4 x 10 = 14 css px regardless of the 2x paint;
      // matching the paint should take it to 28. Probe the band between.
      for (const d of [10, 18, 24, 27, 34]) {
        const off = d / Math.SQRT2;
        const sx = Math.round(br.x + off), sy = Math.round(br.y + off);
        const w0 = await currentWidthIn();
        await dragFrom(sx, sy, sx + 60, sy + 60);
        const w1 = await currentWidthIn();
        const grew = w1 !== null && w0 !== null && w1 - w0 > 0.05;
        console.log(`    press ${d}px from br centre -> width ${w0} -> ${w1} : ${grew ? 'RESIZED' : 'no resize'}`);
        rows.push({ label: `br-probe-${d}px`, probeDistCssPx: d, widthBefore: w0, widthAfter: w1, resized: grew });
        // Put it back so each probe starts from the same place.
        await goToWidth(2);
        await clearCalls();
        const rr = await readHandles();
        if (rr.error) { const g = await freshGeo(); if (g) { const p = await selectDesign(g); if (p) hit = p; } }
      }
    }
  } else if (MODE === 'group') {
    console.log('\n=== C. multi-selection group handles ===');
    const origCentre = { ...hit };
    await clearCalls();
    // Add a second instance from the still-populated Device Uploads list; the
    // Duplicate button intermittently remounts the canvas mid-run.
    console.log('  add second:', await clickByText('Add Here'));
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      if (await evaluate(`!!document.querySelector('canvas.z-10')`)) break;
    }
    await sleep(1500);
    const dup = await record('after-second-add(single)');
    console.log(`  original centre ${JSON.stringify(origCentre)}, duplicate centre ${JSON.stringify(dup && dup.centreScreen)}`);
    await clearCalls();
    // Ctrl+click the ORIGINAL (the duplicate is already selected); clicking the
    // selected one would toggle it back out and leave nothing selected.
    await ctrlClick(origCentre.x, origCentre.y);
    let grp = await record('group-2-designs', 'arc');
    if (!grp) {
      // Duplicate may have landed on top of the original; try the other one.
      await clearCalls();
      if (dup && dup.centreScreen) await ctrlClick(dup.centreScreen.x, dup.centreScreen.y);
      grp = await record('group-2-designs(retry)', 'arc');
    }
    if (grp) await closeUp(`${MODE}-${TAG}-group`, grp.centreScreen, 260, 3);
    else await shot(`${MODE}-${TAG}-group-fail`);
    if (dup) console.log(`  single square was ${dup.handleCssPx}px; group circle is ${grp ? grp.handleCssPx : 'n/a'}px`);
  } else if (MODE === 'lowzoom') {
    console.log(`\n=== D. low zoom (launched at ${VIEWPORT.width}x${VIEWPORT.height}) ===`);
    console.log(`  fit zoom = minimum zoom = ${await zoomPct()}%`);
    await shot(`${MODE}-${TAG}-layout`);
    for (const w of [2, 1, 0.5, 0.25]) {
      await clearCalls();
      const set = await goToWidth(w);
      if (set.error) {
        // Losing the toolbar means the selection dropped; re-acquire and retry.
        const g = await freshGeo();
        if (g) { const p = await selectDesign(g); if (p) hit = p; }
        const retry = await goToWidth(w);
        if (retry.error) { console.log(`  w=${w}: ${retry.error}`); continue; }
      }
      await record(`lowzoom-${w}in`);
    }
  } else {

  console.log('\n=== A. design size sweep at default zoom ===');
  for (const w of [8, 4, 2, 1, 0.5, 0.25, 0.1]) {
    await clearCalls();
    const set = await goToWidth(w);
    if (set.error) { console.log(`  w=${w}: ${set.error}`); await shot(`${MODE}-fail-${w}`); break; }
    await sleep(400);
    const r = await record(`w=${set.width}in`);
    if (r && [4, 2, 1, 0.5].includes(w)) {
      await closeUp(`${MODE}-${TAG}-${String(w).replace('.', 'p')}in`, r.centreScreen,
        Math.max(120, Math.round(r.designMinCssPx * 2.2)), 3);
    }
  }

  console.log('\n=== B. zoom sweep at a fixed 2in design ===');
  await clearCalls();
  console.log('  back to 2in:', JSON.stringify(await goToWidth(2)));
  await sleep(800);
  await record('2in@base');
  for (let step = 1; step <= 5; step++) {
    // Zoom at the design's own centre so zoom-to-cursor keeps it under the
    // same screen point and the re-select click still lands on it.
    for (let i = 0; i < 3; i++) { await wheel(hit.x, hit.y, -120, true); await sleep(140); }
    await sleep(1000);
    await clearCalls();
    await click(hit.x, hit.y);
    const r = await record(`2in@zoomstep${step}`);
    if (!r) console.log(`    (zoom now ${await zoomPct()}%)`);
  }

  }

  fs.writeFileSync(path.join(OUT, `measurements-${MODE}-${TAG}.json`), JSON.stringify(rows, null, 2));
  console.log('\n==== TABLE (' + MODE + ' / ' + TAG + ') ====');
  console.log('label                      | kind | zoom% | box (in) | box min (css px) | handle (css px) | handle % of box | sizes(draw)');
  for (const r of rows) {
    console.log(
      `${r.label.padEnd(26)} | ${String(r.kind).padEnd(4)} | ${String(r.zoomPct).padStart(5)} | ${String(r.designInches).padStart(8)} | ${String(r.designMinCssPx).padStart(16)} | ${String(r.handleCssPx).padStart(15)} | ${String(r.ratioPct).padStart(15)} | ${JSON.stringify(r.handleSizesDraw)}`,
    );
  }
  console.log('\nwrote', path.join(OUT, `measurements-${MODE}-${TAG}.json`));
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(300); try { ws?.close(); } catch {} chrome.kill(); process.exit(0);
});
