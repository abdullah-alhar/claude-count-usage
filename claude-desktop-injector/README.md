# claude-desktop-injector

A from-scratch tool that (1) fetches the real Claude Desktop app straight
from Anthropic's own CDN, and (2) injects an unpacked extension folder into
it directly — no separate patched instance, no dependency on any
third-party launcher's code.

None of this reuses lugia19's Claude-WebExtension-Launcher or
Claude-Usage-Extension source. The techniques are generic:
`@electron/asar` is Electron's own official archiver (same tool Electron
itself uses to build every app.asar — not a patcher), and
`session.defaultSession.loadExtension()` is a documented, public Electron
API for loading any unpacked MV3 extension into any Electron app.

## Layout

```
claude-desktop-injector/
├── src/
│   ├── download.js      fetch latest Claude Desktop from downloads.claude.ai
│   ├── install.js        turn the download into a runnable Claude.app / portable folder
│   ├── locate.js          find an existing install
│   ├── patch-asar.js      the actual injection: unpack → wrap entry point → repack
│   ├── mac-sign.sh        re-sign the bundle after patching (macOS only)
│   ├── cli.js             ties it all together
│   └── watcher/
│       ├── watch.js                  detects an auto-update wiped the patch, reapplies it
│       ├── install-watcher-mac.js    registers a LaunchAgent to run watch.js periodically
│       └── install-watcher-win.js    registers a Scheduled Task (Windows equivalent)
└── your-extension/       <- put YOUR extension's electron build here (manifest.json + scripts)
```

## Usage

```bash
npm install

# Fresh machine: download Claude, install it, patch it
node src/cli.js install --extension /path/to/your/electron-build

# Already have Claude installed: just patch it
node src/cli.js patch --extension /path/to/your/electron-build

# Keep the patch alive across Claude's own auto-updates
node src/cli.js watch-install --extension /path/to/your/electron-build

# Undo everything (restores the original app.asar from the .bak copy)
node src/cli.js unpatch
```

`your-extension/` should be built the same way the `manifest_electron.json`
target in the usage-tracker source you pulled is built — an MV3 extension
folder with a background service worker + content scripts. If you're
pointing this at your own `claude-count-usage`, that's its electron build
output.

## What's actually verified vs. what isn't

I do not have a Mac or Windows machine or a real Claude Desktop install in
this sandbox, and `downloads.claude.ai` / `claude.ai` aren't reachable from
here either. So, honestly:

**Verified in this environment (real test run, see the tool calls above):**
- `patch-asar.js`'s core logic — unpack → wrap the real entry point →
  repack, idempotent re-patching, and `unpatch()` restoring from backup —
  all ran end-to-end against a fake `app.asar` fixture and behaved
  correctly (wrapper installed, original preserved as `main.original.js`,
  re-running `patch()` correctly no-ops, `unpatch()` restores cleanly and
  removes the injected extension folder).
- Every file passes `node -c` (no syntax errors).

**Not verified — needs testing on a real Mac/Windows machine:**
- `download.js`'s URLs. I confirmed these are real, current Anthropic CDN
  endpoints via search (a public Homebrew cask definition for `claude`
  live-checks against the exact mac feed/regex used here; the Windows
  redirect URL and its resulting `.msix` URL pattern show up in a public
  Claude Code GitHub issue log). They're undocumented, not an official API
  contract, so they can change without notice — if `install` fails at the
  download step, that's the first place to check.
- `mac-sign.sh` — ad-hoc codesign is standard and should work, but I can't
  verify it against a real Claude.app in this sandbox.
- The **Info.plist integrity hash** Claude Desktop itself seems to check
  on top of the OS-level code signature (per the "ASAR hash is now fetched
  from the header of our patched asar" launcher release note you saw
  earlier). I don't know the exact field or algorithm Anthropic uses here
  — it's undocumented and I have no way to inspect a real Info.plist from
  this sandbox. `mac-sign.sh` has a clearly marked TODO with two concrete
  ways to reverse it (Console.app crash log, or diffing Info.plist across
  an auto-update) — you'd already partly solved this once per your notes,
  so it's worth comparing against what you found before.
- Windows: `installWindowsPortable()` deliberately avoids touching the
  OS-protected `WindowsApps` folder — you'd need `takeown`/`icacls` and
  admin elevation to patch the real MSIX install in place (this is exactly
  why the original launcher needs admin on Windows, and why it breaks
  Cowork's signature check). Extracting to a portable copy sidesteps that,
  at the cost of it not being the "real" Start-Menu-registered install.

## Known gaps to close next

1. Fill in the Info.plist hash fix in `mac-sign.sh`.
2. Decide whether you want the Windows path to patch the real (protected)
   install with elevation, or keep the portable extraction — they have
   different tradeoffs (Cowork breaks either way per lugia19's notes, but
   for different reasons).
3. Point `your-extension/` at your actual `claude-count-usage` electron
   build and confirm `session.loadExtension()` picks up its background
   script / content scripts the way `manifest_electron.json` expects.
