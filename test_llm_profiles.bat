@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Capability Profile Sweep Test Suite
:: Evaluates tool calling accuracy sequentially across all 5 capability profiles:
:: 1. osm_full
:: 2. osm_places_only
:: 3. audiom_tier_a
:: 4. audiom_tier_c
:: 5. camio
:: ============================================================

set SERVER_URL=%~1
set MODEL_NAME=%~2

if "!SERVER_URL!"=="" set SERVER_URL=http://localhost:8081/v1
if "!MODEL_NAME!"=="" set MODEL_NAME=gemma-4-E4B-it

set PROFILES=osm_full osm_places_only audiom_tier_a audiom_tier_c camio

echo.
echo ============================================================
echo  Capability Profile Sweep Test Suite
echo  Server: !SERVER_URL!
echo  Model:  !MODEL_NAME!
echo ============================================================
echo.

for %%p in (%PROFILES%) do (
    echo.
    echo ------------------------------------------------------------
    echo  PROFILE: %%p
    echo ------------------------------------------------------------
    python tmap_py\src\tmap\llm_eval_runner.py ^
        --schema "starter\docs\llm-tools.schema.json" ^
        --dataset "starter\docs\eval_dataset.json" ^
        --server "!SERVER_URL!" ^
        --model "!MODEL_NAME!" ^
        --profile "%%p" ^
        --out-dir "response\llm_eval"
)

echo.
echo Profile sweep completed.
pause
