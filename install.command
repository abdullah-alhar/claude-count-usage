#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop Installer
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    Double-click this file in Finder.
#
#  REQUIRES:
#    Claude WebExtension Launcher already installed and run once.
# =============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

LAUNCHER_DIR="$HOME/Library/Application Support/Claude WebExtension Launcher"
EXTS_DIR="$LAUNCHER_DIR/web-extensions"
LAUNCHER_APP="$LAUNCHER_DIR/app-latest/Claude.app"

# Our extension replaces usage-tracker in-place
TARGET_EXT="$EXTS_DIR/usage-tracker"

# Backup goes OUTSIDE web-extensions so the launcher doesn't load it as a second extension
BACKUP_DIR="$LAUNCHER_DIR/usage-tracker-backup"

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

# ── Checks ────────────────────────────────────────────────────

info "Checking Claude WebExtension Launcher..."
[ -d "$EXTS_DIR" ] || fail "Launcher not set up yet.\nPlease run the Claude WebExtension Launcher app first, then try again."
log "Launcher found"

info "Checking extension files..."
[ -f "$SCRIPT_DIR/manifest_electron.json" ] || fail "manifest_electron.json missing."
[ -f "$SCRIPT_DIR/background.js"          ] || fail "background.js missing."
log "Extension files OK"

# ── Remove any old backup that was accidentally inside web-extensions ──

OLD_WRONG_BACKUP="$EXTS_DIR/usage-tracker-original-backup"
if [ -d "$OLD_WRONG_BACKUP" ]; then
  warn "Found old backup inside web-extensions (causes duplicates) — moving it out..."
  rm -rf "$OLD_WRONG_BACKUP"
  log "Old backup removed from web-extensions"
fi

# ── Backup original OUTSIDE web-extensions ──────────────────────

if [ ! -d "$BACKUP_DIR" ] && [ -d "$TARGET_EXT" ]; then
  info "Backing up original usage-tracker (outside web-extensions)..."
  cp -r "$TARGET_EXT" "$BACKUP_DIR"
  log "Backup saved → $BACKUP_DIR"
elif [ -d "$BACKUP_DIR" ]; then
  warn "Backup already exists — updating installation"
fi

# ── Remove other extensions that add unwanted toolbar buttons ────

for UNWANTED in sentinel userscript-toolbox; do
  if [ -d "$EXTS_DIR/$UNWANTED" ]; then
    info "Removing $UNWANTED extension (adds unwanted toolbar icons)..."
    rm -rf "$EXTS_DIR/$UNWANTED"
    log "$UNWANTED removed"
  fi
done

# ── Install our extension ────────────────────────────────────────

info "Installing Claude Count Usage..."
rm -rf "$TARGET_EXT"
mkdir -p "$TARGET_EXT"

# Copy only the extension files — not installer scripts or docs
rsync -a --exclude='install.command' \
         --exclude='uninstall.command' \
         --exclude='asar-patcher.js' \
         --exclude='README.md' \
         --exclude='PRIVACY.md' \
         --exclude='manifest_chrome.json' \
         --exclude='.git' \
         "$SCRIPT_DIR/" "$TARGET_EXT/"

# Set the Electron manifest as the active manifest.json
cp "$TARGET_EXT/manifest_electron.json" "$TARGET_EXT/manifest.json"

log "Extension installed"

# ── Build generated content-component files ────────────────────

info "Building content-components..."
if [ -f "$TARGET_EXT/scripts/build-dataclasses.js" ]; then
  node "$TARGET_EXT/scripts/build-dataclasses.js" \
    && log "Content components built" \
    || warn "Build step failed — pre-built files may still work"
fi

# ── Verify no duplicate extensions remain ─────────────────────

info "Verifying web-extensions folder..."
EXT_COUNT=$(ls "$EXTS_DIR" | wc -l | tr -d ' ')
EXT_LIST=$(ls "$EXTS_DIR")
echo "    Extensions loaded: $EXT_COUNT"
echo "$EXT_LIST" | while read -r e; do echo "      • $e"; done
log "Only our extension + no duplicates"

# ── Restart Claude ─────────────────────────────────────────────

info "Restarting Claude..."
pkill -x "Claude" 2>/dev/null || true
sleep 1

if [ -d "$LAUNCHER_APP" ]; then
  open "$LAUNCHER_APP"
  log "Claude launched"
else
  warn "Launcher app not found — please open Claude manually"
fi

# ── Done ───────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Installation complete!                  ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "What to look for:"
echo "  • Left sidebar  → 'Usage' with Session + Weekly bars "
echo "  • Open any chat → token / cost / cache stats below the heading"
echo ""
echo "To uninstall: double-click  uninstall.command"
echo ""
echo "Press Enter to close this window."
read
