// src/watcher/install-watcher-mac.js
//
// Installs a LaunchAgent that runs watch.js + mac-sign.sh every 15 minutes
// and once at login, so the injection survives Claude Desktop's own
// auto-updates without you having to remember to re-run anything.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const LABEL = "com.local.claude-desktop-injector.watcher";

function plistXml({ nodePath, watchJsPath, signShPath, extensionDir, appPath, logDir }) {
  // Runs `node watch.js <ext>` then, only if it reports a re-patch, re-signs.
  // Kept as a tiny shell one-liner so we don't need a second JS entry point.
  const script =
    `"${nodePath}" "${watchJsPath}" "${extensionDir}" && "${signShPath}" "${appPath}"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>${logDir}/watcher.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/watcher.err.log</string>
</dict>
</plist>
`;
}

function install(extensionDir, appPath = "/Applications/Claude.app") {
  const home = os.homedir();
  const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
  const logDir = path.join(home, "Library", "Logs", "claude-desktop-injector");
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  const nodePath = process.execPath;
  const watchJsPath = path.join(__dirname, "watch.js");
  const signShPath = path.join(__dirname, "..", "mac-sign.sh");

  const plistPath = path.join(launchAgentsDir, `${LABEL}.plist`);
  fs.writeFileSync(
    plistPath,
    plistXml({ nodePath, watchJsPath, signShPath, extensionDir, appPath, logDir })
  );

  // Reload if already loaded, then load.
  try {
    execFileSync("launchctl", ["unload", plistPath]);
  } catch {
    /* wasn't loaded yet — fine */
  }
  execFileSync("launchctl", ["load", plistPath]);

  console.log(`Installed and loaded LaunchAgent: ${plistPath}`);
  console.log(`Logs: ${logDir}`);
  return plistPath;
}

function uninstall() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  try {
    execFileSync("launchctl", ["unload", plistPath]);
  } catch {}
  fs.rmSync(plistPath, { force: true });
  console.log("Watcher LaunchAgent removed.");
}

if (require.main === module) {
  const [, , cmd, extDir, appPath] = process.argv;
  if (cmd === "uninstall") {
    uninstall();
  } else if (cmd === "install" && extDir) {
    install(extDir, appPath);
  } else {
    console.error("Usage: node install-watcher-mac.js install <extension-dir> [Claude.app path]");
    console.error("       node install-watcher-mac.js uninstall");
    process.exit(1);
  }
}

module.exports = { install, uninstall, LABEL };
