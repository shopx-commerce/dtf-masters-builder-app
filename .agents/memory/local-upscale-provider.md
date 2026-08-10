---
name: Local upscale provider
description: The local open-source Real-ESRGAN ncnn-Vulkan provider, its runtime requirements, and fallback behavior.
---

Local Real-ESRGAN ncnn-Vulkan is preferred for image upscaling when the configured
binary and bundled model directory are available. The server keeps the same
`/api/upscale-image` contract and retains the Replicate implementation only as
an explicit automatic fallback.

**Why:** Customer designs should not need to be uploaded to an external AI API
for every upscale, and local inference avoids network transfer and provider
startup overhead. A serialized queue is required because concurrent large PNG
inference can exhaust GPU memory.

**How to apply:** Keep `UPSCALE_PROVIDER=local`, point
`REAL_ESRGAN_BIN` and `REAL_ESRGAN_MODEL_DIR` at the official complete Linux
bundle, and tune `REAL_ESRGAN_TILE` downward for constrained GPU memory. The
model is loaded per queued CLI invocation, so result caching and in-flight
deduplication are important until a warm model service is introduced.