// Dev-only verification driver for the five draft-persistence changes batched
// tonight. Complements `verify-draft-policies.mjs`, which is left untouched so
// its count stays a clean regression baseline; the behaviour here needs things
// that harness cannot do — chiefly a *second page* against the same profile.
//
//   1. a draft from an OLDER schema is deleted and its blobs freed;
//      a draft from a NEWER schema is kept
//   2. vector sources live in the file store, not in the draft record
//   3. one tab owns saving: a second tab neither saves nor clears, a killed
//      owner does not wedge saving, a closing owner hands over, and a missing
//      BroadcastChannel degrades to saving normally
//   4. a draft built for another product is not offered, but is not destroyed
//   5. a design recovered below print resolution is reported to the customer
//
// Launches its OWN headless Chrome against a throwaway --user-data-dir, so the
// IndexedDB it reads and writes is isolated from any browser a human or another
// agent has open on localhost:5000.
//
//   node scripts/verify-draft-batch.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9413;
const URL = 'http://localhost:5000/test-builder';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'draftbatch-'));

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

// ---------------------------------------------------------------------------
// One CDP session per page, so two tabs can be driven independently. `browser`
// is the browser-level session, which is where Target.* has to be sent from.
// ---------------------------------------------------------------------------
let nextId = 0;
function attach(webSocketDebuggerUrl, label, { page = true } = {}) {
  const pending = new Map();
  const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  const session = {
    label,
    ws,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const r = await session.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(`${label}: ${r.exceptionDetails.exception?.description ?? 'eval failed'}`);
      }
      return r.result?.value;
    },
  };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (/editor-draft/.test(text)) console.log(`    [${label}]`, text.slice(0, 220));
    }
  });
  ws.on('error', () => { /* a closed tab's socket erroring is expected */ });
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', async () => {
      if (page) {
        await session.send('Page.enable');
        await session.send('Runtime.enable');
      }
      resolve(session);
    });
  });
}

let browser;

/** Opens a brand-new tab on the app and returns its session. */
async function openTab(label, { withoutBroadcastChannel = false } = {}) {
  const created = await browser.send('Target.createTarget', { url: 'about:blank' });
  let target;
  for (let i = 0; i < 40 && !target; i++) {
    target = (await targets()).find((t) => t.id === created.targetId && t.webSocketDebuggerUrl);
    if (!target) await sleep(150);
  }
  if (!target) throw new Error(`could not attach to new tab ${label}`);
  const session = await attach(target.webSocketDebuggerUrl, label);
  session.targetId = created.targetId;
  if (withoutBroadcastChannel) {
    // Removed before any app code runs, so the module-level support check sees
    // the same thing a browser without the API would.
    await session.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'delete window.BroadcastChannel;',
    });
  }
  await session.send('Page.navigate', { url: URL });
  await waitReady(session);
  await sleep(1200);
  return session;
}

async function closeTab(session) {
  await browser.send('Target.closeTarget', { targetId: session.targetId }).catch(() => {});
  try { session.ws.close(); } catch { /* already gone */ }
  await sleep(250);
}

async function waitReady(session, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await session.evaluate(
      `typeof window.__stressUpload === 'function' && (document.body?.innerText.length ?? 0) > 50`,
    ).catch(() => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error(`${session.label}: editor never became ready`);
}

// ---------------------------------------------------------------------------
// IndexedDB probes. Read/written through any page on the origin — all tabs
// share one store, which is the entire reason tab ownership exists.
// ---------------------------------------------------------------------------
const IDB_OPEN = `
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open('sticker-editor-drafts', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('blocked'));
  });`;

const readDraft = (session) => session.evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction(['drafts', 'files'], 'readonly');
  const get = (store, method, key) => new Promise(res => {
    const q = key === undefined ? tx.objectStore(store)[method]() : tx.objectStore(store)[method](key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => res(null);
  });
  const draft = await get('drafts', 'get', 'current');
  const keys = await get('files', 'getAllKeys');
  db.close();
  if (!draft) return { exists: false, files: (keys || []).length, keys: keys || [] };
  const designs = draft.designs || [];
  return {
    exists: true,
    designs: designs.length,
    savedAt: draft.savedAt,
    schemaVersion: draft.schemaVersion,
    profileId: draft.profileId,
    files: (keys || []).length,
    keys: keys || [],
    // Whether any design still carries inline vector bytes, and which file-store
    // keys the record points at for them instead.
    inlineVectorBytes: designs.some(d => 'originalPdfData' in d || 'svgSource' in d),
    vectorKeys: designs.flatMap(d => [d.pdfKey, d.svgKey].filter(Boolean)),
    recordBytes: new Blob([JSON.stringify(designs)]).size,
  };
})()`);

/** Overwrites fields on the stored record so a policy can be exercised for real. */
const patchDraft = (session, patchExpression) => session.evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite');
  const store = tx.objectStore('drafts');
  const draft = await new Promise(res => { const q = store.get('current'); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  if (!draft) { db.close(); return 'no draft to patch'; }
  (${patchExpression})(draft);
  store.put(draft, 'current');
  await new Promise(res => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
  db.close();
  return 'patched -> schemaVersion=' + draft.schemaVersion + ' profileId=' + draft.profileId;
})()`);

/** Plants a record of an arbitrary schema version plus blobs for it to own. */
const plantDraft = (session, schemaVersion) => session.evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction(['drafts', 'files'], 'readwrite');
  tx.objectStore('drafts').put({
    schemaVersion: ${schemaVersion},
    savedAt: Date.now(),
    profileId: 'hot-peel',
    artboardWidth: 22, artboardHeight: 12, quantity: 1, designGap: 0.25,
    selectedDesignId: 'planted', selectedDesignIds: ['planted'],
    designs: [{
      id: 'planted', name: 'planted.png',
      transform: { nx: 0.5, ny: 0.5, s: 1, rotation: 0 },
      widthInches: 4, heightInches: 4, originalDPI: 300,
      fileKey: 'planted-key', fileName: 'planted.png', fileType: 'image/png',
      fileLastModified: Date.now(), originalWidth: 512, originalHeight: 512, dpi: 300,
    }],
  }, 'current');
  tx.objectStore('files').put({
    key: 'planted-key',
    blob: new Blob([new Uint8Array(4096)], { type: 'image/png' }),
    name: 'planted.png', type: 'image/png', lastModified: Date.now(),
  });
  // A second, orphaned blob: the kind an earlier save stranded. An obsolete
  // record's purge has to reclaim these too, or the leak simply moves.
  tx.objectStore('files').put({
    key: 'orphan-key',
    blob: new Blob([new Uint8Array(2048)], { type: 'image/png' }),
    name: 'orphan.png', type: 'image/png', lastModified: Date.now(),
  });
  await new Promise(res => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
  db.close();
  return 'planted schemaVersion=${schemaVersion} with 2 blobs';
})()`);

const wipeStores = (session) => session.evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction(['drafts', 'files'], 'readwrite');
  tx.objectStore('drafts').clear();
  tx.objectStore('files').clear();
  await new Promise(res => { tx.oncomplete = res; tx.onerror = res; tx.onabort = res; });
  db.close();
  return 'wiped';
})()`);

/** Reads a file-store record's contents back, to prove the round trip. */
const readFileRecord = (session, key) => session.evaluate(`(async () => {${IDB_OPEN}
  const db = await openDb();
  const tx = db.transaction('files', 'readonly');
  const rec = await new Promise(res => { const q = tx.objectStore('files').get(${JSON.stringify(key)}); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
  db.close();
  if (!rec) return null;
  return { type: rec.type, size: rec.blob.size, head: (await rec.blob.text()).slice(0, 80) };
})()`);

const bannerVisible = (session) => session.evaluate(
  `/Recover your previous work\\?/.test(document.body.innerText)`,
);
const ownership = (session) => session.evaluate(
  `window.__draftOwnership ? window.__draftOwnership() : null`,
);
const upload = (session, count = 1) =>
  session.evaluate(`window.__stressUpload({ count: ${count}, dimension: 512 })`);

/**
 * Delivers a synthetic SVG through the same file-input path a real upload takes.
 * Padded with real elements rather than a comment or `<desc>` so the sanitiser
 * cannot strip the bulk and make "the source left the record" untestable.
 */
const uploadSvg = (session) => session.evaluate(`(() => {
  const rects = [];
  for (let i = 0; i < 2000; i++) {
    rects.push('<rect x="' + (i % 40) * 10 + '" y="' + Math.floor(i / 40) * 6 + '" width="8" height="4" fill="#c0392b"/>');
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">'
    + rects.join('') + '</svg>';
  const file = new File([svg], 'vector-probe.svg', { type: 'image/svg+xml' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const inputs = [...document.querySelectorAll('input[type=file]')];
  const input = inputs.find(i => (i.accept || '').includes('svg')) ?? inputs.find(i => i.multiple) ?? inputs[0];
  if (!input) return 'no file input';
  Object.defineProperty(input, 'files', { configurable: true, value: dt.files });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'dispatched ' + svg.length + ' source bytes';
})()`);

/** Captures toast text as it appears, since toasts auto-dismiss. */
const installToastRecorder = (session) => session.evaluate(`(() => {
  window.__toasts = window.__toasts || [];
  if (window.__toastObserver) return 'already recording';
  const seen = new Set();
  const sweep = () => {
    for (const el of document.querySelectorAll('[role="status"], [role="alert"], li[data-state]')) {
      const text = (el.innerText || '').trim();
      if (text && !seen.has(text)) { seen.add(text); window.__toasts.push(text); }
    }
  };
  window.__toastObserver = new MutationObserver(sweep);
  window.__toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  window.__toastSweep = setInterval(sweep, 150);
  return 'recording';
})()`);
const toasts = (session) => session.evaluate(`window.__toasts || []`);

const clickRecover = (session) => session.evaluate(
  `(() => { const b=[...document.querySelectorAll('button')].find(x=>/Recover draft/.test(x.innerText||'')); if (b) b.click(); return !!b; })()`,
);
const designCount = (session) => session.evaluate(
  `(() => { const m = document.body.innerText.match(/(\\d+)\\s+design/i); return m ? Number(m[1]) : null; })()`,
);

async function waitForBannerGone(session) {
  for (let i = 0; i < 40 && (await bannerVisible(session)); i++) await sleep(400);
}

async function waitFor(session, label, predicate, timeoutMs = 20000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await readDraft(session);
    if (predicate(last)) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label} — last read: ${brief(last)}`);
}

const brief = (d) => JSON.stringify({ ...d, keys: undefined });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  let version;
  for (let i = 0; i < 80 && !version; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(250); }
  }
  if (!version) throw new Error('Chrome never opened its debugging port');
  browser = await attach(version.webSocketDebuggerUrl, 'browser', { page: false });

  // ------------------------------------------------------------------ TASK 1
  console.log('\nTASK 1 — mismatched schema versions are handled asymmetrically');
  let tab = await openTab('A');
  await wipeStores(tab);

  console.log('  ', await plantDraft(tab, 1));
  const plantedV1 = await readDraft(tab);
  check('planted older-schema record is on disk with its blobs', plantedV1.exists && plantedV1.files === 2, brief(plantedV1));
  await closeTab(tab);
  tab = await openTab('A');
  const afterV1 = await waitFor(tab, 'obsolete record purge', (d) => !d.exists);
  check('an older-schema draft is deleted', !afterV1.exists, brief(afterV1));
  check('its blobs are reclaimed, orphans included', afterV1.files === 0, `files=${afterV1.files} keys=${JSON.stringify(afterV1.keys)}`);
  check('no recovery banner for an older-schema draft', (await bannerVisible(tab)) === false);

  console.log('  ', await plantDraft(tab, 99));
  await closeTab(tab);
  tab = await openTab('A');
  await sleep(3000);
  const afterNewer = await readDraft(tab);
  check(
    'a newer-schema draft is kept, blobs intact',
    afterNewer.exists && afterNewer.schemaVersion === 99 && afterNewer.files === 2,
    brief(afterNewer),
  );
  check('a newer-schema draft is still not offered', (await bannerVisible(tab)) === false);

  // ------------------------------------------------------------------ TASK 2
  console.log('\nTASK 2 — vector sources live in the file store, not the record');
  await wipeStores(tab);
  await closeTab(tab);
  tab = await openTab('A');
  console.log('  ', await uploadSvg(tab));
  const vectorDraft = await waitFor(tab, 'draft holding the vector design', (d) => d.exists && d.designs >= 1, 30000);
  check('vector upload produced a draft', vectorDraft.designs >= 1, brief(vectorDraft));
  check(
    'the draft record carries no inline vector bytes',
    vectorDraft.inlineVectorBytes === false,
    `inlineVectorBytes=${vectorDraft.inlineVectorBytes}`,
  );
  check(
    'the record stays small, so boot does not deserialise the source',
    vectorDraft.recordBytes < 20000,
    `recordBytes=${vectorDraft.recordBytes}`,
  );
  check(
    'the record points at a file-store key for the source',
    vectorDraft.vectorKeys.length === 1,
    JSON.stringify(vectorDraft.vectorKeys),
  );
  const sourceRecord = vectorDraft.vectorKeys.length
    ? await readFileRecord(tab, vectorDraft.vectorKeys[0])
    : null;
  check(
    'the source blob round-tripped into the file store',
    !!sourceRecord && sourceRecord.size > 50000 && sourceRecord.head.includes('svg'),
    sourceRecord ? `${sourceRecord.type} ${sourceRecord.size}B` : 'missing',
  );
  check(
    'preview blob and source blob are separate records',
    vectorDraft.files === vectorDraft.designs + vectorDraft.vectorKeys.length,
    `files=${vectorDraft.files} designs=${vectorDraft.designs} vectorKeys=${vectorDraft.vectorKeys.length}`,
  );

  // Restore has to reunite them, and the reconciliation pass must not sweep the
  // source away on the next save just because it is not a `fileKey`.
  await closeTab(tab);
  tab = await openTab('A');
  check('vector draft is offered on the next visit', (await bannerVisible(tab)) === true);
  check('recover button present', (await clickRecover(tab)) === true);
  await waitForBannerGone(tab);
  const restoredVector = await waitFor(tab, 'vector draft re-saved after restore', (d) => d.exists && d.designs >= 1);
  check('vector design came back', (await designCount(tab)) !== 0, `designCount=${await designCount(tab)}`);
  check(
    'the source survives the save that follows a restore',
    restoredVector.vectorKeys.length === 1 && restoredVector.files === 2,
    `files=${restoredVector.files} vectorKeys=${JSON.stringify(restoredVector.vectorKeys)}`,
  );

  // ------------------------------------------------------------------ TASK 4
  console.log('\nTASK 4 — a draft built for another product is hidden, not destroyed');
  await wipeStores(tab);
  await closeTab(tab);
  tab = await openTab('A');
  await upload(tab, 1);
  const ownProfile = await waitFor(tab, 'draft to save', (d) => d.exists && d.designs === 1);
  check(
    'the draft records which product it was built for',
    typeof ownProfile.profileId === 'string' && ownProfile.profileId.length > 0,
    `profileId=${ownProfile.profileId}`,
  );
  console.log('  ', await patchDraft(tab, `d => { d.profileId = 'some-other-product'; }`));
  await closeTab(tab);
  tab = await openTab('A');
  await sleep(2500);
  check('a foreign-product draft is not offered', (await bannerVisible(tab)) === false);
  const foreignKept = await readDraft(tab);
  check(
    'a foreign-product draft is kept on disk with its blobs',
    foreignKept.exists && foreignKept.profileId === 'some-other-product' && foreignKept.files >= 1,
    brief(foreignKept),
  );
  // Restoring the matching product must still work, i.e. the check is on the
  // profile and not simply "never offer anything".
  console.log('  ', await patchDraft(tab, `d => { d.profileId = ${JSON.stringify(ownProfile.profileId)}; }`));
  await closeTab(tab);
  tab = await openTab('A');
  check('the same draft is offered again once the product matches', (await bannerVisible(tab)) === true);

  // ------------------------------------------------------------------ TASK 5
  console.log('\nTASK 5 — a design recovered below print resolution is reported');
  await wipeStores(tab);
  await closeTab(tab);
  tab = await openTab('A');
  await upload(tab, 1);
  await waitFor(tab, 'draft to save', (d) => d.exists && d.designs === 1);
  // Shape of a server-prepared upload after this change: the record's inches and
  // DPI describe the >40 MP original, while the persisted blob is the smaller
  // preview. Scaling `dpi` up reproduces exactly that mismatch.
  console.log('  ', await patchDraft(tab, `d => { d.designs.forEach(x => { x.dpi = x.dpi * 8; }); }`));
  await closeTab(tab);
  tab = await openTab('A');
  await installToastRecorder(tab);
  check('reduced-quality draft is still offered', (await bannerVisible(tab)) === true);
  await clickRecover(tab);
  await waitForBannerGone(tab);
  await sleep(1500);
  const recoveryToasts = await toasts(tab);
  check(
    'recovery warns that print quality was reduced',
    recoveryToasts.some((x) => /lower print quality|lower resolution/i.test(x)),
    JSON.stringify(recoveryToasts).slice(0, 200),
  );
  check('the design is still restored, not dropped', (await designCount(tab)) !== 0, `designCount=${await designCount(tab)}`);

  // A design whose blob matches its claimed source must NOT warn, or the
  // notification is worthless noise on every recovery.
  await wipeStores(tab);
  await closeTab(tab);
  tab = await openTab('A');
  await upload(tab, 1);
  await waitFor(tab, 'draft to save', (d) => d.exists && d.designs === 1);
  await closeTab(tab);
  tab = await openTab('A');
  await installToastRecorder(tab);
  await clickRecover(tab);
  await waitForBannerGone(tab);
  await sleep(1500);
  const cleanToasts = await toasts(tab);
  check(
    'an undamaged recovery does not warn',
    !cleanToasts.some((x) => /lower print quality|lower resolution/i.test(x)),
    JSON.stringify(cleanToasts).slice(0, 200),
  );
  await wipeStores(tab);
  await closeTab(tab);

  // ------------------------------------------------------------------ TASK 3
  console.log('\nTASK 3 — one tab owns saving');
  const tabA = await openTab('A');
  const ownA = await ownership(tabA);
  check('the only tab open owns saving', ownA?.isOwner === true && ownA?.settled === true, JSON.stringify(ownA));
  check('BroadcastChannel is available in this browser', ownA?.supported === true);

  await upload(tabA, 2);
  const twoDesigns = await waitFor(tabA, 'tab A draft', (d) => d.exists && d.designs === 2, 30000);
  check('tab A saved its sheet', twoDesigns.designs === 2 && twoDesigns.files === 2, brief(twoDesigns));

  const tabB = await openTab('B');
  const ownB = await ownership(tabB);
  check('a second tab does not take ownership', ownB?.isOwner === false && ownB?.settled === true, JSON.stringify(ownB));
  check('tab A keeps ownership when a second tab opens', (await ownership(tabA))?.isOwner === true);
  check("the second tab does not offer another tab's live draft", (await bannerVisible(tabB)) === false);

  // The reproduced data loss: tab B starting a fresh upload used to clear the
  // whole shared file store, leaving tab A writing `fileKey`s that pointed at
  // nothing and restore recovering zero designs.
  await installToastRecorder(tabB);
  await upload(tabB, 1);
  await sleep(7000);
  const afterTabBUpload = await readDraft(tabA);
  check("tab B uploading does not clear tab A's blobs", afterTabBUpload.files === 2, `files=${afterTabBUpload.files}`);
  check(
    "tab B uploading does not overwrite tab A's record",
    afterTabBUpload.exists && afterTabBUpload.designs === 2,
    brief(afterTabBUpload),
  );
  const tabBToasts = await toasts(tabB);
  check(
    'tab B tells the customer it is not saving',
    tabBToasts.some((x) => /Not saving work in this tab/i.test(x)),
    JSON.stringify(tabBToasts).slice(0, 200),
  );

  // Ownership must not have cost the owner anything.
  await upload(tabA, 1);
  const tabAStillSaving = await waitFor(tabA, 'tab A third design', (d) => d.exists && d.designs === 3, 30000);
  check('the owner keeps saving normally', tabAStillSaving.designs === 3, brief(tabAStillSaving));

  // The whole point: restore now recovers the sheet instead of nothing.
  await closeTab(tabB);
  await closeTab(tabA);
  const tabC = await openTab('C');
  await installToastRecorder(tabC);
  check('the sheet is offered after the two-tab session', (await bannerVisible(tabC)) === true);
  await clickRecover(tabC);
  await waitForBannerGone(tabC);
  await sleep(2000);
  const recovered = await designCount(tabC);
  const recoveredToasts = await toasts(tabC);
  check('restore recovers the designs rather than zero of them', recovered === 3, `designCount=${recovered}`);
  check(
    'no missing-artwork warning after a two-tab session',
    !recoveredToasts.some((x) => /missing artwork|could not recover/i.test(x)),
    JSON.stringify(recoveredToasts).slice(0, 200),
  );

  // Killed owner: no release message, so only the lease timeout can free it. A
  // durable lock would leave every future tab silently not saving from here on.
  const tabD = await openTab('D');
  check('tab D is a non-owner while tab C owns', (await ownership(tabD))?.isOwner === false);
  console.log('  ', await tabC.evaluate(`window.__draftOwnershipKill()`));
  const killStart = Date.now();
  let promoted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    if ((await ownership(tabD))?.isOwner === true) { promoted = true; break; }
  }
  check(
    'a killed owner does not wedge saving — the next tab takes over',
    promoted,
    `${Date.now() - killStart}ms ${JSON.stringify(await ownership(tabD))}`,
  );
  const beforeTabDSave = await readDraft(tabD);
  await upload(tabD, 1);
  const tabDSaved = await waitFor(
    tabD,
    'the promoted tab to save',
    (d) => d.exists && d.savedAt > (beforeTabDSave.savedAt ?? 0),
    30000,
  );
  check('the promoted tab actually writes', tabDSaved.savedAt > (beforeTabDSave.savedAt ?? 0), brief(tabDSaved));
  await closeTab(tabC);
  await closeTab(tabD);

  // Owner closing cleanly: the release broadcast should hand over without
  // waiting out the lease timeout.
  const tabE = await openTab('E');
  await wipeStores(tabE);
  const tabF = await openTab('F');
  check('tab F stands down behind tab E', (await ownership(tabF))?.isOwner === false);
  // `pagehide` is what the release is bound to; dispatching it and then closing
  // the tab is the same sequence a real close produces, without depending on how
  // CDP tears a target down.
  await tabE.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`);
  const handoverStart = Date.now();
  let handedOver = false;
  for (let i = 0; i < 20; i++) {
    if ((await ownership(tabF))?.isOwner === true) { handedOver = true; break; }
    await sleep(200);
  }
  const handoverMs = Date.now() - handoverStart;
  check(
    'a closing owner hands over without waiting out the lease',
    handedOver && handoverMs < 3000,
    `${handoverMs}ms (lease timeout is 5500ms)`,
  );
  await closeTab(tabE);
  await upload(tabF, 1);
  const tabFSaved = await waitFor(tabF, 'tab F to save after handover', (d) => d.exists && d.designs >= 1, 30000);
  check('the tab that took over saves', tabFSaved.designs >= 1, brief(tabFSaved));
  await wipeStores(tabF);
  await closeTab(tabF);

  // No BroadcastChannel: coordination is impossible, so the tab must behave
  // exactly as it did before any of this existed rather than stop saving.
  const tabG = await openTab('G', { withoutBroadcastChannel: true });
  const ownG = await ownership(tabG);
  check(
    'without BroadcastChannel a tab assumes ownership',
    ownG?.supported === false && ownG?.isOwner === true && ownG?.settled === true,
    JSON.stringify(ownG),
  );
  await upload(tabG, 1);
  const tabGSaved = await waitFor(tabG, 'draft without BroadcastChannel', (d) => d.exists && d.designs >= 1, 30000);
  check('saving still works without BroadcastChannel', tabGSaved.designs >= 1, brief(tabGSaved));
  await closeTab(tabG);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log('failed:', failed.map((f) => f.name).join(' | '));
}

main().catch((e) => console.error('HARNESS FAILED', e)).finally(async () => {
  await sleep(300);
  chrome.kill();
  process.exit(0);
});
