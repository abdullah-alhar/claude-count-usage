// src/download.js
//
// Talks to Anthropic's real, public update endpoints to fetch the current
// Claude Desktop build — no third-party mirror, no lugia19 code involved.
//
// macOS: Claude ships Squirrel.Mac style updates. The feed lives at
//   https://downloads.claude.ai/releases/darwin/universal/RELEASES.json
// and looks like:
//   { "releases": [ { "updateTo": { "version": "...", "url": "https://downloads.claude.ai/releases/darwin/universal/<ver>/Claude-<hash>.zip" } } ] }
// (Structure confirmed via the public Homebrew cask definition for `claude`,
// which live-checks against this exact feed/regex.)
//
// Windows: Claude ships as a signed MSIX. There's a stable "give me latest"
// redirect:
//   https://claude.ai/api/desktop/win32/x64/msix/latest/redirect   (x64)
//   https://claude.ai/api/desktop/win32/arm64/msix/latest/redirect (arm64)
// which 302s to the real, versioned .msix URL on downloads.claude.ai.
//
// These are undocumented-but-real endpoints (observed in the Homebrew cask
// and in public Claude Code issue logs) — not officially published as an
// API contract, so they can change without notice. Treat this file as the
// one place you'd need to patch if Anthropic changes their CDN layout.

const fs = require("fs");
const path = require("path");
const os = require("os");
const fetch = require("node-fetch");

const MAC_RELEASES_FEED =
  "https://downloads.claude.ai/releases/darwin/universal/RELEASES.json";

const WIN_LATEST_REDIRECT = (arch) =>
  `https://claude.ai/api/desktop/win32/${arch}/msix/latest/redirect`;

function currentPlatform() {
  const plat = os.platform(); // 'darwin' | 'win32' | 'linux'
  const arch = os.arch(); // 'x64' | 'arm64'
  return { plat, arch };
}

async function getMacDownloadUrl() {
  const res = await fetch(MAC_RELEASES_FEED, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Failed to fetch mac releases feed: HTTP ${res.status}`);
  }
  const json = await res.json();
  const releases = json.releases || [];
  if (releases.length === 0) throw new Error("Releases feed was empty");
  // Last entry is the newest in Squirrel.Mac feeds.
  const latest = releases[releases.length - 1];
  const url = latest.updateTo && latest.updateTo.url;
  const version = latest.updateTo && latest.updateTo.version;
  if (!url) throw new Error("Could not find a download URL in releases feed");
  return { url, version };
}

async function getWindowsDownloadUrl(arch = "x64") {
  // Follow the redirect manually so we get the final URL without pulling
  // the (large) file into memory.
  const res = await fetch(WIN_LATEST_REDIRECT(arch), { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) {
    throw new Error(
      `Expected a redirect from the msix/latest endpoint, got HTTP ${res.status}`
    );
  }
  const match = location.match(/\/([\d.]+)\/Claude-[^/]+\.msix$/);
  return { url: location, version: match ? match[1] : "unknown" };
}

async function downloadTo(url, destPath, onProgress) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);

  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const out = fs.createWriteStream(destPath);

  await new Promise((resolve, reject) => {
    res.body.on("data", (chunk) => {
      received += chunk.length;
      if (onProgress && total) onProgress(received / total);
    });
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });

  return destPath;
}

/**
 * Fetch the current Claude Desktop installer for this machine into `destDir`.
 * Returns { filePath, version, platform }.
 */
async function fetchLatestInstaller(destDir = os.tmpdir()) {
  const { plat, arch } = currentPlatform();

  if (plat === "darwin") {
    const { url, version } = await getMacDownloadUrl();
    const dest = path.join(destDir, `Claude-${version}.zip`);
    await downloadTo(url, dest, (p) =>
      process.stdout.write(`\rDownloading Claude ${version}: ${(p * 100).toFixed(0)}%  `)
    );
    process.stdout.write("\n");
    return { filePath: dest, version, platform: "darwin" };
  }

  if (plat === "win32") {
    const winArch = arch === "arm64" ? "arm64" : "x64";
    const { url, version } = await getWindowsDownloadUrl(winArch);
    const dest = path.join(destDir, `Claude-${version}-${winArch}.msix`);
    await downloadTo(url, dest, (p) =>
      process.stdout.write(`\rDownloading Claude ${version}: ${(p * 100).toFixed(0)}%  `)
    );
    process.stdout.write("\n");
    return { filePath: dest, version, platform: "win32" };
  }

  throw new Error(`Unsupported platform: ${plat}. Claude Desktop only ships mac/win.`);
}

module.exports = {
  currentPlatform,
  getMacDownloadUrl,
  getWindowsDownloadUrl,
  downloadTo,
  fetchLatestInstaller,
};
