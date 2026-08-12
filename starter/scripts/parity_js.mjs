#!/usr/bin/env node
/**
 * MapIO parity benchmark, JavaScript stack — the Node arms.
 *
 * The twin of `explore/simple_camio_llm/run_parity_benchmark.py`, driving
 * `starter/src/lib` instead of `simple_camio_llm/src`. Everything except IO and
 * the transport lives in `src/lib/parity/`, which is platform-free and is the
 * *same module* `explore/wllama-spike/parity.html` runs in a tab — so the Node
 * and browser arms differ only in the injected `LocalLLMClient`.
 *
 * STT is replayed, not re-executed: Web Speech `SpeechRecognition` takes no file
 * and no MediaStream, so the words come out of the recorded Apple-STT run. Both
 * strings it stored are used, as two passes. See `src/lib/parity/transcript.js`.
 *
 *   # the baseline: E4B on the router, the words Apple actually heard
 *   node scripts/parity_js.mjs --arm js_node_e4b --server http://localhost:11434/v1
 *
 *   # the same arm on clean text — is any gap STT's fault or ours?
 *   node scripts/parity_js.mjs --arm js_node_e4b --input clean
 *
 *   # both passes, one command
 *   node scripts/parity_js.mjs --arm js_node_e4b --input both
 *
 *   # no server needed: build every prompt, print sizes, call nothing
 *   node scripts/parity_js.mjs --dry-run
 *
 * Results land in `explore/simple_camio_llm/benchmark/results/<label>/parity_<ts>.{json,md}`,
 * beside the Python's, so `compare_arms.py` and the grading flow work unchanged.
 * Grading is POST-HOC: `grade` is null on every turn and a human writes
 * `parity_<ts>_graded.md` afterwards.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLLMClient } from '../src/lib/llm/index.js';
import { TIER } from '../src/lib/localLLM.js';
import { buildUserTurn } from '../src/lib/candidateContext.js';
import {
  createParityWorld,
  positionBlock,
  resolvePositionSpec,
  loadRecordedTranscript,
  runParityBenchmark,
  buildRunRecord,
  buildRunMarkdown,
  summarise,
  timestampOf,
  DEFAULT_K,
  INPUT,
} from '../src/lib/parity/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = resolve(HERE, '..');
const REPO = resolve(STARTER, '..');
const CAMIO = join(REPO, 'explore/simple_camio_llm');
const RESULTS = join(CAMIO, 'benchmark/results');
const SCHEMA = join(STARTER, 'docs/llm-tools.schema.json');

/**
 * The recorded Apple-STT run this replays.
 *
 * 18 cases / 26 turns, `--formatter curated --input text --routing local --k 8`,
 * 50 POI hints. Pinned rather than globbed: which recording an arm replayed is
 * part of what the arm means, and silently picking up a newer file would make
 * two runs incomparable without either one changing.
 */
const DEFAULT_TRANSCRIPT = join(
  RESULTS, 'arm1_curated_stt', 'parity_20260805_194151.json',
);

/** Arm → what it pins. One variable each; see `benchmark/run_arms.py`. */
const ARMS = {
  js_node_e4b: {
    backend: 'http',
    model: TIER.REASON,
    why: 'HTTP router, l3 = Gemma 4 E4B — the baseline; same model and same words as arm1_curated_stt',
  },
  js_node_e2b: {
    backend: 'http',
    // ⚠️ A placeholder, not a discovered name. There is no second chat tier in
    // ~/.config/abtc/models.ini today, so whoever mounts one must pass its
    // actual id with --model. The run prints the router's model list, and warns
    // when the requested id is not in it.
    model: 'l3e2b',
    why: 'HTTP router, E2B — separates "E2B is weaker" from "in-tab differs from llama-server". OPTIONAL: needs a second tier mounted; pass its id with --model.',
  },
  js_browser_e2b: {
    backend: 'wllama',
    model: TIER.REASON,
    why: 'wllama in-tab, E2B — run this one from explore/wllama-spike/parity.html, not here',
  },
};

function parseArgs(argv) {
  const args = {
    arm: 'js_node_e4b',
    server: process.env.LLM_BASE_URL || 'http://localhost:11434/v1',
    model: null,
    input: INPUT.HEARD,
    k: DEFAULT_K,
    map: null,
    case: null,
    label: null,
    outDir: RESULTS,
    transcript: DEFAULT_TRANSCRIPT,
    maxRounds: undefined,
    adopt: null,
    dryRun: false,
    warmup: true,
    harnessTools: true,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => argv[++i];
    switch (flag) {
      case '--arm': args.arm = value(); break;
      case '--server': args.server = value(); break;
      case '--model': args.model = value(); break;
      case '--input': args.input = value(); break;
      case '--k': args.k = Number(value()); break;
      case '--map': args.map = value(); break;
      case '--case': args.case = value(); break;
      case '--label': args.label = value(); break;
      case '--out-dir': args.outDir = resolve(value()); break;
      case '--transcript': args.transcript = resolve(value()); break;
      case '--max-rounds': args.maxRounds = Number(value()); break;
      case '--adopt': args.adopt = resolve(value()); break;
      case '--dry-run': args.dryRun = true; break;
      case '--no-warmup': args.warmup = false; break;
      case '--no-harness-tools': args.harnessTools = false; break;
      case '--quiet': args.quiet = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default:
        console.error(`unknown flag ${flag}`);
        usage();
        process.exit(2);
    }
  }
  return args;
}

function usage() {
  console.log(`
parity_js.mjs — MapIO parity benchmark against the JS stack

  --arm <name>        ${Object.keys(ARMS).join(' | ')}   (default js_node_e4b)
  --input <pass>      heard | clean | both                (default heard)
  --server <url>      OpenAI-compatible base URL          (default $LLM_BASE_URL or :11434/v1)
  --model <tier>      override the arm's model
  --k <n>             candidates per question             (default ${DEFAULT_K})
  --map <name>        run only new_york | detroit_conant
  --case <id>         run only this case or turn id
  --label <folder>    results folder name                 (default derived from the arm)
  --transcript <path> recorded run to replay
  --max-rounds <n>    tool-loop round budget
  --adopt <file>      move a browser run POSTed to explore/wllama-spike/results/
                      into benchmark/results/<label>/, where compare_arms.py looks
  --dry-run           build every prompt, print sizes, call no model
  --no-warmup         skip priming the prefix
  --no-harness-tools  withhold route_to and the two accessibility readers

Arms:
${Object.entries(ARMS).map(([k, v]) => `  ${k.padEnd(16)} ${v.why}`).join('\n')}
`);
}

/** Probe the given URL, then the WSL gateway, mirroring the Python's resolver. */
async function resolveServer(url) {
  const candidates = [url];
  try {
    const version = readFileSync('/proc/version', 'utf8');
    if (/microsoft/i.test(version)) {
      const parsed = new URL(url);
      for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length > 2 && fields[1] === '00000000') {
          const hex = fields[2];
          const gw = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16)).join('.');
          candidates.push(`${parsed.protocol}//${gw}:${parsed.port}${parsed.pathname}`);
          break;
        }
      }
      const parsed2 = new URL(url);
      candidates.push(`${parsed2.protocol}//127.0.0.1:${parsed2.port}${parsed2.pathname}`);
    }
  } catch { /* not WSL */ }

  for (const candidate of candidates) {
    try {
      const res = await fetch(`${candidate.replace(/\/$/, '')}/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) continue;
      const json = await res.json();
      const models = (json.data || []).map((m) => m.id);
      return { url: candidate, models };
    } catch { /* next */ }
  }
  return { url: null, models: [] };
}

const loadJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Land a browser run beside the Python's.
 *
 * `parity.html` POSTs to `server.mjs`'s generic `/results` endpoint — the same
 * one `bench.html` uses, because that endpoint is how a run on the 8 GB M1 floor
 * device gets into the repo at all. Its file lands in
 * `explore/wllama-spike/results/`, which `compare_arms.py` does not read. This
 * moves the pair into `benchmark/results/<label>/parity_<ts>.{json,md}` without
 * touching either the record or the server.
 */
function adopt(path, outDir) {
  const posted = loadJson(path);
  const run = posted.parity || posted;
  if (!run?.results || !run?.timestamp) {
    console.error(`${path} does not look like a parity run (no \`results\`/\`timestamp\`)`);
    process.exit(2);
  }
  const dir = join(outDir, run.label || run.arm || 'js_browser_e2b');
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, `parity_${run.timestamp}.json`);
  const mdPath = join(dir, `parity_${run.timestamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(run, null, 2));
  writeFileSync(mdPath, posted.markdown || buildRunMarkdown(run));
  console.log(summarise(run));
  console.log(`\nAdopted ${path}\nSaved ${jsonPath}\nSaved ${mdPath}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.adopt) {
    adopt(args.adopt, args.outDir);
    return;
  }
  const arm = ARMS[args.arm];
  if (!arm) {
    console.error(`unknown arm ${args.arm}; pick from ${Object.keys(ARMS).join(', ')}`);
    process.exit(2);
  }
  if (args.arm === 'js_browser_e2b') {
    console.error(
      'js_browser_e2b is the in-tab arm. Run it from explore/wllama-spike/parity.html:\n'
      + '  cd explore/wllama-spike && npm run serve\n'
      + '  open http://localhost:8971/parity.html?auto=1&label=<machine>',
    );
    process.exit(2);
  }
  const model = args.model || arm.model;

  if (!existsSync(args.transcript)) {
    console.error(`no recorded transcript at ${args.transcript}`);
    console.error(`available: ${readdirSync(join(RESULTS, 'arm1_curated_stt')).join(', ')}`);
    process.exit(2);
  }

  const schema = loadJson(SCHEMA);
  const recorded = loadJson(args.transcript);
  const benchmark = loadJson(join(CAMIO, 'benchmark/mapio_benchmark.json'));
  const transcript = loadRecordedTranscript(recorded, { benchmark });
  console.log(
    `replaying ${transcript.turnCount} turns across ${transcript.cases.length} cases from `
    + `${transcript.source.label}/${transcript.source.timestamp}`,
  );

  let cases = transcript.cases;
  if (args.map) cases = cases.filter((c) => c.map === args.map);
  if (args.case) {
    cases = cases
      .filter((c) => c.id === args.case || c.turns.some((t) => t.id === args.case))
      .map((c) => (c.id === args.case ? c : { ...c, turns: c.turns.filter((t) => t.id === args.case) }));
  }
  if (!cases.length) {
    console.error('no cases match the filter');
    process.exit(2);
  }

  const passes = args.input === 'both' ? [INPUT.HEARD, INPUT.CLEAN] : [args.input];
  for (const pass of passes) {
    if (pass !== INPUT.HEARD && pass !== INPUT.CLEAN) {
      console.error(`--input must be heard | clean | both, got ${pass}`);
      process.exit(2);
    }
  }

  /* -- the server ---------------------------------------------------------- */
  let server = args.server;
  if (!args.dryRun) {
    const probe = await resolveServer(args.server);
    if (!probe.url) {
      console.error(
        `\n[BLOCKED] no OpenAI-compatible server reachable from ${args.server}.\n`
        + '  This arm needs the local router (see ~/.config/abtc/models.ini). Everything that\n'
        + '  does not need it still works:\n'
        + '    node scripts/parity_js.mjs --dry-run       every prompt, built and sized\n'
        + '    node scripts/test_parity.mjs               the offline checks\n',
      );
      process.exit(3);
    }
    server = probe.url;
    console.log(`[OK] LLM server at ${server}. Models: ${probe.models.join(', ')}`);
    if (probe.models.length && !probe.models.includes(model)) {
      console.log(`[WARN] '${model}' not in ${probe.models.join(', ')}; sending anyway.`);
    }
  }

  /* -- the client ---------------------------------------------------------- */
  const client = args.dryRun
    ? dryRunClient()
    : await createLLMClient({ backend: arm.backend, http: { baseUrl: server, timeoutMs: 300_000 } });

  /* -- worlds, built once each --------------------------------------------- */
  const now = Date.now();
  const worlds = new Map();
  const getWorld = async (mapName) => {
    if (worlds.has(mapName)) return worlds.get(mapName);
    const model_ = loadJson(join(CAMIO, 'models', mapName, `${mapName}.json`));
    const world = await createParityWorld({
      mapName,
      model: model_,
      schema,
      client,
      now,
      harnessTools: args.harnessTools,
      onEvent: (e) => !args.quiet && console.log(`[${mapName}] ${e.type}${e.ms != null ? ` ${e.ms}ms` : ''}`),
    });
    worlds.set(mapName, world);
    return world;
  };

  if (args.dryRun) {
    await dryRun({ cases, getWorld, args });
    return;
  }

  /* -- run ----------------------------------------------------------------- */
  for (const pass of passes) {
    const label = args.label
      ? (passes.length > 1 && pass === INPUT.CLEAN ? `${args.label}_text` : args.label)
      : (pass === INPUT.CLEAN ? `${args.arm}_text` : args.arm);

    console.log(`\n${'='.repeat(72)}\n${args.arm} · ${pass} · ${arm.why}\n  -> ${join(args.outDir, label)}/\n${'='.repeat(72)}`);

    const { results, warmupSec, worlds: worldSummaries } = await runParityBenchmark({
      cases,
      getWorld,
      client,
      input: pass,
      k: args.k,
      model,
      maxRounds: args.maxRounds,
      warmup: args.warmup,
      onEvent: (e) => logEvent(e, args.quiet),
    });

    const run = buildRunRecord({
      results,
      label,
      arm: args.arm,
      model,
      server,
      backend: arm.backend,
      k: args.k,
      input: pass,
      warmupSec,
      worlds: worldSummaries,
      harnessTools: args.harnessTools ? [...new Set(worldSummaries.flatMap((w) => w.harnessTools))] : [],
      transcriptSource: transcript.source,
      timestamp: timestampOf(),
    });

    const dir = join(args.outDir, label);
    mkdirSync(dir, { recursive: true });
    const jsonPath = join(dir, `parity_${run.timestamp}.json`);
    const mdPath = join(dir, `parity_${run.timestamp}.md`);
    writeFileSync(jsonPath, JSON.stringify(run, null, 2));
    writeFileSync(mdPath, buildRunMarkdown(run));

    console.log(`\n${summarise(run)}`);
    console.log(`\nSaved ${jsonPath}\nSaved ${mdPath}`);
  }
}

function logEvent(event, quiet) {
  if (quiet) return;
  if (event.type === 'turn-start') {
    console.log(`\n=== [${event.id}] ${event.utterance}`);
    console.log(`    candidates: ${event.candidates.join(', ') || '(none)'}`);
  } else if (event.type === 'turn-end') {
    const calls = event.calls.map((c) => `${c.name}:${c.status}`).join(', ') || 'no calls';
    console.log(`--- (${event.seconds}s, ${calls}) ${event.answer}`);
  } else if (event.type === 'warmup') {
    console.log(`prefix warm in ${event.seconds}s`);
  } else if (event.type === 'world') {
    console.log(
      `[${event.map}] ${event.tools.length} tools served (${event.tools.join(', ')})`
      + `${event.withheld.length ? `; withheld ${event.withheld.join(', ')}` : ''}`,
    );
    console.log(`[${event.map}] system prompt ~${Math.round(event.systemPromptChars / 4)} tokens (${event.systemPromptChars} chars)`);
  }
}

/**
 * A client that answers nothing.
 *
 * `--dry-run` exists to size prompts and to prove the whole assembly path — L1,
 * briefing, tool filtering, position resolution — with no server in the room.
 * Embeddings are deterministic hashes rather than random, so the same utterance
 * ranks the same way twice and a dry run is diffable.
 */
function dryRunClient() {
  const embed = (texts) => texts.map((text) => {
    const vec = new Float32Array(64);
    for (let i = 0; i < text.length; i += 1) vec[text.charCodeAt(i) % 64] += 1;
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i += 1) vec[i] /= norm;
    return vec;
  });
  return {
    baseUrl: 'dry-run',
    async chatCompletion() {
      throw new Error('dry-run: no model is called');
    },
    async embedQueries(queries) { return embed(queries); },
    async embedDocuments(docs) { return embed(docs.map((d) => `${d.name} ${d.text}`)); },
  };
}

async function dryRun({ cases, getWorld, args }) {
  const approxTokens = (text) => Math.round(text.length / 4);
  for (const benchCase of cases) {
    const world = await getWorld(benchCase.map);
    if (!world._printed) {
      world._printed = true;
      console.log(
        `\n[${benchCase.map}] system prompt ~${approxTokens(world.systemPrompt)} tokens`
        + ` (briefing ~${approxTokens(world.briefing)})`,
      );
      console.log(`[${benchCase.map}] tools served: ${world.served.tools.map((t) => t.function.name).join(', ')}`);
      if (world.withheld.length) console.log(`[${benchCase.map}] withheld: ${world.withheld.join(', ')}`);
    }
    for (const turn of benchCase.turns) {
      let position = null;
      try {
        position = resolvePositionSpec(world.graph, turn.position);
      } catch (error) {
        console.log(`  ${turn.id}: POSITION FAILED — ${error.message}`);
      }
      const { matches } = await world.placeIndex.resolve(
        args.input === INPUT.CLEAN ? turn.clean : turn.heard,
        { worldId: world.adapter.worldId, windowId: world.windowId, k: args.k },
      );
      const content = buildUserTurn(
        matches,
        `${positionBlock(world, position)}${args.input === INPUT.CLEAN ? turn.clean : turn.heard}`,
      );
      console.log(`  ${turn.id}: user turn ~${approxTokens(content)} tokens · ${matches.length} candidates`);
    }
  }
  console.log('\ndry run complete — no model was called');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
