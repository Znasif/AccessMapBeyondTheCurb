#!/usr/bin/env node
/**
 * Milestone 8 check: PlaceIndex against the live local server.
 *
 *   VITE_LLM_BASE=http://127.0.0.1:8081/v1 node starter/scripts/test_place_index.mjs
 *
 * Uses MemoryStore because Node has no IndexedDB; the retrieval path under
 * test is identical, only persistence differs.
 */

import { LocalLLMClient } from '../src/lib/localLLM.js';
import { PlaceIndex, MemoryStore, indexKey, TIE_EPSILON } from '../src/lib/placeIndex.js';

const BASE = process.env.VITE_LLM_BASE || 'http://127.0.0.1:8081/v1';

// Real POIs from simple_camio/models/new_york/new_york.json
const PLACES = [
  { id: 0, name: 'American Academy of Dramatic Arts', category: 'education.college', context: 'Madison Avenue' },
  { id: 1, name: 'Andrews NYC Diner', category: 'restaurant.diner', context: 'American food' },
  { id: 2, name: 'BCD Tofu House', category: 'restaurant.korean', context: 'tofu soup, open late' },
  { id: 3, name: 'Bank of America', category: 'financial.bank', context: 'ATM' },
  { id: 4, name: 'Bank of Hope', category: 'financial.bank', context: 'ATM' },
  { id: 5, name: 'Barn Joo 35', category: 'restaurant.korean', context: 'gastropub' },
  { id: 6, name: 'Blaggards Pub', category: 'bar.pub', context: 'Irish pub' },
  { id: 7, name: 'Blank Slate Coffee + Kitchen', category: 'cafe.coffee', context: 'espresso, sandwiches' },
  { id: 8, name: 'Cafe China', category: 'restaurant.chinese', context: 'Sichuan' },
  { id: 9, name: 'Empire State Building', category: 'tourism.attraction', context: 'observation deck' },
];

// Scored on recall@k, not top-1. L1 narrows context for L3; which of several
// equally-valid candidates ranks first is arbitrary and not L1's job to settle.
// Each case lists every place a reasonable person would accept.
const CASES = [
  ['the Korean place',        ['BCD Tofu House', 'Barn Joo 35']],
  ['where can I get coffee',  ['Blank Slate Coffee + Kitchen']],
  ['I need an ATM',           ['Bank of America', 'Bank of Hope']],
  ['Sichuan food',            ['Cafe China']],
  ['the observation deck',    ['Empire State Building']],
  ['somewhere to get a pint', ['Blaggards Pub']],
];

const client = new LocalLLMClient({ baseUrl: BASE });
const store = new MemoryStore();
const index = new PlaceIndex({ client, store, maxCached: 3 });

const ctx = { worldId: 'camio:new_york', windowId: 'full' };

console.log(`server: ${BASE}\nbuilding index over ${PLACES.length} places...`);
let t0 = Date.now();
const record = await index.build({ ...ctx, places: PLACES });
console.log(`  built in ${Date.now() - t0}ms — dim=${record.dim} count=${record.count} ` +
            `bytes=${record.vectors.byteLength}\n`);

t0 = Date.now();
const cached = await index.build({ ...ctx, places: PLACES });
console.log(`rebuild hits cache: ${cached.builtAt === record.builtAt ? 'yes' : 'NO'} (${Date.now() - t0}ms)\n`);

let hit1 = 0, hit5 = 0;
for (const [utterance, acceptable] of CASES) {
  const t = Date.now();
  const { matches, confident, margin } = await index.resolve(utterance, ctx);
  const names = matches.map((m) => m.name);
  const r1 = acceptable.includes(names[0]);
  const r5 = names.some((n) => acceptable.includes(n));
  hit1 += r1; hit5 += r5;
  console.log(`${r5 ? 'ok  ' : 'MISS'} "${utterance}"  (${Date.now() - t}ms)`);
  console.log(`     top-5: ${names.join(' | ')}`);
  console.log(`     margin=${margin.toFixed(3)} confident=${confident}` +
              `  -> ${confident ? 'L2 fast path allowed' : 'escalate to L3 with all candidates'}`);
}

// LRU: maxCached=3, so building 4 windows must drop the oldest.
for (const w of ['w2', 'w3', 'w4']) {
  await index.build({ worldId: ctx.worldId, windowId: w, places: PLACES.slice(0, 3) });
}
const remaining = (await store.entries()).map((e) => e.key);
const evicted = !remaining.includes(indexKey(ctx.worldId, 'full'));
console.log(`\nLRU eviction at maxCached=3: ${remaining.length} kept, oldest evicted: ${evicted ? 'yes' : 'NO'}`);
console.log(`  kept: ${remaining.join(', ')}`);

console.log(`\nrecall@1: ${hit1}/${CASES.length}   recall@5: ${hit5}/${CASES.length}   (tie epsilon ${TIE_EPSILON})`);
console.log('recall@5 is the metric that matters — the whole top-k is what L3 receives.');
process.exit(hit5 === CASES.length && evicted ? 0 : 1);
