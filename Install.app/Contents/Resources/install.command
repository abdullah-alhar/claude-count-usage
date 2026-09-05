#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop Installer
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    Double-click this file in Finder.
#    Works standalone (auto-downloads extension if run alone)
#    and directly patches official Claude Desktop.
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_REPO="https://github.com/abdullah-alhar/claude-count-usage"
GITHUB_ZIP="https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  $1${NC}"; echo ""; echo "Press Enter to close."; read; exit 1; }

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}   Claude Count Usage — Desktop Installer      ${NC}"
echo -e "${BOLD}   by Abdullah Alhar                           ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# ── 1. Check Node.js ──────────────────────────────────────────

info "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  # Check standard Mac paths
  if [ -x "/usr/local/bin/node" ]; then
    export PATH="/usr/local/bin:$PATH"
  elif [ -x "/opt/homebrew/bin/node" ]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [ -d "$HOME/.nvm/versions/node" ]; then
    NVM_NODE="$(ls -d "$HOME/.nvm/versions/node"/*/bin 2>/dev/null | tail -n 1)"
    if [ -n "$NVM_NODE" ] && [ -x "$NVM_NODE/node" ]; then
      export PATH="$NVM_NODE:$PATH"
    fi
  fi
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

  curl -sSL "$GITHUB_ZIP" -o "$ZIP_PATH" || fail "Failed to download extension files from GitHub ($GITHUB_ZIP)."
  unzip -q "$ZIP_PATH" -d "$TMP_DOWNLOAD" || fail "Failed to unpack extension archive."

  EXT_DIR="$TMP_DOWNLOAD/claude-count-usage-main"
  [ -f "$EXT_DIR/manifest_electron.json" ] || fail "Archive did not contain expected extension files."
  log "Downloaded latest extension files from GitHub"
fi

# ── 3. Build dataclasses and configure manifest ───────────────

info "Configuring extension files..."
if [ -f "$EXT_DIR/manifest_electron.json" ]; then
  cp "$EXT_DIR/manifest_electron.json" "$EXT_DIR/manifest.json"
fi

if [ -f "$EXT_DIR/scripts/build-dataclasses.js" ]; then
  node "$EXT_DIR/scripts/build-dataclasses.js" >/dev/null 2>&1 || true
fi
log "Extension ready"

# ── 4. Run Injector to patch Claude Desktop ───────────────────

info "Installing into Claude Desktop..."
node "$EXT_DIR/desktop-injector.js" install "$EXT_DIR"

# Clean up temp download if any
if [ "$IS_TEMP_SOURCE" -eq 1 ] && [ -d "$TMP_DOWNLOAD" ]; then
  rm -rf "$TMP_DOWNLOAD"
fi

# ── 5. Restart Claude Desktop ─────────────────────────────────

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

# ── 6. Done ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete!                  ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "What to look for in Claude Desktop:"
echo "  • Left sidebar  → 'Usage' with Session (5h) + Weekly bars"
echo "  • In any chat   → Token / Cost / Cache stats below heading"
echo ""
echo "To uninstall: double-click  uninstall.command"
echo ""
echo "Press Enter to close this window."
read
