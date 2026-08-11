/**
 * Elects one tab to own draft saving.
 *
 * The problem
 * -----------
 * The draft record and the blob store behind it are a single shared resource
 * keyed `current`, so two builder tabs are two writers to one document. That is
 * not merely "last write wins": tab B starting a fresh upload clears the whole
 * file store, and tab A — which has no idea that happened — then writes a draft
 * whose `fileKey`s point at records that no longer exist. Restore recovers zero
 * designs and says nothing useful, because from its point of view the artwork
 * simply failed to reload.
 *
 * The scheme
 * ----------
 * Heartbeat lease over `BroadcastChannel`, with **no durable state anywhere**.
 * That is the central design choice: a lock written to `localStorage` or
 * IndexedDB outlives the tab that took it, so a tab killed by an OOM, a crash,
 * or a force-quit leaves a lock nobody can clear and every future tab silently
 * stops saving — strictly worse than the bug being fixed. A lease that exists
 * only as periodic messages from a live tab cannot outlive that tab.
 *
 *   - A new tab announces `claim` and waits `ELECTION_WINDOW_MS` for an
 *     incumbent to answer `owner`. Silence means there is no owner, so it takes
 *     ownership itself.
 *   - The owner re-announces `owner` every `HEARTBEAT_MS`. A non-owner that
 *     hears nothing for `OWNER_TIMEOUT_MS` re-runs the election. **This is the
 *     crashed-owner recovery**: no heartbeat, no lease, and the next tab takes
 *     over within a few seconds without anyone having to clean up after the
 *     dead one.
 *   - A closing owner broadcasts `release`, which makes every other tab
 *     re-elect immediately instead of waiting out the timeout. **This is the
 *     owner-closes handover.**
 *   - Simultaneous claims (two tabs opened together, or a handover racing a
 *     timeout) are resolved by a deterministic tie-break on `tabId`: lowest
 *     wins. Any tab that hears `owner` from a tab that beats it demotes itself.
 *     So a split brain converges to a single owner rather than persisting.
 *
 * Note that `release` deliberately does *not* demote the sender. `pagehide`
 * also fires when a page enters the back/forward cache and can be dispatched by
 * test harnesses against a page that then keeps running, and a tab that
 * demoted itself on a false alarm would sit there not saving while believing it
 * had handed over. Instead it keeps saving, and if another tab really did take
 * over in the meantime the tie-break settles which of them continues.
 *
 * Without `BroadcastChannel`
 * --------------------------
 * There is then no way to detect a second tab at all, so the tab declares
 * itself the owner and behaves exactly as it did before any of this existed.
 * Standing down instead would break persistence for every customer in that
 * browser to avoid a two-tab collision we cannot even observe.
 */

const CHANNEL_NAME = "dtf-builder-draft-owner";

/** How long a starting tab waits for an incumbent to answer before claiming. */
const ELECTION_WINDOW_MS = 250;
/** Owner re-announce interval. */
const HEARTBEAT_MS = 1500;
/**
 * Silence after which a non-owner assumes the owner is gone. Comfortably more
 * than two heartbeats, so an owner merely descheduled by a busy main thread or
 * a throttled background tab is not evicted while it is still writing.
 */
const OWNER_TIMEOUT_MS = 5500;

type OwnerMessage =
  | { type: "claim"; tabId: string }
  | { type: "owner"; tabId: string }
  | { type: "release"; tabId: string }
  /**
   * "I have just emptied the shared draft record and the whole blob store."
   *
   * Carried on this channel rather than a second one because the set of tabs
   * that need to hear it is exactly the set already listening here, and because
   * the sender is typically a tab that has *crashed* — the fewer objects it has
   * to construct on the way out, the better.
   */
  | { type: "purge"; tabId: string };

export interface DraftOwnershipState {
  /** Whether this tab may write to draft storage. */
  isOwner: boolean;
  /** False only during the initial election window, when it is not yet known. */
  settled: boolean;
  /** False when `BroadcastChannel` is missing, i.e. ownership is assumed. */
  supported: boolean;
}

function canUseBroadcastChannel(): boolean {
  return typeof window !== "undefined" && typeof window.BroadcastChannel === "function";
}

const tabId =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let state: DraftOwnershipState = canUseBroadcastChannel()
  ? { isOwner: false, settled: false, supported: true }
  : { isOwner: true, settled: true, supported: false };

const listeners = new Set<(next: DraftOwnershipState) => void>();
const settledWaiters = new Set<(isOwner: boolean) => void>();
const purgeListeners = new Set<() => void>();

let channel: BroadcastChannel | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let electionTimer: ReturnType<typeof setTimeout> | null = null;
let ownerWatchdog: ReturnType<typeof setInterval> | null = null;
let lastOwnerSeenAt = 0;
/** Tabs that answered during the current election window, this tab included. */
let contenders = new Set<string>();
let attachCount = 0;
let lifecycleBound = false;

function publish() {
  const snapshot = state;
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* a bad subscriber must not stall the rest */ }
  }
}

function settle(isOwner: boolean) {
  const changed = state.isOwner !== isOwner || !state.settled;
  state = { ...state, isOwner, settled: true };
  if (settledWaiters.size > 0) {
    const waiters = Array.from(settledWaiters);
    settledWaiters.clear();
    for (const waiter of waiters) waiter(isOwner);
  }
  if (changed) publish();
}

function post(message: OwnerMessage) {
  try { channel?.postMessage(message); } catch { /* channel closed mid-teardown */ }
}

/** Lowest id wins — arbitrary but identical in every tab, which is the point. */
function winnerOf(ids: Iterable<string>): string {
  let best: string | null = null;
  for (const id of ids) if (best === null || id < best) best = id;
  return best ?? tabId;
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  post({ type: "owner", tabId });
  heartbeatTimer = setInterval(() => post({ type: "owner", tabId }), HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function becomeOwner() {
  if (state.isOwner && state.settled) {
    startHeartbeat();
    return;
  }
  settle(true);
  startHeartbeat();
}

function standDown() {
  stopHeartbeat();
  settle(false);
}

/**
 * Announce and wait. Re-entrant: a re-election triggered by a release or a
 * lapsed heartbeat restarts the window rather than stacking timers.
 */
function runElection() {
  if (!channel) return;
  if (electionTimer) clearTimeout(electionTimer);
  contenders = new Set([tabId]);
  post({ type: "claim", tabId });
  electionTimer = setTimeout(() => {
    electionTimer = null;
    // An incumbent that answered `owner` during the window has already
    // demoted us; only decide from the contender set if we still could win.
    if (winnerOf(contenders) === tabId) becomeOwner();
    else standDown();
  }, ELECTION_WINDOW_MS);
}

function startOwnerWatchdog() {
  if (ownerWatchdog) return;
  ownerWatchdog = setInterval(() => {
    if (state.isOwner) return;
    if (electionTimer) return;
    if (lastOwnerSeenAt !== 0 && Date.now() - lastOwnerSeenAt < OWNER_TIMEOUT_MS) return;
    // Either we never heard an owner or the one we heard has gone quiet.
    runElection();
  }, HEARTBEAT_MS);
}

function onMessage(event: MessageEvent<OwnerMessage>) {
  const message = event.data;
  if (!message || typeof message !== "object" || message.tabId === tabId) return;

  if (message.type === "claim") {
    contenders.add(message.tabId);
    // Answer immediately so the newcomer does not have to wait out its window.
    if (state.isOwner) post({ type: "owner", tabId });
    return;
  }

  if (message.type === "owner") {
    lastOwnerSeenAt = Date.now();
    contenders.add(message.tabId);
    if (message.tabId < tabId) {
      // A tab that beats us on the tie-break is claiming ownership, so this is
      // either the incumbent answering our claim or a split brain resolving.
      if (electionTimer) { clearTimeout(electionTimer); electionTimer = null; }
      standDown();
    } else if (state.isOwner) {
      // We beat it; re-assert rather than yield so it demotes on our next beat.
      post({ type: "owner", tabId });
    }
    return;
  }

  if (message.type === "release") {
    lastOwnerSeenAt = 0;
    if (!state.isOwner) runElection();
    return;
  }

  if (message.type === "purge") {
    // Deliberately not ownership-scoped. Whoever sent this emptied the store
    // for *everyone*, so every tab needs to know — the owner most of all,
    // since its cached "already on disk" bookkeeping is now wrong.
    for (const listener of purgeListeners) {
      try { listener(); } catch { /* a bad subscriber must not stall the rest */ }
    }
  }
}

/**
 * Hand over without demoting — see the note at the top of the file on why a
 * `pagehide` that turns out not to be a teardown must not leave this tab
 * silently not saving.
 */
function announceRelease() {
  stopHeartbeat();
  if (state.isOwner) post({ type: "release", tabId });
}

function bindLifecycle() {
  if (lifecycleBound || typeof window === "undefined") return;
  lifecycleBound = true;
  window.addEventListener("pagehide", announceRelease);
  // A bfcache restore lands here with the heartbeat stopped, so re-announce.
  window.addEventListener("pageshow", () => {
    if (state.isOwner) startHeartbeat();
    else runElection();
  });
}

/**
 * Joins the election. Ref-counted so several consumers in one tab share one
 * lease; the returned disposer stops this tab's heartbeat and offers the lease
 * to any other tab, without asserting that this tab has stopped saving.
 */
export function acquireDraftOwnership(): () => void {
  attachCount += 1;
  if (attachCount === 1) {
    if (!canUseBroadcastChannel()) {
      settle(true);
    } else {
      try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = onMessage;
        bindLifecycle();
        startOwnerWatchdog();
        runElection();
      } catch {
        // Channel construction can fail in partitioned or sandboxed contexts.
        channel = null;
        state = { ...state, supported: false };
        settle(true);
      }
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    attachCount = Math.max(0, attachCount - 1);
    if (attachCount === 0) announceRelease();
  };
}

export function getDraftOwnership(): DraftOwnershipState {
  return state;
}

/** Cheap synchronous gate for imperative paths (unload flush, discard, clear). */
export function isDraftOwner(): boolean {
  return state.isOwner;
}

export function subscribeDraftOwnership(
  listener: (next: DraftOwnershipState) => void,
): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Told when another tab has emptied the draft record and the blob store, so this
 * tab can stop believing anything of its own is on disk.
 *
 * Subscribed regardless of ownership: a non-owner has nothing to re-save but may
 * be *offering* the record that has just been deleted, and a stale recovery
 * banner that recovers nothing is its own defect.
 */
export function subscribeDraftPurge(listener: () => void): () => void {
  purgeListeners.add(listener);
  return () => { purgeListeners.delete(listener); };
}

/**
 * Announce that this tab has just cleared the shared store.
 *
 * Sent even when this tab is not the owner, because the purge itself is allowed
 * regardless of ownership. Falls back to a one-shot channel because the caller
 * may be a tab whose editor has already been torn down by an error boundary, so
 * `acquireDraftOwnership`'s channel may never have been opened.
 */
export function broadcastDraftPurge(): void {
  if (channel) {
    post({ type: "purge", tabId });
    return;
  }
  if (!canUseBroadcastChannel()) return;
  try {
    const transient = new BroadcastChannel(CHANNEL_NAME);
    transient.postMessage({ type: "purge", tabId } satisfies OwnerMessage);
    // Delivery is queued against the receiving tabs and does not depend on this
    // end staying open, but closing is deferred a task anyway: the cost is
    // nothing and the caller is about to reload the page regardless.
    setTimeout(() => { try { transient.close(); } catch { /* already closed */ } }, 0);
  } catch {
    // Partitioned or sandboxed context — there is no channel to reach, which is
    // the same world in which there is no second tab to warn.
  }
}

/**
 * Resolves once the first election has decided. Destructive storage paths that
 * run on mount (the expiry purge, the recovery offer) should await this so they
 * cannot act on another tab's live record during the election window.
 */
export function whenDraftOwnershipSettled(): Promise<boolean> {
  if (state.settled) return Promise.resolve(state.isOwner);
  return new Promise<boolean>(resolve => { settledWaiters.add(resolve); });
}

/** Test seam: a harness needs to observe which tab won. */
export function draftOwnershipTabId(): string {
  return tabId;
}
