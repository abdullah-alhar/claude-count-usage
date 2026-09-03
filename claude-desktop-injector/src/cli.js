#!/usr/bin/env node
// src/cli.js
//
//   node src/cli.js install [--extension <dir>]   fresh download + install + patch (+ sign on mac)
//   node src/cli.js patch [--extension <dir>]      patch whatever Claude install is already found
//   node src/cli.js unpatch                        restore the original app.asar from backup
//   node src/cli.js watch [--extension <dir>]      install the auto-repatch watcher (mac/win)
//
// All state lives on disk (the .bak asar, the LaunchAgent/Scheduled Task) —
// this CLI itself is stateless and safe to re-run.

const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { fetchLatestInstaller } = require("./download");
const { installMac, installWindowsPortable } = require("./install");
const { locate } = require("./locate");
const { patch, unpatch } = require("./patch-asar");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--extension") args.extension = argv[++i];
    else args._.push(argv[i]);
  }
  return args;
}

function defaultExtensionDir() {
  // Where you drop YOUR extension's electron build (manifest.json +
  // background/content scripts) — e.g. the output of your own
  // claude-count-usage project, built for the "electron" target the same
  // way the tracker zip you pulled ships a manifest_electron.json.
  return path.join(__dirname, "..", "your-extension");
}

async function cmdInstall(extensionDir) {
  console.log(`Platform: ${os.platform()} / ${os.arch()}`);
  const { filePath, version, platform } = await fetchLatestInstaller();
  console.log(`Downloaded Claude ${version} -> ${filePath}`);

  let appPath;
  if (platform === "darwin") {
    appPath = installMac(filePath);
    console.log(`Installed to ${appPath}`);
  } else {
    appPath = installWindowsPortable(filePath);
    console.log(`Extracted (portable) to ${appPath}`);
  }

  await cmdPatch(extensionDir);
}

async function cmdPatch(extensionDir) {
  const installs = locate();
  if (installs.length === 0) {
    console.error("No Claude Desktop install found. Run `install` first.");
    process.exit(1);
  }

  for (const { asarPath, appPath, protected: isProtected } of installs) {
    if (isProtected) {
      console.warn(
        `Skipping ${asarPath}: this is the OS-protected WindowsApps copy.\n` +
          `  Either take ownership manually (icacls / takeown) and re-run, or\n` +
          `  prefer \`cdi install\`, which extracts a portable copy you fully own.`
      );
      continue;
    }
    console.log(`Patching ${asarPath} ...`);
    const result = await patch(asarPath, extensionDir);
    console.log(`Patched. Backup at ${result.backupAsar}`);

    if (os.platform() === "darwin" && appPath) {
      const signSh = path.join(__dirname, "mac-sign.sh");
      console.log("Re-signing bundle ...");
      execFileSync("/bin/bash", [signSh, appPath], { stdio: "inherit" });
    }
  }
}

function cmdUnpatch() {
  const installs = locate();
  for (const { asarPath } of installs) {
    try {
      unpatch(asarPath);
      console.log(`Restored original app.asar for ${asarPath}`);
    } catch (e) {
      console.warn(`Could not restore ${asarPath}: ${e.message}`);
    }
  }
}

async function cmdWatch(extensionDir) {
  const installs = locate();
  const appPath = installs[0] && installs[0].appPath;
  if (os.platform() === "darwin") {
    require("./watcher/install-watcher-mac").install(extensionDir, appPath);
  } else if (os.platform() === "win32") {
    require("./watcher/install-watcher-win").install(extensionDir);
  } else {
    console.error("Watcher is only implemented for macOS and Windows.");
    process.exit(1);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  const extensionDir = args.extension || defaultExtensionDir();

  switch (cmd) {
    case "install":
      return cmdInstall(extensionDir);
    case "patch":
      return cmdPatch(extensionDir);
    case "unpatch":
      return cmdUnpatch();
    case "watch-install":
      return cmdWatch(extensionDir);
    default:
      console.log(`Usage:
  node src/cli.js install [--extension <dir>]
  node src/cli.js patch [--extension <dir>]
  node src/cli.js unpatch
  node src/cli.js watch-install [--extension <dir>]`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
