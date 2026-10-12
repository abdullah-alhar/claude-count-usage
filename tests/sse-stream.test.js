/**
 * Claude Count Usage - completion-stream usage parsing (content-components/sse_bridge.js)
 *
 * On the free plan /usage reports nothing, so the `message_limit` event of the completion stream is
 * the only usage the extension ever sees. If its shape drifts, free accounts silently fall back to
 * "Starts with your next message" on both bars. This pins the shape against a real capture
 * (tests/fixtures/free-plan-message-limit.json) and walks it through the same path the page uses:
 * postMessage from injections/sse-watcher.js -> sse_bridge listener -> UI listeners + background.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'free-plan-message-limit.json'), 'utf8'));

let passedTests = 0;
function assert(condition, message) {
	if (!condition) {
		console.error(`  ✗ ${message}`);
		process.exit(1);
	}
	console.log(`  ✓ ${message}`);
	passedTests++;
}

// Minimal content-script world: sse_bridge.js registers one window 'message' listener at load.
const windowListeners = [];
const backgroundMessages = [];
const fakeWindow = {
	location: { origin: 'https://claude.ai' },
	addEventListener: (type, fn) => { if (type === 'message') windowListeners.push(fn); },
	postMessage: () => {}
};
// Stands in for the browser's resource timing, so the test can deliver entries the way Chromium does.
let performanceCallback = null;
class FakePerformanceObserver {
	constructor(callback) { performanceCallback = callback; }
	observe() {}
}
const pageDiagnostics = {
	injections: {}, watcherInstalledAt: null, watcherWrappedNativeFetch: null,
	watcherCompletions: [], streamsReceived: 0, streamsWithUsage: 0, browserCompletions: []
};
const context = vm.createContext({
	window: fakeWindow,
	PerformanceObserver: FakePerformanceObserver,
	pageDiagnostics,
	console,
	setTimeout: (fn) => fn(),
	Log: () => {},
	CONFIG: { SSE_SAME_WINDOW_TOLERANCE_MS: 60 * 1000, ESTIMATION_MULTIPLIER: 1 },
	GPTTokenizer_o200k_base: { countTokens: (text) => text.length },
	getActiveOrgId: () => 'org-1',
	sendBackgroundMessage: (message) => { backgroundMessages.push(message); return Promise.resolve(); }
});
vm.runInContext(fs.readFileSync(path.join(rootDir, 'content-components', 'sse_bridge.js'), 'utf8'), context);

console.log('\nsse_bridge: free-plan message_limit (Sonnet 5.5, 2026-10-11)');

const limits = context.parseSseLimits(fixture.message_limit);
assert(limits !== null, 'parseSseLimits finds usage in the captured payload');
assert(limits.session.percentage === 3, '5h utilization 0.03 -> session 3%');
assert(limits.session.resetsAt === 1791747600 * 1000, '5h resets_at seconds -> epoch ms');
assert(limits.weekly.percentage === 0, '7d utilization 0 -> weekly 0% (zero is a value, not missing)');
assert(limits.weekly.resetsAt === 1792184400 * 1000, '7d resets_at seconds -> epoch ms');

const exceeded = context.parseSseWindow({ status: 'exceeded_limit', resets_at: 1791747600, utilization: 0.98 });
assert(exceeded.percentage === 100, 'exceeded_limit reads as 100% even though utilization stops at 0.98');
assert(context.parseSseLimits({ windows: {} }) === null, 'payload without 5h/7d windows reports nothing');

console.log('\nsse_bridge: page message -> UI listeners and background');

const uiUpdates = [];
context.onSsePartialUsage((update) => uiUpdates.push(update));
assert(windowListeners.length === 1, 'sse_bridge listens for the watcher\'s postMessage');

windowListeners[0]({
	source: fakeWindow,
	origin: 'https://claude.ai',
	data: {
		type: 'claudeUsageTrackerStream',
		streamOrgId: 'org-1',
		conversationId: 'conv-1',
		isRetry: false,
		messageLimit: fixture.message_limit,
		assistantText: 'Hey there! How can I help?',
		sawNonTextBlock: false,
		assistantUuid: 'a-1',
		parentUuid: 'h-1',
		model: 'claude-sonnet-5-5'
	}
});

assert(uiUpdates.length === 1, 'UI listeners receive one update per completion');
assert(uiUpdates[0].session.percentage === 3 && uiUpdates[0].weekly.percentage === 0, 'UI update carries session 3% and weekly 0%');
assert(backgroundMessages.length === 1 && backgroundMessages[0].type === 'reportStreamCompletion', 'background gets reportStreamCompletion');
assert(backgroundMessages[0].sseLimits.session.percentage === 3, 'background snapshot carries the session window (free-plan fallback source)');
assert(backgroundMessages[0].sseLimits.weekly.percentage === 0, 'background snapshot carries the weekly window');

windowListeners[0]({
	source: fakeWindow,
	origin: 'https://claude.ai',
	data: { type: 'claudeUsageTrackerStream', streamOrgId: 'org-2', messageLimit: fixture.message_limit, assistantText: '' }
});
assert(uiUpdates.length === 1, 'a stream from another org is ignored');

console.log('\nsse_bridge: diagnostics for the debug log header');

assert(pageDiagnostics.streamsReceived === 2 && pageDiagnostics.streamsWithUsage === 2, 'every stream is counted, including one from another org');

windowListeners[0]({ source: fakeWindow, origin: 'https://claude.ai', data: { type: 'claudeUsageTrackerDiag', stage: 'installed', nativeFetch: true } });
assert(pageDiagnostics.watcherInstalledAt !== null && pageDiagnostics.watcherWrappedNativeFetch === true, 'watcher install is recorded with its fetch kind');

windowListeners[0]({ source: fakeWindow, origin: 'https://claude.ai', data: { type: 'claudeUsageTrackerDiag', stage: 'completion', status: 200, contentType: 'text/event-stream' } });
assert(pageDiagnostics.watcherCompletions.join() === 'completion 200 text/event-stream', 'completion seen by the watcher is recorded');
assert(uiUpdates.length === 1 && backgroundMessages.length === 1, 'diagnostic messages never reach the usage path');

assert(typeof performanceCallback === 'function', 'sse_bridge observes resource timing');
performanceCallback({ getEntries: () => [
	{ name: 'https://claude.ai/api/organizations/o/chat_conversations/c/completion', initiatorType: 'fetch', responseStatus: 200 },
	{ name: 'https://claude.ai/api/organizations/o/chat_conversations/c?tree=True', initiatorType: 'fetch', responseStatus: 200 },
	{ name: 'https://claude.ai/api/organizations/o/chat_conversations/c/retry_completion?x=1', initiatorType: 'xmlhttprequest' }
] });
assert(pageDiagnostics.browserCompletions.join('; ') === 'fetch 200; xmlhttprequest', 'browser-recorded completions are counted with how they were made; other requests are not');

console.log(`\nAll ${passedTests} SSE stream tests passed.`);
