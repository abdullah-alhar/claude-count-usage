# Claude Count Usage


**Claude Count Usage** is a minimal, open-source **Claude usage tracker** — a patch for the Claude Desktop app that surfaces the two stats people actually want to see: how much of your session and weekly usage you've used, and what the current reply cost. No promos, no donate buttons, no bloat.

Created by [Abdullah Alhar](https://github.com/abdullah-alhar).

![Claude Count Usage demo](assets/demo.gif)

---

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Features](#features)
- [How it works](#how-it-works)
- [Privacy](#privacy)
- [License](#license)

---

## What it does

**Sidebar usage bars** — Session (5h) and weekly token usage, with live progress bars and reset timers, injected directly into Claude's sidebar.

```
Usage                    ⚙
Session (5h):  2%   ⏱ 4h 53m
[████░░░░░░░░░░░░░░░░░]
Weekly:        23%  ⏱ 23h 33m
[████████░░░░░░░░░░░░░]
```

**Top-bar token stats** — appended below the existing chat heading (the heading itself isn't touched):

```
Length*: 33,868 tokens  |  Cost: 210 credits  |  Cached for: 60m
```

---

## Installation

### Claude Desktop (Mac)

Install [Node.js](https://nodejs.org) if needed, then paste this into Terminal:

```bash
/bin/bash -c 'f=$(mktemp "${TMPDIR:-/tmp}/ccu-install.XXXXXX") || exit; cleanup() { rm -f -- "$f"; }; trap cleanup EXIT; curl -fsSL https://raw.githubusercontent.com/abdullah-alhar/claude-count-usage/main/install.command -o "$f" && /bin/bash "$f"'
```

The installer fetches the extension from GitHub and restarts Claude Desktop after installation.

For an existing Claude Desktop installation, the release ZIP also includes a graphical **Install.app**.

To remove it, double-click **Uninstall.app** or run **`uninstall.command`**. This performs a full, clean uninstall of Claude Desktop rather than trying to patch it back — reinstall fresh from [claude.ai/download](https://claude.ai/download) afterward if you want to keep using Claude without the tracker.

### Claude Desktop (Windows)

Install [Node.js](https://nodejs.org) if needed, then paste this into PowerShell:

```powershell
& { $f = Join-Path $env:TEMP ('ccu-install-' + [guid]::NewGuid() + '.bat'); try { Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -Uri 'https://raw.githubusercontent.com/abdullah-alhar/claude-count-usage/main/install.bat' -OutFile $f; & $f } finally { Remove-Item -LiteralPath $f -ErrorAction SilentlyContinue } }
```

The installer fetches the extension from GitHub and restarts Claude Desktop after installation.

For an existing Claude Desktop installation, extract the release ZIP and open its graphical **Install.exe**.

To remove it, run **`uninstall.bat`** — this fully uninstalls Claude Desktop rather than trying to patch it back; grab a fresh copy from [claude.ai/download](https://claude.ai/download) afterward if you want to keep using it.

*(Optional)* Run **`create-shortcuts.bat`** once afterward to generate desktop shortcuts with proper custom icons instead of the default script icon.

### Updating

The tracker checks for releases every 12 hours. To check sooner, open **Settings → Updates → Check for updates now**. **Update now** shows download and installation progress in Claude, verifies the package against GitHub’s release metadata, and restarts Claude. If the update fails, settings shows the reason and offers a retry. **Download installer manually** opens the separate installer download.

The tracker lives in your own user folder (`~/Library/Application Support/ClaudeCountUsage` on macOS, `%APPDATA%\ClaudeCountUsage` on Windows), so updates never touch the signed Claude.app bundle and never ask for an admin password.

The desktop manifests for 1.0.0, 1.2, 1.3, 1.4, 1.5 through 1.5.4, and 1.6.0 predate the in-app update bridge. For those versions, download the matching installer ZIP from the [latest release](https://github.com/abdullah-alhar/claude-count-usage/releases/latest), extract it, and open **Install.app** on macOS or **Install.exe** on Windows. The graphical installer requires Node.js and reopens Claude when setup finishes.

Versions 1.7.0 and 1.7.1 have the bridge. Try **Check for updates now** in settings. If those builds show only a download link, the same graphical installer can upgrade the installed tracker to a version that reads the checksum directly from GitHub’s release API.

**When Claude Desktop itself updates**, the update replaces the patched app with the official one, so the usage bars disappear after the restart that installs it. Run the installer again to bring them back. The tracker shows a notification when a Claude update has been downloaded.

**Claude closing by itself in the middle of a task (Mac, v1.4)?** Older installers removed Claude's updater helper (ShipIt). From v1.4 on, Claude got far enough into installing its own update to need that helper, and crashed instead. Since v1.5 the helper is left in place. If yours was already removed, the installer reinstalls the latest official Claude Desktop once to restore it; your chats and settings are kept.

**Black screen for 30+ seconds when opening Claude (Mac)?** macOS is asking whether Claude may use **"Claude Safe Storage"** in your keychain, and the prompt is often hidden behind Claude's window. Find the prompt, enter your Mac password and click **Always Allow**. Since v1.4 this is needed once; earlier versions asked again after every install.

**Slow start or black screen on Windows?** Since v1.4 every launch writes a timing log to `%LOCALAPPDATA%\Claude\logs\ccu-startup.log` (if it isn't there, check `%APPDATA%\Claude\logs`). Please attach that file and `main.log` from the same folder when you report it. The log shows where the time went: before the app started at all, before the window opened, or while claude.ai loaded. Note that patching changes `claude.exe`, so it is no longer signed by Anthropic, and antivirus software may scan it more thoroughly than the official build.

---

## Building an update

`scripts/build-package.js` builds `ccu-extension.zip`, `scripts/build-migration-installers.sh` builds the two graphical installer ZIPs, and `scripts/make-manifest.js` writes `latest.json` for existing updaters. Run the Release workflow manually to stage a draft. Pushing a matching `v*` tag publishes after the workflow verifies the local package and the digests GitHub reports for the uploaded assets.

## Features

| Feature | Status |
|---|---|
| Session (5h) usage bar | ✅ |
| Weekly usage bar | ✅ |
| Top-bar token / cost / cache stats | ✅ |
| Blue / orange / red severity colors (70% / 90%) | ✅ |
| Background refresh while idle (every 2 min) | ✅ |
| Update check against GitHub releases | ✅ |

---

## How it works

The tracker reads Claude's own API traffic locally — your usage data is never sent to an external server.

```
Claude API
    │
    ▼
injections/sse-watcher.js        Patches window.fetch (MAIN world),
                                  reads SSE events from the /completion endpoint
    │
    ▼
content-components/*.js          Injected into claude.ai, tokenizes replies
                                  locally with o200k (message text never leaves the page)
    │
    ▼
background.js                    Service worker — fetches /usage for session/weekly
                                  percentages, caches locally, pushes updates to open tabs
    │
    ▼
UI injected into the page        Sidebar bars + top-bar stats
```

On Claude Desktop, there's no plugin API to hook into, so the installer patches the app directly: it unpacks Electron's `app.asar`, injects the same tracker code, repacks it, fixes the macOS integrity hash, and re-signs the app so Gatekeeper doesn't block it.

---

## Privacy

None of your usage or conversation data leaves your device.

- Message text is never stored or transmitted — only a token count (an integer) is computed
- Tokenization happens locally using the o200k tokenizer
- No analytics, no telemetry
- The only request outside claude.ai is the optional update check to GitHub's public releases API

See [PRIVACY.md](PRIVACY.md) for full details.

---

## License

MIT © 2026 [Abdullah Alhar](https://github.com/abdullah-alhar) — see [LICENSE](LICENSE) for details.

Found a bug or have an idea? [Open an issue](https://github.com/abdullah-alhar/claude-count-usage/issues) — contributions welcome.
