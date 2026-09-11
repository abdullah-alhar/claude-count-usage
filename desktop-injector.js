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
    execFileSync('ditto', ['-xk', filePath, destDir]);

    if (!fs.existsSync(appDest)) {
      throw new Error(`Claude.app not found at ${appDest} after extraction`);
    }

    // Strip quarantine right after extraction
    try {
      execFileSync('xattr', ['-cr', appDest], { stdio: 'ignore' });
    } catch {}

    const shipItPath = path.join(appDest, 'Contents', 'Frameworks',
      'Squirrel.framework', 'Resources', 'ShipIt');
    try {
      if (fs.existsSync(shipItPath)) {
        fs.rmSync(shipItPath, { force: true });
        console.log('Removed ShipIt to prevent Claude Desktop self-updates.');
      }
    } catch (e) {
      console.warn('Could not remove ShipIt:', e.message);
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
  return `'use strict';
${MARKER}
// Claude Count Usage — Desktop Extension Injector & Event Bridge
require('events').EventEmitter.defaultMaxListeners = 100;
const { app, session, Notification, webContents } = require('electron');
const path = require('path');
const fs = require('fs');

const EXTENSION_DIR = path.join(process.resourcesPath, 'injected-extension');

// ── Extension loader: inject into EVERY session, not just defaultSession ──
// Claude Desktop renders claude.ai inside a WebContentsView that uses its
// own session/partition. An extension loaded only into defaultSession will
// never get its content scripts injected into that view. We track which
// sessions we've already loaded into via a WeakSet to avoid duplicates.
const loadedSessions = new WeakSet();

async function loadIntoSession(sess) {
  if (!sess || loadedSessions.has(sess)) return;
  loadedSessions.add(sess);
  try {
    await sess.loadExtension(EXTENSION_DIR, { allowFileAccess: true });
    console.log('[CCU] Extension loaded into session');
  } catch (err) {
    console.error('[CCU] Failed to load extension into session:', err);
  }
}

async function loadExtensionEverywhere() {
  if (!fs.existsSync(EXTENSION_DIR)) {
    console.log('[CCU] No extension folder found at', EXTENSION_DIR);
    return;
  }
  // Load into default session first
  await loadIntoSession(session.defaultSession);
  // Load into every existing WebContents' session
  for (const wc of webContents.getAllWebContents()) {
    await loadIntoSession(wc.session);
  }
  // Load into any future WebContents' sessions
  app.on('web-contents-created', (_event, wc) => loadIntoSession(wc.session));
  console.log('[CCU] Claude Count Usage extension loaded from', EXTENSION_DIR);
}

// ── Polyfill bridge (alarms, notifications, tab events) ──
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
  contents.on('console-message', (ev, level, message) => {
    const text = typeof message === 'string' ? message : (typeof level === 'string' ? level : ((ev && ev.message) || ''));
    if (text.includes('[CCU]') || text.includes('UsageTracker') || text.includes('Last-resort') || text.includes('Count Usage') || text.includes('[SIDEBAR DIAG') || text.includes('Error') || text.startsWith('CUT_')) {
      console.log('[Renderer]', text);
    }
  });

  if (claudeWebContents) return;
  const check = (url) => {
    if (claudeWebContents) return;
    if (url && (url.includes('claude.ai') || url.includes('localhost'))) {
      claudeWebContents = contents;
      setupPolyfills();
    }
  };
  contents.on('did-start-navigation', (_ev, url) => check(url || ''));
  contents.once('dom-ready', () => check(contents.getURL()));
});

app.whenReady().then(loadExtensionEverywhere);

// Boot original application
require(${JSON.stringify(relativeMainPath)});
`;
}

// ─── Process & Lock Management ──────────────────────────────

function closeRunningClaude() {
  try {
    if (os.platform() === 'win32') {
      execFileSync('taskkill', ['/f', '/im', 'Claude.exe'], { stdio: 'ignore' });
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

async function patchAsar(asarPath, extensionDir) {
  if (!fs.existsSync(asarPath)) throw new Error(`No app.asar at ${asarPath}`);
  if (!fs.existsSync(extensionDir)) throw new Error(`Extension dir not found at ${extensionDir}`);

  const resourcesDir = path.dirname(asarPath);

  // Clean up any stale temporary asar files from previous failed runs
  try {
    for (const file of fs.readdirSync(resourcesDir)) {
      if (file.startsWith('app.asar.tmp-') || file.startsWith('app.asar.old-')) {
        try { fs.unlinkSync(path.join(resourcesDir, file)); } catch {}
      }
    }
  } catch {}
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
  const currentMainNode = getNode(header, currentMain);
  if (currentMainNode) {
    const currentMainBuf = readFileFromAsar(asarPath, dataOffset, currentMainNode);
    if (currentMainBuf && currentMainBuf.toString('utf8').includes(MARKER)) {
      console.log('app.asar already has Claude Count Usage wrapper installed; refreshing wrapper & extension...');
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

  // Copy extension folder next to asar
  installExtensionFolder(resourcesDir, extensionDir);

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

function installExtensionFolder(resourcesDir, extensionDir) {
  const destExtDir = path.join(resourcesDir, 'injected-extension');
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

  const readBack = execFileSync('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :ElectronAsarIntegrity:Resources/app.asar:hash',
    infoPlist
  ], { encoding: 'utf8' }).trim();

  if (readBack !== headerHash) {
    throw new Error(
      `ElectronAsarIntegrity verification mismatch in Info.plist: expected "${headerHash}", read back "${readBack}"`
    );
  }
  console.log('Verified ElectronAsarIntegrity in Info.plist matches asar header hash.');
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

// ─── macOS Auto-Update Prevention & Stale LaunchAgent Cleanup ──

function disableMacAutoUpdates(appPath) {
  if (os.platform() !== 'darwin') return;

  // 1. Remove ShipIt from Squirrel.framework to prevent automatic self-updates from overwriting Claude.app on reboot
  const possibleShipItPaths = [
    path.join(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt'),
    path.join(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Versions', 'A', 'Resources', 'ShipIt'),
    path.join(appPath, 'Contents', 'Frameworks', 'Squirrel.framework', 'Versions', 'Current', 'Resources', 'ShipIt')
  ];
  for (const shipIt of possibleShipItPaths) {
    try {
      if (fs.existsSync(shipIt)) {
        fs.rmSync(shipIt, { force: true });
        console.log(`Removed ${path.basename(shipIt)} to protect Claude Desktop patch from self-updates.`);
      }
    } catch {}
  }

  // 2. Clear staged ShipIt update caches that could trigger an overwrite on reboot
  const home = os.homedir();
  const shipItCacheDir = path.join(home, 'Library', 'Caches', 'com.anthropic.claudefordesktop.ShipIt');
  try {
    if (fs.existsSync(shipItCacheDir)) {
      for (const item of fs.readdirSync(shipItCacheDir)) {
        try { fs.rmSync(path.join(shipItCacheDir, item), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}

  // 3. Remove obsolete LaunchAgents that previously ran legacy patch engines on reboot
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

  // Also clean old Application Support folder if present
  const oldAppSupport = path.join(home, 'Library', 'Application Support', 'ClaudeCountUsage');
  try {
    if (fs.existsSync(oldAppSupport)) {
      fs.rmSync(oldAppSupport, { recursive: true, force: true });
    }
  } catch {}
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
    execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript]);
    console.log('Created Start Menu shortcut (Windows Search will now find Claude).');
  } catch (err) {
    console.warn('Could not create shortcut:', err.message);
  }
}

// ─── High-Level CLI Actions ─────────────────────────────────

async function cmdInstall(extensionDir) {
  closeRunningClaude();
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
    disableMacAutoUpdates(install.appPath);
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }

  if (install.platform === 'win32') {
    updateWindowsExeIntegrity(install.appPath, install.asarPath);
    setupWindowsShortcuts(install.appPath);
  }

  if (!isAsarPatched(install.asarPath)) {
    throw new Error(`Verification failed: ${install.asarPath} does not contain the injection marker after patching.`);
  }

  console.log('\n Claude Count Usage installed successfully into Claude Desktop!');
}

async function cmdPatch(extensionDir) {
  closeRunningClaude();
  const install = locateClaude();
  if (!install) {
    throw new Error('Claude Desktop not found. Use "install" to automatically download and install it.');
  }
  await patchAsar(install.asarPath, extensionDir);
  if (install.platform === 'darwin') {
    disableMacAutoUpdates(install.appPath);
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }
  if (install.platform === 'win32') {
    updateWindowsExeIntegrity(install.appPath, install.asarPath);
    setupWindowsShortcuts(install.appPath);
  }
  if (!isAsarPatched(install.asarPath)) {
    throw new Error(`Verification failed: ${install.asarPath} does not contain the injection marker after patching.`);
  }
  console.log('Patched successfully.');
}

function cmdUnpatch() {
  closeRunningClaude();
  const install = locateClaude();
  if (!install) throw new Error('Claude Desktop not found.');
  unpatchAsar(install.asarPath);
  if (install.platform === 'darwin') {
    disableMacAutoUpdates(install.appPath);
    updateInfoPlistHash(install.appPath, install.asarPath);
    signMac(install.appPath);
  }
  console.log('Unpatched and restored original Claude Desktop.');
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
  console.log('DELETED:' + install.appPath);
}

// ─── CLI Entrypoint ─────────────────────────────────────────

if (require.main === module) {
  const [,, cmd, arg1] = process.argv;
  const extDir = arg1 || __dirname;

  (async () => {
    switch (cmd) {
      case 'install':
        await cmdInstall(extDir);
        process.exit(0);
        break;
      case 'patch':
        await cmdPatch(extDir);
        process.exit(0);
        break;
      case 'unpatch':
        cmdUnpatch();
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
  node desktop-injector.js check
  node desktop-injector.js locate
  node desktop-injector.js delete`);
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
  isAsarPatched,
  updateInfoPlistHash,
  cmdLocate,
  cmdDelete,
  MARKER
};