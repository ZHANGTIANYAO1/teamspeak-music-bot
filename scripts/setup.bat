@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title TSMusicBot Setup

:: ============================================================
::  TSMusicBot Setup Script (Windows)
::  - Auto-detect China network, switch to npmmirror
::  - Download native binaries from CDN (避开 GitHub)
::  - 自动修复 PowerShell 环境变量
:: ============================================================

set "SCRIPT_VERSION=2.2"
set "MIN_NODE_MAJOR=20"
:: Newest Node major this project is regularly tested against. Anything above
:: still works, it just may have no prebuilt addons and fall back to a source build.
set "TESTED_NODE_MAJOR=22"
set "LOG_FILE=%~dp0..\setup.log"
set "FAILED=0"

:: Resolve project root (one level up from scripts/)
cd /d "%~dp0.." || (
    echo [FATAL] Cannot change to project directory.
    pause
    exit /b 1
)

set "PROJECT_ROOT=%cd%"

:: ---- Initialize log ----
echo. > "%LOG_FILE%"
call :log "============================================"
call :log "  TSMusicBot Setup v%SCRIPT_VERSION%"
call :log "  Started: %date% %time%"
call :log "  Project root: %PROJECT_ROOT%"
call :log "============================================"

echo ============================================
echo   TSMusicBot - First-Time Setup (Windows)
echo   Version %SCRIPT_VERSION%
echo ============================================
echo.
echo Log file: %LOG_FILE%
echo.

:: ============================================================
:: Step 1: Check Node.js
:: ============================================================
call :step "1/7" "Checking Node.js"

where node >nul 2>&1
if not errorlevel 1 goto :check_node_version

call :error "Node.js not found in PATH."
echo.
echo Please install Node.js %MIN_NODE_MAJOR% LTS or newer from:
echo   https://nodejs.org/  (official)
echo   https://nodejs.cn/   (China mirror, recommended)
echo.
pause
exit /b 1

:check_node_version
for /f "delims=" %%v in ('node --version 2^>nul') do set "NODE_VER=%%v"
for /f "tokens=1 delims=v." %%a in ("%NODE_VER%") do set "NODE_MAJOR=%%a"

call :log "Node.js version: %NODE_VER%"
echo [OK] Node.js found: %NODE_VER%

:: The supported floor is not just a major version, so let node decide:
:: @honeybbq/teamspeak-client needs >=20.19, @sansenjian/qq-music-api needs
:: >=20.17 / >=22.9, and the odd majors (21 / 23) are excluded by
:: better-sqlite3 and vitest. Keep this in sync with "engines" in package.json.
node -e "const v=process.versions.node.split('.').map(Number); process.exit((v[0]===20&&v[1]>=19)||(v[0]===22&&v[1]>=12)||v[0]>=24?0:1)"
if errorlevel 1 (
    call :error "Node.js %NODE_VER% is not supported. Use Node 20.19+ LTS or Node 22.12+ LTS."
    echo         Download: https://nodejs.org/  or  https://nodejs.cn/
    pause
    exit /b 1
)

:: Not fatal: setup now rebuilds the native modules for whatever ABI you run,
:: so newer Node majors work - they are just slower to install.
:: NOTE: keep every line inside these parenthesised blocks pure ASCII.
:: cmd.exe mis-tracks its file offset when a block contains multi-byte UTF-8
:: characters and starts eating the "echo " prefix of following lines.
:: Bilingual guidance lives in the Node scripts, which print UTF-8 reliably.
if %NODE_MAJOR% GTR %TESTED_NODE_MAJOR% (
    echo [WARN] Node %NODE_VER% is newer than the tested LTS line, Node 20 / Node 22.
    echo        Newer Node majors may have no prebuilt opus / better-sqlite3,
    echo        so setup falls back to a source build - slower, needs C++ build tools.
    echo        Recommended: Node 20 LTS or Node 22 LTS - https://nodejs.org/ or https://nodejs.cn/
    echo        This is only a warning; setup still builds the binaries for %NODE_VER%.
    call :log "[WARN] Node major %NODE_MAJOR% is newer than tested LTS %TESTED_NODE_MAJOR%"
)
echo.

:: Native addons are tied to one Node ABI. If node_modules was built by a
:: different Node major, step 4b below detects it and repairs it.
call :log "Node ABI for this install: see node_modules\.tsmusicbot-abi after step 4b"

:: ============================================================
:: Step 2: Check npm
:: ============================================================
call :step "2/7" "Checking npm"

where npm >nul 2>&1
if errorlevel 1 (
    call :error "npm not found."
    pause
    exit /b 1
)

for /f "delims=" %%v in ('npm --version 2^>nul') do set "NPM_VER=%%v"
call :log "npm version: %NPM_VER%"
echo [OK] npm found: %NPM_VER%
echo.

:: ============================================================
:: Step 3: Detect network and configure mirror
:: ============================================================
call :step "3/7" "Checking network"

set "USE_MIRROR=0"
set "MIRROR_REGISTRY=https://registry.npmjs.org"

echo Testing connection to npm registry...
call :log "Testing npm registry connectivity..."

ping -n 1 -w 4000 registry.npmjs.org >nul 2>&1
if errorlevel 1 (
    echo [WARN] Cannot reach npm registry quickly, using China mirror.
    call :log "npm registry unreachable via ping"
    set "USE_MIRROR=1"
) else (
    echo [OK] npm registry reachable.
    call :log "npm registry reachable"
)

if "%USE_MIRROR%"=="1" (
    echo.
    echo [INFO] Using China mirror (npmmirror.com)
    call :log "Switching to npmmirror.com"
    set "MIRROR_REGISTRY=https://registry.npmmirror.com"
    set "CDN_MIRROR=https://cdn.npmmirror.com/binaries"
) else (
    set "CDN_MIRROR="
)
echo.

:: ============================================================
:: Step 4: Install backend dependencies (跳过二进制)
:: ============================================================
call :step "4/7" "Installing backend dependencies"

if exist "node_modules\.package-lock.json" (
    echo Found existing node_modules. Checking integrity...
)

echo Running: npm install --ignore-scripts (跳过 GitHub 二进制下载)
echo.

call npm install --registry=%MIRROR_REGISTRY% --ignore-scripts >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Backend npm install failed."
    echo Check the log: %LOG_FILE%
    pause
    exit /b 1
)
echo [OK] Backend dependencies installed.
echo.

:: ============================================================
:: Step 4b: Verify / download / repair native binaries (ABI aware)
:: ============================================================
call :step "4b/7" "Checking native binaries"

echo Verifying native modules for %NODE_VER% and downloading whatever is missing.
echo Progress is shown below; the full transcript goes to the log file.
echo.

:: The .mjs writes progress to stderr and - with TSMB_BINARY_LOG_STDOUT=1 - the
:: same lines to stdout. Redirecting only stdout therefore keeps the log complete
:: while the user still sees live progress instead of a frozen window.
set "TSMB_BINARY_LOG_STDOUT=1"
node scripts\download-binaries.mjs %CDN_MIRROR% >>"%LOG_FILE%"
set "BIN_RESULT=!errorlevel!"
set "TSMB_BINARY_LOG_STDOUT="

:: ASCII only inside these blocks - see the note near the Node version check.
if not "!BIN_RESULT!"=="0" (
    set "FAILED=1"
    call :error "A required native module is unusable - see the [binary] lines above."
    echo         Required: @discordjs/opus and better-sqlite3.
    echo         Full log: %LOG_FILE%
)

if "!FAILED!"=="1" (
    echo.
    echo Setup aborted. Fix the problem above and run this script again.
    call :log "Setup aborted at step 4b"
    pause
    exit /b 1
)

echo [OK] Native binaries ready for %NODE_VER%.
echo      ABI recorded in node_modules\.tsmusicbot-abi
echo.

:: ============================================================
:: Step 5: Install frontend dependencies
:: ============================================================
call :step "5/7" "Installing frontend dependencies"

if not exist "web\package.json" (
    call :error "web\package.json not found."
    pause
    exit /b 1
)

echo Running: npm install (in web/)
echo.

pushd web >nul
call npm install --registry=%MIRROR_REGISTRY% >>"%LOG_FILE%" 2>&1
set "WEB_INSTALL_RESULT=!errorlevel!"
popd >nul

if !WEB_INSTALL_RESULT! neq 0 (
    call :error "Frontend npm install failed."
    pause
    exit /b 1
)
echo [OK] Frontend dependencies installed.
echo.

:: ============================================================
:: Step 6: Build project
:: ============================================================
call :step "6/7" "Building project"

echo Running: npm run build
echo.

call npm run build >>"%LOG_FILE%" 2>&1
if errorlevel 1 (
    call :error "Build failed. Check: %LOG_FILE%"
    pause
    exit /b 1
)
echo [OK] Build succeeded.
echo.

:: ============================================================
:: Step 7: Ensure PowerShell in PATH (修复 jdymusic CDN 播放)
:: ============================================================
call :step "7/7" "Checking PowerShell PATH"

where powershell >nul 2>&1
if errorlevel 1 (
    echo [WARN] PowerShell not found in PATH.
    echo Attempting to fix...
    set "POWERSHELL_PATH=C:\Windows\System32\WindowsPowerShell\v1.0"
    if exist "!POWERSHELL_PATH!\powershell.exe" (
        :: 为用户添加永久 PATH 环境变量
        echo [INFO] Adding PowerShell to user PATH...
        call setx PATH "!POWERSHELL_PATH!;%PATH%" >nul 2>&1
        echo [OK] PowerShell added to PATH. Please restart your terminal.
    ) else (
        echo [WARN] Could not find powershell.exe on this system.
        echo        If you encounter playback issues with some NetEase songs,
        echo        run: set PATH=%%PATH%%;C:\Windows\System32\WindowsPowerShell\v1.0\
        echo        before running scripts\start.bat
    )
) else (
    echo [OK] PowerShell found in PATH.
)
echo.

:: ============================================================
:: Verify build outputs
:: ============================================================
echo Verifying build outputs...
set "BUILD_OK=1"

if not exist "dist" (
    call :error "dist/ directory missing after build."
    set "BUILD_OK=0"
)
if not exist "web\dist" (
    call :error "web\dist/ directory missing after build."
    set "BUILD_OK=0"
)

if "!BUILD_OK!"=="0" (
    echo Build completed but expected output is missing.
    pause
    exit /b 1
)
echo [OK] Build outputs verified.
echo.

if not exist "config.json" (
    echo [INFO] config.json will be auto-generated on first launch.
) else (
    echo [OK] config.json already exists.
)
echo.

:: ============================================================
:: Done
:: ============================================================
call :log "Setup completed successfully at %date% %time%"

echo ============================================
echo   Setup Complete!
echo ============================================
echo.
echo Next steps:
echo   1. Run:  scripts\start.bat
echo   2. Open: http://localhost:3000
echo.
echo Setup log: %LOG_FILE%
echo.
pause
exit /b 0

:: ============================================================
:: Subroutines
:: ============================================================
:step
echo ---- Step %~1: %~2 ----
call :log ""
call :log "---- Step %~1: %~2 ----"
goto :eof

:error
echo.
echo [ERROR] %~1
call :log "[ERROR] %~1"
goto :eof

:log
echo [%time%] %~1 >> "%LOG_FILE%"
goto :eof

