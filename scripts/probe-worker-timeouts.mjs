// Dev-only probe for the three worker timeouts added to `worker-pool.ts`,
// `background-removal.ts` and the overlap worker in `preview-section.tsx`.
//
// A genuine worker OOM in Chromium takes the whole renderer down, so the silent death
// these timeouts exist for cannot be reproduced here by starving a worker. What can be
// reproduced is the shape of it: a worker that accepts `postMessage` and never replies.
// `window.Worker` is replaced before any app code runs, but *only* for the two worker
// URLs under test, so the rest of the app keeps its real workers.
//
//   node scripts/probe-worker-timeouts.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// `--overlap-only` skips the pool and background-removal checks. Useful because those
// two hold the page for a minute, which is long enough for someone else's HMR reload to
// land and take the inspected target with it.
const OVERLAP_ONLY = process.argv.includes('--overlap-only');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9413;
const OUT = path.resolve('tmp-size-target');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-wt-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--window-size=1500,950',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json`)).json();

let ws, id = 0;
const pending = new Map();
const logs = [];
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const msgId = ++id;
  pending.set(msgId, { resolve, reject });
  ws.send(JSON.stringify({ id: msgId, method, params }));
});
async function evaluate(expression, timeoutNote = '') {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 180000 });
  if (r.exceptionDetails) throw new Error(`${timeoutNote}${r.exceptionDetails.exception?.description ?? 'eval failed'}`);
  return r.result?.value;
}

/** Stub only the workers under test; everything else gets the real thing. */
const PATCH = `(() => {
  const Real = window.Worker;
  window.__stub = { overlap: { created: 0, posted: 0, terminated: 0 }, bg: { created: 0, posted: 0, terminated: 0 } };
  function silent(kind) {
    const et = new EventTarget();
    et.postMessage = () => { window.__stub[kind].posted++; };
    et.terminate = () => { window.__stub[kind].terminated++; };
    window.__stub[kind].created++;
    return et;
  }
  const Patched = function (url, opts) {
    const s = String(url);
    if (s.includes('overlap-worker')) return silent('overlap');
    if (s.includes('bg-removal-worker')) return silent('bg');
    return new Real(url, opts);
  };
  Patched.prototype = Real.prototype;
  window.Worker = Patched;
})()`;

async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await targets()).length) break; } catch {}
    await sleep(250);
  }
  const page = (await targets()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${msg.params.type}] ` + msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await sleep(9000);

  // ---------------------------------------------------------------- 1. worker pool
  console.log('=== 1. WorkerPool: a worker that never replies ===');
  const pool = OVERLAP_ONLY ? 'skipped' : await evaluate(`(async () => {
    const mod = await import('/src/lib/worker-pool.ts');
    const silentSrc = URL.createObjectURL(new Blob(['self.onmessage = () => {};'], { type: 'text/javascript' }));
    const replySrc = URL.createObjectURL(new Blob(['self.onmessage = (e) => self.postMessage({ ok: e.data });'], { type: 'text/javascript' }));
    const out = {};

    // run(): rejects instead of hanging, and the dead worker is not handed back.
    let spawns = 0;
    const p = new mod.WorkerPool(() => { spawns++; return new Worker(silentSrc); }, { name: 'ProbeSilent', size: 1, jobTimeoutMs: 1200 });
    const t0 = performance.now();
    try { await p.run({ hello: 1 }); out.firstRun = 'RESOLVED (bug)'; }
    catch (e) { out.firstRun = e.message; out.firstRunMs = Math.round(performance.now() - t0); }
    out.spawnsAfterFirst = spawns;
    // A second job must get a *new* worker, not the timed-out one.
    const t1 = performance.now();
    try { await p.run({ hello: 2 }); } catch (e) { out.secondRun = e.message; out.secondRunMs = Math.round(performance.now() - t1); }
    out.spawnsAfterSecond = spawns;
    p.terminate();

    // A healthy pool is unaffected: same code path, worker replies.
    const good = new mod.WorkerPool(() => new Worker(replySrc), { name: 'ProbeGood', size: 2, jobTimeoutMs: 1200 });
    out.healthy = await good.run({ n: 7 });
    good.terminate();

    // runPooled: the Promise.all must settle rather than hang on dead workers.
    const t2 = performance.now();
    out.pooled = await mod.runPooled([1, 2, 3], () => new Worker(silentSrc), (j) => ({ payload: { j } }), { name: 'ProbePooled', jobTimeoutMs: 1200 });
    out.pooledMs = Math.round(performance.now() - t2);
    return out;
  })()`);
  console.log(JSON.stringify(pool, null, 2));

  // ------------------------------------- 2 + 3. the two 60s timeouts, run in parallel
  console.log('\n=== 2. background-removal + 3. overlap worker (60s, run together) ===');
  const dropped = await evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    g.fillStyle = '#e11d48';
    g.beginPath(); g.ellipse(600, 450, 520, 360, 0, 0, Math.PI * 2); g.fill();
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const hidden = [...document.querySelectorAll('input[type=file]')].find(i => i.className.includes('hidden'));
    const root = hidden ? hidden.parentElement : document.body;
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'probe-design.png', { type: 'image/png' }));
    root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  void dropped;
  for (let i = 0; i < 25; i++) {
    const n = await evaluate(`[...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || '')).length`);
    if (n > 0) break;
    await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /Add Here/i.test(x.textContent || '')); if (b) b.click(); return !!b; })()`);
    await sleep(1000);
  }
  await sleep(2000);
  // "Duplicate" (not "Duplicate & Arrange") drops the copy 3% of the artboard to the
  // right of its source, so the two boxes intersect — which is what makes the overlap
  // check reach for its worker at all; it skips the worker when nothing intersects.
  const duplicated = await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^\\s*Duplicate\\s*$/.test((x.textContent || '').replace(/\\s+/g, ' ')));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(2500);
  const stubBefore = await evaluate(`JSON.parse(JSON.stringify(window.__stub))`);
  console.log('clicked Duplicate:', duplicated);
  console.log('stub counters before the wait:', JSON.stringify(stubBefore));

  if (OVERLAP_ONLY) {
    // Poll in short slices rather than one long wait: if the page reloads under us the
    // counters reset, and it is better to notice that than to report a bogus result.
    console.log('waiting out the 60s overlap timeout...');
    for (let i = 0; i < 14; i++) {
      await sleep(5000);
      const s = await evaluate(`window.__stub ? JSON.parse(JSON.stringify(window.__stub.overlap)) : null`);
      if (i % 3 === 0) console.log(`  t+${(i + 1) * 5}s overlap=${JSON.stringify(s)}`);
      if (s && s.terminated > 0 && logs.some((l) => /abandoned/.test(l))) break;
    }
    const s = await evaluate(`JSON.parse(JSON.stringify(window.__stub.overlap))`);
    console.log('overlap stub counters:', JSON.stringify(s));
    console.log('\n=== console output from the page ===');
    for (const l of logs.filter((l) => /overlap|abandon|timed out/i.test(l))) console.log(' ', l);
    fs.writeFileSync(path.join(OUT, 'overlap-timeout.json'), JSON.stringify({ stubBefore, overlapAfter: s, logs }, null, 2));
    return;
  }

  const both = await evaluate(`(async () => {
    const mod = await import('/src/lib/background-removal.ts');
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    c.getContext('2d').fillRect(0, 0, 64, 64);
    const t0 = performance.now();
    const bg = await mod.removeBackgroundFromCanvas(c, 75).then(
      () => ({ outcome: 'RESOLVED (bug)' }),
      (e) => ({ outcome: 'rejected', message: e.message, ms: Math.round(performance.now() - t0) }),
    );
    return { bg, stub: JSON.parse(JSON.stringify(window.__stub)) };
  })()`);
  console.log('background-removal:', JSON.stringify(both, null, 2));

  const stubAfter = await evaluate(`JSON.parse(JSON.stringify(window.__stub))`);
  console.log('stub counters after the wait :', JSON.stringify(stubAfter));
  console.log('\n=== console output from the page ===');
  for (const l of logs.filter((l) => /overlap|worker|timed out|abandon/i.test(l))) console.log(' ', l);
  fs.writeFileSync(path.join(OUT, 'worker-timeouts.json'), JSON.stringify({ pool, both, stubBefore, stubAfter, logs }, null, 2));
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
