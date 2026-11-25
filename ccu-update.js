'use strict';
/**
 * Claude Count Usage — shared update engine.
 *
 * Used by two callers:
 *   - desktop-injector.js (CLI: `update <zip> --sha256 <hash>`)
 *   - wrapper-runtime.js  (in-app "Update now": download, verify, swap, restart)
 *
 * Pure Node, no npm dependencies. Keeping the tracker in a user-owned folder means an update
 * never touches the signed Claude.app bundle: no re-signing, no Gatekeeper, no admin prompt.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const https = require('https');
const { pipeline } = require('stream/promises');
const { Script } = require('vm');

const APP_DIR_NAME = 'ClaudeCountUsage';
const STATE_FILE = 'state.json';

// ─── Paths ──────────────────────────────────────────────────

// Deliberately independent of Electron so the CLI, the bootstrap and tests all agree.
function ccuRoot() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, APP_DIR_NAME);
  }
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(config, APP_DIR_NAME);
}

function extensionDir(root = ccuRoot()) { return path.join(root, 'extension'); }
function runtimeDir(root = ccuRoot()) { return path.join(root, 'runtime'); }
function statePath(root = ccuRoot()) { return path.join(root, STATE_FILE); }
function tempDir(root = ccuRoot()) { return path.join(root, 'tmp'); }

function readState(root = ccuRoot()) {
  try { return JSON.parse(fs.readFileSync(statePath(root), 'utf8')); } catch { return {}; }
}

function writeState(root, patch) {
  const next = { ...readState(root), ...patch };
  try {
    fs.mkdirSync(root, { recursive: true });
    const tmp = statePath(root) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, statePath(root));
  } catch {}
  return next;
}

function readExtensionVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
}

function extensionIdForPath(dir) {
  const windows = process.platform === 'win32';
  const normalized = windows ? dir.replace(/^[a-z]:/, drive => drive.toUpperCase()) : dir;
  return crypto.createHash('sha256').update(normalized, windows ? 'utf16le' : 'utf8').digest('hex')
    .slice(0, 32).replace(/./g, hex => String.fromCharCode(97 + parseInt(hex, 16)));
}

function migrateExtensionSettings(storage, sourceDir, destDir) {
  for (const name of ['Local Extension Settings', 'Sync Extension Settings']) {
    const parent = path.join(storage, name);
    const source = path.join(parent, extensionIdForPath(sourceDir));
    const dest = path.join(parent, extensionIdForPath(destDir));
    if (fs.existsSync(dest) || !fs.existsSync(source)) continue;
    const temporary = fs.mkdtempSync(path.join(parent, 'ccu-settings-'));
    try {
      fs.cpSync(source, temporary, { recursive: true, filter: file => path.basename(file) !== 'LOCK' });
      fs.renameSync(temporary, dest);
    } finally {
      fs.rmSync(temporary, { force: true, recursive: true });
    }
  }
}

// ─── Hashing ────────────────────────────────────────────────

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeSha(value) {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

// ─── Minimal ZIP reader ─────────────────────────────────────
//
// Release assets are ordinary (non-ZIP64) archives with stored or deflated entries, so a
// ~100-line reader is enough and avoids depending on `unzip` / `tar` being installed.

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      return {
        entryCount: buffer.readUInt16LE(i + 10),
        centralOffset: buffer.readUInt32LE(i + 16)
      };
    }
  }
  return null;
}

function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (!eocd) throw new Error('Not a ZIP archive (no end-of-central-directory record)');
  if (eocd.centralOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');

  const entries = [];
  let offset = eocd.centralOffset;
  for (let i = 0; i < eocd.entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP central directory');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    if (flags & 0x1) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Rejects absolute paths and `..` traversal, and normalises Windows separators.
function safeZipPath(destDir, entryName) {
  const name = String(entryName).replace(/\\/g, '/');
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw new Error(`Unsafe ZIP path: ${entryName}`);
  const normalized = path.normalize(name);
  if (normalized.split(/[\\/]/).includes('..')) throw new Error(`Unsafe ZIP path: ${entryName}`);
  const target = path.resolve(destDir, normalized);
  if (target !== path.resolve(destDir) && !target.startsWith(path.resolve(destDir) + path.sep)) {
    throw new Error(`Unsafe ZIP path: ${entryName}`);
  }
  return target;
}

function extractZipBuffer(buffer, destDir) {
  const entries = readZipEntries(buffer);
  fs.mkdirSync(destDir, { recursive: true });

  for (const entry of entries) {
    const target = safeZipPath(destDir, entry.name);
    if (/[\\/]$/.test(entry.name)) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP entry: ${entry.name}`);
    }
    const localNameLen = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(entry.localOffset + 28);
    const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Truncated ZIP entry: ${entry.name}`);
    const raw = buffer.subarray(dataStart, dataEnd);

    let data;
    if (entry.method === 0) {
      data = raw;
    } else if (entry.method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
    }
    if (entry.size && data.length !== entry.size) {
      throw new Error(`Size mismatch while unpacking ${entry.name}`);
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
  return entries.length;
}

function extractZipFile(zipPath, destDir) {
  return extractZipBuffer(fs.readFileSync(zipPath), destDir);
}

// ─── Download ───────────────────────────────────────────────

async function downloadToFile(url, destPath, options = {}) {
  const {
    onProgress = () => {},
    maxRedirects = 8,
    timeoutMs = 30000,
    allowedHosts,
    expectedSize,
    headers = {}
  } = options;

  async function request(target, redirectsLeft) {
    const parsed = new URL(target);
    if (parsed.protocol !== 'https:' || (allowedHosts && !allowedHosts.includes(parsed.hostname))) {
      throw new Error('Unexpected update download host: ' + parsed.host);
    }

    const res = await new Promise((resolve, reject) => {
      const req = https.get(parsed, {
        headers: {
          'User-Agent': 'ClaudeCountUsage-Updater',
          'Accept': 'application/octet-stream',
          ...headers
        }
      }, resolve);
      req.setTimeout(timeoutMs, () => req.destroy(new Error('Update download timed out')));
      req.on('error', reject);
    });
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirectsLeft <= 0) throw new Error('Too many redirects while downloading the update');
      return request(new URL(res.headers.location, parsed), redirectsLeft - 1);
    }
    if (status !== 200) {
      res.resume();
      throw new Error(`Update download failed with HTTP ${status}`);
    }
    return res;
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  try {
    const res = await request(url, maxRedirects);
    const total = expectedSize || Number(res.headers['content-length']) || 0;
    let received = 0;
    let lastReport = 0;
    res.on('data', (chunk) => {
      received += chunk.length;
      if (total && received > total) {
        res.destroy(new Error('Update download exceeded the expected size'));
      } else if (Date.now() - lastReport > 120) {
        lastReport = Date.now();
        onProgress({ received, total, percent: total ? Math.floor(received * 100 / total) : null });
      }
    });
    await pipeline(res, fs.createWriteStream(destPath));
    if (total && received !== total) throw new Error('Update download did not match the expected size');
    onProgress({ received, total, percent: 100 });
    return { received, total };
  } catch (error) {
    try { fs.unlinkSync(destPath); } catch {}
    throw error;
  }
}

// ─── Applying a package ─────────────────────────────────────

// A package (release asset `ccu-extension.zip`) looks like:
//   extension/...            the tracker itself
//   runtime/wrapper-runtime.js
//   runtime/ccu-update.js
//   version.json             { "version": "1.7.0" }
function validatePackageDir(packageDir, expectedVersion) {
  const ext = path.join(packageDir, 'extension');
  const runtime = path.join(packageDir, 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
  const { version } = JSON.parse(fs.readFileSync(path.join(packageDir, 'version.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.version !== version || (expectedVersion && expectedVersion !== version)) {
    throw new Error('Update package version does not match the release');
  }
  for (const name of ['wrapper-runtime.js', 'ccu-update.js']) {
    const filename = path.join(runtime, name);
    new Script(fs.readFileSync(filename, 'utf8'), { filename });
  }
  for (const name of ['background.js', 'bg-components/update-check.js', 'content-components/settings_card.js']) {
    if (!fs.statSync(path.join(ext, name)).isFile()) throw new Error('Update package is missing ' + name);
  }
  return { version, extensionDir: ext, runtimeDir: runtime };
}

// Windows occasionally holds a directory handle open for a moment after Claude exits, so renames
// get a few retries instead of failing the whole update.
function renameWithRetry(from, to, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (attempt >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      } catch {
        const until = Date.now() + 150;
        while (Date.now() < until) { /* brief spin */ }
      }
    }
  }
}

function replaceDirsAtomic(root, names) {
  const dirs = names.map(name => ({
    current: path.join(root, name),
    incoming: path.join(root, name + '.new'),
    previous: path.join(root, name + '.old'),
    hadCurrent: false,
    installed: false
  }));

  try {
    // Move every working tree aside before installing either new tree.
    for (const dir of dirs) {
      fs.rmSync(dir.previous, { recursive: true, force: true });
      dir.hadCurrent = fs.existsSync(dir.current);
      if (dir.hadCurrent) renameWithRetry(dir.current, dir.previous);
    }
    for (const dir of dirs) {
      renameWithRetry(dir.incoming, dir.current);
      dir.installed = true;
    }
  } catch (error) {
    // Roll back the pair. Never leave a new extension with an old runtime (or vice versa).
    for (const dir of dirs) {
      if (dir.installed) {
        try { fs.rmSync(dir.current, { recursive: true, force: true }); } catch {}
      }
    }
    for (const dir of dirs) {
      if (dir.hadCurrent && !fs.existsSync(dir.current) && fs.existsSync(dir.previous)) {
        try { renameWithRetry(dir.previous, dir.current); } catch {}
      }
    }
    throw error;
  }
}

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      copyTree(path.join(src, entry.name), path.join(dest, entry.name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Moves the validated package into place. The caller restarts Claude afterwards; the old copy
// stays in extension.old / runtime.old until the next successful update so the runtime can fall
// back if the new files fail to load.
function applyUpdatePackage({ packageDir, root = ccuRoot(), version = null, onProgress = () => {} }) {
  const pkg = validatePackageDir(packageDir, version);
  const resolvedVersion = pkg.version;

  fs.mkdirSync(root, { recursive: true });
  onProgress({ phase: 'installing', percent: 90 });

  // Stage both trees first so a failure leaves the current install untouched.
  const stagedExt = path.join(root, 'extension.new');
  const stagedRuntime = path.join(root, 'runtime.new');
  fs.rmSync(stagedExt, { recursive: true, force: true });
  fs.rmSync(stagedRuntime, { recursive: true, force: true });
  copyTree(pkg.extensionDir, stagedExt);
  copyTree(pkg.runtimeDir, stagedRuntime);

  const previousVersion = readState(root).version || null;
  replaceDirsAtomic(root, ['extension', 'runtime']);
  writeState(root, {
    version: resolvedVersion,
    previousVersion,
    updatedAt: new Date().toISOString(),
    pendingRestart: true
  });

  onProgress({ phase: 'installing', percent: 100 });
  return { version: resolvedVersion, previousVersion };
}

// Runs a validated package from a zip file: verify → unpack → apply.
async function applyUpdateZip({ zipPath, sha256, root = ccuRoot(), version = null, onProgress = () => {} }) {
  if (sha256) {
    onProgress({ phase: 'verifying', percent: 80 });
    const actual = await sha256File(zipPath);
    if (normalizeSha(actual) !== normalizeSha(sha256)) {
      throw new Error(`Checksum mismatch (expected ${normalizeSha(sha256).slice(0, 12)}…, got ${actual.slice(0, 12)}…)`);
    }
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-update-'));
  try {
    extractZipFile(zipPath, work);
    return applyUpdatePackage({ packageDir: work, root, version, onProgress });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

// ─── Service worker cache ───────────────────────────────────
//
// Electron keeps the extension's service worker on disk. Replacing extension files without
// clearing it leaves the old background.js running until the cache is dropped.

function clearServiceWorkerCache() {
  const userDataDirs = process.platform === 'darwin'
    ? [path.join(os.homedir(), 'Library', 'Application Support', 'Claude')]
    : process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude')]
      : [path.join(os.homedir(), '.config', 'Claude')];

  const cleared = [];
  for (const userData of userDataDirs) {
    if (!fs.existsSync(userData)) continue;
    const targets = [path.join(userData, 'Service Worker')];
    const partitions = path.join(userData, 'Partitions');
    try {
      for (const name of fs.readdirSync(partitions)) targets.push(path.join(partitions, name, 'Service Worker'));
    } catch {}
    for (const dir of targets) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        cleared.push(dir);
      } catch {}
    }
  }
  return cleared;
}

module.exports = {
  APP_DIR_NAME,
  ccuRoot,
  extensionDir,
  runtimeDir,
  statePath,
  tempDir,
  readState,
  writeState,
  readExtensionVersion,
  extensionIdForPath,
  migrateExtensionSettings,
  sha256File,
  normalizeSha,
  readZipEntries,
  extractZipBuffer,
  extractZipFile,
  downloadToFile,
  validatePackageDir,
  applyUpdatePackage,
  applyUpdateZip,
  clearServiceWorkerCache
};
