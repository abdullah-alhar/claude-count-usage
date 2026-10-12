// Runs injections/sse-watcher.js against a fake claude.ai page whose fetch answers the new chat
// backend's StreamTimeline RPC with hand-encoded Connect/protobuf frames, and checks that the
// message_limit event comes out in the JSON shape sse_bridge.js already parses.
//
// Field numbers are from anthropic/bard/api/v1alpha/bard_api.proto as bundled by claude.ai on
// 2026-10-12 - see the comment block above pumpTimeline in the watcher.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const rootDir = path.join(__dirname, '..');

let passedTests = 0;
function assert(condition, message) {
	if (!condition) {
		console.error(`  ✗ ${message}`);
		process.exit(1);
	}
	console.log(`  ✓ ${message}`);
	passedTests++;
}

// --- minimal protobuf encoder ---
function varint(n) {
	const out = [];
	while (n >= 128) {
		out.push((n % 128) | 128);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return Buffer.from(out);
}
const tag = (field, wire) => varint(field * 8 + wire);
const vField = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);
const lenField = (field, bytes) => Buffer.concat([tag(field, 2), varint(bytes.length), bytes]);
const strField = (field, s) => lenField(field, Buffer.from(s, 'utf8'));
function doubleField(field, x) {
	const b = Buffer.alloc(8);
	b.writeDoubleLE(x);
	return Buffer.concat([tag(field, 1), b]);
}

function limitWindow({ status, seconds, utilization }) {
	const parts = [vField(1, status), lenField(2, Buffer.concat([vField(1, seconds), vField(2, 5)]))];
	if (utilization !== undefined) parts.push(doubleField(3, utilization));
	parts.push(vField(5, 2)); // period - present in real payloads, must be skipped
	return Buffer.concat(parts);
}
function messageLimit(windows, status = 1) {
	return Buffer.concat([
		vField(1, status),
		strField(9, 'five_hour'),
		...Object.entries(windows).map(([key, w]) => lenField(13, Buffer.concat([strField(1, key), lenField(2, limitWindow(w))])))
	]);
}
const timelineResponse = (streamEvent) => lenField(1, streamEvent);
const limitEvent = (ml) => timelineResponse(Buffer.concat([lenField(4, ml), lenField(10, vField(1, 7))]));
const appendEvent = (text) => timelineResponse(lenField(2, strField(3, text)));

function envelope(message, { gzip = false, end = false } = {}) {
	const body = gzip ? zlib.gzipSync(message) : message;
	const head = Buffer.alloc(5);
	head[0] = (gzip ? 0x01 : 0) | (end ? 0x02 : 0);
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

// --- fake page ---
const posted = [];
const listeners = [];
const fetchResponses = [];
const fakeWindow = {
	location: { origin: 'https://claude.ai' },
	postMessage: (data) => posted.push(data),
	addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
	fetch: async () => fetchResponses.shift()
};
const context = vm.createContext({
	window: fakeWindow,
	localStorage: { getItem: () => null },
	Request, URL, Headers, Response, Blob, DecompressionStream, TextDecoder, DataView, Uint8Array,
	Function, Error, Math, Object, Number, String
});
vm.runInContext(fs.readFileSync(path.join(rootDir, 'injections', 'sse-watcher.js'), 'utf8'), context);

function streamResponse(chunks, contentType = 'application/connect+proto') {
	const body = new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(new Uint8Array(c));
			controller.close();
		}
	});
	return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

// Split a byte buffer into uneven chunks so envelopes and varints straddle read boundaries.
function choppy(buffer, sizes) {
	const out = [];
	let i = 0;
	for (let k = 0; i < buffer.length; k++) {
		const n = sizes[k % sizes.length];
		out.push(buffer.subarray(i, i + n));
		i += n;
	}
	return out;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

(async () => {
	console.log('\nsse-watcher: bard StreamTimeline (Connect/protobuf)');

	assert(posted.some(m => m.type === 'claudeUsageTrackerDiag' && m.stage === 'installed'), 'watcher announces itself on install');
	const before = posted.length;
	listeners.forEach(fn => fn({ source: fakeWindow, data: { type: 'claudeUsageTrackerPing' } }));
	assert(posted.length === before + 1 && posted.at(-1).stage === 'installed', 'watcher re-announces itself when pinged');

	const stream = Buffer.concat([
		envelope(appendEvent('Hi Sajeer! What can I help you with tonight?')),
		envelope(limitEvent(messageLimit({
			'5h': { status: 1, seconds: 1791747600, utilization: 0.03 },
			'7d': { status: 1, seconds: 1792184400 } // utilization 0 is omitted on the wire
		})), { gzip: true }),
		envelope(appendEvent('more text')),
		envelope(limitEvent(messageLimit({ '5h': { status: 3, seconds: 1791747600, utilization: 0.98 } }, 3))),
		envelope(Buffer.from('{}'), { end: true }),
		envelope(limitEvent(messageLimit({ '5h': { status: 1, seconds: 1, utilization: 0.5 } }))) // after end: ignored
	]);
	fetchResponses.push(streamResponse(choppy(stream, [3, 1, 7, 64, 2])));
	posted.length = 0;

	const pageResponse = await context.window.fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', {
		method: 'POST',
		headers: new Headers({ 'x-organization-uuid': 'org-1', 'content-type': 'application/connect+proto' })
	});
	assert(pageResponse.status === 200, 'the page still gets its response');
	const pageBytes = new Uint8Array(await pageResponse.arrayBuffer());
	assert(pageBytes.length === stream.length, 'the page still reads the whole stream, untouched');
	await settle();

	assert(posted.some(m => m.type === 'claudeUsageTrackerDiag' && m.stage === 'timeline' && m.status === 200), 'timeline stream is reported to the debug log');
	const usage = posted.filter(m => m.type === 'claudeUsageTrackerStream');
	assert(usage.length === 2, 'one usage message per message_limit event; content appends and post-trailer frames ignored');

	const [first, second] = usage;
	assert(first.usageOnly === true && first.conversationId === null, 'usage-only: nothing to count toward conversation length');
	assert(first.streamOrgId === 'org-1', 'org comes from the request header');
	assert(first.messageLimit.type === 'within_limit', 'MessageLimit status maps to the JSON type');
	assert(first.messageLimit.windows['5h'].status === 'within_limit', '5h window status');
	assert(first.messageLimit.windows['5h'].resets_at === 1791747600, '5h resets_at is unix seconds');
	assert(Math.abs(first.messageLimit.windows['5h'].utilization - 0.03) < 1e-12, '5h utilization read from the double');
	assert(first.messageLimit.windows['7d'].utilization === 0, 'omitted utilization reads as 0, like claude.ai\'s converter');
	assert(second.messageLimit.windows['5h'].status === 'exceeded_limit', 'exceeded window keeps its status');

	// The JSON shape must be what sse_bridge parses.
	const bridgeContext = vm.createContext({
		window: { location: { origin: 'https://claude.ai' }, addEventListener() {}, postMessage() {} },
		setTimeout: (fn) => fn(), Log: () => {}, CONFIG: { SSE_SAME_WINDOW_TOLERANCE_MS: 60000, ESTIMATION_MULTIPLIER: 1 },
		pageDiagnostics: { watcherCompletions: [], browserCompletions: [], injections: {} },
		getActiveOrgId: () => 'org-1', sendBackgroundMessage: () => Promise.resolve()
	});
	vm.runInContext(fs.readFileSync(path.join(rootDir, 'content-components', 'sse_bridge.js'), 'utf8'), bridgeContext);
	const limits = bridgeContext.parseSseLimits(first.messageLimit);
	assert(limits.session.percentage === 3 && limits.weekly.percentage === 0, 'sse_bridge reads session 3% / weekly 0% from it');
	assert(bridgeContext.parseSseLimits(second.messageLimit).session.percentage === 100, 'sse_bridge shows an exceeded window as 100%');

	console.log('\nsse-watcher: other requests');
	posted.length = 0;
	fetchResponses.push(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
	await context.window.fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction', { method: 'POST' });
	fetchResponses.push(streamResponse([Buffer.from('not a connect stream at all, just bytes')], 'text/plain'));
	await context.window.fetch('/api/organizations/o/chat_conversations/c?tree=True');
	await settle();
	assert(posted.length === 0, 'non-stream requests are left alone');

	fetchResponses.push(streamResponse([Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 1, 2, 3])]));
	await context.window.fetch('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline', { method: 'POST' });
	await settle();
	assert(!posted.some(m => m.type === 'claudeUsageTrackerStream'), 'an implausible frame length stops the watch instead of misreading');

	console.log(`\nAll ${passedTests} bard timeline tests passed.`);
})().catch(error => {
	console.error(error);
	process.exit(1);
});
