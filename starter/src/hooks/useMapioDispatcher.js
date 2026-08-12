import { useState, useEffect, useRef, useCallback } from 'react';
import { Graph } from '../lib/logic/graph.js';
import { MapioWorldAdapter } from '../lib/parity/mapioAdapter.js';
import { ToolRegistry } from '../lib/toolRegistry.js';
import { registerCoreTools } from '../lib/tools/index.js';
import { Dispatcher } from '../lib/dispatcher.js';
import { createLLMClient } from '../lib/llm/index.js';
import { PlaceIndex } from '../lib/placeIndex.js';
import { createSurface, BRAILLE_DOODLE } from '../lib/surface.js';
import { speak } from '../lib/speak.js';
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

export function useMapioDispatcher({
  coordRef,
  llmUrl = '/llm/v1',
  backend = import.meta.env.VITE_LLM_BACKEND || 'auto',
}) {
  const [selectedMapKey, setSelectedMapKey] = useState('new_york');
  const [isLoadingMap, setIsLoadingMap] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [mapInfo, setMapInfo] = useState(null);

  // Dispatcher & state references
  const dispatcherRef = useRef(null);
  const adapterRef = useRef(null);
  const uvRef = useRef({ u: 0, v: 0 });
  const sourcesRef = useRef({
    uv: () => uvRef.current,
  });

  // Speech Recognition state
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [lastAnswer, setLastAnswer] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const recognitionRef = useRef(null);

  const selectedMap = MAPIO_MAPS[selectedMapKey] || MAPIO_MAPS.new_york;

  // Load selected MapIO map JSON & initialize MapioWorldAdapter + Dispatcher
  useEffect(() => {
    let isCurrent = true;
    setIsLoadingMap(true);
    setMapError(null);

    async function loadMap() {
      try {
        const targetUrl = asset(selectedMap.modelUrl);
        const res = await fetch(targetUrl);
        if (!res.ok) throw new Error(`Failed to load ${targetUrl}: ${res.statusText}`);
        const data = await res.json();
        if (!isCurrent) return;

        const graphDict = data.graph || data;
        const feetsPerInch = data.feets_per_inch || 1;
        const graph = new Graph(graphDict, { feetsPerInch });
        const adapter = new MapioWorldAdapter({ graph });
        adapterRef.current = adapter;

        const placeIndex = new PlaceIndex();
        const registry = new ToolRegistry({ schema });
        registerCoreTools(registry);

        const surface = createSurface(BRAILLE_DOODLE);

        const client = await createLLMClient({
          backend,
          http: { baseUrl: llmUrl },
          wllama: {
            onProgress: (p) => {
              if (p.desc) console.log(`[Wasm LLM] ${p.desc} ${(p.progress || 0).toFixed(1)}%`);
            },
          },
        });

        const dispatcher = new Dispatcher({
          registry,
          adapter,
          client,
          placeIndex,
          surface,
          sources: sourcesRef.current,
          speak: (text) => speak(text),
        });

        dispatcherRef.current = dispatcher;

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
        setIsLoadingMap(false);
      }
    }

    loadMap();

    return () => {
      isCurrent = false;
    };
  }, [selectedMapKey, llmUrl]);

  // Keep uvRef synchronized with live finger coordinates
  useEffect(() => {
    const interval = setInterval(() => {
      if (coordRef?.current) {
        const c = coordRef.current;
        const u = c.u ?? c[0] ?? 0;
        const v = c.v ?? c[1] ?? 0;
        uvRef.current = { u, v };
      }
    }, 100);
    return () => clearInterval(interval);
  }, [coordRef]);

  // Dispatch query to Dispatcher
  const handleQuery = useCallback(
    async (text) => {
      const queryText = text || transcript;
      if (!queryText || !queryText.trim()) return;

      if (mapError) {
        const msg = `Map loading error: ${mapError}. Please refresh the page.`;
        speak(msg);
        setLastAnswer(msg);
        return;
      }

      if (!dispatcherRef.current || isLoadingMap) {
        const msg = 'Map model is currently loading. Please wait a moment.';
        speak(msg);
        setLastAnswer(msg);
        return;
      }

      setIsProcessing(true);
      try {
        const res = await dispatcherRef.current.handle(queryText);
        const answerText = res?.text || 'No answer produced.';
        setLastAnswer(answerText);
        speak(answerText);
      } catch (err) {
        console.error('Dispatcher error:', err);
        let errMsg = 'Sorry, an error occurred while answering.';
        if (String(err.message || '').includes('Failed to fetch')) {
          errMsg = 'Local LLM router not reachable on port 8081. Instant queries like "what is here" work offline without an LLM.';
        }
        setLastAnswer(errMsg);
        speak(errMsg);
      } finally {
        setIsProcessing(false);
      }
    },
    [transcript, mapError, isLoadingMap]
  );

  // Web Speech API Voice Recognition setup
  const toggleListening = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome.');
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      setTranscript('');
    };

    recognition.onresult = (event) => {
      const current = event.resultIndex;
      const resultTranscript = event.results[current][0].transcript;
      setTranscript(resultTranscript);
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      setIsListening(false);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [isListening]);

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
  };
}
