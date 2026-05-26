#!/usr/bin/env bash
# Run from WSL at the repo root after test_mapillary.bat has downloaded images:
#   bash test_onnx.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export IMAGES_DIR="$SCRIPT_DIR/response/images"
export ONNX_PATH="$SCRIPT_DIR/starter/resources/yolo_entrance.onnx"
export OUT_DIR="$SCRIPT_DIR/response/annotated"

# ── Guards ─────────────────────────────────────────────────────────────────────
if ! command -v uv &>/dev/null; then
    echo "ERROR: uv not found. Install: curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

if [ ! -f "$ONNX_PATH" ]; then
    echo "ERROR: ONNX model not found at $ONNX_PATH"
    echo "Run setup_models.sh first."
    exit 1
fi

if ! ls "$IMAGES_DIR"/*.jpg &>/dev/null; then
    echo "ERROR: No .jpg files found in $IMAGES_DIR"
    echo "Run test_mapillary.bat first."
    exit 1
fi

mkdir -p "$OUT_DIR"

echo "=== YOLO Entrance Detection Test ==="
echo "Model : $ONNX_PATH"
echo "Images: $IMAGES_DIR"
echo "Output: $OUT_DIR"
echo ""

uv run --with onnxruntime --with opencv-python --with numpy python3 - <<'PYEOF'
import os, sys
import numpy as np
import cv2
from pathlib import Path

images_dir = Path(os.environ["IMAGES_DIR"])
onnx_path  = Path(os.environ["ONNX_PATH"])
out_dir    = Path(os.environ["OUT_DIR"])

import onnxruntime as ort

session     = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
input_name  = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name
out_shape   = session.get_outputs()[0].shape
print(f"Model loaded — input: {input_name}  output: {output_name} {out_shape}")
print()

CONF_THR = 0.35
IOU_THR  = 0.45
INPUT_SZ = 640


def preprocess(img_bgr):
    h, w = img_bgr.shape[:2]
    resized = cv2.resize(img_bgr, (INPUT_SZ, INPUT_SZ))
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    return rgb.transpose(2, 0, 1)[np.newaxis], w, h


def nms(boxes, scores, iou_thr):
    if len(boxes) == 0:
        return []
    x1, y1, x2, y2 = boxes[:,0], boxes[:,1], boxes[:,2], boxes[:,3]
    areas = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]; keep.append(i)
        inter_x1 = np.maximum(x1[i], x1[order[1:]])
        inter_y1 = np.maximum(y1[i], y1[order[1:]])
        inter_x2 = np.minimum(x2[i], x2[order[1:]])
        inter_y2 = np.minimum(y2[i], y2[order[1:]])
        inter    = np.maximum(0, inter_x2 - inter_x1) * np.maximum(0, inter_y2 - inter_y1)
        iou      = inter / (areas[i] + areas[order[1:]] - inter + 1e-9)
        order    = order[1:][iou <= iou_thr]
    return keep


def postprocess(raw_output, orig_w, orig_h):
    # YOLOv8 single-class output: [1, 5, 8400] → squeeze batch → transpose to [8400, 5]
    # columns: x_center, y_center, w, h, confidence  (in 640-pixel space)
    preds = raw_output[0][0].T
    mask  = preds[:, 4] >= CONF_THR
    preds = preds[mask]
    if len(preds) == 0:
        return []

    cx, cy, bw, bh = preds[:,0], preds[:,1], preds[:,2], preds[:,3]
    boxes_640 = np.stack([cx - bw/2, cy - bh/2, cx + bw/2, cy + bh/2], axis=1)
    scores    = preds[:, 4]
    keep      = nms(boxes_640, scores, IOU_THR)

    sx = orig_w / INPUT_SZ
    sy = orig_h / INPUT_SZ
    results = []
    for k in keep:
        x1 = int(np.clip(boxes_640[k, 0] * sx, 0, orig_w))
        y1 = int(np.clip(boxes_640[k, 1] * sy, 0, orig_h))
        x2 = int(np.clip(boxes_640[k, 2] * sx, 0, orig_w))
        y2 = int(np.clip(boxes_640[k, 3] * sy, 0, orig_h))
        conf         = float(scores[k])
        bar_fraction = float((boxes_640[k, 0] + boxes_640[k, 2]) / 2 / INPUT_SZ)
        results.append({"x1":x1,"y1":y1,"x2":x2,"y2":y2,"conf":conf,"bar_fraction":bar_fraction})
    return results


images = sorted(images_dir.glob("*.jpg"))
if not images:
    print("No .jpg files found in", images_dir)
    sys.exit(1)

hits = 0
col_w = max(len(p.name) for p in images) + 2

print(f"  {'Image':<{col_w}}  {'Dets':>4}  {'Best conf':>9}  Bar fractions")
print("  " + "-" * (col_w + 32))

for img_path in images:
    img = cv2.imread(str(img_path))
    if img is None:
        print(f"  WARN: could not read {img_path.name}")
        continue

    tensor, orig_w, orig_h = preprocess(img)
    raw = session.run([output_name], {input_name: tensor})
    dets = postprocess(raw, orig_w, orig_h)

    best_conf = f"{max(d['conf'] for d in dets):.3f}" if dets else "—"
    bar_str   = "  ".join(f"{d['bar_fraction']:.3f}" for d in dets) if dets else "—"
    print(f"  {img_path.name:<{col_w}}  {len(dets):>4}  {best_conf:>9}  {bar_str}")

    # annotate image
    vis = img.copy()
    for d in dets:
        # green bounding box
        cv2.rectangle(vis, (d["x1"], d["y1"]), (d["x2"], d["y2"]), (0, 200, 0), 2)
        cv2.putText(vis, f"{d['conf']:.2f}", (d["x1"], max(0, d["y1"] - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 0), 1, cv2.LINE_AA)
        # cyan vertical bar at horizontal center of detection
        bar_x = int(d["bar_fraction"] * orig_w)
        cv2.line(vis, (bar_x, 0), (bar_x, orig_h), (0, 255, 255), 2)
        cv2.putText(vis, f"bar={d['bar_fraction']:.3f}", (bar_x + 4, 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)

    cv2.imwrite(str(out_dir / img_path.name), vis)
    if dets:
        hits += 1

print("  " + "-" * (col_w + 32))
print(f"\n  Detections in {hits}/{len(images)} images")
print(f"  Annotated images → {out_dir}")
PYEOF

echo ""
echo "=== Done ==="
echo "Open response/annotated/ to inspect bounding boxes and cyan entrance bars."
