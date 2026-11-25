#!/usr/bin/env node
'use strict';
/**
 * Builds the release's latest.json from the built artifacts.
 *
 *   node scripts/make-manifest.js \
 *     --version 1.7.0 \
 *     --package dist/ccu-extension.zip \
 *     --mac dist/Mac.installer.zip \
 *     --windows dist/windows.installer.zip \
 *     --notes "What changed" \
 *     --out dist/latest.json
 *
 * The URLs point at this repo's release assets, which is where the update checker downloads from.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'https://github.com/abdullah-alhar/claude-count-usage';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function asset(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) throw new Error(`Missing artifact: ${filePath}`);
  const data = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length
  };
}

function main() {
  const version = String(arg('--version') || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Pass --version x.y.z');

  const pkg = asset(arg('--package'));
  const mac = asset(arg('--mac'));
  const windows = asset(arg('--windows'));
  if (!pkg) throw new Error('Pass --package <ccu-extension.zip>');

  const downloadUrl = (file) => `${REPO}/releases/download/v${version}/${encodeURIComponent(file)}`;

  const manifest = {
    version,
    releasedAt: new Date().toISOString(),
    notes: arg('--notes', ''),
    extension: {
      url: downloadUrl(pkg.name),
      sha256: pkg.sha256,
      size: pkg.size
    },
    installers: {}
  };

  if (mac) manifest.installers.mac = { url: downloadUrl(mac.name), sha256: mac.sha256, size: mac.size };
  if (windows) manifest.installers.windows = { url: downloadUrl(windows.name), sha256: windows.sha256, size: windows.size };

  const out = arg('--out', 'dist/latest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote ${out}`);
  console.log(JSON.stringify(manifest, null, 2));
}

try {
  main();
} catch (error) {
  console.error('make-manifest failed:', error.message);
  process.exit(1);
}
