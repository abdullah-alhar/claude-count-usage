// Builds the Chrome Web Store upload: dist/claude-count-usage-chrome-<version>.zip
// Only files the browser extension loads go in - no Desktop installers, icons or patcher.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'manifest.json'), 'utf8'));

const include = [
	'manifest.json',
	'background.js',
	'tracker-styles.css',
	'icon128.png',
	'LICENSE.md',
	'icons',
	'lib',
	'injections',
	'shared/dataclasses.js',
	'shared/localization.js',
	'bg-components/claude-api.js',
	'bg-components/container-strategy.js',
	'bg-components/electron-compat.js',
	'bg-components/tokenManagement.js',
	'bg-components/update-check.js',
	'bg-components/utils.js',
	'content-components'
];

// The content-script copies of shared/*.js must match their sources.
execFileSync(process.execPath, [path.join(__dirname, 'build-dataclasses.js')], { stdio: 'inherit' });

for (const entry of include) {
	if (!fs.existsSync(path.join(rootDir, entry))) throw new Error(`Missing ${entry}`);
}

const distDir = path.join(rootDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const zipPath = path.join(distDir, `claude-count-usage-chrome-${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });

execFileSync('zip', ['-r', '-X', '-q', zipPath, ...include, '-x', '*.DS_Store'], { cwd: rootDir, stdio: 'inherit' });
console.log(`Wrote ${path.relative(rootDir, zipPath)}`);
