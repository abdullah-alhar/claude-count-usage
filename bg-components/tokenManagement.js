/* global GPTTokenizer_o200k_base */
import { CONFIG, sleep, RawLog, FORCE_DEBUG, StoredMap, getStorageValue, setStorageValue, removeStorageValue } from './utils.js';

// Create component-specific logger
async function Log(...args) {
	await RawLog("tokenManagement", ...args);
}

// The static multiplier from CONFIG is the fallback until enough real count_tokens samples exist.
// Samples were only ever logged on the (now removed) API-key path, so new installs stay on the
// fallback; entries already recorded still apply until they expire.
const DEFAULT_ESTIMATION_MULTIPLIER = CONFIG.ESTIMATION_MULTIPLIER;
const CALIBRATION_MIN_SAMPLES = 20;
// count_tokens adds per-message framing tokens that o200k never sees; on short texts that overhead
// dominates the ratio, so those samples are left out.
const CALIBRATION_MIN_O200K_TOKENS = 50;
const CALIBRATION_BOUNDS = [1.0, 2.5];

// Token-weighted ratio of real to o200k counts across the calibration log. Weighting by size keeps
// many small samples from outvoting the long conversations whose estimates matter most.
function computeCalibratedMultiplier(entries, fallback = DEFAULT_ESTIMATION_MULTIPLIER) {
	let realSum = 0;
	let o200kSum = 0;
	let samples = 0;
	for (const entry of entries || []) {
		if (!entry || !(entry.real > 0) || !(entry.o200k >= CALIBRATION_MIN_O200K_TOKENS)) continue;
		realSum += entry.real;
		o200kSum += entry.o200k;
		samples++;
	}
	if (samples < CALIBRATION_MIN_SAMPLES || o200kSum === 0) return fallback;
	const ratio = realSum / o200kSum;
	const [lo, hi] = CALIBRATION_BOUNDS;
	return Math.round(Math.min(hi, Math.max(lo, ratio)) * 1000) / 1000;
}
// Move getTextFromContent here since it's token-related
async function getTextFromContent(content, includeEphemeral = false, api = null, orgId = null) {
	let textPieces = [];

	if (content.text) {
		textPieces.push(content.text);
	}

	if (content.thinking && includeEphemeral) {
		textPieces.push(content.thinking);
	}

	if (content.input) {
		textPieces.push(JSON.stringify(content.input));
	}
	if (content.content) {
		if (Array.isArray(content.content)) {
			if (content.type !== "tool_result" || includeEphemeral) {
				for (const nestedContent of content.content) {
					textPieces = textPieces.concat(await getTextFromContent(nestedContent, includeEphemeral, api, orgId));
				}
			}
		}
		else if (typeof content.content === 'object') {
			textPieces = textPieces.concat(await getTextFromContent(content.content, includeEphemeral, api, orgId));
		}
	}

	if (content.type === "knowledge" && includeEphemeral) {
		if (content.url && content.url.length > 0) {
			if (content.url.includes("docs.google.com")) {
				if (api && orgId) {
					const docUuid = content.metadata?.uri;
					if (docUuid) {
						const syncObj = { type: "gdrive", config: { uri: docUuid } };
						await Log("Fetching Google Drive document content:", content.url, "with sync object:", syncObj);
						try {
							const syncText = await api.getSyncText(syncObj);
							if (syncText) {
								textPieces.push(syncText);
								await Log("Retrieved Google Drive document content successfully:", syncText);
							}
						} catch (error) {
							await Log("error", "Error fetching Google Drive document:", error);
						}
					} else {
						await Log("error", "Could not extract document UUID from URL or metadata");
					}
				} else {
					await Log("warn", "API or orgId not provided, cannot fetch Google Drive document");
				}
			}
		}
	}

	return textPieces;
}

class TokenCounter {
	constructor() {
		this.tokenizer = GPTTokenizer_o200k_base;
		this.ESTIMATION_MULTIPLIER = CONFIG.ESTIMATION_MULTIPLIER;
		this.fileTokenCache = new StoredMap("fileTokens");
		this.calibrationLog = new StoredMap("tokenCalibration");
	}

	// Core text counting - the main workhorse. Always local (o200k x multiplier); the optional
	// Anthropic API key path was removed - it needed a developer console key, which a claude.ai
	// account (and every free user) doesn't have.
	async countText(text) {
		if (!text) return 0;
		return Math.round(this.tokenizer.countTokens(text) * this.ESTIMATION_MULTIPLIER);
	}

	// Synchronous twin of countText, for the provisional SSE estimate on the hot path.
	countTextLocal(text) {
		if (!text) return 0;
		return Math.round(this.tokenizer.countTokens(text) * this.ESTIMATION_MULTIPLIER);
	}

	// Count a conversation's messages
	async countMessages(userMessages, assistantMessages) {
		let total = 0;
		for (const msg of [...userMessages, ...assistantMessages]) {
			total += Math.round(this.tokenizer.countTokens(msg) * this.ESTIMATION_MULTIPLIER);
		}
		return total;
	}

	// Log both estimated and real token counts for calibration.
	// Entries expire after 30 days and feed computeCalibratedMultiplier.
	async logCalibration(text, realTokens) {
		try {
			const o200kRaw = this.tokenizer.countTokens(text);
			const estimated = Math.round(o200kRaw * this.ESTIMATION_MULTIPLIER);
			const ratio = o200kRaw > 0 ? (realTokens / o200kRaw).toFixed(3) : 'N/A';

			const entry = {
				ts: Date.now(),
				real: realTokens,
				o200k: o200kRaw,
				estimated,
				ratio: parseFloat(ratio),
				len: text.length,
				multiplier: this.ESTIMATION_MULTIPLIER
			};

			// Use timestamp as key, auto-expires after 30 days
			await this.calibrationLog.set(String(entry.ts), entry, 30 * 24 * 60 * 60 * 1000);

			await Log(`Calibration: real=${realTokens} est=${estimated} o200k=${o200kRaw} ratio=${ratio} len=${text.length}`);
			await this.refreshCalibratedMultiplier();
		} catch (e) {
			// Never let calibration logging break the main flow
			await Log("warn", "Calibration log error:", e);
		}
	}

	// CONFIG is updated too so content scripts (sse_bridge.js) get the same figure via getConfig.
	async refreshCalibratedMultiplier() {
		const entries = await this.calibrationLog.entries();
		const multiplier = computeCalibratedMultiplier(entries.map(([, entry]) => entry));
		if (multiplier !== this.ESTIMATION_MULTIPLIER) {
			await Log(`Estimation multiplier ${this.ESTIMATION_MULTIPLIER} -> ${multiplier} (${entries.length} calibration entries)`);
		}
		this.ESTIMATION_MULTIPLIER = multiplier;
		CONFIG.ESTIMATION_MULTIPLIER = multiplier;
		return multiplier;
	}

	async getCalibrationData() {
		return await this.calibrationLog.entries();
	}

	// Count file tokens with caching
	async getNonTextFileTokens(fileContent, mediaType, fileMetadata, orgId) {
		// Check cache first
		const cacheKey = `${orgId}:${fileMetadata.file_uuid}`;
		const cachedValue = await this.fileTokenCache.get(cacheKey);
		if (cachedValue !== undefined) {
			await Log(`Using cached token count for file ${fileMetadata.file_uuid}: ${cachedValue}`);
			return cachedValue;
		}

		// Estimated from file metadata (page count / image size)
		const tokens = this.estimateFileTokens(fileMetadata);
		await this.fileTokenCache.set(cacheKey, tokens);
		return tokens;
	}

	// Estimate file tokens based on type
	estimateFileTokens(fileMetadata) {
		if (fileMetadata.file_kind === "image") {
			const width = fileMetadata.preview_asset.image_width;
			const height = fileMetadata.preview_asset.image_height;
			return Math.min(1600, Math.ceil((width * height) / 750));
		} else if (fileMetadata.file_kind === "document") {
			return 2250 * fileMetadata.document_asset.page_count;
		}
		return 0;
	}

}

// How long an org stays "known" without being seen again. Refreshed on every sighting so active
// accounts persist; idle ones drop out so the popup doesn't keep listing accounts you no longer use.
const KNOWN_ORG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Token storage manager (simplified - only org ID tracking and total tokens)
class TokenStorageManager {
	constructor() {
		// TTL'd set of orgs we've seen recently (value is unused; the key + expiry is the data).
		this.knownOrgs = new StoredMap('knownOrgsV2');
	}

	async addOrgId(orgId) {
		// Always write to refresh the TTL on every sighting.
		await this.knownOrgs.set(orgId, true, KNOWN_ORG_TTL_MS);
	}

	// Non-expired orgs we've seen recently (entries() prunes expired keys on read).
	async getKnownOrgIds() {
		return (await this.knownOrgs.entries()).map(([orgId]) => orgId);
	}

	async getTotalTokens() {
		return await getStorageValue('totalTokensTracked', 0);
	}

	async addToTotalTokens(tokens) {
		const current = await this.getTotalTokens();
		await setStorageValue('totalTokensTracked', current + tokens);
	}
}

const tokenCounter = new TokenCounter();
const tokenStorageManager = new TokenStorageManager();
tokenCounter.refreshCalibratedMultiplier().catch(error => Log("warn", "Calibration load failed:", error));
export { getTextFromContent, tokenCounter, tokenStorageManager, computeCalibratedMultiplier };