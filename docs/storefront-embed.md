# Embedding the builder in the storefront

The builder runs inside an iframe on the Shopify storefront. Everything awkward
in this document follows from one fact: **an iframe can only measure itself.**
Inside the frame, `window.innerWidth`, `window.innerHeight` and
`visualViewport` all describe the iframe's own box, not the customer's device.
The embedding page is the only party that can see the real thing, so it has to
say so.

Two of the fixes below do nothing at all until the theme is updated. They are
not degraded — they are inert.

## 1. Size the iframe to the visible viewport

**Required, and the most important item here.** Size the iframe to the height
the customer can actually see, and let the builder scroll internally. Do not
size it to its content.

The builder's shell is `100dvh` with `overflow: hidden`, which is meaningful
only when the frame is the height of the viewport. A tall, content-sized iframe
breaks three things at once:

- **Phones silently get the desktop layout.** The short-viewport guard that
  keeps a landscape phone on the two-panel layout reads height from the real
  `window`, which in a 1600px iframe reports 1600. The guard never fires. A
  landscape phone then renders the desktop column and the gangsheet canvas
  shrinks from 414×206 to roughly 186×93.
- **Nothing can rescue a field from behind the keyboard.** With a 1600px frame
  and a 221px keyboard, the visible bottom lands around y=169 while the size
  fields sit near y=600. No amount of scrolling *inside* the frame helps,
  because the frame itself extends past the screen. The host page would have to
  scroll.
- **`keyboardInset` becomes meaningless.** See below.

## 2. Post the real viewport width

Without this, a padded theme container can hand an iPad a sub-768px iframe and
the builder renders the phone layout on a tablet.

The builder only ever uses a shell-supplied width to correct the measurement
*upward*, and clamps it to `window.screen.width`, which an embedder cannot
influence. Height always comes from the real `window`. So a shell cannot force
the desktop layout onto a phone even by accident.

## 3. Post the keyboard inset

Without this, the keyboard-safe scrolling never engages and iOS customers go
back to typing a size into a field hidden behind the keyboard.

`keyboardInset` is **how many CSS pixels of the builder iframe's viewport the
keyboard covers, measured up from the iframe's bottom edge.** It is deliberately
*not* the keyboard's height:

- The overlap is exact at any iframe height and any scroll position. A keyboard
  height would only be correct for a full-height embed.
- It fails safe. Posting `221` (a keyboard height) into a 1600px frame reads as
  "the bottom 221 of 1600 are covered" — a line far below the content — and the
  builder declines to do anything. Under the opposite convention the same
  mistake would read as "everything below y=221 is covered" and would shrink the
  panel aggressively.

Note the consequence: the number is not keyboard-shaped. A 1600px iframe on a
390px phone legitimately produces `1431`.

## The snippet

```js
const BUILDER_ORIGIN = "https://your-builder-origin";       // exact origin, no path
const iframe = document.getElementById("dtf-builder");      // your iframe element

function postShellConfig() {
  const vv = window.visualViewport;
  const box = iframe.getBoundingClientRect();

  iframe.contentWindow.postMessage(
    {
      type: "dtf-builder-shell-config",
      viewportWidth: window.innerWidth,
      keyboardInset: vv
        ? Math.max(0, box.bottom - (vv.offsetTop + vv.height))
        : 0,
    },
    BUILDER_ORIGIN,
  );
}

iframe.addEventListener("load", postShellConfig);
window.addEventListener("resize", postShellConfig);
window.addEventListener("orientationchange", postShellConfig);
window.visualViewport?.addEventListener("resize", postShellConfig);
window.visualViewport?.addEventListener("scroll", postShellConfig);
```

`visualViewport`'s `scroll` matters as much as its `resize`: iOS pans the visual
viewport when a keyboard opens, so the overlap changes without the viewport
resizing.

## Rules the theme side must respect

- **Post from the window that directly embeds the builder.** The builder
  requires `event.source === window.parent`, which the browser sets and nothing
  can forge. Sibling frames, popups and openers are rejected.
- **Numbers, not strings.** `"820"` is rejected rather than coerced.
  `viewportWidth` must be finite and within 240–8192; `keyboardInset` finite and
  within 0–8192.
- **Level-triggered, so post `0` when the keyboard closes.** Nothing times the
  value out. Reporting the open without the close leaves a stale claim until the
  field is blurred.
- **An inset under 120 is treated as no keyboard**, on the assumption that a
  shrink that small is browser chrome rather than a keyboard.
- **Idempotent.** Re-posting an unchanged value notifies nobody, so calling on
  every event is fine. A message that omits a field leaves the previously
  accepted value in place, so `uploadUrl` can travel in the same message.

## Nested embeds

If the chain is storefront → app-proxy shell → builder, the top-level page must
post to the middle frame and the middle frame must re-post to the builder,
recomputing `keyboardInset` against its *own* iframe rect. Forwarding the outer
page's number unchanged will be wrong by the middle frame's offset. This path is
documented but has not been tested.

## If the theme is never updated

The builder stays functional. What you lose: tablets keep getting the phone
layout when the iframe is narrower than 768px, and iOS customers keep hitting a
size field behind the keyboard. The 16px font-size change that stops iOS zooming
the page in on focus is pure CSS and works regardless.

## Related deployment step

Unrelated to embedding but required at the same time: set `TRUST_PROXY` in the
server environment. Rate limiting keys off `req.ip`, so behind the app proxy
every customer otherwise shares one bucket. See `.env.example`.
