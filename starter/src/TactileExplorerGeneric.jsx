import { useEffect, useRef, useState } from 'react';
import cv from '@techstark/opencv-js';
import { uvToLngLat } from './audiom';
import { openCameraStream } from './cameraDevices';
import { createPointingTracker, pointingHint } from './gestureRecognizer';
import { speak } from './lib/speak';

const MEDIAPIPE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const CORNER_PROMPTS = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const DWELL_MS = 1500;   // hold time to lock a corner
const DWELL_R = 45;      // px jitter tolerance while holding

function waitForOpenCV() {
  return new Promise((resolve) => {
    if (cv.Mat) { resolve(); return; }
    cv.onRuntimeInitialized = resolve;
  });
}

// One Euro Filter — speed-adaptive low-pass for noisy fingertip tracking.
function makeOneEuroFilter(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
  let xFilt = null, dxFilt = 0, lastT = null;
  const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
  return function filter(x, t) {
    if (lastT === null) { xFilt = x; lastT = t; return x; }
    const dt = Math.max((t - lastT) / 1000, 1e-6);
    lastT = t;
    const dx = (x - xFilt) / dt;
    dxFilt = dxFilt + alpha(dCutoff, dt) * (dx - dxFilt);
    const cutoff = minCutoff + beta * Math.abs(dxFilt);
    xFilt = xFilt + alpha(cutoff, dt) * (x - xFilt);
    return xFilt;
  };
}

// ---- accessibility cues ----
// `speak` moved to lib/speak.js in milestone 5c — same cancel-then-speak
// behaviour, now shared with AudiomMap's whats_here. The M-S queue replaces it.
let _ac;
const beep = () => {
  try {
    _ac = _ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = _ac.createOscillator(), g = _ac.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(_ac.destination);
    g.gain.setValueAtTime(0.2, _ac.currentTime); o.start();
    g.gain.exponentialRampToValueAtTime(0.001, _ac.currentTime + 0.15); o.stop(_ac.currentTime + 0.16);
  } catch { /* noop */ }
};

/**
 * Camera-driven pointer for a PRE-MADE physical tactile map of an Audiom map.
 *
 * Register the material once by pointing at its 4 corners (MediaPipe + dwell);
 * the frame captured at the 4th corner becomes the AKAZE reference. Each frame
 * afterwards: live camera -> snapshot (AKAZE homography) -> (u,v) inside the 4
 * corners -> lat/lng inside `bbox`. No Mapbox, no pin generation.
 *
 * Props: bbox [minLng,minLat,maxLng,maxLat], onCoord({lng,lat}|null).
 */
export function TactileExplorerGeneric({
  bbox, onCoord, cols = 43, rows = 31, hysteresis = 0.3,
  bboxAspect = null, materialAspect = null,
  overlay = true, overlayOpacity = 0.55, overlayPct = 60, showRectPanel = false,
}) {
  const videoRef = useRef(null);
  const offRef = useRef(document.createElement('canvas')); // clean frame for AKAZE
  const debugRef = useRef(null);
  const rectRef = useRef(null);   // rectified ("reverse projection") view
  const rectOffRef = useRef(document.createElement('canvas')); // warp target, drawn twice
  const ovRef = useRef(null);     // same rectification, overlaid on the embed
  const ovWrapRef = useRef(null);
  const overlayPctRef = useRef(overlayPct);
  useEffect(() => { overlayPctRef.current = overlayPct; }, [overlayPct]);
  const [ovSize, setOvSize] = useState(null); // reported px size of the box
  const ovSizeRef = useRef(null);
  const runningRef = useRef(false);

  const bboxRef = useRef(bbox);
  useEffect(() => { bboxRef.current = bbox; }, [bbox]);

  // Quantization: the material has a real physical resolution (a fingertip can't
  // resolve better than one pin), so snap (u,v) to the material's own grid and
  // only emit when the cell changes. This is what keeps a state-sized map from
  // firing a new feature announcement on every tremor — One-Euro smooths motion
  // but cannot fix the map being denser than the sensor. Map-agnostic: the grid
  // is a property of the material, not of the map.
  const gridRef = useRef({ cols, rows, hysteresis });
  useEffect(() => { gridRef.current = { cols, rows, hysteresis }; }, [cols, rows, hysteresis]);

  // Letterbox: if the material's physical aspect differs from the map window's
  // aspect, the printed artwork occupies only an inscribed sub-rectangle of the
  // material. Map (u,v) through that sub-rectangle so the four corners you
  // touched (the material's) still land correctly on the window's corners.
  const bboxAspectRef = useRef(bboxAspect);
  useEffect(() => { bboxAspectRef.current = bboxAspect; }, [bboxAspect]);

  const fitRef = useRef({ fx: 1, fy: 1 });
  useEffect(() => {
    if (bboxAspect && materialAspect && Number.isFinite(bboxAspect) && Number.isFinite(materialAspect)) {
      // fx/fy = fraction of the material occupied by the artwork on each axis
      const fx = materialAspect > bboxAspect ? bboxAspect / materialAspect : 1;
      const fy = materialAspect > bboxAspect ? 1 : materialAspect / bboxAspect;
      fitRef.current = { fx, fy };
    } else {
      fitRef.current = { fx: 1, fy: 1 };
    }
  }, [bboxAspect, materialAspect]);
  const cellRef = useRef(null); // last accepted { x, y }
  const [cell, setCell] = useState(null);

  const phaseRef = useRef('idle');       // 'idle' | 'capturing' | 'ready'
  const cornerIdxRef = useRef(0);
  const cornerPxRef = useRef([]);        // [[x,y]TL,TR,BR,BL] in snapshot px
  const dwellRef = useRef(null);         // { x, y, since }
  const isFixedRef = useRef(false);

  const s = useRef({
    hl: null, sift: null, bf: null,
    kpTpl: null, descTpl: null,          // features of the captured snapshot
    Hfwd: null, Hinv: null, HsnapToUv: null,
    bestInliers: 0, bestInliersAt: 0, tick: 0,
    oefX: makeOneEuroFilter(), oefY: makeOneEuroFilter(),
    pointTracker: null, wasPointing: false, lastHint: undefined,
  });

  const [status, setStatus] = useState('Initializing…');
  const [gestureHint, setGestureHint] = useState(null);
  const [attempt, setAttempt] = useState(0); // bump to retry camera/model init
  const [camInfo, setCamInfo] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [coord, setCoord] = useState(null);
  const [debugInfo, setDebugInfo] = useState({ good: 0, inliers: 0 });
  const [isFixed, setIsFixed] = useState(false);

  const startCapture = () => {
    cornerIdxRef.current = 0;
    cornerPxRef.current = [];
    dwellRef.current = null;
    s.current.HsnapToUv?.delete(); s.current.HsnapToUv = null;
    s.current.Hfwd?.delete(); s.current.Hinv?.delete();
    s.current.Hfwd = s.current.Hinv = null;
    s.current.bestInliers = 0;
    isFixedRef.current = false; setIsFixed(false);
    phaseRef.current = 'capturing'; setPhase('capturing');
    setStatus('Registering material');
    speak(`Point at the ${CORNER_PROMPTS[0]} corner and hold.`);
  };

  const toggleFixed = () => {
    const next = !isFixedRef.current;
    isFixedRef.current = next; setIsFixed(next);
    if (s.current.Hfwd && !s.current.Hfwd.empty()) setStatus(next ? 'Tracking (Fixed)' : 'Tracking');
  };

  // Keyboard: ';' toggles Fix, 'r' re-registers (ignored while typing in a field).
  useEffect(() => {
    function onKey(e) {
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === ';' || e.code === 'Semicolon') { e.preventDefault(); toggleFixed(); }
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startCapture(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const st = s.current;
    let cancelled = false;

    function captureReference() {
      const off = offRef.current;
      const snap = cv.imread(off);
      const gray = new cv.Mat();
      cv.cvtColor(snap, gray, cv.COLOR_RGBA2GRAY); snap.delete();
      st.kpTpl?.delete(); st.descTpl?.delete();
      st.kpTpl = new cv.KeyPointVector();
      st.descTpl = new cv.Mat();
      const noMask = new cv.Mat();
      st.sift.detectAndCompute(gray, noMask, st.kpTpl, st.descTpl);
      noMask.delete(); gray.delete();

      const c = cornerPxRef.current;
      const srcPx = cv.matFromArray(4, 1, cv.CV_32FC2,
        [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
      const dstUv = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 1, 0, 1, 1, 0, 1]);
      st.HsnapToUv?.delete();
      st.HsnapToUv = cv.getPerspectiveTransform(srcPx, dstUv);
      srcPx.delete(); dstUv.delete();

      // The snapshot IS the current frame, so snapshot->camera is the identity
      // right now. Seed it so tracking works the instant registration finishes,
      // rather than waiting for AKAZE to score 8+ inliers — which may never
      // happen on a feature-poor material, leaving the tool apparently dead.
      // NB: built with matFromArray, not cv.Mat.eye — that returns a MatExpr,
      // whose support in OpenCV.js is partial and can throw when handed to
      // perspectiveTransform (which would kill the render loop mid-registration).
      const I = () => cv.matFromArray(3, 3, cv.CV_64F, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
      st.Hfwd?.delete(); st.Hinv?.delete();
      st.Hfwd = I();
      st.Hinv = I();
      st.bestInliers = 0; st.bestInliersAt = 0;
    }

    async function init() {
      setStatus('Loading hand model…');
      const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      // numHands: 2 — with 1, a second pointing hand is invisible and the
      // ambiguity can never be detected. See gestureRecognizer.js.
      st.hl = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 2,
      });
      if (cancelled) return;

      setStatus('Loading OpenCV…');
      await waitForOpenCV();
      if (cancelled) return;

      st.sift = new cv.AKAZE();
      st.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);

      // Camera choice is Chrome's — its permission prompt lists every input
      // with a preview. facingMode is applied on mobile only so the desktop
      // prompt is not biased toward a virtual/headset camera. Retries fall back
      // to plain `video: true`, which succeeds on desktops where the
      // constrained request can return a device that never produces frames.
      setStatus(attempt === 0 ? 'Opening camera…' : 'Opening camera (any device)…');
      const stream = await openCameraStream({ relaxed: attempt > 0 });
      if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      // A camera can open yet deliver no frames (element suspended, or the
      // device is held by another app). Wait for real dimensions before
      // claiming success, otherwise the render loop silently no-ops forever.
      const gotFrames = await new Promise((resolve) => {
        const t0 = performance.now();
        const check = () => {
          if (cancelled) { resolve(false); return; }
          if (video.videoWidth > 0 && video.videoHeight > 0) { resolve(true); return; }
          if (performance.now() - t0 > 6000) { resolve(false); return; }
          requestAnimationFrame(check);
        };
        check();
      });
      if (cancelled) return;

      const track = stream.getVideoTracks()[0];
      setCamInfo({
        w: video.videoWidth, h: video.videoHeight,
        label: track?.label || 'camera', state: track?.readyState || '?',
      });

      if (!gotFrames) {
        setStatus('Camera opened but sent no frames — close other apps using it (e.g. the Camera app), then Retry.');
        return;
      }

      setStatus('Ready — press “Register material”.');
      runningRef.current = true;
      requestAnimationFrame(loop);
    }

    // Any throw inside a requestAnimationFrame callback silently ends the chain,
    // which looks exactly like "registration stopped working". Keep the loop
    // alive and surface the error instead of dying quietly.
    function loop() {
      try {
        loopBody();
      } catch (e) {
        console.error('[TactileExplorerGeneric] frame failed:', e);
        setStatus(`Frame error: ${e.message} — press r to re-register`);
        requestAnimationFrame(loop);
      }
    }

    function loopBody() {
      if (!runningRef.current || cancelled) return;
      const video = videoRef.current;
      if (!video) { requestAnimationFrame(loop); return; }
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) { requestAnimationFrame(loop); return; }

      const off = offRef.current;
      off.width = vw; off.height = vh;
      off.getContext('2d').drawImage(video, 0, 0);

      const now = performance.now();
      const result = st.hl.detectForVideo(video, now);

      // Require an actual pointing gesture, as camio-explorer does. Taking
      // landmarks[0][8] unconditionally meant a flat palm, a fist, or a hand
      // reaching across the material all produced a confident cursor — and
      // during corner capture could lock a dwell that was never a point.
      st.pointTracker ??= createPointingTracker();
      const gesture = st.pointTracker.update(result, now);

      let fx = null, fy = null;
      if (gesture.pointing && gesture.tip) {
        // Re-seed the smoothing filters on re-acquisition, otherwise the One
        // Euro state carries across the gap and the cursor slides in from
        // wherever the hand last was.
        if (!st.wasPointing) {
          st.oefX = makeOneEuroFilter();
          st.oefY = makeOneEuroFilter();
        }
        fx = st.oefX(gesture.tip.x * vw, now);
        fy = st.oefY(gesture.tip.y * vh, now);
      }
      st.wasPointing = gesture.pointing;

      // Speak only on transitions, and only the ambiguous case — announcing
      // every dropped frame would be unusable.
      const hint = pointingHint(gesture);
      if (hint !== st.lastHint) {
        st.lastHint = hint;
        setGestureHint(hint);
        if (gesture.tooManyHandsPointing) speak('Point with only one hand.');
      }

      // ── Corner capture ─────────────────────────────────────────────
      if (phaseRef.current === 'capturing') {
        if (fx !== null) {
          const d = dwellRef.current;
          if (!d || Math.hypot(fx - d.x, fy - d.y) > DWELL_R) {
            dwellRef.current = { x: fx, y: fy, since: now };
          } else if (now - d.since > DWELL_MS) {
            cornerPxRef.current[cornerIdxRef.current] = [fx, fy];
            cornerIdxRef.current += 1;
            dwellRef.current = null;
            beep();
            if (cornerIdxRef.current >= 4) {
              captureReference();
              phaseRef.current = 'ready'; setPhase('ready');
              setStatus('Tracking');
              speak('Map registered. Move your finger on the map.');
            } else {
              speak(`Point at the ${CORNER_PROMPTS[cornerIdxRef.current]} corner and hold.`);
            }
          }
        }
        drawDebug(fx, fy);
        requestAnimationFrame(loop);
        return;
      }

      // ── AKAZE match (every 6 frames) while tracking ────────────────
      st.tick += 1;
      if (phaseRef.current === 'ready' && !isFixedRef.current && st.tick % 6 === 0 && st.descTpl?.rows > 0) {
        const frameMat = cv.imread(off);
        const frameGray = new cv.Mat();
        cv.cvtColor(frameMat, frameGray, cv.COLOR_RGBA2GRAY); frameMat.delete();
        const kpFrame = new cv.KeyPointVector();
        const descFrame = new cv.Mat();
        const mask = new cv.Mat();
        st.sift.detectAndCompute(frameGray, mask, kpFrame, descFrame);
        mask.delete(); frameGray.delete();

        if (descFrame.rows >= 4) {
          const knn = new cv.DMatchVectorVector();
          st.bf.knnMatch(st.descTpl, descFrame, knn, 2);
          const good = [];
          for (let i = 0; i < knn.size(); i++) {
            const pair = knn.get(i);
            if (pair.size() >= 2 && pair.get(0).distance < 0.75 * pair.get(1).distance) {
              good.push({ q: pair.get(0).queryIdx, t: pair.get(0).trainIdx });
            }
          }
          knn.delete();

          if (good.length >= 8) {
            const srcArr = good.flatMap((m) => { const p = st.kpTpl.get(m.q).pt; return [p.x, p.y]; });
            const dstArr = good.flatMap((m) => { const p = kpFrame.get(m.t).pt; return [p.x, p.y]; });
            const srcPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcArr);
            const dstPts = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstArr);
            const inlierMask = new cv.Mat();
            const Hfwd = cv.findHomography(srcPts, dstPts, cv.RANSAC, 8.0, inlierMask);
            const inliers = Hfwd && !Hfwd.empty() ? cv.countNonZero(inlierMask) : 0;
            srcPts.delete(); dstPts.delete(); inlierMask.delete();

            setDebugInfo({ good: good.length, inliers });
            const stale = (now - st.bestInliersAt) > 7000;
            if (stale) st.bestInliers = 0;
            if (inliers >= 8 && inliers >= st.bestInliers) {
              st.Hfwd?.delete(); st.Hinv?.delete();
              st.Hfwd = Hfwd;
              st.Hinv = new cv.Mat();
              cv.invert(Hfwd, st.Hinv, cv.DECOMP_SVD);
              st.bestInliers = inliers; st.bestInliersAt = now;
            } else if (Hfwd) { Hfwd.delete(); }
          }
        }
        descFrame.delete(); kpFrame.delete();
      }

      // ── Fingertip -> snapshot -> (u,v) -> lat/lng ──────────────────
      let out = null;
      if (fx !== null && st.Hinv && !st.Hinv.empty() && st.HsnapToUv && bboxRef.current) {
        const p0 = cv.matFromArray(1, 1, cv.CV_32FC2, [fx, fy]);
        const p1 = new cv.Mat();
        cv.perspectiveTransform(p0, p1, st.Hinv);
        const p2 = new cv.Mat();
        cv.perspectiveTransform(p1, p2, st.HsnapToUv);
        const u = p2.data32F[0], v = p2.data32F[1];
        p0.delete(); p1.delete(); p2.delete();
        // Material (u,v) -> window (u,v): undo the letterbox margins.
        // Aliased to lbx/lby: naming these fx/fy would shadow the fingertip
        // fx/fy used above in this same block and throw a TDZ error.
        const { fx: lbx, fy: lby } = fitRef.current;
        const wu = (u - (1 - lbx) / 2) / lbx;
        const wv = (v - (1 - lby) / 2) / lby;

        if (wu >= -0.05 && wu <= 1.05 && wv >= -0.05 && wv <= 1.05) {
          // NB: don't name these cu/cv — `cv` would shadow the OpenCV namespace
          // inside this block, and fx/fy would shadow the fingertip above.
          const su = Math.max(0, Math.min(1, wu));
          const sv = Math.max(0, Math.min(1, wv));
          const g = gridRef.current;
          // Continuous cell coordinates, then per-axis hysteresis: keep the
          // current cell until the finger crosses its boundary by a margin.
          const gx = su * g.cols, gy = sv * g.rows;
          const prev = cellRef.current;
          const pick = (f, prevIdx, n) => {
            const idx = Math.max(0, Math.min(n - 1, Math.floor(f)));
            if (prevIdx == null) return idx;
            return Math.abs(f - (prevIdx + 0.5)) > 0.5 + g.hysteresis ? idx : prevIdx;
          };
          const nx = pick(gx, prev?.x, g.cols);
          const ny = pick(gy, prev?.y, g.rows);
          if (!prev || prev.x !== nx || prev.y !== ny) {
            cellRef.current = { x: nx, y: ny };
            setCell({ x: nx, y: ny });
          }
          // Emit the centre of the snapped cell — stable, repeatable positions.
          const c = cellRef.current;
          out = uvToLngLat((c.x + 0.5) / g.cols, (c.y + 0.5) / g.rows, bboxRef.current);
        }
      }
      if (!out) { cellRef.current = null; setCell(null); }
      setCoord(out); onCoord?.(out);

      drawDebug(fx, fy);
      drawRectified(fx, fy);
      requestAnimationFrame(loop);
    }

    /**
     * Reverse projection: warp the camera's view of the material into a
     * synthetic rectangle at the WINDOW's aspect ratio — the equivalent of the
     * OSM build warping onto the Mapbox canvas, but without needing a map.
     *
     * How to read it: the rectangle IS the Audiom window. If the printed map
     * inside it looks stretched, cropped, or inset from the edges, the material
     * and the window disagree — which is exactly the scaling mismatch that is
     * otherwise invisible. The dashed box shows the artwork area implied by the
     * material dimensions you entered.
     */
    function drawRectified(fx, fy) {
      const panel = rectRef.current;
      const ov = ovRef.current;
      if (!panel && !ov) return;

      const g = gridRef.current;
      // GREEN rectangle == the Audiom window, sized by the aspect discovered
      // from the map's own bounds. Nothing else is drawn in green.
      const A = bboxAspectRef.current || 1.387;
      const W = 320, H = Math.max(60, Math.round(W / A));
      const off = rectOffRef.current;

      const registered = cornerPxRef.current.length >= 4
        && st.Hfwd && !st.Hfwd.empty() && st.HsnapToUv;

      if (!registered) {
        if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
        const c0 = off.getContext('2d');
        c0.clearRect(0, 0, W, H);
        c0.fillStyle = 'rgba(15,23,42,0.5)'; c0.fillRect(0, 0, W, H);
        c0.textAlign = 'center';
        c0.fillStyle = '#cbd5e1'; c0.font = '12px sans-serif';
        c0.fillText('press “Register material”', W / 2, H / 2 - 4);
        c0.fillStyle = '#94a3b8'; c0.font = '10px sans-serif';
        c0.fillText('this box = the Audiom window', W / 2, H / 2 + 12);
      } else {
        const c = cornerPxRef.current;
        const snapPts = cv.matFromArray(4, 1, cv.CV_32FC2,
          [c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
        const camPts = new cv.Mat();
        cv.perspectiveTransform(snapPts, camPts, st.Hfwd); // snapshot -> live camera
        snapPts.delete();
        const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
        const Hcr = cv.getPerspectiveTransform(camPts, dstPts);
        camPts.delete(); dstPts.delete();

        const frame = cv.imread(offRef.current);
        const warped = new cv.Mat();
        cv.warpPerspective(frame, warped, Hcr, new cv.Size(W, H), cv.INTER_LINEAR,
          cv.BORDER_CONSTANT, new cv.Scalar(15, 23, 42, 255));
        frame.delete(); Hcr.delete();
        cv.imshow(off, warped);   // warp once, reuse for panel + overlay
        warped.delete();
      }

      // Fingertip in window space (computed once, drawn on both surfaces)
      let uv = null;
      if (registered && fx !== null && st.Hinv && !st.Hinv.empty()) {
        const p0 = cv.matFromArray(1, 1, cv.CV_32FC2, [fx, fy]);
        const p1 = new cv.Mat(); cv.perspectiveTransform(p0, p1, st.Hinv);
        const p2 = new cv.Mat(); cv.perspectiveTransform(p1, p2, st.HsnapToUv);
        uv = [p2.data32F[0], p2.data32F[1]];
        p0.delete(); p1.delete(); p2.delete();
      }

      const cur = cellRef.current;
      const { fx: lx, fy: ly } = fitRef.current;

      const paint = (ctx, withGrid) => {
        ctx.drawImage(off, 0, 0);

        // ORANGE dashed = artwork area implied by the material dimensions
        if (lx < 0.999 || ly < 0.999) {
          ctx.strokeStyle = '#f97316'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
          ctx.strokeRect(((1 - lx) / 2) * W, ((1 - ly) / 2) * H, lx * W, ly * H);
          ctx.setLineDash([]);
        }
        if (withGrid) {
          ctx.strokeStyle = 'rgba(148,163,184,0.25)'; ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 1; i < g.cols; i++) { const x = (i / g.cols) * W; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
          for (let j = 1; j < g.rows; j++) { const y = (j / g.rows) * H; ctx.moveTo(0, y); ctx.lineTo(W, y); }
          ctx.stroke();
        }
        // YELLOW = where your finger is
        if (cur) {
          ctx.fillStyle = 'rgba(250,204,21,0.35)';
          ctx.fillRect((cur.x / g.cols) * W, (cur.y / g.rows) * H, W / g.cols, H / g.rows);
        }
        if (uv) {
          ctx.beginPath(); ctx.arc(uv[0] * W, uv[1] * H, 6, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(250,204,21,0.95)'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
          ctx.fill(); ctx.stroke();
        }
        // GREEN border + label: this is the window
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, W - 2, H - 2);
        ctx.fillStyle = 'rgba(34,197,94,0.9)';
        ctx.fillRect(1, 1, 132, 14);
        ctx.fillStyle = '#04210f'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`Audiom window ${A.toFixed(3)}`, 5, 11);
        if (ovSizeRef.current) {
          ctx.fillStyle = 'rgba(34,197,94,0.9)';
          ctx.fillRect(W - 92, 1, 91, 14);
          ctx.fillStyle = '#04210f';
          ctx.fillText(`${ovSizeRef.current.w}×${ovSizeRef.current.h} px`, W - 88, 11);
        }
      };

      if (panel) {
        if (panel.width !== W || panel.height !== H) { panel.width = W; panel.height = H; }
        paint(panel.getContext('2d'), true);
      }
      if (ov) {
        if (ov.width !== W || ov.height !== H) { ov.width = W; ov.height = H; }
        const octx = ov.getContext('2d');
        octx.clearRect(0, 0, W, H);
        paint(octx, false); // no grid on the overlay — keeps the map readable

        // Size the box in ACTUAL PIXELS, fitted to the panel. A percentage of
        // panel width made a portrait window taller than the viewport, so its
        // extent ran off-screen. At 100% it exactly fits the panel.
        const wrap = ovWrapRef.current;
        const parent = wrap?.parentElement;
        if (wrap && parent) {
          const pw = parent.clientWidth, ph = parent.clientHeight;
          if (pw && ph) {
            const fitW = Math.min(pw - 24, (ph - 24) * A);       // "contain"
            const boxW = Math.max(120, Math.round(fitW * (overlayPctRef.current / 100)));
            const boxH = Math.round(boxW / A);
            if (wrap.style.width !== `${boxW}px`) {
              wrap.style.width = `${boxW}px`;
              wrap.style.height = `${boxH}px`;
              ovSizeRef.current = { w: boxW, h: boxH };
              setOvSize({ w: boxW, h: boxH });
            }
          }
        }
      }
    }

    // Live camera thumbnail with captured corners + fingertip overlay.
    function drawDebug(fx, fy) {
      const dbg = debugRef.current;
      if (!dbg) return;
      const off = offRef.current;
      const vw = off.width, vh = off.height;
      if (!vw || !vh) return;
      const dw = 320, dh = Math.round((dw * vh) / vw);
      dbg.width = dw; dbg.height = dh;
      const ctx = dbg.getContext('2d');
      const sx = dw / vw, sy = dh / vh;
      ctx.drawImage(off, 0, 0, dw, dh);

      // Deliberately no corner quad here — the ONE rectangle in the UI is the
      // green bounding box on the map. Tracking health is the inliers count.
      // During capture, show only small ticks for corners already locked in.
      if (phaseRef.current === 'capturing') {
        const corners = cornerPxRef.current;
        ctx.fillStyle = 'rgba(250,204,21,0.9)';
        corners.forEach(([x, y]) => {
          ctx.beginPath(); ctx.arc(x * sx, y * sy, 3, 0, Math.PI * 2); ctx.fill();
        });
      }
      if (fx !== null) {
        ctx.beginPath(); ctx.arc(fx * sx, fy * sy, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(250,204,21,0.9)'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
        ctx.fill(); ctx.stroke();
      }
    }

    init().catch((e) => {
      console.error('[TactileExplorerGeneric] init failed:', e);
      setStatus(`Camera error: ${e.name === 'NotAllowedError' ? 'permission denied' : e.message}`);
    });

    return () => {
      cancelled = true;
      runningRef.current = false;
      videoRef.current?.srcObject?.getTracks()?.forEach((t) => t.stop());
      st.Hfwd?.delete(); st.Hinv?.delete(); st.HsnapToUv?.delete();
      st.descTpl?.delete(); st.kpTpl?.delete(); st.sift?.delete(); st.bf?.delete();
      st.Hfwd = st.Hinv = st.HsnapToUv = st.descTpl = st.kpTpl = st.sift = st.bf = null;
    };
  }, [attempt]);

  const progress = phase === 'capturing' ? ` (${cornerIdxRef.current}/4 — ${CORNER_PROMPTS[Math.min(cornerIdxRef.current, 3)]})` : '';

  return (
    <>
      {/* NOT display:none — a hidden video element can be suspended by the
          browser so videoWidth stays 0 and no frames ever reach the canvas.
          Keep it rendered but effectively invisible. */}
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{
          position: 'absolute', top: 0, left: 0,
          width: 2, height: 2, opacity: 0.01,
          pointerEvents: 'none', zIndex: 0,
        }}
      />

      <div className="tactile-controls-panel">
        {/Camera error|no frames/.test(status) && (
          <button
            type="button"
            className="tactile-fix-btn"
            onClick={() => { setStatus('Retrying…'); setAttempt((a) => a + 1); }}
          >
            ⟳ Retry camera
          </button>
        )}
        <button type="button" className="tactile-fix-btn" onClick={startCapture}>
          {phase === 'ready' ? '↻ Re-register [ r ]' : '🎯 Register material [ r ]'}
        </button>
        <button
          type="button"
          className={`tactile-fix-btn ${isFixed ? 'fixed' : ''}`}
          onClick={toggleFixed}
          disabled={phase !== 'ready'}
          title={phase === 'ready'
            ? 'Freeze the current homography (press ; )'
            : 'Register the material first — then Fix freezes the homography'}
        >
          {isFixed ? '🔓 Unfix [ ; ]' : '🔒 Fix [ ; ]'}
        </button>
      </div>

      <div className="tactile-debug-panel">
        <div className="tactile-debug-header">
          <span>
            {status}{progress}
            {camInfo ? ` · ${camInfo.w}×${camInfo.h} ${camInfo.state}` : ' · no camera yet'}
            &nbsp;·&nbsp; good: {debugInfo.good} &nbsp;·&nbsp; inliers: {debugInfo.inliers}
            {gestureHint ? <>&nbsp;·&nbsp;<strong>{gestureHint}</strong></> : null}
          </span>
          <button
            type="button"
            className={`tactile-debug-fix-btn ${isFixed ? 'fixed' : ''}`}
            onClick={toggleFixed}
            title="Freeze the current homography (press ; )"
          >
            {isFixed ? 'Unfix' : 'Fix'}
          </button>
        </div>
        <canvas ref={debugRef} className="tactile-debug-canvas" />
      </div>

      {/* Same rectification, laid over the Audiom map. pointer-events:none so
          you can still drag/zoom the map underneath to line them up. */}
      {overlay && (
        <div
          ref={ovWrapRef}
          className="tactile-rect-overlay"
          style={{ opacity: overlayOpacity }}
        >
          <canvas ref={ovRef} />
        </div>
      )}

      {/* Same rectification as a side panel — redundant once the overlay is on,
          but it adds the quantization grid and stays put while you pan the map. */}
      {showRectPanel && (
      <div className="tactile-rect-panel">
        <div className="tactile-debug-header">
          <span>
            rectified → window
            {bboxAspect ? ` · window ${bboxAspect.toFixed(3)}` : ''}
            {materialAspect ? ` · material ${materialAspect.toFixed(3)}` : ''}
            {materialAspect && bboxAspect && Math.abs(materialAspect / bboxAspect - 1) > 0.01
              ? ` · letterboxed ${(Math.max(1 - fitRef.current.fx, 1 - fitRef.current.fy) * 100).toFixed(0)}%`
              : ''}
          </span>
        </div>
        <canvas ref={rectRef} className="tactile-debug-canvas" />
      </div>
      )}

      {coord && (
        <div className="tactile-coord-hud">
          <div>Finger: {coord.lat.toFixed(6)},&thinsp;{coord.lng.toFixed(6)}</div>
          {cell && <div style={{ fontSize: '0.85em', opacity: 0.8 }}>cell {cell.x},{cell.y} of {cols}×{rows}</div>}
        </div>
      )}
      {!status.startsWith('Tracking') && (
        <div className="tactile-status-hud">{status}{progress}</div>
      )}
    </>
  );
}
