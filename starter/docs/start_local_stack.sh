#!/usr/bin/env bash
# ============================================================
# 3-Tier Local Gemma Stack Launcher for M1 Mac (8 GB VRAM)
# ============================================================

LLAMA_SERVER="./build/bin/llama-server"
if [ ! -f "$LLAMA_SERVER" ]; then
    LLAMA_SERVER="./llama-server"
fi

mkdir -p ~/.cache/abtc-kv

echo "============================================================"
echo " Starting 3-Tier Local Gemma LLM Servers on M1 Mac"
echo " L3 Reasoning Server  : http://localhost:8081/v1"
echo " L1 Embedding Server  : http://localhost:8082/v1"
echo " L2 Function Formatter: http://localhost:8083/v1"
echo "============================================================"

# 1. Layer 3: Gemma 4 E4B Instruct (Port 8081)
"$LLAMA_SERVER" \
  -m models/gemma-4-E4B-it-Q4_K_M.gguf \
  --port 8081 \
  -c 16384 \
  -fa on \
  -ctk q8_0 \
  -ctv q8_0 \
  -ngl 99 \
  --jinja \
  --cache-reuse 256 \
  --slot-save-path ~/.cache/abtc-kv \
  --parallel 1 &
L3_PID=$!

# 2. Layer 1: EmbeddingGemma 308M (Port 8082)
"$LLAMA_SERVER" \
  -m models/embeddinggemma-308m-Q8_0.gguf \
  --port 8082 \
  --embedding \
  -c 2048 &
L1_PID=$!

# 3. Layer 2: FunctionGemma 270M (Port 8083)
"$LLAMA_SERVER" \
  -m models/functiongemma-270m-Q8_0.gguf \
  --port 8083 \
  -c 4096 \
  --jinja &
L2_PID=$!

echo "LLM Servers launched in background."
echo "PIDs: L3=$L3_PID | L1=$L1_PID | L2=$L2_PID"

trap "kill $L3_PID $L1_PID $L2_PID 2>/dev/null" EXIT
wait
