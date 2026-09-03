#!/usr/bin/env node
/**
 * Claude Count Usage — Asar Patcher
 * Pure Node.js, zero npm dependencies.
 * Created by Abdullah Alhar
 *
 * Usage:
 *   node asar-patcher.js patch   <asar> <extensionDir>
 *   node asar-patcher.js restore <asar> [backupAsar]
 *   node asar-patcher.js check   <asar>
 */

'use strict';

const injector = require('./desktop-injector.js');

const [,, command, ...args] = process.argv;

(async () => {
  if (command === 'check') {
    const [asarPath] = args;
    if (!asarPath) {
      injector.cmdCheck ? injector.cmdCheck() : console.log('READY');
      process.exit(0);
    }
    const { header, dataOffset } = injector.readAsarHeader(asarPath);
    const mainNode = header.files && (header.files['.vite/build/index.pre.js'] || header.files['package.json']);
    if (!mainNode) { console.error('MAIN_NOT_FOUND'); process.exit(1); }
    console.log('READY');
    process.exit(0);
  }

  if (command === 'patch') {
    const [asarPath, extensionDir] = args;
    if (!asarPath || !extensionDir) {
      console.error('Usage: node asar-patcher.js patch <asar> <extensionDir>');
      process.exit(1);
    }
    await injector.patchAsar(asarPath, extensionDir);
    process.exit(0);
  }

  if (command === 'restore') {
    const [asarPath] = args;
    if (!asarPath) {
      console.error('Usage: node asar-patcher.js restore <asar>');
      process.exit(1);
    }
    injector.unpatchAsar(asarPath);
    process.exit(0);
  }

  console.error('Unknown command:', command);
  process.exit(1);
})().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
