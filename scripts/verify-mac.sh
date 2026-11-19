#!/bin/bash
set +e

app="${APP:-/Applications/Claude.app}"
plist="$app/Contents/Info.plist"
asar="$app/Contents/Resources/app.asar"

verify() {
  local failed=0 signature signature_lines plist_hash asar_hash
  local plist_status asar_status attributes xattr_status quarantine_count
  local running_claude run_log launch_pid launch_status launch_matches

  printf '[1] Running Claude processes\n'
  running_claude=$(pgrep -fl "$app/Contents")
  if [[ -n "$running_claude" ]]; then
    printf '%s\n' "$running_claude"
    printf 'WARNING: Claude is already running, quit it and rerun for a valid launch test\n'
    exit 1
  fi

  printf '\n[2] Strict code signature verification\n'
  codesign --verify --deep --strict --verbose=2 "$app" || failed=1

  printf '\n[3] Signature details\n'
  signature=$(codesign -dv "$app" 2>&1)
  signature_lines=$(printf '%s\n' "$signature" | grep -E 'Signature|TeamIdentifier|Info.plist')
  if [[ -n "$signature_lines" ]]; then
    printf '%s\n' "$signature_lines"
  fi
  if ! printf '%s\n' "$signature_lines" | grep -qx 'Signature=adhoc' ||
     printf '%s\n' "$signature_lines" | grep -q 'TeamIdentifier=Q6L2SF6YDW'; then
    failed=1
  fi

  printf '\n[4] ElectronAsarIntegrity\n'
  plist_hash=$(/usr/libexec/PlistBuddy -c 'Print :ElectronAsarIntegrity:Resources/app.asar:hash' "$plist")
  plist_status=$?
  asar_hash=$(node "$(dirname "$0")/asar-hash.js" "$asar")
  asar_status=$?
  printf 'Info.plist SHA256: %s\nASAR header SHA256: %s\n' "$plist_hash" "$asar_hash"
  if [[ "$plist_status" -eq 0 && "$asar_status" -eq 0 && -n "$asar_hash" && "$plist_hash" == "$asar_hash" ]]; then
    printf 'MATCH\n'
  else
    printf 'MISMATCH\n'
    failed=1
  fi

  printf '\n[5] Quarantine xattr count\n'
  attributes=$(xattr -lr "$app")
  xattr_status=$?
  quarantine_count=$(printf '%s\n' "$attributes" | grep -c quarantine)
  printf '%s\n' "$quarantine_count"
  if [[ "$xattr_status" -ne 0 || "$quarantine_count" != 0 ]]; then
    failed=1
  fi

  printf '\n[6] Claude launch output (15 seconds, fatal and assertion lines)\n'
  if run_log=$(mktemp "${TMPDIR:-/tmp}/ccu-launch.XXXXXX"); then
    "$app/Contents/MacOS/Claude" >"$run_log" 2>&1 &
    launch_pid=$!
    sleep 15
    if kill -0 "$launch_pid" 2>/dev/null && kill "$launch_pid" 2>/dev/null; then
      sleep 1
      kill -KILL "$launch_pid" 2>/dev/null
      wait "$launch_pid"
      launch_status=$?
      pkill -f "$app/Contents"
      case "$launch_status" in
        0|137|143) ;;
        *)
          printf 'Claude exited with status %s during shutdown\n' "$launch_status"
          tail -n 20 "$run_log"
          failed=1
          ;;
      esac
    else
      printf 'Claude exited on its own before 15s\n'
      wait "$launch_pid"
      launch_status=$?
      printf 'Claude exit status: %s\n' "$launch_status"
      tail -n 20 "$run_log"
      failed=1
    fi
    launch_matches=$(grep -E 'FATAL|Check failed|Trace/BPT|Assertion' "$run_log")
    if [[ -n "$launch_matches" ]]; then
      printf '%s\n' "$launch_matches"
    fi
    if [[ "$launch_matches" == *FATAL* ]]; then
      failed=1
    fi
    if grep -q 'LOCK' "$run_log"; then
      printf 'WARNING: profile lock errors, another Claude instance was running\n'
    fi
    rm -f "$run_log"
  else
    failed=1
  fi

  printf '\n[7] Newest 3 diagnostic reports\n'
  find "$HOME/Library/Logs/DiagnosticReports" -maxdepth 1 -type f -exec stat -f '%m %N' {} + |
    sort -rn | head -n 3 | cut -d ' ' -f 2-

  if [[ "$failed" -eq 0 ]]; then
    printf '\nPASS\n'
  else
    printf '\nFAIL\n'
  fi
  return "$failed"
}

verify 2>&1 | tee "$HOME/ccu-verify.log"
statuses=("${PIPESTATUS[@]}")
if [[ "${statuses[0]}" -ne 0 || "${statuses[1]}" -ne 0 ]]; then
  exit 1
fi
