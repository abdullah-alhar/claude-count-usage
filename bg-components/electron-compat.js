import '../lib/browser-polyfill.min.js';
import { StoredMap } from './utils.js';

// Claude Desktop has no chrome.alarms / chrome.notifications. The patched main process
// (desktop-injector.js) watches the claude.ai page's console for CUT_ALARM / CUT_NOTIFICATION
// lines and runs the timer or notification natively; fired alarms come back through
// electron_reciever.js as 'electron-alarm' messages.
// In Chrome (the Web Store build) the native APIs exist and are used directly instead.
export const hasNativeAlarms = typeof chrome !== 'undefined' && typeof chrome.alarms?.create === 'function';
const hasNativeNotifications = typeof chrome !== 'undefined' && typeof chrome.notifications?.create === 'function';

const electronAlarms = new StoredMap('electronAlarms');

async function postToMainProcess(prefix, payload) {
	const tabs = await chrome.tabs.query({ url: '*://claude.ai/*' });
	if (tabs.length === 0) return false;
	await chrome.scripting.executeScript({
		target: { tabId: tabs[0].id },
		func: (line) => { console.log(line); },
		args: [prefix + JSON.stringify(payload)]
	});
	return true;
}

// Must be called synchronously at service-worker startup so Chrome can wake the worker for it.
export function onNativeAlarm(handler) {
	if (hasNativeAlarms) chrome.alarms.onAlarm.addListener(alarm => handler(alarm.name));
}

export async function clearAlarm(name) {
	if (hasNativeAlarms) {
		await chrome.alarms.clear(name);
		return;
	}
	await electronAlarms.delete(name);
	await postToMainProcess('CUT_ALARM:', { action: 'clear', name });
}

// Reads the persisted copy only. Main-process timers do not survive an app restart, so a stored
// entry does not prove the timer is live - periodic alarms are re-armed via rearmAlarms().
export async function getAlarm(name) {
	if (hasNativeAlarms) return await chrome.alarms.get(name);
	return await electronAlarms.get(name);
}

export async function scheduleAlarm(name, options) {
	if (hasNativeAlarms) {
		await chrome.alarms.create(name, options);
		return;
	}
	await electronAlarms.set(name, options);
	await postToMainProcess('CUT_ALARM:', { action: 'create', name, ...options });
}

// Re-sends every stored alarm to the main process. Needed because its timers are lost on app
// restart and an alarm created while no claude.ai page was open never reached it at all.
// One-shot alarms whose time has passed are dropped rather than fired late.
// Chrome persists its own alarms, so there is nothing to do there.
export async function rearmAlarms() {
	if (hasNativeAlarms) return;
	const now = Date.now();
	for (const [name, options] of await electronAlarms.entries()) {
		if (options?.when && !options.periodInMinutes && options.when <= now) {
			await electronAlarms.delete(name);
			continue;
		}
		await postToMainProcess('CUT_ALARM:', { action: 'create', name, ...options });
	}
}

export async function createNotification(options) {
	if (hasNativeNotifications) {
		await chrome.notifications.create(options);
		return;
	}
	await postToMainProcess('CUT_NOTIFICATION:', options);
}
