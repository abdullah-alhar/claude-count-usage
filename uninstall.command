#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop UNINSTALLER
#  Created by Abdullah Alhar
#
#  HOW TO USE:
#    Double-click this file in Finder.
#    It restores Claude to its original state.
# =============================================================

CLAUDE_APP="/Applications/Claude.app"
ASAR_PATH="$CLAUDE_APP/Contents/Resources/app.asar"
BACKUP_PATH="$CLAUDE_APP/Contents/Resources/app.asar.original"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  ERROR: $1${NC}"; echo ""; echo "Press Enter to close."; read; exit 1; }

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}  Claude Count Usage — Uninstaller             ${NC}"
echo -e "${BOLD}  by Abdullah Alhar                            ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# Check backup exists
if [ ! -f "$BACKUP_PATH" ]; then
  fail "No backup found at:\n  $BACKUP_PATH\n\nEither the extension was never installed, or the backup was deleted."
fi

info "Restoring original app.asar from backup..."
cp "$BACKUP_PATH" "$ASAR_PATH" || fail "Could not restore backup.\nTry running with sudo: sudo bash '$0'"
log "Original app.asar restored"

info "Removing backup file..."
rm -f "$BACKUP_PATH"
log "Backup removed"

info "Removing code signature (required after restore)..."
codesign --remove-signature "$CLAUDE_APP" 2>/dev/null || true
codesign --remove-signature "$CLAUDE_APP/Contents/MacOS/Claude" 2>/dev/null || true
log "Code signature removed"

info "Restarting Claude..."
pkill -x "Claude" 2>/dev/null || true
sleep 2
open "$CLAUDE_APP"
log "Claude launched"

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Uninstall complete!                        ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "Claude Count Usage has been removed."
echo "Claude is now running in its original state."
echo ""
echo "Press Enter to close this window."
read
