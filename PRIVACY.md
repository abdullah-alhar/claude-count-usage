# Privacy Policy — Claude Count Usage

**Author: Abdullah Alhar**
**Version: 1.3**

---

## What This Extension Does

Claude Count Usage tracks how much of your Claude.ai token quota you have used. It shows two things only:

1. **Sidebar usage bars** — Session (5h window) and Weekly percentage with progress bars and reset timers
2. **Top-bar stats** — Conversation context length in tokens, credit cost of the next message, and cache expiry time

---

## What Data Is Collected

**Nothing is collected. None of your usage or conversation data ever leaves your device.**

All processing happens locally inside the Claude Desktop app. No analytics service is contacted. The only request made outside claude.ai is:

- **Update check (on by default, can be turned off):** a plain `GET https://api.github.com/repos/abdullah-alhar/claude-count-usage/releases/latest` every 12 hours, or when you click *Check for updates now*. Nothing is sent with it — no identifiers, no usage data, no cookies. GitHub sees an ordinary request from your IP address, as with any web page. Turn it off under **Settings → Updates**; the manual button still works.

| Data | What happens to it |
|---|---|
| Session / weekly usage % | Stored **locally** in the extension's local storage only. Never sent anywhere. |
| Conversation token counts | Counted locally using the o200k tokenizer. Only the **number** is stored — never the text. |
| Your message text | Tokenized locally to compute size. **Immediately discarded** after counting — never stored, never sent. |
| Attached files | Only a boolean flag ("attachments present") is noted. File content is never read or stored. |
| Conversation text / AI replies | Read temporarily to count tokens. **Never stored, never sent.** |

---

## What the Extension Reads

The extension observes network requests **only** on `claude.ai` — the same requests the app already makes:

- `GET /api/organizations/*/usage` — reads your session and weekly usage percentages
- `POST /api/organizations/*/chat_conversations/*/completion` — reads the SSE stream to detect when a reply ends (no content is stored)
- `GET /api/organizations/*/chat_conversations/*` — reads conversation structure for accurate token counting

The extension **reads** these responses. It does **not** modify them, block them, or send them elsewhere.

---

## What This Extension Does NOT Do

- ✅ Does **not** send any usage or conversation data to external servers
- ✅ Does **not** use analytics, telemetry, or tracking of any kind
- ✅ Does **not** store message content, conversation text, or file content
- ✅ Does **not** contact any third-party service other than the GitHub update check described above
- ✅ Does **not** include any donation prompts, ads, or promotional code
- ✅ Does **not** require an account, login, or API key to function

---

## Permissions Explained

| Permission | Reason |
|---|---|
| `storage` | Save usage percentages and UI preferences locally on your device |
| `tabs` | Find the claude.ai page to send usage updates to |
| `scripting` | Pass timers and notifications to the Claude Desktop app (it has no native extension alarms) |
| Host: `claude.ai` | Read your usage and conversation structure |
| Host: `api.github.com` | The optional update check described above |

---

## Data Retention & Deletion

All data is stored only in the extension's local storage inside Claude Desktop. It is deleted when:

- You **uninstall** the extension
- Cache entries **expire** automatically:
  - Conversation data: 60 minutes
  - Usage percentages: refreshed every 2 minutes, when you return to the window, or on next message

---

## Contact

This extension is maintained by **Abdullah Alhar**.
For issues or questions, open an issue on the GitHub repository.
