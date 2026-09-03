#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop UNINSTALLER
#  Created by Abdullah Alhar
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_REPO="https://github.com/abdullah-alhar/claude-count-usage"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  $1${NC}"; echo ""; echo "Press Enter to close."; read; exit 1; }

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}  Claude Count Usage — Uninstaller             ${NC}"
echo -e "${BOLD}  by Abdullah Alhar                            ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# Find Node
NODE_DIR="$HOME/Library/Application Support/ClaudeCountUsage/node"
if [ -x "$NODE_DIR/bin/node" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
fi

if ! command -v node >/dev/null 2>&1; then
  if [ -x "/usr/local/bin/node" ]; then export PATH="/usr/local/bin:$PATH";
  elif [ -x "/opt/homebrew/bin/node" ]; then export PATH="/opt/homebrew/bin:$PATH";
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required to run the unpatcher."
fi

# Locate Claude.app
CLAUDE_APP="/Applications/Claude.app"
if [ ! -d "$CLAUDE_APP" ] && [ -d "$HOME/Applications/Claude.app" ]; then
  CLAUDE_APP="$HOME/Applications/Claude.app"
fi

RESOURCES_DIR="$CLAUDE_APP/Contents/Resources"
ASAR_PATH="$RESOURCES_DIR/app.asar"
BACKUP_PATH="$RESOURCES_DIR/app.asar.bak"
INJECTED_DIR="$RESOURCES_DIR/injected-extension"

# Check if injector script is present locally
if [ -f "$SCRIPT_DIR/desktop-injector.js" ]; then
  node "$SCRIPT_DIR/desktop-injector.js" unpatch || true
else
  # Direct fallback restoration
  if [ -f "$BACKUP_PATH" ]; then
    info "Restoring original app.asar from backup..."
    cp "$BACKUP_PATH" "$ASAR_PATH"
    log "Original app.asar restored"
  else
    warn "No backup app.asar.bak found in $RESOURCES_DIR"
  fi

  if [ -d "$INJECTED_DIR" ]; then
    rm -rf "$INJECTED_DIR"
    log "Removed injected extension directory"
  fi

  if [ -d "$CLAUDE_APP" ]; then
    info "Re-signing Claude Desktop bundle..."
    codesign --force --deep --sign - "$CLAUDE_APP" || true
  fi
fi

# Clean up any legacy launcher web-extensions if present
LEGACY_EXT="$HOME/Library/Application Support/Claude WebExtension Launcher/web-extensions/usage-tracker"
if [ -d "$LEGACY_EXT" ]; then
  rm -rf "$LEGACY_EXT"
  log "Cleaned up legacy launcher extension copy"
fi

info "Restarting Claude Desktop..."
pkill -x "Claude" 2>/dev/null || true
sleep 1
if [ -d "$CLAUDE_APP" ]; then
  open -a "$CLAUDE_APP"
  log "Claude Desktop restarted"
fi

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Uninstall complete!                        ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "Claude Desktop has been restored to its original state."
echo ""
echo "Press Enter to close."
read
