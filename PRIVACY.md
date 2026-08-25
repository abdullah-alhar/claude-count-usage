# Privacy Policy — Claude Count Usage

**Author: Abdullah Alhar**
**Version: 1.0.0**

---

## What This Extension Does

Claude Count Usage tracks how much of your Claude.ai token quota you have used. It shows two things only:

1. **Sidebar usage bars** — Session (5h window) and Weekly percentage with progress bars and reset timers
2. **Top-bar stats** — Conversation context length in tokens, credit cost of the next message, and cache expiry time

---

## What Data Is Collected

**Nothing is collected. No data ever leaves your device.**

All processing happens locally inside your browser or the Claude desktop app. No external server, API, or analytics service is contacted.

| Data | What happens to it |
|---|---|
| Session / weekly usage % | Stored **locally** in `chrome.storage.local` only. Never sent anywhere. |
| Conversation token counts | Counted locally using the o200k tokenizer. Only the **number** is stored — never the text. |
| Your message text | Tokenized locally to compute size. **Immediately discarded** after counting — never stored, never sent. |
| Attached files | Only a boolean flag ("attachments present") is noted. File content is never read or stored. |
| Conversation text / AI replies | Read temporarily to count tokens. **Never stored, never sent.** |

---

## What the Extension Reads

The extension intercepts network requests **only** on `claude.ai` — the same requests your browser already makes:

- `GET /api/organizations/*/usage` — reads your session and weekly usage percentages
- `POST /api/organizations/*/chat_conversations/*/completion` — reads the SSE stream to detect when a reply ends (no content is stored)
- `GET /api/organizations/*/chat_conversations/*` — reads conversation structure for accurate token counting

The extension **reads** these responses. It does **not** modify them, block them, or send them elsewhere.

---

## What This Extension Does NOT Do

- ✅ Does **not** send any data to external servers
- ✅ Does **not** use analytics, telemetry, or tracking of any kind
- ✅ Does **not** store message content, conversation text, or file content
- ✅ Does **not** contact any third-party service (ko-fi, Google Analytics, etc.)
- ✅ Does **not** include any donation prompts, ads, or promotional code
- ✅ Does **not** require an account, login, or API key to function

---

## Permissions Explained

| Permission | Reason |
|---|---|
| `storage` | Save usage percentages and UI preferences locally on your device |
| `webRequest` | Intercept Claude's own API responses to read usage data |
| `tabs` | Know which tab is active to associate usage with the correct account |
| `alarms` | Refresh usage data periodically (every 3 minutes) |
| `cookies` | Read Claude session cookies for per-organisation identification |
| `contextMenus` | Add an "Open Debug Page" option to the extension icon right-click menu |

---

## Data Retention & Deletion

All data is stored only in your local browser profile (`chrome.storage.local`). It is deleted when:

- You **uninstall** the extension
- You **clear** browser storage or cookies for claude.ai
- Cache entries **expire** automatically:
  - Conversation data: 60 minutes
  - Usage percentages: refreshed every 3 minutes or on next message

---

## Contact

This extension is maintained by **Abdullah Alhar**.
For issues or questions, open an issue on the GitHub repository.
