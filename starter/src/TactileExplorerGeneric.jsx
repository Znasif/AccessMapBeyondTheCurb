import { useEffect, useRef, useState } from 'react';
import cv from '@techstark/opencv-js';
import { uvToLngLat } from './audiom';

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
const speak = (t) => {
  try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(new SpeechSynthesisUtterance(t)); }
  catch { /* noop */ }
};
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
export function TactileExplorerGeneric({ bbox, onCoord, cols = 43, rows = 31, hysteresis = 0.3 }) {
  const videoRef = useRef(null);
  const offRef = useRef(document.createElement('canvas')); // clean frame for AKAZE
  const debugRef = useRef(null);
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
  });

  const [status, setStatus] = useState('Initializing…');
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
      st.bestInliers = 0; st.bestInliersAt = 0;
    }

    async function init() {
      setStatus('Loading hand model…');
      const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      st.hl = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO', numHands: 1,
      });
      if (cancelled) return;

      setStatus('Loading OpenCV…');
      await waitForOpenCV();
      if (cancelled) return;

      st.sift = new cv.AKAZE();
      st.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);

      // First try prefers a rear/environment camera at 720p. Retries fall back
      // to plain `video: true`, which succeeds on desktops where the constrained
      // request can return a device that never produces frames.
      setStatus(attempt === 0 ? 'Opening camera…' : 'Opening camera (any device)…');
      const constraints = attempt === 0
        ? { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'environment' } } }
        : { video: true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
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

    function loop() {
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
      let fx = null, fy = null;
      if (result.landmarks?.length) {
        const tip = result.landmarks[0][8]; // index-finger tip
        fx = st.oefX(tip.x * vw, now);
        fy = st.oefY(tip.y * vh, now);
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
        if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) {
          const cu = Math.max(0, Math.min(1, u));
          const cv = Math.max(0, Math.min(1, v));
          const g = gridRef.current;
          // Continuous cell coordinates, then per-axis hysteresis: keep the
          // current cell until the finger crosses its boundary by a margin.
          const fx = cu * g.cols, fy = cv * g.rows;
          const prev = cellRef.current;
          const pick = (f, prevIdx, n) => {
            const idx = Math.max(0, Math.min(n - 1, Math.floor(f)));
            if (prevIdx == null) return idx;
            return Math.abs(f - (prevIdx + 0.5)) > 0.5 + g.hysteresis ? idx : prevIdx;
          };
          const nx = pick(fx, prev?.x, g.cols);
          const ny = pick(fy, prev?.y, g.rows);
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
      requestAnimationFrame(loop);
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

      // captured corners already collected (snapshot space == capture-time frame)
      const corners = cornerPxRef.current;
      if (corners.length) {
        ctx.strokeStyle = '#22c55e'; ctx.fillStyle = '#22c55e'; ctx.lineWidth = 2;
        ctx.beginPath();
        corners.forEach(([x, y], i) => {
          const px = x * sx, py = y * sy;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        if (corners.length === 4) ctx.closePath();
        ctx.stroke();
        corners.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x * sx, y * sy, 4, 0, Math.PI * 2); ctx.fill(); });
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
          title="Freeze the current homography (press ; )"
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
          </span>
        </div>
        <canvas ref={debugRef} className="tactile-debug-canvas" />
      </div>

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
