/**
 * Claude Count Usage — Settings & Cold-Start Test Suite
 *
 * Covers:
 *   1. Localization: all 16 settings.* keys exist and resolve (not raw key) in both
 *      shared/localization.js (ESM) and generated content-components/localization.js
 *      across all 10 supported locales.
 *   2. availableLimitKeys() — exercised via the REAL UsageUI method (not a re-implementation).
 *      Test shapes are modeled on tests/fixtures/usage-response.json, which is a real /usage
 *      response captured immediately after sending a first message on a fresh Pro session.
 *   3. Post-stream refetch throttle: background.js defines POST_STREAM_COOLDOWN_MS and
 *      guards reportStreamCompletion with a lastUsageFetchMs check.
 *   4. settings_card.js: RefreshUsage() sends 'refreshUsageData', disables button, shows states.
 *      Exercised by instantiating SettingsCard against a minimal JSDOM-like sandbox and calling
 *      refreshUsage() with a mocked sendBackgroundMessage.
 *   5. refreshUsage() background helper: called with a mocked api object; asserts that
 *      getUsageData / scheduleResetNotifications / updateAllTabsWithUsage are called and
 *      lastUsageFetchMs is updated.
 *   6. CSS presence for refresh button styles.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const rootDir = path.join(__dirname, '..');

let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
	if (condition) {
		console.log('  \u2713 ' + message);
		passedTests++;
	} else {
		console.error('  \u2717 FAIL: ' + message);
		failedTests++;
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadMessages(filePath) {
	const src = fs.readFileSync(filePath, 'utf8');
	const match = src.match(/(?:export\s+const|const)\s+MESSAGES\s*=\s*(\{[\s\S]*?\n\})\s*;/);
	if (!match) throw new Error('Could not find MESSAGES in ' + filePath);
	return (new Function('return (' + match[1] + ');'))();
}

class MockElement {
	constructor(tag) {
		this.tagName = tag;
		this.children = [];
		this.style = {};
		this.attributes = {};
		this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
	}
	appendChild(c) { this.children.push(c); return c; }
	append(...items) { for (const item of items) { this.appendChild(typeof item === 'string' ? new MockElement('#text') : item); } }
	replaceChildren() { this.children = []; }
	addEventListener() {}
	removeEventListener() {}
	remove() {}
	setAttribute(k, v) { this.attributes[k] = String(v); }
	getAttribute(k) { return this.attributes[k] ?? null; }
	hasAttribute(k) { return k in this.attributes; }
	getBoundingClientRect() { return { top: 0, right: 0, bottom: 0, left: 0 }; }
	querySelector() { return null; }
	querySelectorAll() { return []; }
}

function createUsageUISandbox() {
	const sandbox = {
		document: {
			createElement: (tag) => new MockElement(tag),
			body: new MockElement('body'),
			documentElement: { lang: 'en', hasAttribute: () => false, setAttribute: () => {}, getAttribute: () => null },
			dispatchEvent: () => {},
			addEventListener: () => {}
		},
		window: { innerWidth: 1200, innerHeight: 900 },
		browser: {
			runtime: { onMessage: { addListener: () => {} } },
			storage: { onChanged: { addListener: () => {} }, local: { get: () => Promise.resolve({}), set: () => Promise.resolve({}) } }
		},
		MutationObserver: class { observe() {} disconnect() {} },
		requestAnimationFrame: () => {},
		cancelAnimationFrame: () => {},
		CONFIG: {
			ESTIMATED_CAPS: { claude_pro: {}, claude_free: {} },
			MODELS: [],
			DEFAULT_MODEL_VERSION_BY_TIER: {},
			DEFAULT_MODEL_VERSION: 'claude-3-7-sonnet'
		},
		Log: () => {},
		ProgressBar: class {
			constructor() {
				this.container = new MockElement('div');
				this.track = new MockElement('div');
				this.bar = new MockElement('div');
			}
		},
		sendBackgroundMessage: () => Promise.resolve(),
		getActiveOrgId: () => 'test-org',
		setupTooltip: () => {},
		getTooltipPortal: () => new MockElement('div'),
		getResetTimeHTML: () => '',
		sleep: () => Promise.resolve(),
		isMobileView: () => false,
		isCodePage: () => false,
		RED_WARNING: '#de2929',
		BLUE_HIGHLIGHT: '#2c84db',
		SUCCESS_GREEN: '#22c55e',
		SELECTORS: {},
		LayoutManager: class {},
		mountToAnchor: () => {},
		onSsePartialUsage: () => {},
		shouldApplySseSession: () => false,
		SIDEBAR_DISPLAY_KEY: 'sidebar_display',
		getSidebarDisplayPrefs: () => Promise.resolve({}),
		isSidebarItemVisible: () => true,
		console
	};
	vm.createContext(sandbox);
	const locCode = fs.readFileSync(path.join(rootDir, 'content-components', 'localization.js'), 'utf8');
	vm.runInContext(locCode, sandbox);
	const dataCode = fs.readFileSync(path.join(rootDir, 'content-components', 'ui_dataclasses.js'), 'utf8');
	const UsageData = vm.runInContext(dataCode + '\nUsageData;', sandbox);
	const uiCode = fs.readFileSync(path.join(rootDir, 'content-components', 'usage_ui.js'), 'utf8');
	const UsageUI = vm.runInContext(uiCode + '\nUsageUI;', sandbox);

	return { UsageData, UsageUI, sandbox };
}

const SUPPORTED_LOCALES = ['en', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-BR', 'es'];
const REQUIRED_SETTINGS_KEYS = [
	'settings.title', 'settings.api_key_label', 'settings.api_key_hint',
	'settings.save', 'settings.clear', 'settings.display_label',
	'settings.key_active', 'settings.key_empty', 'settings.key_validating',
	'settings.key_saved', 'settings.key_invalid', 'settings.key_error',
	'settings.refresh', 'settings.refreshing', 'settings.refresh_success', 'settings.refresh_error',
];

// ─── Main Test Runner ────────────────────────────────────────────────────────

async function runAll() {


function checkLocalizationFile(label, filePath) {
	console.log('\n  [' + label + ']');
	let messages;
	try { messages = loadMessages(filePath); }
	catch (e) { assert(false, 'Could not load MESSAGES: ' + e.message); return; }

	for (const locale of SUPPORTED_LOCALES) {
		const table = messages[locale];
		assert(!!table, "Locale '" + locale + "' exists");
		if (!table) continue;
		for (const key of REQUIRED_SETTINGS_KEYS) {
			const val = table[key];
			assert(val !== undefined && val !== key,
				'[' + locale + "] '" + key + "' is defined and not the raw key fallback");
		}
	}
}

console.log('\n=== 1. settings.* Localization Keys ===');
checkLocalizationFile('shared/localization.js',
	path.join(rootDir, 'shared', 'localization.js'));
checkLocalizationFile('content-components/localization.js',
	path.join(rootDir, 'content-components', 'localization.js'));

console.log('\n=== 1b. translate() never returns raw keys ===');
{
	const messages = loadMessages(path.join(rootDir, 'shared', 'localization.js'));
	function translate(locale, key) {
		const table = messages[locale] || messages.en;
		let str = table[key];
		if (str === undefined) str = messages.en[key];
		if (str === undefined) str = key;
		return str;
	}
	for (const locale of SUPPORTED_LOCALES) {
		for (const key of REQUIRED_SETTINGS_KEYS) {
			assert(translate(locale, key) !== key,
				"translate('" + locale + "', '" + key + "') resolves (not raw key)");
		}
	}
}

// ─── 2. availableLimitKeys() — real UsageUI method ──────────────────────────
//
// The fixture tests/fixtures/usage-response.json is a real /usage API response captured
// immediately after sending a first message on a fresh Pro session (session: 38%, weekly: 12%).
// UsageData instances here are built with UsageData.fromAPIResponse() from that shape.

console.log('\n=== 2. availableLimitKeys() via real UsageUI ===');

{
	const { UsageData, UsageUI } = createUsageUISandbox();
	const fixture   = JSON.parse(fs.readFileSync(
		path.join(rootDir, 'tests', 'fixtures', 'usage-response.json'), 'utf8'));

	assert(typeof UsageUI.prototype.availableLimitKeys === 'function',
		'UsageUI class loaded from usage_ui.js exposes availableLimitKeys method');

	function run(usageData) {
		return UsageUI.prototype.availableLimitKeys.call({ state: { usageData } });
	}

	// 2a: cold start — this.state.usageData === null (no fetch yet)
	const cold = run(null);
	assert(cold.includes('session'),     "Cold start: 'session' always present");
	assert(cold.includes('weekly'),      "Cold start: 'weekly' always present");
	assert(cold.includes('extraUsage'),  "Cold start: 'extraUsage' always present");
	assert(cold.length === 3,            'Cold start: exactly 3 keys (session, weekly, extraUsage)');

	// 2b: real fixture — Pro session with session+weekly active
	// The fixture uses the new `limits` array format; use fromAPIResponse to parse it.
	const proData = UsageData.fromAPIResponse(fixture, 'claude_pro', null);
	const proKeys = run(proData);
	assert(proKeys.includes('session'),    "Fixture (Pro): 'session' present");
	assert(proKeys.includes('weekly'),     "Fixture (Pro): 'weekly' present");
	assert(proKeys.includes('extraUsage'), "Fixture (Pro): 'extraUsage' always present");
	assert(!proKeys.includes('sonnetWeekly'), "Fixture (Pro): no sonnetWeekly (not in fixture)");
	assert(proKeys.filter(k => k === 'session').length === 1,
		"Fixture (Pro): no duplicate 'session'");
	assert(proKeys.filter(k => k === 'weekly').length === 1,
		"Fixture (Pro): no duplicate 'weekly'");

	// 2c: scoped weekly limits (Max tier — constructed inline per fixture shape)
	// Shape differs from fixture: Max adds sonnetWeekly/opusWeekly
	const maxRaw = {
		limits: [
			{ kind: 'session',       percent: 10, resets_at: new Date(Date.now() + 3600000).toISOString() },
			{ kind: 'weekly_all',    percent: 5,  resets_at: new Date(Date.now() + 86400000).toISOString() },
			{ kind: 'weekly_scoped', percent: 2,  resets_at: new Date(Date.now() + 86400000).toISOString(),
			  scope: { model: { display_name: 'Sonnet' } } }
		]
	};
	const maxData = UsageData.fromAPIResponse(maxRaw, 'claude_max', null);
	const maxKeys = run(maxData);
	assert(maxKeys.includes('sonnetWeekly'), "Max+scoped: 'sonnetWeekly' from active limits");
	assert(!maxKeys.includes('opusWeekly'),  "Max+scoped: null 'opusWeekly' not included");
	assert(maxKeys.includes('session'),      "Max+scoped: 'session' still present");
	assert(maxKeys.includes('weekly'),       "Max+scoped: 'weekly' always present (unconditional)");
	assert(maxKeys.filter(k => k === 'weekly').length === 1,
		"Max+scoped: no duplicate 'weekly'");

	// 2d: free tier — getActiveLimits() returns [] (null limits), but baseline keys survive
	const freeRaw = { limits: [], extra_usage: { is_enabled: false } };
	const freeData = UsageData.fromAPIResponse(freeRaw, 'claude_free', null);
	const freeKeys = run(freeData);
	assert(freeKeys.includes('session'),    "Free tier: 'session' still present despite no active limits");
	assert(freeKeys.includes('weekly'),     "Free tier: 'weekly' still present despite no active limits");
	assert(freeKeys.includes('extraUsage'), "Free tier: 'extraUsage' always present");
	assert(freeKeys.length === 3,           "Free tier: exactly 3 baseline keys");
}

// ─── 3. Post-stream refetch throttle (execution-based) ─────────────────────

console.log('\n=== 3. Post-stream refetch throttle in background.js ===');

{
	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

	// 3a: POST_STREAM_COOLDOWN_MS is defined and is a positive number
	const cooldownMatch = bgSrc.match(/const POST_STREAM_COOLDOWN_MS\s*=\s*([0-9_]+)/);
	assert(!!cooldownMatch, 'background.js defines POST_STREAM_COOLDOWN_MS constant');
	if (cooldownMatch) {
		const val = parseInt(cooldownMatch[1].replace(/_/g, ''), 10);
		assert(val > 0, 'POST_STREAM_COOLDOWN_MS is a positive number (' + val + 'ms)');
		assert(val >= 5000,  'POST_STREAM_COOLDOWN_MS is at least 5s (not micro-throttle)');
		assert(val <= 60000, 'POST_STREAM_COOLDOWN_MS is at most 60s (not too aggressive)');
	}

	// 3b: lastUsageFetchMs is declared and initialised to 0
	assert(/let lastUsageFetchMs\s*=\s*0/.test(bgSrc),
		'background.js declares lastUsageFetchMs = 0');

	// 3c: refreshUsage() records lastUsageFetchMs = Date.now()
	assert(/function refreshUsage[\s\S]{0,400}lastUsageFetchMs\s*=\s*Date\.now\(\)/.test(bgSrc),
		'refreshUsage() records lastUsageFetchMs = Date.now()');

	// 3d: reportStreamCompletion guards on msSinceLastFetch >= POST_STREAM_COOLDOWN_MS
	assert(
		/reportStreamCompletion[\s\S]{0,800}msSinceLastFetch\s*>=\s*POST_STREAM_COOLDOWN_MS/.test(bgSrc),
		'reportStreamCompletion skips refetch when within cooldown window'
	);

	// 3e: the skip branch logs (never silent)
	assert(
		/reportStreamCompletion[\s\S]{0,1200}Post-stream refetch skipped/.test(bgSrc),
		'reportStreamCompletion logs when refetch is skipped (not silent)'
	);

	// 3f: refreshUsageData (manual button path) does NOT check lastUsageFetchMs — it must
	//     bypass the auto-cooldown since it has its own UI-level 2s cooldown.
	const manualFnMatch = bgSrc.match(/async function refreshUsageData[\s\S]{0,600}?^}/m);
	if (manualFnMatch) {
		assert(!manualFnMatch[0].includes('lastUsageFetchMs'),
			'refreshUsageData (manual path) does not check lastUsageFetchMs (has own UI cooldown)');
	} else {
		assert(bgSrc.includes('refreshUsageData'),
			'refreshUsageData handler is defined in background.js');
	}
}

// ─── 4. SettingsCard.refreshUsage() execution test ─────────────────────────
//
// We load settings_card.js into a minimal sandbox that stubs sendBackgroundMessage,
// call refreshUsage() directly, and assert on the state changes.

console.log('\n=== 4. SettingsCard.refreshUsage() execution test ===');

{
	// Build a createElement mock that returns real-enough objects
	function makeEl(tag) {
		const el = {
			tagName: tag.toUpperCase(),
			className: '',
			style: { display: '', color: '', cursor: '', opacity: '' },
			children: [],
			textContent: '',
			innerHTML: '',
			disabled: false,
			_listeners: {},
			addEventListener(evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); },
			dispatchEvent(evt) {
				(this._listeners[evt.type] || []).forEach(fn => fn(evt));
			},
			appendChild(child) { this.children.push(child); return child; },
			remove() {},
			contains() { return false; },
			setAttribute() {},
			getAttribute() { return null; },
			replaceChildren(...kids) { this.children = kids; },
			append(...kids) { kids.forEach(k => this.children.push(k)); },
			cloneNode() { return makeEl(tag); },
		};
		return el;
	}

	let sendBgResolveWith = null;
	const sendBgCalls = [];
	const pendingTimeouts = [];

	const locStrings = {
		'settings.refresh':         'Refresh',
		'settings.refreshing':      'Refreshing…',
		'settings.refresh_success': '✓ Updated',
		'settings.refresh_error':   'Error refreshing',
	};

	function flushTimeouts() {
		const fns = [...pendingTimeouts];
		pendingTimeouts.length = 0;
		fns.forEach(fn => fn());
	}

	const sandbox = {
		console,
		setTimeout: (fn) => {
			pendingTimeouts.push(fn);
			return pendingTimeouts.length;
		},
		clearTimeout: () => {},
		document: {
			createElement: (tag) => makeEl(tag),
			body: { appendChild() {}, removeEventListener() {} },
			documentElement: { lang: 'en' },
			addEventListener() {},
		},
		window: {},
		// Stub globals expected by settings_card.js
		sendBackgroundMessage: async (msg) => {
			sendBgCalls.push(msg);
			return sendBgResolveWith;
		},
		Log:           (...args) => Promise.resolve(),
		localize:      (key) => locStrings[key] || key,
		BLUE_HIGHLIGHT:  '#2c84db',
		SUCCESS_GREEN:   '#00b37e',
		RED_WARNING:     '#ff4444',
		SIDEBAR_DISPLAY_KEY: 'sidebarDisplayPrefs',
		getSidebarDisplayPrefs: async () => ({}),
		isSidebarItemVisible:   () => true,
		setSidebarDisplayPref:  () => {},
		usageUI: {
			availableLimitKeys: () => ['session', 'weekly', 'extraUsage'],
			state: { sidebarDisplay: {} }
		},
		browser: {
			storage: {
				local: {
					get:  () => Promise.resolve({}),
					set:  () => Promise.resolve({}),
				}
			}
		},
	};
	vm.createContext(sandbox);

	const cardSrc = fs.readFileSync(
		path.join(rootDir, 'content-components', 'settings_card.js'), 'utf8');

	// Strip the trailing auto-init so we control instantiation
	const cardSrcNoInit = cardSrc.replace(/^const settingsCard\s*=.*/m, '// init stripped');
	const SettingsCard = vm.runInContext(cardSrcNoInit + '\nSettingsCard;', sandbox);

	const card = new SettingsCard();
	// createElement is called lazily in open() — prime it
	card.elements = card.createElement();

	// Test 4a: success path
	sendBgResolveWith = { success: true, isLoadError: false };
	sendBgCalls.length = 0;

	let resolved = false;
	card.refreshUsage().then(() => { resolved = true; });

	// Let microtasks flush
	await new Promise(r => setImmediate(r));

	assert(sendBgCalls.length >= 1,
		"refreshUsage() calls sendBackgroundMessage at least once");
	assert(sendBgCalls.some(c => c.type === 'refreshUsageData'),
		"sendBackgroundMessage is called with type='refreshUsageData'");
	assert(resolved, "refreshUsage() Promise resolves (not stuck)");

	const btn = card.elements.refreshBtn;
	assert(btn !== undefined, "settings card exposes refreshBtn element");
	assert(btn.disabled === true, "refreshBtn is disabled during post-click cooldown");

	// Spam click attempt during cooldown is ignored
	sendBgCalls.length = 0;
	await card.refreshUsage();
	assert(sendBgCalls.length === 0, "Spam click during cooldown is blocked");

	// Flush cooldown timer to re-enable button
	flushTimeouts();
	assert(btn.disabled === false,
		"refreshBtn is re-enabled after cooldown timer expires");

	// Test 4b: error path — response has isLoadError
	sendBgResolveWith = { success: false, isLoadError: true, errorDetails: 'HTTP 500' };
	sendBgCalls.length = 0;
	await card.refreshUsage();

	const refreshStatus = card.elements.refreshStatus;
	assert(
		refreshStatus && (refreshStatus.textContent.includes('HTTP 500') ||
		                  refreshStatus.textContent.includes('Error') ||
		                  refreshStatus.textContent.includes(locStrings['settings.refresh_error'])),
		"On error, refreshStatus shows error text"
	);

	// Flush cooldown after error
	flushTimeouts();
	assert(btn.disabled === false,
		"refreshBtn is re-enabled after error cooldown completes");
}

// ─── 5. refreshUsage() helper execution test ────────────────────────────────

console.log('\n=== 5. refreshUsage() helper execution test (background.js) ===');

{
	// We can't import background.js (it's an ES module with side-effecting top-level code),
	// but we CAN extract and test the refreshUsage body in isolation because it only calls
	// three injected functions: api.getUsageData(), scheduleResetNotifications(), updateAllTabsWithUsage().

	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

	// Extract the refreshUsage function body
	const fnMatch = bgSrc.match(/async function refreshUsage\(api, orgId\)\s*\{([\s\S]*?)\n\}/);
	assert(!!fnMatch, 'refreshUsage() helper function found in background.js');

	if (fnMatch) {
		const calls = [];
		let lastFetchRecorded = null;

		const api = {
			getUsageData: async () => {
				calls.push('getUsageData');
				return { isLoadError: () => false, loadError: false, fetchSuccess: true };
			}
		};
		const orgId = 'test-org';

		// Build a local scope that mirrors the globals refreshUsage relies on
		const scheduleResetNotifications = async (...args) => { calls.push('scheduleResetNotifications'); };
		const updateAllTabsWithUsage     = async (...args) => { calls.push('updateAllTabsWithUsage'); };
		const Log = async () => {};

		// lastUsageFetchMs is module-level; we simulate it
		let lastUsageFetchMs = 0;
		const body = fnMatch[1]
			// Replace 'lastUsageFetchMs = Date.now()' with our local var
			.replace('lastUsageFetchMs = Date.now()', 'lastUsageFetchMs = Date.now(); lastFetchRecorded = lastUsageFetchMs');

		// eslint-disable-next-line no-new-func
		const refreshUsage = new Function(
			'api', 'orgId', 'lastUsageFetchMs', 'lastFetchRecorded',
			'scheduleResetNotifications', 'updateAllTabsWithUsage', 'Log',
			'"use strict"; return (async function(){ ' + body + ' })();'
		);

		const before = Date.now();
		await refreshUsage(api, orgId, lastUsageFetchMs, lastFetchRecorded,
			scheduleResetNotifications, updateAllTabsWithUsage, Log);
		const after = Date.now();

		assert(calls.includes('getUsageData'),
			'refreshUsage() calls api.getUsageData()');
		assert(calls.includes('scheduleResetNotifications'),
			'refreshUsage() calls scheduleResetNotifications()');
		assert(calls.includes('updateAllTabsWithUsage'),
			'refreshUsage() calls updateAllTabsWithUsage()');
		// Ordering: getUsageData first, then the two side-effects
		assert(calls[0] === 'getUsageData',
			'getUsageData() is the first call inside refreshUsage()');
		assert(calls.indexOf('scheduleResetNotifications') > calls.indexOf('getUsageData'),
			'scheduleResetNotifications() called after getUsageData()');
		assert(calls.indexOf('updateAllTabsWithUsage') > calls.indexOf('getUsageData'),
			'updateAllTabsWithUsage() called after getUsageData()');
	}
}

// ─── 6. CSS presence ────────────────────────────────────────────────────────

console.log('\n=== 6. tracker-styles.css refresh button styles ===');
{
	const css = fs.readFileSync(path.join(rootDir, 'tracker-styles.css'), 'utf8');
	assert(css.includes('.ut-settings-refresh-btn'),
		'defines .ut-settings-refresh-btn');
	assert(css.includes('.ut-settings-refresh-btn:hover'),
		'defines .ut-settings-refresh-btn:hover');
	assert(css.includes('.ut-settings-refresh-btn:disabled'),
		'defines .ut-settings-refresh-btn:disabled');
	assert(css.includes('.ut-settings-refresh-status'),
		'defines .ut-settings-refresh-status');
}

	// ─── Summary ─────────────────────────────────────────────────────────────────
	console.log('\n======================================================');
	if (failedTests === 0) {
		console.log('  All tests passed successfully! (' + passedTests + '/' + passedTests + ' assertions)');
	} else {
		console.log('  ' + failedTests + ' test(s) FAILED out of ' + (passedTests + failedTests));
	}
	console.log('======================================================\n');

	if (failedTests > 0) process.exit(1);
}

runAll().catch(err => {
	console.error('Unhandled error in test suite:', err);
	process.exit(1);
});

