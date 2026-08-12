@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Local LLM Tool Calling — False Positive Negative Test Suite
::
:: Tests non-tool utterances (chit-chat, disfluency, follow-ups)
:: to measure false positive rate (unwanted tool calls).
:: ============================================================

set SERVER_URL=%~1
set MODEL_NAME=%~2

if "!SERVER_URL!"=="" set SERVER_URL=http://localhost:8081/v1
if "!MODEL_NAME!"=="" set MODEL_NAME=gemma-4-E4B-it

echo.
echo ============================================================
echo  Local LLM False Positive / Negative Test Suite
echo  Server: !SERVER_URL!
echo  Model:  !MODEL_NAME!
echo ============================================================
echo.

python -c "import json; d=json.load(open('starter/docs/eval_dataset.json')); json.dump([x for x in d if x.get('expected_tool') is None], open('starter/docs/eval_negatives_tmp.json','w'), indent=2)"

python tmap_py\src\tmap\llm_eval_runner.py ^
    --schema "starter\docs\llm-tools.schema.json" ^
    --dataset "starter\docs\eval_negatives_tmp.json" ^
    --server "!SERVER_URL!" ^
    --model "!MODEL_NAME!" ^
    --out-dir "response\llm_eval"

if exist "starter\docs\eval_negatives_tmp.json" del "starter\docs\eval_negatives_tmp.json"

pause
