/**
 * Pointing-gesture recognition for MediaPipe HandLandmarker results.
 *
 * Ported from camio-explorer (src/explore/models/GestureRecognizer.ts) so both
 * apps agree on what "pointing" means.
 *
 * Before this module, the explorers here read `result.landmarks[0][8]` — the
 * index fingertip of whichever hand MediaPipe happened to list first —
 * regardless of whether that hand was pointing at all. A flat palm, a fist, a
 * hand reaching past the material, or a second person's hand entering frame all
 * produced a confident cursor. During corner registration that means a dwell
 * can be locked by a hand that never pointed.
 *
 * Method: for each finger measure "straightness" — the straight-line distance
 * from its knuckle (MCP) to its tip, divided by the summed length of its three
 * bone segments. A perfectly straight finger approaches 1.0; a curled one falls
 * well below. A pointing hand has an extended index and three curled fingers.
 *
 * MediaPipe hand landmark indices:
 *   index  5→8    middle  9→12    ring  13→16    pinky  17→20
 */

/** Index-fingertip landmark — the point the explorers track. */
export const INDEX_TIP = 8;

/** Knuckle (MCP) landmark that starts each finger's 4-point chain. */
const FINGER_MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };

/** Index must be at least this straight to count as extended. */
const INDEX_EXTENDED_MIN = 0.7;

/** Middle, ring and pinky must each be below this to count as curled. */
const OTHER_CURLED_MAX = 0.95;

const DETECTED_NO_HANDS = Object.freeze({
  detected: false,
  pointing: false,
  tooManyHandsPointing: false,
  pointingHandLandmarks: null,
  tip: null,
});

const TOO_MANY_HANDS_POINTING = Object.freeze({
  detected: true,
  pointing: false,
  tooManyHandsPointing: true,
  pointingHandLandmarks: null,
  tip: null,
});

function dist(a, b) {
  const x = a.x - b.x;
  const y = a.y - b.y;
  const z = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Straightness of one finger: |MCP→TIP| / (|MCP→PIP| + |PIP→DIP| + |DIP→TIP|).
 * Returns 0 when the landmarks are missing.
 */
export function fingerStraightness(landmarks, mcpIndex) {
  const p0 = landmarks[mcpIndex];
  const p1 = landmarks[mcpIndex + 1];
  const p2 = landmarks[mcpIndex + 2];
  const p3 = landmarks[mcpIndex + 3];
  if (!p0 || !p1 || !p2 || !p3) return 0;

  const chain = dist(p0, p1) + dist(p1, p2) + dist(p2, p3);
  if (chain <= 0) return 0;
  return dist(p0, p3) / chain;
}

/** True when one hand's 21 landmarks form an index-pointing gesture. */
export function isPointingHand(landmarks) {
  if (!landmarks || landmarks.length < 21) return false;
  if (fingerStraightness(landmarks, FINGER_MCP.index) < INDEX_EXTENDED_MIN) return false;
  if (fingerStraightness(landmarks, FINGER_MCP.middle) > OTHER_CURLED_MAX) return false;
  if (fingerStraightness(landmarks, FINGER_MCP.ring) > OTHER_CURLED_MAX) return false;
  if (fingerStraightness(landmarks, FINGER_MCP.pinky) > OTHER_CURLED_MAX) return false;
  return true;
}

/**
 * Classify a HandLandmarker VIDEO result.
 *
 * Requires `numHands: 2` on the landmarker — with `numHands: 1` a second
 * pointing hand is invisible and `tooManyHandsPointing` can never fire, which
 * is the ambiguity this is meant to catch.
 *
 * @returns {{detected: boolean, pointing: boolean, tooManyHandsPointing: boolean,
 *            pointingHandLandmarks: object[]|null, tip: object|null}}
 */
export function recognizePointing(result) {
  const hands = result?.landmarks;
  if (!hands || hands.length === 0) return DETECTED_NO_HANDS;

  let pointingHandLandmarks = null;
  let pointingCount = 0;

  for (const landmarks of hands) {
    if (!isPointingHand(landmarks)) continue;
    pointingCount += 1;
    if (pointingCount > 1) return TOO_MANY_HANDS_POINTING;
    pointingHandLandmarks = landmarks;
  }

  if (pointingCount !== 1) {
    return { ...DETECTED_NO_HANDS, detected: true };
  }

  return {
    detected: true,
    pointing: true,
    tooManyHandsPointing: false,
    pointingHandLandmarks,
    tip: pointingHandLandmarks[INDEX_TIP] ?? null,
  };
}

/** Human-readable reason the cursor is currently suppressed, or null. */
export function pointingHint(state) {
  if (!state) return null;
  if (state.tooManyHandsPointing) return 'Point with only one hand.';
  if (!state.detected) return 'No hand detected.';
  if (!state.pointing) return 'Point with your index finger, other fingers curled.';
  return null;
}

/**
 * Stateful wrapper that holds the last good pointing result for `graceMs` after
 * the gesture drops out.
 *
 * Landmark inference on a handheld camera drops single frames constantly — at a
 * hard per-frame gate the cursor strobes, which for a blind user reads as the
 * app losing their finger. The grace window keeps the gesture requirement
 * strict while absorbing that noise. Set graceMs to 0 for camio-explorer's
 * exact frame-by-frame behaviour.
 */
export function createPointingTracker({ graceMs = 120 } = {}) {
  let lastPointing = null;
  let lastPointingAt = -Infinity;

  return {
    /**
     * @param result HandLandmarkerResult
     * @param nowMs  performance.now()
     * @returns the recognizer state, with `held` true when the result is being
     *          carried over from a recent frame rather than seen this frame.
     */
    update(result, nowMs) {
      const state = recognizePointing(result);

      if (state.pointing) {
        lastPointing = state;
        lastPointingAt = nowMs;
        return { ...state, held: false };
      }

      // A second pointing hand is a genuine ambiguity, not sensor noise —
      // never paper over it with a held frame.
      if (!state.tooManyHandsPointing &&
          lastPointing &&
          nowMs - lastPointingAt <= graceMs) {
        return { ...lastPointing, held: true };
      }

      lastPointing = null;
      return { ...state, held: false };
    },

    reset() {
      lastPointing = null;
      lastPointingAt = -Infinity;
    },
  };
}
