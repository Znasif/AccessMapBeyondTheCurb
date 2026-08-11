#!/usr/bin/env node
/**
 * Milestone 2 check: capability filtering of the 12 tool schemas.
 *
 *   node starter/scripts/test_tool_filter.mjs
 *
 * No server and no network — the whole point of §3.5 is that tool selection is
 * deterministic, so this is a pure function test over docs/llm-tools.schema.json.
 *
 * The counts are the ones in the schema's own `capabilityProfiles`, and in §3 of
 * browser-voice-exploration-plan.md, which corrects design doc §3.5's stale 4/3.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { filterTools, placeTakingTools } from '../src/lib/toolFilter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '../docs/llm-tools.schema.json');

/** Freeze the whole tree: any attempt to mutate the input throws in strict mode. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const schema = deepFreeze(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const names = (tools) => tools.map((t) => t.function.name);
const byName = (tools, name) => tools.find((t) => t.function.name === name);

/** Recursive: no metadata key may survive anywhere in the served payload. */
function findMetaKeys(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((v, i) => findMetaKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, val]) =>
    key === 'requires' || key === 'frames' || key.startsWith('$')
      ? [`${path}.${key}`]
      : findMetaKeys(val, `${path}.${key}`),
  );
}

/** Exactly the OAI shape llama-server accepts — nothing else at either level. */
function shapeErrors(tool) {
  const errs = [];
  const top = Object.keys(tool).sort().join(',');
  if (top !== 'function,type') errs.push(`top-level keys: ${top}`);
  if (tool.type !== 'function') errs.push(`type: ${tool.type}`);
  const fn = Object.keys(tool.function || {}).sort().join(',');
  if (fn !== 'description,name,parameters') errs.push(`function keys: ${fn}`);
  return errs;
}

console.log(`schema: ${SCHEMA_PATH}  (${schema.tools.length} tools declared, v${schema.$version})\n`);

/* -- profile counts ---------------------------------------------------------- */

const PROFILES = [
  ['osm_full',        ['places', 'graph', 'routing', 'accessibilityAttrs', 'entrances'], 'geographic', 12],
  ['camio',           ['places', 'regions'],                                             'image',       7],
  ['audiom_tier_c',   ['places', 'liveFeatureStream'],                                   'geographic',  7],
  ['osm_places_only', ['places'],                                                        'geographic',  7],
];

const filtered = new Map();
for (const [label, caps, frame, expected] of PROFILES) {
  const tools = filterTools(schema, { capabilities: new Set(caps), frame });
  filtered.set(label, tools);
  check(tools.length === expected, `${label} (${frame}) -> ${expected} tools`, `got ${tools.length}`);
  console.log(`     ${names(tools).join(', ')}`);
}

/* -- the 7 are the right 7 --------------------------------------------------- */

const EXPECTED_SEVEN = [
  'whats_here', 'describe_surroundings', 'get_place_details', 'am_i_at',
  'get_distance_to', 'get_direction_to', 'route_to',
];
for (const label of ['camio', 'audiom_tier_c', 'osm_places_only']) {
  const got = names(filtered.get(label)).sort().join(',');
  check(got === [...EXPECTED_SEVEN].sort().join(','), `${label}: whats_here + 5 places tools + route_to`, got);
}

/* -- frame / capability narrowing (§5.4 and the two $notes) ------------------ */

const camio = filtered.get('camio');
const camioMode = byName(camio, 'route_to').function.parameters.properties.mode.enum;
check(
  JSON.stringify(camioMode) === JSON.stringify(['fly_me_there']),
  'camio: route_to mode enum narrowed (no routing capability)',
  JSON.stringify(camioMode),
);

const camioUnits = byName(camio, 'get_distance_to').function.parameters.properties.units.enum;
check(
  JSON.stringify(camioUnits) === JSON.stringify(['material_mm']),
  'camio: get_distance_to units narrowed for the image frame',
  JSON.stringify(camioUnits),
);

const full = filtered.get('osm_full');
const fullMode = byName(full, 'route_to').function.parameters.properties.mode.enum;
check(
  JSON.stringify(fullMode) === JSON.stringify(['street_by_street', 'fly_me_there']),
  'osm_full: route_to keeps both modes',
  JSON.stringify(fullMode),
);

const fullUnits = byName(full, 'get_distance_to').function.parameters.properties.units.enum;
check(
  JSON.stringify(fullUnits) === JSON.stringify(['minutes', 'metres', 'feet', 'blocks']),
  'osm_full: get_distance_to units narrowed for the geographic frame',
  JSON.stringify(fullUnits),
);

const enuUnits = byName(
  filterTools(schema, { capabilities: ['places', 'graph'], frame: 'enu' }),
  'get_distance_to',
).function.parameters.properties.units.enum;
check(
  JSON.stringify(enuUnits) === JSON.stringify(['metres']),
  'enu: get_distance_to units narrowed to metres',
  JSON.stringify(enuUnits),
);

/* -- frame gating ------------------------------------------------------------ */

const enuFull = filterTools(schema, {
  capabilities: ['places', 'graph', 'routing', 'accessibilityAttrs', 'entrances'],
  frame: 'enu',
});
check(
  !names(enuFull).some((n) => ['get_crossing_info', 'get_segment_accessibility', 'find_accessible_entrance',
    'set_route_preferences', 'stop_navigation'].includes(n)),
  'enu: geographic-only tools are dropped even with full capabilities',
  `${enuFull.length} tools: ${names(enuFull).join(', ')}`,
);

/* -- output is clean OAI ----------------------------------------------------- */

const allOut = [...filtered.values()].flat();
const meta = allOut.flatMap((t) => findMetaKeys(t, t.function.name));
check(meta.length === 0, 'no requires / frames / $note anywhere in the output', meta.join(' '));

const shape = allOut.flatMap((t) => shapeErrors(t).map((e) => `${t.function.name}: ${e}`));
check(shape.length === 0, 'every tool is exactly {type, function:{name, description, parameters}}', shape.join('; '));

/* -- input untouched --------------------------------------------------------- */

const before = JSON.stringify(schema);
filterTools(schema, { capabilities: ['places'], frame: 'image' });
check(JSON.stringify(schema) === before, 'input schema object is not mutated (deep-frozen)');

const schemaRouteMode = schema.tools.find((t) => t.function.name === 'route_to')
  .function.parameters.properties.mode.enum;
check(schemaRouteMode.length === 2, 'source route_to still declares both modes after narrowing', JSON.stringify(schemaRouteMode));

/* -- placeTakingTools (§4.3: derived, never hand-listed) --------------------- */

const EXPECTED_PLACE_TOOLS = [
  'get_place_details', 'am_i_at', 'get_distance_to', 'get_direction_to',
  'find_accessible_entrance', 'route_to',
].sort();

const derived = [...placeTakingTools(schema.tools)].sort();
check(
  JSON.stringify(derived) === JSON.stringify(EXPECTED_PLACE_TOOLS),
  'placeTakingTools over all 12 -> the six place-arg tools',
  derived.join(', '),
);
check(
  JSON.stringify([...placeTakingTools(schema)].sort()) === JSON.stringify(EXPECTED_PLACE_TOOLS),
  'placeTakingTools also accepts a whole schema object',
);
check(
  JSON.stringify([...placeTakingTools(camio)].sort()) ===
    JSON.stringify(EXPECTED_PLACE_TOOLS.filter((n) => n !== 'find_accessible_entrance')),
  'placeTakingTools over a filtered set drops the tool that was filtered out',
);

/* -- validation -------------------------------------------------------------- */

let threw = false;
try { filterTools(schema, { capabilities: ['places'], frame: 'mercator' }); } catch { threw = true; }
check(threw, 'unknown frame is rejected rather than silently passing everything');

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
