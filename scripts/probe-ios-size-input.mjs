// Dev-only probe: opens the test builder in an iPhone-sized, touch-emulated
// headless Chrome and reports everything that decides whether a tap on the
// W/H size field ends up focusing a *typable* input.
//
// Chrome cannot prove iOS keyboard behaviour — there is no software keyboard
// here. What it can prove is the structural half: hit target, overlays,
// touchstart preventDefault, and the readOnly/inputMode state at focus time.
//
//   node scripts/probe-ios-size-input.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DESKTOP = process.argv.includes('--desktop');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = DESKTOP ? 9402 : 9401;
const OUT = path.resolve('tmp-repro');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-ios-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  '--window-size=390,844',
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
  const p = path.join(OUT, `${DESKTOP ? 'desktop' : 'ios'}-size-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  screenshot →', p);
}

/** Describe every candidate size field: geometry, attributes, what a tap hits. */
const describe = () => evaluate(`(() => {
  const pick = [...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || ''));
  return {
    isMobileLayout: window.innerWidth < 768,
    innerWidth: window.innerWidth,
    count: pick.length,
    fields: pick.map((i) => {
      const r = i.getBoundingClientRect();
      const cs = getComputedStyle(i);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // Walk ancestors looking for anything that would eat the tap.
      const blockers = [];
      for (let n = i.parentElement; n && n !== document.documentElement; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.touchAction === 'none') blockers.push('touch-action:none on ' + n.className);
        if (s.pointerEvents === 'none') blockers.push('pointer-events:none on ' + n.className);
        if (s.userSelect === 'none' || s.webkitUserSelect === 'none') blockers.push('user-select:none on ' + n.className);
      }
      return {
        title: i.title,
        value: i.value,
        type: i.type,
        inputMode: i.getAttribute('inputmode'),
        readOnly: i.readOnly,
        disabled: i.disabled,
        rect: { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.left.toFixed(1), y: +r.top.toFixed(1) },
        fontSize: cs.fontSize,
        ownUserSelect: cs.userSelect || cs.webkitUserSelect,
        ownTouchAction: cs.touchAction,
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0',
        tapLandsOnSelf: hit === i,
        tapLandsOn: hit ? (hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className.slice(0, 60) : '')) : null,
        ancestorBlockers: blockers,
      };
    }),
  };
})()`);

async function main() {
  for (let i = 0; i < 60; i++) {
    try { if ((await targets()).length) break; } catch {}
    await sleep(250);
  }
  const page = (await targets()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
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

  if (DESKTOP) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1500, height: 950, deviceScaleFactor: 1, mobile: false,
    });
  } else {
    // iPhone 14-ish metrics + real touch event support, no mouse.
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
  }

  await send('Page.navigate', { url: 'http://localhost:5000/test-builder?stress=1' });
  await sleep(11000);

  const before = await describe();
  console.log('\n=== SIZE FIELDS AS RENDERED (390px viewport, touch, iPhone UA) ===');
  console.log(JSON.stringify(before, null, 2));
  await shot('01-mobile');

  if (!before.count) {
    console.log('\nNo size field found — layout may not have loaded a design.');
    return;
  }

  // Instrument: does anything cancel the touch sequence before focus?
  await evaluate(`(() => {
    window.__probe = { touchstartPrevented: null, focusEvents: [] };
    document.addEventListener('touchstart', (e) => {
      window.__probe.touchstartPrevented = e.defaultPrevented;
    }, { capture: false, passive: true });
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      window.__probe.focusEvents.push({
        tag: t.tagName,
        title: t.title,
        // The state iOS reads when it decides to show the keyboard.
        readOnlyAtFocus: t.readOnly,
        disabledAtFocus: t.disabled,
        inputModeAtFocus: t.getAttribute('inputmode'),
        typeAtFocus: t.type,
      });
    }, true);
    return 'instrumented';
  })()`);

  const f = before.fields[0];
  const cx = Math.round(f.rect.x + f.rect.w / 2);
  const cy = Math.round(f.rect.y + f.rect.h / 2);
  console.log(`\n=== TAPPING FIRST SIZE FIELD AT (${cx}, ${cy}) WITH REAL TOUCH EVENTS ===`);

  if (DESKTOP) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  } else {
    await send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: cx, y: cy, radiusX: 12, radiusY: 12, force: 1 }],
    });
    await sleep(90);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await sleep(600);

  const after = await evaluate(`(() => {
    const a = document.activeElement;
    return {
      probe: window.__probe,
      activeElement: a ? a.tagName + (a.title ? ' [' + a.title + ']' : '') : null,
      activeIsSizeInput: !!(a && a.tagName === 'INPUT' && /width|height|edit/i.test(a.title || '')),
      activeReadOnlyNow: a && a.tagName === 'INPUT' ? a.readOnly : null,
      activeInputModeNow: a && a.tagName === 'INPUT' ? a.getAttribute('inputmode') : null,
      activeValueNow: a && a.tagName === 'INPUT' ? a.value : null,
    };
  })()`);
  console.log(JSON.stringify(after, null, 2));

  // Full round trip: clear, type a new size, commit with Enter.
  await evaluate(`(() => {
    const a = document.activeElement;
    a.setSelectionRange(0, a.value.length);
    return true;
  })()`);
  for (const ch of '3.5') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp' });
  }
  await sleep(300);
  const typed = await evaluate(`(() => { const a = document.activeElement; return a && a.tagName === 'INPUT' ? a.value : null; })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await sleep(900);
  const committed = await evaluate(`(() => {
    const i = [...document.querySelectorAll('input')].filter(x => /click to edit/i.test(x.title || ''));
    return i.map(x => ({ title: x.title, value: x.value, readOnly: x.readOnly }));
  })()`);
  console.log('\ntyped into field :', JSON.stringify(typed));
  console.log('after Enter      :', JSON.stringify(committed));
  await shot('02-after-tap');
  console.log('\ndone');
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
