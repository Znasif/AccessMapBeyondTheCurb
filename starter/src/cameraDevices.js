/**
 * Camera acquisition, matching camio-explorer's behaviour.
 *
 * Camera *selection* is left to Chrome. Its permission prompt lists every video
 * input with a live preview and a dropdown, which is a better picker than
 * anything worth rebuilding in-app. To re-choose later, reset the site's camera
 * permission (padlock in the address bar) and reload.
 *
 * What this module fixes is that the app was quietly biasing that pick.
 * `TactileExplorer` and `TactileExplorerGeneric` both requested
 * `facingMode: { ideal: 'environment' }` unconditionally. On a desktop with
 * several inputs — document cam, lid cam, headsets, virtual cams — that hint
 * steers Chrome toward whatever claims to be rear-facing, which is rarely the
 * document camera aimed at the tactile material. camio-explorer applies
 * facingMode on mobile only (CameraViewModel.getCameraFacingMode is gated on
 * `isOnMobile()`); this matches it, so the desktop prompt opens unbiased with
 * every camera offered.
 *
 * The getUserMedia timeout and the 1280x720 constraints are also from
 * camio-explorer's CameraViewModel.
 */

export const STREAM_WIDTH = 1280;
export const STREAM_HEIGHT = 720;
export const GET_USER_MEDIA_TIMEOUT_MS = 15_000;

/** Mirrors camio-explorer's `isOnMobile()` gate on facingMode. */
export function isOnMobile() {
  if (navigator.userAgentData?.mobile !== undefined) return navigator.userAgentData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function hasGetUserMedia() {
  return Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * Why the camera API is unavailable, or null when it is fine.
 *
 * The common cause is not the browser at all: `navigator.mediaDevices` is
 * undefined outside a secure context, so an app served over plain http:// on a
 * LAN address has no camera API whatsoever. This dev server binds 0.0.0.0, so
 * opening Vite's "Network" URL (http://192.168.x.x:5173) instead of the "Local"
 * one silently removes getUserMedia. Localhost is exempt and works over http.
 */
export function cameraSupportProblem() {
  const origin = typeof location !== 'undefined' ? location.origin : 'this page';

  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return (
      `Camera blocked: ${origin} is not a secure context, so the browser does ` +
      `not expose navigator.mediaDevices at all. Open http://localhost:5173 ` +
      `instead of the network address, or start the dev server over HTTPS ` +
      `(VITE_HTTPS=1 npm run dev).`
    );
  }
  if (!navigator.mediaDevices) {
    return `Camera unavailable: navigator.mediaDevices is undefined on ${origin}.`;
  }
  if (!navigator.mediaDevices.getUserMedia) {
    return 'Camera unavailable: this browser does not implement getUserMedia.';
  }
  return null;
}

/**
 * getUserMedia can hang indefinitely — most often when a previous page still
 * holds the device after a reload. Race it so the caller surfaces an error
 * instead of sitting on "Opening camera…" forever.
 */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

/**
 * Video constraints for the tactile explorers.
 *
 * `relaxed` drops to bare `video: true` for the retry path, where a desktop can
 * otherwise return a device that opens but never produces frames.
 */
export function buildVideoConstraints({ relaxed = false } = {}) {
  if (relaxed) return { video: true, audio: false };

  const video = {
    width: { ideal: STREAM_WIDTH },
    height: { ideal: STREAM_HEIGHT },
  };

  // Only hint at a rear camera on mobile, where "environment" means something.
  // On desktop, stay silent and let Chrome's prompt present the full list.
  if (isOnMobile()) video.facingMode = { ideal: 'environment' };

  return { video, audio: false };
}

/** Open a camera stream with the timeout guard applied. */
export async function openCameraStream({ relaxed = false } = {}) {
  const problem = cameraSupportProblem();
  if (problem) throw new Error(problem);
  return withTimeout(
    navigator.mediaDevices.getUserMedia(buildVideoConstraints({ relaxed })),
    GET_USER_MEDIA_TIMEOUT_MS,
    'Camera did not start in time. Reload the page and make sure no other app or tab is using it.',
  );
}
