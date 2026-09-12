#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop Installer v2
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    Double-click this file in Finder, OR run from Terminal:
#      cd /path/to/claude-count-usage && bash install-v2.command
#
#  What's new in v2:
#    ✓ Auto-recovery if app.asar is corrupted
#    ✓ Removes ShipIt auto-updater (patch now survives reboots)
#    ✓ Clears staged Squirrel update caches
#    ✓ Removes old stale LaunchAgents from previous installs
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_ZIP="https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  $1${NC}"; echo ""; echo "Press Enter to close."; read; exit 1; }

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}   Claude Count Usage — Installer v2          ${NC}"
echo -e "${BOLD}   by Abdullah Alhar                          ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────

info "Checking Node.js..."
for node_path in "/usr/local/bin" "/opt/homebrew/bin"; do
  if [ -x "$node_path/node" ]; then
    export PATH="$node_path:$PATH"
    break
  fi
done
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1)"
  [ -n "$NVM_NODE" ] && [ -x "$NVM_NODE/node" ] && export PATH="$NVM_NODE:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed.\nPlease install Node.js from https://nodejs.org and run this installer again."
fi
log "Node.js $(node -v) found"

# ── 2. Check or Download Extension Files ───────────────────────

IS_TEMP_SOURCE=0
EXT_DIR="$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/manifest_electron.json" ] || [ ! -f "$SCRIPT_DIR/desktop-injector.js" ]; then
  info "Standalone installer detected — fetching latest extension from GitHub..."
  TMP_DOWNLOAD="$(mktemp -d /tmp/ccu-dl-XXXXXX)"
  IS_TEMP_SOURCE=1
  ZIP_PATH="$TMP_DOWNLOAD/repo.zip"
  curl -sSL "$GITHUB_ZIP" -o "$ZIP_PATH" || fail "Failed to download extension files from GitHub."
  unzip -q "$ZIP_PATH" -d "$TMP_DOWNLOAD" || fail "Failed to unpack extension archive."
  EXT_DIR="$TMP_DOWNLOAD/claude-count-usage-main"
  [ -f "$EXT_DIR/manifest_electron.json" ] || fail "Archive did not contain expected extension files."
  log "Downloaded latest extension files from GitHub"
else
  log "Using local extension files from: $SCRIPT_DIR"
fi

# ── 3. Build dataclasses and configure manifest ───────────────

info "Configuring extension files..."
cp "$EXT_DIR/manifest_electron.json" "$EXT_DIR/manifest.json"
if [ -f "$EXT_DIR/scripts/build-dataclasses.js" ]; then
  node "$EXT_DIR/scripts/build-dataclasses.js" >/dev/null 2>&1 || true
fi
log "Extension ready"

# ── 4. Close Claude & Run Injector ───────────────────────────

info "Closing Claude Desktop to release file locks..."
pkill -x "Claude" 2>/dev/null || true
sleep 1

info "Installing into Claude Desktop (v2 — with startup persistence fix)..."
node "$EXT_DIR/desktop-injector.js" install "$EXT_DIR"
INSTALL_EXIT=$?

# Clean up temp download if any
if [ "$IS_TEMP_SOURCE" -eq 1 ] && [ -d "$TMP_DOWNLOAD" ]; then
  rm -rf "$TMP_DOWNLOAD"
fi

if [ $INSTALL_EXIT -ne 0 ]; then
  fail "Installation failed. Check the output above for details."
fi

# ── 5. Verify the installation ────────────────────────────────

info "Verifying installation..."
CHECK_RESULT=$(node "$EXT_DIR/desktop-injector.js" check 2>/dev/null || echo "UNKNOWN")
if [ "$CHECK_RESULT" = "PATCHED" ]; then
  log "Verified: Claude Desktop is correctly patched"
else
  warn "Patch check returned: $CHECK_RESULT — Claude may still work, but verify manually"
fi

# ── 6. Check auto-update prevention ──────────────────────────

SHIPIT_PATH="/Applications/Claude.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt"
if [ ! -f "$SHIPIT_PATH" ]; then
  log "Auto-update protection active (ShipIt removed — patch will survive reboots)"
else
  warn "ShipIt still present — patch may be overwritten on reboot"
fi

# ── 7. Restart Claude Desktop ─────────────────────────────────

info "Restarting Claude Desktop..."
pkill -x "Claude" 2>/dev/null || true
sleep 1

CLAUDE_APP="/Applications/Claude.app"
if [ ! -d "$CLAUDE_APP" ] && [ -d "$HOME/Applications/Claude.app" ]; then
  CLAUDE_APP="$HOME/Applications/Claude.app"
fi

if [ -d "$CLAUDE_APP" ]; then
  xattr -cr "$CLAUDE_APP" 2>/dev/null || true
  open -a "$CLAUDE_APP"
  log "Claude Desktop launched"
else
  warn "Claude installed. Please open Claude from Applications."
fi

# ── 8. Done ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete! (v2)             ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "What to look for in Claude Desktop:"
echo "  • Left sidebar  → 'Usage' with Session (5h) + Weekly bars"
echo "  • In any chat   → Token / Cost / Cache stats below heading"
echo ""
echo "New in v2:"
echo "  • Patch now survives Mac reboots (ShipIt auto-update blocked)"
echo "  • Auto-recovery if Claude Desktop app.asar is corrupted"
echo ""
echo "To uninstall: double-click  uninstall.command"
echo ""
echo "Press Enter to close this window."
read
