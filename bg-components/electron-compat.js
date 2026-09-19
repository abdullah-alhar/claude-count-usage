import '../lib/browser-polyfill.min.js';
import { StoredMap } from './utils.js';

// Claude Desktop has no chrome.alarms / chrome.notifications. The patched main process
// (desktop-injector.js) watches the claude.ai page's console for CUT_ALARM / CUT_NOTIFICATION
// lines and runs the timer or notification natively; fired alarms come back through
// electron_reciever.js as 'electron-alarm' messages.

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

export async function clearAlarm(name) {
	await electronAlarms.delete(name);
	await postToMainProcess('CUT_ALARM:', { action: 'clear', name });
}

// Reads the persisted copy only. Main-process timers do not survive an app restart, so a stored
// entry does not prove the timer is live - periodic alarms are re-armed via rearmAlarms().
export async function getAlarm(name) {
	return await electronAlarms.get(name);
}

export async function scheduleAlarm(name, options) {
	await electronAlarms.set(name, options);
	await postToMainProcess('CUT_ALARM:', { action: 'create', name, ...options });
}

// Re-sends every stored alarm to the main process. Needed because its timers are lost on app
// restart and an alarm created while no claude.ai page was open never reached it at all.
// One-shot alarms whose time has passed are dropped rather than fired late.
export async function rearmAlarms() {
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
	await postToMainProcess('CUT_NOTIFICATION:', options);
}
