#!/usr/bin/env node
'use strict';
/**
 * Builds the release update package: dist/ccu-extension.zip
 *
 * Layout (what wrapper-runtime.js installs):
 *   extension/…              the tracker itself (manifest.json is the Electron manifest)
 *   runtime/wrapper-runtime.js
 *   runtime/ccu-update.js
 *   version.json             { "version": "1.7.0" }
 *
 * Prints the SHA-256 the release manifest needs.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeZip, walk } = require('./lib/zip-writer.js');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const staging = path.join(dist, 'package');

const EXTENSION_ENTRIES = [
  'manifest_electron.json',
  'background.js',
  'bg-components',
  'content-components',
  'lib',
  'shared',
  'injections',
  'tracker-styles.css',
  'icon128.png'
];

const RUNTIME_ENTRIES = ['wrapper-runtime.js', 'ccu-update.js'];

function copyEntry(name, destDir) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) throw new Error(`Missing ${name}; run from the repository root.`);
  fs.cpSync(src, path.join(destDir, name), { recursive: true });
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const version = manifest.version;
  if (require('../manifest_electron.json').version !== version || require('../package.json').version !== version) {
    throw new Error('Both extension manifests and package.json must have the same version.');
  }

  // Generated twins must match their sources.
  require('./build-dataclasses.js');

  fs.rmSync(staging, { recursive: true, force: true });
  const extensionDir = path.join(staging, 'extension');
  const runtimeDir = path.join(staging, 'runtime');
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (const name of EXTENSION_ENTRIES) copyEntry(name, extensionDir);
  for (const name of RUNTIME_ENTRIES) copyEntry(name, runtimeDir);

  // Electron loads manifest.json; keep the browser manifest out of the package.
  fs.copyFileSync(path.join(root, 'manifest_electron.json'), path.join(extensionDir, 'manifest.json'));
  fs.writeFileSync(path.join(staging, 'version.json'), JSON.stringify({ version }, null, 2) + '\n');

  const out = path.join(dist, 'ccu-extension.zip');
  const result = writeZip(walk(staging), out);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');

  fs.rmSync(staging, { recursive: true, force: true });

  console.log(`Built ${path.relative(root, out)} (${result.files} files, ${(result.bytes / 1024).toFixed(0)} KB)`);
  console.log(`version: ${version}`);
  console.log(`sha256:  ${sha256}`);
}

try {
  main();
} catch (error) {
  console.error('build-package failed:', error.message);
  process.exit(1);
}
