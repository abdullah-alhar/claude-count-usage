#!/usr/bin/env node
/**
 * Claude Count Usage — Asar Patcher
 * Pure Node.js, zero npm dependencies.
 * Created by Abdullah Alhar
 *
 * Usage:
 *   node asar-patcher.js patch   <asar> <extensionDir>
 *   node asar-patcher.js restore <asar> <backupAsar>
 *   node asar-patcher.js check   <asar>
 */

'use strict';
const fs   = require('fs');
const path = require('path');

// ─── ASAR reader ────────────────────────────────────────────
// asar binary layout:
//   [0..3]   uint32LE  — ASAR magic / pickle header size (always 4)
//   [4..7]   uint32LE  — size of the header pickle (= 8 + headerJsonSize)
//   [8..11]  uint32LE  — header pickle size again (Chromium pickle format)
//   [12..15] uint32LE  — actual headerJsonSize
//   [16..]   utf8 JSON — the file header (tree of {files:{...}, offset, size})
//   [16+headerJsonSize..] — raw file contents concatenated

function readAsarHeader(buf) {
  const headerJsonSize = buf.readUInt32LE(12);
  const headerJson     = buf.slice(16, 16 + headerJsonSize).toString('utf8');
  const header         = JSON.parse(headerJson);
  const dataOffset     = 16 + headerJsonSize;
  return { header, dataOffset, headerJsonSize };
}

/** Extract a single file's bytes from the asar buffer */
function extractFile(buf, dataOffset, node) {
  if (node.unpacked) return null;                       // in .unpacked dir, skip
  const start = dataOffset + parseInt(node.offset, 10);
  return buf.slice(start, start + node.size);
}

/** Walk a header node and call cb(relativePath, node) for every file */
function walkHeader(node, prefix, cb) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const rel = prefix ? prefix + '/' + name : name;
    if (child.files) {
      walkHeader(child, rel, cb);
    } else {
      cb(rel, child);
    }
  }
}

/** Navigate a header path like ".vite/build/index.pre.js" */
function getNode(header, filePath) {
  const parts = filePath.split('/');
  let node = header;
  for (const part of parts) {
    if (!node.files || !node.files[part]) return null;
    node = node.files[part];
  }
  return node;
}

// ─── ASAR writer ────────────────────────────────────────────
// We use a simple strategy: extract everything to a temp dir,
// modify the target file, then repack.

function extractAll(buf, dataOffset, header, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  walkHeader(header, '', (rel, node) => {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    if (node.unpacked) {
      // File is in .unpacked alongside the asar — copy from there
      // (we'll handle this in the installer by copying .unpacked too)
      fs.writeFileSync(dest, Buffer.alloc(0)); // placeholder
    } else {
      const data = extractFile(buf, dataOffset, node);
      if (data) fs.writeFileSync(dest, data);
    }
  });
}

/** Build a new asar from a directory */
function packDir(srcDir, destAsar) {
  // Walk all files, build header tree and content buffer
  const files    = [];
  const header   = { files: {} };
  let   offset   = 0;

  function walk(dir, node) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : 1);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        node.files[entry.name] = { files: {} };
        walk(fullPath, node.files[entry.name]);
      } else {
        const data = fs.readFileSync(fullPath);
        node.files[entry.name] = { size: data.length, offset: String(offset) };
        files.push(data);
        offset += data.length;
      }
    }
  }
  walk(srcDir, header);

  // Serialize header JSON
  const headerJson   = JSON.stringify(header);
  const headerBuf    = Buffer.from(headerJson, 'utf8');
  const headerSize   = headerBuf.length;

  // Build the 16-byte ASAR prefix
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4,                  0);  // pickle header size
  prefix.writeUInt32LE(8 + headerSize,     4);  // header pickle size
  prefix.writeUInt32LE(8 + headerSize,     8);  // repeated
  prefix.writeUInt32LE(headerSize,        12);  // JSON size

  const parts = [prefix, headerBuf, ...files];
  const total = parts.reduce((s, b) => s + b.length, 0);
  const out   = Buffer.concat(parts, total);
  fs.writeFileSync(destAsar, out);
}

// ─── Commands ───────────────────────────────────────────────

const [,, command, ...args] = process.argv;

if (command === 'check') {
  const [asarPath] = args;
  const buf = fs.readFileSync(asarPath);
  const { header, dataOffset } = readAsarHeader(buf);
  const mainNode = getNode(header, '.vite/build/index.pre.js');
  if (!mainNode) { console.error('MAIN_NOT_FOUND'); process.exit(1); }
  const content = extractFile(buf, dataOffset, mainNode).toString('utf8');
  if (content.includes('CLAUDE_COUNT_USAGE')) {
    console.log('ALREADY_PATCHED');
  } else {
    console.log('READY');
  }
  process.exit(0);
}

if (command === 'patch') {
  const [asarPath, extensionDir] = args;
  const MARKER    = 'CLAUDE_COUNT_USAGE';
  const MAIN_PATH = '.vite/build/index.pre.js';

  console.log('Reading asar...');
  const buf = fs.readFileSync(asarPath);
  const { header, dataOffset } = readAsarHeader(buf);

  // Find main JS node (try known path, fall back to grep)
  let mainRelPath = MAIN_PATH;
  let mainNode    = getNode(header, MAIN_PATH);

  if (!mainNode) {
    console.log('Known path not found, searching for BrowserWindow...');
    // Walk and find first JS file containing BrowserWindow in its content
    let found = false;
    walkHeader(header, '', (rel, node) => {
      if (found || !rel.endsWith('.js') || rel.includes('node_modules')) return;
      const data = extractFile(buf, dataOffset, node);
      if (data && data.toString('utf8').includes('BrowserWindow')) {
        mainRelPath = rel;
        mainNode    = node;
        found       = true;
        console.log('Found via content search:', rel);
      }
    });
  }

  if (!mainNode) {
    console.error('ERROR: Could not find main process JS file');
    process.exit(1);
  }
  console.log('Main process:', mainRelPath);

  // Extract all files to temp dir
  const tmpDir = path.join(require('os').tmpdir(), 'ccu-patch-' + Date.now());
  console.log('Extracting', Object.keys(header.files).length, 'top-level entries to', tmpDir);
  extractAll(buf, dataOffset, header, tmpDir);
  console.log('Extraction complete');

  // Read and patch the main JS
  const mainDest    = path.join(tmpDir, ...mainRelPath.split('/'));
  let   mainContent = fs.readFileSync(mainDest, 'utf8');

  // Remove old injection if present
  if (mainContent.includes(MARKER)) {
    console.log('Removing previous injection...');
    mainContent = mainContent.replace(
      /\/\* CLAUDE_COUNT_USAGE_START \*\/[\s\S]*?\/\* CLAUDE_COUNT_USAGE_END \*\//g,
      ''
    );
  }

  // Build injection snippet
  const injection = `\n/* CLAUDE_COUNT_USAGE_START */\n` +
    `(function(){try{const {app:_a,session:_s}=require('electron');` +
    `const _p=${JSON.stringify(extensionDir)};` +
    `const _l=()=>_s.defaultSession.loadExtension(_p,{allowFileAccess:true})` +
    `.then(()=>console.log('[CCU] Loaded:',_p))` +
    `.catch(e=>console.error('[CCU] Failed:',e));` +
    `_a.isReady()?_l():_a.whenReady().then(_l);` +
    `}catch(e){console.error('[CCU] Error:',e);}})();\n` +
    `/* CLAUDE_COUNT_USAGE_END */\n`;

  fs.writeFileSync(mainDest, mainContent + injection, 'utf8');
  console.log('Injection written');

  // Repack
  console.log('Packing asar...');
  packDir(tmpDir, asarPath);
  console.log('Pack complete');

  // Clean up
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('Temp dir cleaned');

  process.exit(0);
}

if (command === 'restore') {
  const [asarPath, backupPath] = args;
  fs.copyFileSync(backupPath, asarPath);
  console.log('Restored from backup');
  process.exit(0);
}

console.error('Unknown command:', command);
process.exit(1);
