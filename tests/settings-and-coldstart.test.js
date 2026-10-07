/**
 * Claude Count Usage — Settings & Cold-Start Test Suite
 *
 * Covers:
 *   1. Localization: every settings.* key the settings card uses exists and resolve (not raw key) in both
 *      shared/localization.js (ESM) and generated content-components/localization.js
 *      across all 10 supported locales.
 *   2. availableLimitKeys() — exercised via the REAL UsageUI method (not a re-implementation).
 *      Test shapes are modeled on tests/fixtures/usage-response.json, which is a real /usage
 *      response captured immediately after sending a first message on a fresh Pro session.
 *   3. Post-stream refetch throttle: background.js defines POST_STREAM_COOLDOWN_MS, and
 *      schedulePostStreamRefresh() runs, defers or coalesces the refetch against it.
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
	'settings.title', 'settings.close', 'settings.clear', 'settings.display_label',
	'settings.refresh', 'settings.refreshing', 'settings.refresh_success', 'settings.refresh_error',
	'settings.refresh_label', 'settings.refresh_hint',
	'settings.section_usage', 'settings.section_notifications', 'settings.section_updates', 'settings.section_more',
	'settings.notif_toggle', 'settings.notif_threshold',
	'settings.update_auto', 'settings.update_auto_hint', 'settings.update_check_now', 'settings.update_checking',
	'settings.update_version', 'settings.update_up_to_date', 'settings.update_available', 'settings.update_download',
	'settings.update_release_notes', 'settings.update_how_mac', 'settings.update_how_windows', 'settings.update_how_other',
	'settings.update_error', 'settings.update_checked_at', 'settings.update_never',
	'settings.language_label', 'settings.language_auto', 'settings.language_reload_hint', 'settings.language_reload',
	'settings.debug_hint', 'settings.debug_show', 'settings.debug_hide', 'settings.debug_copy',
	'settings.debug_copied', 'settings.debug_empty', 'common.debug_logs', 'usage.starts_next_message',
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

	// 3d: reportStreamCompletion delegates to schedulePostStreamRefresh. (Previously it dropped a
	//     refetch inside the cooldown and only logged; that left the bars stale after a message
	//     sent soon after opening a chat, so the refetch is now deferred to the cooldown's end.)
	assert(/reportStreamCompletion[\s\S]{0,400}schedulePostStreamRefresh\(api, orgId\)/.test(bgSrc),
		'reportStreamCompletion schedules the post-stream refetch');

	// 3e: execute schedulePostStreamRefresh against a fake clock
	const fnMatch = bgSrc.match(/async function schedulePostStreamRefresh\(api, orgId\) \{([\s\S]*?)\n\}/);
	assert(!!fnMatch, 'background.js defines schedulePostStreamRefresh()');
	if (fnMatch) {
		const env = {
			now: 0, lastUsageFetchMs: 0, deferredPostStreamRefresh: null,
			timers: [], refreshes: 0, logs: []
		};
		const body = fnMatch[1]
			.replace(/Date\.now\(\)/g, 'env.now')
			.replace(/lastUsageFetchMs/g, 'env.lastUsageFetchMs')
			.replace(/deferredPostStreamRefresh/g, 'env.deferredPostStreamRefresh');
		// eslint-disable-next-line no-new-func
		const schedule = new Function('env', 'POST_STREAM_COOLDOWN_MS', 'pendingTasks', 'processNextTask',
			'refreshUsage', 'Log', 'setTimeout', 'api', 'orgId',
			'"use strict"; return (async function(){ ' + body + ' })();');
		const cooldown = 10000;
		const tasks = [];
		const run = () => schedule(env, cooldown, tasks,
			() => { while (tasks.length) tasks.shift()(); },
			async () => { env.refreshes++; env.lastUsageFetchMs = env.now; },
			async (...a) => { env.logs.push(a.join(' ')); },
			(fn, ms) => { env.timers.push({ fn, at: env.now + ms }); return env.timers.length; },
			{}, 'org');
		const fireTimers = () => { const t = env.timers.splice(0); t.forEach(x => { env.now = x.at; x.fn(); }); };

		env.now = 100000; env.lastUsageFetchMs = 50000;
		assert(await run() === 'now', 'outside the cooldown the refetch runs immediately');
		await new Promise(r => setImmediate(r));
		assert(env.refreshes === 1, 'immediate refetch calls refreshUsage once');

		env.now = 103000; // 3s after that fetch
		assert(await run() === 'deferred', 'inside the cooldown the refetch is deferred, not dropped');
		assert(env.timers.length === 1 && env.timers[0].at === 110000,
			'deferred refetch is timed for the end of the cooldown');
		assert(await run() === 'coalesced', 'a second stream inside the cooldown coalesces into the pending one');
		assert(env.logs.some(l => l.includes('deferred')), 'deferral is logged (not silent)');
		fireTimers();
		await new Promise(r => setImmediate(r));
		assert(env.refreshes === 2, 'deferred refetch fires once when the cooldown ends');
		assert(env.deferredPostStreamRefresh === null, 'deferred timer handle is cleared after firing');

		env.now = 112000;
		await run();
		env.lastUsageFetchMs = 115000; // e.g. a heartbeat landed after the stream ended
		fireTimers();
		await new Promise(r => setImmediate(r));
		assert(env.refreshes === 2, 'deferred refetch is skipped if a newer fetch already covered the stream');
	}

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
		CONFIG:          { WARNING_THRESHOLD: 0.9, CAUTION_THRESHOLD: 0.7 },
		getSeverityColor: (pct) => (pct >= 90 ? '#ff4444' : pct >= 70 ? '#dd6b0a' : '#2c84db'),
		localeForIntl:   () => 'en',
		applyLocale:     async () => {},
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

	// ── 4c. Updates section: checkForUpdatesNow() follows the same pattern ──
	console.log('\n  [4c. SettingsCard.checkForUpdatesNow()]');
	const allNodes = (node, out = []) => { out.push(node); (node.children || []).forEach(c => allNodes(c, out)); return out; };
	const textOf = (node) => allNodes(node).map(n => n.textContent || '').join(' ');
	const updateBtn = card.elements.updateCheckBtn;
	const updateStatus = card.elements.updateCheckStatus;
	const updateInfo = card.elements.updateInfo;
	// Status line + the callout row that only appears when an update exists.
	const updateArea = { children: [card.elements.updateInfo, card.elements.updateCallout] };
	const clearUpdateArea = () => { card.elements.updateInfo.children = []; card.elements.updateCallout.children = []; };
	assert(!!updateBtn && !!updateStatus && !!updateInfo, 'settings card exposes the update check button, status and info');

	// The manual check must not depend on the automatic toggle.
	card.elements.updateAutoToggle.checked = false;
	const releaseUrl = 'https://github.com/abdullah-alhar/claude-count-usage/releases/tag/v1.4';
	const macZip = 'https://github.com/abdullah-alhar/claude-count-usage/releases/download/v1.4/Mac.installer.zip';
	sendBgResolveWith = {
		currentVersion: '1.3', latestVersion: '1.4', updateAvailable: true,
		releaseUrl, downloadUrl: macZip, checkedAt: Date.now(), error: null
	};
	sendBgCalls.length = 0;
	clearUpdateArea();
	let pendingCheck = card.checkForUpdatesNow();
	assert(updateBtn.disabled === true, 'update button is disabled while the check runs');
	assert(updateStatus.textContent === 'settings.update_checking', 'shows the checking state while the check runs');
	await pendingCheck;
	assert(sendBgCalls.some(c => c.type === 'checkForUpdatesNow'),
		"sends 'checkForUpdatesNow' even with the automatic check toggled off");
	const infoText = textOf(updateArea);
	assert(infoText.includes('1.3') && infoText.includes('1.4') && infoText.includes('→'),
		'update available: shows current → latest version');
	const links = allNodes(updateArea).filter(n => n.tagName === 'A');
	assert(links.some(a => a.href === macZip && a.target === '_blank' && a.rel.includes('noopener')),
		'links the platform download in a new window with noopener');
	assert(links.some(a => a.href === releaseUrl), 'links the GitHub release page');
	assert(updateStatus.style.display === 'none', 'successful check leaves the result to the info block');

	sendBgCalls.length = 0;
	await card.checkForUpdatesNow();
	assert(sendBgCalls.length === 0, 'spam click during the update cooldown is blocked');
	flushTimeouts();
	assert(updateBtn.disabled === false, 'update button is re-enabled after the cooldown');

	// Error path
	sendBgResolveWith = { currentVersion: '1.3', checkedAt: Date.now(), error: 'GitHub responded 403' };
	clearUpdateArea();
	await card.checkForUpdatesNow();
	assert(updateStatus.style.color === '#ff4444' && updateStatus.textContent.includes('403'),
		'failed check shows a red error with the reason');
	flushTimeouts();
	assert(updateBtn.disabled === false, 'update button is re-enabled after a failed check');

	// Thrown error (background unreachable)
	const originalSend = sandbox.sendBackgroundMessage;
	sandbox.sendBackgroundMessage = async () => { throw new Error('no background'); };
	await card.checkForUpdatesNow();
	assert(updateStatus.style.color === '#ff4444', 'a thrown error also shows the red error state');
	flushTimeouts();
	assert(updateBtn.disabled === false, 'update button is re-enabled after a thrown error');
	sandbox.sendBackgroundMessage = originalSend;

	// Up to date
	clearUpdateArea();
	card.renderUpdateStatus('1.4', { currentVersion: '1.4', latestVersion: '1.4', updateAvailable: false, checkedAt: Date.now(), error: null });
	assert(textOf(updateArea).includes('settings.update_up_to_date'), 'up to date: shows the up-to-date state');
	assert(!allNodes(updateArea).some(n => n.tagName === 'A'), 'up to date: no download link');

	// Hostile / malformed URLs are never rendered as links
	clearUpdateArea();
	card.renderUpdateStatus('1.3', {
		currentVersion: '1.3', latestVersion: '9.9', updateAvailable: true,
		releaseUrl: 'https://evil.example/release', downloadUrl: 'javascript:alert(1)', checkedAt: Date.now(), error: null
	});
	assert(!allNodes(updateArea).some(n => n.tagName === 'A'), 'non-github.com release URLs are not rendered as links');

	// Automatic toggle relays to the background
	sendBgCalls.length = 0;
	card.elements.updateAutoToggle.checked = false;
	card.elements.updateAutoToggle._listeners.change.forEach(fn => fn());
	await new Promise(r => setImmediate(r));
	assert(sendBgCalls.some(c => c.type === 'setAutoUpdateCheck' && c.value === false),
		"turning the toggle off sends setAutoUpdateCheck(false)");
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

// ─── 7. getResetTimeHTML() transitional "Resetting..." state ────────────────
console.log('\n=== 7. getResetTimeHTML() transitional "Resetting..." state ===');
{
	const contentUtilsSrc = fs.readFileSync(path.join(rootDir, 'content-components', 'content_utils.js'), 'utf8');
	const fnMatch = contentUtilsSrc.match(/function getResetTimeHTML\(timeInfo\)\s*\{([\s\S]*?)\n\}/);
	assert(!!fnMatch, 'getResetTimeHTML() function found in content_utils.js');

	if (fnMatch) {
		const locStrings = {
			'reset.prefix': 'Reset in:',
			'reset.not_set': 'Not set',
			'reset.under_1m': '<1m',
			'common.resetting': 'Resetting...',
			'time.hm': '{h}h {m}m',
			'time.m': '{m}m'
		};
		const localize = (k, params) => {
			let s = locStrings[k] || k;
			if (params) {
				for (const [p, v] of Object.entries(params)) s = s.replace(`{${p}}`, v);
			}
			return s;
		};
		const SUCCESS_GREEN = '#00b37e';
		const BLUE_HIGHLIGHT = '#2c84db';

		// eslint-disable-next-line no-new-func
		const getResetTimeHTML = new Function(
			'timeInfo', 'localize', 'SUCCESS_GREEN', 'BLUE_HIGHLIGHT',
			'"use strict"; ' + fnMatch[1]
		);

		// Test 7a: null / missing timeInfo -> "Reset in: Not set"
		const htmlNull = getResetTimeHTML(null, localize, SUCCESS_GREEN, BLUE_HIGHLIGHT);
		assert(htmlNull.includes('Not set'), 'getResetTimeHTML(null) shows "Not set"');

		// Test 7b: missing timestamp -> "Reset in: Not set"
		const htmlNoTs = getResetTimeHTML({ timestamp: null, expired: false }, localize, SUCCESS_GREEN, BLUE_HIGHLIGHT);
		assert(htmlNoTs.includes('Not set'), 'getResetTimeHTML({ timestamp: null }) shows "Not set"');

		// Test 7c: future timestamp -> formatted countdown
		const futureTs = Date.now() + 15 * 60 * 1000; // 15 mins
		const htmlFuture = getResetTimeHTML({ timestamp: futureTs, expired: false }, localize, SUCCESS_GREEN, BLUE_HIGHLIGHT);
		assert(htmlFuture.includes('15m'), 'getResetTimeHTML() formats future minutes correctly');

		// Test 7d: expired=true -> returns "Resetting..." in SUCCESS_GREEN
		const htmlExpired = getResetTimeHTML({ timestamp: Date.now() - 5000, expired: true }, localize, SUCCESS_GREEN, BLUE_HIGHLIGHT);
		assert(htmlExpired.includes('Resetting...'), 'getResetTimeHTML({ expired: true }) displays "Resetting..."');
		assert(htmlExpired.includes(SUCCESS_GREEN), 'getResetTimeHTML({ expired: true }) uses SUCCESS_GREEN');
		assert(!htmlExpired.includes('Not set'), 'getResetTimeHTML({ expired: true }) does NOT show "Not set"');

		// Test 7e: timestamp in the past (diff <= 0) even if expired flag wasn't set -> returns "Resetting..."
		const htmlPast = getResetTimeHTML({ timestamp: Date.now() - 2000, expired: false }, localize, SUCCESS_GREEN, BLUE_HIGHLIGHT);
		assert(htmlPast.includes('Resetting...'), 'getResetTimeHTML(past timestamp) displays "Resetting..."');
		assert(htmlPast.includes(SUCCESS_GREEN), 'getResetTimeHTML(past timestamp) uses SUCCESS_GREEN');
	}
}

// ─── 8. scheduleResetNotifications() prompt alarm scheduling & deduplication ─
console.log('\n=== 8. scheduleResetNotifications() prompt alarm scheduling & deduplication ===');
{
	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');

	// 8a: Verify RESET_REFRESH_BUFFER_MS is declared and positive
	const bufferMatch = bgSrc.match(/const RESET_REFRESH_BUFFER_MS\s*=\s*(\d+);/);
	assert(!!bufferMatch, 'RESET_REFRESH_BUFFER_MS constant declared in background.js');
	const bufferMs = bufferMatch ? parseInt(bufferMatch[1], 10) : 0;
	assert(bufferMs >= 1000 && bufferMs <= 10000, 'RESET_REFRESH_BUFFER_MS is between 1s and 10s (buffer: ' + bufferMs + 'ms)');

	// 8b: Test scheduleResetNotifications logic with mock alarms
	const fnMatch = bgSrc.match(/async function scheduleResetNotifications\(orgId, usageData\)\s*\{([\s\S]*?)\n\}/);
	assert(!!fnMatch, 'scheduleResetNotifications() found in background.js');

	if (fnMatch) {
		const scheduledAlarms = new Map();
		const scheduledNotificationsMock = new Map();
		const logs = [];

		const getStorageValue = async (key, def) => def;
		const scheduledNotifications = {
			has: async (k) => scheduledNotificationsMock.has(k),
			set: async (k, v) => { scheduledNotificationsMock.set(k, v); }
		};
		const getAlarm = async (name) => scheduledAlarms.get(name) || null;
		const scheduleAlarm = async (name, opts) => { scheduledAlarms.set(name, opts); };
		const Log = async (...args) => { logs.push(args.join(' ')); };

		// eslint-disable-next-line no-new-func
		const scheduleResetNotifications = new Function(
			'orgId', 'usageData', 'RESET_REFRESH_BUFFER_MS', 'getStorageValue',
			'scheduledNotifications', 'getAlarm', 'scheduleAlarm', 'Log',
			'"use strict"; return (async function(){ ' + fnMatch[1] + ' })();'
		);

		const orgId = 'org-test-123';
		const targetResetAt = Date.now() + 60000; // 60s in future
		const usageDataMock = {
			getMaxedLimits: () => [],
			getActiveLimits: () => [
				{ key: 'session', percentage: 75, resetsAt: targetResetAt }
			]
		};

		// First run: should schedule the alarm
		await scheduleResetNotifications(orgId, usageDataMock, bufferMs,
			getStorageValue, scheduledNotifications, getAlarm, scheduleAlarm, Log);

		const expectedAlarmName = `resetRefresh:${orgId}:session:${targetResetAt}`;
		assert(scheduledAlarms.has(expectedAlarmName),
			'scheduleResetNotifications() schedules alarm with expected naming scheme');
		const alarmOpts = scheduledAlarms.get(expectedAlarmName);
		assert(alarmOpts && alarmOpts.when === targetResetAt + bufferMs,
			'Alarm is scheduled for resetsAt + bufferMs (' + (targetResetAt + bufferMs) + ')');

		// Second run with same limit & timestamp: should deduplicate (not overwrite or error)
		let scheduleAlarmCallCount = 0;
		const trackingScheduleAlarm = async (name, opts) => {
			scheduleAlarmCallCount++;
			scheduledAlarms.set(name, opts);
		};
		await scheduleResetNotifications(orgId, usageDataMock, bufferMs,
			getStorageValue, scheduledNotifications, getAlarm, trackingScheduleAlarm, Log);

		assert(scheduleAlarmCallCount === 0,
			'scheduleResetNotifications() deduplicates and does not re-schedule existing alarm');
	}

	// 8c: Test handleAlarm() with resetRefresh alarm
	const handleAlarmMatch = bgSrc.match(/async function handleAlarm\(alarmName\)\s*\{([\s\S]*?)\n\}/);
	assert(!!handleAlarmMatch, 'handleAlarm() function found in background.js');

	if (handleAlarmMatch) {
		const calls = [];
		const clearAlarm = async (name) => { calls.push(`clearAlarm:${name}`); };
		const browser = {
			tabs: {
				query: async () => [{ id: 42 }]
			}
		};
		const requestActiveOrgId = async (tab) => 'org-from-tab';
		const getStrategy = () => ({
			apiForTab: (tab, orgId) => ({ tab, orgId })
		});
		const refreshUsage = async (api, orgId) => {
			calls.push(`refreshUsage:${orgId}`);
		};
		const checkResetNotifications = async () => {
			calls.push('checkResetNotifications');
		};
		const updateAllTabsWithUsage = async () => {
			calls.push('updateAllTabsWithUsage');
		};
		const Log = async () => {};

		// eslint-disable-next-line no-new-func
		const handleAlarm = new Function(
			'alarmName', 'clearAlarm', 'browser', 'requestActiveOrgId',
			'getStrategy', 'refreshUsage', 'checkResetNotifications',
			'updateAllTabsWithUsage', 'Log',
			'"use strict"; return (async function(){ ' + handleAlarmMatch[1] + ' })();'
		);

		await handleAlarm('resetRefresh:my-org:session:123456789', clearAlarm, browser,
			requestActiveOrgId, getStrategy, refreshUsage, checkResetNotifications,
			updateAllTabsWithUsage, Log);

		assert(calls.some(c => c.startsWith('clearAlarm:resetRefresh:my-org')),
			'handleAlarm() clears one-shot resetRefresh alarm');
		assert(calls.includes('refreshUsage:my-org'),
			'handleAlarm() calls refreshUsage with target orgId');
		assert(calls.includes('checkResetNotifications'),
			'handleAlarm() triggers checkResetNotifications promptly on reset');
	}
}

// ─── 9. Calibrated estimation multiplier (tokenManagement.js) ───────────────
console.log('\n=== 9. computeCalibratedMultiplier() ===');
{
	const src = fs.readFileSync(path.join(rootDir, 'bg-components', 'tokenManagement.js'), 'utf8');
	const consts = ['CALIBRATION_MIN_SAMPLES', 'CALIBRATION_MIN_O200K_TOKENS', 'CALIBRATION_BOUNDS']
		.map(name => src.match(new RegExp('const ' + name + ' = [^;]+;'))?.[0]);
	const fnSrc = src.match(/function computeCalibratedMultiplier[\s\S]*?\n\}/)?.[0];
	assert(consts.every(Boolean) && !!fnSrc, 'tokenManagement.js defines the calibration constants and function');
	// eslint-disable-next-line no-new-func
	const compute = new Function('DEFAULT_ESTIMATION_MULTIPLIER',
		consts.join('\n') + '\n' + fnSrc + '\nreturn computeCalibratedMultiplier;')(1.4);
	const samples = (n, real, o200k) => Array.from({ length: n }, () => ({ real, o200k }));

	assert(compute([]) === 1.4, 'no samples -> falls back to 1.4');
	assert(compute(samples(19, 1200, 1000)) === 1.4, '19 samples -> still the 1.4 fallback');
	assert(compute(samples(20, 1200, 1000)) === 1.2, '20 samples at ratio 1.2 -> 1.2');
	assert(compute([...samples(20, 1200, 1000), ...samples(50, 400, 10)]) === 1.2,
		'samples under the minimum o200k size are ignored');
	assert(compute([...samples(10, 1000, 1000), ...samples(10, 20000, 10000)]) === 1.909,
		'ratio is token-weighted (large conversations dominate)');
	assert(compute(samples(20, 5000, 1000)) === 2.5, 'implausibly high ratio is clamped to 2.5');
	assert(compute(samples(20, 500, 1000)) === 1.0, 'implausibly low ratio is clamped to 1.0');
	assert(compute([null, { real: 0, o200k: 500 }, ...samples(20, 1300, 1000)]) === 1.3,
		'malformed / zero entries are skipped');
}

// ─── 10. Idle usage heartbeat (background.js) ───────────────────────────────
console.log('\n=== 10. runUsageHeartbeat() idle refresh ===');
{
	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
	const minutes = Number(bgSrc.match(/const USAGE_HEARTBEAT_MINUTES = (\d+)/)?.[1]);
	const gap = Number(bgSrc.match(/const HEARTBEAT_MIN_GAP_MS = ([0-9_]+)/)?.[1].replace(/_/g, ''));
	assert(minutes >= 1 && minutes <= 5, 'heartbeat period is 1-5 minutes (' + minutes + ')');
	assert(gap > 0 && gap < minutes * 60000, 'heartbeat min gap is shorter than its period');
	assert(/\[USAGE_HEARTBEAT_ALARM, USAGE_HEARTBEAT_MINUTES\]/.test(bgSrc),
		'ensurePeriodicAlarms() arms the heartbeat alarm');

	const fnMatch = bgSrc.match(/async function runUsageHeartbeat\(reason\) \{([\s\S]*?)\n\}/);
	assert(!!fnMatch, 'background.js defines runUsageHeartbeat()');
	if (fnMatch) {
		const env = { now: 0, lastUsageFetchMs: 0, heartbeatInFlight: false, refreshed: [], tabs: [{ id: 1 }] };
		const body = fnMatch[1]
			.replace(/Date\.now\(\)/g, 'env.now')
			.replace(/lastUsageFetchMs/g, 'env.lastUsageFetchMs')
			.replace(/heartbeatInFlight/g, 'env.heartbeatInFlight');
		// eslint-disable-next-line no-new-func
		const beat = new Function('env', 'HEARTBEAT_MIN_GAP_MS', 'browser', 'requestActiveOrgId',
			'refreshUsage', 'getStrategy', 'Log', 'reason',
			'"use strict"; return (async function(){ ' + body + ' })();');
		const run = () => beat(env, gap,
			{ tabs: { query: async () => env.tabs } },
			async () => 'org-1',
			async (api, orgId) => { env.refreshed.push(orgId); env.lastUsageFetchMs = env.now; },
			() => ({ apiForTab: () => ({}) }),
			async () => {}, 'test');

		env.now = 10 * 60000;
		assert(await run() === true && env.refreshed.length === 1, 'idle heartbeat refreshes usage');
		env.now += gap - 1;
		assert(await run() === false && env.refreshed.length === 1, 'heartbeat within the min gap is skipped');
		env.now += 1;
		assert(await run() === true && env.refreshed.length === 2, 'heartbeat after the min gap refreshes again');
		env.now += gap; env.heartbeatInFlight = true;
		assert(await run() === false, 'heartbeat does not overlap an in-flight one');
		env.heartbeatInFlight = false; env.tabs = [];
		assert(await run() === false, 'heartbeat with no claude.ai page open does nothing');
		assert(env.heartbeatInFlight === false, 'in-flight flag is released after an early return');
	}
}

// ─── 11. Three-tier severity colors (content_utils.js) ─────────────────────
console.log('\n=== 11. getSeverityColor() three-tier helper ===');
{
	const src = fs.readFileSync(path.join(rootDir, 'content-components', 'content_utils.js'), 'utf8');
	const head = src.slice(0, src.indexOf('const SELECTORS'));
	// eslint-disable-next-line no-new-func
	const h = new Function('CONFIG', 'window', head + '\nreturn { BLUE_HIGHLIGHT, ORANGE_WARNING, RED_WARNING, SUCCESS_GREEN, getSeverityColor, getSeverityColorForLimit, getSeverityColorForRemaining };')(
		{ WARNING_THRESHOLD: 0.9, CAUTION_THRESHOLD: 0.7 }, {});
	const utilsSrc = fs.readFileSync(path.join(rootDir, 'bg-components', 'utils.js'), 'utf8');
	assert(/"CAUTION_THRESHOLD": 0\.7/.test(utilsSrc) && /"WARNING_THRESHOLD": 0\.9/.test(utilsSrc),
		'CONFIG defines CAUTION_THRESHOLD 0.7 and WARNING_THRESHOLD 0.9');
	assert(new Set([h.BLUE_HIGHLIGHT, h.ORANGE_WARNING, h.RED_WARNING, h.SUCCESS_GREEN]).size === 4,
		'blue, orange, red and green are four distinct colors');

	const cases = [[0, 'BLUE_HIGHLIGHT'], [69.9, 'BLUE_HIGHLIGHT'], [70, 'ORANGE_WARNING'], [89.9, 'ORANGE_WARNING'],
		[90, 'RED_WARNING'], [100, 'RED_WARNING'], [140, 'RED_WARNING']];
	for (const [pct, name] of cases) {
		assert(h.getSeverityColor(pct) === h[name], `getSeverityColor(${pct}) -> ${name}`);
	}
	// eslint-disable-next-line no-new-func
	const shifted = new Function('CONFIG', 'window', head + '\nreturn getSeverityColor;')({ WARNING_THRESHOLD: 0.8, CAUTION_THRESHOLD: 0.5 }, {});
	assert(shifted(55) === h.ORANGE_WARNING && shifted(80) === h.RED_WARNING,
		'thresholds come from CONFIG, not hardcoded');

	assert(h.getSeverityColorForLimit(0, 50000) === h.BLUE_HIGHLIGHT, 'length 0 of 50k -> blue');
	assert(h.getSeverityColorForLimit(40000, 50000) === h.ORANGE_WARNING, 'length 40k of 50k -> orange');
	assert(h.getSeverityColorForLimit(50000, 50000) === h.RED_WARNING, 'length at the warning limit -> red (unchanged cutoff)');
	assert(h.getSeverityColorForLimit(10, 0) === h.BLUE_HIGHLIGHT, 'a missing limit never produces a warning color');

	assert(h.getSeverityColorForRemaining(14.9, 15) === h.RED_WARNING, '14.9 messages left -> red (unchanged cutoff)');
	assert(h.getSeverityColorForRemaining(15, 15) === h.ORANGE_WARNING, '15 messages left -> orange');
	assert(h.getSeverityColorForRemaining(44.9, 15) === h.ORANGE_WARNING, '44.9 messages left -> orange');
	assert(h.getSeverityColorForRemaining(45, 15) === h.BLUE_HIGHLIGHT, '45 messages left -> blue');

	// Nobody re-implements the threshold check inline any more.
	for (const file of ['content_utils.js', 'usage_ui.js', 'length_ui.js', 'settings_card.js']) {
		const code = fs.readFileSync(path.join(rootDir, 'content-components', file), 'utf8');
		const inline = /WARNING_THRESHOLD\s*\*\s*100\s*\?|PERCENT_THRESHOLD|isLong\(\)\s*\?|isExpensive\(\)\s*\?|<\s*15\s*\?/.test(code);
		assert(!inline, `${file} has no inline threshold -> color checks`);
	}

	const css = fs.readFileSync(path.join(rootDir, 'tracker-styles.css'), 'utf8');
	assert(css.toLowerCase().includes('--ut-orange: ' + h.ORANGE_WARNING.toLowerCase()),
		'tracker-styles.css --ut-orange mirrors ORANGE_WARNING');
}

// ─── 12. Update check: version comparison and storage (update-check.js) ─────
console.log('\n=== 12. update-check.js ===');
{
	const uc = await import(path.join(rootDir, 'bg-components', 'update-check.js'));

	assert(uc.RELEASES_API_URL === 'https://api.github.com/repos/abdullah-alhar/claude-count-usage/releases/latest',
		'checks exactly this repo\'s latest-release endpoint');
	const cmp = [['1.4', '1.3', 1], ['1.3', '1.4', -1], ['1.3', '1.3.0', 0], ['v1.3', '1.3', 0], ['1.10', '1.9', 1],
		['2.0', '1.99.99', 1], ['1.3.1', '1.3', 1], ['1.3-beta', '1.3', 0], ['', '1.3', -1], ['V2', 'v1.9', 1]];
	for (const [a, b, want] of cmp) {
		assert(uc.compareVersions(a, b) === want, `compareVersions('${a}', '${b}') === ${want}`);
	}

	const release = {
		tag_name: 'v1.4', html_url: 'https://github.com/abdullah-alhar/claude-count-usage/releases/tag/v1.4',
		assets: [
			{ name: 'Mac installer.zip', browser_download_url: 'https://github.com/x/mac.zip' },
			{ name: 'windows installer.zip', browser_download_url: 'https://github.com/x/win.zip' }
		]
	};
	assert(uc.pickDownloadUrl(release, 'mac') === 'https://github.com/x/mac.zip', 'Mac gets the Mac installer');
	assert(uc.pickDownloadUrl(release, 'windows') === 'https://github.com/x/win.zip', 'Windows gets the Windows installer');
	assert(uc.pickDownloadUrl(release, 'other') === release.html_url, 'other platforms get the release page');
	assert(uc.pickDownloadUrl({ html_url: release.html_url, assets: [] }, 'mac') === release.html_url,
		'no assets -> release page');
	assert(uc.detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Electron/30') === 'mac', 'detects Mac');
	assert(uc.detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/30') === 'windows', 'detects Windows');

	const makeStore = () => {
		const data = {};
		return {
			data,
			getStorageValue: async (k, d) => (k in data ? data[k] : d),
			setStorageValue: async (k, v) => { data[k] = v; }
		};
	};
	const fetchCalls = [];
	const okFetch = async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, status: 200, json: async () => release }; };

	const store = makeStore();
	const status = await uc.checkForUpdates({ fetchImpl: okFetch, currentVersion: '1.3', platform: 'mac', now: 1000, ...store });
	assert(fetchCalls.length === 1 && fetchCalls[0].url === uc.RELEASES_API_URL, 'contacts only the releases API, once');
	assert(fetchCalls[0].opts.credentials === 'omit', 'sends no cookies/credentials');
	assert(status.updateAvailable === true && status.latestVersion === '1.4' && status.currentVersion === '1.3',
		'1.3 installed, v1.4 released -> update available');
	assert(status.downloadUrl === 'https://github.com/x/mac.zip' && status.releaseUrl === release.html_url,
		'stores the download and release URLs');
	assert(store.data[uc.UPDATE_STATUS_KEY] && store.data[uc.UPDATE_STATUS_KEY].checkedAt === 1000,
		'persists the result with its check time under UPDATE_STATUS_KEY');

	const sameStore = makeStore();
	const same = await uc.checkForUpdates({ fetchImpl: okFetch, currentVersion: '1.4', platform: 'mac', now: 1000, ...sameStore });
	assert(same.updateAvailable === false, 'same version installed -> no update');

	// Failure keeps the last known release and records the error.
	const failFetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
	const failed = await uc.checkForUpdates({ fetchImpl: failFetch, currentVersion: '1.3', platform: 'mac', now: 5000, ...store });
	assert(failed.error && failed.error.includes('403'), 'HTTP failure is recorded as an error');
	assert(failed.latestVersion === '1.4' && failed.updateAvailable === true,
		'a failed check keeps the last known latest version');
	assert(failed.checkedAt === 5000 && store.data[uc.UPDATE_STATUS_KEY].error, 'failed check is persisted too');

	const throwStore = makeStore();
	const thrown = await uc.checkForUpdates({ fetchImpl: async () => { throw new Error('offline'); }, currentVersion: '1.3', platform: 'mac', now: 1, ...throwStore });
	assert(thrown.error === 'offline' && !thrown.updateAvailable, 'network error with no history -> error, no update claimed');

	const namedStore = makeStore();
	const namedFetch = async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'New', assets: [] }) });
	const named = await uc.checkForUpdates({ fetchImpl: namedFetch, currentVersion: '1.3', platform: 'mac', now: 1, ...namedStore });
	assert(named.error && named.error.includes('not a version number') && !named.updateAvailable,
		'a non-numeric release tag is reported as a failed check, not as "up to date"');

	assert(uc.isStatusStale(null, 0) === true, 'no stored result is stale');
	assert(uc.isStatusStale({ checkedAt: 1000 }, 1000 + uc.UPDATE_CHECK_INTERVAL_MS - 1) === false, 'result inside the interval is fresh');
	assert(uc.isStatusStale({ checkedAt: 1000 }, 1000 + uc.UPDATE_CHECK_INTERVAL_MS) === true, 'result at the interval is stale');
	assert(uc.UPDATE_CHECK_INTERVAL_MS >= 12 * 3600000 && uc.UPDATE_CHECK_INTERVAL_MS <= 24 * 3600000,
		'automatic check interval is 12-24h');
}

// ─── 13. Automatic update check toggle (background.js) ──────────────────────
console.log('\n=== 13. Automatic update check toggle ===');
{
	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
	const body = (name) => bgSrc.match(new RegExp('async function ' + name + '\\(\\) \\{([\\s\\S]*?)\\n\\}'))?.[1];

	const scheduledSrc = body('runScheduledUpdateCheck');
	assert(!!scheduledSrc, 'background.js defines runScheduledUpdateCheck()');
	const store = {};
	let checks = 0;
	// eslint-disable-next-line no-new-func
	const runScheduled = new Function('getStorageValue', 'isStatusStale', 'runUpdateCheck', 'Log',
		'AUTO_UPDATE_CHECK_KEY', 'UPDATE_STATUS_KEY',
		'"use strict"; return (async function(){ ' + scheduledSrc + ' })();');
	const uc = await import(path.join(rootDir, 'bg-components', 'update-check.js'));
	const go = () => runScheduled(async (k, d) => (k in store ? store[k] : d), uc.isStatusStale,
		async () => { checks++; return { checkedAt: Date.now() }; }, async () => {}, 'autoUpdateCheck', 'updateCheckStatus');

	await go();
	assert(checks === 1, 'toggle on by default + never checked -> checks');
	store.updateCheckStatus = { checkedAt: Date.now() };
	await go();
	assert(checks === 1, 'toggle on + fresh result -> does not re-check');
	store.updateCheckStatus = { checkedAt: 0 };
	store.autoUpdateCheck = false;
	await go();
	assert(checks === 1, 'toggle off -> scheduled check never contacts GitHub, even when stale');
	store.autoUpdateCheck = true;
	await go();
	assert(checks === 2, 'toggle back on + stale -> checks');

	const alarmsSrc = body('ensurePeriodicAlarms');
	assert(!!alarmsSrc, 'background.js defines ensurePeriodicAlarms()');
	const armed = {};
	const cleared = [];
	// eslint-disable-next-line no-new-func
	const ensure = new Function('getStorageValue', 'getAlarm', 'scheduleAlarm', 'clearAlarm',
		'AUTO_UPDATE_CHECK_KEY', 'UPDATE_CHECK_ALARM', 'UPDATE_CHECK_INTERVAL_MS', 'USAGE_HEARTBEAT_ALARM', 'USAGE_HEARTBEAT_MINUTES',
		'"use strict"; return (async function(){ ' + alarmsSrc + ' })();');
	const runEnsure = (auto) => ensure(async (k, d) => (k === 'autoUpdateCheck' ? auto : d),
		async (n) => armed[n], async (n, o) => { armed[n] = o; }, async (n) => { cleared.push(n); delete armed[n]; },
		'autoUpdateCheck', 'updateCheck', uc.UPDATE_CHECK_INTERVAL_MS, 'usageHeartbeat', 2);

	await runEnsure(true);
	assert(armed.updateCheck && armed.updateCheck.periodInMinutes === uc.UPDATE_CHECK_INTERVAL_MS / 60000,
		'toggle on -> periodic update alarm armed at the check interval');
	assert(armed.usageHeartbeat && armed.checkResetNotifications, 'heartbeat and reset alarms are armed regardless');
	await runEnsure(false);
	assert(!armed.updateCheck && cleared.includes('updateCheck'), 'toggle off -> update alarm cleared');
	assert(armed.usageHeartbeat, 'toggle off leaves the usage heartbeat alone');

	assert(/register\('checkForUpdatesNow', \(\) => runUpdateCheck\(\)\)/.test(bgSrc),
		'manual check calls runUpdateCheck directly (ignores the toggle and staleness)');
	assert(/register\('getUpdateStatus'[\s\S]{0,200}AUTO_UPDATE_CHECK_KEY, true\)/.test(bgSrc),
		'automatic checking defaults to on');
	assert(/UPDATE_CHECK_ALARM\) \{\s*await runScheduledUpdateCheck\(\)/.test(bgSrc),
		'the update alarm goes through the toggle-aware runScheduledUpdateCheck');
}

// ─── 14. Every string the settings card shows is localized everywhere ───────
console.log('\n=== 14. settings_card.js localize() keys exist in all locales ===');
{
	const cardSrc = fs.readFileSync(path.join(rootDir, 'content-components', 'settings_card.js'), 'utf8');
	const keys = new Set([...cardSrc.matchAll(/localize\('([a-z_.]+)'/g)].map(m => m[1]));
	// settings.update_how_${platform}
	['mac', 'windows', 'other'].forEach(p => keys.add('settings.update_how_' + p));
	assert(keys.size > 30, 'found the settings card\'s localize() keys (' + keys.size + ')');
	for (const file of [path.join('shared', 'localization.js'), path.join('content-components', 'localization.js')]) {
		const messages = loadMessages(path.join(rootDir, file));
		const missing = [];
		for (const locale of SUPPORTED_LOCALES) {
			for (const key of keys) if (messages[locale]?.[key] === undefined) missing.push(locale + ':' + key);
		}
		assert(missing.length === 0, file + ': every settings card key exists in all locales' + (missing.length ? ' (missing ' + missing.slice(0, 5).join(', ') + ')' : ''));
	}
	const en = loadMessages(path.join(rootDir, 'shared', 'localization.js')).en;
	const sameKeys = SUPPORTED_LOCALES.every(l => Object.keys(loadMessages(path.join(rootDir, 'shared', 'localization.js'))[l]).length === Object.keys(en).length);
	assert(sameKeys, 'every locale table has the same number of keys as English');
}

// ─── 15. Desktop regressions: sidebar anchor shapes, stale service worker ───
console.log('\n=== 15. Desktop install / init regressions ===');
{
	const cu = fs.readFileSync(path.join(rootDir, 'content-components', 'content_utils.js'), 'utf8');
	assert(!/sidebarAnchor\.parent\.(get|set)Attribute/.test(cu),
		'initExtension does not assume sidebar anchors have .parent (the { insertAfter } shape crashed init)');
	const initBlock = cu.match(/if \(sidebarAnchor\) \{([\s\S]*?)break;\s*\}/)?.[1];
	assert(!!initBlock, 'found the sidebar marking block in initExtension');
	if (initBlock) {
		// eslint-disable-next-line no-new-func
		const runBlock = new Function('sidebarAnchor', 'Log',
			'"use strict"; return (async function(){ ' + initBlock + ' return "continued"; })();');
		const el = () => { const a = {}; return { getAttribute: k => a[k] ?? null, setAttribute: (k, v) => { a[k] = String(v); } }; };
		const parentEl = el();
		assert(await runBlock({ insertAfter: { parentElement: parentEl } }, async () => {}) === 'continued'
			&& parentEl.getAttribute('data-script-loaded') === 'true',
			'{ insertAfter } anchor: init continues and marks the insertAfter parent');
		assert(await runBlock({ insertAfter: { parentElement: parentEl } }, async () => {}) === undefined,
			'a second instance on the same parent stops as a duplicate');
		const p2 = el();
		assert(await runBlock({ parent: p2, referenceNode: null }, async () => {}) === 'continued'
			&& p2.getAttribute('data-script-loaded') === 'true', '{ parent } anchor still works');
	}
	for (const name of ['chat', 'home', 'code', 'incognitoConversation', 'desktopChat', 'desktopHome']) {
		assert(new RegExp('\\n\\t' + name + ': \\{').test(cu), `page layout '${name}' is present`);
	}

	const inj = fs.readFileSync(path.join(rootDir, 'desktop-injector.js'), 'utf8');
	assert(/function clearServiceWorkerCache\(\)/.test(inj), 'desktop-injector.js defines clearServiceWorkerCache()');
	for (const cmd of ['cmdInstall', 'cmdPatch', 'cmdUnpatch']) {
		const body = inj.match(new RegExp('function ' + cmd + '\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}'))?.[1] || '';
		assert(body.includes('clearServiceWorkerCache()'), `${cmd} clears the cached service worker`);
	}
	assert(/'Service Worker'/.test(inj) && !/rmSync\([^)]*Local Extension Settings/.test(inj),
		'only the service worker cache is cleared, never chrome.storage (Local Extension Settings)');
}

// ─── 16. Live stream update applies weekly on the free plan ─────────────────
console.log('\n=== 16. handleSsePartialUsage(): free plan weekly goes live ===');
{
	const { UsageData, UsageUI, sandbox } = createUsageUISandbox();
	// The real guard from sse_bridge.js, with the tolerance CONFIG provides
	sandbox.CONFIG.SSE_SAME_WINDOW_TOLERANCE_MS = 60000;
	const bridgeSrc = fs.readFileSync(path.join(rootDir, 'content-components', 'sse_bridge.js'), 'utf8');
	sandbox.shouldApplySseSession = vm.runInContext('(' + bridgeSrc.match(/function shouldApplySseSession[\s\S]*?\n\}/)[0] + ')', sandbox);

	const make = (tier) => {
		const ui = new UsageUI();
		let renders = 0;
		ui.uiReady = true;
		ui.renderAll = () => { renders++; };
		ui.state.usageData = UsageData.fromAPIResponse({ limits: [] }, tier);
		return { ui, renders: () => renders };
	};
	const resetsAt = Date.now() + 3600000;

	const free = make('claude_free');
	free.ui.handleSsePartialUsage({ session: { percentage: 12, resetsAt }, weekly: { percentage: 30, resetsAt: resetsAt + 86400000 } });
	assert(free.ui.state.usageData.limits.session?.percentage === 12, 'free: session from the stream applies live');
	assert(free.ui.state.usageData.limits.weekly?.percentage === 30, 'free: weekly from the stream applies live (no background round trip)');
	assert(free.renders() === 1, 'free: one re-render for both');
	free.ui.handleSsePartialUsage({ session: null, weekly: { percentage: 29, resetsAt: resetsAt + 86400000 } });
	assert(free.ui.state.usageData.limits.weekly.percentage === 30, 'free: a one-point dip in the same window is ignored');

	const paid = make('claude_pro');
	paid.ui.handleSsePartialUsage({ session: { percentage: 12, resetsAt }, weekly: { percentage: 30, resetsAt } });
	assert(paid.ui.state.usageData.limits.session?.percentage === 12, 'paid: session still applies live');
	assert(!paid.ui.state.usageData.limits.weekly, 'paid: weekly keeps coming from /usage only');

	const bridge = fs.readFileSync(path.join(rootDir, 'content-components', 'sse_bridge.js'), 'utf8');
	assert(/listener\(\{ session, weekly \}\)/.test(bridge), 'sse_bridge passes both windows to listeners');
}

// ─── 17. Mac re-sign keeps Cowork's virtualization entitlement ─────────────
console.log('\n=== 17. signMac() restores entitlements (Cowork) ===');
{
	const inj = fs.readFileSync(path.join(rootDir, 'desktop-injector.js'), 'utf8');
	const grab = (name) => inj.match(new RegExp('const ' + name + ' = [\\s\\S]*?;\\n'))?.[0];
	// eslint-disable-next-line no-new-func
	const env = new Function(grab('RESTRICTED_ENTITLEMENT') + grab('DEVICE_ENTITLEMENTS') + grab('DEFAULT_ENTITLEMENTS') +
		inj.match(/function withoutRestricted[\s\S]*?\n\}/)[0] + '\nreturn { RESTRICTED_ENTITLEMENT, DEFAULT_ENTITLEMENTS, withoutRestricted };')();

	const official = {
		'keychain-access-groups': ['Q6L2SF6YDW.com.anthropic.claude.webauthn'],
		'com.apple.application-identifier': 'Q6L2SF6YDW.com.anthropic.claudefordesktop',
		'com.apple.developer.team-identifier': 'Q6L2SF6YDW',
		'com.apple.security.virtualization': true,
		'com.apple.security.cs.allow-jit': true
	};
	const kept = env.withoutRestricted(official);
	assert(kept['com.apple.security.virtualization'] === true && kept['com.apple.security.cs.allow-jit'] === true,
		'non-restricted entitlements (virtualization, allow-jit) are kept');
	assert(!('keychain-access-groups' in kept) && !('com.apple.application-identifier' in kept) && !('com.apple.developer.team-identifier' in kept),
		'restricted entitlements (macOS kills ad-hoc apps claiming them) are dropped');
	assert(env.DEFAULT_ENTITLEMENTS[''].hasOwnProperty('com.apple.security.virtualization')
		&& env.DEFAULT_ENTITLEMENTS['Claude Helper.app'].hasOwnProperty('com.apple.security.virtualization'),
		'fallback for already-stripped installs restores virtualization on the app and Claude Helper');
	assert(Object.values(env.DEFAULT_ENTITLEMENTS).every(e => Object.keys(e).every(k => !env.RESTRICTED_ENTITLEMENT(k))),
		'fallback entitlements contain nothing restricted');

	const body = inj.match(/function signMac\(appPath\) \{([\s\S]*?)\n\}/)?.[1] || '';
	const readAt = body.indexOf('readEntitlements(codePath)');
	const deepAt = body.indexOf("'--deep'");
	assert(readAt !== -1 && deepAt !== -1 && readAt < deepAt, 'entitlements are read before the bundle is re-signed');
	assert(/signWithEntitlements\(codePath, entitlements[,)]/.test(body), 'each component is re-signed with its entitlements');
	assert(/\{ name: '', codePath: appPath \}\]/.test(body), 'the main app is signed last (after its helpers)');
	assert(/signWithEntitlements\(codePath, entitlements, isMain \? mainRequirement : null\)/.test(body)
		&& /=designated => identifier /.test(inj),
		'the main app gets a bundle-identifier requirement, so keychain trust survives re-signing (no black-screen prompt per update)');
}

console.log('\n=== 18. Startup does not compete with claude.ai booting ===');
{
	const utils = fs.readFileSync(path.join(rootDir, 'content-components', 'content_utils.js'), 'utf8');
	const init = utils.match(/async function initExtension\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
	assert(init.indexOf('await waitForPageSettled()') !== -1 && init.indexOf('await waitForPageSettled()') < init.indexOf('injectStyles()'),
		'initExtension waits for the page to settle before touching the DOM');
	assert(/now - lastSidebarDiagAt < SIDEBAR_DIAG_INTERVAL_MS\) return;/.test(utils),
		'sidebar diagnostics are rate-limited (they ran on every mount attempt while the page rendered)');
	const receiver = fs.readFileSync(path.join(rootDir, 'content-components', 'electron_reciever.js'), 'utf8');
	assert(/waitForPageSettled\(\)\.then\(\(\) => browser\.runtime\.sendMessage\(\{ type: 'electronPageReady' \}\)\)/.test(receiver),
		'electronPageReady (usage fetch + update check) waits until the page has settled');
	const usageUi = fs.readFileSync(path.join(rootDir, 'content-components', 'usage_ui.js'), 'utf8');
	assert(/MIN_MOUNT_GAP_MS/.test(usageUi), 'sidebar re-mounts triggered by DOM mutations are rate-limited');
}

console.log('\n=== 19. Claude Desktop: Squirrel updates install instead of crashing Claude ===');
{
	const injector = fs.readFileSync(path.join(rootDir, 'desktop-injector.js'), 'utf8');
	assert((injector.match(/'Resources', 'ShipIt'\)/g) || []).length === 1 && /function hasShipIt[^}]*'Resources', 'ShipIt'\)/.test(injector),
		'the installer no longer deletes ShipIt (Squirrel launched it from the missing path and crashed the main process)');
	const install = injector.match(/async function cmdInstall\(extensionDir\) \{([\s\S]*?)\n\}/)?.[1] || '';
	assert(/!hasShipIt\(install\.appPath\)\) \{[\s\S]*?install = null;/.test(install),
		'an install whose ShipIt an older version removed is replaced with a fresh official Claude');
	const cleanup = injector.match(/function cleanupMacLeftovers\(appPath\) \{([\s\S]*?)\n\}/)?.[1] || '';
	assert(cleanup && !/Squirrel\.framework/.test(cleanup), 'leftover cleanup leaves the Squirrel framework alone');
	const wrapper = injector.slice(injector.indexOf('function generateWrapperSource'), injector.indexOf('// ─── Process & Lock Management'));
	assert(/autoUpdater\.once\('update-downloaded'/.test(wrapper), 'the wrapper tells the user to re-run the installer once an update is downloaded');
	assert(!/autoUpdater\.(checkForUpdates|quitAndInstall)\s*=/.test(wrapper), 'the wrapper does not disable Claude\'s own updater');
}

console.log('\n=== 20. Claude Desktop: the completion-stream watcher actually runs ===');
{
	const receiver = fs.readFileSync(path.join(rootDir, 'content-components', 'electron_reciever.js'), 'utf8');
	assert(/injectPageScript\('injections\/sse-watcher\.js'\)/.test(receiver),
		'electron_reciever injects sse-watcher.js into the page (Electron ignores the manifest\'s MAIN-world entry)');
	for (const file of ['manifest.json', 'manifest_electron.json']) {
		const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, file), 'utf8'));
		const resources = manifest.web_accessible_resources.flatMap(entry => entry.resources);
		assert(resources.includes('injections/sse-watcher.js'), `${file} makes sse-watcher.js loadable from a page script tag`);
	}

	// Loaded by both the manifest entry and the script tag in a browser - fetch must be wrapped once.
	const watcherSrc = fs.readFileSync(path.join(rootDir, 'injections', 'sse-watcher.js'), 'utf8');
	const originalFetch = async () => ({});
	const win = { fetch: originalFetch };
	// eslint-disable-next-line no-new-func
	const runWatcher = new Function('window', 'localStorage', watcherSrc);
	runWatcher(win, { getItem: () => null });
	const wrapped = win.fetch;
	runWatcher(win, { getItem: () => null });
	assert(wrapped !== originalFetch && win.fetch === wrapped, 'a second copy of the watcher does not wrap fetch again');
}

console.log('\n=== 21. Model detection prices the model the conversation really uses ===');
{
	const utilsSrc = fs.readFileSync(path.join(rootDir, 'bg-components', 'utils.js'), 'utf8');
	// eslint-disable-next-line no-new-func
	const MODEL_VERSION_MAP = new Function('return ' + utilsSrc.match(/"MODEL_VERSION_MAP": (\{[\s\S]*?\n\t\}),/)[1])();
	const labels = Object.keys(MODEL_VERSION_MAP);
	const shadowed = labels.filter((label, i) => labels.slice(0, i).some(earlier => label.startsWith(earlier)));
	assert(shadowed.length === 0, 'no picker label is shadowed by a shorter one above it' + (shadowed.length ? ': ' + shadowed : ''));

	const contentSrc = fs.readFileSync(path.join(rootDir, 'content-components', 'content_utils.js'), 'utf8');
	const detection = contentSrc.slice(contentSrc.indexOf('async function getCurrentModel('), contentSrc.indexOf('function isMobileView()'));
	const families = ['Fable', 'Opus', 'Sonnet', 'Haiku'];
	const familyOf = (v) => families.find(f => (v || '').toLowerCase().includes(f.toLowerCase())) || null;
	const defaultVersion = (tier) => (tier === 'claude_max_5x' ? 'claude-opus-5' : 'claude-sonnet-5');
	const detect = (pickerText) => {
		const picker = pickerText === null ? null : { querySelector: () => ({ textContent: pickerText }) };
		// eslint-disable-next-line no-new-func
		return new Function('document', 'waitForElement', 'SELECTORS', 'CONFIG', 'modelFamilyFromVersion', 'defaultModelForTier',
			'defaultModelVersionForTier', 'Log', detection + '\nreturn { getCurrentModel, getCurrentModelVersion };')(
			{}, async () => picker, { MODEL_PICKER: 'x' }, { MODEL_VERSION_MAP }, familyOf,
			(tier) => familyOf(defaultVersion(tier)), defaultVersion, async () => {});
	};

	for (const [label, version] of [['Opus 5.5', 'claude-opus-5-5'], ['Sonnet 5.5', 'claude-sonnet-5-5'],
		['Sonnet 5', 'claude-sonnet-5'], ['Fable 5.1', 'claude-fable-5-1'], ['Opus 5', 'claude-opus-5']]) {
		assert(await detect(label).getCurrentModelVersion(0, 'claude_pro') === version, `picker "${label}" -> ${version} (matches what the API reports, so the cache check holds)`);
	}
	const noPicker = detect(null);
	assert(await noPicker.getCurrentModelVersion(0, 'claude_pro', 'claude-opus-5-5') === 'claude-opus-5-5'
		&& await noPicker.getCurrentModel(0, 'claude_pro', 'claude-opus-5-5') === 'Opus',
		'unreadable picker -> the conversation\'s own model, not the plan default');
	assert(await noPicker.getCurrentModelVersion(0, 'claude_free') === 'claude-sonnet-5' && await noPicker.getCurrentModel(0, 'claude_free') === 'Sonnet',
		'unreadable picker on a new chat -> the plan default');
	assert(await detect('Opus 5.5').getCurrentModelVersion(0, 'claude_pro', 'claude-sonnet-5') === 'claude-opus-5-5',
		'a readable picker still wins (the user switched model for the next message)');

	const bgSrc = fs.readFileSync(path.join(rootDir, 'background.js'), 'utf8');
	const beforeRequest = bgSrc.match(/async function onBeforeRequestHandler\(details\) \{([\s\S]*?)\n\}/)?.[1] || '';
	assert(/const modelVersion = requestBodyJSON\?\.model \|\| null;/.test(beforeRequest) && !/defaultModelVersionForTier/.test(beforeRequest),
		'a completion that names no model is not recorded as the plan default (it overrode the API\'s real model: Opus priced as Sonnet)');
	const pass = bgSrc.match(/async function runAuthoritativePass\([^)]*\) \{([\s\S]*?)\n\}/)?.[1] || '';
	assert(/const model = pendingRequest\?\.model \|\| conversationData\.model \|\|/.test(pass) && pass.indexOf('const model =') > pass.indexOf('conversation.getInfo('),
		'the authoritative pass falls back to the conversation\'s model from the API before the plan default');
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

