"""
Export Real-ESRGAN's `realesr-general-x4v3` checkpoint to ONNX for the
browser upscaler.

Run once; the resulting `.onnx` is committed under `client/public/models/`
and served as a static asset, so nothing here runs at build or request time.

    python tools/upscale-export/export_srvggnet.py

Provenance / licence
--------------------
Weights: `realesr-general-x4v3.pth`, downloaded from the official
xinntao/Real-ESRGAN GitHub release v0.2.5.0. Real-ESRGAN is BSD-3-Clause.
This is deliberately *not* a community-trained OpenModelDB checkpoint —
most of those are CC-BY-NC-SA-4.0, and shipping weights in a commercial
web app is distribution, which the NonCommercial term forbids.

The architecture below is SRVGGNetCompact, transcribed from Real-ESRGAN's
`realesrgan/archs/srvgg_arch.py` so this script does not need the whole
basicsr dependency tree. Same BSD-3-Clause licence.
"""

from __future__ import annotations

import hashlib
import pathlib
import sys

import torch
import torch.nn.functional as F
from torch import nn

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
CHECKPOINT = HERE / "realesr-general-x4v3.pth"
OUT_DIR = REPO / "client" / "public" / "models"
OUT_FILE = OUT_DIR / "realesr-general-x4v3.onnx"

# realesr-general-x4v3 hyper-parameters, per Real-ESRGAN's inference script.
NUM_FEAT = 64
NUM_CONV = 32
UPSCALE = 4


class SRVGGNetCompact(nn.Module):
    def __init__(self, num_in_ch=3, num_out_ch=3, num_feat=64, num_conv=16, upscale=4):
        super().__init__()
        self.upscale = upscale
        self.body = nn.ModuleList()
        self.body.append(nn.Conv2d(num_in_ch, num_feat, 3, 1, 1))
        self.body.append(nn.PReLU(num_parameters=num_feat))
        for _ in range(num_conv):
            self.body.append(nn.Conv2d(num_feat, num_feat, 3, 1, 1))
            self.body.append(nn.PReLU(num_parameters=num_feat))
        self.body.append(nn.Conv2d(num_feat, num_out_ch * upscale * upscale, 3, 1, 1))
        self.upsampler = nn.PixelShuffle(upscale)

    def forward(self, x):
        out = x
        for layer in self.body:
            out = layer(out)
        out = self.upsampler(out)
        # The network learns the residual over a nearest-neighbour upsample.
        base = F.interpolate(x, scale_factor=self.upscale, mode="nearest")
        return out + base


def main() -> int:
    if not CHECKPOINT.exists():
        print(f"missing checkpoint: {CHECKPOINT}", file=sys.stderr)
        return 1

    digest = hashlib.sha256(CHECKPOINT.read_bytes()).hexdigest()
    print(f"checkpoint sha256 {digest}")

    state = torch.load(CHECKPOINT, map_location="cpu", weights_only=True)
    state = state.get("params", state)

    model = SRVGGNetCompact(num_feat=NUM_FEAT, num_conv=NUM_CONV, upscale=UPSCALE)
    missing, unexpected = model.load_state_dict(state, strict=True), None
    print(f"load_state_dict: {missing}")
    model.eval()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dummy = torch.rand(1, 3, 64, 64, dtype=torch.float32)

    # Dynamic H/W keeps one artefact usable for any tile size. The runtime
    # always feeds the *same* shape so ORT's program cache still hits.
    torch.onnx.export(
        model,
        (dummy,),
        str(OUT_FILE),
        input_names=["input"],
        output_names=["output"],
        dynamic_axes={"input": {2: "height", 3: "width"}, "output": {2: "out_h", 3: "out_w"}},
        opset_version=17,
        dynamo=False,
    )

    print(f"wrote {OUT_FILE} ({OUT_FILE.stat().st_size / 1e6:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
