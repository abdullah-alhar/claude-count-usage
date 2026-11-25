#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const updater = require('../ccu-update.js');

async function main() {
  const dist = path.resolve(process.argv[2] || 'dist');
  const manifestPath = path.join(dist, 'latest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const version = require('../manifest_electron.json').version;
  assert.equal(manifest.version, version);
  for (const file of ['../manifest.json', '../package.json']) assert.equal(require(file).version, version);

  const tag = 'v' + version;
  const base = 'https://github.com/abdullah-alhar/claude-count-usage/releases';
  const assets = [];
  for (const [name, metadata] of [
    ['ccu-extension.zip', manifest.extension],
    ['Mac.installer.zip', manifest.installers.mac],
    ['windows.installer.zip', manifest.installers.windows],
    ['latest.json', null]
  ]) {
    const file = path.join(dist, name);
    const size = fs.statSync(file).size;
    const sha256 = await updater.sha256File(file);
    const url = `${base}/download/${tag}/${name}`;
    if (metadata) assert.deepEqual(metadata, { url, size, sha256 });
    assets.push({ name, browser_download_url: url, size, digest: 'sha256:' + sha256 });
  }

  const release = { tag_name: tag, html_url: `${base}/tag/${tag}`, assets };
  if (process.argv[3]) {
    const uploaded = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    assert.equal(uploaded.tag_name, tag);
    for (const expected of assets) {
      const actual = uploaded.assets.find(asset => asset.name === expected.name);
      assert.ok(actual, 'Missing uploaded asset ' + expected.name);
      for (const key of Object.keys(expected)) assert.equal(actual[key], expected[key], expected.name + ' ' + key);
    }
  }

  const { buildUpdateStatus } = await import('../bg-components/update-check.js');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ccu-verify-release-'));
  try {
    for (const platform of ['mac', 'windows']) {
      const status = buildUpdateStatus(release, '0.0.0', platform, Date.now());
      assert.ok(status.updateAvailable);
      assert.deepEqual(status.extension, manifest.extension);
      assert.equal(status.downloadUrl, manifest.installers[platform].url);
    }
    const result = await updater.applyUpdateZip({
      zipPath: path.join(dist, 'ccu-extension.zip'), root: work, sha256: manifest.extension.sha256, version
    });
    assert.equal(result.version, version);
    assert.equal(updater.readExtensionVersion(updater.extensionDir(work)), version);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('Verified release metadata, asset hashes and automatic installation of ' + version);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
