'use strict';

// Bridges Claude Desktop's main process (alarms, window focus) and the fetch monkeypatch to the background.
async function initElectronReceiver() {
	console.log('Electron receiver initializing...');

	// Claude Desktop ignores the manifest's `"world": "MAIN"` content script, so the completion-stream
	// watcher never ran there: no live usage, reply token count or - on the free plan, where /usage
	// reports nothing - any session/weekly figure at all. Inject it into the page the same way as the
	// webrequest polyfill. It guards against running twice where the manifest entry does work.
	injectPageScript('injections/sse-watcher.js');

	// Get monkeypatch patterns for request interception
	const patterns = await browser.runtime.sendMessage({
		type: 'getMonkeypatchPatterns'
	});

	if (patterns) {
		setupRequestInterception(patterns);
	}

	// Alarm events from Node
	window.addEventListener('electronAlarmFired', (event) => {
		chrome.runtime.sendMessage({
			type: 'electron-alarm',
			name: event.detail.name
		});
	});

	// Tab activity events from Node
	window.addEventListener('electronTabActivated', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabActivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabDeactivated', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabDeactivated',
			details: event.detail
		});
	});

	window.addEventListener('electronTabRemoved', (event) => {
		chrome.runtime.sendMessage({
			type: 'electronTabRemoved',
			details: event.detail
		});
	});

	// Request/Response interception events
	window.addEventListener('interceptedRequest', async (event) => {
		browser.runtime.sendMessage({
			type: 'interceptedRequest',
			details: event.detail
		});
	});

	window.addEventListener('interceptedResponse', async (event) => {
		browser.runtime.sendMessage({
			type: 'interceptedResponse',
			details: event.detail
		});
	});

	// Lets the background re-arm main-process alarms (lost on app restart) and refresh stale usage.
	// That refresh and the update check are network requests, so hold them until claude.ai has
	// finished booting rather than competing with its own startup requests.
	waitForPageSettled().then(() => browser.runtime.sendMessage({ type: 'electronPageReady' })).catch(() => {});

	console.log('Electron receiver initialized');
}

function setupRequestInterception(patterns) {
	// Inject external request interception script with patterns as data attribute
	injectPageScript('injections/webrequest-polyfill.js', { patterns: JSON.stringify(patterns) });
}

// Runs an extension file in the page's own world (where claude.ai's window.fetch lives).
function injectPageScript(file, dataset = {}) {
	const script = document.createElement('script');
	script.src = browser.runtime.getURL(file);
	Object.assign(script.dataset, dataset);
	script.onload = function () {
		this.remove();
	};
	(document.head || document.documentElement).appendChild(script);
}

// Initialize
initElectronReceiver();