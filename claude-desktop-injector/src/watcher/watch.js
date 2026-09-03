// src/watcher/watch.js
//
// Claude Desktop auto-updates itself, which overwrites app.asar with a
// clean, unpatched copy — silently undoing the injection. This script is
// meant to be run periodically (via a macOS LaunchAgent or a Windows
// Scheduled Task, see install-watcher-mac.js / install-watcher-win.js) to
// notice that and re-patch automatically.
//
// Detection: our wrapper.js always contains the MARKER string. If
// app.asar exists but the entry point no longer contains it, an update
// (or a manual reinstall) has clobbered our patch — reapply it.

const fs = require("fs");
const { extractAll } = require("@electron/asar");
const os = require("os");
const path = require("path");

const { locate } = require("../locate");
const { patch, MARKER, findEntryPoint } = require("../patch-asar");

function isPatched(asarPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cdi-check-"));
  try {
    extractAll(asarPath, tmp);
    const { mainAbs } = findEntryPoint(tmp);
    return fs.readFileSync(mainAbs, "utf8").includes(MARKER);
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function runOnce(extensionSrcDir) {
  const installs = locate();
  if (installs.length === 0) {
    console.log("[watcher] No Claude Desktop install found — nothing to do.");
    return;
  }

  for (const { asarPath } of installs) {
    if (isPatched(asarPath)) {
      console.log(`[watcher] ${asarPath} already patched, skipping.`);
      continue;
    }
    console.log(`[watcher] ${asarPath} is unpatched (likely just auto-updated) — re-patching.`);
    await patch(asarPath, extensionSrcDir);
    console.log(`[watcher] Re-patched ${asarPath}.`);
    // NOTE (macOS): after this, you must re-run mac-sign.sh on the .app
    // bundle, or Claude will refuse to launch with a broken signature.
    // The LaunchAgent wrapper (install-watcher-mac.js) chains that for you.
  }
}

if (require.main === module) {
  const extDir = process.argv[2];
  if (!extDir) {
    console.error("Usage: node watch.js <path-to-your-extension-folder>");
    process.exit(1);
  }
  runOnce(extDir).catch((err) => {
    console.error("[watcher] failed:", err);
    process.exit(1);
  });
}

module.exports = { runOnce, isPatched };
