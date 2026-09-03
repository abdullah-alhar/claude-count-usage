# Claude Count Usage

**Created by Abdullah Alhar**

A minimal Claude.ai browser/desktop extension that shows **only the 2 most useful UI elements** — no noise, no promotions, no donate buttons.

---

## What It Shows

### 1. Sidebar Usage Bars
Session (5h) and Weekly token usage with live progress bars and reset timers — injected directly into the Claude sidebar.

```
Usage                    ⚙
Session (5h):  2%   ⏱ 4h 53m
[████░░░░░░░░░░░░░░░░░]
Weekly:        23%  ⏱ 23h 33m
[████████░░░░░░░░░░░░░]
```

### 2. Top-Bar Token Stats
Injected **below** the chat heading (the heading itself is unchanged):

```
Length*: 33,868 tokens  |  Cost: 210 credits  |  Cached for: 60m
```

---

## Download & Installation

### Mac — Claude Desktop App

**Zero extra launchers required.** Directly patches official Claude Desktop.

1. Download or clone this repository (or simply download **[`install.command`](install.command)**).
2. Double-click **`install.command`** in Finder.
   - *If Mac asks "Are you sure?" → click **Open**.*
   - *If Claude Desktop is not installed, the installer automatically downloads and installs it directly from Anthropic's CDN.*
   - *Works standalone: even if you only download `install.command`, it automatically fetches the extension from GitHub.*
3. Claude Desktop restarts automatically with usage tracking active!

**To uninstall:** double-click **`uninstall.command`** (restores original Claude Desktop bundle).

---

### Windows — Claude Desktop App

**Zero extra launchers required.** Directly patches Claude Desktop.

1. Ensure **[Node.js](https://nodejs.org)** is installed.
2. Double-click **`install.bat`**.
   - *If Claude Desktop is not installed, the installer automatically fetches the official package from Anthropic.*
   - *Works standalone: even if you only download `install.bat`, it automatically fetches the extension from GitHub.*
3. Claude Desktop restarts with usage tracking active!

**To uninstall:** double-click **`uninstall.bat`** (restores original Claude Desktop).

---

### Browser (Chrome / Edge / Brave)

1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** → select the `claude-count-usage` folder
4. Go to [claude.ai](https://claude.ai)

---

## Features

| Feature | Status |
|---|---|
| Session (5h) usage bar |
| Weekly usage bar |
| Top-bar token / cost / cache stats |

---

## How It Works

The extension intercepts Claude's own API traffic locally — no external servers involved.

```
Claude API
    │
    ▼
injections/sse-watcher.js        ← Patches window.fetch (MAIN world)
    │  Reads SSE stream events from /completion endpoint
    │  Emits postMessage to content script
    ▼
content-components/*.js          ← Content scripts injected into claude.ai
    │  Tokenizes reply locally with o200k (text never stored or sent)
    │  Reports token count to background
    ▼
background.js                    ← Service worker
    │  Fetches /usage for session/weekly percentages
    │  Stores data locally (chrome.storage.local)
    │  Pushes updates to all open claude.ai tabs
    ▼
UI injected into the page
    • Sidebar: Session % + Weekly % progress bars
    • Top bar: Tokens | Credits | Cache time
```

---



## Privacy

**No data ever leaves your device.**

- Message text is **never** stored or sent — only the token count (an integer)
- All tokenization runs locally using the o200k tokenizer
- No analytics, no telemetry, no third-party requests

→ Full details: [PRIVACY.md](PRIVACY.md)

---

