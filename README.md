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

### 🍎 Mac — Claude Desktop App

**Requires:** The Claude Desktop Launcher *(by Abdullah Alhar)*
👉 **[Download Mac Launcher](https://github.com/abdullah-alhar/claude-count-usage/releases/tag/Mac)**

1. Install and run the launcher at least once.
2. Open Finder → go to the `claude-count-usage` folder.
3. Double-click **`install.command`**.
4. If Mac asks *"Are you sure?"* → click **Open**.
5. Terminal will open and run automatically — Claude restarts when done.

**To uninstall:** double-click `uninstall.command`

---

### 🪟 Windows — Claude Desktop App

**Requires:** The Claude Desktop Launcher *(by Abdullah Alhar)* + [Node.js](https://nodejs.org)
👉 **[Download Windows Launcher](https://github.com/abdullah-alhar/claude-count-usage/releases/tag/windows)**

1. Install and run the launcher at least once.
2. Open the `claude-count-usage` folder.
3. Double-click **`install.bat`**.
4. Follow the prompts — Claude restarts when done.

**To uninstall:** double-click `uninstall.bat`

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

## License

MIT — see [LICENSE](LICENSE) if included.
