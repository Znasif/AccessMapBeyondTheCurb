@echo off
setlocal enabledelayedexpansion

:: ============================================================
:: Setup script to clone simple_camio repo (branch: llm)
:: Target directory: explore\simple_camio_llm
:: ============================================================

set TARGET_DIR=explore\simple_camio_llm

if exist "!TARGET_DIR!" (
    echo [INFO] Directory !TARGET_DIR! already exists.
    echo Pulling latest changes from llm branch...
    git -C "!TARGET_DIR!" pull origin llm
) else (
    echo [INFO] Cloning Coughlan-Lab/simple_camio (branch llm) into !TARGET_DIR!...
    if not exist "explore" mkdir "explore"
    git clone -b llm https://github.com/Coughlan-Lab/simple_camio.git "!TARGET_DIR!"
)

if errorlevel 1 (
    echo [ERROR] Git clone or pull failed.
) else (
    echo [OK] simple_camio (llm branch) ready in !TARGET_DIR!\
)

pause
