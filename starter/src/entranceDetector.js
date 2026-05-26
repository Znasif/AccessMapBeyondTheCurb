import * as ort from 'onnxruntime-web';

// Single-threaded WASM — no COOP/COEP headers required (Mapbox would break with them).
// Point to CDN using the exact installed version so JS glue and WASM binary always match.
// Vite does not intercept absolute https:// dynamic imports, so .mjs files load cleanly.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';

const CONF_THR = 0.25;
const IOU_THR  = 0.45;
const INPUT_SZ = 640;
const N_ANCHORS = 8400;

let _sessionPromise = null;

export function loadEntranceModel() {
  if (!_sessionPromise) {
    _sessionPromise = ort.InferenceSession.create('/yolo_entrance.onnx', {
      executionProviders: ['wasm'],
    }).catch((err) => {
      _sessionPromise = null; // allow retry
      throw err;
    });
  }
  return _sessionPromise;
}

function iou(a, b) {
  const x1 = Math.max(a[0], b[0]), y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]), y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (!inter) return 0;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

function nms(boxes, scores) {
  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
  const suppressed = new Uint8Array(scores.length);
  const keep = [];
  for (const i of order) {
    if (suppressed[i]) continue;
    keep.push(i);
    for (const j of order) {
      if (j === i || suppressed[j]) continue;
      if (iou(boxes[i], boxes[j]) > IOU_THR) suppressed[j] = 1;
    }
  }
  return keep;
}

export async function detectEntrance(imageUrl, session) {
  // Fetch image and draw onto INPUT_SZ x INPUT_SZ offscreen canvas
  const blob   = await fetch(imageUrl).then((r) => r.blob());
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(INPUT_SZ, INPUT_SZ);
  const ctx    = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, INPUT_SZ, INPUT_SZ);
  bitmap.close();

  // RGBA → CHW float32 RGB tensor
  const { data } = ctx.getImageData(0, 0, INPUT_SZ, INPUT_SZ);
  const pixels = INPUT_SZ * INPUT_SZ;
  const tensor_data = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    tensor_data[i]             = data[i * 4]     / 255; // R
    tensor_data[i + pixels]    = data[i * 4 + 1] / 255; // G
    tensor_data[i + 2 * pixels] = data[i * 4 + 2] / 255; // B
  }

  const tensor  = new ort.Tensor('float32', tensor_data, [1, 3, INPUT_SZ, INPUT_SZ]);
  const results = await session.run({ images: tensor });

  // output0: [1, 5, 8400] stored row-major → data[row * N_ANCHORS + col]
  // rows: x_center, y_center, w, h, confidence (in 640-px space)
  const output = results['output0'].data;
  const boxes  = [];
  const scores = [];

  for (let i = 0; i < N_ANCHORS; i++) {
    const conf = output[4 * N_ANCHORS + i];
    if (conf < CONF_THR) continue;
    const cx = output[0 * N_ANCHORS + i];
    const cy = output[1 * N_ANCHORS + i];
    const w  = output[2 * N_ANCHORS + i];
    const h  = output[3 * N_ANCHORS + i];
    boxes.push([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]);
    scores.push(conf);
  }

  if (boxes.length === 0) return null;

  const keep = nms(boxes, scores);
  return {
    // barFraction: horizontal center of best detection, 0–1 across the image width
    barFraction: (boxes[keep[0]][0] + boxes[keep[0]][2]) / 2 / INPUT_SZ,
    confidence:  scores[keep[0]],
  };
}
