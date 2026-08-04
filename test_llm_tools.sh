#!/usr/bin/env bash
# Local LLM Tool Calling Test Suite (WSL Native Script)
# Usage: ./test_llm_tools.sh [SERVER_URL] [MODEL_NAME|PROFILE] [PROFILE] [--simulate-loop]

SERVER_URL="${1:-http://localhost:11434/v1}"
ARG2="$2"
ARG3="$3"
ARG4="$4"

PYTHON_BIN="/home/znasif/anaconda3/envs/braille/bin/python"
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tmap_py/src/tmap/llm_eval_runner.py"

MODEL_NAME="auto"
PROFILE_NAME="all"
SIM_LOOP_FLAG=""

for arg in "$@"; do
    if [ "$arg" == "--simulate-loop" ]; then
        SIM_LOOP_FLAG="--simulate-loop"
    fi
done

if [ "$ARG2" == "osm_full" ] || [ "$ARG2" == "camio" ] || [ "$ARG2" == "audiom_tier_a" ] || [ "$ARG2" == "audiom_tier_c" ] || [ "$ARG2" == "osm_places_only" ]; then
    PROFILE_NAME="$ARG2"
elif [ -n "$ARG2" ] && [ "$ARG2" != "--simulate-loop" ]; then
    MODEL_NAME="$ARG2"
    if [ -n "$ARG3" ] && [ "$ARG3" != "--simulate-loop" ]; then
        PROFILE_NAME="$ARG3"
    fi
fi

echo "============================================================"
echo " Local LLM Tool Calling Test Suite (WSL Native)"
echo " Server:   $SERVER_URL"
echo " Model:    $MODEL_NAME"
echo " Profile:  $PROFILE_NAME"
echo " Sim Loop: $SIM_LOOP_FLAG"
echo "============================================================"
echo ""

"$PYTHON_BIN" "$SCRIPT_PATH" \
    --schema "starter/docs/llm-tools.schema.json" \
    --dataset "starter/docs/eval_dataset.json" \
    --server "$SERVER_URL" \
    --model "$MODEL_NAME" \
    --profile "$PROFILE_NAME" \
    --timeout 120 \
    $SIM_LOOP_FLAG \
    --out-dir "response/llm_eval"
