#!/usr/bin/env bash
set -euo pipefail

#
# TSMusicBot Setup Script (Linux/macOS)
# - Auto-detect China network, switch to npmmirror
# - Download native binaries from CDN (避开 GitHub)
# - One-click setup, same as setup.bat for Windows
#

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_FILE="$PROJECT_DIR/setup.log"

echo "============================================"
echo "  TSMusicBot - First-Time Setup (Linux)"
echo "============================================"
echo ""
echo "Log file: $LOG_FILE"
echo ""

# ---- Check Node.js ----
if ! command -v node &>/dev/null; then
    echo "[ERROR] Node.js not found. Please install Node.js 20+ from https://nodejs.org"
    echo "        or https://nodejs.cn/ (China mirror)."
    exit 1
fi
echo "[OK] Node.js $(node -v)"

# Newest Node major this project is regularly tested against. Anything above
# still works, it just may have no prebuilt addons and fall back to a source build.
TESTED_NODE_MAJOR=22
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"

# The floor is not just a major version, so let node decide. Node 20 was dropped:
# better-sqlite3 ships no prebuilt binary for its ABI (115) since 12.10.0, so every
# Node 20 install needed Python and a C++ toolchain just to get off the ground
# (issue #152). The odd majors (21 / 23) are excluded by better-sqlite3 and vitest.
# Keep in sync with package.json "engines".
if ! node -e 'const v=process.versions.node.split(".").map(Number); process.exit((v[0]===22&&v[1]>=12)||v[0]>=24?0:1)'; then
    echo "[ERROR] Node.js $(node -v) is not supported. Use Node 22.12+ LTS or newer."
    echo "        https://nodejs.org/  |  https://nodejs.cn/"
    exit 1
fi
if [ "$NODE_MAJOR" -gt "$TESTED_NODE_MAJOR" ]; then
    echo "[WARN] Node $(node -v) is newer than the tested LTS line (Node 22)."
    echo "       新版 Node 可能没有现成的 opus / better-sqlite3 预编译包,"
    echo "       安装时会自动改用源码编译,需要 C/C++ 构建工具,速度较慢。"
    echo "       This is only a warning - setup builds the binaries for $(node -v) either way."
fi

if ! command -v npm &>/dev/null; then
    echo "[ERROR] npm not found."
    exit 1
fi
echo "[OK] npm v$(npm -v)"
echo ""

# ---- Detect China network ----
USE_MIRROR=0
MIRROR_REGISTRY="https://registry.npmjs.org"
CDN_MIRROR=""

echo "Testing connection to npm registry..."
if ping -c 1 -W 4 registry.npmjs.org &>/dev/null; then
    echo "[OK] npm registry reachable."
else
    echo "[WARN] Cannot reach npm registry, using China mirror."
    USE_MIRROR=1
fi

if [ "$USE_MIRROR" = "1" ]; then
    echo "[INFO] Using China mirror (npmmirror.com)"
    MIRROR_REGISTRY="https://registry.npmmirror.com"
    CDN_MIRROR="https://cdn.npmmirror.com/binaries"
    export npm_config_registry="$MIRROR_REGISTRY"
fi
echo ""

# ---- Check build tools (needed for native module fallback) ----
if ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
    echo "[INFO] No C compiler found. If CDN binaries are unavailable,"
    echo "       native modules may fail. Install build tools:"
    echo "       sudo apt install build-essential  (Ubuntu/Debian)"
    echo "       sudo yum groupinstall 'Development Tools'  (CentOS/RHEL)"
    echo ""
fi

# ---- Step 1: Install dependencies (skip GitHub binaries) ----
echo "---- 1/5: Installing Node.js dependencies ----"
echo ""

cd "$PROJECT_DIR"
npm install --registry="$MIRROR_REGISTRY" --ignore-scripts 2>&1 | tee -a "$LOG_FILE"
echo "[OK] Dependencies installed."
echo ""

# ---- Step 2: Verify / download / repair native binaries (ABI aware) ----
echo "---- 2/5: Checking native binaries ----"
echo ""

# The old `if node ... | tee ...` only printed a [WARN] and carried on, so a
# broken native module still produced a "Setup Complete!" banner. It also read
# the *pipeline's* status: `set -o pipefail` above happens to surface node's
# failure, but a failing `tee` (unwritable log) was indistinguishable from a
# failing node. PIPESTATUS[0] is exactly node's own exit code, nothing else.
set +e
node scripts/download-binaries.mjs $CDN_MIRROR 2>&1 | tee -a "$LOG_FILE"
BIN_STATUS=${PIPESTATUS[0]}
set -e

if [ "$BIN_STATUS" -ne 0 ]; then
    echo ""
    echo "[ERROR] A required native module (@discordjs/opus / better-sqlite3) is unusable."
    echo "        必需的原生模块不可用,安装中止。原因见上面的 [binary] 输出。"
    echo "        Log: $LOG_FILE"
    exit 1
fi
# ffmpeg-static failures are only a WARN inside the script above (a system
# ffmpeg on PATH is a supported fallback), so reaching here means we are good.
echo "[OK] Native binaries ready for $(node -v)."
echo ""

# ---- Step 3: Install web panel dependencies ----
echo "---- 3/5: Installing web panel dependencies ----"
echo ""

if [ -f "web/package.json" ]; then
    cd "$PROJECT_DIR/web"
    npm install --registry="$MIRROR_REGISTRY" 2>&1 | tee -a "$LOG_FILE"
    cd "$PROJECT_DIR"
    echo "[OK] Web panel dependencies installed."
else
    echo "[SKIP] web/package.json not found."
fi
echo ""

# ---- Step 4: Build project ----
echo "---- 4/5: Building project ----"
echo ""

npm run build 2>&1 | tee -a "$LOG_FILE"
echo "[OK] Build succeeded."
echo ""

# ---- Step 5: Verify ----
echo "---- 5/5: Verifying build ----"
echo ""

BUILD_OK=1
if [ ! -d "dist" ]; then
    echo "[ERROR] dist/ directory missing."
    BUILD_OK=0
fi
if [ -d "web" ] && [ ! -d "web/dist" ]; then
    echo "[ERROR] web/dist/ directory missing."
    BUILD_OK=0
fi

if [ "$BUILD_OK" = "0" ]; then
    echo "Build completed but expected output is missing."
    exit 1
fi
echo "[OK] Build outputs verified."
echo ""

if [ ! -f "config.json" ]; then
    echo "[INFO] config.json will be auto-generated on first launch."
fi
echo ""

echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "  1. Run:  npm start"
echo "  2. Open: http://localhost:3000"
echo ""
echo "Setup log: $LOG_FILE"
echo ""

