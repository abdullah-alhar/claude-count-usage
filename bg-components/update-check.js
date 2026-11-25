// Update checking against this repo's GitHub releases. Contacts exactly one URL (below) and sends
// nothing but a plain GET - see PRIVACY.md.
//
// The release carries a `latest.json` asset describing the update package (extension zip + SHA-256)
// and the per-platform installers. When it is present the settings card can update in place; when
// it is missing (older releases) the card falls back to linking the installer download.

export const RELEASES_API_URL = 'https://api.github.com/repos/abdullah-alhar/claude-count-usage/releases/latest';
export const MANIFEST_ASSET_NAME = 'latest.json';
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_STATUS_KEY = 'updateCheckStatus';
export const AUTO_UPDATE_CHECK_KEY = 'autoUpdateCheck';

function versionParts(version) {
	return String(version || '')
		.trim()
		.replace(/^v/i, '')
		.split(/[.+-]/)
		.map(part => parseInt(part, 10))
		.filter(n => Number.isFinite(n));
}

// Returns >0 if a is newer than b, <0 if older, 0 if equal. Missing segments count as 0, so
// "1.3" equals "1.3.0". Anything without a leading number is treated as 0.0.0.
export function compareVersions(a, b) {
	const pa = versionParts(a);
	const pb = versionParts(b);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] || 0) - (pb[i] || 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

// The installers are per-platform zips (see README). Pick the one for this OS, else fall back to
// the release page, which lists both.
export function pickDownloadUrl(release, platform) {
	const assets = Array.isArray(release?.assets) ? release.assets : [];
	const pattern = platform === 'mac' ? /mac|darwin|osx/i : platform === 'windows' ? /win/i : null;
	const asset = pattern && assets.find(a => pattern.test(a?.name || '') && a.browser_download_url);
	return asset?.browser_download_url || release?.html_url || null;
}

export function detectPlatform(userAgent) {
	if (/Mac/i.test(userAgent || '')) return 'mac';
	if (/Win/i.test(userAgent || '')) return 'windows';
	return 'other';
}

// ─── Release manifest ───────────────────────────────────────
//
// {
//   "version": "1.7.0",
//   "notes": "…",
//   "extension": { "url": "https://github.com/…/ccu-extension.zip", "sha256": "…", "size": 123 },
//   "installers": { "mac": { "url": "…" }, "windows": { "url": "…" } }
// }

function isHttpsUrl(value) {
	try { return new URL(value).protocol === 'https:'; } catch (e) { return false; }
}

function normalizeAsset(asset) {
	if (!asset || typeof asset !== 'object') return null;
	if (!isHttpsUrl(asset.url)) return null;
	const sha256 = typeof asset.sha256 === 'string' ? asset.sha256.trim().toLowerCase() : '';
	if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
	return {
		url: asset.url,
		sha256,
		size: Number.isFinite(asset.size) ? asset.size : null
	};
}

export function findManifestAsset(release) {
	const assets = Array.isArray(release?.assets) ? release.assets : [];
	return assets.find(asset => (asset?.name || '').toLowerCase() === MANIFEST_ASSET_NAME && asset.browser_download_url) || null;
}

// Fetches latest.json from the release. Never throws: a broken or missing manifest only disables
// in-place updating, it must not make the version check itself fail.
export async function fetchReleaseManifest(fetchImpl, release) {
	const asset = findManifestAsset(release);
	if (!asset) return null;
	try {
		const response = await fetchImpl(asset.browser_download_url, {
			headers: { 'Accept': 'application/json' },
			credentials: 'omit',
			cache: 'no-store'
		});
		if (!response.ok) return null;
		const manifest = await response.json();
		return manifest && typeof manifest === 'object' ? manifest : null;
	} catch (e) {
		return null;
	}
}

export function buildUpdateStatus(release, currentVersion, platform, now, manifest = null) {
	const latestVersion = String(manifest?.version || release?.tag_name || release?.name || '').replace(/^v/i, '') || null;
	if (!latestVersion) throw new Error('Release has no version tag');
	// A tag like "New" compares as 0.0.0, which would silently report "up to date" forever.
	if (versionParts(latestVersion).length === 0) throw new Error(`Latest release tag "${latestVersion}" is not a version number`);

	const installer = platform === 'other' ? null : normalizeAsset(manifest?.installers?.[platform]);
	const extension = normalizeAsset(manifest?.extension);

	return {
		currentVersion,
		latestVersion,
		updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
		releaseUrl: release.html_url || null,
		downloadUrl: installer?.url || pickDownloadUrl(release, platform),
		extension,
		notes: typeof manifest?.notes === 'string' ? manifest.notes.slice(0, 2000) : null,
		checkedAt: now,
		error: null
	};
}

export function isStatusStale(status, now, maxAgeMs = UPDATE_CHECK_INTERVAL_MS) {
	return !status || !status.checkedAt || now - status.checkedAt >= maxAgeMs;
}

// Fetches the latest release and persists the result (including failures, so the UI can show
// "last check failed" instead of silently showing stale data).
export async function checkForUpdates({ fetchImpl, currentVersion, platform, now, getStorageValue, setStorageValue }) {
	let status;
	try {
		const response = await fetchImpl(RELEASES_API_URL, {
			headers: { 'Accept': 'application/vnd.github+json' },
			credentials: 'omit',
			cache: 'no-store'
		});
		if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
		const release = await response.json();
		const manifest = await fetchReleaseManifest(fetchImpl, release);
		status = buildUpdateStatus(release, currentVersion, platform, now, manifest);
	} catch (error) {
		const previous = await getStorageValue(UPDATE_STATUS_KEY, null);
		status = {
			...(previous || {}),
			currentVersion,
			checkedAt: now,
			error: error?.message || String(error)
		};
		if (previous?.latestVersion) {
			status.updateAvailable = compareVersions(previous.latestVersion, currentVersion) > 0;
		}
	}
	await setStorageValue(UPDATE_STATUS_KEY, status);
	return status;
}
