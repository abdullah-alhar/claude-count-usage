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

## Download / Releases

👉 **[Download the latest release](https://github.com/abdullahalhar/claude-count-usage/releases/latest)**

> Drop the release link here once you publish it on GitHub.

---

## Installation

### Mac — Claude Desktop App

**Requires:** The Claude Desktop Launcher *(by Abdullah Alhar)* — download from the [Releases page](https://github.com/abdullahalhar/claude-count-usage/releases) and run it once first.

1. Open Finder → go to the `claude-count-usage` folder
2. Double-click **`install.command`**
3. If Mac asks *"Are you sure?"* → click **Open**
4. Terminal opens and runs automatically — Claude restarts when done

**To uninstall:** double-click `uninstall.command`

---

### Windows — Claude Desktop App

**Requires:** Node.js ([nodejs.org](https://nodejs.org)) + the Claude Desktop Launcher *(by Abdullah Alhar)* — download from the [Releases page](https://github.com/abdullahalhar/claude-count-usage/releases) and run it once first.

1. Open the `claude-count-usage` folder
2. Double-click **`install.bat`**
3. Follow the prompts — Claude restarts when done

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
