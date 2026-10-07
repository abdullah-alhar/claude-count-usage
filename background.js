import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter } from './bg-components/tokenManagement.js';
import { getStrategy } from './bg-components/container-strategy.js';
import { UsageData, modelFamilyFromVersion, defaultModelForTier, defaultModelVersionForTier } from './shared/dataclasses.js';
import { translate, normalizeLocale } from './shared/localization.js';
import { scheduleAlarm, getAlarm, clearAlarm, rearmAlarms, createNotification } from './bg-components/electron-compat.js';
import { checkForUpdates, detectPlatform, isStatusStale, UPDATE_CHECK_INTERVAL_MS, UPDATE_STATUS_KEY, AUTO_UPDATE_CHECK_KEY } from './bg-components/update-check.js';
import { invalidateAccountSettings, invalidateProfileTokens, storeSseUsage } from './bg-components/claude-api.js';

const INTERCEPT_PATTERNS = {
	onBeforeRequest: {
		regexes: [
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
			"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
			"^https?://claude\\.ai/api/settings/billing",
			"^https?://claude\\.ai/api/account_profile$",
			"^https?://claude\\.ai/api/account/settings"
		]
	},
	onCompleted: {
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
// Minimum gap between a /usage fetch and the automatic post-stream refetch; a refetch that lands
// inside it is deferred to its end. Prevents rapid back-to-back messages from hammering the endpoint. Completely independent
// of the manual Refresh button's 2-second UI cooldown in settings_card.js.
const POST_STREAM_COOLDOWN_MS = 10_000;  // 10 seconds
let lastUsageFetchMs = 0;  // epoch ms of last successful /usage fetch (shared across all codepaths)
let deferredPostStreamRefresh = null;  // timer for a post-stream fetch pushed past the cooldown
let pendingRequests;
let scheduledNotifications;
let heartbeatInFlight = false;

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

//Alarm listeners

async function handleAlarm(alarmName) {
	await Log("Alarm triggered:", alarmName);

	if (alarmName.startsWith('resetRefresh:')) {
		const parts = alarmName.split(':');
		const orgId = parts[1];
		try {
			await clearAlarm(alarmName).catch(() => {});
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			if (tabs.length > 0) {
				const tab = tabs[0];
				const activeOrgId = orgId || (await requestActiveOrgId(tab));
				const api = getStrategy().apiForTab(tab, activeOrgId);
				await refreshUsage(api, activeOrgId);
				await checkResetNotifications();
				await Log("Reset refresh completed for org:", activeOrgId);
			} else {
				await Log("Reset refresh alarm fired but no claude.ai tab open");
			}
		} catch (error) {
			await Log("warn", "Reset refresh failed:", error);
		}
		return;
	}

	if (alarmName === 'checkResetNotifications') {
		await checkResetNotifications();
		return;
	}

	if (alarmName === USAGE_HEARTBEAT_ALARM) {
		await runUsageHeartbeat('alarm');
		return;
	}

	if (alarmName === UPDATE_CHECK_ALARM) {
		await runScheduledUpdateCheck();
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
// Alarms are timers in the desktop app's main process; they fire into the page, and
// electron_reciever.js relays them here.
messageRegistry.register('electron-alarm', (msg) => {
	handleAlarm(msg.name);
});


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
			const errorUsage = new UsageData({
				subscriptionTier: 'unknown',
				loadError: true,
				fetchSuccess: false,
				errorDetails: error.message || String(error)
			});
			sendTabMessage(tab.id, {
				type: 'updateUsage',
				data: {
					usageData: errorUsage.toJSON()
				}
			}).catch(() => {});
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

// The Anthropic API key feature was removed; drop a key saved by an older version so it doesn't
// sit in storage unused.
removeStorageValue('apiKey').catch(() => {});

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

messageRegistry.register('getMonkeypatchPatterns', () => INTERCEPT_PATTERNS);

// Unified usage fetch path — queries api.getUsageData(), updates notifications and all tabs.
// Records lastUsageFetchMs on every successful fetch so callers can throttle auto-refetches.
async function refreshUsage(api, orgId) {
	const usageData = await api.getUsageData();
	// Record the timestamp regardless of whether the response was an error — a 500 still consumed
	// the request, and we don't want the next message to immediately retry a broken endpoint.
	lastUsageFetchMs = Date.now();
	await scheduleResetNotifications(orgId, usageData);
	await updateAllTabsWithUsage(usageData);
	return usageData;
}

// Complex handlers
async function requestData(message, sender, orgId) {
	const { conversationId } = message;

	const api = getStrategy().apiForTab(sender.tab, orgId);
	const usageData = await refreshUsage(api, orgId);

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

// Manual usage refresh triggered from the settings card
async function refreshUsageData(message, sender, orgId) {
	if (!orgId || !sender?.tab) return { success: false, error: 'No active tab or org' };
	const api = getStrategy().apiForTab(sender.tab, orgId);
	try {
		const usageData = await refreshUsage(api, orgId);
		const isError = (typeof usageData.isLoadError === 'function' && usageData.isLoadError()) ||
			usageData.loadError === true || usageData.fetchSuccess === false;
		return {
			success: !isError,
			isLoadError: isError,
			errorDetails: usageData.errorDetails
		};
	} catch (error) {
		await Log("warn", "Manual usage refresh failed:", error);
		return {
			success: false,
			isLoadError: true,
			errorDetails: error.message || String(error)
		};
	}
}
messageRegistry.register('refreshUsageData', refreshUsageData);

// Trigger a fresh /usage fetch after a completed message so newly reported limits (e.g. the 5h
// session bar appearing on a fresh/reset session) are picked up. Within the cooldown the fetch is
// deferred to the end of it rather than dropped: the fetch that started the cooldown is usually
// the conversation load from just before the message was sent, so it cannot reflect the message.
// Dropping it left the bars stale until the next heartbeat. This cooldown is independent of the
// manual Refresh button's own 2-second UI cooldown in settings_card.js.
async function schedulePostStreamRefresh(api, orgId) {
	const streamEndedAt = Date.now();
	const queueRefresh = () => {
		pendingTasks.push(async () => {
			try {
				await refreshUsage(api, orgId);
			} catch (error) {
				await Log("warn", "Post-stream usage refresh failed:", error);
			}
		});
		processNextTask();
	};

	const msSinceLastFetch = streamEndedAt - lastUsageFetchMs;
	if (msSinceLastFetch >= POST_STREAM_COOLDOWN_MS) {
		queueRefresh();
		return 'now';
	}
	if (deferredPostStreamRefresh) {
		await Log("Post-stream refetch already deferred - coalescing");
		return 'coalesced';
	}
	const delay = POST_STREAM_COOLDOWN_MS - msSinceLastFetch;
	await Log(`Post-stream refetch deferred ${delay}ms - last fetch was ${msSinceLastFetch}ms ago (cooldown: ${POST_STREAM_COOLDOWN_MS}ms)`);
	deferredPostStreamRefresh = setTimeout(() => {
		deferredPostStreamRefresh = null;
		// Anything fetched after the stream ended (heartbeat, another message) already has it.
		if (lastUsageFetchMs >= streamEndedAt) return;
		queueRefresh();
	}, delay);
	return 'deferred';
}

async function reportStreamCompletion(message, sender, orgId) {
	if (!orgId || !sender?.tab) return false;

	const api = getStrategy().apiForTab(sender.tab, orgId);
	await storeSseUsage(api, message.sseLimits);

	await schedulePostStreamRefresh(api, orgId);

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

async function interceptedRequest(message, sender) {
	await Log("Got intercepted request");
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onBeforeRequestHandler(message.details);
	return true;
}
messageRegistry.register(interceptedRequest);

async function interceptedResponse(message, sender) {
	await Log("Got intercepted response");
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

async function getCalibrationData() {
	return await tokenCounter.getCalibrationData();
}
messageRegistry.register(getCalibrationData);

// Main handler function
async function handleMessageFromContent(message, sender) {
	// Reject messages not sent from this extension's own context; otherwise an untrusted
	// sender could invoke privileged handlers (storage, notifications, update checks).
	if (sender.id !== browser.runtime.id) {
		return;
	}
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

	const conversationData = await conversation.getInfo(isNewMessage, {
		toolTokens: pendingRequest?.toolTokens || 0
	});

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		return false;
	}

	// The model this message was sent with when the request named one, else the conversation's own
	// model as the API reports it (getInfo already resolved that, falling back to the plan default).
	const model = pendingRequest?.model || conversationData.model || defaultModelForTier(usageData.subscriptionTier);
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

const RESET_REFRESH_BUFFER_MS = 3000;

async function scheduleResetNotifications(orgId, usageData) {
	if (!usageData || !orgId) return;

	const threshold = await getStorageValue('resetNotifThreshold', 100);
	const maxedLimits = (typeof usageData.getMaxedLimits === 'function') ? usageData.getMaxedLimits(threshold) : [];

	for (const limit of maxedLimits) {
		if (limit.resetsAt <= Date.now()) continue;

		const timestampKey = limit.resetsAt.toString();

		if (await scheduledNotifications.has(timestampKey)) continue;

		const expiryTime = limit.resetsAt + (60 * 60 * 1000) - Date.now();
		await scheduledNotifications.set(timestampKey, orgId, expiryTime);

		await Log(`Stored pending reset: ${limit.key} for ${new Date(limit.resetsAt).toISOString()}`);
	}

	// Schedule prompt data refresh at resets_at + buffer for any active limit with a future reset
	const activeLimits = (typeof usageData.getActiveLimits === 'function') ? usageData.getActiveLimits() : [];
	const now = Date.now();

	for (const limit of activeLimits) {
		if (!limit.resetsAt) continue;
		const resetsAtMs = typeof limit.resetsAt === 'number' ? limit.resetsAt : new Date(limit.resetsAt).getTime();
		if (isNaN(resetsAtMs) || resetsAtMs <= now) continue;

		const timestampKey = resetsAtMs.toString();
		const alarmName = `resetRefresh:${orgId}:${limit.key}:${timestampKey}`;
		const refreshWhen = resetsAtMs + RESET_REFRESH_BUFFER_MS;

		try {
			const existing = await getAlarm(alarmName);
			if (!existing) {
				await scheduleAlarm(alarmName, { when: refreshWhen });
				await Log(`Scheduled prompt reset refresh alarm "${alarmName}" for ${new Date(refreshWhen).toISOString()}`);
			}
		} catch (error) {
			await Log("warn", `Failed to schedule reset refresh alarm for ${limit.key}:`, error);
		}
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

		// Only what the request itself names. claude.ai often leaves `model` out and serves the
		// conversation's own model; recording the plan default in its place made every later pass
		// override the API's real model with it (Opus 5.5 chats priced as Sonnet 5). null lets the
		// conversation's model from the API stand.
		const modelVersion = requestBodyJSON?.model || null;
		const model = modelVersion ? (modelFamilyFromVersion(modelVersion) || defaultModelForTier(subscriptionTier)) : null;
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

//#region Periodic refresh & update checks
// Idle refresh. Driven by a main-process alarm rather than setInterval here, because the service
// worker is torn down when idle and its timers die with it; the alarm wakes it back up.
const USAGE_HEARTBEAT_ALARM = 'usageHeartbeat';
const USAGE_HEARTBEAT_MINUTES = 2;
// A heartbeat or focus refresh is skipped if any codepath fetched /usage more recently than this.
const HEARTBEAT_MIN_GAP_MS = 60_000;
const UPDATE_CHECK_ALARM = 'updateCheck';

async function runUsageHeartbeat(reason) {
	if (heartbeatInFlight) return false;
	const sinceLast = Date.now() - lastUsageFetchMs;
	if (sinceLast < HEARTBEAT_MIN_GAP_MS) {
		await Log(`Usage heartbeat (${reason}) skipped - last fetch ${sinceLast}ms ago`);
		return false;
	}
	heartbeatInFlight = true;
	try {
		const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
		if (tabs.length === 0) return false;
		const orgId = await requestActiveOrgId(tabs[0]);
		if (!orgId) return false;
		await refreshUsage(getStrategy().apiForTab(tabs[0], orgId), orgId);
		await Log(`Usage heartbeat (${reason}) refreshed org ${orgId}`);
		return true;
	} catch (error) {
		await Log("warn", `Usage heartbeat (${reason}) failed:`, error);
		return false;
	} finally {
		heartbeatInFlight = false;
	}
}

async function ensurePeriodicAlarms() {
	const periodic = [
		['checkResetNotifications', 3],
		[USAGE_HEARTBEAT_ALARM, USAGE_HEARTBEAT_MINUTES]
	];
	if (await getStorageValue(AUTO_UPDATE_CHECK_KEY, true)) {
		periodic.push([UPDATE_CHECK_ALARM, UPDATE_CHECK_INTERVAL_MS / 60_000]);
	} else {
		await clearAlarm(UPDATE_CHECK_ALARM);
	}
	for (const [name, periodInMinutes] of periodic) {
		const existing = await getAlarm(name);
		if (existing?.periodInMinutes !== periodInMinutes) {
			await scheduleAlarm(name, { periodInMinutes });
		}
	}
}

async function runUpdateCheck() {
	return checkForUpdates({
		fetchImpl: (url, options) => fetch(url, options),
		currentVersion: browser.runtime.getManifest().version,
		platform: detectPlatform(navigator.userAgent),
		now: Date.now(),
		getStorageValue,
		setStorageValue
	});
}

// The alarm only lives while the desktop app runs, so also check on page load when the last
// result is older than the interval. Both paths respect the automatic-check toggle.
async function runScheduledUpdateCheck() {
	if (!await getStorageValue(AUTO_UPDATE_CHECK_KEY, true)) return null;
	const status = await getStorageValue(UPDATE_STATUS_KEY, null);
	if (!isStatusStale(status, Date.now())) return status;
	const result = await runUpdateCheck();
	await Log("Update check:", result);
	return result;
}

messageRegistry.register('electronPageReady', async () => {
	await ensurePeriodicAlarms();
	await rearmAlarms();
	await runUsageHeartbeat('page-ready');
	await runScheduledUpdateCheck().catch(error => Log("warn", "Update check failed:", error));
	return true;
});

// Returning to the window is when stale numbers are most noticeable.
messageRegistry.register('electronTabActivated', () => {
	runUsageHeartbeat('focus');
	return true;
});

messageRegistry.register('getUpdateStatus', async () => ({
	currentVersion: browser.runtime.getManifest().version,
	autoCheck: await getStorageValue(AUTO_UPDATE_CHECK_KEY, true),
	status: await getStorageValue(UPDATE_STATUS_KEY, null)
}));

// Manual check: deliberately ignores the automatic-check toggle and the staleness window.
messageRegistry.register('checkForUpdatesNow', () => runUpdateCheck());

messageRegistry.register('setAutoUpdateCheck', async (message) => {
	await setStorageValue(AUTO_UPDATE_CHECK_KEY, !!message.value);
	await ensurePeriodicAlarms();
	// Re-enabling after a long time off would otherwise wait a full interval for the first alarm.
	if (message.value) runScheduledUpdateCheck().catch(error => Log("warn", "Update check failed:", error));
	return true;
});
//#endregion

//#region Variable fill in and initialization
pendingRequests = new StoredMap("pendingRequests");
scheduledNotifications = new StoredMap('scheduledNotifications');
const conversationCache = new StoredMap("conversationCache");
const CONVERSATION_CACHE_TTL = 60 * 60 * 1000; // 60 minutes
const PROVISIONAL_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const branchSwitchTimers = new Map();
const authoritativeInFlight = new Set();
const PENDING_REQUEST_TTL = 10 * 60 * 1000;

ensurePeriodicAlarms().catch(error => Log("warn", "Failed to arm periodic alarms:", error));

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("Done initializing.")
//#endregion
