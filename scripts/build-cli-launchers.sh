#!/bin/bash
# Builds tiny macOS launchers for the existing command-line installers.
#
# These apps do not install anything themselves. They only ask Terminal to open the adjacent
# install.command / install-v2.command, preserving the original CLI behavior and permissions.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

make_app() {
  local app_name="$1"
  local command_name="$2"
  local bundle_id="$3"
  local app="$ROOT/$app_name"

  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

  cat > "$app/Contents/MacOS/Launcher" <<SCRIPT
#!/bin/bash
ROOT="\$(cd "\$(dirname "\$0")/../../.." && pwd)"
COMMAND="\$ROOT/$command_name"

if [ ! -f "\$COMMAND" ]; then
  /usr/bin/osascript -e 'display alert "Installer file is missing" message "$command_name must be next to $app_name." as critical'
  exit 1
fi

chmod +x "\$COMMAND" 2>/dev/null || true
/usr/bin/open -a Terminal "\$COMMAND"
SCRIPT
  chmod +x "$app/Contents/MacOS/Launcher"

  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Launcher</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>CFBundleName</key><string>Claude Count Usage Installer</string>
  <key>CFBundleDisplayName</key><string>Install Claude Count Usage</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
</dict>
</plist>
PLIST

  cp "$ROOT/icon.icns" "$app/Contents/Resources/app.icns"
  codesign --force --deep --sign - "$app" >/dev/null 2>&1 || true
  echo "Built $app_name -> $command_name"
}

make_app "Install.app" "install.command" "com.abdullahalhar.claudecountusage.cli-installer"

if [ -f "$ROOT/install-v2.command" ]; then
  make_app "Install-v2.app" "install-v2.command" "com.abdullahalhar.claudecountusage.cli-installer-v2"
fi

# The production Install.exe already uses install.bat. Build an equivalent local-source launcher
# when Go is available; it is ignored by Git alongside install-v2.bat.
if [ -f "$ROOT/install-v2.bat" ] && command -v go >/dev/null 2>&1; then
  (
    cd "$ROOT"
    GOOS=windows GOARCH=amd64 go build -o Install-v2.exe \
      -ldflags "-X main.scriptName=install-v2.bat" scripts/windows-cli-launcher.go
  )
  echo "Built Install-v2.exe -> install-v2.bat"
fi
