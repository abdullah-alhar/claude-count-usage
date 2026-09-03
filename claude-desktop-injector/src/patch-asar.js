// src/patch-asar.js
//
// This is the actual injection mechanism, and it doesn't touch any of
// lugia19's code — it's the standard, documented technique for loading an
// unpacked extension into any Electron app:
//
//   1. Unpack app.asar to a temp folder (@electron/asar, MIT licensed tool
//      published by Electron itself — not a patching tool, just an
//      archiver, same as tar/zip).
//   2. Find the app's real entry point (package.json's "main").
//   3. Rename it to <name>.original.js and write a small wrapper.js in its
//      place. The wrapper requires the original file (so the app boots
//      completely normally) and, once Electron fires `app.whenReady()`,
//      calls the *native* `session.defaultSession.loadExtension()` API to
//      load your extension folder — the same API Chromium/Electron expose
//      for any unpacked MV3 extension. This is why the electron_reciever.js
//      / webrequest-polyfill.js pieces exist in the usage-tracker source
//      you pulled: they're the content-script side of exactly this API.
//   4. Repack the folder into app.asar.
//
// Nothing here reads or reuses lugia19's launcher binary or source — it's
// a generic "load an extension into an Electron app" patcher you can point
// at any extension folder.

const fs = require("fs");
const path = require("path");
const os = require("os");
const asar = require("@electron/asar");

const MARKER = "// __CLAUDE_DESKTOP_INJECTOR_WRAPPER__";

function wrapperSource(originalRequirePath) {
  return `${MARKER}
const { app, session } = require("electron");
const path = require("path");

// process.resourcesPath is Electron's own global — it always points to
// .../Contents/Resources (mac) or resources\\ (win), which sits *next to*
// app.asar, not inside it. Extensions must be loaded from a real path on
// disk, so we keep the extension folder unpacked alongside the asar rather
// than inside it.
const EXTENSION_DIR = path.join(process.resourcesPath, "injected-extension");

async function loadInjectedExtension() {
  try {
    if (!require("fs").existsSync(EXTENSION_DIR)) {
      console.log("[claude-desktop-injector] no extension folder found at", EXTENSION_DIR);
      return;
    }
    await session.defaultSession.loadExtension(EXTENSION_DIR, { allowFileAccess: true });
    console.log("[claude-desktop-injector] extension loaded from", EXTENSION_DIR);
  } catch (err) {
    console.error("[claude-desktop-injector] failed to load extension:", err);
  }
}

app.whenReady().then(loadInjectedExtension);

// Hand off to the real app exactly as if we were never here.
require(${JSON.stringify(originalRequirePath)});
`;
}

function findEntryPoint(unpackedDir) {
  const pkgPath = path.join(unpackedDir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`No package.json found at ${pkgPath} — is this really an Electron app.asar?`);
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const mainRel = pkg.main || "index.js";
  const mainAbs = path.join(unpackedDir, mainRel);
  if (!fs.existsSync(mainAbs)) {
    throw new Error(`package.json declares main="${mainRel}" but that file doesn't exist`);
  }
  return { pkgPath, pkg, mainRel, mainAbs };
}

/**
 * Patch an app.asar in place.
 * @param {string} asarPath   path to the app.asar to patch
 * @param {string} extensionSrcDir  folder containing YOUR extension
 *                 (manifest.json + background/content scripts) — e.g. the
 *                 unpacked electron build of your own claude-count-usage.
 */
async function patch(asarPath, extensionSrcDir) {
  if (!fs.existsSync(asarPath)) throw new Error(`No app.asar at ${asarPath}`);
  if (!fs.existsSync(extensionSrcDir)) {
    throw new Error(`Extension folder not found: ${extensionSrcDir}`);
  }

  const resourcesDir = path.dirname(asarPath);
  const unpackedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cdi-asar-"));

  console.log(`Unpacking ${asarPath} ...`);
  asar.extractAll(asarPath, unpackedDir);

  const { mainAbs } = findEntryPoint(unpackedDir);
  const alreadyPatched = fs.readFileSync(mainAbs, "utf8").includes(MARKER);

  if (alreadyPatched) {
    console.log("Entry point already wrapped — leaving as-is (idempotent).");
  } else {
    const backupAbs = mainAbs.replace(/\.js$/, "") + ".original.js";
    fs.copyFileSync(mainAbs, backupAbs);
    fs.writeFileSync(mainAbs, wrapperSource("./" + path.basename(backupAbs)));
    console.log(`Wrapped entry point: ${path.relative(unpackedDir, mainAbs)}`);
  }

  console.log("Repacking asar ...");
  const backupAsar = asarPath + ".bak";
  if (!fs.existsSync(backupAsar)) fs.copyFileSync(asarPath, backupAsar); // one-time safety net
  await asar.createPackage(unpackedDir, asarPath);

  console.log("Installing extension folder next to app.asar ...");
  const destExtDir = path.join(resourcesDir, "injected-extension");
  fs.rmSync(destExtDir, { recursive: true, force: true });
  fs.cpSync(extensionSrcDir, destExtDir, { recursive: true });

  fs.rmSync(unpackedDir, { recursive: true, force: true });

  return { asarPath, extensionDir: destExtDir, backupAsar };
}

/** Restore the original, unpatched app.asar from the .bak copy. */
function unpatch(asarPath) {
  const backupAsar = asarPath + ".bak";
  if (!fs.existsSync(backupAsar)) {
    throw new Error(`No backup found at ${backupAsar} — nothing to restore`);
  }
  fs.copyFileSync(backupAsar, asarPath);
  const resourcesDir = path.dirname(asarPath);
  fs.rmSync(path.join(resourcesDir, "injected-extension"), { recursive: true, force: true });
}

module.exports = { patch, unpatch, findEntryPoint, MARKER };
