#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop Installer
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    Double-click this file in Finder.
#    It will install the extension into the Claude desktop app.
#
#  WHAT IT DOES:
#    1. Backs up Claude's app.asar (so you can always uninstall)
#    2. Injects the extension loader into Claude's main process
#    3. Repacks the asar
#    4. Restarts Claude with the extension active
# =============================================================

# Get the directory this script lives in (the extension folder)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$SCRIPT_DIR"

CLAUDE_APP="/Applications/Claude.app"
ASAR_PATH="$CLAUDE_APP/Contents/Resources/app.asar"
BACKUP_PATH="$CLAUDE_APP/Contents/Resources/app.asar.original"
WORK_DIR="$HOME/.claude-count-usage-tmp"

# ---- Colors ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  ERROR: $1${NC}"; echo ""; echo "Installation failed. Press Enter to close."; read; exit 1; }

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}   Claude Count Usage — Desktop App Installer  ${NC}"
echo -e "${BOLD}   by Abdullah Alhar                           ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# ---- 1. Pre-flight checks ----

info "Checking Claude.app..."
[ -d "$CLAUDE_APP" ] || fail "Claude.app not found at /Applications/Claude.app\nPlease make sure the Claude desktop app is installed."
[ -f "$ASAR_PATH" ]  || fail "Could not find app.asar inside Claude.app."
log "Claude.app found"

info "Checking Node.js..."
if ! which node > /dev/null 2>&1; then
  fail "Node.js is required but not installed.\nInstall it from: https://nodejs.org\nThen double-click this file again."
fi
NODE_VER=$(node --version)
log "Node.js $NODE_VER found"

info "Checking extension folder..."
[ -f "$EXTENSION_DIR/manifest_electron.json" ] || fail "manifest_electron.json not found in:\n$EXTENSION_DIR\n\nMake sure you run this installer from inside the claude-count-usage folder."
log "Extension folder OK: $EXTENSION_DIR"

# ---- 2. Set manifest.json to Electron version ----

info "Setting up Electron manifest..."
cp "$EXTENSION_DIR/manifest_electron.json" "$EXTENSION_DIR/manifest.json"
log "manifest.json set to Electron version"

# ---- 3. Backup original asar ----

if [ -f "$BACKUP_PATH" ]; then
  warn "Backup already exists — skipping backup (previous install detected)"
  info "To do a fresh install, delete: $BACKUP_PATH"
else
  info "Backing up original app.asar..."
  cp "$ASAR_PATH" "$BACKUP_PATH" || fail "Could not create backup. Try running with sudo:\n  sudo bash '$0'"
  log "Backup saved to app.asar.original"
fi

# ---- 4. Extract asar ----

info "Extracting app.asar (may take 10-30 seconds)..."
rm -rf "$WORK_DIR"
npx --yes @electron/asar extract "$ASAR_PATH" "$WORK_DIR" 2>&1 | tail -3
[ -d "$WORK_DIR" ] || fail "Failed to extract app.asar"
log "Extracted app.asar"

# ---- 5. Find the main process entry point ----

info "Locating main process entry point..."

# Strategy: find the JS file that creates BrowserWindow AND
# is referenced as "main" in package.json, OR is the largest
# JS file at the root of the extracted folder.

MAIN_FROM_PKG=""
if [ -f "$WORK_DIR/package.json" ]; then
  MAIN_FROM_PKG=$(node -e "try{const p=require('$WORK_DIR/package.json');console.log(p.main||'')}catch(e){}" 2>/dev/null)
fi

TARGET_JS=""

# First try: use the "main" field from package.json
if [ -n "$MAIN_FROM_PKG" ]; then
  CANDIDATE="$WORK_DIR/$MAIN_FROM_PKG"
  if [ -f "$CANDIDATE" ] && grep -q "BrowserWindow\|app\.whenReady" "$CANDIDATE" 2>/dev/null; then
    TARGET_JS="$CANDIDATE"
    log "Found main process from package.json: $MAIN_FROM_PKG"
  fi
fi

# Second try: grep for BrowserWindow in all root-level JS files
if [ -z "$TARGET_JS" ]; then
  for f in "$WORK_DIR"/*.js; do
    if grep -q "BrowserWindow" "$f" 2>/dev/null; then
      TARGET_JS="$f"
      log "Found main process (by BrowserWindow): $(basename $f)"
      break
    fi
  done
fi

# Third try: any subdirectory main JS
if [ -z "$TARGET_JS" ]; then
  FOUND=$(grep -rl "BrowserWindow" "$WORK_DIR" --include="*.js" -l 2>/dev/null | head -1)
  if [ -n "$FOUND" ]; then
    TARGET_JS="$FOUND"
    log "Found main process (deep search): ${TARGET_JS#$WORK_DIR/}"
  fi
fi

[ -n "$TARGET_JS" ] || fail "Could not find the main process JavaScript file inside app.asar.\nPlease report this at: https://github.com/abdullahalhar/claude-count-usage"

info "Target: ${TARGET_JS#$WORK_DIR/}"

# ---- 6. Inject extension loader ----

info "Checking for existing injection..."
if grep -q "CLAUDE_COUNT_USAGE" "$TARGET_JS" 2>/dev/null; then
  warn "Previous injection found — removing old version first..."
  # Remove old block using Python (handles multiline cleanly)
  python3 -c "
import re, sys
content = open('$TARGET_JS', 'r').read()
cleaned = re.sub(r'// CLAUDE_COUNT_USAGE_START.*?// CLAUDE_COUNT_USAGE_END\n?', '', content, flags=re.DOTALL)
open('$TARGET_JS', 'w').write(cleaned)
print('Old injection removed.')
"
fi

info "Injecting extension loader..."

# The injection: appended at end of file, runs after Electron is ready
INJECT=$(cat << 'INJECT_BLOCK'

// CLAUDE_COUNT_USAGE_START
// Claude Count Usage Extension — injected by installer (Abdullah Alhar)
(function() {
  try {
    const _mod = require('electron');
    const _app = _mod.app;
    const _session = _mod.session;
    const _extPath = '__EXTENSION_DIR__';
    const _load = () => {
      _session.defaultSession
        .loadExtension(_extPath, { allowFileAccess: true })
        .then(() => console.log('[ClaudeCountUsage] Loaded from', _extPath))
        .catch(err => console.error('[ClaudeCountUsage] Load failed:', err));
    };
    if (_app.isReady()) { _load(); }
    else { _app.whenReady().then(_load); }
  } catch(e) {
    console.error('[ClaudeCountUsage] Injection error:', e);
  }
})();
// CLAUDE_COUNT_USAGE_END
INJECT_BLOCK
)

# Replace placeholder with actual extension path
INJECT="${INJECT/__EXTENSION_DIR__/$EXTENSION_DIR}"

# Append to target file
echo "$INJECT" >> "$TARGET_JS"
log "Extension loader injected"

# ---- 7. Repack asar ----

info "Repacking app.asar (may take 10-30 seconds)..."
npx --yes @electron/asar pack "$WORK_DIR" "$ASAR_PATH" 2>&1 | tail -3
log "Repacked app.asar"

# ---- 8. Remove code signature (required after modifying) ----

info "Removing code signature..."
codesign --remove-signature "$CLAUDE_APP" 2>/dev/null || true
codesign --remove-signature "$CLAUDE_APP/Contents/MacOS/Claude" 2>/dev/null || true
log "Code signature removed"

# ---- 9. Clean up temp files ----

rm -rf "$WORK_DIR"
log "Temp files cleaned up"

# ---- 10. Restart Claude ----

info "Restarting Claude..."
pkill -x "Claude" 2>/dev/null || true
sleep 2
open "$CLAUDE_APP"
log "Claude launched"

# ---- Done ----

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete! 🎉                  ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "What to look for in the Claude app:"
echo "  • Left sidebar  → 'Usage' section with Session + Weekly bars"
echo "  • Chat window   → Token / Cost / Cache stats below the heading"
echo ""
echo "To UNINSTALL: double-click uninstall.command"
echo ""
echo "Press Enter to close this window."
read
