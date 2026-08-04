# Local Real-ESRGAN upscaling

The editor keeps using `POST /api/upscale-image`. The server now supports a
local open-source provider without changing the browser API.

## Install the native engine

On a Linux deployment with Vulkan support:

```bash
bash scripts/setup-local-upscaler.sh
```

The script installs the official
[`Real-ESRGAN-ncnn-vulkan`](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)
release and prints the environment variables required by the server.

```bash
export UPSCALE_PROVIDER=local
export REAL_ESRGAN_BIN=/path/to/vendor/realesrgan-ncnn-vulkan/realesrgan-ncnn-vulkan
export REAL_ESRGAN_MODEL_DIR=/path/to/vendor/realesrgan-ncnn-vulkan/models
npm run dev
```

The setup script uses the official Linux bundle that includes the executable
and `realesrgan-x4plus` model files. If `REAL_ESRGAN_MODEL_DIR` is omitted,
the server looks for a `models` directory next to the configured executable.

`UPSCALE_PROVIDER=auto` is the default. In auto mode the server uses the local
binary when `REAL_ESRGAN_BIN` is configured, otherwise it keeps the existing
Replicate provider. Set `UPSCALE_PROVIDER=local` to fail explicitly when the
native engine is missing instead of using an external provider.

## Runtime behavior

- x2 and x3 use the official `realesrgan-x4plus` model with the native CLI
  scale set to 2 or 3.
- Transparent PNG alpha is restored after inference.
- Only one local GPU job runs at a time.
- Two additional jobs may wait in the queue; further requests fail clearly.
- Identical in-flight requests are shared.
- Completed results are cached in memory with bounded LRU eviction.
- Cache keys include the source bytes, scale factor, provider, and binary path.

Optional tuning variables:

```bash
REAL_ESRGAN_TILE=256       # lower GPU memory use; keep 0/empty for automatic
REAL_ESRGAN_GPU=0          # Vulkan GPU index
REAL_ESRGAN_THREADS=1:2:2  # load:process:save threads
```

The local CLI loads its model for each queued invocation. This removes API
startup, network upload, and result-download overhead, but it is not a
persistent in-memory model service. A future warm worker could improve first
request latency further without changing this route contract.