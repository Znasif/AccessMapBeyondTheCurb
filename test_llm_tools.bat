@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Local LLM Tool Calling Evaluation Test Suite
::
:: Usage:
::   test_llm_tools.bat [SERVER_URL] [MODEL_NAME|PROFILE] [PROFILE] [--simulate-loop]
::
:: Examples:
::   test_llm_tools.bat http://localhost:11434/v1 camio
::   test_llm_tools.bat http://localhost:11434/v1 camio --simulate-loop
::   test_llm_tools.bat http://localhost:8081/v1 gemma-4-E4B-it osm_full --simulate-loop
:: ============================================================

set SERVER_URL=%~1
set ARG2=%~2
set ARG3=%~3
set ARG4=%~4

if "!SERVER_URL!"=="" set SERVER_URL=http://localhost:8081/v1
set MODEL_NAME=auto
set PROFILE_NAME=all
set SIM_LOOP_FLAG=

if "!ARG2!"=="--simulate-loop" set SIM_LOOP_FLAG=--simulate-loop
if "!ARG3!"=="--simulate-loop" set SIM_LOOP_FLAG=--simulate-loop
if "!ARG4!"=="--simulate-loop" set SIM_LOOP_FLAG=--simulate-loop

:: Detect if ARG2 is a capability profile name
if "!ARG2!"=="osm_full" (
    set PROFILE_NAME=osm_full
) else if "!ARG2!"=="osm_places_only" (
    set PROFILE_NAME=osm_places_only
) else if "!ARG2!"=="audiom_tier_a" (
    set PROFILE_NAME=audiom_tier_a
) else if "!ARG2!"=="audiom_tier_c" (
    set PROFILE_NAME=audiom_tier_c
) else if "!ARG2!"=="camio" (
    set PROFILE_NAME=camio
) else if "!ARG2!"=="all" (
    set PROFILE_NAME=all
) else if not "!ARG2!"=="" if not "!ARG2!"=="--simulate-loop" (
    set MODEL_NAME=!ARG2!
    if not "!ARG3!"=="" if not "!ARG3!"=="--simulate-loop" set PROFILE_NAME=!ARG3!
)

set SCHEMA_PATH=starter\docs\llm-tools.schema.json
set DATASET_PATH=starter\docs\eval_dataset.json
set OUT_DIR=response\llm_eval

echo.
echo ============================================================
echo  Local LLM Tool Calling Test Suite
echo  Server:   !SERVER_URL!
echo  Model:    !MODEL_NAME!
echo  Profile:  !PROFILE_NAME!
echo  Sim Loop: !SIM_LOOP_FLAG!
echo  Output:   !OUT_DIR!
echo ============================================================
echo.

:: 1. Health Probe on Server Endpoint
echo [1/2] Probing LLM Server endpoint...
curl -s -w "  HTTP status: %%{http_code}\n" "!SERVER_URL!/models" -o "NUL" 2>NUL
if errorlevel 1 (
    echo [WARNING] Server at !SERVER_URL! appears offline or unreachable.
    echo Make sure llama-server, Ollama, or vLLM is running.
    echo You can start llama-server using run_llama_server.bat
    echo.
) else (
    echo [OK] Server responded.
)

:: 2. Execute Python Evaluation Harness
echo.
echo [2/2] Running Tool Call Evaluation...
python tmap_py\src\tmap\llm_eval_runner.py ^
    --schema "!SCHEMA_PATH!" ^
    --dataset "!DATASET_PATH!" ^
    --server "!SERVER_URL!" ^
    --model "!MODEL_NAME!" ^
    --profile "!PROFILE_NAME!" ^
    --timeout 120 ^
    !SIM_LOOP_FLAG! ^
    --out-dir "!OUT_DIR!"

if errorlevel 1 (
    echo.
    echo [ERROR] Test evaluation failed.
    exit /b 1
)

echo.
echo Evaluation complete. Detailed reports saved in !OUT_DIR!\
pause
