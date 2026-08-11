---
name: Server upload temp-file hygiene
description: Rules for multipart upload storage on the builder server — disk over memory, abort cleanup, decode serialization.
---

# Server upload temp-file hygiene

**Rules:**
- Large multipart uploads must use disk storage, never multer memoryStorage — concurrent 100 MB bodies in RAM stack per customer and have OOM-killed production (`signal: killed` in deployment logs; customers saw bare "Prepare failed (500)" from the platform's boot windows).
- multer's disk storage does NOT clean up when the client disconnects mid-body; its cleanup only covers its own limit/parse errors, and route-handler `finally` blocks never run because the handler is never reached. Record each temp path the moment the storage engine names the file (custom `filename` callback + per-request WeakMap), and unlink on `res` `close` when `writableEnded` is false.
- Keep an app-owned temp subdirectory with an age-gated reaper (hourly, only files older than the max request lifetime) as defense in depth for crash-mid-write. Age gating prevents reaping files of in-flight requests.
- Serialize full-image decode work (one at a time + short FIFO), shed overflow with 503 + Retry-After. Header-only work (metadata, MP caps) stays outside the gate. The client prepare retry treats 500/502/503/504 as transient, so shedding is recoverable — 500 is retryable because the platform answers bare 500s while an instance boots.
- `sharp.cache(false)` on servers processing unique customer uploads — the decoded-image cache gets no reuse and only raises resident memory.

**Why:** Production OOM kills were traced to unbounded concurrent libvips decodes (up to 150 MP each) plus per-request RAM upload buffers. Flaky mobile connections make mid-body aborts routine, so any uncovered abort path leaks unboundedly.

**How to apply:** Any new upload-accepting endpoint (the upscale endpoint still uses a Buffer-based multer) should reuse this pattern: disk storage into the reaped directory, abort middleware, and the decode gate if it does full-image work.
