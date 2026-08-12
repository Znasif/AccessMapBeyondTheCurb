#!/usr/bin/env python3
"""
Local LLM Tool Calling Evaluation Runner
Evaluates an OpenAI-compatible local LLM endpoint against the AccessMap Beyond
the Curb tool schemas (llm-tools.schema.json).

Tuned for the llama.cpp router serving [l1]/[l3] from ~/.config/abtc/models.ini.

  ./eval_tools.py                                  # localhost, model l3
  ./eval_tools.py --server http://127.0.0.1:11434/v1   # through the SSH tunnel
  ./eval_tools.py --simulate-loop --profile osm_full
  ./eval_tools.py --reasoning                      # measure the CoT cost

RECONCILED (design doc §10 open risk): this used to build its own flat system
prompt and a hand-rolled capability filter, which measured a different thing
from the real §4.3 candidate path in `src/lib/candidateContext.js` /
`src/lib/toolFilter.js`. It now shells out to Node and calls those modules
directly for every case's system prompt, user turn, and filtered tool list --
see `compile_cases_via_candidate_path()` below. That keeps the prompt logic in
exactly one place (JS); porting it into Python would have recreated the same
drift this reconciliation is fixing. Node is a hard dependency of this script
as a result -- there is no Python fallback path, by design.
"""

import os
import sys
import json
import time
import argparse
import subprocess
import urllib.request
import urllib.error
from datetime import datetime

# Tiers that cannot generate text. Sending a chat completion to one of these
# returns "the current context does not logits computation. skipping", which is
# what you get if you let the runner auto-pick the first model the router lists
# ([l1] sorts before [l3]).
EMBEDDING_MODEL_HINTS = ("l1", "embed", "embedding")


def load_schema(schema_path):
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_dataset(dataset_path):
    with open(dataset_path, "r", encoding="utf-8") as f:
        return json.load(f)


# Frame per `capability_profile`, needed because `toolFilter.filterTools()` (the
# real dispatcher's filter) gates on capability AND frame -- e.g. get_crossing_info,
# get_segment_accessibility, find_accessible_entrance, set_route_preferences and
# stop_navigation all carry `"frames": ["geographic"]`, and get_distance_to's
# `units` enum is narrowed differently per frame (§5.4). The dataset only tags
# capability_profile, not frame, so this map is the missing link -- sourced from
# design doc §3.1-§3.3, one frame per world/route:
#   osm_full, osm_places_only -> geographic  (§3.1: the OSM/OpenSidewalks route)
#   audiom_tier_c             -> enu         (§3.2: tier C is an opaque oracle
#                                              probe with "no geometry ... You
#                                              cannot build a graph"; treated as
#                                              unreferenced-to-WGS84 ENU, never
#                                              geographic)
#   camio                     -> image       (§3.3, stated explicitly: "Frame:
#                                              image (template pixels)")
# audiom_tier_a is NOT in the current 21-case dataset. §3.2 itself calls its
# frame "geographic or ENU" (depends on the fetched source), so there is no
# single correct default yet. "enu" below is a placeholder for if/when a
# tier-A case is added -- revisit against the real source before trusting it.
PROFILE_FRAMES = {
    "osm_full": "geographic",
    "osm_places_only": "geographic",
    "audiom_tier_a": "enu",  # placeholder -- §3.2 leaves this genuinely ambiguous
    "audiom_tier_c": "enu",
    "camio": "image",
}


def compile_cases_via_candidate_path(dataset, schema_path, repo_root, node_bin="node"):
    """Compile every case's system prompt, user turn, and filtered tool list by
    calling the real candidate-path modules in Node -- NOT a Python reimplementation.

    `src/lib/candidateContext.js` (buildSystemPrompt/buildUserTurn) and
    `src/lib/toolFilter.js` (filterTools, capability+frame aware) are the single
    source of truth for §4.3's prompt construction; this only marshals JSON in and
    out of them. Duplicating that logic in Python is exactly the drift this
    reconciliation removes -- see the module docstring.
    """
    candidate_context_path = os.path.join(repo_root, "starter", "src", "lib", "candidateContext.js")
    tool_filter_path = os.path.join(repo_root, "starter", "src", "lib", "toolFilter.js")
    for p, label in ((candidate_context_path, "candidateContext.js"), (tool_filter_path, "toolFilter.js")):
        if not os.path.exists(p):
            print(f"[ERROR] Cannot reconcile: {label} not found at {p}")
            sys.exit(1)

    node_script = f"""
import {{ readFileSync }} from 'fs';
import {{ buildSystemPrompt, buildUserTurn }} from {json.dumps(candidate_context_path)};
import {{ filterTools }} from {json.dumps(tool_filter_path)};

const input = JSON.parse(readFileSync(0, 'utf-8'));
const schema = JSON.parse(readFileSync(input.schemaPath, 'utf-8'));
const systemPrompt = buildSystemPrompt();
const toolCache = new Map();

const out = input.cases.map((tc) => {{
  const frame = input.profileFrames[tc.profile];
  if (!frame) {{
    throw new Error(`No frame mapping for capability_profile "${{tc.profile}}" (add it to PROFILE_FRAMES in eval_tools.py)`);
  }}
  const profileSchema = schema.capabilityProfiles[tc.profile];
  if (!profileSchema) {{
    throw new Error(`Unknown capability_profile "${{tc.profile}}" -- not in schema.capabilityProfiles`);
  }}
  const cacheKey = tc.profile + '::' + frame;
  if (!toolCache.has(cacheKey)) {{
    const capabilities = new Set(profileSchema.caps || []);
    toolCache.set(cacheKey, filterTools(schema, {{ capabilities, frame }}));
  }}
  const matches = (tc.resolvedPlaces || []).map((name) => ({{ name }}));
  return {{
    id: tc.id,
    systemPrompt,
    userMessage: buildUserTurn(matches, tc.utterance),
    tools: toolCache.get(cacheKey),
  }};
}});

process.stdout.write(JSON.stringify(out));
"""

    payload = {
        "schemaPath": schema_path,
        "profileFrames": PROFILE_FRAMES,
        "cases": [
            {
                "id": tc["id"],
                "profile": tc.get("capability_profile", "osm_full"),
                "utterance": tc["utterance"],
                "resolvedPlaces": tc.get("context", {}).get("resolved_places", []),
            }
            for tc in dataset
        ],
    }

    try:
        proc = subprocess.run(
            [node_bin, "--input-type=module", "-e", node_script],
            input=json.dumps(payload).encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        )
    except FileNotFoundError:
        print(f"[ERROR] '{node_bin}' not found. This harness now drives the real candidate-path\n"
              f"        prompt builder in src/lib/candidateContext.js and src/lib/toolFilter.js\n"
              f"        via Node -- Node is a required dependency, not optional. Install Node or\n"
              f"        pass --node-bin to point at it.")
        sys.exit(1)

    if proc.returncode != 0:
        print("[ERROR] Reconciled prompt compilation failed (Node side):")
        print(proc.stderr.decode("utf-8", errors="replace"))
        sys.exit(1)

    try:
        compiled_list = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        print(f"[ERROR] Node did not return valid JSON: {e}")
        print(proc.stdout.decode("utf-8", errors="replace")[:2000])
        sys.exit(1)

    return {c["id"]: c for c in compiled_list}


def validate_dataset(dataset, compiled_by_id):
    """Catch impossible expectations before spending minutes of inference on them.

    Uses the SAME compiled tool list eval_test_case will send to the model
    (§4.3-accurate: capability *and* frame filtered), not a re-derived one.
    """
    problems = []
    for tc in dataset:
        compiled = compiled_by_id.get(tc["id"])
        if compiled is None:
            problems.append(f"  {tc['id']}: no compiled prompt (compilation step did not cover this case)")
            continue
        offered = {t["function"]["name"] for t in compiled["tools"]}
        exp = tc.get("expected_tool")
        prof = tc.get("capability_profile", "osm_full")
        if exp is not None and exp not in offered:
            problems.append(f"  {tc['id']}: expects '{exp}' but profile '{prof}' does not offer it")
    return problems


def check_server_health(base_url, timeout=5):
    url = f"{base_url.rstrip('/')}/models"
    req = urllib.request.Request(url, headers={"User-Agent": "LLMEvalRunner/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8"))
                models = [m.get("id") for m in data.get("data", [])]
                return True, models
    except Exception as e:
        return False, str(e)
    return False, "Unknown status"


def pick_chat_model(models):
    """Never auto-select an embeddings-only tier."""
    for m in models:
        if not any(h in m.lower() for h in EMBEDDING_MODEL_HINTS):
            return m
    return models[0] if models else None


def send_chat_completion(base_url, model, messages, tools, timeout=120,
                         max_tokens=256, reasoning=False):
    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.0,
        "max_tokens": max_tokens,
    }
    # Gemma 4 emits chain-of-thought by default. With tools in the payload that
    # is fatal, not just slow: measured on "Tell me about Cafe China" with the
    # full 12-tool schema --
    #   reasoning_budget=0   -> 256 tokens of CoT, finish_reason=length, NO tool call
    #   enable_thinking=false-> 18 tokens, get_place_details{"place":"Cafe China"}
    #   reasoning on         -> 495 tokens, correct call, ~31s at 16 tok/s
    # reasoning_budget is silently ignored once `tools` is present; the template
    # kwarg is the one that actually suppresses thinking. Do not "simplify" this
    # back to reasoning_budget.
    if not reasoning:
        payload["chat_template_kwargs"] = {"enable_thinking": False}
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    data_bytes = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data_bytes,
        headers={"Content-Type": "application/json", "User-Agent": "LLMEvalRunner/1.0"},
        method="POST",
    )

    start_time = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            elapsed = time.time() - start_time
            return True, json.loads(resp.read().decode("utf-8")), elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - start_time
        err_body = e.read().decode("utf-8") if e.fp else str(e)
        return False, {"code": e.code, "error": err_body}, elapsed
    except Exception as e:
        return False, {"error": str(e)}, time.time() - start_time


def sanitize_assistant_message(msg):
    """Strip non-standard fields before replaying the turn.

    llama.cpp returns `reasoning_content` alongside `content`. Feeding that back
    into the next turn is not part of the OpenAI message shape and can confuse
    the chat template.
    """
    clean = {"role": msg.get("role", "assistant"), "content": msg.get("content") or ""}
    if msg.get("tool_calls"):
        clean["tool_calls"] = msg["tool_calls"]
    return clean


def mock_execute_tool(tool_name, args):
    place = args.get("place", "target location") if isinstance(args, dict) else "target location"
    mode = args.get("mode", "fly_me_there") if isinstance(args, dict) else "fly_me_there"

    mock_responses = {
        "whats_here": {"feature": "Tactile path near main intersection", "adjacent": ["Landmark A", "Coffee Shop"]},
        "describe_surroundings": {"radius_m": 50, "nearby": [{"name": "Empire State Building", "category": "landmark"}, {"name": "Shake Shack", "category": "restaurant"}]},
        "get_place_details": {"place": place, "category": "building", "hours": "09:00 - 22:00", "accessibility": "wheelchair ramp at main entrance"},
        "am_i_at": {"place": place, "is_at": True, "distance_mm": 0},
        "get_distance_to": {"place": place, "distance_meters": 320, "walk_minutes": 4, "material_mm": 95},
        "get_direction_to": {"place": place, "clock_direction": "2 o'clock", "compass_bearing": "northeast", "distance_mm": 95},
        "get_crossing_info": {"crossing": "5th Ave & 34th St", "has_curb_ramps": True, "has_audible_signal": True},
        "get_segment_accessibility": {"incline_percent": 3.5, "surface": "asphalt", "wheelchair_accessible": True},
        "find_accessible_entrance": {"place": place, "entrance_side": "west side on 5th Ave", "has_ramp": True},
        "route_to": {"status": "routing_started", "destination": place, "mode": mode, "confirmation": f"Navigation mode '{mode}' enabled to {place}"},
        "set_route_preferences": {"status": "updated", "confirmation": "Preferences updated: max uphill grade set to 5%"},
        "stop_navigation": {"status": "stopped", "confirmation": "Navigation cancelled and route cleared"},
    }
    return mock_responses.get(tool_name, {"status": "ok", "message": f"Executed {tool_name}"})


def eval_test_case(test_case, compiled_case, base_url, model, timeout=120,
                   simulate_loop=False, dry_run=False, max_tokens=256, reasoning=False):
    profile = test_case.get("capability_profile", "osm_full")
    tools = compiled_case["tools"]
    offered_tool_names = [t["function"]["name"] for t in tools]

    # systemPrompt and userMessage come straight from src/lib/candidateContext.js
    # (§4.3's V3t prompt) via compile_cases_via_candidate_path() -- this is the
    # reconciliation: no locally-built flat prompt here anymore.
    messages = [
        {"role": "system", "content": compiled_case["systemPrompt"]},
        {"role": "user", "content": compiled_case["userMessage"]},
    ]

    if dry_run:
        return {
            "id": test_case["id"],
            "utterance": test_case["utterance"],
            "profile": profile,
            "status": "DRY_RUN",
            "offered_tools": len(tools),
            "payload": {"messages": messages, "tools": tools},
        }

    success, response, elapsed = send_chat_completion(
        base_url, model, messages, tools, timeout=timeout,
        max_tokens=max_tokens, reasoning=reasoning)

    result = {
        "id": test_case["id"],
        "utterance": test_case["utterance"],
        "profile": profile,
        "expected_tool": test_case["expected_tool"],
        "expected_args": test_case["expected_args"],
        "elapsed_sec": round(elapsed, 3),
        "http_success": success,
        "called_tool": None,
        "called_args": None,
        "tool_match": False,
        "args_match": False,
        "false_positive": False,
        "capability_violation": False,
        "narration": None,
        "loop_success": False,
        "raw_response": response,
    }

    if not success:
        result["error"] = response
        return result

    choice = response.get("choices", [{}])[0]
    msg = choice.get("message", {})
    tool_calls = msg.get("tool_calls", [])

    if tool_calls:
        first_call = tool_calls[0]
        func_call = first_call.get("function", {})
        call_id = first_call.get("id", "call_001")
        called_name = func_call.get("name")
        raw_args = func_call.get("arguments", "{}")
        try:
            called_args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except Exception:
            called_args = {"_raw": raw_args}

        result["called_tool"] = called_name
        result["called_args"] = called_args

        if called_name not in offered_tool_names:
            result["capability_violation"] = True

        if simulate_loop:
            tool_output = mock_execute_tool(called_name, called_args)
            messages.append(sanitize_assistant_message(msg))
            messages.append({
                "role": "tool",
                "tool_call_id": call_id,
                "name": called_name,
                "content": json.dumps(tool_output),
            })
            turn2_success, turn2_resp, turn2_elapsed = send_chat_completion(
                base_url, model, messages, tools=None, timeout=timeout,
                max_tokens=max_tokens, reasoning=reasoning)
            if turn2_success:
                turn2_msg = turn2_resp.get("choices", [{}])[0].get("message", {})
                result["narration"] = turn2_msg.get("content", "")
                result["loop_success"] = True
                result["elapsed_sec"] = round(elapsed + turn2_elapsed, 3)
            else:
                result["turn2_error"] = turn2_resp
    else:
        result["narration"] = msg.get("content", "")
        result["loop_success"] = True

    expected_tool = test_case["expected_tool"]
    expected_args = test_case["expected_args"]

    if expected_tool is None:
        if result["called_tool"] is not None:
            result["false_positive"] = True
        else:
            result["tool_match"] = True
            result["args_match"] = True
    else:
        if result["called_tool"] == expected_tool:
            result["tool_match"] = True
            if expected_args is not None and isinstance(result["called_args"], dict):
                match = True
                for k, v in expected_args.items():
                    if result["called_args"].get(k) != v:
                        match = False
                        break
                result["args_match"] = match
            elif expected_args == result["called_args"]:
                result["args_match"] = True

    return result


def print_summary_table(results):
    print("\n" + "=" * 92)
    print(f"{'ID':<6} | {'PROFILE':<16} | {'EXPECTED':<26} | {'CALLED':<26} | {'SEC':>5} | {'':<4}")
    print("=" * 92)

    pos_count = pos_tool_hits = pos_args_hits = 0
    neg_count = neg_fp_count = cap_violations = 0
    http_errors = 0
    total_sec = 0.0

    for r in results:
        exp = str(r.get("expected_tool"))
        called = str(r.get("called_tool"))
        secs = r.get("elapsed_sec", 0) or 0
        total_sec += secs

        match_str = "ok" if r.get("tool_match") else "MISS"
        if r.get("false_positive"):
            match_str = "FP!"
        elif r.get("capability_violation"):
            match_str = "CAP!"
        if not r.get("http_success", True):
            match_str = "ERR"
            http_errors += 1

        print(f"{r.get('id',''):<6} | {r.get('profile',''):<16} | {exp[:26]:<26} | "
              f"{called[:26]:<26} | {secs:>5.1f} | {match_str:<4}")

        if r.get("expected_tool") is None:
            neg_count += 1
            if r.get("false_positive"):
                neg_fp_count += 1
        else:
            pos_count += 1
            if r.get("tool_match"):
                pos_tool_hits += 1
            if r.get("args_match"):
                pos_args_hits += 1

        if r.get("capability_violation"):
            cap_violations += 1

    print("=" * 92)
    print(" SUMMARY METRICS:")
    if pos_count:
        print(f"  Positive cases:             {pos_count}")
        print(f"  Tool selection accuracy:    {pos_tool_hits / pos_count * 100:.1f}% ({pos_tool_hits}/{pos_count})")
        print(f"  Argument exact match:       {pos_args_hits / pos_count * 100:.1f}% ({pos_args_hits}/{pos_count})")
    if neg_count:
        print(f"  Negative cases:             {neg_count}")
        print(f"  False positive rate:        {neg_fp_count / neg_count * 100:.1f}% ({neg_fp_count}/{neg_count})")
    print(f"  Capability violations:      {cap_violations}")
    if http_errors:
        print(f"  HTTP errors:                {http_errors}   <-- check --model")
    if results:
        print(f"  Mean latency:               {total_sec / len(results):.2f}s   (design target for L3: 1-3s)")
    print("=" * 92 + "\n")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(os.path.dirname(here))

    parser = argparse.ArgumentParser(description="Evaluate Local LLM Tool Calling Performance")
    parser.add_argument("--schema", default=os.path.join(repo, "starter/docs/llm-tools.schema.json"))
    parser.add_argument("--dataset", default=os.path.join(repo, "starter/docs/eval_dataset.json"))
    parser.add_argument("--server", default="http://127.0.0.1:8081/v1",
                        help="Base URL. Through the SSH tunnel: http://127.0.0.1:11434/v1")
    parser.add_argument("--model", default="l3",
                        help="Model/tier name. Do NOT use l1 -- it is embeddings-only.")
    parser.add_argument("--profile", default="all")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--reasoning", action="store_true",
                        help="Leave chain-of-thought on (much slower; off by default)")
    parser.add_argument("--simulate-loop", action="store_true")
    parser.add_argument("--out-dir", default=os.path.join(repo, "response/llm_eval"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--node-bin", default="node",
                        help="Node executable used to compile prompts from "
                             "src/lib/candidateContext.js / toolFilter.js (the "
                             "real candidate path -- see module docstring).")

    args = parser.parse_args()

    for path, label in ((args.schema, "Schema"), (args.dataset, "Dataset")):
        if not os.path.exists(path):
            print(f"[ERROR] {label} file not found: {path}")
            sys.exit(1)

    load_schema(args.schema)  # fail fast here with a clear path if the schema JSON is malformed
    dataset_data = load_dataset(args.dataset)

    print("Compiling prompts via the real candidate path "
          "(src/lib/candidateContext.js + toolFilter.js, through Node)...")
    compiled_by_id = compile_cases_via_candidate_path(
        dataset_data, args.schema, repo, node_bin=args.node_bin)
    print(f"Compiled {len(compiled_by_id)} case(s).\n")

    problems = validate_dataset(dataset_data, compiled_by_id)
    if problems:
        print("[ERROR] Dataset expects tools its profile does not offer:")
        print("\n".join(problems))
        sys.exit(1)

    if args.profile != "all":
        dataset_data = [tc for tc in dataset_data if tc.get("capability_profile") == args.profile]
        print(f"Filtered dataset to {len(dataset_data)} cases for profile '{args.profile}'")

    model_name = args.model
    if not args.dry_run:
        print(f"Checking server health at {args.server}...")
        healthy, info = check_server_health(args.server)
        if healthy:
            print(f"Server ONLINE. Models available: {info}")
            if model_name == "auto":
                model_name = pick_chat_model(info)
                print(f"Auto-selected chat-capable model: '{model_name}'")
            elif model_name not in info:
                print(f"[WARN] '{model_name}' not in the server list; sending anyway.")
            if any(h in (model_name or "").lower() for h in EMBEDDING_MODEL_HINTS):
                print(f"[ERROR] '{model_name}' looks like an embeddings-only tier. "
                      f"Every request will fail with 'does not logits computation'. Use --model l3.")
                sys.exit(1)
        else:
            print(f"[WARNING] Server health check failed: {info}")
            print("Proceeding anyway with evaluation request attempts...\n")

    reasoning_label = "ON" if args.reasoning else "OFF (enable_thinking=false)"
    print(f"Reasoning: {reasoning_label}   "
          f"max_tokens={args.max_tokens}   loop={'ON' if args.simulate_loop else 'OFF'}\n")

    results = []
    for tc in dataset_data:
        print(f"Executing [{tc['id']}] '{tc['utterance']}' (profile: {tc.get('capability_profile')})...")
        results.append(eval_test_case(
            tc, compiled_by_id[tc["id"]], args.server, model_name, timeout=args.timeout,
            simulate_loop=args.simulate_loop, dry_run=args.dry_run,
            max_tokens=args.max_tokens, reasoning=args.reasoning))

    if args.dry_run:
        print("\n[DRY RUN COMPLETE] Sample request payload:")
        print(json.dumps(results[0]["payload"], indent=2))
        return

    print_summary_table(results)

    os.makedirs(args.out_dir, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    report_filename = os.path.join(args.out_dir, f"report_{ts}.json")
    with open(report_filename, "w", encoding="utf-8") as f:
        json.dump({
            "timestamp": ts,
            "server": args.server,
            "model": model_name,
            "reasoning": args.reasoning,
            "profile_filter": args.profile,
            "results": results,
        }, f, indent=2)
    print(f"Report saved to {report_filename}")


if __name__ == "__main__":
    main()
