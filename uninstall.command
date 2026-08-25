#!/bin/bash

# =============================================================
#  Claude Count Usage — UNINSTALLER
#  Created by Abdullah Alhar
#
#  Restores the original usage-tracker extension and
#  removes Claude Count Usage.
# =============================================================

LAUNCHER_EXTENSIONS="$HOME/Library/Application Support/Claude WebExtension Launcher/web-extensions"
LAUNCHER_APP="$HOME/Library/Application Support/Claude WebExtension Launcher/app-latest/Claude.app"
INSTALLED_EXT="$LAUNCHER_EXTENSIONS/usage-tracker"
BACKUP="$LAUNCHER_EXTENSIONS/usage-tracker-original-backup"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

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

# Check there's something to uninstall
[ -d "$LAUNCHER_EXTENSIONS" ] || fail "Launcher extensions folder not found.\nNothing to uninstall."

info "Removing Claude Count Usage extension..."
rm -rf "$INSTALLED_EXT"
log "Extension removed"

if [ -d "$BACKUP" ]; then
  info "Restoring original usage-tracker..."
  cp -r "$BACKUP" "$INSTALLED_EXT"
  rm -rf "$BACKUP"
  log "Original usage-tracker restored"
else
  warn "No backup found — original usage-tracker was not restored."
  warn "You can reinstall it by running the Claude WebExtension Launcher again."
fi

info "Restarting Claude..."
pkill -x "Claude" 2>/dev/null || true
sleep 1
[ -d "$LAUNCHER_APP" ] && open "$LAUNCHER_APP"
log "Claude launched"

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Uninstall complete!                        ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "Press Enter to close this window."
read
