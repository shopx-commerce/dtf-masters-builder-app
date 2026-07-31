---
name: Replicate upscale request limits
description: Replicate synchronous prediction waits have a strict 60-second header limit.
---

Use a synchronous Replicate wait value below 60 seconds and keep a separate outer abort timeout around the full prediction and output-download flow.

**Why:** Replicate rejects `Prefer: wait` values above 60 seconds with a 422 response, even when the client-side timeout is longer.

**How to apply:** When adding or changing Replicate-backed image processing, keep the model wait limit and the overall request timeout separate; validate the real endpoint rather than relying only on a build.