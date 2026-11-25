#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

unzip -q dist/ccu-extension.zip -d "$work/payload"
cp "$work/payload"/runtime/*.js "$work/payload/extension/"
cp desktop-injector.js ccu-update.js "$work/payload/"
rm -rf "$work/payload/runtime" "$work/payload/version.json"

app="$work/mac/Install.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp -R "$work/payload" "$app/Contents/Resources/"
cp icon.icns "$app/Contents/Resources/app.icns"
install -m 755 scripts/macos-migration-launcher.sh "$app/Contents/MacOS/Launcher"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>Launcher</string>
  <key>CFBundleIconFile</key><string>app.icns</string>
  <key>CFBundleIdentifier</key><string>com.abdullahalhar.claudecountusage.migration</string>
  <key>CFBundleName</key><string>Claude Count Usage Installer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"
codesign --verify --strict "$app"

rm -f dist/Mac.installer.zip
/usr/bin/ditto -ck --keepParent "$app" dist/Mac.installer.zip
mkdir -p "$work/windows"
mv "$work/payload" "$work/windows/"
cp scripts/windows-migration.ps1 "$work/windows/migration.ps1"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags '-H windowsgui' \
  -o "$work/windows/Install.exe" scripts/windows-migration-launcher.go
dist="$PWD/dist"
rm -f "$dist/windows.installer.zip"
(cd "$work/windows" && zip -qr "$dist/windows.installer.zip" Install.exe migration.ps1 payload)
