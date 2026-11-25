// Update checking against this repo's GitHub releases. Contacts exactly one URL (below) and sends
// nothing but a plain GET - see PRIVACY.md.
//
// The release carries a `latest.json` asset describing the update package (extension zip + SHA-256)
// and the per-platform installers. When it is present the settings card can update in place; when
// it is missing (older releases) the card falls back to linking the installer download.

const REPO = 'abdullah-alhar/claude-count-usage';
export const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
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

function releaseAsset(release, name) {
	const tag = release?.tag_name;
	if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) return null;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
	return (release.assets || []).find(asset => asset.name === name && asset.browser_download_url === url) || null;
}

function normalizeDigest(value) {
	const digest = String(value || '').toLowerCase();
	return /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

export function findManifestAsset(release) {
	return releaseAsset(release, MANIFEST_ASSET_NAME);
}

export async function fetchReleaseManifest(fetchImpl, release) {
	const asset = findManifestAsset(release);
	if (!asset) return null;
	try {
		const response = await fetchImpl(asset.browser_download_url, {
			headers: { 'Accept': 'application/json' },
			credentials: 'omit',
			cache: 'no-store'
		});
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

function selectUpdatePackage(release, manifest) {
	const asset = releaseAsset(release, 'ccu-extension.zip');
	if (!asset) return null;
	const url = asset.browser_download_url;
	const apiDigest = /^sha256:/i.test(asset.digest || '') && normalizeDigest(asset.digest.slice(7));
	const manifestDigest = manifest?.version === release.tag_name.slice(1) && manifest.extension?.url === url
		&& normalizeDigest(manifest.extension.sha256);
	const sha256 = apiDigest || manifestDigest;
	return sha256 ? { url, sha256, size: asset.size || manifest?.extension?.size || null } : null;
}

export function buildUpdateStatus(release, currentVersion, platform, now, manifest = null) {
	const latestVersion = String(release?.tag_name || '').replace(/^v/i, '');
	if (!/^\d+\.\d+(?:\.\d+)?$/.test(latestVersion) || release.draft || release.prerelease) {
		throw new Error('The latest GitHub release tag is not a version number for a stable release');
	}
	const extension = selectUpdatePackage(release, manifest);
	const updateAvailable = compareVersions(latestVersion, currentVersion) > 0;
	return {
		currentVersion,
		latestVersion,
		updateAvailable,
		releaseUrl: release.html_url || null,
		downloadUrl: pickDownloadUrl(release, platform),
		extension,
		packageError: updateAvailable && !extension ? 'This release does not have a verified automatic update package.' : null,
		notes: manifest?.version === latestVersion && typeof manifest.notes === 'string' ? manifest.notes.slice(0, 2000) : null,
		checkedAt: now,
		error: null
	};
}

export async function fetchUpdateStatus(fetchImpl, currentVersion, platform, now = Date.now()) {
	const response = await fetchImpl(RELEASES_API_URL, {
		headers: { 'Accept': 'application/vnd.github+json' },
		credentials: 'omit',
		cache: 'no-store'
	});
	if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
	const release = await response.json();
	const manifest = selectUpdatePackage(release, null) ? null : await fetchReleaseManifest(fetchImpl, release);
	return buildUpdateStatus(release, currentVersion, platform, now, manifest);
}

export function isStatusStale(status, now, maxAgeMs = UPDATE_CHECK_INTERVAL_MS) {
	return !status || !status.checkedAt || now - status.checkedAt >= maxAgeMs;
}

// Fetches the latest release and persists the result (including failures, so the UI can show
// "last check failed" instead of silently showing stale data).
export async function checkForUpdates({ fetchImpl, currentVersion, platform, now, getStorageValue, setStorageValue }) {
	let status;
	try {
		status = await fetchUpdateStatus(fetchImpl, currentVersion, platform, now);
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
