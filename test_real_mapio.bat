@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Real MapIO Graph Tool Evaluation Script
:: Runs ACTUAL MapIO python graph calculations on real maps (new_york.json)
:: via WSL python environment.
::
:: Usage:
::   test_real_mapio.bat [SERVER_URL] [MODEL_NAME] [QUESTION]
::
:: Examples:
::   test_real_mapio.bat http://localhost:11434/v1 auto "what is near 5th avenue?"
:: ============================================================

set SERVER_URL=%~1
set MODEL_NAME=%~2
set QUESTION=%~3

if "!SERVER_URL!"=="" set SERVER_URL=http://localhost:11434/v1
if "!MODEL_NAME!"=="" set MODEL_NAME=auto
if "!QUESTION!"=="" set QUESTION=what shops or restaurants are near 5th avenue?

set WSL_ENV=/home/znasif/anaconda3/envs/braille/bin/python
set SCRIPT_PATH=/mnt/d/Projects/AccessMapBeyondTheCurb/explore/simple_camio_llm/run_real_camio_eval.py

echo.
echo ============================================================
echo  Real MapIO Graph Tool Execution Evaluator (WSL)
echo  Server:   !SERVER_URL!
echo  Model:    !MODEL_NAME!
echo  Question: "!QUESTION!"
echo ============================================================
echo.

wsl.exe -d Ubuntu bash -c "!WSL_ENV! !SCRIPT_PATH! --server '!SERVER_URL!' --model '!MODEL_NAME!' --question '!QUESTION!'"

pause
