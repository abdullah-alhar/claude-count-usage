// The single boundary for how the background reaches claude.ai on behalf of a tab. Claude Desktop
// has one cookie store, so this is a plain background fetch; the rest of the codebase goes through
// getStrategy() so it never has to care about transport.

import { RawLog, sendTabMessage } from './utils.js';
import { ClaudeAPI } from './claude-api.js';

async function Log(...args) {
	await RawLog("container", ...args);
}

class ContainerStrategy {
	async fetch(url, options = {}) {
		return fetch(url, options);
	}

	async activeOrgForTab(tab) {
		try {
			const response = await sendTabMessage(tab.id, { action: "getOrgID" });
			return response?.orgId || null;
		} catch (e) {
			await Log("error", "activeOrgForTab (content script) failed:", e);
			return null;
		}
	}

	apiFor(_ctx, orgId) {
		return new ClaudeAPI(orgId, (url, options) => this.fetch(url, options));
	}

	apiForTab(_tab, orgId) {
		return this.apiFor(null, orgId);
	}

	apiForRequest(_details, orgId) {
		return this.apiFor(null, orgId);
	}
}

const strategy = new ContainerStrategy();

function getStrategy() {
	return strategy;
}

export { getStrategy };
