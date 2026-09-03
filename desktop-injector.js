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
const { execFileSync } = require('child_process');

const MARKER = '// __CLAUDE_COUNT_USAGE_WRAPPER__';

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

function findAsarUnder(dir) {
  if (!fs.existsSync(dir)) return null;
  const candidates = [
    path.join(dir, 'resources', 'app.asar'),
    path.join(dir, 'app', 'resources', 'app.asar'),
    path.join(dir, 'Contents', 'Resources', 'app.asar')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
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

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https:') ? https : http;

    const req = client.get(url, { headers: { 'User-Agent': 'ClaudeCountUsage-Installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          const parsed = new URL(url);
          redirectUrl = new URL(redirectUrl, parsed.origin).href;
        }
        return downloadFile(redirectUrl, destPath, onProgress).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }

      const total = Number(res.headers['content-length'] || 0);
      let received = 0;

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const out = fs.createWriteStream(destPath);

      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress && total > 0) onProgress(received / total);
      });
      res.pipe(out);
      res.on('error', reject);
      out.on('finish', () => resolve(destPath));
      out.on('error', reject);
    });
    req.on('error', reject);
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

async function downloadClaude(destDir = os.tmpdir()) {
  const plat = os.platform();
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';

  if (plat === 'darwin') {
    console.log('Fetching latest Claude Desktop release info from Anthropic CDN...');
    const { url, version } = await getMacDownloadUrl();
    const dest = path.join(destDir, `Claude-${version}.zip`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024 * 1024) {
      console.log(`Using cached package: ${dest}`);
      return { filePath: dest, version, platform: 'darwin' };
    }
    console.log(`Downloading Claude Desktop ${version} (${arch})...`);
    await downloadFile(url, dest, (p) => {
      process.stdout.write(`\rProgress: ${(p * 100).toFixed(0)}% `);
    });
    process.stdout.write('\n');
    return { filePath: dest, version, platform: 'darwin' };
  }

  if (plat === 'win32') {
    console.log('Fetching latest Claude Desktop MSIX info from Anthropic CDN...');
    const { url, version } = await getWindowsDownloadUrl(arch);
    const dest = path.join(destDir, `Claude-${version}-${arch}.msix`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 50 * 1024 * 1024) {
      console.log(`Using cached package: ${dest}`);
      return { filePath: dest, version, platform: 'win32' };
    }
    console.log(`Downloading Claude Desktop ${version} (${arch})...`);
    await downloadFile(url, dest, (p) => {
      process.stdout.write(`\rProgress: ${(p * 100).toFixed(0)}% `);
    });
    process.stdout.write('\n');
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
    execFileSync('ditto', ['-xk', filePath, destDir]);

    if (!fs.existsSync(appDest)) {
      throw new Error(`Claude.app not found at ${appDest} after extraction`);
    }

    // Strip quarantine right after extraction
    try {
      execFileSync('xattr', ['-cr', appDest], { stdio: 'ignore' });
    } catch {}

    return appDest;
  }

  if (plat === 'win32') {
    const destDir = path.join(os.homedir(), 'AppData', 'Local', 'ClaudeDesktopInjector', 'Claude');
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    const zipAlias = filePath.replace(/\.msix$/i, '.zip');
    fs.copyFileSync(filePath, zipAlias);

    console.log('Extracting portable Claude package...');
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${zipAlias}" -DestinationPath "${destDir}" -Force`
    ]);
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

// ─── Wrapper Source ─────────────────────────────────────────

function generateWrapperSource(relativeMainPath) {
  return `'use strict';
${MARKER}
// Claude Count Usage — Desktop Extension Injector & Event Bridge
const { app, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const EXTENSION_DIR = path.join(process.resourcesPath, 'injected-extension');

let mainWindow = null;
let claudeWebContents = null;
let polyfillsReady = false;
const alarms = new Map();

function fireAlarm(name) {
  if (claudeWebContents) {
    claudeWebContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('electronAlarmFired', { detail: { name: " + JSON.stringify(name) + " } }));"
    ).catch(() => {});
  }
}

function setupPolyfills() {
  if (polyfillsReady || !mainWindow || !claudeWebContents) return;
  polyfillsReady = true;

  claudeWebContents.on('console-message', (event) => {
    const msg = (event && event.message) || '';
    if (msg.startsWith('CUT_ALARM:')) {
      try {
        const data = JSON.parse(msg.substring(10));
        if (data.action === 'create') {
          const existing = alarms.get(data.name);
          if (existing) clearTimeout(existing.timerId);
          let timerId;
          if (data.periodInMinutes) {
            timerId = setInterval(() => fireAlarm(data.name), data.periodInMinutes * 60 * 1000);
          } else if (data.when) {
            const delay = data.when - Date.now();
            if (delay > 0) timerId = setTimeout(() => { fireAlarm(data.name); alarms.delete(data.name); }, delay);
          } else if (data.delayInMinutes) {
            timerId = setTimeout(() => { fireAlarm(data.name); alarms.delete(data.name); }, data.delayInMinutes * 60 * 1000);
          }
          if (timerId) alarms.set(data.name, { timerId });
        } else if (data.action === 'clear') {
          const entry = alarms.get(data.name);
          if (entry) {
            clearTimeout(entry.timerId);
            alarms.delete(data.name);
          }
        }
      } catch (e) {
        console.error('[CCU] Alarm error:', e);
      }
      return;
    }

    if (msg.startsWith('CUT_NOTIFICATION:')) {
      try {
        const content = msg.substring(17);
        let opts;
        try { opts = JSON.parse(content); } catch (e) { opts = { title: 'Claude Count Usage', message: content }; }
        if (Notification && Notification.isSupported && Notification.isSupported()) {
          new Notification({
            title: opts.title || 'Claude Count Usage',
            body: opts.message || opts.body || ''
          }).show();
        }
      } catch (e) {
        console.error('[CCU] Notification error:', e);
      }
      return;
    }
  });

  mainWindow.on('focus', () => {
    claudeWebContents && claudeWebContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('electronTabActivated', { detail: { tabId: 1, windowId: 1 } }));"
    ).catch(() => {});
  });

  mainWindow.on('blur', () => {
    claudeWebContents && claudeWebContents.executeJavaScript(
      "window.dispatchEvent(new CustomEvent('electronTabDeactivated', { detail: { tabId: 1, windowId: 1 } }));"
    ).catch(() => {});
  });
}

app.on('browser-window-created', (event, win) => {
  if (!mainWindow) {
    mainWindow = win;
    setupPolyfills();
  }
});

app.on('web-contents-created', (event, contents) => {
  if (claudeWebContents) return;
  const check = (url) => {
    if (claudeWebContents) return;
    if (url && url.includes('claude.ai')) {
      claudeWebContents = contents;
      setupPolyfills();
    }
  };
  contents.on('did-start-navigation', (d) => check((d && d.url) || ''));
  contents.once('dom-ready', () => check(contents.getURL()));
});

async function loadInjectedExtension() {
  try {
    if (!fs.existsSync(EXTENSION_DIR)) {
      console.log('[CCU] No extension folder found at', EXTENSION_DIR);
      return;
    }
    await session.defaultSession.loadExtension(EXTENSION_DIR, { allowFileAccess: true });
    console.log('[CCU] Claude Count Usage extension loaded from', EXTENSION_DIR);
  } catch (err) {
    console.error('[CCU] Failed to load extension:', err);
  }
}

app.whenReady().then(loadInjectedExtension);

// Boot original application
require(${JSON.stringify(relativeMainPath)});
`;
}

// ─── Surgical ASAR Patcher ──────────────────────────────────

async function patchAsar(asarPath, extensionDir) {
  if (!fs.existsSync(asarPath)) throw new Error(`No app.asar at ${asarPath}`);
  if (!fs.existsSync(extensionDir)) throw new Error(`Extension dir not found at ${extensionDir}`);

  const resourcesDir = path.dirname(asarPath);
  const { header, dataOffset } = readAsarHeader(asarPath);

  // 1. Locate package.json
  const pkgNode = getNode(header, 'package.json');
  if (!pkgNode) throw new Error('No package.json found inside app.asar');

  const pkgBuf = readFileFromAsar(asarPath, dataOffset, pkgNode);
  const pkg = JSON.parse(pkgBuf.toString('utf8'));

  // Determine current and original main
  const currentMain = pkg.main || 'index.js';
  let originalMain = pkg._originalMain;

  // Check if target file already has our wrapper
  const currentMainNode = getNode(header, currentMain);
  if (currentMainNode) {
    const currentMainBuf = readFileFromAsar(asarPath, dataOffset, currentMainNode);
    if (currentMainBuf && currentMainBuf.toString('utf8').includes(MARKER)) {
      console.log('app.asar already has Claude Count Usage wrapper installed (idempotent).');
      // Update extension files next to asar
      installExtensionFolder(resourcesDir, extensionDir);
      return { asarPath, alreadyPatched: true };
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
    console.log('Creating safety backup:', backupAsar);
    fs.copyFileSync(asarPath, backupAsar);
  }

  // Replace asar
  fs.renameSync(tempAsarPath, asarPath);
  console.log('Patched app.asar successfully.');

  // Copy extension folder next to asar
  installExtensionFolder(resourcesDir, extensionDir);

  return { asarPath, backupAsar, alreadyPatched: false };
}

function installExtensionFolder(resourcesDir, extensionDir) {
  const destExtDir = path.join(resourcesDir, 'injected-extension');
  console.log('Installing extension to:', destExtDir);
  if (fs.existsSync(destExtDir)) {
    fs.rmSync(destExtDir, { recursive: true, force: true });
  }
  fs.cpSync(extensionDir, destExtDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return !['.git', 'install.command', 'install.bat', 'uninstall.command', 'uninstall.bat', 'README.md', 'PRIVACY.md'].includes(base);
    }
  });
  // Ensure manifest.json in dest is the electron manifest
  const manifestElectron = path.join(destExtDir, 'manifest_electron.json');
  if (fs.existsSync(manifestElectron)) {
    fs.copyFileSync(manifestElectron, path.join(destExtDir, 'manifest.json'));
  }
}

function unpatchAsar(asarPath) {
  const backupAsar = asarPath + '.bak';
  if (!fs.existsSync(backupAsar)) {
    throw new Error(`No backup file found at ${backupAsar}`);
  }
  fs.copyFileSync(backupAsar, asarPath);
  const resourcesDir = path.dirname(asarPath);
  const extDir = path.join(resourcesDir, 'injected-extension');
  if (fs.existsSync(extDir)) fs.rmSync(extDir, { recursive: true, force: true });
  console.log('Restored original app.asar from backup.');
}

// ─── macOS Info.plist ElectronAsarIntegrity & Code Signing ──

function updateInfoPlistHash(appPath, asarPath) {
  if (os.platform() !== 'darwin') return;
  const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
  if (!fs.existsSync(infoPlist)) return;

  try {
    const fd = fs.openSync(asarPath, 'r');
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);
    const jsonLen = prefix.readUInt32LE(12);
    const headerBuf = Buffer.alloc(jsonLen);
    fs.readSync(fd, headerBuf, 0, jsonLen, 16);
    fs.closeSync(fd);

    const headerHash = crypto.createHash('sha256').update(headerBuf).digest('hex');
    console.log(`Updating ElectronAsarIntegrity in Info.plist to: ${headerHash}`);

    try {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
        infoPlist
      ]);
    } catch {
      try {
        execFileSync('/usr/libexec/PlistBuddy', [
          '-c',
          `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${headerHash}`,
          infoPlist
        ]);
      } catch (e) {
        console.warn('PlistBuddy notice:', e.message);
      }
    }
  } catch (err) {
    console.warn('Could not compute or update asar hash in Info.plist:', err.message);
  }
}

function signMac(appPath) {
  if (os.platform() !== 'darwin') return;
  console.log('Removing quarantine attributes...');
  try {
    execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' });
  } catch {}

  console.log('Ad-hoc re-signing bundle:', appPath);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  } catch (e) {
    console.warn('codesign notice:', e.message);
  }

  // Clear quarantine again after signing to guarantee Gatekeeper allows it
  try {
    execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' });
  } catch {}
}

// ─── High-Level CLI Actions ─────────────────────────────────

async function cmdInstall(extensionDir) {
  let install = locateClaude();

  if (install && install.platform === 'darwin' && !isBundleHealthy(install.appPath)) {
    console.log('Detected corrupted or broken app bundle (broken framework symlinks).');
    console.log('Restoring clean official Claude Desktop bundle directly from Anthropic package...');
    install = null;
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
  await patchAsar(install.asarPath, extensionDir);

  if (install.platform === 'darwin') {
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }

  console.log('\n Claude Count Usage installed successfully into Claude Desktop!');
}

async function cmdPatch(extensionDir) {
  const install = locateClaude();
  if (!install) {
    throw new Error('Claude Desktop not found. Use "install" to automatically download and install it.');
  }
  await patchAsar(install.asarPath, extensionDir);
  if (install.platform === 'darwin') {
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }
  console.log('Patched successfully.');
}

function cmdUnpatch() {
  const install = locateClaude();
  if (!install) throw new Error('Claude Desktop not found.');
  unpatchAsar(install.asarPath);
  if (install.platform === 'darwin') {
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }
  console.log('Unpatched and restored original Claude Desktop.');
}

function cmdCheck() {
  const install = locateClaude();
  if (!install) {
    console.log('NOT_INSTALLED');
    process.exit(1);
  }
  const { header, dataOffset } = readAsarHeader(install.asarPath);
  const pkgNode = getNode(header, 'package.json');
  if (!pkgNode) {
    console.log('INVALID_ASAR');
    process.exit(1);
  }
  const pkg = JSON.parse(readFileFromAsar(install.asarPath, dataOffset, pkgNode).toString('utf8'));
  const mainNode = getNode(header, pkg.main || 'index.js');
  if (mainNode) {
    const mainBuf = readFileFromAsar(install.asarPath, dataOffset, mainNode);
    if (mainBuf && mainBuf.toString('utf8').includes(MARKER)) {
      console.log('PATCHED');
      process.exit(0);
    }
  }
  console.log('READY');
  process.exit(0);
}

// ─── Entry Point ────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const command = args[0] || 'install';
  const extDir = args[1] || path.resolve(__dirname);

  (async () => {
    switch (command) {
      case 'install':
        await cmdInstall(extDir);
        break;
      case 'patch':
        await cmdPatch(extDir);
        break;
      case 'unpatch':
        cmdUnpatch();
        break;
      case 'check':
        cmdCheck();
        break;
      default:
        console.log(`Usage:
  node desktop-injector.js install [extensionDir]
  node desktop-injector.js patch   [extensionDir]
  node desktop-injector.js unpatch
  node desktop-injector.js check`);
        process.exit(1);
    }
  })().catch((err) => {
    console.error('\n❌ Error:', err.message || err);
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
  MARKER
};
