// Dev-only verification driver for the three editor-draft policies:
//   1. deleting every design persists the empty state (no stale recovery offer)
//   2. drafts older than DRAFT_MAX_AGE_MS are neither offered nor kept
//   3. a confirmed add-to-cart (`dtf-builder-cart-status` → done) stops the draft
//      being offered, by stamping it submitted rather than deleting it
//
// Launches its OWN headless Chrome against a throwaway --user-data-dir, so the
// IndexedDB it reads and writes is isolated from any browser a human or another
// agent has open on localhost:5000.
//
//   node scripts/verify-draft-policies.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9411;
const URL = 'http://localhost:5000/test-builder';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'draftverify-'));

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

const IDB_OPEN = `
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open('sticker-editor-drafts', 1);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });`;

/** Reads the record and the file-store key count straight out of IndexedDB. */
const readDraft = () => evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  if (!db.objectStoreNames.contains('drafts')) { db.close(); return { db: 'empty' }; }
  const tx = db.transaction(['drafts', 'files'], 'readonly');
  const get = (store, method, key) => new Promise(res => {
    const q = key === undefined ? tx.objectStore(store)[method]() : tx.objectStore(store)[method](key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(null);
  });
  const draft = await get('drafts', 'get', 'current');
  const keys = await get('files', 'getAllKeys');
  db.close();
  return draft
    ? { exists: true, designs: draft.designs.length, savedAt: draft.savedAt, schemaVersion: draft.schemaVersion,
        submittedAt: draft.submittedAt ?? null, files: (keys || []).length }
    : { exists: false, files: (keys || []).length };
})()`);

/** Back-dates the stored record so the age cutoff can be exercised for real. */
const ageDraftByDays = (days) => evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite');
  const store = tx.objectStore('drafts');
  const draft = await new Promise(res => { const q = store.get('current'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  if (!draft) { db.close(); return 'no draft to age'; }
  draft.savedAt = Date.now() - ${days} * 24 * 60 * 60 * 1000;
  store.put(draft, 'current');
  await new Promise(res => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
  db.close();
  return new Date(draft.savedAt).toISOString();
})()`);

const bannerVisible = () => evaluate(
  `/Recover your previous work\\?/.test(document.body.innerText)`,
);
const designCount = () => evaluate(
  `(() => { const m = document.body.innerText.match(/(\\d+)\\s+design/i); return m ? Number(m[1]) : null; })()`,
);

/** Waits for the editor to be interactive rather than guessing a sleep — the
 *  dev server recompiles while other agents edit, so load time varies a lot. */
async function waitReady(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // `.preview-canvas-area` only exists once a design is on the sheet, so the
    // upload harness being installed is the readiness signal.
    const ready = await evaluate(
      `typeof window.__stressUpload === 'function' && (document.body?.innerText.length ?? 0) > 50`,
    ).catch(() => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error('editor never became ready');
}

async function reload() {
  await send('Page.navigate', { url: URL });
  await waitReady();
  await sleep(1500);
}

/**
 * Uploads and then waits for the sheet to actually finish landing.
 *
 * `__stressUpload` resolves before its designs are all on the sheet, and a check
 * that proceeds against a half-loaded sheet fails in ways that look exactly like
 * policy bugs: a design that arrives *after* a delete-all re-saves a non-empty
 * draft and the next reload offers a recovery banner the test just proved should
 * not exist. Waiting for the record to change and then stop changing removes the
 * guesswork — this run is sharing the machine with other agents' harnesses, so
 * "fast enough in practice" is not a property to rely on.
 */
async function upload(count = 2) {
  await waitReady();
  const before = JSON.stringify(await readDraft());
  await evaluate(`window.__stressUpload({ count: ${count}, dimension: 512 })`);
  const started = Date.now();
  while (Date.now() - started < 40000) {
    if (JSON.stringify(await readDraft()) !== before) break;
    await sleep(300);
  }
  return settleDraft();
}

/** Polls until the persisted record stops changing, so a count read from it is final. */
async function settleDraft(timeoutMs = 40000, needStable = 4) {
  const started = Date.now();
  let last = null, key = null, stable = 0;
  while (Date.now() - started < timeoutMs) {
    last = await readDraft();
    const k = JSON.stringify(last);
    if (k === key) {
      if (++stable >= needStable) return last;
    } else {
      stable = 0;
      key = k;
    }
    await sleep(400);
  }
  return last;
}

/** Polls IndexedDB until the predicate holds, so timing is never guessed. */
async function waitFor(label, predicate, timeoutMs = 12000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await readDraft();
    if (predicate(last)) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} — last read: ${JSON.stringify(last)}`);
}

async function key(k, code, windowsVirtualKeyCode, modifiers = 0) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode, modifiers });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode, modifiers });
}

async function clickCanvas() {
  const p = await evaluate(`(() => {
    const el = document.querySelector('.preview-canvas-area');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!p) return;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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
      return;
    }
    // Surface the page's own draft diagnostics, so a silent storage failure
    // can't masquerade as a policy result.
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/editor-draft/.test(text)) console.log('    [page]', text.slice(0, 200));
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await reload();

  // ---------------------------------------------------------------- Decision 1
  console.log('\nDECISION 1 — deleting every design must persist the empty state');
  const cold = await readDraft();
  check('fresh profile starts with no draft', !cold.exists, JSON.stringify(cold));

  // A page that has only just loaded must not write anything: that is the
  // half of the old gate the session flag has to preserve.
  await sleep(3000);
  const idle = await readDraft();
  check('empty page load writes nothing', !idle.exists, JSON.stringify(idle));

  await upload(2);
  const saved = await waitFor('draft with designs', (d) => d.exists && d.designs >= 1);
  check('uploading produces a draft with the sheet in it', saved.designs >= 1 && saved.files === saved.designs, JSON.stringify(saved));

  await clickCanvas();
  await sleep(300);
  await key('a', 'KeyA', 65, 2);   // ctrl+A → select all
  await sleep(600);
  await key('Delete', 'Delete', 46);
  const emptied = await waitFor('empty draft on disk', (d) => d.exists && d.designs === 0);
  check('delete-all reaches disk as an empty draft', emptied.designs === 0, JSON.stringify(emptied));
  check('delete-all releases the stored blobs', emptied.files === 0, `files=${emptied.files}`);

  await reload();
  check('no recovery banner after delete-all', (await bannerVisible()) === false);

  // The other half of the old gate: a page that has just loaded also has zero
  // designs, and must not overwrite the draft it is about to offer.
  await upload(1);
  const armed = await waitFor('draft to save', (d) => d.exists && d.designs === 1);
  await reload();
  check('banner is offered on the next visit', (await bannerVisible()) === true);
  await sleep(4000);
  const untouched = await readDraft();
  check(
    'a fresh load does not clobber the offered draft',
    untouched.exists && untouched.designs === 1 && untouched.savedAt === armed.savedAt,
    JSON.stringify(untouched),
  );

  // Recover, then delete everything: the session *did* become non-empty, so
  // this delete is deliberate and must reach disk.
  const clicked = await evaluate(
    `(() => { const b=[...document.querySelectorAll('button')].find(x=>/Recover draft/.test(x.innerText||'')); if (b) b.click(); return !!b; })()`,
  );
  check('recover button present', clicked === true);
  for (let i = 0; i < 30 && (await bannerVisible()); i++) await sleep(400);
  await sleep(1200);
  await key('a', 'KeyA', 65, 2);
  await sleep(500);
  await key('Delete', 'Delete', 46);
  const afterRecoverDelete = await waitFor('empty draft after recover+delete', (d) => d.exists && d.designs === 0);
  check('delete-all after a recovery clears the draft', afterRecoverDelete.designs === 0, JSON.stringify(afterRecoverDelete));

  // Delete everything and hide the page inside the 750 ms debounce window: the
  // synchronous unload flush has to carry the empty state to disk on its own.
  await upload(1);
  await waitFor('draft to save', (d) => d.exists && d.designs === 1);
  await key('a', 'KeyA', 65, 2);
  await sleep(500);
  await key('Delete', 'Delete', 46);
  await sleep(60);
  const flushStarted = Date.now();
  await evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`);
  const flushed = await readDraft();
  const flushMs = Date.now() - flushStarted;
  check(
    'unload flush persists the empty sheet before the debounce could',
    flushed.exists && flushed.designs === 0 && flushMs < 600,
    `${JSON.stringify(flushed)} after ${flushMs}ms`,
  );

  // ---------------------------------------------------------------- Decision 2
  console.log('\nDECISION 2 — drafts expire after 7 days');
  await upload(1);
  await waitFor('draft to save', (d) => d.exists && d.designs === 1);

  console.log('  aged to:', await ageDraftByDays(6));
  await reload();
  check('6-day-old draft is still offered', (await bannerVisible()) === true);
  const sixDay = await readDraft();
  check('6-day-old draft is kept on disk', sixDay.exists, JSON.stringify(sixDay));

  console.log('  aged to:', await ageDraftByDays(8));
  await reload();
  check('8-day-old draft is not offered', (await bannerVisible()) === false);
  const purged = await waitFor('expired draft purge', (d) => !d.exists);
  check('8-day-old draft is deleted', !purged.exists, JSON.stringify(purged));
  check('expired purge frees its blobs', purged.files === 0, `files=${purged.files}`);

  // Fail-safe: an unreadable timestamp must keep the draft, not destroy it.
  await upload(1);
  await waitFor('draft to save', (d) => d.exists && d.designs === 1);
  await evaluate(`(async () => {${IDB_OPEN}
    const db = await openDb();
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    const draft = await new Promise(res => { const q = store.get('current'); q.onsuccess = () => res(q.result); });
    delete draft.savedAt;
    store.put(draft, 'current');
    await new Promise(res => { tx.oncomplete = res; tx.onabort = res; });
    db.close();
  })()`);
  await reload();
  check('draft with missing savedAt is still offered', (await bannerVisible()) === true);
  check('draft with missing savedAt is not destroyed', (await readDraft()).exists);

  // Future-dated (clock skew) must also survive.
  await ageDraftByDays(-30);
  await reload();
  check('future-dated draft is still offered', (await bannerVisible()) === true);

  // ---------------------------------------------------------------- Decision 3
  console.log('\nDECISION 3 — a confirmed add-to-cart stops the draft being offered');
  // Discard the banner so this session starts clean, then build a fresh sheet.
  await evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/^Discard$/.test((x.innerText||'').trim())); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  await upload(2);
  const beforeCart = await waitFor('draft before cart', (d) => d.exists && d.designs >= 1);
  const sheetCount = beforeCart.designs;
  check('sheet is drafted before add-to-cart', sheetCount >= 1, JSON.stringify(beforeCart));

  // A rejected cart must leave the customer's only copy alone.
  await evaluate(`window.postMessage({ type: 'dtf-builder-cart-status', status: 'error', message: 'nope', requestId: window.__dtfMintCartSubmitId() }, '*')`);
  await sleep(2500);
  const afterError = await readDraft();
  check('cart error keeps the draft', afterError.exists && afterError.designs === sheetCount, JSON.stringify(afterError));

  // Establish that a keyboard nudge really does dirty the draft, so the race
  // test below cannot pass vacuously by simply not changing anything.
  await clickCanvas();
  await sleep(300);
  await key('a', 'KeyA', 65, 2);   // ctrl+A → select all
  await sleep(400);
  await key('ArrowRight', 'ArrowRight', 39);
  const nudged = await waitFor(
    'nudge to reach disk',
    (d) => d.exists && d.savedAt > beforeCart.savedAt,
    8000,
  );
  check('a nudge dirties the draft and re-saves', nudged.savedAt > beforeCart.savedAt, JSON.stringify(nudged));

  // Confirmed success clears it. Nudge again immediately beforehand so a
  // debounced save is armed against a *newer* signature than the one on disk —
  // that is the resurrection race the clear has to win.
  await key('ArrowRight', 'ArrowRight', 39);
  // `done` is only honoured for a submit this tab actually made, so the simulated
  // shell reply has to carry a real requestId — `__dtfMintCartSubmitId` is the
  // dev-only mint hook the app exposes for exactly this.
  await evaluate(`window.postMessage({ type: 'dtf-builder-cart-status', status: 'done', message: 'Added to cart', requestId: window.__dtfMintCartSubmitId() }, '*')`);
  const stamped = await waitFor('draft stamped submitted after done', (d) => d.exists && d.submittedAt, 8000);
  // The contract changed here deliberately: `done` means the cart request came
  // back, not that the order is durable, so the sheet is marked rather than
  // destroyed and survives a checkout that later fails. The customer-visible
  // effect is identical — no recovery banner — and that is asserted below.
  check('confirmed add-to-cart keeps the draft and stamps it submitted',
    stamped.exists && typeof stamped.submittedAt === 'number' && stamped.designs === sheetCount,
    JSON.stringify(stamped));
  check('the submitted draft keeps its blobs', stamped.files > 0, `files=${stamped.files}`);

  await sleep(5000);
  const stillStamped = await readDraft();
  check('pending debounced save does not clear the stamp', stillStamped.exists && Boolean(stillStamped.submittedAt), JSON.stringify(stillStamped));
  check('designs are still on screen after the submit', (await designCount()) !== 0, `designCount=${await designCount()}`);

  // The retained record must not be offered back: to the customer a submitted
  // sheet has to look exactly like a deleted one.
  await reload();
  check('a submitted draft is not offered on the next visit', (await bannerVisible()) === false);
  const survived = await readDraft();
  check('...but it is still on disk, recoverable if the order never completed',
    survived.exists && survived.designs === sheetCount && survived.files > 0, JSON.stringify(survived));

  // A real edit after the submit must resume normal saving and clear the stamp —
  // the suppression is a one-shot, not a permanent gate.
  await upload(1);
  const reArmed = await waitFor('new draft after post-cart edit', (d) => d.exists && !d.submittedAt, 12000);
  check('a later edit clears the stamp and resumes saving', reArmed.exists && !reArmed.submittedAt, JSON.stringify(reArmed));
  await reload();
  check('and recovery is offered again', (await bannerVisible()) === true);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('failed:', failed.map((f) => f.name).join(' | '));
}

main().catch((e) => console.error('HARNESS FAILED', e)).finally(async () => {
  await sleep(300);
  try { ws?.close(); } catch {}
  chrome.kill();
  process.exit(0);
});
