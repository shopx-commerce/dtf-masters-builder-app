// Dev-only probe: measures the W/H size field's touch target and proves the desktop
// toolbar is untouched by the mobile-only height change in `size-input.tsx`.
//
// Mobile run (390x844, touch, iPhone UA):
//   - measures the field as it renders now ("after")
//   - re-measures with a `height: 1.75rem` override that reproduces the old `h-7`
//     ("before"), so both numbers come from the same page
//   - checks the mobile size panel still fits its column
//
// Desktop run (1500x950): captures the geometry of every element in the toolbar and a
// screenshot, then rewrites both inputs' classes back to the pre-change `h-7` and
// captures again. Identical geometry + identical screenshot bytes = pixel-identical.
//
//   node scripts/probe-size-input-target.mjs [--desktop]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DESKTOP = process.argv.includes('--desktop');
// `--w=900` checks the 768-1023px band: the desktop toolbar renders there (the layout
// swap is at 768px) but Tailwind's `lg:` would not yet have applied.
const WIDTH = Number((process.argv.find((a) => a.startsWith('--w=')) || '').slice(4)) || (DESKTOP ? 1500 : 390);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = DESKTOP ? 9412 : 9411;
const OUT = path.resolve('tmp-size-target');
fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-size-'));
const tag = `${DESKTOP ? 'desktop' : 'mobile'}-${WIDTH}w`;

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new',
  `--window-size=${WIDTH},${DESKTOP ? 950 : 844}`,
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
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip: { ...clip, scale: 1 } } : { format: 'png' });
  const p = path.join(OUT, `${tag}-${name}.png`);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('  screenshot →', p);
  return crypto.createHash('sha256').update(r.data).digest('hex');
}

/** Geometry + hit-testing for every size field on the page. */
const measure = () => evaluate(`(() => {
  const fields = [...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || ''));
  const probePoint = (x, y, self) => {
    const hit = document.elementFromPoint(x, y);
    return hit === self;
  };
  return {
    innerWidth: window.innerWidth,
    count: fields.length,
    fields: fields.map((i) => {
      const r = i.getBoundingClientRect();
      const cs = getComputedStyle(i);
      // The panel the field lives in, and its scroll container, to spot new overflow.
      const panel = i.closest('div.rounded-md') || i.parentElement;
      const pr = panel.getBoundingClientRect();
      let scroller = i.parentElement, overflow = null;
      while (scroller) {
        const s = getComputedStyle(scroller);
        if (/auto|scroll/.test(s.overflowY) || /auto|scroll/.test(s.overflowX)) {
          const sr = scroller.getBoundingClientRect();
          overflow = {
            className: String(scroller.className).slice(0, 70),
            clientH: scroller.clientHeight, scrollH: scroller.scrollHeight,
            clientW: scroller.clientWidth, scrollW: scroller.scrollWidth,
            vScroll: scroller.scrollHeight > scroller.clientHeight + 1,
            hScroll: scroller.scrollWidth > scroller.clientWidth + 1,
            rect: { w: +sr.width.toFixed(1), h: +sr.height.toFixed(1) },
          };
          break;
        }
        scroller = scroller.parentElement;
      }
      return {
        title: i.title,
        value: i.value,
        className: i.className.split(' ').filter(c => /^h-|^md:h-|^w-/.test(c)).join(' '),
        hit: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        area: Math.round(r.width * r.height),
        cssHeight: cs.height,
        fontSize: cs.fontSize,
        // A 44px target is only real if the whole box is tappable, not just the middle.
        tapCentre: probePoint(r.left + r.width / 2, r.top + r.height / 2, i),
        tapTopEdge: probePoint(r.left + r.width / 2, r.top + 3, i),
        tapBottomEdge: probePoint(r.left + r.width / 2, r.bottom - 3, i),
        panel: { w: +pr.width.toFixed(1), h: +pr.height.toFixed(1), y: +pr.top.toFixed(1), bottom: +pr.bottom.toFixed(1) },
        panelClippedByViewport: pr.bottom > window.innerHeight || pr.right > window.innerWidth,
        scroller: overflow,
      };
    }),
    // Sibling stepper arrows: must be untouched.
    arrows: [...document.querySelectorAll('button[aria-label="Increase size"], button[aria-label="Decrease size"]')].map(b => {
      const r = b.getBoundingClientRect();
      return { label: b.getAttribute('aria-label'), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }),
  };
})()`);

/** Every rect in the toolbar, so a desktop change of any kind shows up. */
const toolbarGeometry = () => evaluate(`(() => {
  const anchor = [...document.querySelectorAll('span')].find(s => s.textContent === 'Size' && /text-cyan-900/.test(s.className));
  if (!anchor) return null;
  const root = anchor.closest('div.flex-col, div.flex') ? anchor.parentElement.parentElement.parentElement : anchor.parentElement;
  const all = [root, ...root.querySelectorAll('*')];
  return {
    count: all.length,
    // Keyed on tag + geometry only. The class list is deliberately excluded: it is the
    // one thing that is *meant* to differ between the two states being compared.
    rects: all.map((el) => {
      const r = el.getBoundingClientRect();
      return [el.tagName, +r.x.toFixed(2), +r.y.toFixed(2), +r.width.toFixed(2), +r.height.toFixed(2)].join('|');
    }),
    rootRect: (() => { const r = root.getBoundingClientRect(); return { x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; })(),
  };
})()`);

/**
 * Drop one generated design onto the page.
 *
 * The artwork is drawn in-page rather than fetched: `client/public/nest-test/` is a
 * scratch directory that may or may not exist, and the dev server answers a missing
 * asset with `index.html`, which reaches the decoder as a zero-dimension "PNG".
 */
async function uploadDesign() {
  return evaluate(`(async () => {
    const c = document.createElement('canvas');
    c.width = 1200; c.height = 900;
    const g = c.getContext('2d');
    g.fillStyle = '#e11d48';
    g.beginPath(); g.ellipse(600, 450, 520, 360, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0ea5e9';
    g.fillRect(500, 350, 200, 200);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const file = new File([blob], 'probe-design.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    // The editor root is the element carrying React's onDrop; its hidden file input
    // makes it findable without a test hook. Falls back to the landing drop zone.
    const hidden = [...document.querySelectorAll('input[type=file]')].find(i => i.className.includes('hidden'));
    const root = hidden ? hidden.parentElement : document.body;
    for (const type of ['dragenter', 'dragover', 'drop']) {
      root.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
    return { bytes: blob.size, target: String(root.className).slice(0, 60) };
  })()`);
}

async function waitForField(maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const n = await evaluate(`[...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || '')).length`);
    if (n > 0) return true;
    // A dropped file lands in the "Device Uploads" list first; "Add Here" commits it to
    // the sheet. On mobile the size column is the second pane, so also press the toggle.
    await evaluate(`(() => {
      const add = [...document.querySelectorAll('button')].find(b => /Add Here/i.test(b.textContent || ''));
      if (add) add.click();
      const prev = [...document.querySelectorAll('button')].find(b => /Preview/.test(b.textContent || ''));
      if (prev) prev.click();
      return { add: !!add, prev: !!prev };
    })()`);
    await sleep(1200);
  }
  return false;
}

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
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 950, deviceScaleFactor: 1, mobile: false });
  } else {
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      platform: 'iPhone',
    });
  }

  await send('Page.navigate', { url: 'http://localhost:5000/test-builder' });
  await sleep(9000);
  console.log('  dropped:', JSON.stringify(await uploadDesign()));
  if (!(await waitForField())) {
    console.log('No size field appeared — upload may not have landed.');
    await shot('99-no-field');
    return;
  }
  await sleep(1500);

  if (DESKTOP) {
    const geomAfter = await toolbarGeometry();
    const measureAfter = await measure();
    // Clip to the Size panel: a full-page shot also contains the live preview canvas,
    // which repaints on its own and would mask a real toolbar difference in noise.
    const clip = geomAfter
      ? { x: Math.max(0, geomAfter.rootRect.x - 8), y: Math.max(0, geomAfter.rootRect.y - 8), width: geomAfter.rootRect.w + 16, height: geomAfter.rootRect.h + 16 }
      : undefined;
    const hashAfter = await shot('01-current', clip);
    await shot('01-current-full');
    console.log('\n=== DESKTOP, CURRENT CODE (h-11 md:h-7) ===');
    console.log(JSON.stringify(measureAfter, null, 2));

    // Reproduce the pre-change markup exactly: the class list before this change was
    // `h-7` where it is now `h-11 md:h-7`, everything else identical.
    const swapped = await evaluate(`(() => {
      const fields = [...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || ''));
      fields.forEach(i => { i.className = i.className.replace('h-11 md:h-7', 'h-7'); });
      return fields.map(i => i.className.split(' ')[0]);
    })()`);
    await sleep(400);
    const geomBefore = await toolbarGeometry();
    const measureBefore = await measure();
    const hashBefore = await shot('02-pre-change-classes', clip);
    await shot('02-pre-change-classes-full');
    console.log('\n=== DESKTOP, PRE-CHANGE CLASSES (h-7), same page ===');
    console.log('first class now:', JSON.stringify(swapped));
    console.log(JSON.stringify(measureBefore, null, 2));

    const rectDiff = (geomAfter?.rects ?? []).filter((r, i) => r !== (geomBefore?.rects ?? [])[i]);
    console.log('\n=== DESKTOP VERDICT ===');
    console.log('toolbar elements compared :', geomAfter?.count);
    console.log('rects that differ         :', rectDiff.length, rectDiff.slice(0, 10));
    console.log('screenshot sha256 current :', hashAfter);
    console.log('screenshot sha256 pre     :', hashBefore);
    console.log('pixel-identical           :', hashAfter === hashBefore && rectDiff.length === 0);
    fs.writeFileSync(path.join(OUT, 'desktop-geometry.json'), JSON.stringify({ geomAfter, geomBefore, measureAfter, measureBefore, hashAfter, hashBefore }, null, 2));
    return;
  }

  const after = await measure();
  console.log('\n=== MOBILE, AFTER (h-11 under md) ===');
  console.log(JSON.stringify(after, null, 2));
  const hashAfter = await shot('01-after');

  // Same page, old height. `h-7` is 1.75rem; this reproduces the pre-change box without
  // touching the source or reloading, so the two numbers are directly comparable.
  await evaluate(`(() => {
    const s = document.createElement('style');
    s.id = 'probe-before';
    s.textContent = 'input.h-11 { height: 1.75rem !important; }';
    document.head.appendChild(s);
    return true;
  })()`);
  await sleep(500);
  const before = await measure();
  console.log('\n=== MOBILE, BEFORE (h-7 = 1.75rem, reproduced) ===');
  console.log(JSON.stringify(before, null, 2));
  const hashBefore = await shot('02-before');

  await evaluate(`document.getElementById('probe-before')?.remove(), true`);
  await sleep(400);
  const restored = await measure();

  console.log('\n=== MOBILE VERDICT ===');
  for (let i = 0; i < after.fields.length; i++) {
    const b = before.fields[i], a = after.fields[i];
    console.log(`field ${i} (${a.title.split('—')[0].trim()})`);
    console.log(`  hit target  : ${b.hit.w} x ${b.hit.h} (${b.area}px²)  ->  ${a.hit.w} x ${a.hit.h} (${a.area}px²)`);
    console.log(`  meets 44px  : ${b.hit.h >= 44 ? 'yes' : 'no'}  ->  ${a.hit.h >= 44 ? 'yes' : 'no'}`);
    console.log(`  tappable box: centre ${a.tapCentre} topEdge ${a.tapTopEdge} bottomEdge ${a.tapBottomEdge}`);
    console.log(`  panel       : ${b.panel.w}x${b.panel.h} -> ${a.panel.w}x${a.panel.h}, clipped by viewport: ${a.panelClippedByViewport}`);
    console.log(`  scroller    : ${JSON.stringify(a.scroller)}`);
  }
  // The taller box must still behave: a real touch tap has to focus a typable input.
  // This is the structural half of the iOS keyboard fix, which Chrome can check.
  const rect = await evaluate(`(() => {
    const i = [...document.querySelectorAll('input')].find(x => /click to edit/i.test(x.title || ''));
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y, radiusX: 12, radiusY: 12, force: 1 }] });
  await sleep(90);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
  const focus = await evaluate(`(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, title: a?.title, readOnly: a?.readOnly ?? null, inputMode: a?.getAttribute?.('inputmode') ?? null };
  })()`);
  await evaluate(`(() => { const a = document.activeElement; a.setSelectionRange(0, a.value.length); return true; })()`);
  for (const ch of '3.5') {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp' });
  }
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' });
  await sleep(900);
  const committed = await evaluate(`[...document.querySelectorAll('input')].filter(i => /click to edit/i.test(i.title || '')).map(i => i.value)`);
  await shot('03-after-tap-and-type');
  console.log('tap focus    :', JSON.stringify(focus));
  console.log('values after typing 3.5 + Enter:', JSON.stringify(committed));
  console.log('arrows after :', JSON.stringify(after.arrows));
  console.log('arrows before:', JSON.stringify(before.arrows));
  console.log('restored h   :', restored.fields.map(f => f.hit.h).join(', '));
  console.log('shots differ :', hashAfter !== hashBefore);
  fs.writeFileSync(path.join(OUT, 'mobile-geometry.json'), JSON.stringify({ before, after, restored }, null, 2));
}

main().catch((e) => console.error('FAILED', e)).finally(async () => {
  await sleep(400);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
