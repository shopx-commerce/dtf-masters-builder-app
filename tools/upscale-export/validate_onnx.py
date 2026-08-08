"""
Sanity-check the exported ONNX against the PyTorch reference, and try an
fp16 variant.

    python tools/upscale-export/validate_onnx.py
"""

from __future__ import annotations

import pathlib

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxconverter_common import float16

from export_srvggnet import (
    CHECKPOINT,
    NUM_CONV,
    NUM_FEAT,
    OUT_DIR,
    OUT_FILE,
    UPSCALE,
    SRVGGNetCompact,
)

FP16_FILE = OUT_DIR / "realesr-general-x4v3-fp16.onnx"


def torch_reference(x: np.ndarray) -> np.ndarray:
    state = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
    state = state.get("params", state)
    model = SRVGGNetCompact(num_feat=NUM_FEAT, num_conv=NUM_CONV, upscale=UPSCALE)
    model.load_state_dict(state, strict=True)
    model.eval()
    with torch.no_grad():
        return model(torch.from_numpy(x)).numpy()


def main() -> int:
    rng = np.random.default_rng(7)
    x = rng.random((1, 3, 96, 96), dtype=np.float32)

    ref = torch_reference(x)
    print(f"torch out shape {ref.shape} range [{ref.min():.4f}, {ref.max():.4f}]")

    sess = ort.InferenceSession(str(OUT_FILE), providers=["CPUExecutionProvider"])
    got = sess.run(None, {"input": x})[0]
    err = np.abs(got - ref).max()
    print(f"fp32 ONNX vs torch  max abs err = {err:.3e}")
    assert err < 1e-4, "fp32 export does not match the PyTorch reference"

    # fp16: halves the download and is materially faster on GPUs that expose
    # `shader-f16`. Only worth shipping if it stays visually identical.
    model = onnx.load(str(OUT_FILE))
    fp16_model = float16.convert_float_to_float16(model, keep_io_types=True)
    onnx.save(fp16_model, str(FP16_FILE))
    sess16 = ort.InferenceSession(str(FP16_FILE), providers=["CPUExecutionProvider"])
    got16 = sess16.run(None, {"input": x})[0]
    err16 = np.abs(got16 - ref).max()
    rms16 = float(np.sqrt(np.mean((got16 - ref) ** 2)))
    print(f"fp16 ONNX vs torch  max abs err = {err16:.3e}  rms = {rms16:.3e}")
    print(f"fp16 size {FP16_FILE.stat().st_size / 1e6:.2f} MB")

    # 1/255 is one 8-bit level: below that the difference cannot survive
    # encoding to PNG, so it cannot reach the printer.
    print(f"fp16 max err in 8-bit levels: {err16 * 255:.2f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
