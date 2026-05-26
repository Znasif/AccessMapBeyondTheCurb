#!/usr/bin/env bash
# Run from WSL at the repo root:
#   bash setup_models.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export MAPILLARY_DIR="$SCRIPT_DIR/mapillary-entrances"
export RESOURCES_DIR="$SCRIPT_DIR/starter/resources"
export MODEL_NAME="yolo_weights_750_image_set.pt"

echo "=== AccessMap entrance model setup ==="
echo "Project root : $SCRIPT_DIR"
echo "Resources dir: $RESOURCES_DIR"
echo ""

# ── Require uv ─────────────────────────────────────────────────────────────────
if ! command -v uv &>/dev/null; then
    echo "ERROR: uv is not installed. Install it with:"
    echo "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

mkdir -p "$RESOURCES_DIR"

UV="uv run --with huggingface_hub>=0.16 --with ultralytics>=8.0"

# ── Download .pt weights ───────────────────────────────────────────────────────
echo "[1/2] Downloading YOLO weights from HuggingFace ..."
$UV python3 - <<'PYEOF'
from huggingface_hub import hf_hub_download
from pathlib import Path
import shutil, os

dest = Path(os.environ["MAPILLARY_DIR"]) / os.environ["MODEL_NAME"]
if dest.exists():
    print(f"  Already present: {dest} — skipping download.")
else:
    print(f"  Fetching erantala1/yolov8s-entrance-detector / {os.environ['MODEL_NAME']} ...")
    src = hf_hub_download(
        repo_id="erantala1/yolov8s-entrance-detector",
        filename=os.environ["MODEL_NAME"],
    )
    shutil.copy(src, dest)
    size_mb = dest.stat().st_size / 1_048_576
    print(f"  Saved: {dest}  ({size_mb:.1f} MB)")
PYEOF

# ── Export to ONNX ─────────────────────────────────────────────────────────────
echo "[2/2] Exporting to ONNX (640×640, opset 12, simplified) ..."
$UV python3 - <<'PYEOF'
from ultralytics import YOLO
from pathlib import Path
import os, shutil

pt_path  = Path(os.environ["MAPILLARY_DIR"]) / os.environ["MODEL_NAME"]
onnx_out = Path(os.environ["RESOURCES_DIR"]) / "yolo_entrance.onnx"

if onnx_out.exists():
    print(f"  Already present: {onnx_out} — skipping export.")
else:
    print(f"  Loading {pt_path.name} ...")
    model = YOLO(str(pt_path))

    print("  Exporting ...")
    exported = model.export(
        format="onnx",
        imgsz=640,
        simplify=True,
        opset=12,
        dynamic=False,
    )

    # ultralytics >= 8.x returns the path; older versions return None
    exported_path = Path(str(exported)) if exported else None
    if exported_path is None or not exported_path.exists():
        exported_path = pt_path.with_suffix(".onnx")

    if not exported_path.exists():
        raise FileNotFoundError(
            f"ONNX export did not produce a file at {exported_path}. "
            "Check ultralytics output above for the actual path."
        )

    shutil.copy(exported_path, onnx_out)
    size_mb = onnx_out.stat().st_size / 1_048_576
    print(f"  Written: {onnx_out}  ({size_mb:.1f} MB)")
PYEOF

echo ""
echo "=== Done ==="
echo "ONNX model ready at: $RESOURCES_DIR/yolo_entrance.onnx"
echo ""
echo "Next: run the JS integration (Step 2) to wire the model into the React app."
