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
const { app, session, Notification, webContents } = require('electron');
const updater = require('./ccu-update.js');

require('events').EventEmitter.defaultMaxListeners = 100;

const MARKER = '// __CLAUDE_COUNT_USAGE_WRAPPER__';
const ROOT = updater.ccuRoot();
const USER_EXTENSION_DIR = updater.extensionDir(ROOT);
const PREVIOUS_EXTENSION_DIR = path.join(ROOT, 'extension.old');
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

async function loadExtensionFrom(dir, sess) {
  const loader = sess.extensions && typeof sess.extensions.loadExtension === 'function' ? sess.extensions : sess;
  await loader.loadExtension(dir, { allowFileAccess: true });
}

async function loadIntoSession(sess) {
  if (!sess || loadedSessions.has(sess)) return;
  loadedSessions.add(sess);
  const started = Date.now();

  const preferred = firstExistingDir([USER_EXTENSION_DIR, BUNDLED_EXTENSION_DIR]);
  if (!preferred) {
    console.log('[CCU] No tracker extension found; run the installer again.');
    startupLog('extension missing');
    return;
  }

  try {
    await loadExtensionFrom(preferred, sess);
    console.log('[CCU] Extension loaded from', preferred);
    startupLog('extension loaded', 'in ' + (Date.now() - started) + 'ms');
    if (preferred === USER_EXTENSION_DIR) updater.writeState(ROOT, { pendingRestart: false, runningVersion: updater.readState(ROOT).version || null });
    return;
  } catch (err) {
    console.error('[CCU] Failed to load tracker from', preferred, err);
    startupLog('extension load failed', String(err && err.message || err));
  }

  // A half-installed update should never leave the user without the tracker.
  if (preferred === USER_EXTENSION_DIR && firstExistingDir([PREVIOUS_EXTENSION_DIR])) {
    try {
      await loadExtensionFrom(PREVIOUS_EXTENSION_DIR, sess);
      console.log('[CCU] Rolled back to the previous tracker version');
      startupLog('extension rollback');
      updater.writeState(ROOT, { rollbackFrom: updater.readState(ROOT).version || null, version: updater.readState(ROOT).previousVersion || null });
      return;
    } catch (err) {
      console.error('[CCU] Rollback failed:', err);
    }
  }

  if (preferred !== BUNDLED_EXTENSION_DIR) {
    try {
      await loadExtensionFrom(BUNDLED_EXTENSION_DIR, sess);
      startupLog('extension bundled fallback');
    } catch (err) {
      console.error('[CCU] Bundled fallback failed:', err);
    }
  }
}

async function loadExtensionEverywhere() {
  if (!firstExistingDir([USER_EXTENSION_DIR, BUNDLED_EXTENSION_DIR])) {
    console.log('[CCU] No extension folder found; skipping load');
    return;
  }
  await loadIntoSession(session.defaultSession);
  const followClaude = (wc) => {
    if (isClaudeUrl(wc.getURL())) loadIntoSession(wc.session);
    wc.on('did-start-navigation', (ev, url) => {
      if (isClaudeUrl(typeof url === 'string' ? url : ev && ev.url)) loadIntoSession(wc.session);
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
  if (!target) return;
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
let updateInProgress = false;

async function handleUpdateRequest(payload, target = claudeWebContents) {
  if (updateInProgress) return;
  updateInProgress = true;

  const url = payload && payload.url;
  const sha256 = payload && payload.sha256;
  const version = (payload && payload.version) || null;
  const emit = (state) => emitUpdateState(state, target);

  try {
    if (!url || !/^https:\/\//i.test(url)) throw new Error('Update URL is missing or not HTTPS');
    if (!sha256) throw new Error('Update checksum is missing');

    fs.mkdirSync(updater.tempDir(ROOT), { recursive: true });
    const zipPath = path.join(updater.tempDir(ROOT), 'update-' + Date.now() + '.zip');

    emit({ phase: 'downloading', percent: 0, version });
    await updater.downloadToFile(url, zipPath, {
      onProgress: ({ percent }) => emit({ phase: 'downloading', percent: percent ?? 0, version })
    });

    emit({ phase: 'verifying', percent: 80, version });
    const actual = await updater.sha256File(zipPath);
    if (updater.normalizeSha(actual) !== updater.normalizeSha(sha256)) {
      throw new Error('Downloaded update failed its checksum check');
    }

    emit({ phase: 'installing', percent: 90, version });
    await updater.applyUpdateZip({ zipPath, sha256, root: ROOT, onProgress: (state) => emit({ ...state, version }) });
    try { fs.unlinkSync(zipPath); } catch {}

    updater.clearServiceWorkerCache();
    updater.writeState(ROOT, { pendingRestart: true, version });

    // Give the card a moment to show the countdown before the window disappears.
    for (let secondsLeft = 3; secondsLeft > 0; secondsLeft--) {
      emit({ phase: 'restarting', percent: 100, secondsLeft, version });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    app.relaunch();
    app.exit(0);
  } catch (error) {
    console.error('[CCU] Update failed:', error);
    updateInProgress = false;
    emit({ phase: 'error', message: (error && error.message) || String(error), version });
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

    if (msg.startsWith('CUT_UPDATE:')) {
      try {
        const payload = JSON.parse(msg.substring(11));
        handleUpdateRequest(payload, (event && event.sender) || claudeWebContents);
      } catch (e) {
        console.error('[CCU] Update request error:', e);
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
  // Relay only the tracker's own lines. Matching anything containing "Error" echoed most of
  // claude.ai's console into the main process during startup.
  contents.on('console-message', (ev, level, message) => {
    const text = typeof message === 'string' ? message : (typeof level === 'string' ? level : ((ev && ev.message) || ''));
    if (text.startsWith('[CCU]') || text.startsWith('[UsageTracker]')) {
      console.log('[Renderer]', text);
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
  contents.on('did-start-navigation', (_ev, url) => check(url || ''));
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
