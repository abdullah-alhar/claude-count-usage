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

### Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `claude-count-usage` folder
5. Go to [claude.ai](https://claude.ai) — the sidebar bars and top stats appear automatically

### Firefox

1. Open `about:addons` → click the ⚙ gear → **Debug Add-ons**
2. Click **Load Temporary Add-on**
3. Select the `manifest.json` file inside `claude-count-usage`

---

### Mac Claude Desktop App

The Claude Mac app runs on **Electron (Chromium)** — extensions are sideloaded via a patcher tool.

> **Patcher tool download link** — *(add your patcher release link here)*

**Steps:**
1. Download the patcher for **macOS**
2. Run it and point it to the `claude-count-usage` folder
   - It automatically uses `manifest_electron.json`
3. Restart the Claude desktop app
4. Usage bars appear in the sidebar 

---

### Windows Claude Desktop App

Same Electron engine as Mac — works identically.

> **Patcher tool download link** — *(add your patcher release link here)*

**Steps:**
1. Download the patcher for **Windows**
2. Run it and point it to the `claude-count-usage` folder
3. Restart the Claude desktop app
4. Usage bars appear in the sidebar 

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

## Features

| Feature | Status |
|---|---|
| Session (5h) usage bar |
| Weekly usage bar |
| Top-bar token / cost / cache stats |


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
