#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop Installer
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    1. Make sure the Claude WebExtension Launcher is installed
#       and has been run at least once (so its folder exists).
#    2. Double-click this file.
#
#  WHAT IT DOES:
#    Replaces the usage-tracker extension inside the launcher
#    with our stripped version (no donate buttons, 2 UI elements only).
#    The launcher's Claude app stays intact — no signature issues.
# =============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LAUNCHER_EXTENSIONS="$HOME/Library/Application Support/Claude WebExtension Launcher/web-extensions"
LAUNCHER_APP="$HOME/Library/Application Support/Claude WebExtension Launcher/app-latest/Claude.app"
ORIGINAL_EXT="$LAUNCHER_EXTENSIONS/usage-tracker"
OUR_EXT_NAME="usage-tracker"   # replace in-place so the launcher still finds it

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() {
  echo -e "${RED}❌  $1${NC}"
  echo ""
  echo "Press Enter to close."
  read
  exit 1
}

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}   Claude Count Usage — Desktop App Installer  ${NC}"
echo -e "${BOLD}   by Abdullah Alhar                           ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# ── Checks ─────────────────────────────────────────────────────

info "Checking Claude WebExtension Launcher is installed..."
if [ ! -d "$LAUNCHER_EXTENSIONS" ]; then
  fail "Claude WebExtension Launcher not found.\n\nPlease run the Claude_WebExtension_Launcher app first to set it up,\nthen double-click this installer again.\n\nLauncher is in your Downloads folder."
fi
log "Launcher found"

info "Checking our extension files..."
[ -f "$SCRIPT_DIR/manifest_electron.json" ] || fail "manifest_electron.json missing. Make sure install.command is inside the claude-count-usage folder."
[ -f "$SCRIPT_DIR/background.js"          ] || fail "background.js missing."
log "Extension files OK"

# ── Backup original extension ───────────────────────────────────

BACKUP="$LAUNCHER_EXTENSIONS/usage-tracker-original-backup"
if [ ! -d "$BACKUP" ] && [ -d "$ORIGINAL_EXT" ]; then
  info "Backing up original usage-tracker..."
  cp -r "$ORIGINAL_EXT" "$BACKUP"
  log "Backup saved → usage-tracker-original-backup"
else
  warn "Backup already exists or no original to back up — skipping"
fi

# ── Replace with our version ────────────────────────────────────

info "Installing Claude Count Usage..."

# Remove old extension (either original or previous install of ours)
rm -rf "$ORIGINAL_EXT"

# Copy our extension into place
mkdir -p "$ORIGINAL_EXT"
cp -r "$SCRIPT_DIR"/. "$ORIGINAL_EXT/"

# Copy the electron manifest as manifest.json
cp "$ORIGINAL_EXT/manifest_electron.json" "$ORIGINAL_EXT/manifest.json"

# Remove files that don't belong in the extension folder
rm -f "$ORIGINAL_EXT/install.command"
rm -f "$ORIGINAL_EXT/uninstall.command"
rm -f "$ORIGINAL_EXT/asar-patcher.js"
rm -f "$ORIGINAL_EXT/README.md"
rm -f "$ORIGINAL_EXT/PRIVACY.md"
rm -f "$ORIGINAL_EXT/manifest_chrome.json"

log "Claude Count Usage installed into launcher"

# ── Run the shared content script build step ───────────────────

info "Building content-components from shared files..."
if [ -f "$ORIGINAL_EXT/scripts/build-dataclasses.js" ]; then
  node "$ORIGINAL_EXT/scripts/build-dataclasses.js" && log "Content components built" || warn "Build step failed — files may already exist"
fi

# ── Launch Claude ───────────────────────────────────────────────

info "Launching Claude..."

# Kill any running Claude instance first
pkill -x "Claude" 2>/dev/null || true
sleep 1

if [ -d "$LAUNCHER_APP" ]; then
  open "$LAUNCHER_APP"
  log "Opened launcher's Claude.app"
else
  warn "Launcher app not found at expected path."
  warn "Please open Claude manually from: Claude WebExtension Launcher"
fi

# ── Done ────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete! 🎉                  ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "What to look for:"
echo "  • Left sidebar  → 'Usage' section with Session + Weekly bars"
echo "  • Open any chat → Token / Cost / Cache stats below heading"
echo ""
echo "To uninstall: double-click  uninstall.command"
echo ""
echo "Press Enter to close this window."
read
