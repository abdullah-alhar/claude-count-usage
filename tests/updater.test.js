/**
 * Claude Count Usage — updater test suite.
 *
 * Covers the pieces that make "Update now" safe:
 *   1. update-check.js reads latest.json and only trusts https URLs + real SHA-256 values
 *   2. ccu-update.js unpacks release zips (stored + deflated) and rejects unsafe paths
 *   3. applyUpdatePackage swaps extension/runtime atomically and keeps a rollback copy
 *   4. applyUpdateZip refuses a package whose checksum does not match
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { pathToFileURL } = require('url');

const rootDir = path.join(__dirname, '..');
const updater = require(path.join(rootDir, 'ccu-update.js'));

let passed = 0;
let failed = 0;

function check(condition, message) {
	if (condition) {
		console.log('  \u2713 ' + message);
		passed++;
	} else {
		console.error('  \u2717 FAIL: ' + message);
		failed++;
	}
}

// ─── Minimal ZIP writer (stored + deflate) ─────────────────

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
	return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8');
		const raw = Buffer.from(entry.data);
		const deflate = entry.deflate === true;
		const data = deflate ? zlib.deflateRawSync(raw) : raw;
		const method = deflate ? 8 : 0;
		const crc = crc32(raw);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(method, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += local.length + name.length + data.length;
	}

	const centralBuffer = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralBuffer, eocd]);
}

// ─── 1. Release manifest parsing ───────────────────────────

async function testManifestParsing() {
	console.log('\n=== 1. latest.json manifest parsing ===');
	const uc = await import(pathToFileURL(path.join(rootDir, 'bg-components', 'update-check.js')).href);

	const sha = 'a'.repeat(64);
	const base = 'https://github.com/abdullah-alhar/claude-count-usage/releases';
	const asset = (name, digest) => ({ name, browser_download_url: base + '/download/v1.7.2/' + name, digest });
	const zip = asset('ccu-extension.zip', 'sha256:' + sha);
	const release = {
		tag_name: 'v1.7.2',
		html_url: base + '/tag/v1.7.2',
		assets: [asset('latest.json'), zip, asset('Mac.installer.zip'), asset('windows.installer.zip')]
	};
	const manifest = {
		version: '1.7.2',
		extension: { url: zip.browser_download_url, sha256: sha, size: 1234 }
	};

	const fetchWithoutManifest = async url => {
		assert.strictEqual(url, uc.RELEASES_API_URL);
		return { ok: true, json: async () => release };
	};
	for (const [platform, installer] of [['mac', 'Mac.installer.zip'], ['windows', 'windows.installer.zip']]) {
		const status = await uc.fetchUpdateStatus(fetchWithoutManifest, '1.7.0', platform);
		check(status.updateAvailable && status.extension?.sha256 === sha, platform + ' finds the update from the API alone');
		check(status.downloadUrl.endsWith('/' + installer), platform + ' gets its own manual installer link');
	}

	const withoutDigest = { ...release, assets: release.assets.map(item => ({ ...item, digest: undefined })) };
	check(uc.buildUpdateStatus(withoutDigest, '1.7.0', 'mac', 0, manifest).extension?.sha256 === sha,
		'accepts the matching release manifest if the API digest is absent');
	for (const invalid of [
		{ ...manifest, version: '1.7.1' },
		{ ...manifest, extension: { ...manifest.extension, url: 'https://github.com/another-repo/update.zip' } },
		{ ...manifest, extension: { ...manifest.extension, sha256: 'not-a-hash' } },
		null
	]) {
		const status = uc.buildUpdateStatus(withoutDigest, '1.7.0', 'mac', 0, invalid);
		check(status.updateAvailable && !status.extension && !!status.packageError, 'rejects missing or invalid package metadata');
	}
	check(uc.buildUpdateStatus(release, '1.7.2', 'mac', 0).updateAvailable === false,
		'loaded release version is already up to date');

	check(uc.findManifestAsset(release)?.name === 'latest.json', 'finds the latest.json release asset');
	const fetched = await uc.fetchReleaseManifest(async () => ({ ok: true, json: async () => manifest }), release);
	check(fetched?.version === '1.7.2', 'fetches and parses the manifest for older release metadata');
	const malformed = await uc.fetchReleaseManifest(async () => ({ ok: false, status: 500 }), release);
	check(malformed === null, 'a failed manifest fetch returns no manifest');

}

// ─── 2. Zip extraction ─────────────────────────────────────

function testZipExtraction() {
	console.log('\n=== 2. ZIP extraction ===');
	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-zip-'));
	try {
		const zip = makeZip([
			{ name: 'extension/manifest.json', data: '{"version":"1.7.0"}' },
			{ name: 'runtime/wrapper-runtime.js', data: 'module.exports = 1;', deflate: true },
			{ name: 'nested/dir/file.txt', data: 'hello' }
		]);
		updater.extractZipBuffer(zip, work);
		check(fs.readFileSync(path.join(work, 'extension', 'manifest.json'), 'utf8') === '{"version":"1.7.0"}',
			'extracts a stored entry');
		check(fs.readFileSync(path.join(work, 'runtime', 'wrapper-runtime.js'), 'utf8') === 'module.exports = 1;',
			'extracts a deflated entry');
		check(fs.readFileSync(path.join(work, 'nested', 'dir', 'file.txt'), 'utf8') === 'hello',
			'creates nested directories');

		let threw = false;
		try {
			updater.extractZipBuffer(makeZip([{ name: '../escape.txt', data: 'x' }]), work);
		} catch (e) {
			threw = /Unsafe ZIP path/.test(e.message);
		}
		check(threw, 'rejects path traversal entries');
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

// ─── 3. Atomic swap + rollback copy ────────────────────────

function testApplyPackage() {
	console.log('\n=== 3. applyUpdatePackage() ===');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-apply-'));
	const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-pkg-'));
	try {
		fs.mkdirSync(path.join(root, 'extension'), { recursive: true });
		fs.writeFileSync(path.join(root, 'extension', 'old.js'), 'old');
		updater.writeState(root, { version: '1.6.0' });

		fs.mkdirSync(path.join(pkg, 'extension'), { recursive: true });
		fs.mkdirSync(path.join(pkg, 'runtime'), { recursive: true });
		fs.writeFileSync(path.join(pkg, 'extension', 'manifest.json'), '{"version":"1.7.0"}');
		fs.writeFileSync(path.join(pkg, 'extension', 'new.js'), 'new');
		fs.writeFileSync(path.join(pkg, 'runtime', 'wrapper-runtime.js'), 'runtime');
		fs.writeFileSync(path.join(pkg, 'runtime', 'ccu-update.js'), 'module.exports = {};');
		for (const file of ['background.js', 'bg-components/update-check.js', 'content-components/settings_card.js']) {
			fs.mkdirSync(path.dirname(path.join(pkg, 'extension', file)), { recursive: true });
			fs.writeFileSync(path.join(pkg, 'extension', file), '');
		}
		fs.writeFileSync(path.join(pkg, 'version.json'), '{"version":"1.7.0"}');

		const result = updater.applyUpdatePackage({ packageDir: pkg, root });
		check(result.version === '1.7.0', 'returns the installed version');
		check(fs.readFileSync(path.join(root, 'extension', 'new.js'), 'utf8') === 'new', 'installs the new extension');
		check(!fs.existsSync(path.join(root, 'extension', 'old.js')), 'old extension is replaced');
		check(fs.existsSync(path.join(root, 'extension.old', 'old.js')), 'old extension is kept for rollback');
		check(fs.readFileSync(path.join(root, 'runtime', 'wrapper-runtime.js'), 'utf8') === 'runtime', 'installs the new runtime');
		check(updater.readState(root).version === '1.7.0', 'records the installed version');
		check(updater.readState(root).pendingRestart === true, 'marks a restart as pending');

		fs.rmSync(path.join(pkg, 'runtime'), { recursive: true, force: true });
		assert.throws(() => updater.applyUpdatePackage({ packageDir: pkg, root }), {
			code: 'ENOENT',
			path: path.join(pkg, 'runtime', 'wrapper-runtime.js')
		});
		check(updater.readExtensionVersion(updater.extensionDir(root)) === result.version,
			'refuses a package without the runtime and keeps the installed version');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
		fs.rmSync(pkg, { recursive: true, force: true });
	}
}

// ─── 4. Checksum enforcement ───────────────────────────────

async function testChecksumAsync() {
	console.log('\n=== 4. applyUpdateZip() checksum ===');
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-sha-'));
	const zipPath = path.join(root, 'update.zip');
	try {
		fs.writeFileSync(zipPath, makeZip([
			{ name: 'extension/manifest.json', data: '{"version":"1.7.0"}' },
			{ name: 'runtime/wrapper-runtime.js', data: 'runtime' },
			{ name: 'runtime/ccu-update.js', data: 'module.exports = {};' },
			{ name: 'extension/background.js', data: '' },
			{ name: 'extension/bg-components/update-check.js', data: '' },
			{ name: 'extension/content-components/settings_card.js', data: '' },
			{ name: 'version.json', data: '{"version":"1.7.0"}' }
		]));

		let message = null;
		try {
			await updater.applyUpdateZip({ zipPath, sha256: 'b'.repeat(64), root });
		} catch (e) {
			message = e.message;
		}
		check(message && /Checksum mismatch/.test(message), 'a mismatched checksum aborts the install');
		check(!fs.existsSync(path.join(root, 'extension')), 'nothing is installed after a bad checksum');

		const previousDir = updater.extensionDir(root);
		fs.mkdirSync(previousDir, { recursive: true });
		fs.writeFileSync(path.join(previousDir, 'manifest.json'), '{"version":"1.6.0"}');

		const sha = await updater.sha256File(zipPath);
		await assert.rejects(updater.applyUpdateZip({ zipPath, sha256: sha, version: '1.7.2', root }), /version does not match/);
		check(updater.readExtensionVersion(previousDir) === '1.6.0', 'a version mismatch keeps the previous version usable');
		const result = await updater.applyUpdateZip({ zipPath, sha256: sha, root });
		check(result.version === '1.7.0', 'a matching checksum installs the package');
		check(fs.existsSync(path.join(root, 'extension', 'manifest.json')), 'package contents land in the user folder');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

function testUploadedReleaseAssets() {
	console.log('\n=== 5. Uploaded release assets ===');
	const { verifyUploadedAssets } = require('../scripts/verify-release.js');
	const base = 'https://github.com/abdullah-alhar/claude-count-usage/releases';
	const tag = 'v1.7.1';
	const temporaryTag = 'untagged-3c5545109e36427844f1';
	const expected = {
		name: 'ccu-extension.zip',
		browser_download_url: `${base}/download/${tag}/ccu-extension.zip`,
		size: 1234,
		digest: 'sha256:' + 'a'.repeat(64)
	};
	const uploadedAsset = {
		...expected,
		browser_download_url: `${base}/download/${temporaryTag}/ccu-extension.zip`
	};
	const draft = { tag_name: tag, draft: true, html_url: `${base}/tag/${temporaryTag}`, assets: [uploadedAsset] };

	verifyUploadedAssets(draft, tag, [expected]);
	verifyUploadedAssets({ ...draft, draft: false, assets: [expected] }, tag, [expected]);
	assert.throws(() => verifyUploadedAssets({ ...draft, draft: false }, tag, [expected]), /browser_download_url/);
	assert.throws(() => verifyUploadedAssets({
		...draft, assets: [{ ...uploadedAsset, digest: 'sha256:' + 'b'.repeat(64) }]
	}, tag, [expected]), /digest/);
	assert.throws(() => verifyUploadedAssets({
		...draft, html_url: `${base}/tag/untagged-aaaa`
	}, tag, [expected]), /browser_download_url/);
	check(true, 'verifies GitHub draft and published assets and rejects mismatched URLs and digests');
}

(async () => {
	await testManifestParsing();
	testZipExtraction();
	testApplyPackage();
	await testChecksumAsync();
	testUploadedReleaseAssets();

	console.log('\n======================================================');
	console.log(`  ${passed} passed, ${failed} failed`);
	console.log('======================================================');
	process.exit(failed === 0 ? 0 : 1);
})();
