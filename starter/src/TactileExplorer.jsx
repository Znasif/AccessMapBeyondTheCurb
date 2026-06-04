import { useEffect, useRef, useState } from 'react';
import cv from '@techstark/opencv-js';

const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm';
const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

function waitForOpenCV() {
  return new Promise(resolve => {
    if (cv.Mat) { resolve(); return; }
    cv.onRuntimeInitialized = resolve;
  });
}

// One Euro Filter — speed-adaptive low-pass filter for noisy tracking input.
// High velocity → low smoothing (responsive); low velocity → high smoothing (jitter suppressed).
// Casiez et al. 2012, CHI. Parameters: minCutoff=1Hz, beta=0.007, dCutoff=1Hz.
function makeOneEuroFilter(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
  let xFilt = null, dxFilt = 0, lastT = null;
  const alpha = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return function filter(x, t) {
    if (lastT === null) { xFilt = x; lastT = t; return x; }
    const dt = Math.max((t - lastT) / 1000, 1e-6); // ms → s
    lastT = t;
    const dx = (x - xFilt) / dt;
    dxFilt = dxFilt + alpha(dCutoff, dt) * (dx - dxFilt);
    const cutoff = minCutoff + beta * Math.abs(dxFilt);
    xFilt = xFilt + alpha(cutoff, dt) * (x - xFilt);
    return xFilt;
  };
}

/**
 * Warps the camera's view of the physical braille.png back onto the digital
 * map using continuous ORB template matching (handles perspective + movement).
 *
 * Pipeline each frame:
 *   camera frame
 *     → Hinv (ORB homography, camera → template)
 *     → H_tpl_to_scr (map.project bbox corners → screen)
 *   Composed H_cam_to_scr = H_tpl_to_scr × Hinv
 *     → cv.warpPerspective → overlay canvas (alpha=0 outside map boundary)
 *
 * Template note: currently uses full braille.png for ORB keypoints.
 * Future: mask to outer border strip only so inner road changes don't
 * affect detection stability.
 */
const DEVICE_ROWS = 31;
const DEVICE_COLS = 43;

export function TactileExplorer({
  bbox,
  mapRef,
  mapLoadedRef,
  templateUrl = '/braille.png',
  pinGridRef,
  onCoord,
  groundTruthProbe,
}) {
  const videoRef   = useRef(null);
  const offRef     = useRef(document.createElement('canvas')); // clean frame for ORB
  const tplPinPosRef  = useRef(null); // Float32Array of template-space (x,y) for each pin, row-major
  const tplCornersRef = useRef(null); // [[x,y]×4] calibrated corners in template pixels (TL,TR,BR,BL)
  const overlayRef = useRef(null);
  const debugRef   = useRef(null);
  const runningRef = useRef(false);

  const s = useRef({
    hl: null,         // HandLandmarker
    sift: null,
    bf: null,
    kpTpl: null,
    descTpl: null,
    tplW: 0,
    tplH: 0,
    Hfwd: null,       // template → camera frame
    Hinv: null,       // camera frame → template
    Hcs:  null,       // camera frame → screen (reused by finger dot each frame)
    bestInliers: 0,
    bestInliersAt: 0,  // performance.now() of last improvement
    tick: 0,
    oefX: makeOneEuroFilter(),
    oefY: makeOneEuroFilter(),
  });
  const bboxRef = useRef(bbox);
  useEffect(() => { bboxRef.current = bbox; }, [bbox]);

  const [status, setStatus]   = useState('Initializing…');
  const [coord, setCoord]     = useState(null);
  const [debugInfo, setDebugInfo] = useState({ good: 0, inliers: 0 });

  // Load calibrated corner positions from brailledoodle_corners.json and
  // precompute template-space (x, y) for every pin via bilinear interpolation.
  useEffect(() => {
    fetch('/brailledoodle_corners.json')
      .then((r) => r.json())
      .then((data) => {
        const corners = Object.values(data)[0];
        if (!corners || corners.length < 4) return;
        tplCornersRef.current = corners; // store raw [TL,TR,BR,BL] pixel coords
        const [tl, tr, br, bl] = corners;
        const arr = new Float32Array(DEVICE_ROWS * DEVICE_COLS * 2);
        for (let row = 0; row < DEVICE_ROWS; row++) {
          const v = row / (DEVICE_ROWS - 1);
          for (let col = 0; col < DEVICE_COLS; col++) {
            const u = col / (DEVICE_COLS - 1);
            const idx = (row * DEVICE_COLS + col) * 2;
            arr[idx]     = (1-u)*(1-v)*tl[0] + u*(1-v)*tr[0] + u*v*br[0] + (1-u)*v*bl[0];
            arr[idx + 1] = (1-u)*(1-v)*tl[1] + u*(1-v)*tr[1] + u*v*br[1] + (1-u)*v*bl[1];
          }
        }
        tplPinPosRef.current = arr;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const st = s.current;
    let cancelled = false;

    async function init() {
      setStatus('Loading hand model…');
      const { HandLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      st.hl = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 1,
      });
      if (cancelled) return;

      setStatus('Loading OpenCV…');
      await waitForOpenCV();
      if (cancelled) return;

      setStatus('Extracting template features…');
      const img = await new Promise((res, rej) => {
        const el = new Image();
        el.onload  = () => res(el);
        el.onerror = () => rej(new Error(`Cannot load template: ${templateUrl}`));
        el.src = templateUrl;
      });
      const tplCanvas = Object.assign(document.createElement('canvas'), {
        width: img.naturalWidth, height: img.naturalHeight,
      });
      tplCanvas.getContext('2d').drawImage(img, 0, 0);
      st.tplW = img.naturalWidth;
      st.tplH = img.naturalHeight;

      const tplMat  = cv.imread(tplCanvas);
      const tplGray = new cv.Mat();
      cv.cvtColor(tplMat, tplGray, cv.COLOR_RGBA2GRAY);
      tplMat.delete();

      // AKAZE restricted to a border-only mask: the dot grid interior is a
      // periodic texture that produces phantom homographies shifted by N grid
      // spacings. Only the outer border strip (corners, clips, text) has unique
      // features that can anchor a correct homography.
      st.sift  = new cv.AKAZE();
      st.kpTpl = new cv.KeyPointVector();
      st.descTpl = new cv.Mat();

      const borderMask = new cv.Mat(st.tplH, st.tplW, cv.CV_8UC1, new cv.Scalar(0));
      const bw = Math.round(st.tplW * 0.12); // 12% strip on each side
      const bh = Math.round(st.tplH * 0.12);
      // Top strip
      borderMask.roi(new cv.Rect(0, 0, st.tplW, bh)).setTo(new cv.Scalar(255));
      // Bottom strip
      borderMask.roi(new cv.Rect(0, st.tplH - bh, st.tplW, bh)).setTo(new cv.Scalar(255));
      // Left strip (full height to fill corners)
      borderMask.roi(new cv.Rect(0, 0, bw, st.tplH)).setTo(new cv.Scalar(255));
      // Right strip
      borderMask.roi(new cv.Rect(st.tplW - bw, 0, bw, st.tplH)).setTo(new cv.Scalar(255));

      st.sift.detectAndCompute(tplGray, borderMask, st.kpTpl, st.descTpl);
      borderMask.delete();
      tplGray.delete();

      // HAMMING norm for AKAZE binary descriptors; crossCheck=false needed for knnMatch
      st.bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
      if (cancelled) return;

      setStatus('Opening camera…');
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: { ideal: 'environment' },
        },
      });
      if (cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      setStatus('Searching for map…');
      runningRef.current = true;
      requestAnimationFrame(loop);
    }

    function loop() {
      if (!runningRef.current || cancelled) return;
            const video  = videoRef.current;
      const overlay = overlayRef.current;
      if (!video || !overlay) { requestAnimationFrame(loop); return; }

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) { requestAnimationFrame(loop); return; }

      // Capture clean frame to offscreen canvas — ORB reads from here.
      const off = offRef.current;
      off.width = vw;
      off.height = vh;
      off.getContext('2d').drawImage(video, 0, 0);

      // ── Hand detection ─────────────────────────────────────────────
      const now = performance.now();
      const result = st.hl.detectForVideo(video, now);
      let fx = null, fy = null;
      if (result.landmarks?.length) {
        const tip = result.landmarks[0][8];
        fx = st.oefX(tip.x * vw, now);
        fy = st.oefY(tip.y * vh, now);
      }

      // ── SIFT + homography (every 6 frames) ─────────────────────────
      st.tick++;
      if (st.tick % 6 === 0 && st.descTpl?.rows > 0) {
        const frameMat  = cv.imread(off);
        const frameGray = new cv.Mat();
        cv.cvtColor(frameMat, frameGray, cv.COLOR_RGBA2GRAY);
        frameMat.delete();

        const kpFrame   = new cv.KeyPointVector();
        const descFrame = new cv.Mat();
        const mask      = new cv.Mat();
        st.sift.detectAndCompute(frameGray, mask, kpFrame, descFrame); // st.sift = AKAZE instance
        mask.delete();
        frameGray.delete();

        if (descFrame.rows >= 4) {
          // kNN (k=2) + Lowe's ratio test — far more discriminative than a fixed distance
          const knnMatches = new cv.DMatchVectorVector();
          st.bf.knnMatch(st.descTpl, descFrame, knnMatches, 2);

          const good = [];
          for (let i = 0; i < knnMatches.size(); i++) {
            const pair = knnMatches.get(i);
            if (pair.size() >= 2 && pair.get(0).distance < 0.75 * pair.get(1).distance) {
              good.push({ queryIdx: pair.get(0).queryIdx, trainIdx: pair.get(0).trainIdx });
            }
          }
          knnMatches.delete();

          if (good.length >= 8) {
            const srcArr = good.flatMap(m => { const p = st.kpTpl.get(m.queryIdx).pt; return [p.x, p.y]; });
            const dstArr = good.flatMap(m => { const p = kpFrame.get(m.trainIdx).pt; return [p.x, p.y]; });
            const srcPts    = cv.matFromArray(good.length, 1, cv.CV_32FC2, srcArr);
            const dstPts    = cv.matFromArray(good.length, 1, cv.CV_32FC2, dstArr);
            const inlierMask = new cv.Mat();
            const Hfwd      = cv.findHomography(srcPts, dstPts, cv.RANSAC, 8.0, inlierMask);
            const inliers   = Hfwd && !Hfwd.empty() ? cv.countNonZero(inlierMask) : 0;
            srcPts.delete(); dstPts.delete(); inlierMask.delete();

            setDebugInfo({ good: good.length, inliers });
            const stale = (now - st.bestInliersAt) > 7000;
            if (stale) st.bestInliers = 0;
            if (inliers >= 8 && inliers >= st.bestInliers) {
              st.Hfwd?.delete(); st.Hinv?.delete();
              st.Hfwd = Hfwd;
              st.Hinv = new cv.Mat();
              cv.invert(Hfwd, st.Hinv, cv.DECOMP_SVD);
              st.bestInliers = inliers;
              st.bestInliersAt = now;
              setStatus('Tracking');
            } else {
              Hfwd?.delete();
            }
          }
        }
        descFrame.delete(); kpFrame.delete();
      }

      // ── Warp camera view onto map overlay ──────────────────────────
      const map = mapRef?.current;
      const bb  = bboxRef.current;
      const screenW = overlay.parentElement?.clientWidth  ?? 800;
      const screenH = overlay.parentElement?.clientHeight ?? 600;

      if (st.Hfwd && !st.Hfwd.empty() && map && mapLoadedRef?.current && bb) {
        const [minLng, minLat, maxLng, maxLat] = bb;
        const tl = map.project([minLng, maxLat]);
        const tr = map.project([maxLng, maxLat]);
        const br = map.project([maxLng, minLat]);
        const bl = map.project([minLng, minLat]);

        const tc = tplCornersRef.current;
        const tcArr = tc
          ? [tc[0][0], tc[0][1], tc[1][0], tc[1][1], tc[2][0], tc[2][1], tc[3][0], tc[3][1]]
          : [0, 0, st.tplW, 0, st.tplW, st.tplH, 0, st.tplH];
        const scrArr = [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y];

        // Project tc corners through Hfwd → their positions in the camera frame,
        // then warp directly from camera to screen in one pass.
        const tplPtsMat = cv.matFromArray(4, 1, cv.CV_32FC2, tcArr);
        const camPtsMat = new cv.Mat();
        cv.perspectiveTransform(tplPtsMat, camPtsMat, st.Hfwd);
        tplPtsMat.delete();

        const scrPtsMat = cv.matFromArray(4, 1, cv.CV_32FC2, scrArr);
        const H_cam_to_scr = cv.getPerspectiveTransform(camPtsMat, scrPtsMat);
        camPtsMat.delete(); scrPtsMat.delete();

        const frameMat = cv.imread(off);
        const warped = new cv.Mat();
        cv.warpPerspective(frameMat, warped, H_cam_to_scr,
          new cv.Size(screenW, screenH), cv.INTER_LINEAR,
          cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
        frameMat.delete();
        st.Hcs?.delete();
        st.Hcs = H_cam_to_scr; // kept alive for finger dot this frame

        cv.imshow(overlay, warped);
        warped.delete();

        // Draw pin dots — project calibrated template positions through
        // H_tpl_to_scr (tc corners → screen) so dots align with physical holes.
        const tplPinPos = tplPinPosRef.current;
        const pinGrid   = pinGridRef?.current;
        if (tplPinPos && pinGrid) {
          const tplPtsMat2 = cv.matFromArray(4, 1, cv.CV_32FC2, tcArr);
          const scrPtsMat2 = cv.matFromArray(4, 1, cv.CV_32FC2, scrArr);
          const H_tpl_to_scr = cv.getPerspectiveTransform(tplPtsMat2, scrPtsMat2);
          tplPtsMat2.delete(); scrPtsMat2.delete();

          const n      = DEVICE_ROWS * DEVICE_COLS;
          const srcMat = cv.matFromArray(n, 1, cv.CV_32FC2, tplPinPos);
          const dstMat = new cv.Mat();
          cv.perspectiveTransform(srcMat, dstMat, H_tpl_to_scr);
          srcMat.delete(); H_tpl_to_scr.delete();

          const ctx = overlay.getContext('2d');
          for (let i = 0; i < n; i++) {
            const sx = dstMat.data32F[i * 2];
            const sy = dstMat.data32F[i * 2 + 1];
            if (sx < -20 || sx > screenW + 20 || sy < -20 || sy > screenH + 20) continue;
            const up = pinGrid[i] > 0;
            ctx.beginPath();
            ctx.arc(sx, sy, up ? 3.5 : 2, 0, Math.PI * 2);
            ctx.fillStyle = up ? 'rgba(250,204,21,0.95)' : 'rgba(200,200,200,0.18)';
            ctx.fill();
          }
          dstMat.delete();
        }
      } else {
        // No homography yet — clear overlay
        overlay.width  = screenW;
        overlay.height = screenH;
        overlay.getContext('2d').clearRect(0, 0, screenW, screenH);
      }

      // ── Finger dot — project camera position directly to screen ──────
      if (fx !== null && st.Hcs && !st.Hcs.empty()) {
        const src = cv.matFromArray(1, 1, cv.CV_32FC2, [fx, fy]);
        const dst = new cv.Mat();
        cv.perspectiveTransform(src, dst, st.Hcs);
        const sx = dst.data32F[0], sy = dst.data32F[1];
        src.delete(); dst.delete();

        // Only draw if the fingertip falls inside the warped pin region
        if (sx >= 0 && sx <= screenW && sy >= 0 && sy <= screenH) {
          const ctx = overlay.getContext('2d');
          ctx.beginPath();
          ctx.arc(sx, sy, 10, 0, Math.PI * 2);
          ctx.fillStyle   = 'rgba(250, 204, 21, 0.9)';
          ctx.strokeStyle = '#000';
          ctx.lineWidth   = 2;
          ctx.fill();
          ctx.stroke();

          if (map && mapLoadedRef?.current) {
            const { lng, lat } = map.unproject([sx, sy]);
            const newCoord = { lng, lat };
            setCoord(newCoord);
            onCoord?.(newCoord);
            return requestAnimationFrame(loop);
          }
        }
      }

      setCoord(null);
      onCoord?.(null);

      // ── Debug panel: live camera + projected template corners ─────
      const dbg = debugRef.current;
      if (dbg) {
        const dw = 320;
        const dh = Math.round(dw * vh / vw);
        dbg.width  = dw;
        dbg.height = dh;
        const dCtx = dbg.getContext('2d');
        dCtx.drawImage(off, 0, 0, dw, dh);

        if (st.Hfwd && !st.Hfwd.empty()) {
          const tplC = cv.matFromArray(4, 1, cv.CV_32FC2,
            [0, 0, st.tplW, 0, st.tplW, st.tplH, 0, st.tplH]);
          const camC = new cv.Mat();
          cv.perspectiveTransform(tplC, camC, st.Hfwd);
          tplC.delete();
          const sx = dw / vw, sy = dh / vh;
          dCtx.beginPath();
          for (let i = 0; i < 4; i++) {
            const x = camC.data32F[i * 2] * sx;
            const y = camC.data32F[i * 2 + 1] * sy;
            i === 0 ? dCtx.moveTo(x, y) : dCtx.lineTo(x, y);
          }
          dCtx.closePath();
          dCtx.strokeStyle = '#22c55e';
          dCtx.lineWidth = 2;
          dCtx.stroke();
          camC.delete();
        }
      }

      requestAnimationFrame(loop);
    }

    init().catch(e => {
      console.error('[TactileExplorer]', e);
      setStatus(`Error: ${e.message}`);
    });

    return () => {
      cancelled = true;
      runningRef.current = false;
      videoRef.current?.srcObject?.getTracks()?.forEach(t => t.stop());
      st.Hfwd?.delete(); st.Hinv?.delete(); st.Hcs?.delete();
      st.descTpl?.delete(); st.kpTpl?.delete();
      st.sift?.delete(); st.bf?.delete();
      st.Hfwd = st.Hinv = st.Hcs = st.descTpl = st.kpTpl = st.sift = st.bf = null;
      st.bestInliers = 0;
      st.bestInliersAt = 0;
      st.oefX = makeOneEuroFilter();
      st.oefY = makeOneEuroFilter();
    };
  }, [templateUrl]);

  // Compute live distance to ground-truth probe
  const probeDistMeters = (coord && groundTruthProbe) ? (() => {
    const toRad = d => d * Math.PI / 180;
    const R = 6371000;
    const dLat = toRad(groundTruthProbe.lat - coord.lat);
    const dLng = toRad(groundTruthProbe.lng - coord.lng);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(coord.lat)) * Math.cos(toRad(groundTruthProbe.lat)) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  })() : null;

  return (
    <>
      <video ref={videoRef} muted playsInline style={{ display: 'none' }} />
      <canvas ref={overlayRef} className="tactile-map-overlay" />

      {/* Debug panel — remove once overlay alignment is confirmed */}
      <div className="tactile-debug-panel">
        <div className="tactile-debug-header">
          {status} &nbsp;·&nbsp; good: {debugInfo.good} &nbsp;·&nbsp; inliers: {debugInfo.inliers}
        </div>
        <canvas ref={debugRef} className="tactile-debug-canvas" />
      </div>

      {coord && (
        <div className="tactile-coord-hud">
          <div>Finger: {coord.lat.toFixed(6)},&thinsp;{coord.lng.toFixed(6)}</div>
          {groundTruthProbe && (
            <div style={{ color: '#facc15', fontSize: '0.85em' }}>
              Probe: {groundTruthProbe.lat.toFixed(6)},&thinsp;{groundTruthProbe.lng.toFixed(6)}
            </div>
          )}
          {probeDistMeters !== null && (
            <div style={{
              color: probeDistMeters < 5 ? '#22c55e' : probeDistMeters < 15 ? '#facc15' : '#ef4444',
              fontWeight: 'bold',
              fontSize: '1.1em',
            }}>
              Δ {probeDistMeters < 1 ? probeDistMeters.toFixed(2) : probeDistMeters.toFixed(1)} m
            </div>
          )}
        </div>
      )}
      {!coord && groundTruthProbe && (
        <div className="tactile-coord-hud" style={{ opacity: 0.7 }}>
          <div style={{ color: '#facc15' }}>Probe set — point at it</div>
          <div style={{ fontSize: '0.85em' }}>
            {groundTruthProbe.lat.toFixed(6)},&thinsp;{groundTruthProbe.lng.toFixed(6)}
          </div>
        </div>
      )}
      {status !== 'Tracking' && (
        <div className="tactile-status-hud">{status}</div>
      )}
    </>
  );
}
