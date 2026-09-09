/**
 * Claude Count Usage - Test Suite for Usage Notice & Dataclass Behavior
 *
 * Covers:
 *   1. Dataclass layer: shared/dataclasses.js (ESM) & content-components/ui_dataclasses.js (Global)
 *      - loadError, fetchSuccess, errorDetails tracking
 *      - isLoadError() and isGenuineZeroUsage() logic
 *      - toJSON() / fromJSON() serialization roundtrips
 *   2. Real UI layer: content-components/usage_ui.js (UsageSection.prototype.renderNotice)
 *      - State A: Genuine zero usage -> neutral muted "Reset" notice
 *      - State B: Missing data / load error -> prominent warning notice
 *      - Normal usage -> notice dismissed
 *      - Dynamic state transitions on the same DOM container
 *
 * NOTE ON ANTHROPIC /usage API RESPONSE SHAPES:
 * Anthropic's GET /api/organizations/{orgId}/usage endpoint returns a unified JSON object that
 * historically used top-level fields:
 *   {
 *     five_hour: { utilization: 0, resets_at: "..." },
 *     seven_day: { utilization: 0, resets_at: "..." },
 *     seven_day_sonnet: null,
 *     seven_day_opus: null
 *   }
 * Newer backend versions provide an authoritative limits array alongside or instead:
 *   {
 *     limits: [
 *       { kind: "session", percent: 0, resets_at: "..." },
 *       { kind: "weekly_all", percent: 0, resets_at: "..." },
 *       { kind: "weekly_scoped", percent: 0, resets_at: "...", scope: { model: { display_name: "Sonnet" } } }
 *     ]
 *   }
 * In production, the API frequently returns BOTH formats concurrently for backwards compatibility.
 * When `limits` is an array with entries, UsageData parses `limits`. When `limits` is empty or missing,
 * it falls back to the top-level five_hour/seven_day fields.
 * On the free plan (claude_free), Anthropic returns HTTP 200 with `limits: []` and all top-level
 * limit fields set to `null`.
 * All tests below verify against these real Anthropic response shapes.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rootDir = path.join(__dirname, '..');

// Mock browser globals needed by ESM imports
globalThis.chrome = {
	storage: {
		local: {
			get: () => Promise.resolve({}),
			set: () => Promise.resolve({})
		}
	}
};
globalThis.browser = globalThis.chrome;

process.on('unhandledRejection', (err) => {
	console.error('\nTest suite failed with unhandled rejection:\n', err);
	process.exit(1);
});

process.on('uncaughtException', (err) => {
	console.error('\nTest suite failed with uncaught exception:\n', err);
	process.exit(1);
});

let totalTests = 0;
let passedTests = 0;

function assert(condition, message) {
	totalTests++;
	if (!condition) {
		console.error(`  ✗ FAILED: ${message}`);
		throw new Error(message);
	}
	passedTests++;
	console.log(`  ✓ ${message}`);
}

// ─── Minimal DOM Mock for VM Execution ──────────────────────────────────────

class ClassList {
	constructor(el) { this.el = el; }
	add(...cls) {
		const parts = (this.el.className || '').split(/\s+/).filter(Boolean);
		for (const c of cls) if (!parts.includes(c)) parts.push(c);
		this.el.className = parts.join(' ');
	}
	remove(...cls) {
		const parts = (this.el.className || '').split(/\s+/).filter(Boolean);
		this.el.className = parts.filter(c => !cls.includes(c)).join(' ');
	}
	contains(c) {
		return (this.el.className || '').split(/\s+/).includes(c);
	}
	toggle(c, force) {
		if (force !== undefined) {
			if (force) this.add(c); else this.remove(c);
		} else {
			if (this.contains(c)) this.remove(c); else this.add(c);
		}
	}
}

class MockElement {
	constructor(tagName) {
		this.tagName = tagName;
		this.className = '';
		this.children = [];
		this.style = {};
		this.dataset = {};
		this.attributes = {};
		this.classList = new ClassList(this);
		this.parent = null;
		this.textContent = '';
	}

	appendChild(child) {
		child.parent = this;
		this.children.push(child);
		return child;
	}

	append(...items) {
		for (const item of items) {
			if (typeof item === 'string') {
				const textNode = new MockElement('#text');
				textNode.textContent = item;
				this.appendChild(textNode);
			} else if (item instanceof MockElement) {
				this.appendChild(item);
			}
		}
	}

	replaceChildren(...items) {
		this.children = [];
		this.textContent = '';
		this.append(...items);
	}

	remove() {
		if (this.parent) {
			const idx = this.parent.children.indexOf(this);
			if (idx !== -1) {
				this.parent.children.splice(idx, 1);
			}
			this.parent = null;
		}
	}

	querySelector(selector) {
		for (const child of this.children) {
			if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
			if (child.tagName.toLowerCase() === selector.toLowerCase()) return child;
			const nested = child.querySelector(selector);
			if (nested) return nested;
		}
		return null;
	}

	querySelectorAll(selector) {
		const results = [];
		for (const child of this.children) {
			if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) results.push(child);
			results.push(...child.querySelectorAll(selector));
		}
		return results;
	}

	setAttribute(k, v) { this.attributes[k] = String(v); }
	getAttribute(k) { return this.attributes[k] ?? null; }
	hasAttribute(k) { return k in this.attributes; }
	addEventListener() {}
	removeEventListener() {}
}

const mockDocument = {
	createElement: (tag) => new MockElement(tag),
	body: new MockElement('body'),
	documentElement: {
		lang: 'en',
		hasAttribute: () => false,
		setAttribute: () => {},
		getAttribute: () => null
	}
};

class MockProgressBar {
	constructor() {
		this.container = new MockElement('div');
		this.track = new MockElement('div');
		this.bar = new MockElement('div');
	}
}

// ─── Environment Setup for Real UI Execution ────────────────────────────────

function createUISandbox() {
	const sandbox = {
		document: mockDocument,
		window: { innerWidth: 1200, innerHeight: 900 },
		browser: {
			runtime: { onMessage: { addListener: () => {} } },
			storage: {
				onChanged: { addListener: () => {} },
				local: {
					get: () => Promise.resolve({}),
					set: () => Promise.resolve({})
				}
			}
		},
		MutationObserver: class {
			observe() {}
			disconnect() {}
		},
		requestAnimationFrame: () => {},
		cancelAnimationFrame: () => {},
		CONFIG: {
			ESTIMATED_CAPS: {
				claude_pro: { session: 45000, weekly: 150000 },
				claude_free: {}
			},
			MODELS: ['Opus', 'Sonnet', 'Haiku'],
			DEFAULT_MODEL_VERSION_BY_TIER: {},
			DEFAULT_MODEL_VERSION: 'claude-3-5-sonnet-20241022'
		},
		Log: () => {},
		ProgressBar: MockProgressBar,
		sendBackgroundMessage: () => Promise.resolve(),
		getActiveOrgId: () => 'test-org-123',
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

	// 1. Evaluate localization
	const locCode = fs.readFileSync(path.join(rootDir, 'content-components', 'localization.js'), 'utf8');
	vm.runInContext(locCode, sandbox);

	// 2. Evaluate ui_dataclasses
	const dataCode = fs.readFileSync(path.join(rootDir, 'content-components', 'ui_dataclasses.js'), 'utf8');
	const UsageData = vm.runInContext(dataCode + '\nUsageData;', sandbox);

	// 3. Evaluate usage_ui.js (the actual shipped code) and extract UsageSection
	const uiCode = fs.readFileSync(path.join(rootDir, 'content-components', 'usage_ui.js'), 'utf8');
	const UsageSection = vm.runInContext(uiCode + '\nUsageSection;', sandbox);

	return { sandbox, UsageData, UsageSection };
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

async function runDataclassTests(UsageData, suiteLabel) {
	console.log(`\n=== Testing Dataclass Layer: ${suiteLabel} ===`);

	// Test 1: API Error responses (HTTP 500, network error)
	const httpError = UsageData.fromAPIResponse({ status: 500 }, 'claude_pro');
	assert(httpError.isLoadError() === true, 'HTTP 500 sets isLoadError() === true');
	assert(httpError.loadError === true, 'HTTP 500 sets loadError flag');
	assert(httpError.fetchSuccess === false, 'HTTP 500 sets fetchSuccess === false');
	assert(httpError.isGenuineZeroUsage() === false, 'HTTP 500 is not genuine zero usage');
	assert(httpError.errorDetails.includes('500'), 'HTTP 500 sets errorDetails');

	const payloadError = UsageData.fromAPIResponse({ error: { message: 'Unauthorized' } }, 'claude_pro');
	assert(payloadError.isLoadError() === true, 'Error payload sets isLoadError() === true');
	assert(payloadError.errorDetails === 'Unauthorized', 'Error message preserved in errorDetails');

	const nullError = UsageData.fromAPIResponse(null, 'claude_free');
	assert(nullError.isLoadError() === true, 'Null API response sets isLoadError() === true');

	// Test 2: Healthy Free Tier with Empty Limits (Anthropic 200 with limits: [])
	const freeEmpty = UsageData.fromAPIResponse({ limits: [] }, 'claude_free');
	assert(freeEmpty.isLoadError() === false, 'Free tier empty limits is not a load error');
	assert(freeEmpty.loadError === false, 'Free tier loadError === false');
	assert(freeEmpty.fetchSuccess === true, 'Free tier fetchSuccess === true');
	assert(freeEmpty.hasNoReportedUsage() === true, 'Free tier hasNoReportedUsage() === true');
	assert(freeEmpty.isGenuineZeroUsage() === true, 'Free tier with empty limits is genuine zero usage');

	// Test 3: Healthy Paid Tier with active limits at 0% (New Array format)
	const paidNewZero = UsageData.fromAPIResponse({
		limits: [
			{ kind: 'session', percent: 0, resets_at: null },
			{ kind: 'weekly_all', percent: 0, resets_at: null }
		]
	}, 'claude_pro');
	assert(paidNewZero.isLoadError() === false, 'Paid tier with limits is not a load error');
	assert(paidNewZero.hasNoReportedUsage() === false, 'Paid tier has reported limits');
	assert(paidNewZero.isGenuineZeroUsage() === true, 'Paid tier with 0% limits is genuine zero usage');

	// Test 4: Healthy Paid Tier with active limits at 0% (Legacy Top-level format)
	const paidLegacyZero = UsageData.fromAPIResponse({
		five_hour: { utilization: 0, resets_at: null },
		seven_day: { utilization: 0, resets_at: null }
	}, 'claude_pro');
	assert(paidLegacyZero.isLoadError() === false, 'Legacy format is not a load error');
	assert(paidLegacyZero.isGenuineZeroUsage() === true, 'Legacy format 0% is genuine zero usage');

	// Test 5: Dual Format (Both new limits array and legacy fields present concurrently)
	const paidDualShape = UsageData.fromAPIResponse({
		limits: [
			{ kind: 'session', percent: 25, resets_at: null },
			{ kind: 'weekly_all', percent: 50, resets_at: null }
		],
		five_hour: { utilization: 25, resets_at: null },
		seven_day: { utilization: 50, resets_at: null }
	}, 'claude_pro');
	assert(paidDualShape.isLoadError() === false, 'Dual format handled cleanly');
	assert(paidDualShape.isGenuineZeroUsage() === false, 'Dual format with non-zero usage is not zero usage');
	assert(paidDualShape.limits.session.percentage === 25, 'Dual format parsed session percentage correctly');

	// Test 6: Serialization roundtrip
	const serialized = JSON.stringify(httpError);
	const restored = UsageData.fromJSON(JSON.parse(serialized));
	assert(restored.loadError === true, 'fromJSON restores loadError');
	assert(restored.fetchSuccess === false, 'fromJSON restores fetchSuccess');
	assert(restored.isLoadError() === true, 'fromJSON preserves isLoadError()');
	assert(restored.errorDetails === httpError.errorDetails, 'fromJSON preserves errorDetails');
}

function runRealUINoticeTests(UsageData, UsageSection) {
	console.log('\n=== Testing Real UI Notice: content-components/usage_ui.js (UsageSection) ===');

	const section = new UsageSection();
	assert(section.notice === null, 'Initial state has no notice');

	// ─── Scenario 1: State A - Genuine Zero Usage on Free Tier ───
	// Fresh session or reset where Anthropic reports limits: []
	const freeZero = UsageData.fromAPIResponse({ limits: [] }, 'claude_free');
	section.renderNotice(freeZero);

	assert(section.notice !== null, 'Notice created for free tier with no reported limits');
	assert(
		section.notice.className.includes('ut-usage-notice-reset'),
		'State A uses ut-usage-notice-reset class'
	);
	assert(
		!section.notice.className.includes('ut-usage-notice-error'),
		'State A does NOT have ut-usage-notice-error class'
	);

	const resetTextEl = section.notice.querySelector('.ut-usage-reset-text');
	assert(resetTextEl !== null, 'State A contains .ut-usage-reset-text element');
	assert(
		resetTextEl.textContent === 'Reset \u2014 usage will show up here once you send a message.',
		'State A displays the neutral Reset wording'
	);

	// ─── Scenario 2: State B - API Load Error / Network Failure on Free Tier ───
	const freeError = UsageData.fromAPIResponse({ status: 500 }, 'claude_free');
	section.renderNotice(freeError);

	assert(
		section.notice.className.includes('ut-usage-notice-error'),
		'State B uses ut-usage-notice-error class'
	);
	assert(
		!section.notice.className.includes('ut-usage-notice-reset'),
		'State B does NOT have ut-usage-notice-reset class'
	);

	const errorTitleEl = section.notice.querySelector('.ut-usage-error-title');
	assert(errorTitleEl !== null, 'State B contains .ut-usage-error-title');
	assert(
		errorTitleEl.textContent === 'Usage data unavailable. Try reloading the page.',
		'State B displays the unavailable error message'
	);

	const caveatEl = section.notice.querySelector('.ut-usage-notice-caveat');
	assert(caveatEl !== null, 'State B contains .ut-usage-notice-caveat');
	assert(
		caveatEl.textContent.includes('Anthropic no longer reports them on the free plan'),
		'State B displays caveat message'
	);

	// ─── Scenario 3: State B - Paid Tier with Unexpected Missing Data ───
	// Pro accounts always have active limits; empty limits indicates an unauthorized/failed fetch
	const proEmpty = UsageData.fromAPIResponse({ limits: [] }, 'claude_pro');
	section.renderNotice(proEmpty);

	assert(
		section.notice.className.includes('ut-usage-notice-error'),
		'Pro tier with empty limits treated as error (State B)'
	);
	assert(
		section.notice.querySelector('.ut-usage-error-title') !== null,
		'Pro tier error contains error title'
	);

	// ─── Scenario 4: Normal Usage Reported -> Notice Dismissed ───
	const normalUsage = UsageData.fromAPIResponse({
		limits: [
			{ kind: 'session', percent: 35, resets_at: null },
			{ kind: 'weekly_all', percent: 60, resets_at: null }
		]
	}, 'claude_pro');
	section.renderNotice(normalUsage);

	assert(section.notice === null, 'Notice element is dismissed/removed when usage bars are present');

	// ─── Scenario 5: Dynamic State Transitions ───
	// Verify notice transitions cleanly: Error -> Reset -> Normal -> Error
	section.renderNotice(freeError);
	assert(section.notice.className.includes('ut-usage-notice-error'), 'Transitioned to error');

	section.renderNotice(freeZero);
	assert(section.notice.className.includes('ut-usage-notice-reset'), 'Transitioned from error to reset');
	assert(section.notice.querySelector('.ut-usage-error-title') === null, 'Old error title removed cleanly');

	section.renderNotice(normalUsage);
	assert(section.notice === null, 'Notice removed on normal usage');

	section.renderNotice(freeError);
	assert(section.notice !== null && section.notice.className.includes('ut-usage-notice-error'), 'Re-opened as error');
}

// ─── Main Execution ──────────────────────────────────────────────────────────

async function main() {
	console.log('Running Claude Count Usage test suite...');

	// 1. Test ESM shared/dataclasses.js
	const esmModule = await import('../shared/dataclasses.js');
	await runDataclassTests(esmModule.UsageData, 'shared/dataclasses.js (ESM source)');

	// 2. Test generated content-components/ui_dataclasses.js
	const { UsageData, UsageSection } = createUISandbox();
	await runDataclassTests(UsageData, 'content-components/ui_dataclasses.js (Generated globals)');

	// 3. Test real content-components/usage_ui.js (UsageSection)
	runRealUINoticeTests(UsageData, UsageSection);

	console.log(`\n======================================================`);
	console.log(`  All tests passed successfully! (${passedTests}/${totalTests} assertions)`);
	console.log(`======================================================\n`);

	process.exit(0);
}

main().catch(err => {
	console.error('\nTest suite failed with unexpected error:\n', err);
	process.exit(1);
});
