'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const widgetSelector = '[data-ccu-sidebar-widget]';
const fixtureHtml = `<body><aside><nav>
	<div id="new"><div><a><svg></svg><span>New</span></a></div></div>
	<div id="search"><div><button><svg></svg><span>Search</span></button></div></div>
	<div id="projects"><div><a><svg></svg><span>Projects</span></a></div></div>
	<div id="artifacts"><div><a><svg></svg><span>Artifacts</span></a></div></div>
	<div id="plugins"><div><div role="link"><svg></svg><span> Plugins </span></div></div></div>
	<h2 id="pinned">Pinned</h2>
	<div><a>First chat</a><a>Second chat</a><a>Plugins</a></div>
</nav></aside></body>`;

function createFixture() {
	const observers = new Set();
	const timers = new Map();
	let timerId = 0;

	function record(target, addedNodes, removedNodes) {
		for (const observer of observers) {
			if (observer.root === target || (observer.subtree && observer.root.contains(target))) {
				observer.records.push({ target, addedNodes, removedNodes });
			}
		}
	}

	class Element {
		constructor(tag, attributes = {}) {
			this.tag = tag;
			this.attributes = attributes;
			this.children = [];
			this.parentElement = null;
			this.text = '';
			this.style = {};
			this.classList = { add() {}, remove() {} };
		}
		get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
		get isConnected() { return this.closest('body') !== null; }
		get nextElementSibling() {
			const siblings = this.parentElement?.children || [];
			return siblings[siblings.indexOf(this) + 1] || null;
		}
		setAttribute(key, value) { this.attributes[key] = value; }
		addEventListener() {}
		getClientRects() { return [{}]; }
		matches(selector) {
			return selector.split(',').some(part => {
				const name = part.trim();
				const attr = name.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
				if (attr) return Object.hasOwn(this.attributes, attr[1]) &&
					(attr[2] === undefined || this.attributes[attr[1]] === attr[2]);
				return name === '*' || name === this.tag || name === `#${this.attributes.id}`;
			});
		}
		closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
		contains(node) {
			return this === node || this.children.some(child => child.contains(node));
		}
		querySelectorAll(selector) {
			return this.children.flatMap(child => [
				...(child.matches(selector) ? [child] : []),
				...child.querySelectorAll(selector),
			]);
		}
		querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
		appendChild(node) { this.insertBefore(node, null); }
		insertBefore(node, reference) {
			node.remove();
			this.children.splice(reference ? this.children.indexOf(reference) : this.children.length, 0, node);
			node.parentElement = this;
			record(this, [node], []);
		}
		after(node) { this.parentElement.insertBefore(node, this.nextElementSibling); }
		remove() {
			const parent = this.parentElement;
			if (!parent) return;
			parent.children.splice(parent.children.indexOf(this), 1);
			this.parentElement = null;
			record(parent, [], [this]);
		}
	}

	// This fixture uses balanced tags and double-quoted attributes only.
	const document = new Element('document');
	let current = document;
	for (const token of fixtureHtml.match(/<[^>]+>|[^<]+/g)) {
		if (token.startsWith('</')) {
			current = current.parentElement;
		} else if (token.startsWith('<')) {
			const [, tag, attrs] = token.match(/^<(\w+)([^>]*)>$/);
			const node = new Element(tag, Object.fromEntries([...attrs.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, value])));
			current.appendChild(node);
			current = node;
		} else {
			current.text += token;
		}
	}
	document.createElement = tag => new Element(tag);

	const context = vm.createContext({
		document,
		window: { addEventListener() {} },
		browser: { runtime: { onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}) } } },
		getComputedStyle: node => ({ visibility: 'visible', ...node.style }),
		setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
		clearTimeout(id) { timers.delete(id); },
		MutationObserver: class {
			constructor(callback) { this.callback = callback; this.records = []; }
			observe(root, { childList, subtree }) {
				assert.equal(childList, true);
				this.root = root;
				this.subtree = subtree;
				observers.add(this);
			}
			disconnect() { observers.delete(this); }
		},
	});
	for (const filename of ['content_utils.js', 'usage_ui.js']) {
		const source = readFileSync(path.join(__dirname, '../content-components', filename), 'utf8');
		vm.runInContext(source.slice(0, source.lastIndexOf('// Self-initialize')), context);
	}
	const logs = [];
	context.Log = message => logs.push(message);
	const ui = vm.runInContext('Object.create(UsageUI.prototype)', context);
	ui.createHeader = () => ({ header: new Element('header'), toggle: new Element('button') });
	ui.usageSection = { elements: { container: new Element('div') } };

	return {
		document, ui, logs,
		deliverMutations() {
			for (const observer of observers) {
				if (observer.records.length) observer.callback(observer.records.splice(0));
			}
		},
		flushTimers() {
			const pending = [...timers.values()];
			timers.clear();
			pending.forEach(run => run());
			return pending.length;
		},
	};
}

async function setup() {
	const fixture = createFixture();
	fixture.ui.elements = { sidebar: await fixture.ui.createSidebarElements() };
	return fixture;
}

test('mounts the widget after the Plugins row and before Pinned', async () => {
	const { document, ui, logs } = await setup();
	const plugins = document.querySelector('#plugins');
	plugins.style.paddingInlineStart = '4px';
	plugins.querySelector('[role="link"]').style.paddingInlineStart = '8px';
	ui.mountSidebar();
	const widget = document.querySelector(widgetSelector);
	assert.equal(plugins.nextElementSibling, widget);
	assert.equal(widget.nextElementSibling, document.querySelector('#pinned'));
	assert.equal(widget.style.paddingInlineStart, '12px');
	assert.ok(logs.includes('UsageUI: Sidebar anchor: after Plugins'));
});

test('mounting twice leaves exactly one marked widget', async () => {
	const { document, ui, deliverMutations, flushTimers } = await setup();
	ui.mountSidebar();
	ui.mountSidebar();
	assert.equal(document.querySelectorAll(widgetSelector).length, 1);
	deliverMutations();
	assert.equal(flushTimers(), 0, 'inserting the widget does not schedule another mount');
});

test('the sidebar observer puts a removed widget back after Plugins', async () => {
	const { document, ui, deliverMutations, flushTimers } = await setup();
	ui.mountSidebar();
	assert.equal(ui.sidebarObserver.root, document.querySelector('aside'));
	assert.equal(ui.sidebarObserver.subtree, true);
	const widget = document.querySelector(widgetSelector);
	widget.remove();
	deliverMutations();
	assert.equal(document.querySelector(widgetSelector), null);
	assert.equal(flushTimers(), 1);
	assert.equal(document.querySelector('#plugins').nextElementSibling, widget);
	assert.equal(document.querySelectorAll(widgetSelector).length, 1);
});

test('falls back after Artifacts when the Plugins nav row is absent', async () => {
	const { document, ui, logs } = await setup();
	document.querySelector('#plugins').remove();
	ui.mountSidebar();
	assert.equal(document.querySelector('#artifacts').nextElementSibling, document.querySelector(widgetSelector));
	assert.ok(logs.includes('UsageUI: Sidebar anchor: after Artifacts'));
});
