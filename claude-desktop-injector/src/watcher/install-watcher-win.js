// src/watcher/install-watcher-win.js
//
// Windows equivalent of install-watcher-mac.js: registers a Scheduled Task
// (via schtasks.exe, no extra deps) that re-runs watch.js every 15 minutes
// and at logon. Since installWindowsPortable() extracts Claude into your
// own AppData folder (see install.js) rather than the OS-protected
// WindowsApps path, no admin elevation is needed here — that's the whole
// point of using the portable extraction instead of patching the real
// MSIX install in place.

const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const TASK_NAME = "ClaudeDesktopInjectorWatcher";

function install(extensionDir) {
  const nodePath = process.execPath;
  const watchJsPath = path.join(__dirname, "watch.js");

  // schtasks wants a single command string; quote each path defensively.
  const taskRun = `"${nodePath}" "${watchJsPath}" "${extensionDir}"`;

  execFileSync("schtasks", [
    "/Create",
    "/TN", TASK_NAME,
    "/TR", taskRun,
    "/SC", "MINUTE",
    "/MO", "15",
    "/RL", "LIMITED", // no admin required
    "/F", // overwrite if it already exists
  ]);

  console.log(`Scheduled task "${TASK_NAME}" created (runs every 15 min).`);
}

function uninstall() {
  try {
    execFileSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"]);
    console.log(`Scheduled task "${TASK_NAME}" removed.`);
  } catch (e) {
    console.log(`No task named "${TASK_NAME}" found (already removed?).`);
  }
}

if (require.main === module) {
  const [, , cmd, extDir] = process.argv;
  if (cmd === "uninstall") {
    uninstall();
  } else if (cmd === "install" && extDir) {
    install(extDir);
  } else {
    console.error("Usage: node install-watcher-win.js install <extension-dir>");
    console.error("       node install-watcher-win.js uninstall");
    process.exit(1);
  }
}

module.exports = { install, uninstall, TASK_NAME };
