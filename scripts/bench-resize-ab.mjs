// Paired A/B for the drag/resize render path. Runs the SAME gestures on the
// SAME page, alternating `window.__abDoubleRender` (which restores the old
// behaviour where the React onMouseMove handler serviced active interactions
// in addition to the rAF-coalesced window listener). Interleaving A and B in
// one session cancels most machine-load drift, which a separate before/after
// run cannot do on a shared dev box.
//
//   node scripts/bench-resize-ab.mjs [appPort] [designCount] [reps]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP_PORT = process.argv[2] || '5000';
const DESIGN_COUNT = Number(process.argv[3] || 16);
const REPS = Number(process.argv[4] || 4);
const PORT = 9560 + (Number(process.env.PORT_OFFSET) || 0);
const OUT = path.resolve('tmp-resize-perf');
fs.mkdirSync(OUT, { recursive: true });
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-ab-'));

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

const INSTRUMENT = `(() => {
  if (window.__ab) return 'already';
  const P = window.__ab = { on: false, reset() { this.di = 0; this.clears = 0; this.rr = []; } };
  P.reset();
  const proto = CanvasRenderingContext2D.prototype;
  const od = proto.drawImage;
  proto.drawImage = function (...a) { if (P.on) P.di++; return od.apply(this, a); };
  const oc = proto.clearRect;
  proto.clearRect = function (...a) {
    if (P.on && this.canvas && this.canvas.isConnected) P.clears++;
    return oc.apply(this, a);
  };
  const orr = proto.roundRect;
  if (orr) proto.roundRect = function (x, y, w, h, r) {
    try { const t = this.getTransform(); P.rr.push({ w, h, e: t.e, f: t.f }); if (P.rr.length > 200) P.rr.splice(0, 100); } catch (e) {}
    return orr.apply(this, arguments);
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

const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
  clickCount: type === 'mouseMoved' ? 0 : 1, pointerType: 'mouse',
});
const click = async (x, y) => {
  await mouse('mouseMoved', x, y); await sleep(40);
  await mouse('mousePressed', x, y); await sleep(60);
  await mouse('mouseReleased', x, y); await sleep(420);
};
const handles = () => evaluate(`(() => {
  if (!window.__ab) return { error: 'no-hook' };
  const c = (window.__ab.rr || []).filter(k => Math.abs(k.w - k.h) < 0.01 && k.w > 0);
  if (c.length < 4) return { error: 'handles(' + c.length + ')' };
  return { pts: c.slice(-4).map(k => ({ x: k.e, y: k.f })) };
})()`);
const metrics = async () => {
  const r = await send('Performance.getMetrics');
  const m = {}; for (const { name, value } of r.metrics) m[name] = value; return m;
};

async function ensureHook() {
  if (!(await evaluate('!!window.__ab'))) {
    await evaluate(INSTRUMENT);
    await sleep(1500);
    return false;
  }
  return true;
}

async function run(kind, start, pathPts, ab) {
  await ensureHook();
  await evaluate(`window.__abDoubleRender = ${ab}; window.__ab.reset(); window.__ab.on = false; "ok"`);
  await mouse('mouseMoved', start.x, start.y);
  await sleep(150);
  const m0 = await metrics();
  await evaluate('window.__ab.reset(); window.__ab.on = true; "ok"');
  await mouse('mousePressed', start.x, start.y);
  await sleep(30);
  for (const p of pathPts) { await mouse('mouseMoved', p.x, p.y); await sleep(16); }
  const d = await evaluate('window.__ab ? ({ di: window.__ab.di, clears: window.__ab.clears }) : null');
  const m1 = await metrics();
  await mouse('mouseReleased', start.x, start.y);
  await evaluate('if (window.__ab) window.__ab.on = false; "ok"');
  await sleep(800);
  if (!d) return { kind, ab, aborted: true };
  return {
    kind, ab,
    renders: d.clears,
    rendersPerMove: +(d.clears / pathPts.length).toFixed(2),
    drawImages: d.di,
    scriptMs: +(1000 * (m1.ScriptDuration - m0.ScriptDuration)).toFixed(1),
    taskMs: +(1000 * (m1.TaskDuration - m0.TaskDuration)).toFixed(1),
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? +s[Math.floor(s.length / 2)].toFixed(1) : null; };

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
  await send('Page.enable'); await send('Runtime.enable'); await send('Performance.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://localhost:${APP_PORT}/test-builder?stress=${DESIGN_COUNT}` });

  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const n = await evaluate(`(() => { const e = document.querySelector('.layers-scroll'); return e ? (e.innerText.match(/stress-512px/g) || []).length : 0; })()`).catch(() => 0);
    if (n >= DESIGN_COUNT) { console.log(`sheet ready: ${n} designs`); break; }
  }
  await sleep(2500);
  console.log('instrument:', await evaluate(INSTRUMENT));
  const sp = await evaluate(SPACE);
  console.log('buffer', sp.bufW, 'x', sp.bufH);

  // Re-probe the sheet for a selectable design and return its live centre and
  // bottom-right handle. Gestures move designs, so this must be redone before
  // every measured gesture rather than reusing stale coordinates.
  async function acquire() {
    await ensureHook();
    for (let fy = 0.18; fy <= 0.86; fy += 0.11) {
      for (let fx = 0.12; fx <= 0.9; fx += 0.1) {
        const p = toScreen(sp, sp.bufW * fx, sp.bufH * fy);
        await evaluate('if (window.__ab) window.__ab.rr = []; "ok"');
        await click(p.x, p.y);
        const h = await handles();
        if (h.error) continue;
        const hx = h.pts.map(q => q.x), hy = h.pts.map(q => q.y);
        return {
          centre: toScreen(sp, (Math.min(...hx) + Math.max(...hx)) / 2, (Math.min(...hy) + Math.max(...hy)) / 2),
          br: toScreen(sp, h.pts[2].x, h.pts[2].y),
        };
      }
    }
    return null;
  }

  const sel0 = await acquire();
  if (!sel0) { console.log('no selection'); return; }
  const centre = sel0.centre;
  const br = sel0.br;
  console.log('centre', JSON.stringify(centre), 'br', JSON.stringify(br));

  const STEPS = 40;
  const movePath = [];
  for (let i = 1; i <= STEPS; i++) {
    const a = (i / STEPS) * Math.PI * 2;
    movePath.push({ x: Math.round(centre.x + 26 * Math.cos(a)), y: Math.round(centre.y + 18 * Math.sin(a)) });
  }
  const resizePath = [];
  for (let i = 1; i <= STEPS; i++) {
    const t = i <= STEPS / 2 ? i / (STEPS / 2) : 2 - i / (STEPS / 2);
    resizePath.push({ x: Math.round(br.x + 70 * t), y: Math.round(br.y + 50 * t) });
  }

  const rows = [];
  for (let rep = 0; rep < REPS; rep++) {
    // Alternate the order each rep so a warm-up bias cannot favour one arm.
    const order = rep % 2 === 0 ? [true, false] : [false, true];
    for (const ab of order) {
      const arm = ab ? 'OLD' : 'NEW';
      const s1 = await acquire();
      if (s1) {
        const mp = movePath.map(p => ({ x: p.x + (s1.centre.x - centre.x), y: p.y + (s1.centre.y - centre.y) }));
        const a = await run('MOVE', s1.centre, mp, ab);
        if (!a.aborted && a.renders > 10) {
          rows.push(a);
          console.log(`  rep${rep} ${arm} MOVE   renders/move ${a.rendersPerMove} · drawImage ${a.drawImages} · script ${a.scriptMs}ms · task ${a.taskMs}ms`);
        } else console.log(`  rep${rep} ${arm} MOVE   skipped (gesture did not engage)`);
      }
      const s2 = await acquire();
      if (s2) {
        const rp = resizePath.map(p => ({ x: p.x + (s2.br.x - br.x), y: p.y + (s2.br.y - br.y) }));
        const b = await run('RESIZE', s2.br, rp, ab);
        if (!b.aborted && b.renders > 10) {
          rows.push(b);
          console.log(`  rep${rep} ${arm} RESIZE renders/move ${b.rendersPerMove} · drawImage ${b.drawImages} · script ${b.scriptMs}ms · task ${b.taskMs}ms`);
        } else console.log(`  rep${rep} ${arm} RESIZE skipped (gesture did not engage)`);
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'ab-results.json'), JSON.stringify(rows, null, 2));
  console.log('\n==== PAIRED A/B MEDIANS (40 pointer moves per gesture) ====');
  console.log('gesture | arm | renders/move | drawImage calls | script ms | task ms');
  for (const kind of ['MOVE', 'RESIZE']) {
    for (const ab of [true, false]) {
      const s = rows.filter(r => r.kind === kind && r.ab === ab);
      if (!s.length) continue;
      console.log(`${kind.padEnd(7)} | ${(ab ? 'OLD' : 'NEW').padEnd(3)} | ${String(median(s.map(r => r.rendersPerMove))).padStart(12)} | ${String(median(s.map(r => r.drawImages))).padStart(15)} | ${String(median(s.map(r => r.scriptMs))).padStart(9)} | ${String(median(s.map(r => r.taskMs))).padStart(7)}`);
    }
  }
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(300); try { ws?.close(); } catch {} chrome.kill(); process.exit(0);
});
