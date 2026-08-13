/**
 * The in-tab MapIO pipeline, as one hook.
 *
 * Everything below the React line is already built and platform-free — the
 * ported `Graph`, `MapioWorldAdapter`, `ToolRegistry`, `Dispatcher`,
 * `PlaceIndex`, the `LocalLLMClient` seam and its two backends, and milestone
 * S's recogniser/narrator. This file is the wiring, and its job is to keep three
 * lifetimes apart:
 *
 *   SESSION  the LLM engines. 2.6 GB of weights and a WASM heap per tier. Built
 *            once per (backend, router URL) and never on a map change.
 *   MAP      the world. A fetch, a `Graph`, an adapter, a tool registry.
 *            Rebuilt whenever the dropdown changes — which must be fast.
 *   TURN     the dispatcher call, its narration and its speech.
 *
 * Collapsing the first two into one effect is what made switching New York ↔
 * Detroit re-download the model, so they are deliberately three effects: build
 * the engines, build the world, then join them into a `Dispatcher`.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Graph } from '../lib/logic/graph.js';
import { MapioWorldAdapter } from '../lib/adapters/mapioWorldAdapter.js';
import { ToolRegistry } from '../lib/toolRegistry.js';
import { registerCoreTools } from '../lib/tools/index.js';
import { Dispatcher } from '../lib/dispatcher.js';
import { createLLMClient, PROFILES, TIER } from '../lib/llm/index.js';
import { PlaceIndex, fromCamioPoi } from '../lib/placeIndex.js';
import { createSurface, BRAILLE_DOODLE } from '../lib/surface.js';
import { windowIdOf } from '../lib/turnContext.js';
import { createNarrator, createRecognizer, linkBargeIn, SttMode } from '../lib/speech/index.js';
import asset from '../lib/assetUrl.js';
import schema from '../../docs/llm-tools.schema.json';

export const MAPIO_MAPS = {
  new_york: {
    id: 'new_york',
    label: 'New York (Midtown)',
    modelUrl: '/models/new_york/new_york.json',
    templateUrl: '/models/new_york/template.png',
  },
  detroit_conant: {
    id: 'detroit_conant',
    label: 'Detroit (Conant)',
    modelUrl: '/models/detroit_conant/detroit_conant.json',
    templateUrl: '/models/detroit_conant/template.png',
  },
};

/**
 * Which tiers the in-tab backend preloads, spelled out rather than left to
 * `preload()`'s default.
 *
 * `preload()` with no argument loads EVERY configured tier, which is ~3 GB
 * sequentially; `bench.html` passes `[TIER.REASON]` because a benchmark of the
 * chat model has no use for embeddings. Here both are genuinely used: L1
 * retrieval is what produces the §4.3 candidate block, and without it the
 * curated prompt does not fit. So the default happens to be right — but it is
 * right for a reason, and the reason is written down instead of inherited.
 */
const PRELOAD_TIERS = [TIER.REASON, TIER.EMBED];

/**
 * The env keys the wllama backend reads, dereferenced in the shape Vite
 * statically replaces (`import.meta.env.VITE_X`, spelled out) and handed to
 * `lib/` as data. `lib/llm/index.js` can read `import.meta.env` itself, but only
 * by dynamic indexing; passing the object keeps the platform read on this side
 * of the React/lib line, where the rest of the app already does it.
 *
 * Unset stays unset — `undefined` means "the profile decides", which is not the
 * same as the empty string. See `resolveModelSource`.
 */
function modelEnv() {
  const entries = {
    VITE_MODEL_URL: import.meta.env.VITE_MODEL_URL,
    VITE_MODEL_HF_REPO: import.meta.env.VITE_MODEL_HF_REPO,
    VITE_MODEL_HF_FILE: import.meta.env.VITE_MODEL_HF_FILE,
    VITE_EMBED_URL: import.meta.env.VITE_EMBED_URL,
    VITE_EMBED_HF_REPO: import.meta.env.VITE_EMBED_HF_REPO,
    VITE_EMBED_HF_FILE: import.meta.env.VITE_EMBED_HF_FILE,
    VITE_LLM_PROFILE: import.meta.env.VITE_LLM_PROFILE,
  };
  const out = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** `idle` → `loading` → `ready` | `failed`. */
const IDLE_STATUS = { loading: false, ready: false, failed: false, percent: 0, text: '', error: null };

/**
 * Every name in this map, for the recogniser's contextual biasing list.
 *
 * Street and POI names are the documented weakness of every recogniser in this
 * stack (`speech/recognizer.js`, "Contextual biasing"), and the list is already
 * in memory: `adapter.places()` for the POIs, `graph.streets` for the streets.
 * Web Speech's `phrases` is exactly the in-window biasing list §8.1 assumed we
 * could not afford, and it costs nothing.
 */
function biasingPhrases(adapter, graph) {
  const names = new Set();
  for (const place of adapter.places?.() || []) {
    if (place?.name) names.add(place.name);
    for (const alias of place?.aliases || []) if (alias) names.add(alias);
  }
  for (const street of graph?.streets?.keys?.() || []) if (street) names.add(street);
  return [...names];
}

export function useMapioDispatcher({
  coordRef,
  llmUrl = '/llm/v1',
  backend = import.meta.env.VITE_LLM_BACKEND || 'auto',
}) {
  const [selectedMapKey, setSelectedMapKey] = useState('new_york');
  const [isLoadingMap, setIsLoadingMap] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [mapInfo, setMapInfo] = useState(null);

  /** The two halves the dispatcher is assembled from, each on its own lifetime. */
  const [llm, setLlm] = useState(null);
  const [world, setWorld] = useState(null);
  const [wllamaStatus, setWllamaStatus] = useState(IDLE_STATUS);

  const dispatcherRef = useRef(null);

  /**
   * `coordRef` is a prop, so a closure that captured it at mount would go stale
   * if the caller ever passed a different ref. One indirection keeps the
   * `sources` object identity stable — the dispatcher holds it for the whole
   * session — while still reading today's ref.
   */
  const coordRefRef = useRef(coordRef);
  coordRefRef.current = coordRef;

  /**
   * `sources.uv` is a GETTER: `createTurnContext` calls it at turn open and gets
   * whatever the finger is doing right then. Polling it onto a mirror ref every
   * 100 ms — which is what this used to do — added a frame of staleness and a
   * timer, and bought nothing.
   */
  const sourcesRef = useRef({
    uv: () => {
      const c = coordRefRef.current?.current;
      if (!c) return null;
      const u = c.u ?? c[0];
      const v = c.v ?? c[1];
      return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
    },
  });

  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [lastAnswer, setLastAnswer] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sttNotice, setSttNotice] = useState(null);
  const [sttMode, setSttMode] = useState(SttMode.UNKNOWN);
  /**
   * Chrome reports the on-device pack as DOWNLOADABLE until someone asks for it,
   * so `processLocally` alone never gets you off the cloud path — the download
   * has to be requested, from a user gesture, and the recogniser deliberately
   * will not start a few-hundred-MB fetch on its own. This is what turns the
   * "audio is leaving the machine" notice into an action instead of a fact.
   */
  const [canInstallStt, setCanInstallStt] = useState(false);
  const [installingStt, setInstallingStt] = useState(false);
  const installingSttRef = useRef(false);

  const recognizerRef = useRef(null);
  const micRef = useRef(null);
  /**
   * The in-window place names, held outside the recogniser so whichever of the
   * two exists first can hand them to the other. The map effect is asynchronous
   * and the recogniser effect is not, so neither order is guaranteed.
   */
  const phrasesRef = useRef([]);
  /** Latest `handleQuery`, so the recogniser's handlers never go stale. */
  const handleQueryRef = useRef(null);

  /**
   * The narrator, built once for the session.
   *
   * Every announcement goes through it — `asSpeaker()` for this hook's own
   * messages, `narrator.speak` for the dispatcher's `speak(text, {layer, turnId})`
   * seam — so all of them get the queue, the interrupt semantics, turn gating,
   * and the `onend` watchdog. Without that watchdog one dropped utterance stalls
   * the queue for the rest of the session and the app goes silent; see
   * `speech/narrator.js`.
   */
  const narratorRef = useRef(null);
  if (narratorRef.current === null) narratorRef.current = createNarrator();
  const speakerRef = useRef(null);
  if (speakerRef.current === null) speakerRef.current = narratorRef.current.asSpeaker();

  const selectedMap = MAPIO_MAPS[selectedMapKey] || MAPIO_MAPS.new_york;

  /* -- SESSION: the LLM engines ------------------------------------------- */

  useEffect(() => {
    let isCurrent = true;
    let created = null;
    setLlm(null);
    setWllamaStatus({ ...IDLE_STATUS, loading: true, text: 'Starting the LLM backend…' });

    (async () => {
      try {
        const client = await createLLMClient({
          backend,
          env: modelEnv(),
          http: { baseUrl: llmUrl },
          wllama: {
            onProgress: ({ loaded, total, profile }) => {
              if (!isCurrent) return;
              // wllama's `progressCallback` reports bytes, not a percentage —
              // there is no `progress` or `desc` field on it.
              const percent = total ? Math.round((100 * loaded) / total) : 0;
              const label = PROFILES[profile]?.label || profile;
              const tier = PROFILES[profile]?.tier || '';
              setWllamaStatus((prev) => ({
                ...prev,
                loading: true,
                ready: false,
                failed: false,
                percent,
                text: `Loading ${tier ? `${tier} · ` : ''}${label}`,
              }));
            },
          },
        });
        created = client;
        if (!isCurrent) return;

        if (client.transport?.preload) {
          setWllamaStatus({ ...IDLE_STATUS, loading: true, text: 'Initialising the in-tab LLM…' });
          // Sequential and explicit: reasoning first, then embeddings.
          await client.transport.preload(PRELOAD_TIERS);
          if (!isCurrent) return;
          setWllamaStatus({ ...IDLE_STATUS, ready: true, percent: 100, text: 'In-tab LLM ready' });
        } else {
          setWllamaStatus({ ...IDLE_STATUS, ready: true, percent: 100, text: `Router backend (${llmUrl})` });
        }
        setLlm({ client });
      } catch (err) {
        console.error('[LLM] backend unavailable:', err);
        if (!isCurrent) return;
        // ⚠️ NOT `loading: false, percent: 0`. That reads as "not loading", which
        // is indistinguishable from "ready" at the query gate, so the next
        // question walks into a dead transport and comes back "Sorry, an error
        // occurred". A failure is its own state and it blocks queries.
        setWllamaStatus({
          ...IDLE_STATUS,
          failed: true,
          text: 'The language model failed to load',
          error: String(err?.message || err),
        });
        setLlm(null);
      }
    })();

    return () => {
      isCurrent = false;
      // Free the worker and the WASM heap rather than leaking one per switch.
      created?.transport?.unload?.().catch(() => {});
    };
  }, [backend, llmUrl]);

  /* -- MAP: the world ------------------------------------------------------ */

  useEffect(() => {
    let isCurrent = true;
    setIsLoadingMap(true);
    setMapError(null);

    (async () => {
      try {
        const targetUrl = asset(selectedMap.modelUrl);
        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error(`Failed to load ${targetUrl}: ${res.statusText}`);
        const data = await res.json();
        if (!isCurrent) return;

        const graphDict = data.graph || data;
        const graph = new Graph(graphDict, { feetsPerInch: data.feets_per_inch || 1 });
        const adapter = new MapioWorldAdapter({ graph, model: data, mapName: selectedMap.id });

        const registry = new ToolRegistry({ schema });
        registerCoreTools(registry);

        // camio-shaped POI records, straight off the JSON — the same source
        // `parity/world.js` builds its L1 index from.
        const places = (graphDict.points_of_interest || []).map((poi, i) => fromCamioPoi(poi, i));

        if (!isCurrent) return;
        setWorld({
          adapter,
          graph,
          registry,
          places,
          // `createTurnContext` defaults the window to `adapter.bbox`, so the
          // index has to be built under the id that produces or `resolve()`
          // answers `no-index` for every turn.
          windowId: windowIdOf(adapter.bbox),
          surface: createSurface(BRAILLE_DOODLE),
        });
        setMapInfo({
          name: data.name || selectedMap.label,
          nodes: graph.nodes?.length || 0,
          edges: graph.edges?.length || 0,
          pois: graph.pois?.length || 0,
        });
        setIsLoadingMap(false);
      } catch (err) {
        if (!isCurrent) return;
        console.error('Error loading MapIO map model:', err);
        setMapError(err.message);
        setWorld(null);
        setIsLoadingMap(false);
      }
    })();

    return () => { isCurrent = false; };
  }, [selectedMapKey]);

  /* -- JOIN: the dispatcher ------------------------------------------------ */

  useEffect(() => {
    if (!world) { dispatcherRef.current = null; return undefined; }
    let isCurrent = true;

    // ⚠️ `new PlaceIndex()` with no client defaults to `new LocalLLMClient()` —
    // a brand-new HTTP client pointed at the router. On the wllama backend that
    // means L3 runs in-tab while L1 silently calls a server that is not running,
    // every `resolve()` throws, and the candidate block — the whole reason the
    // curated prompt fits in 8192 tokens — is empty on every turn. One tier is
    // not a mode of the other (plan §8): they are two engines behind ONE client,
    // and this is that client.
    //
    // No client yet means NO INDEX, not a default one: `{client: undefined}`
    // would take that same default parameter and reintroduce the bug for the
    // window between "map ready" and "weights loaded". The dispatcher treats an
    // absent index as `no-index` and answers without candidates.
    const placeIndex = llm?.client ? new PlaceIndex({ client: llm.client }) : null;

    dispatcherRef.current = new Dispatcher({
      registry: world.registry,
      adapter: world.adapter,
      client: llm?.client || null,
      placeIndex,
      surface: world.surface,
      sources: sourcesRef.current,
      // The narrator's dispatcher seam: `speak(text, {layer, turnId})`, split
      // into sentences so a long L3 answer can be interrupted between them.
      speak: (text, meta) => narratorRef.current?.speak(text, meta),
    });

    // Contextual biasing for the recogniser: every POI, alias and street name on
    // this map. Takes effect on the next `start()`, which is what push-to-talk
    // makes cheap.
    phrasesRef.current = biasingPhrases(world.adapter, world.graph);
    recognizerRef.current?.setPhrases(phrasesRef.current);

    // Session-start job, never a turn-time one (`dispatcher.js#candidates`):
    // building the index inside a question turns a 1–3 s answer into a minute of
    // silence. Failure is not fatal — `resolve()` answers `no-index` and the
    // turn proceeds with no candidates.
    if (placeIndex) {
      placeIndex
        .build({ worldId: world.adapter.worldId, windowId: world.windowId, places: world.places })
        .then(() => { if (isCurrent) console.info(`[L1] indexed ${world.places.length} places`); })
        .catch((err) => console.warn('[L1] place index build failed; turns will run without candidates', err));
    }

    return () => { isCurrent = false; };
  }, [world, llm]);

  /* -- speech in ----------------------------------------------------------- */

  useEffect(() => {
    const recognizer = createRecognizer({
      // Chrome-first on-device recognition. `processLocally` is requested by the
      // recogniser itself whenever the engine exposes the on-device statics; the
      // cloud path is a documented, visible fallback rather than a silent one,
      // which is what `notice` below is for.
      continuous: false,
      interimResults: true,
      // Street and POI names are the documented weakness of every recogniser in
      // this stack, and `SpeechRecognitionPhrase` is free biasing for exactly
      // them. Feature-detected inside the recogniser: an engine without it
      // downgrades with a notice rather than failing.
      phrases: phrasesRef.current,
      onResult: ({ transcript: text }) => setTranscript(text),
      onFinal: (text) => {
        setTranscript(text);
        handleQueryRef.current?.(text);
      },
      onStateChange: (snapshot) => {
        setIsListening(snapshot.listening);
        setSttNotice(snapshot.notice);
        setSttMode(snapshot.mode);
        // Re-read rather than derive from `snapshot`: availability is re-probed
        // after an install attempt, so this flips to false the moment the pack
        // lands and the offer stops being true.
        setCanInstallStt(Boolean(recognizerRef.current?.canInstall?.()));
      },
      onError: (err) => {
        if (err.disposition !== 'benign') console.warn('[STT]', err.code, err.message || '');
      },
    });
    recognizerRef.current = recognizer;
    // `mode: 'button'` — push-to-talk, so the microphone is only open while the
    // user wants it and there is no echo path from our own narration.
    micRef.current = linkBargeIn(recognizer, narratorRef.current, { mode: 'button' });

    // Decide local vs cloud BEFORE the microphone can open. No mic, no gesture,
    // no audio — just the availability probe.
    recognizer.prepare()
      .then(() => setCanInstallStt(Boolean(recognizer.canInstall?.())))
      .catch((err) => console.warn('[STT] prepare failed', err));

    return () => {
      micRef.current?.dispose();
      recognizer.dispose();
      recognizerRef.current = null;
      micRef.current = null;
    };
  }, []);

  useEffect(() => () => narratorRef.current?.dispose(), []);

  /* -- turns --------------------------------------------------------------- */

  const handleQuery = useCallback(
    async (text) => {
      const queryText = text || transcript;
      if (!queryText || !queryText.trim()) return;

      const speaker = speakerRef.current;
      const refuse = (msg) => {
        setLastAnswer(msg);
        speaker.speak(msg);
      };

      if (mapError) {
        refuse(`Map loading error: ${mapError}. Please refresh the page.`);
        return;
      }
      if (isLoadingMap || !dispatcherRef.current) {
        refuse('The map model is still loading. Please try again in a moment.');
        return;
      }
      if (wllamaStatus.failed) {
        refuse(
          `The language model could not be loaded${wllamaStatus.error ? `: ${wllamaStatus.error}` : ''}. `
          + 'Questions that need the model are unavailable until it loads.',
        );
        return;
      }
      if (wllamaStatus.loading) {
        refuse(`The language model is still loading (${wllamaStatus.percent}%). Please wait a moment.`);
        return;
      }

      // The queue opens on a user gesture; every path into here is one.
      narratorRef.current?.arm({ flush: false });
      setIsProcessing(true);
      try {
        const res = await dispatcherRef.current.handle(queryText);

        // L0.1: "stop", "slower", "repeat" — the speech layer only, and
        // deliberately model-free. The dispatcher resolves the command and
        // narrates nothing; answering it with prose (which is what happens if
        // this branch is missing) makes "stop" say "No answer produced".
        if (res?.intent === 'control' && res.command) {
          narratorRef.current?.control(res.command);
          setLastAnswer(`Speech control: ${res.command}`);
          return;
        }

        const answerText = res?.text || 'No answer produced.';
        setLastAnswer(answerText);
        // The dispatcher already narrated anything it produced, through the
        // same narrator — L0 readouts directly, L3 prose via `onNarration`. Only
        // speak here when it did not, or the answer is said twice.
        if (narratorRef.current?.getTurnId() !== res?.turnId) {
          narratorRef.current?.narrate(answerText, { turnId: res?.turnId, layer: res?.layer, split: true });
        }
      } catch (err) {
        console.error('Dispatcher error:', err);
        let errMsg = 'Sorry, an error occurred while answering.';
        if (String(err.message || '').includes('Failed to fetch')) {
          errMsg = `The local LLM router at ${llmUrl} is not reachable. `
            + 'Instant questions like "what is here" work offline without an LLM.';
        }
        setLastAnswer(errMsg);
        narratorRef.current?.error(errMsg);
      } finally {
        setIsProcessing(false);
      }
    },
    [transcript, mapError, isLoadingMap, wllamaStatus, llmUrl],
  );

  handleQueryRef.current = handleQuery;

  /**
   * The microphone button. `linkBargeIn.start()` arms the narrator, stops
   * whatever it was saying — pressing the button IS the barge-in — and opens the
   * recogniser, all synchronously inside the click that granted the gesture.
   */
  /**
   * Ask Chrome for the on-device speech pack. MUST be called from a click —
   * Chrome gates a download this size on transient activation — which is why
   * this is an exported callback for a button rather than something `prepare()`
   * does for you. `install()` re-probes and re-applies availability itself, so
   * the mode and notice update through `onStateChange` with no extra plumbing.
   */
  const installStt = useCallback(async () => {
    // `canInstall()` stays true through DOWNLOADING as well as DOWNLOADABLE, so
    // the offer alone does not stop a second click starting a second download of
    // a few hundred MB. Chrome gives no progress events for this, so the UI has
    // nothing else to show it is busy either — hence an explicit flag.
    if (installingSttRef.current) return false;
    installingSttRef.current = true;
    setInstallingStt(true);
    try {
      return Boolean(await recognizerRef.current?.install?.());
    } finally {
      installingSttRef.current = false;
      setInstallingStt(false);
      setCanInstallStt(Boolean(recognizerRef.current?.canInstall?.()));
    }
  }, []);

  const toggleListening = useCallback(() => {
    const mic = micRef.current;
    const recognizer = recognizerRef.current;
    if (!mic || !recognizer) return;
    if (recognizer.isListening()) { mic.stop(); return; }
    setTranscript('');
    mic.start();
  }, []);

  return {
    selectedMapKey,
    setSelectedMapKey,
    selectedMap,
    MAPIO_MAPS,
    isLoadingMap,
    mapError,
    mapInfo,
    isListening,
    transcript,
    lastAnswer,
    isProcessing,
    toggleListening,
    handleQuery,
    setTranscript,
    wllamaStatus,
    /** ⚠️ Sticky. `severity: 'warning'` means audio is leaving the machine. */
    sttNotice,
    sttMode,
    canInstallStt,
    installStt,
    installingStt,
  };
}
