# Publishing to the Chrome Web Store

`manifest.json` is the Chrome build. Claude Desktop uses `manifest_electron.json`, which the
installers copy over `manifest.json`, so changes here do not affect the Desktop patch.

## 1. Build the package

```bash
npm test
npm run package:chrome   # -> dist/claude-count-usage-chrome-<version>.zip
```

To try it first: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the
repo folder (or the unzipped package), then open claude.ai.

## 2. First submission (by hand, once)

1. Register at https://chrome.google.com/webstore/devconsole (one-time US$5 fee) and verify your
   contact email.
2. **New item** → upload the zip from `dist/`.
3. Fill in the **Store listing**, **Privacy practices** and **Distribution** tabs using
   [LISTING.md](LISTING.md).
4. **Submit for review.** Review usually takes from a few days to a couple of weeks.
5. Copy the 32-letter **item ID** from the dashboard URL – you need it below.

## 3. Automatic updates from GitHub (optional)

`.github/workflows/chrome-web-store.yml` tests, packages and uploads the extension whenever a
GitHub release is published (or by hand from the Actions tab). Set it up once:

1. In Google Cloud Console create a project, enable the **Chrome Web Store API**, configure the
   OAuth consent screen (External, add yourself as a test user) and create an **OAuth client ID**
   of type *Desktop app*.
2. Get a refresh token. Open this URL in a browser (replace `CLIENT_ID`) and approve:
   ```
   https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https://www.googleapis.com/auth/chromewebstore&access_type=offline&prompt=consent&redirect_uri=http://localhost&client_id=CLIENT_ID
   ```
   The browser then goes to `http://localhost/?code=...` (the page will not load – that's fine).
   Copy the `code` value and exchange it:
   ```bash
   curl https://oauth2.googleapis.com/token -d client_id=CLIENT_ID -d client_secret=CLIENT_SECRET \
     -d code=CODE -d grant_type=authorization_code -d redirect_uri=http://localhost
   ```
   Keep the `refresh_token` from the response.
3. In GitHub → **Settings → Secrets and variables → Actions**, add `CWS_EXTENSION_ID`,
   `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET` and `CWS_REFRESH_TOKEN`.

Every upload needs a higher `version` in `manifest.json` than the one in the store. Bump it
(together with `manifest_electron.json` and `package.json`), commit, and publish a release.
