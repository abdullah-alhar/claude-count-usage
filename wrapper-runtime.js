'use strict';
/**
 * Claude Count Usage — main-process runtime.
 *
 * Loaded by the tiny bootstrap that the installer writes into app.asar. Everything that can
 * change between releases lives here (in the user's own folder), so updating the tracker never
 * rewrites the signed Claude.app bundle.
 *
 * Responsibilities:
 *   - load the tracker extension into every session that shows claude.ai
 *   - bridge chrome.alarms / chrome.notifications / tab focus to the extension
 *   - answer the extension's "Update now" request: download, verify, swap, restart
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, session, Notification, webContents } = require('electron');
const updater = require('./ccu-update.js');

require('events').EventEmitter.defaultMaxListeners = 100;

const MARKER = '// __CLAUDE_COUNT_USAGE_WRAPPER__';
const ROOT = updater.ccuRoot();
const USER_EXTENSION_DIR = updater.extensionDir(ROOT);
const PREVIOUS_EXTENSION_DIR = path.join(ROOT, 'extension.old');
const STARTUP_STATE = updater.readState(ROOT);
const BUNDLED_EXTENSION_DIR = path.join(process.resourcesPath || '', 'injected-extension');

// ── Startup timing log ──────────────────────────────────────
const startupT0 = (typeof process.getCreationTime === 'function' && process.getCreationTime()) || (Date.now() - Math.round(process.uptime() * 1000));
const STARTUP_WATCH_MS = 3 * 60 * 1000;
let startupLogPath = null;
const startupBuffer = [];

function appendStartupLine(line) {
  try { fs.appendFileSync(startupLogPath, line + '\n'); } catch {}
}

function startupLog(event, detail) {
  if (Date.now() - startupT0 > STARTUP_WATCH_MS && !/gone|unresponsive|fail/.test(event)) return;
  const line = '+' + (Date.now() - startupT0) + 'ms ' + event + (detail ? ' ' + detail : '');
  if (startupLogPath) appendStartupLine(line); else startupBuffer.push(line);
}

startupLog('runtime loaded');

app.whenReady().then(() => {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    startupLogPath = path.join(dir, 'ccu-startup.log');
    try { if (fs.statSync(startupLogPath).size > 256 * 1024) fs.renameSync(startupLogPath, startupLogPath + '.old'); } catch {}
    appendStartupLine('==== ' + new Date(startupT0).toISOString() + ' Claude ' + app.getVersion() + ' ' + process.platform + '/' + process.arch +
      ' windowsStore=' + !!process.windowsStore + ' exe=' + process.execPath);
    startupBuffer.splice(0).forEach(appendStartupLine);
  } catch {}
  startupLog('app ready');
});

app.on('child-process-gone', (_e, d) => startupLog('child-process-gone', d.type + ' reason=' + d.reason + ' exit=' + d.exitCode + (d.name ? ' name=' + d.name : '')));
app.on('render-process-gone', (_e, _wc, d) => startupLog('render-process-gone', 'reason=' + d.reason + ' exit=' + d.exitCode));
app.on('browser-window-created', (_e, win) => {
  startupLog('window created');
  win.on('unresponsive', () => startupLog('window unresponsive'));
  win.on('responsive', () => startupLog('window responsive again'));
});

// ── Extension loader ────────────────────────────────────────
const loadedSessions = new WeakSet();
const isClaudeUrl = (url) => /^https:\/\/([a-z0-9-]+\.)*claude\.ai(\/|$)/i.test(url || '');

function firstExistingDir(dirs) {
  for (const dir of dirs) {
    try { if (dir && fs.existsSync(path.join(dir, 'manifest.json'))) return dir; } catch {}
  }
  return null;
}

const extensionsBySession = new WeakMap();

async function loadExtensionFrom(dir, sess) {
  const loader = sess.extensions && typeof sess.extensions.loadExtension === 'function' ? sess.extensions : sess;
  const version = updater.readExtensionVersion(dir);
  const storage = sess.getStoragePath?.();
  const extensionId = updater.extensionIdForPath(dir);
  if (storage && dir !== BUNDLED_EXTENSION_DIR) {
    const source = dir === PREVIOUS_EXTENSION_DIR ? USER_EXTENSION_DIR : BUNDLED_EXTENSION_DIR;
    updater.migrateExtensionSettings(storage, source, dir);
  }
  if (dir === USER_EXTENSION_DIR && (STARTUP_STATE.pendingRestart || STARTUP_STATE.runningVersion !== version)) {
    await sess.clearStorageData({ origin: 'chrome-extension://' + extensionId, storages: ['serviceworkers'] });
  }
  const extension = await loader.loadExtension(dir, { allowFileAccess: true });
  extensionsBySession.set(sess, { version: extension.version, dir });
  return extension.version;
}

async function loadIntoSession(sess) {
  if (!sess || loadedSessions.has(sess)) return;
  loadedSessions.add(sess);
  const started = Date.now();
  const alternateRuntime = path.basename(__dirname) === 'runtime.old';
  const dirs = [alternateRuntime ? PREVIOUS_EXTENSION_DIR : USER_EXTENSION_DIR, PREVIOUS_EXTENSION_DIR, BUNDLED_EXTENSION_DIR];
  for (const dir of new Set(dirs)) {
    if (!firstExistingDir([dir])) continue;
    try {
      const runningVersion = await loadExtensionFrom(dir, sess);
      startupLog('extension loaded', runningVersion + ' in ' + (Date.now() - started) + 'ms from ' + path.basename(dir));
      updater.writeState(ROOT, { pendingRestart: false, runningVersion });
      return;
    } catch (error) {
      console.error('[CCU] Failed to load tracker from', dir, error);
      startupLog('extension load failed', String(error?.message || error));
    }
  }
}

async function loadExtensionEverywhere() {
  if (!firstExistingDir([USER_EXTENSION_DIR, PREVIOUS_EXTENSION_DIR, BUNDLED_EXTENSION_DIR])) {
    console.log('[CCU] No extension folder found; skipping load');
    return;
  }
  await loadIntoSession(session.defaultSession);
  const followClaude = (wc) => {
    if (isClaudeUrl(wc.getURL())) loadIntoSession(wc.session);
    wc.on('did-start-navigation', (details, url, _sameDocument, isMainFrame) => {
      if ((details.isMainFrame ?? isMainFrame) !== false && isClaudeUrl(details.url || url)) loadIntoSession(wc.session);
    });
  };
  for (const wc of webContents.getAllWebContents()) followClaude(wc);
  app.on('web-contents-created', (_event, wc) => followClaude(wc));
  console.log('[CCU] Tracker loaded from', USER_EXTENSION_DIR);
}

// ── Polyfill bridge (alarms, notifications, tabs, updates) ──
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

function emitUpdateState(state, target = claudeWebContents) {
  if (!target || target.isDestroyed?.()) return;
  target.executeJavaScript(
    "window.dispatchEvent(new CustomEvent('ccuUpdateState', { detail: " + JSON.stringify(state) + " }));"
  ).catch(() => {});
}

function showNotification(title, body) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch {}
}

// ── In-app update ───────────────────────────────────────────
let activeUpdate;

async function handleUpdateRequest(payload, target) {
  if (activeUpdate) {
    activeUpdate.targets.add(target);
    emitUpdateState(activeUpdate.state, target);
    return;
  }
  const targets = new Set([target]);
  const emit = (state) => {
    activeUpdate = { targets, state };
    for (const contents of targets) emitUpdateState(state, contents);
  };
  emit({ phase: 'checking', percent: 0 });

  let staging;
  try {
    const loaded = extensionsBySession.get(target.session);
    if (!loaded?.version) throw new Error('Could not identify the loaded tracker version');
    const { fetchUpdateStatus } = await import(pathToFileURL(path.join(loaded.dir, 'bg-components', 'update-check.js')).href);
    const status = await fetchUpdateStatus((url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) }), loaded.version, 'other');
    if (!status.updateAvailable) throw new Error('The tracker is already up to date');
    if (status.latestVersion !== payload?.version) throw new Error('The release changed. Check for updates again.');
    if (!status.extension) throw new Error(status.packageError);
    const { url, sha256, size } = status.extension;

    fs.mkdirSync(updater.tempDir(ROOT), { recursive: true });
    staging = fs.mkdtempSync(path.join(updater.tempDir(ROOT), 'download-'));
    const zipPath = path.join(staging, 'update.zip');
    emit({ phase: 'downloading', percent: 0 });
    await updater.downloadToFile(url, zipPath, {
      expectedSize: size,
      allowedHosts: ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'],
      onProgress: ({ percent }) => emit({ phase: 'downloading', percent: percent ?? 0 })
    });

    await updater.applyUpdateZip({ zipPath, sha256, root: ROOT, version: status.latestVersion, onProgress: emit });
    try { fs.rmSync(staging, { recursive: true, force: true }); staging = null; } catch {}
    for (let secondsLeft = 3; secondsLeft > 0; secondsLeft--) {
      emit({ phase: 'restarting', percent: 100, secondsLeft });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    app.relaunch();
    app.exit(0);
  } catch (error) {
    console.error('[CCU] Update failed:', error);
    emit({ phase: 'error', message: error?.message || String(error) });
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
    }
    activeUpdate = null;
  }
}

function setupPolyfills() {
  if (polyfillsReady || !mainWindow || !claudeWebContents) return;
  polyfillsReady = true;

  claudeWebContents.on('console-message', (event, level, message) => {
    const msg = typeof message === 'string'
      ? message
      : (typeof level === 'string' ? level : ((event && event.message) || ''));
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
            if (delay <= 0) {
              fireAlarm(data.name);
            } else {
              timerId = setTimeout(() => { fireAlarm(data.name); alarms.delete(data.name); }, delay);
            }
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
        showNotification(opts.title || 'Claude Count Usage', opts.message || opts.body || '');
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

app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (details, level, message) => {
    const text = details.message || (typeof message === 'string' ? message : '');
    if (text.startsWith('[CCU]') || text.startsWith('[UsageTracker]')) {
      console.log('[Renderer]', text);
    }
    if (!text.startsWith('CUT_UPDATE:') || !isClaudeUrl(contents.getURL())) return;
    if (details.frame && details.frame !== contents.mainFrame) return;
    try {
      handleUpdateRequest(JSON.parse(text.slice('CUT_UPDATE:'.length)), contents);
    } catch (error) {
      emitUpdateState({ phase: 'error', message: error.message }, contents);
    }
  });

  if (claudeWebContents) return;
  const check = (url) => {
    if (claudeWebContents) return;
    if (isClaudeUrl(url) || (url && url.includes('localhost'))) {
      claudeWebContents = contents;
      setupPolyfills();
      watchClaudeLoad(contents, url);
    }
  };
  contents.on('did-start-navigation', (details, url, _sameDocument, isMainFrame) => {
    if ((details.isMainFrame ?? isMainFrame) !== false) check(details.url || url);
  });
  contents.once('dom-ready', () => check(contents.getURL()));
});

// Logs the claude.ai view's load milestones: the gap between "window created" and
// "claude.ai loaded" is the black screen the user sees.
function watchClaudeLoad(contents, firstUrl) {
  const short = (u) => String(u || '').split('?')[0].slice(0, 80);
  startupLog('claude.ai navigation', short(firstUrl));
  contents.once('dom-ready', () => startupLog('claude.ai dom-ready', short(contents.getURL())));
  contents.once('did-finish-load', () => {
    startupLog('claude.ai loaded', short(contents.getURL()));
    try {
      const procs = app.getAppMetrics().map((m) => m.type + '@+' + Math.max(0, Math.round(m.creationTime - startupT0)) + 'ms');
      startupLog('processes', procs.join(' '));
    } catch {}
  });
  contents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (isMainFrame) startupLog('claude.ai load failed', code + ' ' + desc + ' ' + short(url));
  });
}

app.whenReady().then(loadExtensionEverywhere);

// A Claude update replaces this patched app with the official one, so the tracker is gone after the
// restart that installs it. Say so once, so a missing usage bar isn't a mystery.
try {
  const { autoUpdater } = require('electron');
  autoUpdater.once('update-downloaded', () => {
    showNotification(
      'Claude Count Usage',
      'Claude will update the next time it restarts. Run the Claude Count Usage installer again afterwards to bring back usage tracking.'
    );
  });
} catch {}
