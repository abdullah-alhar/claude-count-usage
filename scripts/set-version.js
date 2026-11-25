#!/usr/bin/env node
'use strict';
/**
 * Bumps the tracker version everywhere it is written.
 *
 *   node scripts/set-version.js 1.7.1
 *
 * Keeps manifest.json, manifest_electron.json and package.json in step so the GitHub release tag,
 * the manifest the extension reports, and the update package all agree. The release workflow
 * refuses to publish when the tag and manifest version differ.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const next = String(process.argv[2] || '').trim().replace(/^v/i, '');

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error('Usage: node scripts/set-version.js <x.y.z>');
  process.exit(1);
}

const targets = [
  { file: 'manifest.json', apply: (data) => ({ ...data, version: next }) },
  { file: 'manifest_electron.json', apply: (data) => ({ ...data, version: next }) },
  { file: 'package.json', apply: (data) => ({ ...data, version: next }) }
];

for (const { file, apply } of targets) {
  const filePath = path.join(root, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const before = data.version;
  fs.writeFileSync(filePath, JSON.stringify(apply(data), null, file === 'package.json' ? 2 : '\t') + '\n');
  console.log(`${file}: ${before} -> ${next}`);
}
