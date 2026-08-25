import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter } from './bg-components/tokenManagement.js';
import { getStrategy, initContainerStrategy, setBrave } from './bg-components/container-strategy.js';
import { UsageData, modelFamilyFromVersion, defaultModelForTier, defaultModelVersionForTier } from './shared/dataclasses.js';
import { translate, normalizeLocale } from './shared/localization.js';
import { scheduleAlarm, getAlarm, createNotification } from './bg-components/electron-compat.js';
import { invalidateAccountSettings, invalidateProfileTokens, storeSseUsage } from './bg-components/claude-api.js';

const INTERCEPT_PATTERNS = {
	onBeforeRequest: {
		urls: [
			"*://claude.ai/api/organizations/*/completion",
			"*://claude.ai/api/organizations/*/retry_completion",
			"*://claude.ai/api/settings/billing*",
			"*://claude.ai/api/account_profile",
			"*://claude.ai/api/account/settings*"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
			"^https?://claude\\.ai/api/settings/billing",
			"^https?://claude\\.ai/api/account_profile$",
			"^https?://claude\\.ai/api/account/settings"
		]
	},
	onCompleted: {
		urls: [
			"*://claude.ai/api/organizations/*/chat_conversations/*",
			"*://claude.ai/v1/sessions/*/events",
			"*://claude.ai/api/account_profile"
		],
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*$",
			"^https?://claude\\.ai/v1/sessions/[^/]*/events$",
			"^https?://claude\\.ai/api/account_profile$"
		]
	}
};

//#region Variable declarations
let processingLock = null;  // Unix timestamp or null
const pendingLocaleReloads = new Map();  // tabId -> normalized new locale (set in onBeforeRequest, consumed in onCompleted)
const pendingTasks = [];
const LOCK_TIMEOUT = 30000;  // 30 seconds - if a task takes longer, something's wrong
let pendingRequests;
let scheduledNotifications;
let electronPollingInterval = null;
let electronPollInFlight = false;

let isInitialized = false;
let functionsPendingUntilInitialization = [];

function runOnceInitialized(fn, args) {
	if (!isInitialized) {
		functionsPendingUntilInitialization.push({ fn, args });
		return;
	}
	return fn(...args);
}
//#endregion

//#region Listener setup (I hate MV3 - listeners must be initialized here)
//Extension-related listeners:
browser.runtime.onMessage.addListener(async (message, sender) => {
	return runOnceInitialized(handleMessageFromContent, [message, sender]);
});

// Context menu: Debug only — no donate/Ko-fi entry
if (browser.contextMenus) {
	browser.runtime.onInstalled.addListener(() => {
		browser.contextMenus.create({
			id: 'openDebugPage',
			title: 'Open Debug Page',
			contexts: ['action']
		});
	});

	browser.contextMenus.onClicked.addListener((info, tab) => {
		if (info.menuItemId === 'openDebugPage') {
			browser.tabs.create({
				url: browser.runtime.getURL('debug.html')
			});
		}
	});
}


if (!isElectron) {
	// WebRequest listeners
	browser.webRequest.onBeforeRequest.addListener(
		(details) => runOnceInitialized(onBeforeRequestHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onBeforeRequest.urls },
		["requestBody"]
	);

	browser.webRequest.onCompleted.addListener(
		(details) => runOnceInitialized(onCompletedHandler, [details]),
		{ urls: INTERCEPT_PATTERNS.onCompleted.urls },
		["responseHeaders"]
	);

	initContainerStrategy();
}

//Alarm listeners

async function handleAlarm(alarmName) {
	await Log("Alarm triggered:", alarmName);

	if (alarmName === 'checkResetNotifications') {
		if (!isElectron) {
			try {
				await updateAllTabsWithUsage();
			} catch (error) {
				await Log("warn", "Usage heartbeat failed:", error);
			}
		}
		await checkResetNotifications();
	}
}

async function checkResetNotifications() {
	const enabled = await getStorageValue('resetNotifEnabled', false);
	if (!enabled) return;

	const entries = await scheduledNotifications.entries();
	if (!entries || entries.length === 0) return;

	const now = Date.now();
	let shouldNotify = false;

	for (const [timestampKey, orgId] of entries) {
		const resetTime = parseInt(timestampKey);
		if (resetTime > now) continue;

		if (now - resetTime > 10 * 60 * 1000) {
			await scheduledNotifications.delete(timestampKey);
			continue;
		}

		try {
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			if (tabs.length === 0) {
				await scheduledNotifications.delete(timestampKey);
				continue;
			}

			const tab = tabs[0];
			const tabOrgId = await requestActiveOrgId(tab);
			const api = getStrategy().apiForTab(tab, tabOrgId);
			const usageData = await api.getUsageData();

			const sessionLimit = usageData.limits.session;
			if (!sessionLimit || sessionLimit.percentage === 0) {
				shouldNotify = true;
			}
		} catch (error) {
			await Log("warn", "Error checking reset status:", error);
		}

		await scheduledNotifications.delete(timestampKey);
	}

	if (shouldNotify) {
		try {
			const stored = await browser.storage.local.get('lastLang');
			const loc = normalizeLocale(stored.lastLang || 'en');
			await createNotification({
				type: 'basic',
				iconUrl: browser.runtime.getURL('icon128.png'),
				title: translate(loc, 'bg.reset_title'),
				message: translate(loc, 'bg.reset_message')
			});
			await Log("Reset notification sent");
		} catch (error) {
			await Log("error", "Failed to create reset notification:", error);
		}
	}
}
let alarmListenerRegistered = false;
if (chrome.alarms) {
	if (chrome.alarms && !alarmListenerRegistered) {
		alarmListenerRegistered = true;
		chrome.alarms.onAlarm.addListener(alarm => handleAlarm(alarm.name));
	}
} else {
	messageRegistry.register('electron-alarm', (msg) => {
		handleAlarm(msg.name);
	});
}


//#endregion


async function Log(...args) {
	await RawLog("background", ...args)
};

async function logError(error) {
	if (!(error instanceof Error)) {
		await Log("error", JSON.stringify(error));
		return
	}

	await Log("error", error.toString());
	if ("captureStackTrace" in Error) {
		Error.captureStackTrace(error, logError);
	}
	await Log("error", JSON.stringify(error.stack));
}


//#endregion


async function requestActiveOrgId(tab) {
	if (typeof tab === "number") {
		tab = await browser.tabs.get(tab);
	}
	return getStrategy().activeOrgForTab(tab);
}

//#endregion


//#region Messaging

// Updates all tabs with usage data only
async function updateAllTabsWithUsage(usageData = null) {
	await Log("Updating all tabs with usage data");
	const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	const fetchesByOrg = new Map();

	for (const tab of tabs) {
		try {
			let data = usageData;

			if (!data) {
				const orgId = await requestActiveOrgId(tab);
				if (!fetchesByOrg.has(orgId)) {
					const api = getStrategy().apiForTab(tab, orgId);
					fetchesByOrg.set(orgId, api.getUsageData());
				}
				data = await fetchesByOrg.get(orgId);
			}

			sendTabMessage(tab.id, {
				type: 'updateUsage',
				data: {
					usageData: data.toJSON()
				}
			}).catch(error => Log("warn", `Failed to push usage to tab ${tab.id}:`, error));
		} catch (error) {
			await Log("warn", `Failed to update tab ${tab.id} with usage data:`, error);
		}
	}
}

const PENDING_MODEL_TRUST_MS = 5 * 60 * 1000;

const SYNTHETIC_TURN_PREFIX = 'ts:';

async function getPendingBucket(orgId, conversationId) {
	const stored = await pendingRequests.get(`${orgId}:${conversationId}`);
	if (!stored || typeof stored !== 'object') return {};

	const bucket = {};
	for (const [key, entry] of Object.entries(stored)) {
		if (entry && typeof entry === 'object' && typeof entry.requestTimestamp === 'number') {
			bucket[key] = entry;
		}
	}
	return bucket;
}

async function getPendingRequest(orgId, conversationId, turnUuid) {
	const bucket = await getPendingBucket(orgId, conversationId);
	if (turnUuid && bucket[turnUuid]) return bucket[turnUuid];
	if (!turnUuid) return newestPending(bucket);

	const synthetic = Object.fromEntries(
		Object.entries(bucket).filter(([key]) => key.startsWith(SYNTHETIC_TURN_PREFIX))
	);
	return newestPending(synthetic);
}

function newestPending(bucket) {
	let newest;
	for (const entry of Object.values(bucket)) {
		if (!newest || (entry.requestTimestamp || 0) > (newest.requestTimestamp || 0)) newest = entry;
	}
	return newest;
}

async function setPendingRequest(orgId, conversationId, turnUuid, entry) {
	await pendingRequests.prune();

	const bucket = await getPendingBucket(orgId, conversationId);
	bucket[turnUuid] = entry;

	const cutoff = Date.now() - PENDING_REQUEST_TTL;
	const kept = Object.entries(bucket).filter(([, e]) => (e.requestTimestamp || 0) > cutoff);

	await pendingRequests.set(`${orgId}:${conversationId}`, Object.fromEntries(kept), PENDING_REQUEST_TTL);
}

async function lastToolTokens(orgId, conversationId) {
	const pending = newestPending(await getPendingBucket(orgId, conversationId));
	return pending?.toolTokens || 0;
}

async function applyPendingModel(conversationData, orgId, conversationId) {
	const pending = newestPending(await getPendingBucket(orgId, conversationId));
	if (!pending || Date.now() - (pending.requestTimestamp || 0) > PENDING_MODEL_TRUST_MS) return;

	if (pending.model) conversationData.model = pending.model;
	if (pending.modelVersion) conversationData.modelVersion = pending.modelVersion;
}

async function updateTabWithConversationData(tabId, conversationData) {
	await Log("Updating tab with conversation metrics:", tabId, conversationData);

	sendTabMessage(tabId, {
		type: 'updateConversationData',
		data: {
			conversationData: conversationData.toJSON()
		}
	});
}

// Simple handlers with inline functions
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('getAccountLocale', async (message, sender) => {
	try {
		return await getStrategy().apiForTab(sender.tab, null).getAccountLocale();
	} catch (error) {
		await Log("warn", "Failed to fetch account locale:", error);
		return null;
	}
});
messageRegistry.register('initOrg', (message, sender, orgId) => tokenStorageManager.addOrgId(orgId).then(() => true));

messageRegistry.register('getAPIKey', () => getStorageValue('apiKey'));
messageRegistry.register('setAPIKey', async (message) => {
	const newKey = message.newKey;
	if (newKey === "") {
		await removeStorageValue('apiKey');
		return true;
	}

	const isValid = await tokenCounter.testApiKey(newKey);

	if (isValid) {
		await setStorageValue('apiKey', newKey);
		await Log("API key validated and saved");
		return true;
	} else {
		await Log("warn", "API key validation failed");
		return false;
	}
});

messageRegistry.register('getResetNotifEnabled', () => getStorageValue('resetNotifEnabled', false));
messageRegistry.register('setResetNotifEnabled', (message) => setStorageValue('resetNotifEnabled', message.value));

messageRegistry.register('getResetNotifThreshold', () => getStorageValue('resetNotifThreshold', 100));
messageRegistry.register('setResetNotifThreshold', (message) => {
	const n = Number(message.value);
	const clamped = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.round(n))) : 100;
	return setStorageValue('resetNotifThreshold', clamped);
});

messageRegistry.register('getLanguageOverride', () => getStorageValue('languageOverride', null));
messageRegistry.register('setLanguageOverride', (message) => setStorageValue('languageOverride', message.value));

messageRegistry.register('isElectron', () => isElectron);
messageRegistry.register('getMonkeypatchPatterns', () => isElectron ? INTERCEPT_PATTERNS : false);

messageRegistry.register('reportBrave', async (message) => {
	await setBrave(message.isBrave);
	return true;
});

async function openDebugPage() {
	if (!isElectron) {
		browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
		return true;
	}
	return 'fallback';
}
messageRegistry.register(openDebugPage);

// Complex handlers
async function requestData(message, sender, orgId) {
	const { conversationId } = message;

	const api = getStrategy().apiForTab(sender.tab, orgId);

	const usageData = await api.getUsageData();
	await scheduleResetNotifications(orgId, usageData);
	await updateAllTabsWithUsage(usageData);

	if (conversationId) {
		const cached = await conversationCache.get(conversationId);
		if (cached) {
			await Log(`Cache hit for conversation: ${conversationId}`);

			if (cached.conversationIsCachedUntil && cached.conversationIsCachedUntil <= Date.now()) {
				cached.cost = cached.uncachedCost;
				cached.futureCost = cached.uncachedFutureCost;
				cached.conversationIsCachedUntil = null;
			}

			await sendTabMessage(sender.tab.id, {
				type: 'updateConversationData',
				data: { conversationData: cached }
			});
		} else {
			await Log(`Cache miss for conversation: ${conversationId}`);
			const conversation = await api.getConversation(conversationId);
			const conversationData = await conversation.getInfo(false, {
				toolTokens: await lastToolTokens(orgId, conversationId)
			});

			if (conversationData) {
				await applyPendingModel(conversationData, orgId, conversationId);

				await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
				await updateTabWithConversationData(sender.tab.id, conversationData);
			}
		}
	}

	await Log("Sent update messages to tab");
	return true;
}
messageRegistry.register(requestData);

async function reportStreamCompletion(message, sender, orgId) {
	if (!orgId || !sender?.tab) return false;

	await storeSseUsage(getStrategy().apiForTab(sender.tab, orgId), message.sseLimits);

	const conversationId = message.conversationId;
	if (!conversationId || message.assistantTokens === null) return false;

	const pending = await getPendingRequest(orgId, conversationId, message.assistantUuid);
	const cached = await conversationCache.get(conversationId);
	if (!pending || !cached) {
		await Log("Stream completion: no baseline for", conversationId, "- skipping estimate");
		return false;
	}

	const provisional = { ...cached };

	const assistantTokens = Math.max(0, message.assistantTokens || 0);
	const promptTokens = pending.isRetry ? 0 : Math.max(0, pending.promptTokens || 0);
	const toolTokens = pending.toolTokens || 0;

	const appendOk = !pending.isRetry;
	if (appendOk) {
		provisional.length = (cached.length || 0) + promptTokens + assistantTokens;
	}

	provisional.futureCost = Math.round((1 + CONFIG.OUTPUT_TOKEN_MULTIPLIER) * assistantTokens + toolTokens);
	provisional.cost = provisional.futureCost;

	provisional.uncachedFutureCost = (cached.uncachedFutureCost || 0) + promptTokens + assistantTokens;
	provisional.uncachedCost = provisional.uncachedFutureCost;

	provisional.conversationIsCachedUntil = Date.now() + CONFIG.TOKEN_CACHING_DURATION_MS;
	provisional.costUsedCache = true;
	provisional.lastMessageTimestamp = Date.now();
	provisional.model = pending.model || provisional.model;
	provisional.modelVersion = pending.modelVersion || provisional.modelVersion;
	provisional.orgId = orgId;
	provisional.conversationId = conversationId;
	provisional.lengthIsEstimate = !!(cached.lengthIsEstimate || message.unreliable ||
		pending.hasAttachments || !appendOk);

	await conversationCache.set(conversationId, provisional, PROVISIONAL_CACHE_TTL);

	await Log("Stream completion: provisional length", provisional.length,
		"futureCost", provisional.futureCost, "(assistant", assistantTokens,
		"prompt", promptTokens, "tools", toolTokens, ")");

	await sendTabMessage(sender.tab.id, {
		type: 'updateConversationData',
		data: { conversationData: provisional }
	});

	return true;
}
messageRegistry.register(reportStreamCompletion);

function queueAuthoritativePass(options) {
	const conversationId = options.conversationId;
	if (authoritativeInFlight.has(conversationId)) return;
	authoritativeInFlight.add(conversationId);
	pendingTasks.push(async () => {
		try {
			await runAuthoritativePass(options);
		} catch (error) {
			await logError(error);
		} finally {
			authoritativeInFlight.delete(conversationId);
		}
	});
	processNextTask();
}

async function getPopupUsageData() {
	const accounts = await getStrategy().listAccounts();
	if (accounts.length === 0) return [];

	return Promise.all(accounts.map(async ({ orgId, ctx }) => {
		const api = getStrategy().apiFor(ctx, orgId);
		try {
			const usageData = await api.getUsageData();
			const org = await api.getOrgInfo();
			return { orgId, orgName: org?.name || null, usageData: usageData.toJSON() };
		} catch (e) {
			const org = await api.getOrgInfo().catch(() => null);
			return { orgId, orgName: org?.name || null, error: String(e) };
		}
	}));
}
messageRegistry.register(getPopupUsageData);

async function interceptedRequest(message, sender) {
	await Log("Got intercepted request, are we in electron?", isElectron);
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onBeforeRequestHandler(message.details);
	return true;
}
messageRegistry.register(interceptedRequest);

async function interceptedResponse(message, sender) {
	await Log("Got intercepted response, are we in electron?", isElectron);
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onCompletedHandler(message.details);
	return true;
}
messageRegistry.register(interceptedResponse);

async function getTotalTokensTracked() {
	return await tokenStorageManager.getTotalTokens();
}
messageRegistry.register(getTotalTokensTracked);

// Main handler function
async function handleMessageFromContent(message, sender) {
	return messageRegistry.handle(message, sender);
}
//#endregion



//#region Network handling
async function parseRequestBody(requestBody) {
	if (!requestBody?.raw?.[0]?.bytes) return undefined;

	if (requestBody.fromMonkeypatch) {
		const body = requestBody.raw[0].bytes;
		try {
			return JSON.parse(body);
		} catch (e) {
			try {
				const params = new URLSearchParams(body);
				const formData = {};
				for (const [key, value] of params) {
					formData[key] = value;
				}
				return formData;
			} catch (e) {
				return undefined;
			}
		}
	} else {
		try {
			const text = new TextDecoder().decode(requestBody.raw[0].bytes);
			return JSON.parse(text);
		} catch (e) {
			return undefined;
		}
	}
}

async function runAuthoritativePass({ orgId, conversationId, api, tabId }) {
	await Log("Running authoritative pass for", conversationId);

	const usageData = await api.getUsageData();
	const conversation = await api.getConversation(conversationId);
	const tree = await conversation.getData(true);
	const turnUuid = tree?.current_leaf_message_uuid || null;

	const pendingRequest = await getPendingRequest(orgId, conversationId, turnUuid);
	const isNewMessage = pendingRequest !== undefined;
	const alreadyCounted = !!pendingRequest?.settled;

	const model = pendingRequest?.model || defaultModelForTier(usageData.subscriptionTier);

	const conversationData = await conversation.getInfo(isNewMessage, {
		toolTokens: pendingRequest?.toolTokens || 0
	});

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		return false;
	}

	conversationData.model = model;
	await Log('authoritative pass: modelVersion -',
		'from API:', conversationData.modelVersion,
		'| from pendingRequest:', pendingRequest?.modelVersion);
	if (pendingRequest?.modelVersion) {
		conversationData.modelVersion = pendingRequest.modelVersion;
	}
	await Log('authoritative pass: modelVersion final:', conversationData.modelVersion);

	if (isNewMessage && !alreadyCounted && pendingRequest.previousUsage) {
		const previousUsage = UsageData.fromJSON(pendingRequest.previousUsage);
		await logUsageDelta(orgId, previousUsage, usageData, conversationData.length, model);
		await tokenStorageManager.addToTotalTokens(conversationData.cost);
		await debugLogMessageCost(usageData, conversationData);
	}

	if (isNewMessage && !alreadyCounted && pendingRequest.turnUuid) {
		await setPendingRequest(orgId, conversationId, pendingRequest.turnUuid,
			{ ...pendingRequest, settled: true });
	}

	await scheduleResetNotifications(orgId, usageData);
	await updateAllTabsWithUsage(usageData);
	await updateTabWithConversationData(tabId, conversationData);

	await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);

	return true;
}

async function debugLogMessageCost(usageData, conversationData) {
	if (!FORCE_DEBUG) return;

	const limitMapping = {
		session: 'debug_session',
		weekly: 'debug_weekly',
		sonnetWeekly: 'debug_sonnet_weekly',
		opusWeekly: 'debug_opus_weekly',
		fableWeekly: 'debug_fable_weekly'
	};

	for (const [limitKey, storagePrefix] of Object.entries(limitMapping)) {
		const limit = usageData.limits[limitKey];
		if (!limit) continue;

		const storageKey = `${storagePrefix}_${limit.resetsAt}`;
		const existing = await getStorageValue(storageKey, {
			resetsAt: limit.resetsAt,
			limitKey,
			messages: [],
			accumulatedCost: 0,
			lastPercentage: null
		});

		const percentageChanged = existing.lastPercentage !== null && limit.percentage !== existing.lastPercentage;

		if (percentageChanged) {
			const entry = {
				timestamp: Date.now(),
				cost: conversationData.cost,
				accumulatedCost: existing.accumulatedCost,
				totalCost: conversationData.cost + existing.accumulatedCost,
				futureCost: conversationData.futureCost,
				model: conversationData.model,
				conversationLength: conversationData.length,
				percentageDelta: limit.percentage - existing.lastPercentage,
			};
			existing.messages.push(entry);
			existing.accumulatedCost = 0;
			await Log(`Debug [${limitKey}]: logged message cost ${entry.totalCost} (accumulated: ${entry.accumulatedCost}, this msg: ${entry.cost}, delta: ${entry.percentageDelta}%)`);
		} else {
			existing.accumulatedCost += conversationData.cost;
			await Log(`Debug [${limitKey}]: accumulated cost ${conversationData.cost}, total accumulated: ${existing.accumulatedCost}`);
		}

		existing.lastPercentage = limit.percentage;
		await setStorageValue(storageKey, existing);
	}
}

async function logUsageDelta(orgId, previousUsage, currentUsage, conversationLength, model) {
	const deltas = {};

	for (const [key, currentLimit] of Object.entries(currentUsage.limits)) {
		if (!currentLimit) continue;

		const previousLimit = previousUsage.limits[key];
		if (!previousLimit) continue;

		const delta = currentLimit.percentage - previousLimit.percentage;

		if (delta >= 1) {
			deltas[key] = delta;
		}
	}

	if (Object.keys(deltas).length > 0) {
		const entry = {
			timestamp: Date.now(),
			orgId,
			conversationLength,
			model,
			deltas
		};

		await Log(`Usage delta: ${JSON.stringify(entry)}`);
	}
}

async function scheduleResetNotifications(orgId, usageData) {
	const threshold = await getStorageValue('resetNotifThreshold', 100);
	const maxedLimits = usageData.getMaxedLimits(threshold);

	for (const limit of maxedLimits) {
		if (limit.resetsAt <= Date.now()) continue;

		const timestampKey = limit.resetsAt.toString();

		if (await scheduledNotifications.has(timestampKey)) continue;

		const expiryTime = limit.resetsAt + (60 * 60 * 1000) - Date.now();
		await scheduledNotifications.set(timestampKey, orgId, expiryTime);

		await Log(`Stored pending reset: ${limit.key} for ${new Date(limit.resetsAt).toISOString()}`);
	}
}


// Listen for message sending
async function onBeforeRequestHandler(details) {
	await Log("Intercepted request:", details.url);
	await Log("Intercepted body:", details.requestBody);
	if (details.method === "POST" &&
		(details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
		await Log("Request sent - URL:", details.url);
		const requestBodyJSON = await parseRequestBody(details.requestBody);
		await Log("Request sent - Body:", { ...requestBodyJSON, tools: requestBodyJSON?.tools?.length ?? 0 });
		const urlParts = details.url.split('/');
		const orgId = urlParts[urlParts.indexOf('organizations') + 1];
		await tokenStorageManager.addOrgId(orgId);
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		let previousUsage = null;
		let subscriptionTier = null;
		try {
			const api = getStrategy().apiForRequest(details, orgId);
			const usageData = await api.getUsageData();
			previousUsage = usageData.toJSON();
			subscriptionTier = usageData.subscriptionTier;
		} catch (error) {
			await Log("warn", "Failed to fetch pre-message usage snapshot:", error);
		}

		const modelVersion = requestBodyJSON?.model || defaultModelVersionForTier(subscriptionTier);
		const model = modelFamilyFromVersion(modelVersion) || defaultModelForTier(subscriptionTier);
		await Log("Model from request:", model, modelVersion);

		let turnUuid = requestBodyJSON?.turn_message_uuids?.assistant_message_uuid;
		if (!turnUuid) {
			await Log("warn", "No turn_message_uuids.assistant_message_uuid in the completion body —",
				"per-turn keying is degraded to newest-wins for this request");
			turnUuid = `${SYNTHETIC_TURN_PREFIX}${Date.now()}`;
		}
		await Log(`Message sent - conversation ${conversationId}, turn ${turnUuid}`);

		const toolDefs = requestBodyJSON?.tools?.filter(tool =>
			tool.name && !['artifacts_v0', 'repl_v0'].includes(tool.type)
		)?.map(tool => ({
			name: tool.name,
			description: tool.description || '',
			schema: JSON.stringify(tool.input_schema || {})
		})) || [];
		await Log("Tool definitions:", toolDefs.map(t => t.name));

		let toolTokens = 0;
		try {
			for (const tool of toolDefs) {
				toolTokens += tokenCounter.countTextLocal(`${tool.name} ${tool.description} ${tool.schema}`);
			}
		} catch (error) {
			await Log("warn", "Failed to size tool definitions:", error);
		}

		// PRIVACY: Only the token COUNT is stored, never the message text itself.
		let promptTokens = 0;
		let hasAttachments = false;
		try {
			promptTokens = tokenCounter.countTextLocal(requestBodyJSON?.prompt || '');
			hasAttachments = !!(requestBodyJSON?.attachments?.length || requestBodyJSON?.files?.length);
		} catch (error) {
			await Log("warn", "Failed to size outgoing message:", error);
		}

		await Log('onBeforeRequest: storing modelVersion:', modelVersion, '| class:', model);
		await setPendingRequest(orgId, conversationId, turnUuid, {
			orgId: orgId,
			conversationId: conversationId,
			turnUuid: turnUuid,
			tabId: details.tabId,
			model: model,
			modelVersion: modelVersion,
			requestTimestamp: Date.now(),
			toolTokens: toolTokens,
			previousUsage: previousUsage,
			promptTokens: promptTokens,
			hasAttachments: hasAttachments,
			isRetry: details.url.includes("/retry_completion")
		});
	}

	if (details.method === "PUT" && details.url.includes("/account_profile")) {
		await invalidateProfileTokens(await requestActiveOrgId(details.tabId));

		const body = await parseRequestBody(details.requestBody);
		const bodyLocale = body?.locale;
		const override = await getStorageValue('languageOverride', null);
		if (bodyLocale && !override) {
			const newLoc = normalizeLocale(bodyLocale);
			const stored = await browser.storage.local.get('lastLang');
			if (normalizeLocale(stored.lastLang || 'en') !== newLoc) {
				await browser.storage.local.set({ lastLang: newLoc, lastLangPinnedUntil: Date.now() + 30000 });
				pendingLocaleReloads.set(details.tabId, newLoc);
				await Log("Account language change detected in PUT body:", newLoc);
			}
		}
	}

	if (["POST", "PATCH", "PUT"].includes(details.method) && details.url.includes("/account/settings")) {
		const orgId = await requestActiveOrgId(details.tabId);
		await invalidateAccountSettings(orgId);
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		await Log("Hit the billing page, let's make sure we get the updated subscription tier in case it was changed...")
		const orgId = await requestActiveOrgId(details.tabId);
		const api = getStrategy().apiForRequest(details, orgId);
		await api.getSubscriptionTier(true);
	}

}

async function onCompletedHandler(details) {
	if (details.method === "PUT" && details.url.includes("/account_profile") &&
		pendingLocaleReloads.has(details.tabId)) {
		const loc = pendingLocaleReloads.get(details.tabId);
		pendingLocaleReloads.delete(details.tabId);
		await Log("Account language changed to", loc, "- reloading tab");
		await browser.tabs.reload(details.tabId);
	}

	if (details.method === "GET" &&
		details.url.includes("/chat_conversations/") &&
		details.url.includes("tree=True") &&
		details.url.includes("render_all_tools=true")) {

		const urlParts = details.url.split('/');
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1]?.split('?')[0];

		if (authoritativeInFlight.has(conversationId)) {
			Log("Tree GET for", conversationId, "— a pass is already in flight, skipping");
			return;
		}

		const treeOrgId = urlParts[urlParts.indexOf('organizations') + 1];
		queueAuthoritativePass({
			orgId: treeOrgId,
			conversationId,
			api: getStrategy().apiForRequest(details, treeOrgId),
			tabId: details.tabId
		});
		tokenStorageManager.addOrgId(treeOrgId);
	}

	if (details.url.includes("/current_leaf_message_uuid")) {
		const urlParts = details.url.split('/');
		const conversationId = urlParts[urlParts.indexOf('chat_conversations') + 1];

		if (branchSwitchTimers.has(conversationId)) {
			clearTimeout(branchSwitchTimers.get(conversationId));
		}

		branchSwitchTimers.set(conversationId, setTimeout(() => {
			branchSwitchTimers.delete(conversationId);
			pendingTasks.push(async () => {
				const orgId = urlParts[urlParts.indexOf('organizations') + 1];

				await conversationCache.delete(conversationId);
				await Log("Branch switch detected — fetching fresh data for:", conversationId);

				const api = getStrategy().apiForRequest(details, orgId);
				const conversation = await api.getConversation(conversationId);
				const conversationData = await conversation.getInfo(false, {
					toolTokens: await lastToolTokens(orgId, conversationId)
				});

				if (conversationData) {
					await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
					await updateTabWithConversationData(details.tabId, conversationData);
				}
			});
			processNextTask();
		}, 5000));
	}

	if (details.url.includes("/v1/sessions/") && details.url.includes("/events")) {
		pendingTasks.push(async () => {
			const orgId = await requestActiveOrgId(details.tabId);
			if (!orgId) return;
			await tokenStorageManager.addOrgId(orgId);
			const api = getStrategy().apiForRequest(details, orgId);
			const usageData = await api.getUsageData();
			await updateAllTabsWithUsage(usageData);
			await scheduleResetNotifications(orgId, usageData);
		});
		processNextTask();
	}
}

async function processNextTask() {
	if (processingLock) {
		const lockAge = Date.now() - processingLock;
		if (lockAge < LOCK_TIMEOUT) {
			return;  // Still legitimately processing
		}
		await Log("warn", `Stale processing lock detected (${lockAge}ms old), clearing`);
	}

	if (pendingTasks.length === 0) return;

	processingLock = Date.now();
	const task = pendingTasks.shift();

	try {
		await task();
	} catch (error) {
		await Log("error", "Task processing failed:", error);
	} finally {
		processingLock = null;

		if (pendingTasks.length > 0) {
			processNextTask();  // Not awaited
		}
	}
}
//#endregion

async function electronUsagePoll() {
	if (electronPollInFlight) return;
	electronPollInFlight = true;
	try {
		await Log("Electron usage poll - fetching fresh usage data");
		await updateAllTabsWithUsage();
	} catch (error) {
		await Log("warn", "Electron usage poll failed:", error);
	} finally {
		electronPollInFlight = false;
	}
}

//#region Variable fill in and initialization
pendingRequests = new StoredMap("pendingRequests");
scheduledNotifications = new StoredMap('scheduledNotifications');
const conversationCache = new StoredMap("conversationCache");
const CONVERSATION_CACHE_TTL = 60 * 60 * 1000; // 60 minutes
const PROVISIONAL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const branchSwitchTimers = new Map();
const authoritativeInFlight = new Set();
const PENDING_REQUEST_TTL = 10 * 60 * 1000;

getAlarm('checkResetNotifications').then(existing => {
	if (!existing) {
		scheduleAlarm('checkResetNotifications', { periodInMinutes: 3 });
		Log("Created repeating checkResetNotifications alarm");
	}
});

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("Done initializing.")

if (isElectron) {
	const ELECTRON_POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
	electronPollingInterval = setInterval(electronUsagePoll, ELECTRON_POLL_INTERVAL_MS);
	Log("Electron usage polling started with interval:", ELECTRON_POLL_INTERVAL_MS, "ms");
}
//#endregion
