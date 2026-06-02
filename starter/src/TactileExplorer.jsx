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
export function TactileExplorer({
  bbox,
  mapRef,
  mapLoadedRef,
  templateUrl = '/braille.png',
  onCoord,
  groundTruthProbe,
}) {
  const videoRef   = useRef(null);
  const offRef     = useRef(document.createElement('canvas')); // clean frame for ORB
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
    tick: 0,
  });
  const bboxRef = useRef(bbox);
  useEffect(() => { bboxRef.current = bbox; }, [bbox]);

  const [status, setStatus]   = useState('Initializing…');
  const [coord, setCoord]     = useState(null);
  const [debugInfo, setDebugInfo] = useState({ good: 0, inliers: 0 });

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

      // AKAZE: works on real photos (device text/border/logos), always in standard builds.
      // Future: restrict to a border-only mask so inner pin changes don't matter.
      st.sift  = new cv.AKAZE();
      st.kpTpl = new cv.KeyPointVector();
      st.descTpl = new cv.Mat();
      const emptyMask = new cv.Mat();
      st.sift.detectAndCompute(tplGray, emptyMask, st.kpTpl, st.descTpl);
      emptyMask.delete();
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
      const result = st.hl.detectForVideo(video, performance.now());
      let fx = null, fy = null;
      if (result.landmarks?.length) {
        const tip = result.landmarks[0][8];
        fx = tip.x * vw;
        fy = tip.y * vh;
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
            // Require at least 8 inliers — fewer means an unreliable/degenerate H
            if (inliers >= 8) {
              st.Hfwd?.delete(); st.Hinv?.delete();
              st.Hfwd = Hfwd;
              st.Hinv = new cv.Mat();
              cv.invert(Hfwd, st.Hinv, cv.DECOMP_SVD);
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
        // Screen positions of the four bbox corners
        const tl = map.project([minLng, maxLat]);
        const tr = map.project([maxLng, maxLat]);
        const br = map.project([maxLng, minLat]);
        const bl = map.project([minLng, minLat]);

        // Two-pass warp — avoids matrix composition (cv.gemm is unreliable here).
        // Pass 1: camera frame → template space via Hinv
        const frameMat   = cv.imread(off);
        const tplAligned = new cv.Mat();
        cv.warpPerspective(
          frameMat, tplAligned, st.Hinv,
          new cv.Size(st.tplW, st.tplH),
          cv.INTER_LINEAR,
          cv.BORDER_CONSTANT,
          new cv.Scalar(0, 0, 0, 0),
        );
        frameMat.delete();

        // Pass 2: template space → screen via 4-point exact transform
        const tplPts = cv.matFromArray(4, 1, cv.CV_32FC2,
          [0, 0, st.tplW, 0, st.tplW, st.tplH, 0, st.tplH]);
        const scrPts = cv.matFromArray(4, 1, cv.CV_32FC2,
          [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
        const H_tpl_to_scr = cv.getPerspectiveTransform(tplPts, scrPts);
        tplPts.delete(); scrPts.delete();

        const warped = new cv.Mat();
        cv.warpPerspective(
          tplAligned, warped, H_tpl_to_scr,
          new cv.Size(screenW, screenH),
          cv.INTER_LINEAR,
          cv.BORDER_CONSTANT,
          new cv.Scalar(0, 0, 0, 0),
        );
        tplAligned.delete(); H_tpl_to_scr.delete();

        cv.imshow(overlay, warped);
        warped.delete();
      } else {
        // No homography yet — clear overlay
        overlay.width  = screenW;
        overlay.height = screenH;
        overlay.getContext('2d').clearRect(0, 0, screenW, screenH);
      }

      // ── Finger dot at map-projected position ───────────────────────
      if (fx !== null && st.Hinv && !st.Hinv.empty() && map && mapLoadedRef?.current && bb) {
        const [minLng, minLat, maxLng, maxLat] = bb;
        const src = cv.matFromArray(1, 1, cv.CV_32FC2, [fx, fy]);
        const dst = new cv.Mat();
        cv.perspectiveTransform(src, dst, st.Hinv);
        const tx = dst.data32F[0], ty = dst.data32F[1];
        src.delete(); dst.delete();

        const nx = tx / st.tplW, ny = ty / st.tplH;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
          const lng = minLng + nx * (maxLng - minLng);
          const lat = maxLat - ny * (maxLat - minLat);
          const pt  = map.project([lng, lat]);

          const ctx = overlay.getContext('2d');
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
          ctx.fillStyle   = 'rgba(250, 204, 21, 0.9)';
          ctx.strokeStyle = '#000';
          ctx.lineWidth   = 2;
          ctx.fill();
          ctx.stroke();

          const newCoord = { lng, lat };
          setCoord(newCoord);
          onCoord?.(newCoord);
          return requestAnimationFrame(loop);
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
      st.Hfwd?.delete(); st.Hinv?.delete();
      st.descTpl?.delete(); st.kpTpl?.delete();
      st.sift?.delete(); st.bf?.delete();
      st.Hfwd = st.Hinv = st.descTpl = st.kpTpl = st.sift = st.bf = null;
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
