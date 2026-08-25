#!/bin/bash

# =============================================================
#  Claude Count Usage — UNINSTALLER
#  Created by Abdullah Alhar
# =============================================================

LAUNCHER_DIR="$HOME/Library/Application Support/Claude WebExtension Launcher"
EXTS_DIR="$LAUNCHER_DIR/web-extensions"
LAUNCHER_APP="$LAUNCHER_DIR/app-latest/Claude.app"
TARGET_EXT="$EXTS_DIR/usage-tracker"
BACKUP_DIR="$LAUNCHER_DIR/usage-tracker-backup"

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

[ -d "$EXTS_DIR" ] || fail "Launcher not found. Nothing to uninstall."

# Remove also any wrong backup that might be inside web-extensions
OLD_WRONG_BACKUP="$EXTS_DIR/usage-tracker-original-backup"
[ -d "$OLD_WRONG_BACKUP" ] && rm -rf "$OLD_WRONG_BACKUP" && warn "Removed stale backup from web-extensions"

info "Removing Claude Count Usage..."
rm -rf "$TARGET_EXT"
log "Extension removed"

if [ -d "$BACKUP_DIR" ]; then
  info "Restoring original usage-tracker..."
  cp -r "$BACKUP_DIR" "$TARGET_EXT"
  rm -rf "$BACKUP_DIR"
  log "Original usage-tracker restored"
else
  warn "No backup found — usage-tracker was not restored."
  warn "Run the Claude WebExtension Launcher app to reinstall it."
fi

info "Restarting Claude..."
pkill -x "Claude" 2>/dev/null || true
sleep 1
[ -d "$LAUNCHER_APP" ] && open "$LAUNCHER_APP" && log "Claude launched"

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Uninstall complete!                        ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "Press Enter to close."
read
