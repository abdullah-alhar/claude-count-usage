#!/bin/bash
set -eu

payload="$(cd "$(dirname "$0")/../Resources/payload" && pwd)"
title="Claude Count Usage Installer"
alert() {
  /usr/bin/osascript - "$title" "$1" <<'APPLESCRIPT'
on run argv
  display alert (item 1 of argv) message (item 2 of argv)
end run
APPLESCRIPT
}

if ! /usr/bin/osascript -e 'display dialog "Set up in-app updates for this installation of Claude Desktop? Claude will close and reopen." with title "Claude Count Usage Installer" buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel"' >/dev/null 2>&1; then
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for bin in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$bin/node" ]; then export PATH="$bin:$PATH"; fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  alert "Install Node.js from nodejs.org, then open this installer again."
  exit 1
fi

mkdir -p "$HOME/Library/Logs"
log="$HOME/Library/Logs/ClaudeCountUsage-migration.log"
if node "$payload/desktop-injector.js" patch "$payload/extension" --mac-install-worker --launch >"$log" 2>&1; then
  alert "Setup is complete. Open Claude Count Usage settings to check for future updates."
else
  alert "Setup failed. See $log for the reason. If macOS blocked access to Claude.app, allow this installer under Privacy & Security → App Management and try again."
  exit 1
fi
