# Claude Count Usage

A minimal browser extension and desktop patch for Claude.ai that surfaces the two stats people actually want to see: how much of your session and weekly usage you've used, and what the current reply cost. No promos, no donate buttons, no bloat.

Created by Abdullah Alhar.

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

No extra launcher needed — this patches the official Claude Desktop app directly.

1. Install [Node.js](https://nodejs.org) if you don't have it.
2. Download this repo, or grab [`Install.app`](Install.app).
3. Double-click **`Install.app`** or **`install.command`**.
   - If macOS shows a security prompt, click **Open**.
   - If Claude Desktop isn't installed yet, the installer downloads it from Anthropic's CDN first.
   - Works standalone — pulls the rest of the extension from GitHub automatically.
4. Claude Desktop restarts with usage tracking already active.

To remove it, double-click **`Uninstall.app`** or `uninstall.command`.

### Claude Desktop (Windows)

1. Install [Node.js](https://nodejs.org).
2. Double-click **[`Install.exe`](Install.exe)** .
   - If Claude Desktop isn't found, it's installed automatically.
   - Works standalone and fetches the rest from GitHub if run alone.
3. Claude Desktop restarts with usage tracking active.

To remove it, run **`Uninstall.exe`** or `uninstall.bat`.

---

## Features

| Feature | Status |
|---|---|
| Session (5h) usage bar | ✅ |
| Weekly usage bar | ✅ |
| Top-bar token / cost / cache stats | ✅ |

---

## How it works

The extension reads Claude's own API traffic locally — nothing is sent to an external server.

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

---

## Privacy

No data leaves your device.

- Message text is never stored or transmitted — only a token count (an integer) is computed
- Tokenization happens locally using the o200k tokenizer
- No analytics, no telemetry, no third-party requests

See [PRIVACY.md](PRIVACY.md) for full details.
