# Chrome Web Store listing

Copy these into the developer dashboard. Images are in this folder.

## Store listing tab

**Name** (from manifest): Claude Count Usage

**Summary** (from manifest, max 132 chars):
See your Claude.ai session (5h) and weekly usage in the sidebar, plus token, cost and cache stats per chat. Runs locally.

**Category:** Productivity → Tools

**Language:** English

**Description:**

```
Claude Count Usage shows how much of your Claude.ai usage you have left, right inside claude.ai.

• Sidebar usage bars – your Session (5h) and Weekly usage with progress bars and reset timers
• Chat stats – conversation length in tokens, the cost of the next message, and how long the prompt cache stays warm
• Blue / orange / red colors at 70% and 90% so you notice before you hit a limit
• Optional notification when your usage resets
• Refreshes quietly in the background every 2 minutes while claude.ai is open

Private by design
• Everything runs in your browser. No analytics, no telemetry, no external servers.
• Message text is tokenized locally and never stored or sent – only a token count is kept.
• Only works on claude.ai.

Open source (MIT): https://github.com/abdullah-alhar/claude-count-usage

This is an unofficial, community-made extension. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic.
```

**Graphic assets**
- Store icon (128×128): `icons/icon128.png`
- Screenshot (1280×800): `store/screenshot-1280x800.png` – add 1–4 more real screenshots of claude.ai with the bars visible if you can
- Small promo tile (440×280): `store/promo-tile-440x280.png`

**Official URL / Homepage:** https://github.com/abdullah-alhar/claude-count-usage
**Support URL:** https://github.com/abdullah-alhar/claude-count-usage/issues

## Privacy practices tab

**Single purpose:**
Shows the user's Claude.ai usage limits (session and weekly) and per-conversation token, cost and cache information inside the claude.ai page.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Stores usage percentages, token counts and the user's display preferences locally so the bars show immediately on page load. |
| `alarms` | Refreshes usage every 2 minutes while claude.ai is open and schedules the optional "usage reset" notification at the reset time. |
| `notifications` | Shows the optional notification when the user's session or weekly usage resets. |
| Host permission `https://claude.ai/*` | The extension only runs on claude.ai: it reads the usage and conversation data claude.ai already loads, and draws the usage bars into the page. |

**Remote code:** No, I am not using remote code. (All JavaScript, including the tokenizer, is bundled in the package.)

**Data usage** – check:
- *Website content* – conversation text is read in the page to count tokens. It is processed locally and never stored or transmitted.

Leave every other category unchecked, then certify:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/abdullah-alhar/claude-count-usage/blob/main/PRIVACY.md

## Distribution tab

**Visibility:** Public · **Regions:** All regions · **Pricing:** Free
