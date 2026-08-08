# Pending actions — read before deploying

Everything in this folder is **work that code alone cannot finish**. The commits
are on `main`, but the items below need someone to change an environment
variable, a Shopify theme, or a hosting setting. Until then the related code is
either inactive or actively risky.

Ordered by consequence. Item 1 can take the store down; the rest degrade
quietly.

---

## 1. Set `TRUST_PROXY` before the security middleware goes live

**Status:** not done. **Blocks:** deploying the rate-limiting work.
**If ignored:** ordinary traffic starts returning `429`s for everybody.

Rate limiting keys off `req.ip`, which Express reports as the *immediate peer*.
This app sits behind Replit's edge, so that peer is the proxy, not the customer —
which puts **every customer in one shared bucket**: 1,200 requests per 5 minutes
across the entire store on `/api`, 300 on the asset-proxy paths, 240 on the image
routes. The symptom is assets failing to load and image processing dying for
everyone at once, which looks like an outage rather than a limit.

**Where to set it.** Either Replit Secrets, or `.replit` under the existing
`[userenv.shared]` section alongside `R2_PUBLIC_BASE_URL`:

```toml
[userenv.shared]
TRUST_PROXY = "1"
```

**What value.** `1` means "one proxy in front of us", which is right for Replit
alone. **If `anynestapp.com` is also behind Cloudflare or any other CDN, it needs
`2`.** Getting this number too low silently restores the shared-bucket problem;
too high lets a caller forge `X-Forwarded-For` and pick its own rate-limit key.
So confirm the hop count rather than guessing.

Sanity check after deploying: two different devices should be able to exhaust
their own allowance independently.

Full notes on this and the other new variables are in `.env.example`.

---

## 2. Storefront embed — only if the builder is ever put in an iframe

**Status:** not needed today. **If ignored (while standalone):** nothing breaks.

As of this writing the production builder is served **top-level** at
`anynestapp.com/hot-peel` — verified live: not framed, no ancestor origins, no
Shopify markers on the page. On that path everything works and there is nothing
to do.

The `shell-message` / `postMessage` code exists for a Shopify-embedded
deployment. **The moment the builder is placed in an iframe, two things stop
working by themselves** and the theme has to cooperate:

- **Layout picks the wrong device.** An iframe measures itself, so a padded theme
  container hands a tablet the phone layout.
- **Keyboard-safe scrolling goes completely inert.** A child frame's
  `visualViewport` *is* its layout viewport — Blink defined it that way
  deliberately, so reporting the top-level one can't leak information across
  origins — which makes the keyboard inset compute to exactly `0` at every iframe
  height. iOS customers go back to typing a size into a field hidden behind the
  keyboard.

There is also a **live-today-if-embedded** hazard: a tall, content-sized iframe
makes a landscape phone render the desktop layout and shrinks the gangsheet
canvas from roughly 414×206 to 186×93.

**`docs/storefront-embed.md` has the complete contract**: the required iframe
sizing, the exact `postMessage` shape, a copy-pasteable snippet, the validation
rules, and the nested-embed relay path. Hand that document to whoever edits the
theme.

Not verified by anyone yet: real iOS Safari, a real software keyboard, and a real
device. The keyboard depths used in testing come from published point tables.

---

## 3. Fetch the upscale weights on a fresh clone

**Status:** informational.

`client/public/models/*.onnx` and `tools/upscale-export/*.pth` are now
`.gitignore`d — they are fetched, not authored, and unlike `client/public/pdfjs/`
and `client/public/ort/` no build plugin produces them. A fresh clone therefore
has no upscale weights until they are downloaded, and the client-side WebGPU
upscaler will not load. See `docs/local-upscale.md`.
`tools/upscale-export/` keeps the two Python scripts so the `.onnx` conversion
stays reproducible.

---

## 4. Replit dev banner in production

**Status:** not investigated.

The live page loads `https://replit.com/public/js/replit-dev-banner.js`. Worth
removing from the production build — it is a third-party script on a page that
handles customer artwork.

---

## 5. Known-unfinished mobile work

Measured and documented, not started. None is a regression; all three predate
the current round of fixes.

- **No multi-select on touch at all**, so bulk align, duplicate and delete are
  unreachable on a phone or tablet.
- **Resize dragging is far too sensitive**: one CSS pixel of drag is about 0.16
  physical inches of film on the phone canvas. The steppers are the precise-entry
  route that avoids this, which is why they were given 44px hit areas first.
- **82 controls still measure under 44 CSS px**, 17 of which fail WCAG 2.5.8.

---

## Verification harnesses

`scripts/` holds the benchmarks and verification harnesses behind this work,
including the rotation trap in `bench-nest.ts` that fails if the
never-rotate-a-group fix is reverted. Scratch output lives in gitignored `tmp-*`
directories and is not preserved.
