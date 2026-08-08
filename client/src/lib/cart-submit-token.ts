/**
 * Correlation tokens for the add-to-cart round trip.
 *
 * `dtf-builder-cart-status: done` is what tells the builder the customer's
 * gangsheet reached the cart, and acting on it deletes their draft — the only
 * copy of unsent work. Trusting the message's mere arrival means anything that
 * can post to this window can destroy that draft, and even the genuine shell can
 * send `done` before the upload is durable.
 *
 * So a status is only honoured when it belongs to a submit this tab actually
 * made. The id is minted here, travels out with `dtf-builder-add-to-cart` /
 * `dtf-builder-save-design` as `requestId`, and comes back on the status — the
 * same request-correlation pattern `lib/r2-direct-upload.ts` already uses for
 * its shell relay.
 *
 * SHELL-SIDE REQUIREMENT: the storefront shell must echo `requestId` back on
 * `dtf-builder-cart-status`. Until it does, a status with no `requestId` is
 * accepted only while a submit from this tab is genuinely outstanding — which
 * already blocks the spontaneous and replayed cases — and each occurrence is
 * logged once.
 */

/** How long a settled submit stays valid, so every listener sees the same status. */
const SETTLED_GRACE_MS = 5_000;
/** Ceiling on an outstanding submit, matched to the add-to-cart stall watchdog. */
const MAX_OUTSTANDING_MS = 30 * 60_000;
const MAX_TRACKED = 4;

type CartSubmit = {
  id: string;
  postedAt: number;
  settledAt: number | null;
};

const submits: CartSubmit[] = [];
const warned = new Set<string>();

function warnOnce(key: string, ...detail: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[cart-submit] ${key}`, ...detail);
}

function prune(now = Date.now()): void {
  for (let i = submits.length - 1; i >= 0; i--) {
    const s = submits[i];
    const expired = s.settledAt !== null
      ? now - s.settledAt > SETTLED_GRACE_MS
      : now - s.postedAt > MAX_OUTSTANDING_MS;
    if (expired) submits.splice(i, 1);
  }
}

/** Mint the id for a submit that is about to be posted to the shell. */
export function mintCartSubmitId(): string {
  prune();
  const id = `atc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  submits.push({ id, postedAt: Date.now(), settledAt: null });
  while (submits.length > MAX_TRACKED) submits.shift();
  return id;
}

/** Forget a submit that never made it out (export threw, postMessage failed). */
export function discardCartSubmitId(id: string): void {
  const i = submits.findIndex((s) => s.id === id);
  if (i >= 0) submits.splice(i, 1);
}

/**
 * True when a `dtf-builder-cart-status` belongs to a submit this tab made.
 *
 * A terminal status (`done` / `error`) settles the submit, after which it stays
 * valid for `SETTLED_GRACE_MS` — long enough for every listener handling the
 * same event, short enough that a captured message cannot be replayed later
 * against whatever the customer has built since.
 */
export function isTrustedCartStatus(requestId: unknown, status: unknown): boolean {
  prune();
  const id = typeof requestId === "string" ? requestId.trim() : "";
  const record = id
    ? submits.find((s) => s.id === id)
    : (submits.find((s) => s.settledAt === null) ?? submits[submits.length - 1]);

  if (!record) {
    warnOnce(
      "ignored a cart-status with no matching outstanding submit",
      { requestId: id || null, status },
    );
    return false;
  }
  if (!id) {
    warnOnce(
      "cart-status arrived without a requestId; falling back to 'a submit is outstanding'. " +
        "Update the storefront shell to echo requestId.",
    );
  }
  if ((status === "done" || status === "error") && record.settledAt === null) {
    record.settledAt = Date.now();
  }
  return true;
}

// Dev-only hook: the verification harnesses (scripts/verify-draft-policies.mjs
// and tmp-verify/) simulate the shell's reply, which now needs a real token.
// Stripped from production builds by the DEV guard.
// `import.meta.env` must appear literally — Vite only substitutes the plain
// member expression, and `import.meta?.env` silently evaluates to undefined.
if (import.meta.env?.DEV) {
  (window as unknown as Record<string, unknown>).__dtfMintCartSubmitId = mintCartSubmitId;
  (window as unknown as Record<string, unknown>).__dtfCartSubmits = () =>
    submits.map((s) => ({ ...s }));
}
