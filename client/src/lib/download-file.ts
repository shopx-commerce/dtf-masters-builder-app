/**
 * The one way this app hands a finished file to the customer.
 *
 * Saving a blob through an anchor looks like three lines, and every place that
 * wrote its own copy got at least one of the following wrong.
 *
 * The revoke is not cleanup — it is the deadline. `URL.revokeObjectURL` cuts
 * the browser off from the bytes it is still reading while it writes the file,
 * and nothing in the API signals that a download finished. Revoke too early and
 * the save fails, or silently truncates, *after* the sheet has already
 * rendered. A "Save as" dialog the customer leaves open, a SmartScreen check, a
 * OneDrive-synced destination, or simply a 200 MB gangsheet on a slow disk are
 * all routinely slower than the five seconds the old call sites allowed.
 *
 * The filename is not trusted. It is derived from an uploaded design name, so it
 * can contain anything the customer's filesystem allowed — `Logo 3/4" <final>`
 * is a perfectly ordinary name that Windows cannot write.
 *
 * The blob is not assumed to have data. A zero-byte save looks like success
 * until someone opens it, which for a print shop is after it has been sent to
 * the printer.
 */

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A filename every OS we ship to can actually write.
 *
 * Strips the characters Windows forbids and Unix finds awkward, collapses
 * whitespace, and removes leading/trailing dots and spaces — Windows silently
 * drops a trailing dot, which turns `sheet .png` into a file the customer
 * cannot find. Reserved device names (`CON`, `LPT1`) are suffixed rather than
 * replaced so the name still means something.
 *
 * The extension is preserved separately, because sanitising the whole string
 * would let a stray character eat the dot and produce a file the OS opens with
 * the wrong application.
 */
export function safeDownloadFileName(filename: string, fallbackBase = "gangsheet"): string {
  const raw = String(filename ?? "");
  const dot = raw.lastIndexOf(".");
  // An extension has to *look* like one. Measuring the distance from the end
  // instead would read the `.2 final` in `Logo v1.2 final` as an extension and
  // strip the space out of the middle of the name.
  const extension = dot > 0 && /^[a-z0-9]{1,8}$/i.test(raw.slice(dot + 1)) ? raw.slice(dot + 1) : "";
  const base = extension ? raw.slice(0, dot) : raw;
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "")
    // Leave room for the extension and for the browser's " (1)" de-duplication
    // suffix inside the ~255-byte limit every filesystem here shares.
    .slice(0, 120)
    // The slice can re-expose a trailing dot or space.
    .replace(/[.\s]+$/, "");
  const safeBase = WINDOWS_RESERVED_NAME.test(cleaned) ? `${cleaned}-sheet` : cleaned || fallbackBase;
  return extension ? `${safeBase}.${extension}` : safeBase;
}

/**
 * How long to keep the blob URL alive, scaled to the file.
 *
 * One second per megabyte, floored at a minute and capped at twenty. The floor
 * is what matters: it covers the dialogs and scanners that delay the *start* of
 * the write regardless of size. The previous rule here was
 * `Math.max(5000, size / 100000)`, which reads as "scales with size" but only
 * beats its own floor above 500 MB — so every real export got exactly five
 * seconds.
 *
 * Holding a URL longer costs nothing but the blob's storage, which the browser
 * can page to disk, and the listener below releases it on navigation anyway.
 */
function revokeDelayMs(bytes: number): number {
  const perMegabyte = Math.round(bytes / 1_000_000) * 1_000;
  return Math.min(20 * 60_000, Math.max(60_000, perMegabyte));
}

/**
 * Save `blob` to the customer's device as `filename`.
 *
 * Throws when there is nothing to save, so a failed render surfaces as an error
 * instead of a zero-byte file.
 */
export function triggerDownload(blob: Blob, filename: string, fallbackBase?: string): void {
  if (!blob || blob.size === 0) {
    throw new Error("The export finished without producing any image data. Please try again.");
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeDownloadFileName(filename, fallbackBase);
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  let revoked = false;
  const revoke = () => {
    if (revoked) return;
    revoked = true;
    window.removeEventListener("pagehide", onPageHide);
    URL.revokeObjectURL(url);
  };
  // Leaving the page ends the download anyway, so release then rather than
  // holding the bytes for a document that is gone. `persisted` means the page
  // went into the back/forward cache and may be restored, so it keeps its URL.
  const onPageHide = (event: PageTransitionEvent) => {
    if (!event.persisted) revoke();
  };
  window.addEventListener("pagehide", onPageHide);
  window.setTimeout(revoke, revokeDelayMs(blob.size));
}
