---
name: Upload relay fallback
description: Why builder→store direct upload fetches need a relay fallback, and the rules for gating and timing that retry.
---

# Upload relay fallback

**Rule:** when the parent shell hands the builder a direct upload URL, a transport-layer failure of the builder→store prepare/complete fetch (CORS/network — never an HTTP status) must retry once through the parent postMessage relay instead of failing the order. Gate the retry on a dedicated sentinel error type thrown only by that fetch wrapper — never a blanket catch.

**Why:** a real customer's checkout died with "store upload relay did not accept the PNG (cross-origin)" while a working relay sat unused: providing an uploadUrl had explicitly disabled the relay, and the failure path never reconsidered. But retrying *every* failure is worse: HTTP 4xx/5xx and failed R2 part PUTs fail identically via relay (PUTs go direct to R2 either way), and a mid-`Promise.all` part failure retried whole would re-upload the sheet while first-attempt PUTs are still in flight — doubled bandwidth and orphaned multipart sessions.

**How to apply:**
- Browsers spell the same transport failure three ways: Chrome "Failed to fetch", Safari "Load failed", Firefox `/^NetworkError\b/`. Normalize all three into the sentinel.
- A parent frame's existence (`window.parent !== window`) does not prove it implements the relay protocol. The fallback's *prepare* handshake must use a short cap (~20s) so a handler-less shell surfaces the combined error promptly instead of the normal 180s relay timeout; once prepare answers, the parent speaks the protocol and *complete* keeps the generous timeout.
- The legacy `/api/upload-design` form-POST route is the *worst* primary path: it pushes the full file through the Shopify proxy, whose body limits/timeouts surface as 500 HTML pages on production-size sheets. Live storefront shells have been observed to hand out the legacy URL in their config message **while also** implementing the relay handlers — so a legacy uploadUrl must mean relay-first, with the legacy POST as fallback gated on prepare-phase failures only (prepare moves metadata, zero file bytes — rerouting is free; post-prepare failures must never re-send the sheet through the proxy).
- Surface both failures when the retry also dies (`direct: …; relay retry: …`) — phone users can't open a console, and the cart-model error wrapper preserves parenthesized detail.
- **General rule (bit three separate flows):** a blocked `fetch()` THROWS — it never returns a non-ok response — so any "try direct, fall back to proxy/relay" chain gated only on `.ok` has an unreachable fallback for the exact failure it exists for. Catch the throw and route it into the fallback. iOS Safari triggers this most (CORS-less cached `<img>` responses poison later `fetch()` of the same URL; app-switching kills in-flight sockets as "Load failed").
- Raw browser transport messages ("Failed to fetch", "Load failed") must never reach customer toasts — map typed transport errors to translated plain-language copy at the toast site.
