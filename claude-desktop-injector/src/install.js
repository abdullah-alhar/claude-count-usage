// src/install.js
//
// Turns a downloaded installer (from download.js) into a Claude.app you can
// actually patch. Deliberately does NOT touch Windows' protected
// WindowsApps folder — see the note in locate.js for why.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

function installMac(zipPath, { destDir = "/Applications" } = {}) {
  const tmpExtract = fs.mkdtempSync(path.join(os.tmpdir(), "cdi-mac-"));
  // `ditto` preserves the .app bundle structure + extended attributes
  // exactly the way Finder/Installer would — plain `unzip` can mangle
  // resource forks on some zip builds.
  execFileSync("ditto", ["-xk", zipPath, tmpExtract]);

  const appName = fs.readdirSync(tmpExtract).find((f) => f.endsWith(".app"));
  if (!appName) throw new Error("Zip did not contain a .app bundle");

  const src = path.join(tmpExtract, appName);
  const dest = path.join(destDir, appName);

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  // Try /Applications first; fall back to ~/Applications if unwritable
  // (e.g. no admin rights) rather than failing outright.
  try {
    fs.cpSync(src, dest, { recursive: true });
  } catch (e) {
    const fallback = path.join(os.homedir(), "Applications", appName);
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.cpSync(src, fallback, { recursive: true });
    return fallback;
  }
  return dest;
}

function installWindowsPortable(msixPath) {
  // MSIX is a zip container under the hood. We extract it into our own,
  // unprotected folder instead of installing it as a system package — that
  // sidesteps needing admin rights / ACL changes on WindowsApps entirely.
  const destDir = path.join(
    os.homedir(),
    "AppData",
    "Local",
    "ClaudeDesktopInjector",
    "Claude"
  );
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  // Expand-Archive checks the extension, so hand it a .zip-named copy.
  const zipAlias = msixPath.replace(/\.msix$/i, ".zip");
  fs.copyFileSync(msixPath, zipAlias);

  execFileSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Path "${zipAlias}" -DestinationPath "${destDir}" -Force`,
  ]);

  // Inside the MSIX, Electron's payload is usually under app/ or resources/
  // directly at the root — this varies by build, so surface what we find
  // rather than guessing a single fixed path.
  return destDir;
}

module.exports = { installMac, installWindowsPortable };
