#!/bin/bash

# =============================================================
#  Claude Count Usage — Mac Desktop UNINSTALLER
#  Created by Abdullah Alhar
#
#  Performs a COMPLETE uninstall: deletes the Claude Desktop app
#  entirely, rather than restoring the patched app.asar in place
#  (that relied on a backup made on first patch, which goes stale
#  the moment Claude Desktop auto-updates).
#
#  Uses desktop-injector.js's locateClaude() — the SAME lookup the
#  installer already relies on — so it finds Claude wherever it
#  actually lives instead of guessing a fixed path.
#
#  After this runs, download a fresh copy of Claude Desktop from
#  https://claude.ai/download if you want to keep using it without
#  this extension.
# =============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GITHUB_ZIP="https://github.com/abdullah-alhar/claude-count-usage/archive/refs/heads/main.zip"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${GREEN}✅  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $1${NC}"; }
info() { echo -e "${BLUE}ℹ️   $1${NC}"; }
fail() { echo -e "${RED}❌  $1${NC}"; echo ""; echo "Press Enter to close."; read; exit 1; }

IS_TEMP_SOURCE=0
TMP_DOWNLOAD=""
cleanup_temp() {
  if [ "$IS_TEMP_SOURCE" -eq 1 ] && [ -n "$TMP_DOWNLOAD" ] && [ -d "$TMP_DOWNLOAD" ]; then
    rm -rf "$TMP_DOWNLOAD"
  fi
}

clear
echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${BOLD}  Claude Count Usage — Uninstaller             ${NC}"
echo -e "${BOLD}  by Abdullah Alhar                            ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""

# ── Find Node ──────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  if [ -x "/usr/local/bin/node" ]; then export PATH="/usr/local/bin:$PATH";
  elif [ -x "/opt/homebrew/bin/node" ]; then export PATH="/opt/homebrew/bin:$PATH";
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is required to locate Claude Desktop.\nInstall it from https://nodejs.org and run this again."
fi

# ── Get desktop-injector.js (always fetch the latest from GitHub) ──
info "Fetching latest uninstaller files from GitHub..."
TMP_DOWNLOAD="$(mktemp -d /tmp/ccu-uninstall-XXXXXX)"
IS_TEMP_SOURCE=1
ZIP_PATH="$TMP_DOWNLOAD/repo.zip"
curl -sSL "$GITHUB_ZIP" -o "$ZIP_PATH" || fail "Failed to download uninstaller files from GitHub."
unzip -q "$ZIP_PATH" -d "$TMP_DOWNLOAD" || fail "Failed to unpack archive."
EXT_DIR="$TMP_DOWNLOAD/claude-count-usage-main"
[ -f "$EXT_DIR/desktop-injector.js" ] || fail "Archive did not contain desktop-injector.js."

# ── Locate Claude Desktop ──────────────────────────────────
LOCATE_OUTPUT="$(node "$EXT_DIR/desktop-injector.js" locate 2>/dev/null || true)"

case "$LOCATE_OUTPUT" in
  NOT_FOUND)
    warn "Claude Desktop was not found on this Mac."
    info "Nothing to uninstall."
    cleanup_temp
    echo ""; echo "Press Enter to close."; read
    exit 0
    ;;
  PROTECTED:*)
    APP_PATH="${LOCATE_OUTPUT#PROTECTED:}"
    warn "Claude Desktop at $APP_PATH is a protected/managed install."
    info "Remove it via Finder (drag to Trash) or your management tool instead."
    cleanup_temp
    echo ""; echo "Press Enter to close."; read
    exit 0
    ;;
  FOUND:*)
    APP_PATH="${LOCATE_OUTPUT#FOUND:}"
    ;;
  *)
    cleanup_temp
    fail "Could not determine whether Claude Desktop is installed (unexpected output: $LOCATE_OUTPUT)."
    ;;
esac

warn "This will completely DELETE Claude Desktop from this Mac:"
echo "    $APP_PATH"
echo ""
echo "This is a full uninstall, not just a revert of our patch."
echo "Your Claude login/chat data is stored separately by the app"
echo "and will NOT be touched — only the application itself is removed."
echo ""
read -p "Continue? [y/N] " CONFIRM
case "$CONFIRM" in
  [yY]|[yY][eE][sS]) ;;
  *)
    echo "Cancelled."
    cleanup_temp
    echo ""; echo "Press Enter to close."; read
    exit 0
    ;;
esac

echo ""
info "Deleting Claude Desktop..."
DELETE_OUTPUT="$(node "$EXT_DIR/desktop-injector.js" delete 2>/dev/null || true)"

case "$DELETE_OUTPUT" in
  DELETED:*) log "Deleted $APP_PATH" ;;
  *) warn "Could not confirm deletion — check manually: $APP_PATH" ;;
esac

# Clean up our extension's legacy launcher copy, if present
LEGACY_EXT="$HOME/Library/Application Support/Claude WebExtension Launcher/web-extensions/usage-tracker"
if [ -d "$LEGACY_EXT" ]; then
  rm -rf "$LEGACY_EXT"
  log "Cleaned up legacy launcher extension copy"
fi

cleanup_temp

echo ""
echo -e "${BOLD}================================================${NC}"
echo -e "${GREEN}${BOLD}   Uninstall complete!                        ${NC}"
echo -e "${BOLD}================================================${NC}"
echo ""
echo "Claude Desktop has been completely removed from this Mac."
echo "To use Claude Desktop again (without this extension), download"
echo "a fresh copy from: https://claude.ai/download"
echo ""
echo "Press Enter to close."
read
