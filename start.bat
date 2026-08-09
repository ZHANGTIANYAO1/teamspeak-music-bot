@echo off
:: ============================================================
::  TSMusicBot - convenience launcher at the repo root.
::  Everything real lives in scripts\start.bat; this file only makes sure we
::  run from the project directory and then delegates, so both entry points
::  behave identically (same node/dist checks, same native-module preflight).
:: ============================================================

cd /d "%~dp0" || (
    echo [FATAL] Cannot change to the project directory.
    pause
    exit /b 1
)

:: Keep lines inside parenthesised blocks pure ASCII: cmd.exe mis-tracks its
:: file offset when a block contains multi-byte UTF-8 and eats the "echo " prefix.
if not exist "scripts\start.bat" (
    echo scripts\start.bat not found - is this the TSMusicBot project folder?
    pause
    exit /b 1
)

call "scripts\start.bat"
exit /b %errorlevel%
