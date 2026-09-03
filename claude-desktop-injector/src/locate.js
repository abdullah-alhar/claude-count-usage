// src/locate.js
//
// Finds the real, installed Claude Desktop app on this machine, and hands
// back the path to its app.asar so patch-asar.js can work on it directly —
// no separate/patched copy, no launcher process in between.

const fs = require("fs");
const path = require("path");
const os = require("os");

const MAC_CANDIDATES = [
  "/Applications/Claude.app",
  path.join(os.homedir(), "Applications", "Claude.app"),
];

function findMacInstall() {
  for (const candidate of MAC_CANDIDATES) {
    const asar = path.join(candidate, "Contents", "Resources", "app.asar");
    if (fs.existsSync(asar)) {
      return { appPath: candidate, asarPath: asar };
    }
  }
  return null;
}

// Windows: Claude ships as an MSIX. A normally-installed package lives under
// the OS-protected WindowsApps folder, which is owned by TrustedInstaller —
// you cannot write into it without first taking ownership (see
// src/mac-sign.md's Windows counterpart note in the README: this is exactly
// why lugia19's tool needs admin elevation on Windows and why Cowork breaks
// once you touch the signed package). We look in two places:
//
//   1. The protected, "real" install (requires elevation to patch in place)
//   2. A portable/extracted copy you made yourself with `cdi install`
//      (see src/install.js) — this is the path we actually recommend,
//      since it sidesteps the WindowsApps ACLs entirely.
function findWindowsInstalls() {
  const results = [];

  const windowsApps = "C:\\Program Files\\WindowsApps";
  if (fs.existsSync(windowsApps)) {
    try {
      for (const entry of fs.readdirSync(windowsApps)) {
        if (/^AnthropicPBC\.Claude/i.test(entry)) {
          const dir = path.join(windowsApps, entry);
          const asar = findAsarUnder(dir);
          if (asar) results.push({ appPath: dir, asarPath: asar, protected: true });
        }
      }
    } catch (e) {
      // Listing WindowsApps itself requires elevated perms on most systems —
      // that's expected, not a bug. Caller should suggest `cdi install`.
    }
  }

  const portable = path.join(os.homedir(), "AppData", "Local", "ClaudeDesktopInjector", "Claude");
  const portableAsar = findAsarUnder(portable);
  if (portableAsar) results.push({ appPath: portable, asarPath: portableAsar, protected: false });

  return results;
}

function findAsarUnder(dir) {
  if (!fs.existsSync(dir)) return null;
  // MSIX layout puts resources under app\resources\app.asar (mirrors the
  // normal Electron layout once extracted).
  const candidates = [
    path.join(dir, "resources", "app.asar"),
    path.join(dir, "app", "resources", "app.asar"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function locate() {
  const plat = os.platform();
  if (plat === "darwin") {
    const found = findMacInstall();
    return found ? [found] : [];
  }
  if (plat === "win32") {
    return findWindowsInstalls();
  }
  return [];
}

module.exports = { locate, findMacInstall, findWindowsInstalls };
