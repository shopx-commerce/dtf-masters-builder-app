/**
 * Screen Wake Lock helper for long-running uploads.
 *
 * iOS suspends Safari's network process when the screen locks, killing
 * in-flight uploads (WebKit has acknowledged transfers dying this way for
 * years — there is no Background Fetch on iOS to fall back to). Holding a
 * screen wake lock while bytes are moving keeps the phone awake and the
 * transfer alive. Supported on iOS Safari 16.4+, Chrome 85+; everywhere
 * else this module is a silent no-op.
 *
 * Usage:
 *   const release = await holdScreenAwake();
 *   try { ...upload... } finally { release(); }
 *
 * Holds are reference-counted so overlapping uploads share one sentinel.
 * The lock auto-releases when the tab is hidden (platform behavior); a
 * visibilitychange listener re-acquires it when the customer returns while
 * work is still in progress.
 */

type WakeLockSentinelLike = {
  release: () => Promise<void>;
  addEventListener?: (type: string, cb: () => void) => void;
};

let sentinel: WakeLockSentinelLike | null = null;
let holdCount = 0;
let listenerInstalled = false;
/** Serializes wakeLock.request() — concurrent acquires share one attempt. */
let acquiring: Promise<void> | null = null;

function acquire(): Promise<void> {
  if (acquiring) return acquiring;
  const run = async (): Promise<void> => {
    try {
      const wakeLock = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<WakeLockSentinelLike> } }).wakeLock;
      if (!wakeLock || typeof wakeLock.request !== "function") return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      if (sentinel) return;
      const s = await wakeLock.request("screen");
      // Platform releases the sentinel on tab hide / screen events; drop our
      // reference so the visibility handler knows to request a fresh one.
      s.addEventListener?.("release", () => {
        if (sentinel === s) sentinel = null;
      });
      // The last hold may have been released while the request was in
      // flight — keeping this sentinel would pin the screen awake with
      // nobody left to release it.
      if (holdCount === 0) {
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
    } catch {
      // Best-effort only: low battery, permissions policy, or unsupported
      // browser. The upload proceeds either way.
    }
  };
  acquiring = run().finally(() => {
    acquiring = null;
  });
  return acquiring;
}

function installVisibilityListener(): void {
  if (listenerInstalled || typeof document === "undefined") return;
  listenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && holdCount > 0 && !sentinel) {
      void acquire();
    }
  });
}

/**
 * Ask the device to stay awake until the returned release fn is called.
 * Never throws; the release fn is idempotent.
 */
export async function holdScreenAwake(): Promise<() => void> {
  installVisibilityListener();
  holdCount++;
  if (holdCount === 1) await acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount = Math.max(0, holdCount - 1);
    if (holdCount === 0 && sentinel) {
      const s = sentinel;
      sentinel = null;
      void s.release().catch(() => {});
    }
  };
}
