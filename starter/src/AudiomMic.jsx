import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createNarrator, createRecognizer, linkBargeIn, SttMode } from './lib/speech/index.js';
import { setSpeaker } from './lib/speak';
import { matchL0 } from './lib/l0';

/**
 * The microphone affordance — milestone S's whole UI surface.
 *
 * Everything with logic in it lives in `lib/speech/` and is covered by
 * `scripts/test_speech.mjs` in Node. This component is the three things that can
 * only exist in a browser:
 *
 *  1. **The user gesture.** Browsers gate both microphone access and
 *     `speechSynthesis` behind one. This button is that gesture: it arms the
 *     narrator's queue and opens the microphone in the same click.
 *  2. **The visible degradation.** Plan §7.2 item 2 requires that falling back
 *     to cloud STT is never silent. `notice` is rendered here, as an
 *     `role="alert"` when it is a warning, and it stays on screen — it is a
 *     state on the recogniser, not a toast.
 *  3. **Push-to-talk.** ⚠️ Not continuous listening, and that is a decision the
 *     docs did not make. With a loudspeaker and an open microphone, the
 *     recogniser transcribes our own `speechSynthesis` output and treats it as
 *     the user talking — so a continuous session either silences itself the
 *     moment it answers, or answers its own answers. Press-to-talk has no echo
 *     path at all, and pressing the button is itself the barge-in.
 *
 * The speech-out half is installed through `speak.js`'s documented seam:
 * `setSpeaker(narrator.asSpeaker())`. `AudiomMap`'s "What's here?" button keeps
 * calling the module-level `speak()` exactly as milestone 5c wrote it and
 * silently gains the ported queue's categories, priorities, interrupts and the
 * watchdog. Nothing in that path changed.
 *
 * Props:
 *  - onWhatsHere : called when the utterance is an L0 `whats_here` — wired to
 *                  `AudiomMap`'s existing `whatsHere()`, so the mic reaches the
 *                  same answer the button does, with no model in between.
 *  - onUtterance : the M7 seam. Anything L0 does not recognise goes here. Until
 *                  a dispatcher is wired, the component says so out loud rather
 *                  than dropping it.
 *  - phrases     : in-window place names, handed to the engine as contextual
 *                  biasing (§8.1's "in-window biasing list", which the browser
 *                  turns out to provide for free).
 *  - lang, allowCloud : passed through to the recogniser. `allowCloud={false}`
 *                  is the strict posture — refuse the microphone rather than
 *                  upload audio.
 */
export function AudiomMic({
  onWhatsHere,
  onUtterance,
  phrases,
  lang = 'en-US',
  allowCloud = true,
  compact = true,
}) {
  const [status, setStatus] = useState({ listening: false, notice: null, mode: SttMode.UNKNOWN });
  const [heard, setHeard] = useState('');
  const [installing, setInstalling] = useState(false);

  // Latest-callback refs: the recogniser's handlers are wired once, and must not
  // capture the first render's props.
  const onWhatsHereRef = useRef(onWhatsHere);
  const onUtteranceRef = useRef(onUtterance);
  useEffect(() => { onWhatsHereRef.current = onWhatsHere; }, [onWhatsHere]);
  useEffect(() => { onUtteranceRef.current = onUtterance; }, [onUtterance]);

  /** One narrator for the component's whole life. */
  const narrator = useMemo(() => createNarrator({
    // Unarmed: the queue opens on the first user gesture, because a browser will
    // drop `speak()` before one and the queue would then be waiting on an
    // `onend` that never comes.
    autoStart: false,
    onSpeakingChange: () => { /* reserved for a "speaking" indicator */ },
  }), []);

  /**
   * Route a transcript. L0 first and locally — design §4: a "stop" that takes a
   * 1–3 s model round trip is not a stop, and `whats_here` is answered from a
   * ref read with no model at all.
   */
  const handleFinal = useCallback((transcript) => {
    setHeard(transcript);
    const match = matchL0(transcript);
    if (match?.intent === 'control') { narrator.control(match.command); return; }
    if (match?.intent === 'whats_here') { onWhatsHereRef.current?.(); return; }
    if (onUtteranceRef.current) { onUtteranceRef.current(transcript); return; }
    narrator.narrate(
      `I heard, ${transcript}. Nothing is connected to answer that yet.`,
      { layer: 'L1' },
    );
  }, [narrator]);

  const recognizer = useMemo(() => createRecognizer({
    lang,
    allowCloud,
    // Push-to-talk. See the echo note above.
    continuous: false,
    interimResults: true,
    onFinal: handleFinal,
    onStateChange: (next) => setStatus({
      listening: next.listening, notice: next.notice, mode: next.mode,
    }),
    onNotice: (n) => setStatus((prev) => ({ ...prev, notice: n })),
  }), [lang, allowCloud, handleFinal]);

  const link = useMemo(() => linkBargeIn(recognizer, narrator), [recognizer, narrator]);

  // Install the queue behind the module-level `speak()` — `speak.js` calls this
  // "the seam milestone S swaps the AnnouncementQueue in through".
  useEffect(() => {
    setSpeaker(narrator.asSpeaker());
    return () => setSpeaker(null);
  }, [narrator]);

  // Probe for an on-device pack at mount. Deliberately NOT inside the click:
  // `available()` is async, and awaiting inside a gesture handler can lose the
  // activation that the microphone permission needs. No audio is touched here.
  useEffect(() => {
    let cancelled = false;
    recognizer.prepare().then(() => {
      if (!cancelled) setStatus(() => {
        const s = recognizer.getState();
        return { listening: s.listening, notice: s.notice, mode: s.mode };
      });
    });
    return () => { cancelled = true; link.dispose(); recognizer.dispose(); };
  }, [recognizer, link]);

  useEffect(() => () => narrator.dispose(), [narrator]);

  // The window moved, so the biasing list moved with it.
  useEffect(() => {
    if (Array.isArray(phrases)) recognizer.setPhrases(phrases);
  }, [recognizer, phrases]);

  const toggle = useCallback(() => {
    if (recognizer.isListening()) { recognizer.stop(); return; }
    link.start();
  }, [recognizer, link]);

  const install = useCallback(async () => {
    setInstalling(true);
    await recognizer.install();
    setInstalling(false);
    const s = recognizer.getState();
    setStatus({ listening: s.listening, notice: s.notice, mode: s.mode });
  }, [recognizer]);

  const supported = recognizer.isSupported();
  const listening = status.listening;
  const notice = status.notice;
  const warning = notice?.severity === 'warning';

  const buttonStyle = {
    marginLeft: 8,
    padding: '1px 6px',
    border: 0,
    borderRadius: 4,
    background: listening ? '#b91c1c' : '#334155',
    color: '#e2e8f0',
    fontSize: 11,
    cursor: supported ? 'pointer' : 'not-allowed',
    opacity: supported ? 1 : 0.5,
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        disabled={!supported}
        aria-pressed={listening}
        title={supported
          ? `${listening ? 'Stop listening' : 'Hold a question'} · ${status.mode === SttMode.LOCAL ? 'on-device' : 'cloud'} recognition`
          : 'This browser has no speech recognition'}
        style={buttonStyle}
      >
        {listening ? '● Listening…' : '🎙 Ask'}
      </button>

      {recognizer.canInstall() && (
        <button
          type="button"
          onClick={install}
          disabled={installing}
          title="Download the on-device speech pack so audio stays on this machine"
          style={{ ...buttonStyle, background: '#166534' }}
        >
          {installing ? 'Installing…' : 'Get on-device pack'}
        </button>
      )}

      {/*
        The disclosure. `alert` rather than `status` when audio is about to leave
        the machine, because a screen reader user must not have to go looking for
        it. It is rendered from recogniser state, so it cannot be dismissed by a
        re-render the way a toast can.
      */}
      {notice && (
        <span
          role={warning ? 'alert' : 'status'}
          aria-live={warning ? 'assertive' : 'polite'}
          style={{
            marginLeft: 8,
            fontSize: 11,
            color: warning ? '#fca5a5' : '#94a3b8',
            maxWidth: compact ? 320 : undefined,
            display: 'inline-block',
            verticalAlign: 'middle',
          }}
        >
          {warning ? '⚠ ' : ''}
          {compact && notice.text.length > 120 ? `${notice.text.slice(0, 118)}…` : notice.text}
        </span>
      )}

      {heard && (
        <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }} aria-live="polite">
          “{heard}”
        </span>
      )}
    </>
  );
}

export default AudiomMic;
