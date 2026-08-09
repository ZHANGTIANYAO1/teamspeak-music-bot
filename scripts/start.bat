@echo off
title TSMusicBot
echo Starting TSMusicBot...
echo.

:: Check if node is available
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js is not installed.
    echo Run scripts\setup.bat first.
    pause
    exit /b 1
)

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.."

:: Check if dependencies are installed
if not exist "node_modules" (
    echo Dependencies not found. Please run scripts\setup.bat first.
    pause
    exit /b 1
)

:: Check if build output exists
if not exist "dist" (
    echo Build not found. Please run scripts\setup.bat first.
    pause
    exit /b 1
)

:: Preflight: do the compiled native modules match THIS Node version?
:: Switching Node majors after setup leaves node_modules built for the old ABI;
:: without this check the bot dies mid-startup with a NODE_MODULE_VERSION stack.
:: check-native.mjs prints the bilingual explanation itself; keep the lines in
:: this block pure ASCII (cmd.exe garbles multi-byte text inside blocks).
node scripts\check-native.mjs
if errorlevel 1 (
    echo.
    echo Please run scripts\setup.bat to rebuild the native modules.
    pause
    exit /b 1
)

:: Ensure PowerShell is in PATH (fix for jdymusic CDN playback on some systems)
where powershell >nul 2>&1
if errorlevel 1 (
    if exist "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" (
        set "PATH=%PATH%;C:\Windows\System32\WindowsPowerShell\v1.0\"
    )
)

:: Start the application
echo WebUI: http://localhost:3000
echo Press Ctrl+C to stop.
echo.
node dist/index.js

pause

