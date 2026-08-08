/**
 * Trust checks for `window` `message` events sent by the storefront shell.
 *
 * The builder runs in an iframe on a Shopify storefront page and takes
 * instructions from the surrounding shell over `postMessage`. `postMessage` is
 * addressed to a *window*, not to a script, so every frame, popup and opener
 * that can reach this window can deliver a message that looks identical to the
 * shell's. Nothing below can defend against a shell that has itself been
 * compromised — it already receives the artwork we post to it — but it does
 * shut out every *other* window on a storefront page, which on Shopify means
 * third-party app embeds, ad/analytics iframes and anything opened via
 * `window.open`.
 *
 * What can actually be verified about the sender:
 *  - `event.source` is set by the browser and cannot be forged, so requiring it
 *    to be `window.parent` is reliable everywhere.
 *  - `event.origin` is also set by the browser, but knowing which origin to
 *    *expect* is the hard part. `location.ancestorOrigins` is authoritative and
 *    unspoofable — but Chromium/WebKit only. `document.referrer` is the only
 *    cross-browser alternative and it is advisory at best: a storefront serving
 *    `Referrer-Policy: no-referrer` blanks it entirely.
 *  - So the origin check is enforced strictly only where it can be trusted
 *    (`authoritative`). Where it cannot, the sender check stands alone and the
 *    situation is logged once, because rejecting on a guess would silently kill
 *    add-to-cart. No build ever accepts a message from a window other than the
 *    parent.
 *
 * Because that last case exists, the origin check is a hardening layer and not
 * the primary defence. The primary defences are the correlation token in
 * `cart-submit-token.ts` (for the destructive draft clear) and
 * `sanitizeShellUploadUrl` below (for artwork upload destinations).
 */

const IS_DEV = Boolean(import.meta.env.DEV);

/** Log each distinct rejection reason once — a message storm must not flood the console. */
const warned = new Set<string>();
function warnOnce(key: string, ...detail: unknown[]): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[shell-message] ${key}`, ...detail);
}

function toOrigin(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

type ShellOriginContext = {
  selfOrigin: string;
  framed: boolean;
  /** Origins a shell message may legitimately come from. */
  allowed: ReadonlySet<string>;
  /** Which signals produced `allowed` beyond our own origin. */
  evidence: readonly string[];
  /**
   * True when `location.ancestorOrigins` named the embedders. That list is
   * browser-maintained and unspoofable, so a mismatch against it is a real
   * mismatch and rejecting is safe. `document.referrer` is only advisory: it can
   * be blanked or trimmed by the storefront's Referrer-Policy, so a mismatch
   * against it alone is more likely to be our own ignorance than an attack.
   */
  authoritative: boolean;
  /** The immediate parent's origin, when a browser-provided signal named it. */
  parentOrigin: string | null;
  /** The outermost ancestor's origin. Nested embed: parent is the app-proxy shell, top is the storefront. */
  topOrigin: string | null;
};

let context: ShellOriginContext | null = null;

/**
 * Resolved once and then frozen. Re-deriving per message would let anything that
 * can influence `document.referrer` (a same-document navigation, say) widen the
 * allow-list after the fact.
 */
export function getShellOriginContext(): ShellOriginContext {
  if (context) return context;
  const selfOrigin = window.location.origin;
  const allowed = new Set<string>([selfOrigin]);
  const evidence: string[] = [];
  let framed = false;
  try {
    framed = window.parent !== window;
  } catch {
    framed = true;
  }
  let parentOrigin: string | null = null;
  let topOrigin: string | null = null;
  let authoritative = false;

  if (framed) {
    try {
      const ancestors = window.location.ancestorOrigins;
      if (ancestors && ancestors.length > 0) {
        for (let i = 0; i < ancestors.length; i++) {
          const origin = toOrigin(ancestors[i]);
          if (!origin) continue;
          allowed.add(origin);
          if (i === 0) parentOrigin = origin;
          topOrigin = origin;
        }
        if (parentOrigin) {
          evidence.push("ancestorOrigins");
          authoritative = true;
        }
      }
    } catch {
      /* not implemented in this browser */
    }
    const referrerOrigin = toOrigin(document.referrer);
    if (referrerOrigin) {
      allowed.add(referrerOrigin);
      evidence.push("referrer");
    }
    if (!authoritative) {
      warnOnce(
        "parent origin is not authoritatively known (no location.ancestorOrigins); " +
          `sender identity is still enforced. evidence=${evidence.join("+") || "none"}`,
      );
    }
  }

  context = {
    selfOrigin,
    framed,
    allowed,
    evidence,
    authoritative,
    parentOrigin,
    topOrigin,
  };
  return context;
}

/**
 * The parent's origin as reported by the browser on a message that genuinely
 * came from `window.parent`. `event.source` cannot be forged and `event.origin`
 * is set by the browser, so this is a sound way to learn the embedder's origin
 * in browsers without `ancestorOrigins`. Used only to address our *outgoing*
 * messages; it never widens the inbound allow-list.
 */
let observedParentOrigin: string | null = null;

/**
 * True when `event` may be treated as coming from the storefront shell.
 *
 * `label` only names the listener in the log line.
 */
export function isTrustedShellMessage(event: MessageEvent, label: string): boolean {
  const ctx = getShellOriginContext();

  // Same-window, same-origin dispatch. `event.source` is assigned by the
  // browser, so this can only be code already executing in this document —
  // which is how the standalone /test-builder page and the verification
  // harnesses in scripts/ and tmp-verify/ drive these flows. It grants nothing
  // that a script in our own document does not already have, so it is not a
  // dev-only bypass; it is still pinned to our own origin so no embedder can
  // reach it.
  if (event.source === window && event.origin === ctx.selfOrigin) return true;

  let parent: Window | null = null;
  try {
    parent = window.parent;
  } catch {
    parent = null;
  }
  if (!parent || event.source !== parent) {
    warnOnce(
      `${label}: rejected a message from a window that is not the embedding parent`,
      { origin: event.origin },
    );
    return false;
  }

  if (ctx.allowed.has(event.origin)) {
    if (!observedParentOrigin && typeof event.origin === "string") {
      observedParentOrigin = toOrigin(event.origin);
    }
    return true;
  }

  if (!ctx.authoritative) {
    // The expected origin is not authoritatively known, so a mismatch here is
    // more likely to be a blanked Referrer-Policy than an attack. Rejecting
    // would silently kill add-to-cart in browsers without `ancestorOrigins`,
    // which is a worse outcome than trusting the parent alone: the sender check
    // above already excludes every sibling frame, popup and opener, and the
    // correlation token still gates the destructive action.
    warnOnce(
      `${label}: trusting the parent without an authoritative origin (${event.origin})`,
    );
    if (!observedParentOrigin && typeof event.origin === "string") {
      observedParentOrigin = toOrigin(event.origin);
    }
    return true;
  }

  warnOnce(
    `${label}: rejected a shell message from an unexpected origin`,
    { got: event.origin, expected: Array.from(ctx.allowed), via: ctx.evidence },
  );
  return false;
}

/**
 * Target origin for our own outgoing `postMessage` calls.
 *
 * `'*'` lets the message be read by whatever happens to occupy the parent slot
 * at delivery time, which for the add-to-cart payload is the customer's
 * full-resolution artwork. Pinning it whenever the parent origin has been
 * *confirmed* closes that. `'*'` remains the last resort rather than a guess,
 * because a wrong target origin makes the browser drop the message with no
 * error and add-to-cart would simply stop working.
 */
export function resolveShellTargetOrigin(): string {
  const ctx = getShellOriginContext();
  if (!ctx.framed) return ctx.selfOrigin;
  if (ctx.authoritative && ctx.parentOrigin) return ctx.parentOrigin;
  // Second best: the origin the browser reported on a message that really came
  // from the parent. Deliberately *not* the referrer — a stale or trimmed
  // referrer would make the browser drop our message with no error at all, and
  // a dropped add-to-cart is worse than a message the parent could already read.
  if (observedParentOrigin) return observedParentOrigin;
  warnOnce("outgoing messages fall back to targetOrigin '*' (parent origin not confirmed)");
  return "*";
}

/** As `resolveShellTargetOrigin`, for messages addressed to `window.top`. */
export function resolveShellTopTargetOrigin(): string {
  const ctx = getShellOriginContext();
  if (!ctx.framed) return ctx.selfOrigin;
  if (ctx.authoritative && ctx.topOrigin) return ctx.topOrigin;
  warnOnce("outgoing top-frame messages fall back to targetOrigin '*' (top origin not confirmed)");
  return "*";
}

/**
 * Extra hosts allowed to receive production artwork uploads.
 *
 * ===================================================================
 * THIS IS THE ONLY PLACE TO ADD AN UPLOAD HOST. Entries are bare
 * hostnames, lower-case, no scheme and no port, e.g. "uploads.example.com".
 * ===================================================================
 *
 * Everything else is derived at runtime (see `isAllowedUploadHost`): this app's
 * own origin, the configured R2 public base URL, Cloudflare R2's own domains,
 * the verified embedding origin, and the `shop` the builder was opened for.
 */
const EXTRA_ALLOWED_UPLOAD_HOSTS: readonly string[] = [];

function shopParamHost(): string | null {
  try {
    const shop = new URLSearchParams(window.location.search).get("shop");
    const host = String(shop ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function configuredR2Host(): string | null {
  // `import.meta.env` must appear literally: Vite only substitutes the plain
  // member expression, so `import.meta?.env?.X` reads as undefined in a
  // production build and the configured host would never be allow-listed.
  const base = String(
    (import.meta.env as Record<string, string | undefined>)?.VITE_R2_PUBLIC_BASE_URL ?? "",
  ).trim();
  if (!base) return null;
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalhostHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/**
 * Mirrors the server's `isAllowedR2PublicHost` in server/lib/safe-external-url.ts
 * so both ends agree on what counts as our storage.
 */
function isAllowedUploadHost(host: string): boolean {
  const h = host.toLowerCase();
  if (!h) return false;
  if (h === window.location.hostname.toLowerCase()) return true;
  if (h.endsWith(".r2.dev") || h.includes(".r2.cloudflarestorage.com")) return true;
  if (h === configuredR2Host()) return true;
  if (h === shopParamHost()) return true;
  // The shell's upload endpoint is a Shopify app-proxy path on the storefront
  // that embeds us, so the verified embedding origin is a legitimate target.
  // A hostile *embedder* is out of scope here: it already receives the artwork
  // through the add-to-cart message it asked for.
  for (const origin of getShellOriginContext().allowed) {
    try {
      if (new URL(origin).hostname.toLowerCase() === h) return true;
    } catch {
      /* skip unparseable entry */
    }
  }
  return EXTRA_ALLOWED_UPLOAD_HOSTS.includes(h);
}

/**
 * Validate a shell-supplied artwork upload endpoint before anything is sent to it.
 *
 * Returns the normalized absolute URL, or `null` if it must not be used —
 * in which case the caller falls back to the shell relay, which posts to the
 * parent instead of fetching an attacker-named host.
 */
export function sanitizeShellUploadUrl(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  let url: URL;
  try {
    url = new URL(s, window.location.href);
  } catch {
    warnOnce("rejected an unparseable uploadUrl", s.slice(0, 120));
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    // Plain HTTP would expose the artwork on the wire; only the local dev
    // server is exempt, and only in a dev build.
    if (!(url.protocol === "http:" && IS_DEV && isLocalhostHost(host))) {
      warnOnce("rejected a non-https uploadUrl", { url: s.slice(0, 120) });
      return null;
    }
  }
  if (!isAllowedUploadHost(host)) {
    warnOnce("rejected an uploadUrl pointing at a host that is not allowed", {
      host,
      url: s.slice(0, 120),
    });
    return null;
  }
  return url.toString();
}

/**
 * Narrowest and widest viewport a shell may credibly claim, in CSS pixels.
 *
 * The floor is below every phone ever shipped and the ceiling is above every
 * display; the point is not to guess a real device but to keep an absurd value
 * out of a layout calculation. `Number.isFinite` is what actually excludes
 * `NaN` and `Infinity`.
 */
const MIN_SHELL_VIEWPORT_WIDTH = 240;
const MAX_SHELL_VIEWPORT_WIDTH = 8192;

/**
 * Validate a shell-supplied viewport width before it is allowed to influence
 * the layout. Returns the rounded width, or `null` if it must be ignored — in
 * which case the caller falls back to this frame's own `window.innerWidth`.
 *
 * Strictly a number: a numeric *string* is rejected rather than coerced, so a
 * buggy shell posting `"820px"` degrades to the current behaviour instead of
 * producing `NaN` somewhere further down.
 *
 * This is only the value check. The caller is responsible for bounding how far
 * the claim may move the layout — see `use-layout-viewport.ts`, which will only
 * ever let a shell widen this frame's own measurement, and never past the
 * device's screen.
 */
export function sanitizeShellViewportWidth(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warnOnce("rejected a shell viewportWidth that is not a finite number", {
      type: typeof raw,
    });
    return null;
  }
  const width = Math.round(raw);
  if (width < MIN_SHELL_VIEWPORT_WIDTH || width > MAX_SHELL_VIEWPORT_WIDTH) {
    warnOnce("rejected an out-of-range shell viewportWidth", { width });
    return null;
  }
  return width;
}
