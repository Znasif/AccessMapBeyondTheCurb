@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: llama-server launcher helper
:: Launches llama-server configured according to local-llm-tooling-design.md
:: ============================================================

set MODEL_PATH=%~1
set PORT=%~2

if "!PORT!"=="" set PORT=11434

if "!MODEL_PATH!"=="" (
    echo Usage: run_llama_server.bat [PATH_TO_GGUF_MODEL] [PORT]
    echo Example: run_llama_server.bat models/gemma-4-E4B-it-Q4_K_M.gguf 8081
    echo.
    set /p MODEL_PATH="Enter path to model GGUF: "
)

if not exist "!MODEL_PATH!" (
    echo [ERROR] Model file not found at '!MODEL_PATH!'
    pause
    exit /b 1
)

echo Starting llama-server on port !PORT! with KV cache reuse and jinja templates...
llama-server -m "!MODEL_PATH!" ^
  --port !PORT! ^
  -c 16384 ^
  -fa on ^
  -ctk q8_0 ^
  -ctv q8_0 ^
  -ngl 99 ^
  --jinja ^
  --cache-reuse 256

pause
