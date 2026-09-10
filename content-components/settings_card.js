/* global sendBackgroundMessage, Log, BLUE_HIGHLIGHT, SUCCESS_GREEN, RED_WARNING,
   SIDEBAR_DISPLAY_KEY, getSidebarDisplayPrefs, isSidebarItemVisible, setSidebarDisplayPref,
   localize */
'use strict';

// Settings floating card — opened by the ⚙️ gear button in the sidebar header.
// Provides:
//   1. API key entry → enables the exact count_tokens path in tokenManagement.js
//   2. Bar visibility toggles → which sidebar rows to show/hide
//
// Wired to the existing setAPIKey/getAPIKey message handlers in background.js.

class SettingsCard {
	constructor() {
		this.isOpen = false;
		this.elements = null;
		this.backdrop = null;
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
		card.style.display = 'block';

		if (position) {
			card.style.top = `${position.top}px`;
			card.style.left = `${position.left}px`;
		}

		// Ensure card stays within viewport
		requestAnimationFrame(() => {
			const rect = card.getBoundingClientRect();
			if (rect.right > window.innerWidth - 8) {
				card.style.left = `${window.innerWidth - rect.width - 8}px`;
			}
			if (rect.bottom > window.innerHeight - 8) {
				card.style.top = `${window.innerHeight - rect.height - 8}px`;
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

	createElement() {
		const card = document.createElement('div');
		card.className = 'ut-settings-card ut-card bg-bg-100';
		card.style.display = 'none';

		// Header
		const header = document.createElement('div');
		header.className = 'ut-settings-header';

		const title = document.createElement('h3');
		title.className = 'text-text-100 text-sm';
		title.style.fontWeight = '600';
		title.textContent = localize('settings.title') || 'Settings';

		const closeBtn = document.createElement('button');
		closeBtn.className = 'ut-button ut-settings-close';
		closeBtn.innerHTML = '&times;';
		closeBtn.addEventListener('click', () => this.close());

		header.appendChild(title);
		header.appendChild(closeBtn);
		card.appendChild(header);

		// Separator
		card.appendChild(this.createSeparator());

		// API Key section
		const apiSection = this.createApiKeySection();
		card.appendChild(apiSection.container);

		// Separator
		card.appendChild(this.createSeparator());

		// Display toggles section
		const displaySection = this.createDisplaySection();
		card.appendChild(displaySection.container);

		return { card, ...apiSection, ...displaySection };
	}

	createSeparator() {
		const sep = document.createElement('div');
		sep.className = 'ut-settings-separator';
		return sep;
	}

	createApiKeySection() {
		const container = document.createElement('div');
		container.className = 'ut-settings-section';

		const label = document.createElement('label');
		label.className = 'ut-settings-label text-text-300 text-xs';
		label.textContent = localize('settings.api_key_label') || 'Anthropic API Key';

		const sublabel = document.createElement('div');
		sublabel.className = 'text-text-400 text-xs ut-mb-1';
		sublabel.style.lineHeight = '1.3';
		sublabel.textContent = localize('settings.api_key_hint') || 'Enables exact token counting via count_tokens API';

		const inputRow = document.createElement('div');
		inputRow.className = 'ut-settings-input-row';

		const input = document.createElement('input');
		input.type = 'password';
		input.className = 'ut-settings-api-input bg-bg-200 text-text-100 text-xs';
		input.placeholder = 'sk-ant-...';
		input.autocomplete = 'off';
		input.spellcheck = false;

		const toggleVis = document.createElement('button');
		toggleVis.className = 'ut-button ut-settings-vis-toggle text-text-400';
		toggleVis.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
		toggleVis.addEventListener('click', () => {
			input.type = input.type === 'password' ? 'text' : 'password';
		});

		inputRow.appendChild(input);
		inputRow.appendChild(toggleVis);

		// Status + save row
		const actionRow = document.createElement('div');
		actionRow.className = 'ut-settings-action-row';

		const status = document.createElement('span');
		status.className = 'ut-settings-status text-xs';

		const saveBtn = document.createElement('button');
		saveBtn.className = 'ut-button ut-settings-save-btn text-xs';
		saveBtn.textContent = localize('settings.save') || 'Save';
		saveBtn.addEventListener('click', () => this.saveApiKey());

		const clearBtn = document.createElement('button');
		clearBtn.className = 'ut-button ut-settings-clear-btn text-text-400 text-xs';
		clearBtn.textContent = localize('settings.clear') || 'Clear';
		clearBtn.addEventListener('click', () => this.clearApiKey());

		actionRow.appendChild(status);
		actionRow.appendChild(clearBtn);
		actionRow.appendChild(saveBtn);

		container.appendChild(label);
		container.appendChild(sublabel);
		container.appendChild(inputRow);
		container.appendChild(actionRow);

		return { container, apiInput: input, apiStatus: status, apiSaveBtn: saveBtn };
	}

	createDisplaySection() {
		const container = document.createElement('div');
		container.className = 'ut-settings-section';

		const headerRow = document.createElement('div');
		headerRow.className = 'ut-row ut-justify-between ut-mb-1';

		const label = document.createElement('label');
		label.className = 'ut-settings-label text-text-300 text-xs';
		label.style.marginBottom = '0';
		label.textContent = localize('settings.display_label') || 'Visible Bars';

		const refreshBtn = document.createElement('button');
		refreshBtn.className = 'ut-button ut-settings-refresh-btn text-xs text-text-300';
		refreshBtn.textContent = localize('settings.refresh') || 'Refresh';
		refreshBtn.addEventListener('click', () => this.refreshUsage());

		headerRow.appendChild(label);
		headerRow.appendChild(refreshBtn);
		container.appendChild(headerRow);

		const refreshStatus = document.createElement('div');
		refreshStatus.className = 'ut-settings-refresh-status text-xs ut-mb-1';
		refreshStatus.style.display = 'none';
		container.appendChild(refreshStatus);

		const checkboxList = document.createElement('div');
		checkboxList.className = 'ut-settings-checkbox-list';
		container.appendChild(checkboxList);

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

	async loadCurrentState() {
		// Load API key status
		try {
			const key = await sendBackgroundMessage({ type: 'getAPIKey' });
			if (key) {
				this.elements.apiInput.value = '';
				this.elements.apiInput.placeholder = '••••••••' + key.slice(-4);
				this.setStatus('active', localize('settings.key_active') || '✓ Active');
			} else {
				this.elements.apiInput.value = '';
				this.elements.apiInput.placeholder = 'sk-ant-...';
				this.setStatus('', '');
			}
		} catch (e) {
			await Log('warn', 'Settings: Failed to load API key status:', e);
		}

		// Build display toggle checkboxes
		await this.rebuildDisplayToggles();
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
			const row = document.createElement('label');
			row.className = 'ut-settings-checkbox-row text-text-200 text-xs';

			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'ut-settings-checkbox';
			checkbox.checked = isSidebarItemVisible(prefs, key);
			checkbox.addEventListener('change', () => {
				setSidebarDisplayPref(key, checkbox.checked);
			});

			const text = document.createElement('span');
			text.textContent = labelKeys[key] ? localize(labelKeys[key]) : key;

			row.appendChild(checkbox);
			row.appendChild(text);
			checkboxList.appendChild(row);
		}
	}

	setStatus(type, message) {
		const status = this.elements.apiStatus;
		status.textContent = message;
		status.className = 'ut-settings-status text-xs';

		if (type === 'active') {
			status.style.color = SUCCESS_GREEN;
		} else if (type === 'error') {
			status.style.color = RED_WARNING;
		} else if (type === 'loading') {
			status.style.color = BLUE_HIGHLIGHT;
		} else {
			status.style.color = '';
		}
	}

	async saveApiKey() {
		const input = this.elements.apiInput;
		const key = input.value.trim();

		if (!key) {
			this.setStatus('error', localize('settings.key_empty') || 'Enter a key first');
			return;
		}

		this.setStatus('loading', localize('settings.key_validating') || 'Validating…');
		this.elements.apiSaveBtn.disabled = true;

		try {
			const result = await sendBackgroundMessage({ type: 'setAPIKey', newKey: key });

			if (result === true) {
				this.setStatus('active', localize('settings.key_saved') || '✓ Key saved & validated');
				input.value = '';
				input.placeholder = '••••••••' + key.slice(-4);
			} else {
				this.setStatus('error', localize('settings.key_invalid') || '✗ Invalid key');
			}
		} catch (e) {
			this.setStatus('error', localize('settings.key_error') || '✗ Error validating key');
			await Log('warn', 'Settings: API key save failed:', e);
		} finally {
			this.elements.apiSaveBtn.disabled = false;
		}
	}

	async clearApiKey() {
		try {
			await sendBackgroundMessage({ type: 'setAPIKey', newKey: '' });
			this.elements.apiInput.value = '';
			this.elements.apiInput.placeholder = 'sk-ant-...';
			this.setStatus('', '');
		} catch (e) {
			await Log('warn', 'Settings: API key clear failed:', e);
		}
	}
}

// Self-initialize
const settingsCard = new SettingsCard();
