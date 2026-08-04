# Local LLM Stack Setup Guide for 8 GB M1 Mac (llama.cpp)

This guide provides step-by-step instructions to set up, build, and serve the 3-tier local Gemma LLM stack on an **8 GB Apple Silicon M1 Mac** using Metal-accelerated `llama.cpp`.

---

## 1. VRAM & Memory Allocation Budget

On an **8 GB M1 Mac** (where macOS uses ~2.2 GB VRAM/RAM), the stack is budgeted to fit within **~5.8 GB VRAM** with zero disk swapping:

| Tier | Component | Port | GGUF Model | VRAM Allocation |
|---|---|---|---|---|
| **L3** | Reasoning, Tool Loop & Narration | `8081` | `gemma-4-E4B-it-Q4_K_M.gguf` | ~4.5 GB |
| **L1** | Embedding Index & Vector RAG | `8082` | `embeddinggemma-308m-Q8_0.gguf` | ~0.3 GB |
| **L2** | Fast Tool Call Formatter | `8083` | `functiongemma-270m-Q8_0.gguf` | ~0.2 GB |
| **KV Cache** | llama-server slot cache (q8_0) | — | 16,384 tokens | ~0.8 GB |
| **Total** | | | | **~5.8 GB / 8.0 GB** |

---

## 2. Build `llama.cpp` on M1 Mac (Metal Accelerated)

Open a terminal on your M1 Mac and run:

```bash
# 1. Clone llama.cpp repository
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp

# 2. Build with Metal (Apple Silicon GPU Acceleration)
cmake -B build -DLLAMA_METAL=ON
cmake --build build --config Release -j
```

---

## 3. Download GGUF Models

Create a `models/` directory and download the quantised GGUF weights:

```bash
mkdir -p models

# 1. L3: Gemma 4 E4B Instruct (Q4_K_M ~4.5 GB)
curl -L -o models/gemma-4-E4B-it-Q4_K_M.gguf \
  "https://huggingface.co/ggml-org/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf"

# 2. L1: EmbeddingGemma 308M (Q8_0 ~320 MB)
curl -L -o models/embeddinggemma-308m-Q8_0.gguf \
  "https://huggingface.co/ggml-org/embeddinggemma-308m-GGUF/resolve/main/embeddinggemma-308m-Q8_0.gguf"

# 3. L2: FunctionGemma 270M (Q8_0 ~280 MB)
curl -L -o models/functiongemma-270m-Q8_0.gguf \
  "https://huggingface.co/ggml-org/functiongemma-270m-GGUF/resolve/main/functiongemma-270m-Q8_0.gguf"
```

---

## 4. Launch Script (`start_local_stack.sh`)

Create `start_local_stack.sh` inside your `llama.cpp` directory:

```bash
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
```

Make the script executable:
```bash
chmod +x start_local_stack.sh
./start_local_stack.sh
```

---

## 5. Verification & Testing

### Test L3 Chat & Tool Calling (Port 8081)
From your M1 Mac (or Windows/WSL connecting to M1 Mac IP):

```bash
curl http://localhost:8081/v1/models
```

Run test evaluation suite against M1 Mac:
```bash
./test_llm_tools.sh http://<M1_MAC_IP>:8081/v1 gemma-4-E4B-it osm_full --simulate-loop
```

### Test L1 Embeddings (Port 8082)
```bash
curl http://localhost:8082/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": "Empire State Building landmark", "model": "embeddinggemma"}'
```

---

## 6. Vite Proxy Configuration (`starter/vite.config.js`)

To allow the web frontend (`starter`) to connect to the M1 Mac servers without CORS errors or hardcoded API keys:

Add the following proxy configuration in `starter/vite.config.js`:

```javascript
export default defineConfig({
  server: {
    proxy: {
      '/llm/l3': {
        target: 'http://<M1_MAC_IP>:8081',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm\/l3/, ''),
      },
      '/llm/l1': {
        target: 'http://<M1_MAC_IP>:8082',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm\/l1/, ''),
      },
      '/llm/l2': {
        target: 'http://<M1_MAC_IP>:8083',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/llm\/l2/, ''),
      },
    },
  },
});
```
