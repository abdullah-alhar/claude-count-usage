#!/usr/bin/env node
/**
 * Claude Count Usage — Desktop Injector & Patcher
 * Pure Node.js, zero npm dependencies.
 * Created by Abdullah Alhar
 *
 * Supports:
 *   - Locating installed Claude Desktop (macOS & Windows)
 *   - Auto-downloading & installing official Claude Desktop if missing
 *   - Surgical in-place ASAR patching with full pickle alignment & SHA256 integrity
 *   - Embedding Electron polyfills (CUT_ALARM, CUT_NOTIFICATION, tab events)
 *   - Ad-hoc code signing & quarantine removal on macOS
 *   - Clean unpatching / restoring from backup
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn, spawnSync } = require('child_process');
const updater = require('./ccu-update.js');

const MARKER = '// __CLAUDE_COUNT_USAGE_WRAPPER__';
const RUNTIME_FILES = ['wrapper-runtime.js', 'ccu-update.js'];

// ─── Platform & Paths ───────────────────────────────────────

const MAC_APP_PATHS = [
  '/Applications/Claude.app',
  path.join(os.homedir(), 'Applications', 'Claude.app')
];

const MAC_RELEASES_FEED =
  'https://downloads.claude.ai/releases/darwin/universal/RELEASES.json';

const WIN_LATEST_REDIRECT = (arch) =>
  `https://claude.ai/api/desktop/win32/${arch}/msix/latest/redirect`;

function locateClaude() {
  const plat = os.platform();
  if (plat === 'darwin') {
    for (const appPath of MAC_APP_PATHS) {
      const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
      if (fs.existsSync(asarPath)) {
        return { appPath, asarPath, platform: 'darwin' };
      }
    }
    return null;
  }

  if (plat === 'win32') {
    // 1. Check portable directory
    const portableDir = path.join(os.homedir(), 'AppData', 'Local', 'ClaudeDesktopInjector', 'Claude');
    const portableAsar = findAsarUnder(portableDir);
    if (portableAsar) {
      return { appPath: portableDir, asarPath: portableAsar, platform: 'win32', portable: true };
    }

    // 2. Check local AppData paths
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const candidateDirs = [
      path.join(localAppData, 'Programs', 'Claude'),
      path.join(appData, 'Claude'),
      path.join(localAppData, 'Claude')
    ];
    for (const dir of candidateDirs) {
      const asar = findAsarUnder(dir);
      if (asar) return { appPath: dir, asarPath: asar, platform: 'win32' };
    }

    // 3. Check WindowsApps (MSIX install)
    const windowsApps = 'C:\\Program Files\\WindowsApps';
    if (fs.existsSync(windowsApps)) {
      try {
        for (const entry of fs.readdirSync(windowsApps)) {
          if (/^AnthropicPBC\.Claude/i.test(entry)) {
            const dir = path.join(windowsApps, entry);
            const asar = findAsarUnder(dir);
            if (asar) return { appPath: dir, asarPath: asar, platform: 'win32', protected: true };
          }
        }
      } catch {
        // Access denied without admin
      }
    }
    return null;
  }

  return null;
}

function findAsarUnder(dir, maxDepth = 4) {
  if (!fs.existsSync(dir) || maxDepth < 0) return null;
  const candidates = [
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, 'app', 'resources', 'app.asar'),
    path.join(dir, 'Contents', 'Resources', 'app.asar'),
    path.join(dir, 'app.asar')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !['node_modules', 'injected-extension', '.git'].includes(entry.name)) {
        const found = findAsarUnder(path.join(dir, entry.name), maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

// ─── Network Downloader (Zero external deps) ────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https:') ? https : http;

    const req = client.get(url, { headers: { 'User-Agent': 'ClaudeCountUsage-Installer' } }, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = new URL(redirectUrl, parsed.origin).href;
        }
        return httpGet(redirectUrl).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function downloadFile(url, destPath, onProgress, maxRetries = 5) {
  // If curl is available (Windows 10/11 has curl.exe, macOS has /usr/bin/curl), use it with native resume
  const canUseCurl = (() => {
    try {
      execFileSync('curl', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  if (canUseCurl) {
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      console.log('Downloading using system curl (resumable with retries)...');
      execFileSync('curl', [
        '-fL',
        '-C', '-',                       // Resume previous partial download
        '--retry', '5',                  // Retry on transient errors
        '--retry-delay', '2',
        '--retry-connrefused',
        '--connect-timeout', '30',
        '-A', 'ClaudeCountUsage-Installer',
        '-o', destPath,
        url
      ], { stdio: 'inherit' });

      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 10 * 1024 * 1024) {
        return Promise.resolve(destPath);
      }
    } catch (curlErr) {
      console.log('curl download interrupted or failed, using Node.js resume downloader...');
    }
  }

  // Pure Node.js resilient downloader with HTTP Range header resume
  return (async () => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await attemptNodeDownload(url, destPath, onProgress);
        return destPath;
      } catch (err) {
        console.warn(`\n[Download] Connection interrupted (${err.message || err}). Resuming (attempt ${attempt}/${maxRetries}) in 2s...`);
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    return destPath;
  })();
}

function attemptNodeDownload(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');

    function resolveUrl(targetUrl, depth = 0) {
      if (depth > 6) return reject(new Error('Too many redirects'));
      const client = targetUrl.startsWith('https:') ? https : http;
      client.get(targetUrl, { headers: { 'User-Agent': 'ClaudeCountUsage-Installer' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http')) {
            const parsed = new URL(targetUrl);
            redirectUrl = new URL(redirectUrl, parsed.origin).href;
          }
          res.resume();
          return resolveUrl(redirectUrl, depth + 1);
        }
        res.destroy();
        doDownload(targetUrl);
      }).on('error', reject);
    }

    function doDownload(finalUrl) {
      let startOffset = 0;
      if (fs.existsSync(destPath)) {
        startOffset = fs.statSync(destPath).size;
      }

      const headers = { 'User-Agent': 'ClaudeCountUsage-Installer' };
      if (startOffset > 0) {
        headers['Range'] = `bytes=${startOffset}-`;
      }

      const client = finalUrl.startsWith('https:') ? https : http;
      const req = client.get(finalUrl, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolveUrl(res.headers.location);
        }

        let isRange = false;
        let total = 0;
        let received = 0;

        if (res.statusCode === 206) {
          isRange = true;
          const cl = Number(res.headers['content-length'] || 0);
          total = startOffset + cl;
          received = startOffset;
          console.log(`\nResuming download from byte ${startOffset} (${((startOffset / total) * 100).toFixed(0)}%)...`);
        } else if (res.statusCode === 200) {
          total = Number(res.headers['content-length'] || 0);
          received = 0;
          startOffset = 0;
        } else if (res.statusCode === 416) {
          // Range Not Satisfiable: file is already completely downloaded!
          res.resume();
          return resolve(destPath);
        } else {
          return reject(new Error(`HTTP ${res.statusCode} from ${finalUrl}`));
        }

        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const out = fs.createWriteStream(destPath, { flags: isRange ? 'a' : 'w' });

        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total > 0) onProgress(received / total);
        });

        res.pipe(out);
        res.on('error', (err) => {
          out.close();
          reject(err);
        });
        out.on('finish', () => {
          out.close();
          resolve(destPath);
        });
        out.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy(new Error('Connection timeout'));
      });
    }

    resolveUrl(url);
  });
}

async function getMacDownloadUrl() {
  const data = await httpGet(MAC_RELEASES_FEED);
  const json = JSON.parse(data);
  const releases = json.releases || [];
  if (releases.length === 0) throw new Error('Releases feed was empty');
  const latest = releases[releases.length - 1];
  const url = latest.updateTo && latest.updateTo.url;
  const version = (latest.updateTo && latest.updateTo.version) || 'latest';
  if (!url) throw new Error('Could not find download URL in releases feed');
  return { url, version };
}

async function getWindowsDownloadUrl(arch = 'x64') {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.get(WIN_LATEST_REDIRECT(arch), { headers: { 'User-Agent': 'ClaudeCountUsage-Installer' } }, (res) => {
      const loc = res.headers.location;
      if (!loc) return reject(new Error(`Expected redirect from MSIX endpoint, got HTTP ${res.statusCode}`));
      const match = loc.match(/\/([\d.]+)\/Claude-[^/]+\.msix$/);
      resolve({ url: loc, version: match ? match[1] : 'latest' });
    });
    req.on('error', reject);
  });
}

function isBundleHealthy(appPath) {
  if (os.platform() !== 'darwin') return true;
  const squirrel = path.join(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Squirrel');
  try {
    if (fs.existsSync(squirrel) || (fs.lstatSync(squirrel) && fs.lstatSync(squirrel).isSymbolicLink())) {
      fs.statSync(squirrel);
      return true;
    }
  } catch {
    return false;
  }
  return true;
}

// Squirrel's ShipIt is what installs a downloaded Claude update. Installers before v1.5 deleted it to
// keep updates from replacing the patched app, but Squirrel still downloads and verifies each update
// and then launches ShipIt from that missing path: the main process crashes with
// "NSInvalidArgumentException ... insertObject:atIndex: object cannot be nil", i.e. Claude quits
// mid-task. A bundle without it is reinstalled from Anthropic so updates install normally again.
function hasShipIt(appPath) {
  if (os.platform() !== 'darwin') return true;
  return fs.existsSync(path.join(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt'));
}

function isZipComplete(filePath) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < 1024) return false;
    // An MSIX/ZIP file must end with the End of Central Directory (EOCD) signature: 0x06054b50 ("PK\x05\x06")
    const fd = fs.openSync(filePath, 'r');
    const readLen = Math.min(stat.size, 65557);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    fs.closeSync(fd);
    return buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  } catch {
    return false;
  }
}

async function downloadClaude(destDir = os.tmpdir()) {
  const plat = os.platform();
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';

  if (plat === 'darwin') {
    console.log('Fetching latest Claude Desktop release info from Anthropic CDN...');
    const { url, version } = await getMacDownloadUrl();
    const dest = path.join(destDir, `Claude-${version}.zip`);

    if (isZipComplete(dest)) {
      console.log(`Using verified cached package: ${dest}`);
      return { filePath: dest, version, platform: 'darwin' };
    }

    if (fs.existsSync(dest)) {
      console.log(`Found partial download (${(fs.statSync(dest).size / (1024 * 1024)).toFixed(1)} MB). Resuming download...`);
    } else {
      console.log(`Downloading Claude Desktop ${version} (${arch})...`);
    }

    await downloadFile(url, dest, (p) => {
      process.stdout.write(`\rProgress: ${(p * 100).toFixed(0)}% `);
    });
    process.stdout.write('\n');

    if (!isZipComplete(dest)) {
      console.warn('Downloaded archive appears incomplete. Retrying clean download...');
      try { fs.rmSync(dest, { force: true }); } catch {}
      await downloadFile(url, dest);
    }

    return { filePath: dest, version, platform: 'darwin' };
  }

  if (plat === 'win32') {
    console.log('Fetching latest Claude Desktop MSIX info from Anthropic CDN...');
    const { url, version } = await getWindowsDownloadUrl(arch);
    const dest = path.join(destDir, `Claude-${version}-${arch}.msix`);
    const zipAlias = dest.replace(/\.msix$/i, '.zip');

    // If an incomplete or corrupt package was left behind, wipe it
    if (fs.existsSync(dest)) {
      if (!isZipComplete(dest)) {
        console.log(`Clearing corrupted or incomplete cached package: ${dest}`);
        try { fs.rmSync(dest, { force: true }); } catch {}
        try { fs.rmSync(zipAlias, { force: true }); } catch {}
      } else {
        console.log(`Using verified cached package: ${dest}`);
        return { filePath: dest, version, platform: 'win32' };
      }
    }

    console.log(`Downloading fresh Claude Desktop ${version} (${arch})...`);
    await downloadFile(url, dest, (p) => {
      process.stdout.write(`\rProgress: ${(p * 100).toFixed(0)}% `);
    });
    process.stdout.write('\n');

    if (!isZipComplete(dest)) {
      console.warn('Downloaded package appears incomplete or corrupt. Retrying clean download...');
      try { fs.rmSync(dest, { force: true }); } catch {}
      try { fs.rmSync(zipAlias, { force: true }); } catch {}
      await downloadFile(url, dest);
    }

    return { filePath: dest, version, platform: 'win32' };
  }

  throw new Error(`Unsupported platform: ${plat}`);
}

function installDownloadedClaude(filePath) {
  const plat = os.platform();
  if (plat === 'darwin') {
    let destDir = '/Applications';
    try {
      fs.accessSync(destDir, fs.constants.W_OK);
    } catch {
      destDir = path.join(os.homedir(), 'Applications');
      fs.mkdirSync(destDir, { recursive: true });
    }

    const appDest = path.join(destDir, 'Claude.app');
    if (fs.existsSync(appDest)) {
      console.log('Removing previous broken/outdated app bundle at', appDest);
      fs.rmSync(appDest, { recursive: true, force: true });
    }

    console.log(`Extracting Claude.app directly to ${destDir} with ditto...`);
    execFileSync('ditto', ['-xk', filePath, destDir], { stdio: 'inherit' });

    if (!fs.existsSync(appDest)) {
      throw new Error(`Claude.app not found at ${appDest} after extraction`);
    }

    return appDest;
  }

  if (plat === 'win32') {
    const destDir = path.join(os.homedir(), 'AppData', 'Local', 'ClaudeDesktopInjector', 'Claude');
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    if (!isZipComplete(filePath)) {
      try { fs.rmSync(filePath, { force: true }); } catch {}
      throw new Error(`The installer package at ${filePath} was incomplete or corrupted. It has been removed. Please run the installer again to complete the download.`);
    }

    const zipAlias = filePath.replace(/\.msix$/i, '.zip');
    fs.copyFileSync(filePath, zipAlias);

    console.log('Extracting portable Claude package...');
    let extracted = false;
    try {
      execFileSync('tar.exe', ['-xf', zipAlias, '-C', destDir]);
      extracted = true;
    } catch {}

    if (!extracted) {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path "${zipAlias}" -DestinationPath "${destDir}" -Force`
      ]);
    }
    return destDir;
  }

  throw new Error(`Unsupported platform: ${plat}`);
}

// ─── Pure Node ASAR Engine ──────────────────────────────────

function computeIntegrity(buf) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    algorithm: 'SHA256',
    hash: hash,
    blockSize: 4194304,
    blocks: [hash]
  };
}

function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);

  const payloadSize = prefix.readUInt32LE(4);
  const jsonLen = prefix.readUInt32LE(12);

  const headerBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, headerBuf, 0, jsonLen, 16);
  fs.closeSync(fd);

  const header = JSON.parse(headerBuf.toString('utf8'));
  const dataOffset = 8 + payloadSize;

  return { header, dataOffset, jsonLen, payloadSize };
}

function getNode(header, relPath) {
  const parts = relPath.split(/[/\\]/);
  let curr = header;
  for (const p of parts) {
    if (!curr.files || !curr.files[p]) return null;
    curr = curr.files[p];
  }
  return curr;
}

function setNode(header, relPath, fileInfo) {
  const parts = relPath.split(/[/\\]/);
  let curr = header;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!curr.files[p]) curr.files[p] = { files: {} };
    curr = curr.files[p];
  }
  curr.files[parts[parts.length - 1]] = fileInfo;
}

function readFileFromAsar(asarPath, dataOffset, node) {
  if (node.unpacked) return null;
  const fd = fs.openSync(asarPath, 'r');
  const buf = Buffer.alloc(node.size);
  const start = dataOffset + parseInt(node.offset, 10);
  fs.readSync(fd, buf, 0, node.size, start);
  fs.closeSync(fd);
  return buf;
}

function tryLoadAsar(asarPath) {
  try {
    if (!fs.existsSync(asarPath)) return null;
    const { header, dataOffset, jsonLen, payloadSize } = readAsarHeader(asarPath);
    const pkgNode = getNode(header, 'package.json');
    if (!pkgNode) return null;
    const pkgBuf = readFileFromAsar(asarPath, dataOffset, pkgNode);
    if (!pkgBuf) return null;
    const pkg = JSON.parse(pkgBuf.toString('utf8'));
    if (!pkg || typeof pkg !== 'object' || !pkg.name) return null;
    return { header, dataOffset, jsonLen, payloadSize, pkgNode, pkgBuf, pkg };
  } catch {
    return null;
  }
}


// ─── Wrapper Source ─────────────────────────────────────────

function generateWrapperSource(relativeMainPath) {
  // Deliberately tiny and dependency-free. Everything that changes between releases lives in
  // the user's folder (runtime/ + extension/), so this file is written once by the installer and
  // never needs to be rewritten by an update - which keeps the signed app bundle untouched.
  return `'use strict';
${MARKER}
require('events').EventEmitter.defaultMaxListeners = 100;
const path = require('path');
const fs = require('fs');
const os = require('os');

function ccuRoot() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeCountUsage');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ClaudeCountUsage');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ClaudeCountUsage');
}

const candidates = [
  path.join(ccuRoot(), 'runtime', 'wrapper-runtime.js'),
  path.join(ccuRoot(), 'runtime.old', 'wrapper-runtime.js'),
  path.join(process.resourcesPath || '', 'injected-extension', 'wrapper-runtime.js')
];
let loaded = false;
for (const file of candidates) {
  if (loaded) break;
  try {
    if (fs.existsSync(file)) { require(file); loaded = true; }
  } catch (err) {
    console.error('[CCU] Runtime failed to load from', file, err);
  }
}
if (!loaded) console.error('[CCU] Tracker runtime not found; Claude will start without usage tracking.');

require(${JSON.stringify(relativeMainPath)});
`;
}

// ─── Process & Lock Management ──────────────────────────────

function closeRunningClaude() {
  try {
    if (os.platform() === 'win32') {
      execFileSync('taskkill', ['/f', '/im', 'Claude.exe'], { stdio: 'ignore', windowsHide: true });
    } else if (os.platform() === 'darwin') {
      execFileSync('pkill', ['-x', 'Claude'], { stdio: 'ignore' });
    }
  } catch {}
  if (os.platform() === 'win32') {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    } catch {
      const end = Date.now() + 800;
      while (Date.now() < end) {}
    }
  }
}

function safeReplaceAsar(tempAsarPath, asarPath) {
  closeRunningClaude();
  let attempts = 0;
  const maxAttempts = 6;
  while (true) {
    try {
      if (os.platform() === 'win32' && fs.existsSync(asarPath)) {
        const oldTemp = asarPath + '.old-' + Date.now();
        try {
          fs.renameSync(asarPath, oldTemp);
          try { fs.unlinkSync(oldTemp); } catch {}
        } catch {
          try { fs.unlinkSync(asarPath); } catch {}
        }
      }
      fs.renameSync(tempAsarPath, asarPath);
      return;
    } catch (err) {
      attempts++;
      if (attempts >= maxAttempts) {
        try {
          fs.copyFileSync(tempAsarPath, asarPath);
          try { fs.unlinkSync(tempAsarPath); } catch {}
          return;
        } catch (copyErr) {
          if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
            throw new Error(`Permission denied (${err.code}) while replacing app.asar.\nClaude Desktop appears to be running and locking app.asar.\nPlease close Claude Desktop completely (from Task Manager if needed) and run the installer again.\n(${err.message})`);
          }
          throw err;
        }
      }
      closeRunningClaude();
      const delay = attempts * 300;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      } catch {
        const end = Date.now() + delay;
        while (Date.now() < end) {}
      }
    }
  }
}

// ─── Surgical ASAR Patcher ──────────────────────────────────

async function patchAsar(asarPath, extensionDir, beforeRewrite = () => {}) {
  if (!fs.existsSync(asarPath)) throw new Error(`No app.asar at ${asarPath}`);
  if (!fs.existsSync(extensionDir)) throw new Error(`Extension dir not found at ${extensionDir}`);

  const resourcesDir = path.dirname(asarPath);

  // 1. Load and validate package.json, with automatic recovery from healthy backups if corrupted
  let asarInfo = tryLoadAsar(asarPath);
  if (!asarInfo) {
    const candidateBackups = [
      asarPath + '.original',
      asarPath + '.bak',
      asarPath + '.backup'
    ];
    let recovered = false;
    for (const backupFile of candidateBackups) {
      if (fs.existsSync(backupFile)) {
        const backupInfo = tryLoadAsar(backupFile);
        if (backupInfo) {
          beforeRewrite();
          console.log(`Notice: Existing ${path.basename(asarPath)} was corrupted. Automatically restored from healthy backup (${path.basename(backupFile)})...`);
          fs.copyFileSync(backupFile, asarPath);
          asarInfo = backupInfo;
          recovered = true;
          break;
        }
      }
    }
    if (!asarInfo) {
      throw new Error(
        `The Claude Desktop archive (${asarPath}) is corrupted and contains invalid JSON.\n` +
        `Please reinstall Claude Desktop from https://claude.ai/download to restore a clean copy, then run this installer again.`
      );
    }
  }

  const { header, dataOffset, pkg } = asarInfo;

  // Determine current and original main
  const currentMain = pkg.main || 'index.js';
  let originalMain = pkg._originalMain;

  // Check if target file already has our wrapper
  let currentMainBuf = null;
  const currentMainNode = getNode(header, currentMain);
  if (currentMainNode) {
    currentMainBuf = readFileFromAsar(asarPath, dataOffset, currentMainNode);
    if (currentMainBuf && currentMainBuf.toString('utf8').includes(MARKER)) {
      console.log('app.asar already has the Claude Count Usage bootstrap; checking for changes...');
      if (!originalMain) {
        if (getNode(header, '.vite/build/index.pre.js')) {
          originalMain = '.vite/build/index.pre.js';
        } else {
          originalMain = 'index.js';
        }
      }
    }
  }

  if (!originalMain) {
    // If currentMain is already a wrapper (e.g. from previous launcher), find underlying index.pre.js
    if (currentMain.includes('wrapper') && getNode(header, '.vite/build/index.pre.js')) {
      originalMain = '.vite/build/index.pre.js';
    } else {
      originalMain = currentMain;
    }
  }

  // Create wrapper file
  const wrapperRelPath = '.vite/build/ccu_wrapper.js';
  const relativeRequire = './' + path.relative(path.dirname(wrapperRelPath), originalMain).replace(/\\/g, '/');
  const wrapperSource = generateWrapperSource(relativeRequire);
  const wrapperBuf = Buffer.from(wrapperSource, 'utf8');

  // Normal updates only replace files in the user folder. The asar is rewritten once (to install
  // this bootstrap) and then never again, which avoids re-signing and touching a running bundle.
  const earlierBootstrap = wrapperSource.replace("  path.join(ccuRoot(), 'runtime.old', 'wrapper-runtime.js'),\n", '');
  const currentSource = currentMainBuf?.toString('utf8');
  if (pkg.main === wrapperRelPath && [wrapperSource, earlierBootstrap].includes(currentSource)) {
    console.log('app.asar already loads the user runtime; keeping the signed bundle intact.');
    return { asarPath, backupAsar: null, alreadyPatched: true };
  }

  beforeRewrite();

  // Update package.json
  pkg._originalMain = originalMain;
  pkg.main = wrapperRelPath;
  const newPkgBuf = Buffer.from(JSON.stringify(pkg, null, 2), 'utf8');

  // Collect all files in header to rebuild archive
  const fileEntries = [];
  function collectFiles(node, prefix = '') {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? prefix + '/' + name : name;
      if (child.files) {
        collectFiles(child, rel);
      } else if (!child.unpacked) {
        fileEntries.push({
          rel,
          node: child,
          origOffset: parseInt(child.offset, 10),
          size: child.size
        });
      }
    }
  }
  collectFiles(header);
  fileEntries.sort((a, b) => a.origOffset - b.origOffset);

  // Files to replace or add
  const replacements = new Map();
  replacements.set('package.json', newPkgBuf);
  replacements.set(wrapperRelPath, wrapperBuf);

  // Update header node entries
  setNode(header, wrapperRelPath, {
    size: wrapperBuf.length,
    offset: '0',
    integrity: computeIntegrity(wrapperBuf)
  });

  setNode(header, 'package.json', {
    size: newPkgBuf.length,
    offset: '0',
    integrity: computeIntegrity(newPkgBuf)
  });

  // Recompute offsets
  let currentOffset = 0;
  const filesToWrite = [];

  for (const entry of fileEntries) {
    if (replacements.has(entry.rel)) {
      const buf = replacements.get(entry.rel);
      const node = getNode(header, entry.rel);
      node.offset = String(currentOffset);
      node.size = buf.length;
      node.integrity = computeIntegrity(buf);
      filesToWrite.push({ type: 'buffer', buf, rel: entry.rel });
      currentOffset += buf.length;
      replacements.delete(entry.rel);
    } else {
      entry.node.offset = String(currentOffset);
      filesToWrite.push({
        type: 'asar_slice',
        origStart: dataOffset + entry.origOffset,
        size: entry.size,
        rel: entry.rel
      });
      currentOffset += entry.size;
    }
  }

  // Any remaining new files (like wrapper.js if it wasn't in original asar)
  for (const [rel, buf] of replacements.entries()) {
    const node = getNode(header, rel);
    node.offset = String(currentOffset);
    node.size = buf.length;
    node.integrity = computeIntegrity(buf);
    filesToWrite.push({ type: 'buffer', buf, rel });
    currentOffset += buf.length;
  }

  // Serialize new header with 4-byte pickle alignment
  const newHeaderJson = JSON.stringify(header);
  const newHeaderBuf = Buffer.from(newHeaderJson, 'utf8');
  const padding = (4 - (newHeaderBuf.length % 4)) % 4;
  const payloadSize = 8 + newHeaderBuf.length + padding;

  const prefixBuf = Buffer.alloc(16);
  prefixBuf.writeUInt32LE(4, 0);
  prefixBuf.writeUInt32LE(payloadSize, 4);
  prefixBuf.writeUInt32LE(payloadSize - 4, 8);
  prefixBuf.writeUInt32LE(newHeaderBuf.length, 12);

  // Write new asar to temp file
  const tempAsarPath = asarPath + '.tmp-' + Date.now();
  const outFd = fs.openSync(tempAsarPath, 'w');
  const inFd = fs.openSync(asarPath, 'r');

  try {
    fs.writeSync(outFd, prefixBuf);
    fs.writeSync(outFd, newHeaderBuf);
    if (padding > 0) fs.writeSync(outFd, Buffer.alloc(padding));

    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);

    for (const item of filesToWrite) {
      if (item.type === 'buffer') {
        fs.writeSync(outFd, item.buf);
      } else if (item.type === 'asar_slice') {
        let remaining = item.size;
        let pos = item.origStart;
        while (remaining > 0) {
          const toRead = Math.min(remaining, CHUNK_SIZE);
          fs.readSync(inFd, chunkBuf, 0, toRead, pos);
          fs.writeSync(outFd, chunkBuf, 0, toRead);
          pos += toRead;
          remaining -= toRead;
        }
      }
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }

  // Backup original asar once
  const backupAsar = asarPath + '.bak';
  if (!fs.existsSync(backupAsar)) {
    const origCandidate = asarPath + '.original';
    if (fs.existsSync(origCandidate) && tryLoadAsar(origCandidate)) {
      console.log('Creating safety backup from clean original:', backupAsar);
      fs.copyFileSync(origCandidate, backupAsar);
    } else {
      console.log('Creating safety backup:', backupAsar);
      fs.copyFileSync(asarPath, backupAsar);
    }
  }

  // Replace asar safely
  try {
    safeReplaceAsar(tempAsarPath, asarPath);
    console.log('Patched app.asar successfully.');
  } finally {
    if (fs.existsSync(tempAsarPath)) {
      try { fs.unlinkSync(tempAsarPath); } catch {}
    }
  }

  // Seed copy next to asar: used as a fallback if the user-folder copy is ever missing.
  installExtensionFolder(path.join(resourcesDir, 'injected-extension'), extensionDir);

  return { asarPath, backupAsar, alreadyPatched: false };
}

function shouldIgnoreExtensionEntry(name) {
  const lower = name.toLowerCase();

  // OS metadata and thumbnail caches
  if (lower === '.ds_store' || lower === 'desktop.ini') return true;
  if (lower === 'thumbs.db' || lower.startsWith('thumbs.db')) return true;
  if (lower.startsWith('ehthumbs') && lower.endsWith('.db')) return true;
  if (name.startsWith('._')) return true;

  // Version control, dependency, and build scratch folders
  if (lower === '.git' || lower === '.github' || lower === 'node_modules') return true;

  // Repo-only folders and installer icons: never loaded by the extension, just more files for
  // Claude to carry and for antivirus to scan
  if (lower === 'tests' || lower === 'scripts' || lower === 'assets') return true;
  if (lower === 'installer' || lower === 'build' || lower === 'dist') return true;
  if (lower.endsWith('.icns') || lower.endsWith('.ico')) return true;

  // macOS app bundles (e.g. Install.app, Uninstall.app with Icon\r)
  if (lower.endsWith('.app')) return true;

  // Standalone installers, executables, scripts, and archives
  if (lower.endsWith('.bat') || lower.endsWith('.cmd') || lower.endsWith('.command') || lower.endsWith('.sh') || lower.endsWith('.ps1')) return true;
  if (lower.endsWith('.exe') || lower.endsWith('.zip') || lower.endsWith('.msix') || lower.endsWith('.dmg') || lower.endsWith('.pkg')) return true;

  // Patching scripts and repository documentation not needed by the extension runtime
  if (lower === 'desktop-injector.js') return true;
  if (['readme.md', 'privacy.md', 'license.md', 'security.md', 'contributing.md'].includes(lower)) return true;

  // Backups and temporary files
  if (lower.endsWith('.bak') || lower.endsWith('.tmp') || lower.endsWith('.swp')) return true;

  // Catch any filename containing Windows-illegal characters (\r, \n, :, *, ?, ", <, >, |)
  // This explicitly prevents crashes from macOS custom icon files (e.g. 'Icon\r')
  if (/[\r\n:*?"<>|]/.test(name)) return true;

  return false;
}

function cleanOsJunk(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const lower = entry.name.toLowerCase();
      if (lower === 'thumbs.db' || lower.startsWith('thumbs.db') || lower === '.ds_store' || entry.name.startsWith('._')) {
        try { fs.rmSync(full, { force: true }); } catch {}
      } else if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
        cleanOsJunk(full);
      }
    }
  } catch {}
}

function copyExtensionDirRecursive(srcDir, destDir) {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  let entries = [];
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true });
  } catch (err) {
    console.warn(`[Warning] Unable to read directory ${srcDir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    if (shouldIgnoreExtensionEntry(name)) continue;

    const srcPath = path.join(srcDir, name);
    const destPath = path.join(destDir, name);

    try {
      if (entry.isDirectory()) {
        copyExtensionDirRecursive(srcPath, destPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        const parentDir = path.dirname(destPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (err) {
      console.warn(`[Warning] Skipping non-essential file "${name}": ${err.message}`);
    }
  }
}

function installExtensionFolder(destExtDir, extensionDir) {
  console.log('Installing extension to:', destExtDir);

  // Clean junk like Thumbs.db from source folder if present
  cleanOsJunk(extensionDir);

  // Remove previous injected-extension if present
  if (fs.existsSync(destExtDir)) {
    try {
      fs.rmSync(destExtDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[Warning] Could not fully remove old extension folder: ${err.message}`);
    }
  }

  copyExtensionDirRecursive(extensionDir, destExtDir);

  // Ensure manifest.json in dest is the electron manifest
  const manifestElectron = path.join(destExtDir, 'manifest_electron.json');
  if (fs.existsSync(manifestElectron)) {
    try {
      fs.copyFileSync(manifestElectron, path.join(destExtDir, 'manifest.json'));
    } catch (err) {
      console.warn(`[Warning] Could not copy manifest_electron.json to manifest.json: ${err.message}`);
    }
  }

  // Ensure manifest.json exists in destination
  const manifestDest = path.join(destExtDir, 'manifest.json');
  if (!fs.existsSync(manifestDest)) {
    throw new Error(`Extension installation failed: manifest.json missing in ${destExtDir}`);
  }
}

// ─── User-folder install (the updateable half) ─────────────
//
// The extension and runtime live outside Claude.app so updates never modify the signed bundle.
// The bootstrap inside app.asar loads them from here, with the bundled copy as a fallback.

function readExtensionVersion(extensionDir) {
  for (const name of ['manifest.json', 'manifest_electron.json']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(extensionDir, name), 'utf8'));
      if (parsed && parsed.version) return String(parsed.version);
    } catch {}
  }
  return null;
}

function installUserRuntime(extensionDir) {
  const root = updater.ccuRoot();
  const destExtension = updater.extensionDir(root);
  const destRuntime = updater.runtimeDir(root);

  for (const file of RUNTIME_FILES) {
    if (!fs.existsSync(path.join(extensionDir, file))) {
      throw new Error(`Installer is missing ${file}; re-download the installer.`);
    }
  }

  fs.mkdirSync(updater.tempDir(root), { recursive: true });
  const staging = fs.mkdtempSync(path.join(updater.tempDir(root), 'installer-'));
  try {
    const ext = updater.extensionDir(staging);
    const runtime = updater.runtimeDir(staging);
    installExtensionFolder(ext, extensionDir);
    fs.mkdirSync(runtime);
    for (const file of RUNTIME_FILES) {
      fs.copyFileSync(path.join(extensionDir, file), path.join(runtime, file));
    }
    const version = readExtensionVersion(ext);
    fs.writeFileSync(path.join(staging, 'version.json'), JSON.stringify({ version }));
    updater.applyUpdatePackage({ packageDir: staging, root });
    console.log('Installed tracker files to:', root);
    return { root, extensionDir: destExtension, runtimeDir: destRuntime, version };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function unpatchAsar(asarPath) {
  const candidateBackups = [
    asarPath + '.original',
    asarPath + '.bak',
    asarPath + '.backup'
  ];
  let backupToRestore = null;
  for (const candidate of candidateBackups) {
    if (fs.existsSync(candidate)) {
      const info = tryLoadAsar(candidate);
      if (info) {
        backupToRestore = candidate;
        const mainNode = getNode(info.header, info.pkg.main || 'index.js');
        let isPatched = false;
        if (mainNode) {
          const mainContent = readFileFromAsar(candidate, info.dataOffset, mainNode);
          if (mainContent && mainContent.toString('utf8').includes(MARKER)) {
            isPatched = true;
          }
        }
        if (!isPatched) break;
      }
    }
  }
  if (!backupToRestore) {
    throw new Error(`No valid backup file found for ${asarPath} (.original or .bak).`);
  }
  fs.copyFileSync(backupToRestore, asarPath);
  const resourcesDir = path.dirname(asarPath);
  const extDir = path.join(resourcesDir, 'injected-extension');
  if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true, force: true });

  // Restore .exe on Windows if backup exists
  if (os.platform() === 'win32') {
    const parentDir = path.dirname(resourcesDir);
    const candidates = [
      path.join(parentDir, 'Claude.exe'),
      path.join(path.dirname(parentDir), 'Claude.exe')
    ];
    for (const exe of candidates) {
      if (fs.existsSync(exe + '.bak')) {
        try { fs.copyFileSync(exe + '.bak', exe); } catch {}
      }
    }
  }

  console.log('Restored original app.asar from backup.');
}

// ─── ASAR Header Hash Computation ──────────────────────────

function computeAsarHeaderHash(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const prefix = Buffer.alloc(16);
  fs.readSync(fd, prefix, 0, 16, 0);
  const jsonLen = prefix.readUInt32LE(12);
  const headerBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, headerBuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  return crypto.createHash('sha256').update(headerBuf).digest('hex');
}

// ─── Windows: Update ASAR Integrity Hash & Fuses in Claude.exe ─────
//
// On Windows, Electron stores the expected ASAR header hash as a PE
// resource (type "INTEGRITY", name "ELECTRONASAR") inside the main .exe.
// The resource contains JSON like:
//   [{"file":"resources\\app.asar","alg":"sha256","value":"<64-char hex>"}]
//
// After we modify app.asar, the old hash no longer matches. We find the
// old hash string in the .exe binary and replace it with the new hash.
// We also flip the Electron fuses for double protection.
// This is zero-dependency — no resedit or PE parser needed.

function updateWindowsExeIntegrity(appPath, asarPath) {
  if (os.platform() !== 'win32') return;

  const newHash = computeAsarHeaderHash(asarPath);
  let oldHash = null;
  const bakAsar = asarPath + '.bak';
  if (fs.existsSync(bakAsar)) {
    try {
      oldHash = computeAsarHeaderHash(bakAsar);
    } catch {}
  }

  // Find Claude.exe
  function findExe(dir, depth = 3) {
    if (!fs.existsSync(dir) || depth < 0) return null;
    for (const c of [path.join(dir, 'Claude.exe'), path.join(dir, 'app', 'Claude.exe')]) {
      if (fs.existsSync(c)) return c;
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', 'injected-extension'].includes(entry.name)) {
          const res = findExe(path.join(dir, entry.name), depth - 1);
          if (res) return res;
        }
      }
    } catch {}
    return null;
  }

  const exePath = findExe(appPath);
  if (!exePath) {
    console.warn('Could not find Claude.exe — skipping ASAR integrity hash update.');
    return;
  }

  console.log(`Updating ASAR integrity in ${path.basename(exePath)} ...`);

  // Backup the exe
  const bakPath = exePath + '.bak';
  if (!fs.existsSync(bakPath)) {
    try { fs.copyFileSync(exePath, bakPath); } catch {}
  }

  const exeBuf = fs.readFileSync(exePath);
  let replaced = false;

  // 1. If oldHash is known from app.asar.bak, search and replace it across the whole exe
  if (oldHash && oldHash.length === 64) {
    const oldBuf = Buffer.from(oldHash, 'ascii');
    const newBuf = Buffer.from(newHash, 'ascii');
    let pos = 0;
    while ((pos = exeBuf.indexOf(oldBuf, pos)) !== -1) {
      newBuf.copy(exeBuf, pos);
      console.log(`  Replaced integrity hash in exe: ${oldHash} -> ${newHash}`);
      replaced = true;
      pos += 64;
    }
  }

  // 2. Search for integrity JSON block anywhere in the binary ("value":"<64 hex>")
  const patterns = [
    Buffer.from('"value":"'),
    Buffer.from('"hash":"')
  ];
  for (const pat of patterns) {
    let pos = 0;
    while ((pos = exeBuf.indexOf(pat, pos)) !== -1) {
      const hashStart = pos + pat.length;
      if (hashStart + 64 <= exeBuf.length) {
        const candidate = exeBuf.slice(hashStart, hashStart + 64).toString('ascii');
        if (/^[0-9a-fA-F]{64}$/.test(candidate) && candidate.toLowerCase() !== newHash.toLowerCase()) {
          console.log(`  Found integrity hash in resource: ${candidate}`);
          console.log(`  Replacing with: ${newHash}`);
          Buffer.from(newHash, 'ascii').copy(exeBuf, hashStart);
          replaced = true;
        }
      }
      pos += pat.length;
    }
  }

  // 3. Fallback: Search near "app.asar" for any 64-char hex
  const asarRef = Buffer.from('app.asar');
  let asarPos = 0;
  while ((asarPos = exeBuf.indexOf(asarRef, asarPos)) !== -1) {
    const region = exeBuf.slice(asarPos, Math.min(exeBuf.length, asarPos + 512));
    const regionStr = region.toString('ascii');
    const hexMatch = regionStr.match(/([0-9a-fA-F]{64})/);
    if (hexMatch && hexMatch[1].toLowerCase() !== newHash.toLowerCase()) {
      const hashOffset = asarPos + regionStr.indexOf(hexMatch[1]);
      console.log(`  Found hash near app.asar: ${hexMatch[1]}`);
      console.log(`  Replacing with: ${newHash}`);
      Buffer.from(newHash, 'ascii').copy(exeBuf, hashOffset);
      replaced = true;
    }
    asarPos += asarRef.length;
  }

  // 4. Also flip Electron Fuses (double protection)
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  const idx = exeBuf.indexOf(sentinel);
  if (idx !== -1) {
    const version = exeBuf[idx + sentinel.length];
    const wireLen = exeBuf[idx + sentinel.length + 1];
    if (version === 1 && wireLen >= 5) {
      const fuse4Pos = idx + sentinel.length + 2 + 4; // EnableEmbeddedAsarIntegrityValidation
      if (exeBuf[fuse4Pos] === 0x31) {
        exeBuf[fuse4Pos] = 0x30; // disable
        console.log('  Disabled EnableEmbeddedAsarIntegrityValidation fuse');
        replaced = true;
      }
      if (wireLen >= 6) {
        const fuse5Pos = idx + sentinel.length + 2 + 5; // OnlyLoadAppFromAsar
        if (exeBuf[fuse5Pos] === 0x31) {
          exeBuf[fuse5Pos] = 0x30; // disable
          console.log('  Disabled OnlyLoadAppFromAsar fuse');
          replaced = true;
        }
      }
    }
  }

  if (replaced) {
    let attempts = 0;
    while (true) {
      try {
        fs.writeFileSync(exePath, exeBuf);
        console.log('  Updated ASAR integrity in exe successfully.');
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 4) {
          console.warn(`  Warning: Could not write updated integrity to ${path.basename(exePath)} (${err.message}). Continuing...`);
          break;
        }
        closeRunningClaude();
        const end = Date.now() + 300;
        while (Date.now() < end) {}
      }
    }
  } else {
    console.warn('  Notice: Could not locate integrity hash pattern in exe.');
  }
}

// ─── macOS Info.plist ElectronAsarIntegrity & Code Signing ──

function checkMacBundleOwner(appPath) {
  const owner = fs.statSync(appPath).uid;
  if (owner !== process.geteuid()) {
    throw new Error(`Claude.app is owned by UID ${owner}, but the installer is running as UID ${process.geteuid()}. Run the installer as the app's owner, without sudo.`);
  }
}

function checkMacBundleAccess({ appPath, asarPath }) {
  checkMacBundleOwner(appPath);
  fs.accessSync(path.dirname(asarPath), fs.constants.W_OK);
  for (const file of [asarPath, path.join(appPath, 'Contents', 'Info.plist')]) {
    fs.closeSync(fs.openSync(file, 'r+'));
  }
}

function updateInfoPlistHash(appPath, asarPath) {
  if (os.platform() !== 'darwin') return;
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) {
    throw new Error(`Info.plist not found at ${infoPlist}`);
  }

  const headerHash = computeAsarHeaderHash(asarPath);
  console.log(`Updating ElectronAsarIntegrity in Info.plist to: ${headerHash}`);

  try {
    execFileSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
      '-c',
      'Save',
      infoPlist
    ]);
  } catch {
    try {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${headerHash}`,
        '-c',
        'Save',
        infoPlist
      ]);
    } catch (e) {
      throw new Error(`Failed to write ElectronAsarIntegrity to Info.plist: ${e.message}`);
    }
  }

  verifyInfoPlistHash(appPath, asarPath);
}

function verifyInfoPlistHash(appPath, asarPath) {
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  const readBack = execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :ElectronAsarIntegrity:Resources/app.asar:hash',
    infoPlist
  ], { encoding: 'utf8' }).trim();

  const headerHash = computeAsarHeaderHash(asarPath);
  console.log(`ASAR header SHA256: ${headerHash}\nInfo.plist SHA256:  ${readBack}`);
  if (readBack !== headerHash) {
    throw new Error(
      `ElectronAsarIntegrity verification mismatch in Info.plist: expected "${headerHash}", read back "${readBack}"`
    );
  }
  console.log('Verified ElectronAsarIntegrity in Info.plist matches asar header hash.');
}

// ── Mac re-signing ──────────────────────────────────────────
//
// Patching app.asar and Info.plist breaks Anthropic's signature, so the bundle is re-signed ad-hoc.
// A plain `codesign --deep --sign -` also throws away every entitlement, and Claude checks for
// com.apple.security.virtualization before starting Cowork's VM: without it Cowork (local file
// access, "organize my folder", ...) is silently switched off - Claude's log shows
// "macOS VM-support probe: entitlement_missing". So each component gets its own entitlements back.
//
// Restricted entitlements (keychain groups, app/team identifiers) can only be claimed by
// Anthropic's certificate; macOS kills an ad-hoc process that claims them (verified: SIGKILL at
// launch), so those stay dropped - which the old re-sign already did implicitly.
const RESTRICTED_ENTITLEMENT = (key) =>
  key === 'keychain-access-groups' ||
  key === 'application-identifier' ||
  key === 'com.apple.application-identifier' ||
  key === 'com.apple.security.application-groups' ||
  key.startsWith('com.apple.developer.');

// Fallbacks for a bundle that was already stripped by an earlier install (nothing left to read).
// Taken from the official Claude 2.2553.1 signature, restricted keys removed.
const DEVICE_ENTITLEMENTS = {
  'com.apple.security.virtualization': true,
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.automation.apple-events': true,
  'com.apple.security.device.audio-input': true,
  'com.apple.security.device.camera': true,
  'com.apple.security.device.bluetooth': true,
  'com.apple.security.device.usb': true,
  'com.apple.security.device.print': true,
  'com.apple.security.personal-information.location': true,
  'com.apple.security.personal-information.photos-library': true
};
const DEFAULT_ENTITLEMENTS = {
  '': DEVICE_ENTITLEMENTS, // the main app
  'Claude Helper.app': DEVICE_ENTITLEMENTS,
  'Claude Helper (GPU).app': { 'com.apple.security.cs.allow-jit': true },
  'Claude Helper (Renderer).app': { 'com.apple.security.cs.allow-jit': true },
  'Claude Helper (Plugin).app': {
    'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true
  }
};

function readEntitlements(codePath) {
  try {
    const xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', codePath], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (!xml || !xml.length) return null;
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml });
    const parsed = JSON.parse(json.toString('utf8'));
    return parsed && Object.keys(parsed).length ? parsed : null;
  } catch {
    return null;
  }
}

function withoutRestricted(entitlements) {
  const out = {};
  for (const [key, value] of Object.entries(entitlements || {})) {
    if (!RESTRICTED_ENTITLEMENT(key)) out[key] = value;
  }
  return out;
}

function signWithEntitlements(codePath, entitlements, requirement = null) {
  const tmpJson = path.join(os.tmpdir(), `ccu-ent-${process.pid}-${Date.now()}.plist`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify(entitlements));
    execFileSync('plutil', ['-convert', 'xml1', tmpJson]);
    const reqArgs = requirement ? ['-r', requirement] : [];
    execFileSync('codesign', ['--force', '--sign', '-', ...reqArgs, '--entitlements', tmpJson, codePath], { stdio: 'inherit' });
  } finally {
    try { fs.rmSync(tmpJson, { force: true }); } catch {}
  }
}

// Claude keeps its cookie/session encryption key in the login keychain ("Claude Safe Storage") and
// reads it on the main thread at startup. The keychain only hands it over silently to code matching
// the requirement it trusted. An ad-hoc signature's default requirement is its cdhash, which changes
// on every install, so after each install macOS put up an access prompt on launch - frequently behind
// the window - and Claude sat on a black screen until someone found and answered it. Pinning the
// requirement to the bundle identifier makes one "Always Allow" survive later installs and updates.
function stableDesignatedRequirement(appPath) {
  try {
    const id = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
    return /^[A-Za-z0-9.-]+$/.test(id) ? `=designated => identifier "${id}"` : null;
  } catch {
    return null;
  }
}

function signMac(appPath) {
  if (os.platform() !== 'darwin') return;

  // Read entitlements BEFORE re-signing: while Anthropic's signature is still on the binaries this
  // is the exact official list (so new Claude versions carry over automatically).
  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helperApps = fs.readdirSync(frameworksDir).filter(name => name.endsWith('.app'));
  const plan = [...helperApps.map(name => ({ name, codePath: path.join(frameworksDir, name) })), { name: '', codePath: appPath }]
    .map(({ name, codePath }) => {
      const live = readEntitlements(codePath);
      const source = live ? 'current signature' : (DEFAULT_ENTITLEMENTS[name] ? 'built-in defaults' : 'none');
      return { name, codePath, source, entitlements: withoutRestricted(live || DEFAULT_ENTITLEMENTS[name] || {}) };
    });

  console.log('Removing quarantine attributes...');
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  console.log('Ad-hoc re-signing bundle:', appPath);
  // Sign nested code before restoring helper and main app entitlements.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Helpers first, main app last: the outer signature seals the nested ones. The main app is always
  // re-signed here, even with no entitlements, so it gets the stable keychain requirement.
  const mainRequirement = stableDesignatedRequirement(appPath);
  for (const { name, codePath, source, entitlements } of plan) {
    const isMain = name === '';
    if (!Object.keys(entitlements).length && !isMain) continue;
    signWithEntitlements(codePath, entitlements, isMain ? mainRequirement : null);
    console.log(`Restored ${Object.keys(entitlements).length} entitlements on ${name || path.basename(appPath)} (from ${source})`);
  }

  verifyMacSignature(appPath, path.join(appPath, 'Contents', 'Resources', 'app.asar'));

  try {
    const dr = spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' }).stderr || '';
    if (/designated => identifier /.test(dr)) {
      console.log('Verified: stable signing requirement set (keychain access survives future updates).');
    } else {
      console.warn('[Warning] Signing requirement is not stable - macOS may ask for keychain access after each update.');
    }
  } catch {}

  const finalEntitlements = readEntitlements(appPath) || {};
  if (finalEntitlements['com.apple.security.virtualization']) {
    console.log('Verified: virtualization entitlement present (Cowork can start its VM).');
  } else {
    console.warn('[Warning] Virtualization entitlement missing after re-signing - Cowork file access will be unavailable.');
  }
}

function verifyMacSignature(appPath, asarPath) {
  console.log('Verifying macOS signature...');
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });

  const details = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  if (details.error) throw details.error;
  const signature = details.stdout + details.stderr;
  process.stdout.write(signature);
  if (details.status !== 0 || !/^Signature=adhoc$/m.test(signature) || /^TeamIdentifier=Q6L2SF6YDW$/m.test(signature)) {
    throw new Error('Expected an ad-hoc signature without the original Anthropic TeamIdentifier.');
  }

  verifyInfoPlistHash(appPath, asarPath);

  const attributes = execFileSync('xattr', ['-lr', appPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const quarantine = attributes.split('\n').filter(line => line.includes('quarantine'));
  if (quarantine.length) {
    throw new Error(`Quarantine attributes remain:\n${quarantine.join('\n')}`);
  }
  console.log('xattr -lr | grep quarantine: no matches');
}

// ─── macOS Leftover Cleanup ─────────────────────────────────

function cleanupMacLeftovers(appPath) {
  if (os.platform() !== 'darwin') return;

  // 1. Drop an update staged before this install: it was downloaded for the bundle being replaced
  // (~380 MB), and Claude downloads a fresh one on its next update check anyway.
  const home = os.homedir();
  const shipItCacheDir = path.join(home, 'Library', 'Caches', 'com.anthropic.claudefordesktop.ShipIt');
  try {
    if (fs.existsSync(shipItCacheDir)) {
      for (const item of fs.readdirSync(shipItCacheDir)) {
        try { fs.rmSync(path.join(shipItCacheDir, item), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}

  // 2. Remove obsolete LaunchAgents that previously ran legacy patch engines on reboot
  const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents');
  const obsoletePlists = [
    'com.abdullah.claude-count-usage.plist',
    'com.local.claude-desktop-injector.watcher.plist'
  ];
  for (const plistName of obsoletePlists) {
    const plistFile = path.join(launchAgentsDir, plistName);
    if (fs.existsSync(plistFile)) {
      try { execFileSync('launchctl', ['unload', plistFile], { stdio: 'ignore' }); } catch {}
      try { fs.rmSync(plistFile, { force: true }); } catch {}
      console.log(`Cleaned up obsolete launch agent: ${plistName}`);
    }
  }

}

// ─── Windows Start Menu & Desktop Shortcut Creation ────────

function setupWindowsShortcuts(appPath) {
  if (os.platform() !== 'win32') return;

  function findExe(dir, depth = 3) {
    if (!fs.existsSync(dir) || depth < 0) return null;
    const candidates = [
      path.join(dir, 'Claude.exe'),
      path.join(dir, 'app', 'Claude.exe')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !['node_modules', 'injected-extension'].includes(entry.name)) {
          const res = findExe(path.join(dir, entry.name), depth - 1);
          if (res) return res;
        }
      }
    } catch {}
    return null;
  }

  const exePath = findExe(appPath);
  if (!exePath) {
    console.warn('Notice: Could not locate Claude.exe to create shortcut.');
    return;
  }

  console.log('Creating Windows Start Menu and Desktop shortcuts for Claude...');
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const userProfile = process.env.USERPROFILE || os.homedir();

  const startMenuDir = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const desktopDir = path.join(userProfile, 'Desktop');

  const startMenuLnk = path.join(startMenuDir, 'Claude.lnk');
  const desktopLnk = path.join(desktopDir, 'Claude.lnk');
  const exeDir = path.dirname(exePath);

  try {
    fs.mkdirSync(startMenuDir, { recursive: true });
    const psScript = `
$ws = New-Object -ComObject WScript.Shell
$s1 = $ws.CreateShortcut('${startMenuLnk.replace(/'/g, "''")}')
$s1.TargetPath = '${exePath.replace(/'/g, "''")}'
$s1.WorkingDirectory = '${exeDir.replace(/'/g, "''")}'
$s1.IconLocation = '${exePath.replace(/'/g, "''")},0'
$s1.Description = 'Claude Desktop'
$s1.Save()

$s2 = $ws.CreateShortcut('${desktopLnk.replace(/'/g, "''")}')
$s2.TargetPath = '${exePath.replace(/'/g, "''")}'
$s2.WorkingDirectory = '${exeDir.replace(/'/g, "''")}'
$s2.IconLocation = '${exePath.replace(/'/g, "''")},0'
$s2.Description = 'Claude Desktop'
$s2.Save()
`;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { windowsHide: true });
    console.log('Created Start Menu shortcut (Windows Search will now find Claude).');
  } catch (err) {
    console.warn('Could not create shortcut:', err.message);
  }
}

// ─── High-Level CLI Actions ─────────────────────────────────

// Chromium keeps an extension's registered service worker, and serves its cached script, across
// app restarts. After an update that changes background.js, Claude Desktop would otherwise keep
// running the old cached background. The shared implementation lives in ccu-update.js so the
// in-app updater clears exactly the same cache.
function clearServiceWorkerCache() {
  const cleared = updater.clearServiceWorkerCache();
  for (const dir of cleared) console.log('Cleared cached service workers:', dir);
}

async function cmdInstall(extensionDir) {
  closeRunningClaude();
  let install = locateClaude();

  if (install && install.platform === 'darwin' && !isBundleHealthy(install.appPath)) {
    console.log('Detected corrupted or broken app bundle (broken framework symlinks).');
    console.log('Restoring clean official Claude Desktop bundle directly from Anthropic package...');
    install = null;
  } else if (install && install.platform === 'darwin' && !hasShipIt(install.appPath)) {
    console.log("Claude Desktop's updater (ShipIt) was removed by an older version of this installer,");
    console.log('which makes Claude crash when it downloads an update. Reinstalling the latest official');
    console.log('Claude Desktop from Anthropic (your chats and settings are kept)...');
    install = null;
  }

  if (install && install.platform === 'win32' && install.protected) {
    console.log('Detected MSIX installation in WindowsApps (protected by system permissions).');
    console.log('Setting up editable portable Claude Desktop in AppData...');
    const portableDir = path.join(os.homedir(), 'AppData', 'Local', 'ClaudeDesktopInjector', 'Claude');
    let copied = false;
    try {
      if (fs.existsSync(portableDir)) fs.rmSync(portableDir, { recursive: true, force: true });
      fs.mkdirSync(portableDir, { recursive: true });
      fs.cpSync(install.appPath, portableDir, { recursive: true });
      if (findAsarUnder(portableDir)) {
        copied = true;
        console.log('Copied Claude files to:', portableDir);
      }
    } catch {
      copied = false;
    }

    if (!copied) {
      console.log('Fetching official installer directly from Anthropic...');
      const { filePath } = await downloadClaude();
      installDownloadedClaude(filePath);
    }
    install = locateClaude();
    if (!install || install.protected) throw new Error('Failed to set up editable Claude Desktop installation');
  }

  if (!install) {
    console.log('Claude Desktop not detected (or repairing bundle)...');
    console.log('Fetching official installer directly from Anthropic...');
    const { filePath } = await downloadClaude();
    const appPath = installDownloadedClaude(filePath);
    console.log('Installed Claude Desktop to:', appPath);
    install = locateClaude();
    if (!install) throw new Error('Failed to locate Claude Desktop after installation');
  } else {
    console.log(`Found Claude Desktop at: ${install.appPath}`);
  }

  console.log(`Patching ${install.asarPath} ...`);
  const patchResult = await patchAsar(install.asarPath, extensionDir, () => {
    if (install.platform === 'darwin') checkMacBundleAccess(install);
  });
  installUserRuntime(extensionDir);
  clearServiceWorkerCache();

  if (install.platform === 'darwin') {
    if (!patchResult.alreadyPatched) {
      cleanupMacLeftovers(install.appPath);
      updateInfoPlistHash(install.appPath, install.asarPath);
      signMac(install.appPath);
    } else {
      console.log('App bundle unchanged; skipping re-sign.');
    }
  }

  if (install.platform === 'win32') {
    if (!patchResult.alreadyPatched) updateWindowsExeIntegrity(install.appPath, install.asarPath);
    setupWindowsShortcuts(install.appPath);
  }

  if (!isAsarPatched(install.asarPath)) {
    throw new Error(`Verification failed: ${install.asarPath} does not contain the injection marker after patching.`);
  }

  if (install.platform !== 'darwin') console.log('\n Claude Count Usage installed successfully into Claude Desktop!');
}

async function cmdPatch(extensionDir) {
  closeRunningClaude();
  const install = locateClaude();
  if (!install) {
    throw new Error('Claude Desktop not found. Use "install" to automatically download and install it.');
  }
  if (install.protected) throw new Error('Open the standard installer to set up an editable Claude Desktop installation.');
  const patchResult = await patchAsar(install.asarPath, extensionDir, () => {
    if (install.platform === 'darwin') checkMacBundleAccess(install);
  });
  installUserRuntime(extensionDir);
  clearServiceWorkerCache();
  if (install.platform === 'darwin') {
    if (!patchResult.alreadyPatched) {
      cleanupMacLeftovers(install.appPath);
      updateInfoPlistHash(install.appPath, install.asarPath);
      signMac(install.appPath);
    } else {
      console.log('App bundle unchanged; skipping re-sign.');
    }
  }
  if (install.platform === 'win32') {
    if (!patchResult.alreadyPatched) updateWindowsExeIntegrity(install.appPath, install.asarPath);
    setupWindowsShortcuts(install.appPath);
  }
  if (!isAsarPatched(install.asarPath)) {
    throw new Error(`Verification failed: ${install.asarPath} does not contain the injection marker after patching.`);
  }
  if (install.platform !== 'darwin') console.log('Patched successfully.');
}

function launchClaude() {
  const install = locateClaude();
  if (!install) throw new Error('Claude Desktop could not be located for restart');
  if (install.platform === 'darwin') {
    execFileSync('open', ['-a', install.appPath]);
    return;
  }
  const executable = path.join(path.dirname(path.dirname(install.asarPath)), 'Claude.exe');
  if (!fs.existsSync(executable)) throw new Error('Claude.exe was not found at ' + executable);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function cmdUnpatch() {
  closeRunningClaude();
  const install = locateClaude();
  if (!install) throw new Error('Claude Desktop not found.');
  if (install.platform === 'darwin') checkMacBundleAccess(install);
  unpatchAsar(install.asarPath);
  clearServiceWorkerCache();
  try { fs.rmSync(updater.ccuRoot(), { recursive: true, force: true }); } catch {}
  if (install.platform === 'darwin') {
    cleanupMacLeftovers(install.appPath);
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }
  if (install.platform !== 'darwin') console.log('Unpatched and restored original Claude Desktop.');
}

function isAsarPatched(asarPath) {
  try {
    const info = tryLoadAsar(asarPath);
    if (!info) return false;
    const { header, dataOffset, pkg } = info;
    const mainNode = getNode(header, pkg.main || 'index.js');
    if (!mainNode) return false;
    const mainContent = readFileFromAsar(asarPath, dataOffset, mainNode);
    return mainContent ? mainContent.toString('utf8').includes(MARKER) : false;
  } catch {
    return false;
  }
}

function cmdCheck() {
  const install = locateClaude();
  if (!install) {
    console.log('NOT_INSTALLED');
    process.exit(1);
  }
  if (isAsarPatched(install.asarPath)) {
    console.log('PATCHED');
    return;
  }
  console.log('UNPATCHED');
}

// ─── Full Uninstall (delete the whole app, not just the patch) ─────
//
// Reuses locateClaude(), which already recursively searches the
// portable/Programs/AppData/WindowsApps locations and is the same
// logic the (working) installer relies on to find Claude. This
// avoids re-implementing a weaker path search in shell/batch that
// misses non-standard install locations (e.g. MSI/portable copies).

function cmdLocate() {
  const install = locateClaude();
  if (!install) {
    console.log('NOT_FOUND');
    process.exit(1);
  }
  if (install.protected) {
    console.log('PROTECTED:' + install.appPath);
    process.exit(2);
  }
  console.log('FOUND:' + install.appPath);
}

function cmdDelete() {
  const install = locateClaude();
  if (!install) {
    console.log('NOT_FOUND');
    process.exit(1);
  }
  if (install.protected) {
    console.log('PROTECTED:' + install.appPath);
    process.exit(2);
  }

  try {
    if (install.platform === 'darwin') {
      execFileSync('pkill', ['-x', 'Claude'], { stdio: 'ignore' });
    } else if (install.platform === 'win32') {
      execFileSync('taskkill', ['/f', '/im', 'Claude.exe'], { stdio: 'ignore' });
    }
  } catch {}

  if (!fs.existsSync(install.appPath)) {
    console.log('NOT_FOUND');
    process.exit(1);
  }

  fs.rmSync(install.appPath, { recursive: true, force: true });
  try { fs.rmSync(updater.ccuRoot(), { recursive: true, force: true }); } catch {}
  console.log('DELETED:' + install.appPath);
}

// ─── Offline update (used by tests and by hand) ─────────────

async function cmdUpdate(zipPath, options = {}) {
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error('Usage: desktop-injector.js update <package.zip> [--sha256 <hash>] [--version <version>]');
  }
  const result = await updater.applyUpdateZip({
    zipPath,
    sha256: options.sha256,
    version: options.version
  });
  console.log(`Updated tracker files to ${result.version || 'unknown version'}. Restart Claude Desktop to use them.`);
  return result;
}

// ─── CLI Entrypoint ─────────────────────────────────────────

async function runMacInstaller(cmd, extensionDir) {
  const logPath = path.join(os.homedir(), 'ccu-install.log');
  const log = fs.openSync(logPath, 'w', 0o600);
  try {
    // Capture inherited tool output as well as installer messages.
    const worker = spawn(process.execPath, [__filename, cmd, extensionDir, '--mac-install-worker'], {
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let logError;
    const record = (chunk) => {
      if (logError) return;
      try {
        fs.writeFileSync(log, chunk);
      } catch (err) {
        logError = err;
      }
    };
    for (const [input, output] of [[worker.stdout, process.stdout], [worker.stderr, process.stderr]]) {
      input.on('data', (chunk) => {
        record(chunk);
        output.write(chunk);
      });
    }
    const status = await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.once('close', resolve);
    });
    if (logError) throw logError;

    if (status !== 0) {
      const details = fs.readFileSync(logPath, 'utf8');
      if (/\b(?:EPERM|EACCES)\b|permission denied|operation not permitted|access denied/i.test(details)) {
        const message = 'macOS blocked a write. In System Settings → Privacy & Security, grant Terminal App Management or Full Disk Access, then run the installer again as the app owner.\n';
        record(message);
        process.stderr.write(message);
      }
    }
    const result = `Claude Count Usage ${cmd} ${status === 0 ? 'succeeded' : 'failed'}. Log: ${logPath}\n`;
    record(result);
    if (logError) throw logError;
    (status === 0 ? process.stdout : process.stderr).write(result);
    return status === 0 ? 0 : 1;
  } finally {
    fs.closeSync(log);
  }
}

if (require.main === module) {
  const [, , cmd, arg1, ...rest] = process.argv;
  const extDir = arg1 || __dirname;
  const flag = (name, fallback = null) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] ? rest[i + 1] : fallback;
  };
  const macWorker = os.platform() === 'darwin' && rest.includes('--mac-install-worker');

  (async () => {
    if (os.platform() === 'darwin' && !macWorker && ['install', 'patch', 'unpatch'].includes(cmd)) {
      try {
        process.exitCode = await runMacInstaller(cmd, extDir);
      } catch (err) {
        console.error(`Claude Count Usage ${cmd} failed: ${err.message}`);
        process.exitCode = 1;
      }
      return;
    }
    switch (cmd) {
      case 'install':
        await cmdInstall(extDir);
        if (macWorker) return;
        process.exit(0);
        break;
      case 'patch':
        await cmdPatch(extDir);
        if (rest.includes('--launch')) await launchClaude();
        if (macWorker) return;
        process.exit(0);
        break;
      case 'unpatch':
        cmdUnpatch();
        if (macWorker) return;
        process.exit(0);
        break;
      case 'update':
        await cmdUpdate(arg1, { sha256: flag('--sha256'), version: flag('--version') });
        process.exit(0);
        break;
      case 'check':
        cmdCheck();
        break;
      case 'locate':
        cmdLocate();
        process.exit(0);
        break;
      case 'delete':
        cmdDelete();
        process.exit(0);
        break;
      default:
        console.log(`Usage:
  node desktop-injector.js install [extensionDir]
  node desktop-injector.js patch   [extensionDir]
  node desktop-injector.js unpatch
  node desktop-injector.js update  <package.zip> [--sha256 <hash>] [--version <version>]
  node desktop-injector.js check
  node desktop-injector.js locate
  node desktop-injector.js delete`);
        process.exit(1);
    }
  })().catch((err) => {
    console.error('\n❌ Error:', err.message || err);
    if (macWorker) {
      process.exitCode = 1;
      return;
    }
    process.exit(1);
  });
}

module.exports = {
  locateClaude,
  downloadClaude,
  installDownloadedClaude,
  patchAsar,
  unpatchAsar,
  signMac,
  readAsarHeader,
  isAsarPatched,
  updateInfoPlistHash,
  cmdLocate,
  cmdDelete,
  cmdUpdate,
  installUserRuntime,
  MARKER
};
