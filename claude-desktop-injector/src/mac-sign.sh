#!/usr/bin/env bash
# src/mac-sign.sh
#
# Modifying app.asar breaks Claude.app's existing Apple code signature —
# the bundle's _CodeSignature/CodeResources file records a hash of every
# resource, and app.asar no longer matches after patch-asar.js touches it.
# Ad-hoc re-signing (identity "-") regenerates that signature so macOS
# treats the bundle as internally consistent again. This does NOT get you
# a notarized signature — it's a local-only signature, which is fine for
# an app you already have Gatekeeper's blessing to run (you're not
# distributing this copy to anyone else).
#
# Usage: ./mac-sign.sh /Applications/Claude.app

set -euo pipefail

APP_PATH="${1:?Usage: mac-sign.sh /path/to/Claude.app}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "No such app bundle: $APP_PATH" >&2
  exit 1
fi

echo "Removing quarantine attribute (if present)..."
xattr -dr com.apple.quarantine "$APP_PATH" || true

echo "Ad-hoc re-signing $APP_PATH ..."
codesign --force --deep --sign - "$APP_PATH"

echo "Verifying signature..."
codesign --verify --deep --strict "$APP_PATH" && echo "OK: signature is internally consistent."

# --- Info.plist integrity hash --------------------------------------------
# Separately from the Apple code signature, some Electron apps (Claude
# Desktop appears to be one, per lugia19's "ASAR hash is now fetched from
# the header of our patched asar" fix note) do their OWN startup check of
# app.asar's hash against a value they compute or store themselves — this
# is app-specific logic, not a macOS/Electron standard, and Anthropic
# doesn't publish it. If Claude Desktop refuses to launch or shows an
# "installation is damaged/corrupt" dialog even after the codesign step
# above, that self-check is almost certainly why.
#
# You already tracked this down once (per your notes: "Info.plist integrity
# hash fix" in your own injector) — drop the exact field/algorithm you
# found in here so this script fixes it up automatically on every patch:
#
#   /usr/libexec/PlistBuddy -c "Set :SomeHashKey <newly-computed-hash>" \
#     "$APP_PATH/Contents/Info.plist"
#
# If you don't remember the details, the fastest way to re-derive it:
#   1. Patch a clean copy, try to launch it, and check Console.app for the
#      crash/refusal reason (Console → search "Claude").
#   2. `diff` the Info.plist of a clean install vs one that ran an official
#      auto-update, to see which key(s) change between versions — that's
#      almost always the field being hashed.

echo "Done. If Claude still refuses to launch, see the Info.plist note in this script."
