// debug.js
let autoRefreshInterval;
const PERMANENT_DEBUG = 8640000000000000; // Maximum safe timestamp in JavaScript

document.getElementById('refresh').addEventListener('click', showLogs);
document.getElementById('clear').addEventListener('click', clearLogs);
document.getElementById('enableDebug').addEventListener('click', toggleDebugMode);
document.getElementById('enablePermanentDebug').addEventListener('click', enablePermanentDebug);

function showLogs() {
	browser.storage.local.get('debug_logs')
		.then(result => {
			const logs = result.debug_logs || [];
			const preElement = document.getElementById('logs');

			preElement.innerHTML = '';

			logs.forEach(log => {
				const logLine = document.createElement('div');
				logLine.className = 'log-line';
				logLine.dataset.level = log.level || 'debug'; // Add level to the log line

				const timestamp = document.createElement('span');
				timestamp.className = 'log-timestamp';
				timestamp.textContent = log.timestamp;

				const sender = document.createElement('span');
				sender.className = 'log-sender';
				sender.dataset.sender = log.sender;
				sender.textContent = log.sender;

				const message = document.createElement('span');
				message.className = 'log-message';
				message.textContent = log.message;

				logLine.appendChild(timestamp);
				logLine.appendChild(sender);
				logLine.appendChild(message);
				preElement.appendChild(logLine);
			});

			scrollToBottom();
		});
}

function scrollToBottom() {
	const preElement = document.getElementById('logs');
	preElement.scrollTop = preElement.scrollHeight;
}

function clearLogs() {
	browser.storage.local.set({ debug_logs: [] })
		.then(showLogs);
}

function updateDebugStatus() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;
			const isPermanent = debugUntil === PERMANENT_DEBUG;
			const timeLeft = isEnabled && !isPermanent ? Math.ceil((debugUntil - now) / 60000) : 0;

			// Update status text
			const statusElement = document.getElementById('debugStatus');
			statusElement.textContent = isPermanent
				? 'Debug mode enabled (permanent)'
				: isEnabled
					? `Debug mode enabled (${timeLeft} minutes remaining)`
					: 'Debug mode disabled';

			// Update buttons visibility and text
			const debugButton = document.getElementById('enableDebug');
			const permanentDebugButton = document.getElementById('enablePermanentDebug');

			if (isEnabled) {
				debugButton.textContent = 'Disable Debug Mode';
				permanentDebugButton.style.display = 'none';
			} else {
				debugButton.textContent = 'Enable Debug Mode (1 hour)';
				permanentDebugButton.style.display = 'inline-block';
			}

			if (!isEnabled && autoRefreshInterval) {
				stopAutoRefresh();
			} else if (isEnabled && !autoRefreshInterval) {
				startAutoRefresh();
			}
		});
}

function toggleDebugMode() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;

			if (isEnabled) {
				// Disable debug mode by setting timestamp to now (expired)
				return browser.storage.local.set({ debug_mode_until: now });
			} else {
				// Enable debug mode for 1 hour
				const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000).getTime();
				return browser.storage.local.set({ debug_mode_until: oneHourFromNow });
			}
		})
		.then(() => {
			updateDebugStatus();
		});
}

function enablePermanentDebug() {
	browser.storage.local.set({ debug_mode_until: PERMANENT_DEBUG })
		.then(() => {
			updateDebugStatus();
		});
}

function startAutoRefresh() {
	if (!autoRefreshInterval) {
		autoRefreshInterval = setInterval(() => {
			if (document.getElementById('autoUpdate').checked) {
				showLogs();
			}
			updateDebugStatus();
		}, 5000);
	}
}

function stopAutoRefresh() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
	}
}

// Calibration data viewer
document.getElementById('showCalibration').addEventListener('click', toggleCalibration);

async function toggleCalibration() {
	const section = document.getElementById('calibration-section');
	if (section.style.display === 'none') {
		section.style.display = 'block';
		document.getElementById('showCalibration').textContent = 'Hide Calibration';
		await loadCalibrationData();
	} else {
		section.style.display = 'none';
		document.getElementById('showCalibration').textContent = 'Show Calibration';
	}
}

async function loadCalibrationData() {
	try {
		const entries = await chrome.runtime.sendMessage({ type: 'getCalibrationData' });
		const summaryEl = document.getElementById('calibration-summary');
		const dataEl = document.getElementById('calibration-data');

		if (!entries || entries.length === 0) {
			summaryEl.textContent = 'No calibration data yet. Add an API key in settings to start collecting.';
			dataEl.textContent = '';
			return;
		}

		// entries is [[key, value], ...] from StoredMap
		const values = entries.map(([, v]) => v).sort((a, b) => b.ts - a.ts);
		const ratios = values.filter(v => v.ratio && isFinite(v.ratio)).map(v => v.ratio);
		const avgRatio = ratios.length > 0 ? (ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3) : 'N/A';
		const minRatio = ratios.length > 0 ? Math.min(...ratios).toFixed(3) : 'N/A';
		const maxRatio = ratios.length > 0 ? Math.max(...ratios).toFixed(3) : 'N/A';

		summaryEl.innerHTML = `<b>${values.length}</b> entries | ` +
			`Avg ratio (real/o200k): <b>${avgRatio}</b> | ` +
			`Range: <b>${minRatio}</b> – <b>${maxRatio}</b> | ` +
			`Current multiplier: <b>${values[0]?.multiplier || '?'}</b>`;

		const lines = values.slice(0, 100).map(v => {
			const time = new Date(v.ts).toLocaleTimeString();
			const errPct = v.estimated > 0 ? (((v.real - v.estimated) / v.estimated) * 100).toFixed(1) : '?';
			return `${time}  real=${String(v.real).padStart(7)} est=${String(v.estimated).padStart(7)} o200k=${String(v.o200k).padStart(7)} ratio=${String(v.ratio).padStart(6)} err=${errPct}% len=${v.len}`;
		});
		dataEl.textContent = lines.join('\n');
	} catch (e) {
		document.getElementById('calibration-summary').textContent = 'Error loading: ' + e.message;
	}
}

// Initial setup
showLogs();
updateDebugStatus();
startAutoRefresh();

if (!chrome.tabs?.create) {
	const returnButton = document.getElementById('returnToClaude');
	returnButton.style.display = 'inline-block';
	returnButton.addEventListener('click', () => {
		// If in iframe overlay, close it; otherwise navigate back
		if (window.parent !== window) {
			window.parent.document.getElementById('ut-debug-overlay')?.remove();
		} else {
			window.location.href = 'https://claude.ai';
		}
	});
}

// Clean up when the page is closed
window.addEventListener('beforeunload', stopAutoRefresh);
