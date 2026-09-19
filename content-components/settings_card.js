/* global sendBackgroundMessage, Log, BLUE_HIGHLIGHT, SUCCESS_GREEN, RED_WARNING,
   SIDEBAR_DISPLAY_KEY, getSidebarDisplayPrefs, isSidebarItemVisible, setSidebarDisplayPref,
   localize, localeForIntl, applyLocale, usageUI */
'use strict';

// Settings floating card — opened by the ⚙️ gear button in the sidebar header. Kept short on
// purpose; explanations live in tooltips rather than on the card.
//   1. Usage          — manual refresh, visible bars
//   2. Notifications  — reset notification toggle (+ threshold while it's on)
//   3. Updates        — version / status line, manual check, automatic check toggle
//   4. More           — language override, debug logs
//
// Everything is backed by message handlers in background.js; this file only renders and relays.

// Native names are deliberately not localized: people look for their own language by its own name.
const LANGUAGE_NAMES = {
	'en': 'English',
	'fr': 'Français',
	'de': 'Deutsch',
	'hi': 'हिन्दी',
	'id': 'Bahasa Indonesia',
	'it': 'Italiano',
	'ja': '日本語',
	'ko': '한국어',
	'pt-BR': 'Português (Brasil)',
	'es': 'Español'
};

// Release links come from the GitHub API response. Only ever render github.com https URLs as links,
// so a malformed or hostile payload can't turn into a javascript: or off-site link.
function isSafeReleaseUrl(url) {
	return typeof url === 'string' && /^https:\/\/github\.com\//.test(url);
}

function formatRelativeTime(timestamp) {
	const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
	const units = [['day', 86400], ['hour', 3600], ['minute', 60]];
	try {
		const rtf = new Intl.RelativeTimeFormat(localeForIntl(), { numeric: 'auto' });
		for (const [unit, seconds] of units) {
			if (Math.abs(diffSeconds) >= seconds) return rtf.format(Math.round(diffSeconds / seconds), unit);
		}
		return rtf.format(0, 'minute');
	} catch (e) {
		return new Date(timestamp).toLocaleString();
	}
}

function detectInstallPlatform() {
	const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
	if (/Mac/i.test(ua)) return 'mac';
	if (/Win/i.test(ua)) return 'windows';
	return 'other';
}

class SettingsCard {
	constructor() {
		this.isOpen = false;
		this.elements = null;
		this.lastPosition = null;
		this._onEsc = (e) => { if (e.key === 'Escape') this.close(); };
		this._onClickOutside = (e) => {
			if (this.elements && !this.elements.card.contains(e.target)) this.close();
		};

		document.addEventListener('ut:toggleSettings', (e) => {
			if (this.isOpen) {
				this.close();
			} else {
				this.open(e.detail?.position);
			}
		});
	}

	async open(position) {
		if (this.isOpen) return;
		this.isOpen = true;

		if (!this.elements) {
			this.elements = this.createElement();
			document.body.appendChild(this.elements.card);
		}

		// Position near the gear button
		const card = this.elements.card;
		card.style.display = 'flex';
		if (position) this.lastPosition = position;

		if (this.lastPosition) {
			card.style.top = `${this.lastPosition.top}px`;
			card.style.left = `${this.lastPosition.left}px`;
		}

		// Ensure card stays within viewport
		requestAnimationFrame(() => {
			const rect = card.getBoundingClientRect();
			if (rect.right > window.innerWidth - 8) {
				card.style.left = `${Math.max(8, window.innerWidth - rect.width - 8)}px`;
			}
			if (rect.bottom > window.innerHeight - 8) {
				card.style.top = `${Math.max(8, window.innerHeight - rect.height - 8)}px`;
			}
		});

		// Load current values
		await this.loadCurrentState();

		setTimeout(() => {
			document.addEventListener('keydown', this._onEsc);
			document.addEventListener('mousedown', this._onClickOutside);
		}, 50);
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;

		if (this.elements) {
			this.elements.card.style.display = 'none';
		}

		document.removeEventListener('keydown', this._onEsc);
		document.removeEventListener('mousedown', this._onClickOutside);
	}

	// Throws the card away and builds it again in the current locale, keeping it open in place.
	async rebuild() {
		const wasOpen = this.isOpen;
		this.close();
		if (this.elements) {
			this.elements.card.remove();
			this.elements = null;
		}
		if (wasOpen) await this.open();
	}

	// ── Building blocks ──────────────────────────────────────────────────────

	el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	createSection(titleKey) {
		const container = this.el('section', 'ut-settings-section');
		container.appendChild(this.el('h4', 'ut-settings-section-title text-text-500', localize(titleKey)));
		const group = this.el('div', 'ut-settings-group');
		container.appendChild(group);
		return { container, group };
	}

	createRow(extraClass) {
		return this.el('div', 'ut-settings-row' + (extraClass ? ' ' + extraClass : ''));
	}

	createSwitch(labelText, onChange) {
		const row = this.el('label', 'ut-settings-row ut-settings-switch-row');
		const text = this.el('span', 'ut-settings-row-label text-text-100', labelText);

		const input = document.createElement('input');
		input.type = 'checkbox';
		input.className = 'ut-switch-input';
		input.setAttribute('role', 'switch');
		input.addEventListener('change', () => onChange(input.checked));

		const track = this.el('span', 'ut-switch');
		track.setAttribute('aria-hidden', 'true');

		row.appendChild(text);
		row.appendChild(input);
		row.appendChild(track);
		return { row, input };
	}

	createButton(text, variant, onClick) {
		const btn = this.el('button', `ut-button ut-settings-btn ut-settings-btn-${variant} text-xs`, text);
		btn.type = 'button';
		btn.addEventListener('click', onClick);
		return btn;
	}

	createStatusLine(className) {
		const status = this.el('div', 'ut-settings-inline-status text-xs' + (className ? ' ' + className : ''));
		status.style.display = 'none';
		return status;
	}

	// ── Card ─────────────────────────────────────────────────────────────────

	createElement() {
		const card = this.el('div', 'ut-settings-card bg-bg-100 text-text-100');
		card.style.display = 'none';
		card.setAttribute('role', 'dialog');
		card.setAttribute('aria-label', localize('settings.title'));

		const header = this.el('div', 'ut-settings-header');
		const title = this.el('h3', 'ut-settings-title text-text-100', localize('settings.title'));
		const version = this.el('span', 'ut-settings-version text-text-500');
		const closeBtn = this.el('button', 'ut-button ut-settings-close text-text-400');
		closeBtn.type = 'button';
		closeBtn.setAttribute('aria-label', localize('settings.close'));
		closeBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
		closeBtn.addEventListener('click', () => this.close());
		header.appendChild(title);
		header.appendChild(version);
		header.appendChild(closeBtn);
		card.appendChild(header);

		const body = this.el('div', 'ut-settings-body');
		card.appendChild(body);

		const usage = this.createUsageSection();
		const notifications = this.createNotificationsSection();
		const updates = this.createUpdatesSection();
		const more = this.createMoreSection();
		for (const section of [usage, notifications, updates, more]) {
			body.appendChild(section.container);
		}

		return { card, headerVersion: version, ...usage, ...notifications, ...updates, ...more };
	}

	// ── 1. Usage & Refresh ───────────────────────────────────────────────────

	createUsageSection() {
		const { container, group } = this.createSection('settings.section_usage');

		const refreshRow = this.createRow('ut-settings-row-split');
		const refreshLabel = this.el('span', 'ut-settings-row-label text-text-100', localize('settings.refresh_label'));
		refreshLabel.title = localize('settings.refresh_hint');
		refreshRow.appendChild(refreshLabel);
		const refreshBtn = this.el('button', 'ut-button ut-settings-btn ut-settings-btn-secondary ut-settings-refresh-btn text-xs', localize('settings.refresh'));
		refreshBtn.type = 'button';
		refreshBtn.title = localize('settings.refresh_hint');
		refreshBtn.addEventListener('click', () => this.refreshUsage());
		refreshRow.appendChild(refreshBtn);
		group.appendChild(refreshRow);

		const refreshStatus = this.createStatusLine('ut-settings-refresh-status');
		group.appendChild(refreshStatus);

		const barsRow = this.createRow('ut-settings-row-stack');
		barsRow.appendChild(this.el('span', 'ut-settings-hint text-text-400', localize('settings.display_label')));
		const checkboxList = this.el('div', 'ut-settings-checkbox-list');
		barsRow.appendChild(checkboxList);
		group.appendChild(barsRow);

		return { container, checkboxList, refreshBtn, refreshStatus };
	}

	async refreshUsage() {
		const btn = this.elements?.refreshBtn;
		const status = this.elements?.refreshStatus;
		if (!btn || btn.disabled) return;

		btn.disabled = true;
		status.style.display = 'block';
		status.style.color = BLUE_HIGHLIGHT;
		status.textContent = localize('settings.refreshing') || 'Refreshing…';

		try {
			const res = await sendBackgroundMessage({ type: 'refreshUsageData' });
			if (res && res.success) {
				status.style.color = SUCCESS_GREEN;
				status.textContent = localize('settings.refresh_success') || '✓ Updated';
				await this.rebuildDisplayToggles();
			} else {
				status.style.color = RED_WARNING;
				status.textContent = res?.errorDetails ? `✗ ${res.errorDetails}` : (localize('settings.refresh_error') || '✗ Refresh failed');
			}
		} catch (err) {
			status.style.color = RED_WARNING;
			status.textContent = localize('settings.refresh_error') || '✗ Refresh failed';
			await Log('warn', 'Settings: Manual usage refresh failed:', err);
		} finally {
			// Cooldown to prevent spam-clicking
			setTimeout(() => {
				if (btn) btn.disabled = false;
				setTimeout(() => {
					if (status && status.textContent === (localize('settings.refresh_success') || '✓ Updated')) {
						status.style.display = 'none';
					}
				}, 1500);
			}, 2000);
		}
	}

	async rebuildDisplayToggles() {
		const checkboxList = this.elements.checkboxList;
		checkboxList.innerHTML = '';

		// Get the available limit keys from the usage UI
		// The usageUI instance exposes availableLimitKeys()
		const limitKeys = typeof usageUI !== 'undefined' ? usageUI.availableLimitKeys() : ['session', 'weekly', 'extraUsage'];
		const prefs = await getSidebarDisplayPrefs();

		const labelKeys = {
			session: 'usage.label_session',
			weekly: 'usage.label_weekly',
			sonnetWeekly: 'usage.label_sonnet_weekly',
			opusWeekly: 'usage.label_opus_weekly',
			fableWeekly: 'usage.label_fable_weekly',
			extraUsage: 'usage.label_extra'
		};

		for (const key of limitKeys) {
			const row = this.el('label', 'ut-settings-checkbox-row text-text-200 text-xs');

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'ut-settings-checkbox';
			checkbox.checked = isSidebarItemVisible(prefs, key);
			checkbox.addEventListener('change', () => {
				setSidebarDisplayPref(key, checkbox.checked);
			});

			row.appendChild(checkbox);
			// The sidebar labels end in a colon ("Session (5h):"); a checkbox label shouldn't.
			const label = labelKeys[key] ? localize(labelKeys[key]) : key;
			row.appendChild(this.el('span', '', label.replace(/\s*[:：]\s*$/, '')));
			checkboxList.appendChild(row);
		}
	}

	// ── 2. Notifications ─────────────────────────────────────────────────────

	createNotificationsSection() {
		const { container, group } = this.createSection('settings.section_notifications');

		const { row: toggleRow, input: notifToggle } = this.createSwitch(localize('settings.notif_toggle'), async (checked) => {
			notifThreshold.disabled = !checked;
			thresholdRow.style.display = checked ? '' : 'none';
			try {
				await sendBackgroundMessage({ type: 'setResetNotifEnabled', value: checked });
			} catch (e) {
				await Log('warn', 'Settings: Failed to save reset notification toggle:', e);
			}
		});
		group.appendChild(toggleRow);

		const thresholdRow = this.createRow('ut-settings-row-split');
		thresholdRow.appendChild(this.el('span', 'ut-settings-row-label text-text-300', localize('settings.notif_threshold')));
		const inputWrap = this.el('span', 'ut-settings-number-wrap');
		const notifThreshold = document.createElement('input');
		notifThreshold.type = 'number';
		notifThreshold.min = '1';
		notifThreshold.max = '100';
		notifThreshold.step = '1';
		notifThreshold.className = 'ut-settings-input ut-settings-number bg-bg-100 text-text-100 text-xs';
		notifThreshold.addEventListener('change', () => this.saveNotifThreshold());
		inputWrap.appendChild(notifThreshold);
		inputWrap.appendChild(this.el('span', 'text-text-400 text-xs', '%'));
		thresholdRow.appendChild(inputWrap);
		group.appendChild(thresholdRow);

		return { container, notifToggle, notifThreshold, notifThresholdRow: thresholdRow };
	}

	async saveNotifThreshold() {
		const input = this.elements.notifThreshold;
		try {
			await sendBackgroundMessage({ type: 'setResetNotifThreshold', value: input.value });
			// The background clamps to 1-100; show what was actually stored.
			input.value = String(await sendBackgroundMessage({ type: 'getResetNotifThreshold' }));
		} catch (e) {
			await Log('warn', 'Settings: Failed to save reset notification threshold:', e);
		}
	}

	// ── 3. Updates ───────────────────────────────────────────────────────────

	createUpdatesSection() {
		const { container, group } = this.createSection('settings.section_updates');

		// Version + status line and the check button; filled by renderUpdateStatus()
		const checkRow = this.createRow('ut-settings-row-split');
		const updateInfo = this.el('div', 'ut-settings-update-line');
		const updateCheckBtn = this.createButton(localize('settings.update_check_now'), 'secondary', () => this.checkForUpdatesNow());
		checkRow.appendChild(updateInfo);
		checkRow.appendChild(updateCheckBtn);
		group.appendChild(checkRow);

		const updateCheckStatus = this.createStatusLine();
		group.appendChild(updateCheckStatus);

		// Only shown when a newer release exists
		const updateCallout = this.createRow('ut-settings-row-note');
		updateCallout.style.display = 'none';
		group.appendChild(updateCallout);

		const { row: autoRow, input: updateAutoToggle } = this.createSwitch(localize('settings.update_auto'), async (checked) => {
			try {
				await sendBackgroundMessage({ type: 'setAutoUpdateCheck', value: checked });
			} catch (e) {
				await Log('warn', 'Settings: Failed to save automatic update check toggle:', e);
			}
		});
		autoRow.title = localize('settings.update_auto_hint');
		group.appendChild(autoRow);

		return { container, updateInfo, updateCallout, updateAutoToggle, updateCheckBtn, updateCheckStatus };
	}

	renderUpdateStatus(currentVersion, status) {
		const { updateInfo, updateCallout, headerVersion } = this.elements;
		updateInfo.innerHTML = '';
		updateCallout.innerHTML = '';
		updateCallout.style.display = 'none';
		// The version lives in the header; the row itself only says where things stand.
		headerVersion.textContent = currentVersion ? `v${currentVersion}` : '';
		headerVersion.title = localize('settings.update_version', { version: currentVersion || '?' });

		let stateText = null;
		let stateColor = '';
		if (status?.updateAvailable && status.latestVersion) {
			stateText = localize('settings.update_available');
			stateColor = BLUE_HIGHLIGHT;
		} else if (status?.error) {
			stateText = localize('settings.update_error');
			stateColor = RED_WARNING;
		} else if (status?.latestVersion) {
			stateText = localize('settings.update_up_to_date');
			stateColor = SUCCESS_GREEN;
		}
		const stateLine = this.el('div', 'ut-settings-row-label text-text-300', stateText || localize('settings.update_never'));
		if (stateColor) stateLine.style.color = stateColor;
		stateLine.title = status?.checkedAt
			? localize('settings.update_checked_at', { time: formatRelativeTime(status.checkedAt) }) + (status.error ? ` — ${status.error}` : '')
			: localize('settings.update_never');
		updateInfo.appendChild(stateLine);

		if (!(status?.updateAvailable && status.latestVersion)) return;

		const callout = this.el('div', 'ut-settings-update-callout');
		const versions = this.el('div', 'ut-settings-update-versions text-text-100');
		versions.appendChild(this.el('span', 'text-text-400', currentVersion));
		versions.appendChild(this.el('span', 'ut-settings-update-arrow', '→'));
		versions.appendChild(this.el('span', 'ut-settings-update-latest', status.latestVersion));
		callout.appendChild(versions);
		callout.appendChild(this.el('div', 'ut-settings-hint text-text-300', localize(`settings.update_how_${detectInstallPlatform()}`)));

		const links = this.el('div', 'ut-settings-update-links');
		const downloadUrl = isSafeReleaseUrl(status.downloadUrl) ? status.downloadUrl : status.releaseUrl;
		if (isSafeReleaseUrl(downloadUrl)) {
			links.appendChild(this.createLink(localize('settings.update_download', { version: status.latestVersion }), downloadUrl, 'ut-settings-btn ut-settings-btn-primary'));
		}
		if (isSafeReleaseUrl(status.releaseUrl) && status.releaseUrl !== downloadUrl) {
			links.appendChild(this.createLink(localize('settings.update_release_notes'), status.releaseUrl, 'ut-settings-link'));
		}
		callout.appendChild(links);
		updateCallout.appendChild(callout);
		updateCallout.style.display = '';
	}

	createLink(text, href, className) {
		const link = this.el('a', 'ut-button ' + className + ' text-xs', text);
		link.href = href;
		link.target = '_blank';
		link.rel = 'noopener noreferrer';
		return link;
	}

	// Same disable / status / cooldown pattern as refreshUsage(). Deliberately works with the
	// automatic check turned off: the background's checkForUpdatesNow handler ignores the toggle.
	async checkForUpdatesNow() {
		const btn = this.elements?.updateCheckBtn;
		const status = this.elements?.updateCheckStatus;
		if (!btn || btn.disabled) return;

		btn.disabled = true;
		status.style.display = 'block';
		status.style.color = BLUE_HIGHLIGHT;
		status.textContent = localize('settings.update_checking');

		try {
			const result = await sendBackgroundMessage({ type: 'checkForUpdatesNow' });
			if (result && !result.error) {
				// The result itself (up to date / update available) is rendered in the info block.
				status.style.display = 'none';
				status.textContent = '';
			} else {
				status.style.color = RED_WARNING;
				status.textContent = localize('settings.update_error') + (result?.error ? ` (${result.error})` : '');
			}
			if (result) this.renderUpdateStatus(result.currentVersion, result);
		} catch (err) {
			status.style.color = RED_WARNING;
			status.textContent = localize('settings.update_error');
			await Log('warn', 'Settings: Manual update check failed:', err);
		} finally {
			// Cooldown to prevent spam-clicking (GitHub rate-limits unauthenticated requests)
			setTimeout(() => {
				if (btn) btn.disabled = false;
			}, 2000);
		}
	}

	// ── 4. More ──────────────────────────────────────────────────────────────

	createMoreSection() {
		const { container, group } = this.createSection('settings.section_more');

		const row = this.createRow('ut-settings-row-split');
		row.appendChild(this.el('span', 'ut-settings-row-label text-text-100', localize('settings.language_label')));
		const languageSelect = document.createElement('select');
		languageSelect.className = 'ut-settings-input ut-settings-select bg-bg-100 text-text-100 text-xs';
		const auto = this.el('option', '', localize('settings.language_auto'));
		auto.value = '';
		languageSelect.appendChild(auto);
		for (const [code, name] of Object.entries(LANGUAGE_NAMES)) {
			const option = this.el('option', '', name);
			option.value = code;
			languageSelect.appendChild(option);
		}
		languageSelect.addEventListener('change', () => this.saveLanguage());
		row.appendChild(languageSelect);
		group.appendChild(row);

		// Shown after a change: the card re-renders immediately, the rest of the UI on reload.
		const languageReloadRow = this.createRow('ut-settings-row-split');
		languageReloadRow.style.display = 'none';
		languageReloadRow.appendChild(this.el('span', 'ut-settings-hint text-text-400', localize('settings.language_reload_hint')));
		languageReloadRow.appendChild(this.createButton(localize('settings.language_reload'), 'secondary', () => window.location.reload()));
		group.appendChild(languageReloadRow);

		const debug = this.createDebugRows();
		group.appendChild(debug.row);

		return { container, languageSelect, languageReloadRow, ...debug.elements };
	}

	async saveLanguage() {
		const value = this.elements.languageSelect.value || null;
		try {
			await sendBackgroundMessage({ type: 'setLanguageOverride', value });
			await applyLocale();
			this.pendingLanguageReload = true;
			await this.rebuild();
		} catch (e) {
			await Log('warn', 'Settings: Failed to save language override:', e);
		}
	}

	createDebugRows() {
		const row = this.createRow('ut-settings-row-stack');
		const head = this.el('div', 'ut-settings-action-row');
		const label = this.el('span', 'ut-settings-row-label text-text-100', localize('common.debug_logs'));
		label.title = localize('settings.debug_hint');
		const debugStatus = this.el('span', 'ut-settings-status text-xs');
		const debugToggleBtn = this.createButton(localize('settings.debug_show'), 'secondary', () => this.toggleDebugLogs());
		const debugCopyBtn = this.createButton(localize('settings.debug_copy'), 'secondary', () => this.copyDebugLogs());
		debugCopyBtn.title = localize('settings.debug_hint');
		head.appendChild(label);
		head.appendChild(debugStatus);
		head.appendChild(debugToggleBtn);
		head.appendChild(debugCopyBtn);
		row.appendChild(head);

		const debugLogView = this.el('pre', 'ut-settings-log-view bg-bg-100 text-text-300');
		debugLogView.style.display = 'none';
		row.appendChild(debugLogView);

		const debugClearRow = this.el('div', 'ut-settings-action-row ut-settings-log-actions');
		debugClearRow.style.display = 'none';
		debugClearRow.appendChild(this.createButton(localize('settings.clear'), 'secondary', () => this.clearDebugLogs()));
		row.appendChild(debugClearRow);

		return { row, elements: { debugStatus, debugToggleBtn, debugLogView, debugClearRow } };
	}

	async readDebugLogText(limit) {
		const result = await browser.storage.local.get('debug_logs');
		const logs = Array.isArray(result.debug_logs) ? result.debug_logs : [];
		return logs.slice(limit ? -limit : 0)
			.map(entry => `${entry.timestamp} [${entry.level || 'debug'}] ${entry.sender}: ${entry.message}`)
			.join('\n');
	}

	async toggleDebugLogs() {
		const { debugLogView, debugToggleBtn, debugClearRow } = this.elements;
		const show = debugLogView.style.display === 'none';
		debugLogView.style.display = show ? 'block' : 'none';
		debugClearRow.style.display = show ? '' : 'none';
		debugToggleBtn.textContent = localize(show ? 'settings.debug_hide' : 'settings.debug_show');
		if (show) await this.renderDebugLogs();
	}

	async renderDebugLogs() {
		const view = this.elements.debugLogView;
		try {
			// The newest 200 lines keep the view responsive; Copy takes everything.
			view.textContent = (await this.readDebugLogText(200)) || localize('settings.debug_empty');
			view.scrollTop = view.scrollHeight;
		} catch (e) {
			view.textContent = String(e);
		}
	}

	async copyDebugLogs() {
		const status = this.elements.debugStatus;
		try {
			const text = await this.readDebugLogText();
			await navigator.clipboard.writeText(text || localize('settings.debug_empty'));
			status.style.color = SUCCESS_GREEN;
			status.textContent = localize('settings.debug_copied');
		} catch (e) {
			status.style.color = RED_WARNING;
			status.textContent = '✗';
			await Log('warn', 'Settings: Copying debug logs failed:', e);
		}
		setTimeout(() => { status.textContent = ''; }, 2000);
	}

	async clearDebugLogs() {
		try {
			await browser.storage.local.set({ debug_logs: [] });
			if (this.elements.debugLogView.style.display !== 'none') await this.renderDebugLogs();
		} catch (e) {
			await Log('warn', 'Settings: Clearing debug logs failed:', e);
		}
	}

	// ── State ────────────────────────────────────────────────────────────────

	async loadCurrentState() {
		try {
			const [enabled, threshold] = await Promise.all([
				sendBackgroundMessage({ type: 'getResetNotifEnabled' }),
				sendBackgroundMessage({ type: 'getResetNotifThreshold' })
			]);
			this.elements.notifToggle.checked = !!enabled;
			this.elements.notifThreshold.value = String(threshold ?? 100);
			this.elements.notifThreshold.disabled = !enabled;
			this.elements.notifThresholdRow.style.display = enabled ? '' : 'none';
		} catch (e) {
			await Log('warn', 'Settings: Failed to load notification settings:', e);
		}

		try {
			const override = await sendBackgroundMessage({ type: 'getLanguageOverride' });
			this.elements.languageSelect.value = override && LANGUAGE_NAMES[override] ? override : '';
			this.elements.languageReloadRow.style.display = this.pendingLanguageReload ? '' : 'none';
		} catch (e) {
			await Log('warn', 'Settings: Failed to load language override:', e);
		}

		try {
			const info = await sendBackgroundMessage({ type: 'getUpdateStatus' });
			this.elements.updateAutoToggle.checked = info?.autoCheck !== false;
			this.renderUpdateStatus(info?.currentVersion, info?.status);
		} catch (e) {
			await Log('warn', 'Settings: Failed to load update status:', e);
		}

		// Build display toggle checkboxes
		await this.rebuildDisplayToggles();
	}
}

// Self-initialize
const settingsCard = new SettingsCard();
