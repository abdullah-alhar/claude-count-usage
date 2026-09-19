// Update checking against this repo's GitHub releases. Contacts exactly one URL (below) and sends
// nothing but a plain GET - see PRIVACY.md.

export const RELEASES_API_URL = 'https://api.github.com/repos/abdullah-alhar/claude-count-usage/releases/latest';
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

export function buildUpdateStatus(release, currentVersion, platform, now) {
	const latestVersion = String(release?.tag_name || release?.name || '').replace(/^v/i, '') || null;
	if (!latestVersion) throw new Error('Release has no version tag');
	return {
		currentVersion,
		latestVersion,
		updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
		releaseUrl: release.html_url || null,
		downloadUrl: pickDownloadUrl(release, platform),
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
		status = buildUpdateStatus(await response.json(), currentVersion, platform, now);
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
