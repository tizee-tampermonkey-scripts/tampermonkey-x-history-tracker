// ==UserScript==
// @name         X History Tracker
// @namespace    https://github.com/tizee-tampermonkey-scripts/tampermonkey-x-history-tracker
// @version      1.1.0
// @description  Automatically tracks visited X/Twitter posts with frecency-based scoring for easy retrieval. Stores URL + title in localStorage with a configurable cap.
// @author       tizee
// @icon         https://www.google.com/s2/favicons?sz=64&domain=x.com
// @downloadURL  https://raw.githubusercontent.com/tizee-tampermonkey-scripts/tampermonkey-x-history-tracker/refs/heads/main/user.js
// @updateURL    https://raw.githubusercontent.com/tizee-tampermonkey-scripts/tampermonkey-x-history-tracker/refs/heads/main/user.js
// @match        https://x.com/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // --- Constants ---
    const STORAGE_KEY = 'x-history-tracker';
    const SETTINGS_KEY = 'x-history-tracker-settings';
    // Matches: https://x.com/{username}/status/{id}
    const STATUS_URL_REGEX = /^https:\/\/x\.com\/(\w+)\/status\/(\d+)/;

    // --- Settings ---
    const DEFAULT_SETTINGS = {
        maxEntries: 200,
        halfLifeDays: 7,
    };

    function loadSettings() {
        const saved = GM_getValue(SETTINGS_KEY);
        if (!saved) return { ...DEFAULT_SETTINGS };
        try {
            return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(settings) {
        GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    }

    let settings = loadSettings();

    function getHalfLifeMs() {
        return settings.halfLifeDays * 24 * 60 * 60 * 1000;
    }

    // --- Frecency Scoring ---
    // Inspired by z/autojump: score = frequency * recency_weight
    // recency_weight = 2^(-age / half_life), so recent visits contribute more

    /**
     * Calculate frecency score for an entry.
     * @param {object} entry - { url, title, visits, lastVisit }
     * @param {number} now - Current timestamp
     * @returns {number} Frecency score
     */
    function frecencyScore(entry, now) {
        const age = now - entry.lastVisit;
        const recency = Math.pow(2, -age / getHalfLifeMs());
        return entry.visits * recency;
    }

    // --- Storage ---

    /**
     * Load history from localStorage.
     * @returns {Map<string, object>} url -> { url, title, visits, lastVisit }
     */
    function loadHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return new Map();
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return new Map();
            const map = new Map();
            for (const entry of arr) {
                if (entry.url && typeof entry.visits === 'number') {
                    map.set(entry.url, entry);
                }
            }
            return map;
        } catch (e) {
            console.error('[X History Tracker] Failed to load history:', e);
            return new Map();
        }
    }

    /**
     * Save history to localStorage, evicting lowest-frecency entries if over cap.
     * @param {Map<string, object>} map
     */
    function saveHistory(map) {
        const now = Date.now();
        let entries = Array.from(map.values());

        // Evict by lowest frecency score when over cap
        if (entries.length > settings.maxEntries) {
            entries.sort((a, b) => frecencyScore(b, now) - frecencyScore(a, now));
            entries = entries.slice(0, settings.maxEntries);
            // Rebuild map
            map.clear();
            for (const entry of entries) {
                map.set(entry.url, entry);
            }
        }

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        } catch (e) {
            console.error('[X History Tracker] Failed to save history:', e);
        }
    }

    // --- Title Extraction ---

    /**
     * Extract title from og:title meta tag.
     * Format: "User on X: \"tweet content...\"" or "User on X" (no content yet)
     * @returns {string}
     */
    function extractTitle() {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle && ogTitle.content) {
            return ogTitle.content.trim().slice(0, 200);
        }
        return '';
    }

    // --- Core Tracking ---
    const visitHistory = loadHistory();
    let lastTrackedUrl = null;

    /**
     * Check if og:title has actual tweet content.
     * Rejects: empty, "X", or bare "Username on X" (no quoted content).
     * Accepts: "Username on X: \"tweet content...\"" (has colon + content).
     * @param {string} title
     * @returns {boolean}
     */
    function isMeaningfulTitle(title) {
        if (!title) return false;
        const stripped = title.trim();
        if (stripped === 'X' || stripped.length <= 1) return false;
        // og:title with content always has ": " after "on X"
        // e.g. "Mr Panda on X: \"...\""  vs  "Mr Panda on X" (no content yet)
        if (/on X$/.test(stripped)) return false;
        return true;
    }

    /**
     * Record a visit for the given URL with the given title.
     * @param {string} normalizedUrl
     * @param {string} title
     */
    function recordVisit(normalizedUrl, title) {
        const now = Date.now();
        const existing = visitHistory.get(normalizedUrl);

        if (existing) {
            existing.visits += 1;
            existing.lastVisit = now;
            if (isMeaningfulTitle(title)) {
                existing.title = title;
            }
        } else {
            visitHistory.set(normalizedUrl, {
                url: normalizedUrl,
                title: isMeaningfulTitle(title) ? title : normalizedUrl,
                visits: 1,
                lastVisit: now,
            });
        }

        saveHistory(visitHistory);
        console.debug(`[X History Tracker] Tracked: ${normalizedUrl} (${title})`);
    }

    /**
     * Try to extract a meaningful title with retries.
     * X's SPA updates document.title and meta tags asynchronously after navigation,
     * so we poll a few times before giving up.
     * @param {string} normalizedUrl
     * @param {number} attempt
     */
    function extractTitleWithRetry(normalizedUrl, attempt) {
        const MAX_ATTEMPTS = 6;
        const RETRY_INTERVAL_MS = 1000;

        const title = extractTitle();
        if (isMeaningfulTitle(title) || attempt >= MAX_ATTEMPTS) {
            recordVisit(normalizedUrl, title);
            return;
        }
        setTimeout(() => extractTitleWithRetry(normalizedUrl, attempt + 1), RETRY_INTERVAL_MS);
    }

    /**
     * Check if current URL is a status page and record it.
     */
    function trackCurrentPage() {
        const url = window.location.href;
        const match = STATUS_URL_REGEX.exec(url);
        if (!match) return;

        // Normalize: strip query params and hash
        const normalizedUrl = `https://x.com/${match[1]}/status/${match[2]}`;

        if (normalizedUrl === lastTrackedUrl) return;
        lastTrackedUrl = normalizedUrl;

        // Initial delay to let SPA settle, then retry if title is still generic
        setTimeout(() => extractTitleWithRetry(normalizedUrl, 0), 500);
    }

    // --- URL Change Detection ---
    // X is an SPA: intercept pushState/replaceState + popstate

    const originalPushState = History.prototype.pushState;
    const originalReplaceState = History.prototype.replaceState;

    // Note: we patch the global History.prototype so it works with X's SPA navigation
    History.prototype.pushState = function (...args) {
        originalPushState.apply(this, args);
        trackCurrentPage();
    };

    History.prototype.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        trackCurrentPage();
    };

    window.addEventListener('popstate', () => trackCurrentPage());

    // Initial track on page load
    trackCurrentPage();

    // --- Panel UI ---

    GM_addStyle(`
        #xht-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.6);
            z-index: 99998;
            backdrop-filter: blur(4px);
        }

        #xht-panel {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 600px;
            max-width: 90vw;
            max-height: 80vh;
            background: #15202b;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            color: #f7f9f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            z-index: 99999;
            display: flex;
            flex-direction: column;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
            animation: xht-slide-in 0.2s ease-out;
        }

        @keyframes xht-slide-in {
            from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
            to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }

        #xht-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px 0;
            flex-shrink: 0;
        }

        #xht-header h3 {
            margin: 0;
            font-size: 18px;
            font-weight: 700;
        }

        #xht-close {
            background: transparent;
            border: none;
            color: #e7e9ea;
            font-size: 20px;
            cursor: pointer;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background 0.2s;
            flex-shrink: 0;
        }

        #xht-close:hover {
            background: rgba(255, 255, 255, 0.1);
        }

        /* --- Tabs --- */
        #xht-tabs {
            display: flex;
            padding: 12px 20px 0;
            gap: 0;
            flex-shrink: 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }

        .xht-tab {
            padding: 10px 20px;
            font-size: 14px;
            font-weight: 600;
            color: #71767b;
            cursor: pointer;
            border: none;
            background: transparent;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
            position: relative;
            bottom: -1px;
        }

        .xht-tab:hover {
            color: #e7e9ea;
            background: rgba(255, 255, 255, 0.03);
        }

        .xht-tab.active {
            color: #f7f9f9;
            border-bottom-color: #1d9bf0;
        }

        /* --- Tab content --- */
        .xht-tab-content {
            display: none;
            flex-direction: column;
            flex: 1;
            overflow: hidden;
        }

        .xht-tab-content.active {
            display: flex;
        }

        /* --- History tab --- */
        .xht-btn {
            background: transparent;
            border: 1px solid rgba(255, 255, 255, 0.15);
            color: #e7e9ea;
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .xht-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.3);
        }

        #xht-search-container {
            padding: 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            flex-shrink: 0;
            display: flex;
            gap: 8px;
            align-items: center;
        }

        #xht-search {
            flex: 1;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 24px;
            color: #f7f9f9;
            padding: 10px 16px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
            box-sizing: border-box;
        }

        #xht-search:focus {
            border-color: #1d9bf0;
        }

        #xht-search::placeholder {
            color: #71767b;
        }

        #xht-stats {
            padding: 8px 20px;
            font-size: 12px;
            color: #71767b;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            flex-shrink: 0;
        }

        #xht-list {
            overflow-y: auto;
            flex: 1;
            padding: 4px 0;
        }

        .xht-entry {
            display: flex;
            align-items: flex-start;
            padding: 12px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            cursor: pointer;
            transition: background 0.15s;
            gap: 12px;
        }

        .xht-entry:hover {
            background: rgba(255, 255, 255, 0.03);
        }

        .xht-entry-score {
            font-size: 11px;
            color: #71767b;
            font-family: "SF Mono", Monaco, Menlo, monospace;
            min-width: 40px;
            text-align: right;
            padding-top: 2px;
            flex-shrink: 0;
        }

        .xht-entry-content {
            flex: 1;
            min-width: 0;
        }

        .xht-entry-title {
            font-size: 14px;
            color: #e7e9ea;
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .xht-entry-meta {
            font-size: 12px;
            color: #71767b;
            display: flex;
            gap: 12px;
        }

        .xht-entry-url {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .xht-entry-delete {
            flex-shrink: 0;
            background: transparent;
            border: none;
            color: #71767b;
            cursor: pointer;
            padding: 4px;
            border-radius: 50%;
            font-size: 14px;
            opacity: 0;
            transition: all 0.15s;
            align-self: center;
        }

        .xht-entry:hover .xht-entry-delete {
            opacity: 1;
        }

        .xht-entry-delete:hover {
            color: #f4212e;
            background: rgba(244, 33, 46, 0.1);
        }

        #xht-empty {
            padding: 40px 20px;
            text-align: center;
            color: #71767b;
            font-size: 14px;
        }

        /* --- Settings tab --- */
        #xht-settings {
            padding: 20px;
            overflow-y: auto;
        }

        .xht-setting-group {
            margin-bottom: 24px;
        }

        .xht-setting-group:last-child {
            margin-bottom: 0;
        }

        .xht-setting-label {
            font-size: 14px;
            font-weight: 600;
            color: #e7e9ea;
            margin-bottom: 4px;
        }

        .xht-setting-desc {
            font-size: 12px;
            color: #71767b;
            margin-bottom: 10px;
        }

        .xht-setting-row {
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .xht-setting-input {
            width: 80px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.15);
            border-radius: 8px;
            color: #f7f9f9;
            padding: 8px 12px;
            font-size: 14px;
            outline: none;
            transition: border-color 0.2s;
            text-align: center;
        }

        .xht-setting-input:focus {
            border-color: #1d9bf0;
        }

        .xht-setting-range {
            flex: 1;
            accent-color: #1d9bf0;
            cursor: pointer;
        }

        .xht-setting-value {
            font-size: 13px;
            color: #71767b;
            font-family: "SF Mono", Monaco, Menlo, monospace;
            min-width: 50px;
            text-align: right;
        }

        .xht-setting-divider {
            border: none;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            margin: 24px 0;
        }

        /* Danger zone */
        .xht-danger-zone {
            border: 1px solid rgba(244, 33, 46, 0.2);
            border-radius: 12px;
            padding: 16px;
        }

        .xht-danger-zone .xht-setting-label {
            color: #f4212e;
        }

        .xht-btn-danger {
            color: #f4212e;
            border-color: rgba(244, 33, 46, 0.3);
        }

        .xht-btn-danger:hover {
            background: rgba(244, 33, 46, 0.1);
            border-color: rgba(244, 33, 46, 0.5);
        }

        .xht-btn-confirm-danger {
            background: #f4212e;
            border-color: #f4212e;
            color: #fff;
        }

        .xht-btn-confirm-danger:hover {
            background: #dc1d28;
            border-color: #dc1d28;
        }

        .xht-confirm-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 12px;
            padding: 10px 12px;
            background: rgba(244, 33, 46, 0.05);
            border-radius: 8px;
        }

        .xht-confirm-bar span {
            font-size: 13px;
            color: #f4212e;
            flex: 1;
        }

        .xht-btn-save {
            background: #1d9bf0;
            border-color: #1d9bf0;
            color: #fff;
        }

        .xht-btn-save:hover {
            background: #1a8cd8;
            border-color: #1a8cd8;
        }

        .xht-toast {
            position: absolute;
            bottom: 16px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(29, 155, 240, 0.9);
            color: #fff;
            padding: 8px 20px;
            border-radius: 20px;
            font-size: 13px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
        }

        .xht-toast.show {
            opacity: 1;
        }
    `);

    /**
     * Format a timestamp to a relative time string.
     * @param {number} ts - Timestamp in ms
     * @returns {string}
     */
    function timeAgo(ts) {
        const seconds = Math.floor((Date.now() - ts) / 1000);
        if (seconds < 60) return 'just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.floor(days / 30);
        return `${months}mo ago`;
    }

    /**
     * Show the history panel with tabs.
     */
    function showHistoryPanel() {
        // Remove existing panel if any
        const existing = document.getElementById('xht-overlay');
        if (existing) existing.remove();

        // Overlay
        const overlay = document.createElement('div');
        overlay.id = 'xht-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Panel
        const panel = document.createElement('div');
        panel.id = 'xht-panel';

        // --- Header ---
        const header = document.createElement('div');
        header.id = 'xht-header';

        const title = document.createElement('h3');
        title.textContent = 'X History';

        const closeBtn = document.createElement('button');
        closeBtn.id = 'xht-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', () => overlay.remove());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // --- Tabs ---
        const tabsBar = document.createElement('div');
        tabsBar.id = 'xht-tabs';

        const historyTab = document.createElement('button');
        historyTab.className = 'xht-tab active';
        historyTab.textContent = 'History';

        const settingsTab = document.createElement('button');
        settingsTab.className = 'xht-tab';
        settingsTab.textContent = 'Settings';

        tabsBar.appendChild(historyTab);
        tabsBar.appendChild(settingsTab);

        // --- Toast ---
        const toast = document.createElement('div');
        toast.className = 'xht-toast';

        function showToast(msg) {
            toast.textContent = msg;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 1500);
        }

        // --- History tab content ---
        const historyContent = document.createElement('div');
        historyContent.className = 'xht-tab-content active';

        const now = Date.now();
        let entries = Array.from(visitHistory.values())
            .map(e => ({ ...e, score: frecencyScore(e, now) }))
            .sort((a, b) => b.score - a.score);

        // Search bar + export button
        const searchContainer = document.createElement('div');
        searchContainer.id = 'xht-search-container';

        const searchInput = document.createElement('input');
        searchInput.id = 'xht-search';
        searchInput.type = 'text';
        searchInput.placeholder = 'Search by title or URL...';

        const exportBtn = document.createElement('button');
        exportBtn.className = 'xht-btn';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', () => {
            const data = JSON.stringify(entries, null, 2);
            const blob = new Blob([data], { type: 'application/json' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = `x-history-${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(blobUrl);
            showToast('Exported');
        });

        searchContainer.appendChild(searchInput);
        searchContainer.appendChild(exportBtn);

        // Stats
        const stats = document.createElement('div');
        stats.id = 'xht-stats';
        stats.textContent = `${entries.length} / ${settings.maxEntries} posts | sorted by frecency`;

        // List
        const list = document.createElement('div');
        list.id = 'xht-list';

        function renderEntries(filtered) {
            list.innerHTML = '';
            if (filtered.length === 0) {
                const empty = document.createElement('div');
                empty.id = 'xht-empty';
                empty.textContent = 'No matching entries';
                list.appendChild(empty);
                return;
            }

            for (const entry of filtered) {
                const row = document.createElement('div');
                row.className = 'xht-entry';

                const scoreEl = document.createElement('div');
                scoreEl.className = 'xht-entry-score';
                scoreEl.textContent = entry.score.toFixed(1);

                const content = document.createElement('div');
                content.className = 'xht-entry-content';

                const titleEl = document.createElement('div');
                titleEl.className = 'xht-entry-title';
                titleEl.textContent = entry.title;

                const meta = document.createElement('div');
                meta.className = 'xht-entry-meta';

                const urlEl = document.createElement('span');
                urlEl.className = 'xht-entry-url';
                const urlMatch = STATUS_URL_REGEX.exec(entry.url);
                urlEl.textContent = urlMatch ? `@${urlMatch[1]}/status/${urlMatch[2]}` : entry.url;

                const visitsEl = document.createElement('span');
                visitsEl.textContent = `${entry.visits} visit${entry.visits > 1 ? 's' : ''}`;

                const timeEl = document.createElement('span');
                timeEl.textContent = timeAgo(entry.lastVisit);

                meta.appendChild(urlEl);
                meta.appendChild(visitsEl);
                meta.appendChild(timeEl);
                content.appendChild(titleEl);
                content.appendChild(meta);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'xht-entry-delete';
                deleteBtn.innerHTML = '&times;';
                deleteBtn.title = 'Remove from history';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    visitHistory.delete(entry.url);
                    saveHistory(visitHistory);
                    entries = entries.filter(x => x.url !== entry.url);
                    row.remove();
                    const remaining = list.querySelectorAll('.xht-entry').length;
                    stats.textContent = `${remaining} / ${settings.maxEntries} posts | sorted by frecency`;
                });

                row.addEventListener('click', () => {
                    window.open(entry.url, '_blank');
                });

                row.appendChild(scoreEl);
                row.appendChild(content);
                row.appendChild(deleteBtn);
                list.appendChild(row);
            }
        }

        renderEntries(entries);

        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            if (!query) {
                renderEntries(entries);
                stats.textContent = `${entries.length} / ${settings.maxEntries} posts | sorted by frecency`;
                return;
            }
            const filtered = entries.filter(e =>
                e.title.toLowerCase().includes(query) ||
                e.url.toLowerCase().includes(query)
            );
            renderEntries(filtered);
            stats.textContent = `${filtered.length} of ${entries.length} posts | sorted by frecency`;
        });

        historyContent.appendChild(searchContainer);
        historyContent.appendChild(stats);
        historyContent.appendChild(list);

        // --- Settings tab content ---
        const settingsContent = document.createElement('div');
        settingsContent.className = 'xht-tab-content';

        const settingsInner = document.createElement('div');
        settingsInner.id = 'xht-settings';

        // Working copy of settings for editing
        const draft = { ...settings };

        // -- Max entries --
        const maxGroup = document.createElement('div');
        maxGroup.className = 'xht-setting-group';

        const maxLabel = document.createElement('div');
        maxLabel.className = 'xht-setting-label';
        maxLabel.textContent = 'Max entries';

        const maxDesc = document.createElement('div');
        maxDesc.className = 'xht-setting-desc';
        maxDesc.textContent = 'Maximum number of posts to keep. Lowest frecency entries are evicted when exceeded.';

        const maxRow = document.createElement('div');
        maxRow.className = 'xht-setting-row';

        const maxRange = document.createElement('input');
        maxRange.type = 'range';
        maxRange.className = 'xht-setting-range';
        maxRange.min = '50';
        maxRange.max = '1000';
        maxRange.step = '50';
        maxRange.value = draft.maxEntries;

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.className = 'xht-setting-input';
        maxInput.min = '10';
        maxInput.max = '5000';
        maxInput.value = draft.maxEntries;

        maxRange.addEventListener('input', () => {
            draft.maxEntries = parseInt(maxRange.value, 10);
            maxInput.value = draft.maxEntries;
        });

        maxInput.addEventListener('change', () => {
            let val = parseInt(maxInput.value, 10);
            if (isNaN(val) || val < 10) val = 10;
            if (val > 5000) val = 5000;
            draft.maxEntries = val;
            maxInput.value = val;
            // Clamp range slider to its own max
            maxRange.value = Math.min(val, parseInt(maxRange.max, 10));
        });

        maxRow.appendChild(maxRange);
        maxRow.appendChild(maxInput);
        maxGroup.appendChild(maxLabel);
        maxGroup.appendChild(maxDesc);
        maxGroup.appendChild(maxRow);

        // -- Half-life --
        const hlGroup = document.createElement('div');
        hlGroup.className = 'xht-setting-group';

        const hlLabel = document.createElement('div');
        hlLabel.className = 'xht-setting-label';
        hlLabel.textContent = 'Frecency half-life (days)';

        const hlDesc = document.createElement('div');
        hlDesc.className = 'xht-setting-desc';
        hlDesc.textContent = 'Controls how fast recency decays. Lower = recent visits matter more. Higher = older visits persist longer.';

        const hlRow = document.createElement('div');
        hlRow.className = 'xht-setting-row';

        const hlRange = document.createElement('input');
        hlRange.type = 'range';
        hlRange.className = 'xht-setting-range';
        hlRange.min = '1';
        hlRange.max = '30';
        hlRange.step = '1';
        hlRange.value = draft.halfLifeDays;

        const hlValue = document.createElement('div');
        hlValue.className = 'xht-setting-value';
        hlValue.textContent = `${draft.halfLifeDays}d`;

        hlRange.addEventListener('input', () => {
            draft.halfLifeDays = parseInt(hlRange.value, 10);
            hlValue.textContent = `${draft.halfLifeDays}d`;
        });

        hlRow.appendChild(hlRange);
        hlRow.appendChild(hlValue);
        hlGroup.appendChild(hlLabel);
        hlGroup.appendChild(hlDesc);
        hlGroup.appendChild(hlRow);

        // -- Save button --
        const saveGroup = document.createElement('div');
        saveGroup.className = 'xht-setting-group';
        saveGroup.style.display = 'flex';
        saveGroup.style.justifyContent = 'flex-end';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'xht-btn xht-btn-save';
        saveBtn.textContent = 'Save Settings';
        saveBtn.addEventListener('click', () => {
            settings = { ...draft };
            saveSettings(settings);
            // Re-apply cap immediately
            saveHistory(visitHistory);
            showToast('Settings saved');
            // Update stats on history tab
            stats.textContent = `${visitHistory.size} / ${settings.maxEntries} posts | sorted by frecency`;
        });

        saveGroup.appendChild(saveBtn);

        // -- Divider --
        const divider = document.createElement('hr');
        divider.className = 'xht-setting-divider';

        // -- Danger zone --
        const dangerZone = document.createElement('div');
        dangerZone.className = 'xht-setting-group xht-danger-zone';

        const dangerLabel = document.createElement('div');
        dangerLabel.className = 'xht-setting-label';
        dangerLabel.textContent = 'Danger Zone';

        const dangerDesc = document.createElement('div');
        dangerDesc.className = 'xht-setting-desc';
        dangerDesc.textContent = 'Permanently delete all tracked history. This cannot be undone.';

        const clearBtn = document.createElement('button');
        clearBtn.className = 'xht-btn xht-btn-danger';
        clearBtn.textContent = 'Clear All History';

        // Two-step confirmation
        let confirmBar = null;
        clearBtn.addEventListener('click', () => {
            if (confirmBar) return;
            confirmBar = document.createElement('div');
            confirmBar.className = 'xht-confirm-bar';

            const confirmMsg = document.createElement('span');
            confirmMsg.textContent = 'Are you sure? This is irreversible.';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'xht-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => {
                confirmBar.remove();
                confirmBar = null;
            });

            const confirmDeleteBtn = document.createElement('button');
            confirmDeleteBtn.className = 'xht-btn xht-btn-confirm-danger';
            confirmDeleteBtn.textContent = 'Yes, delete all';
            confirmDeleteBtn.addEventListener('click', () => {
                visitHistory.clear();
                saveHistory(visitHistory);
                lastTrackedUrl = null;
                showToast('All history cleared');
                confirmBar.remove();
                confirmBar = null;
                // Refresh entries for history tab
                entries = [];
                renderEntries(entries);
                stats.textContent = `0 / ${settings.maxEntries} posts | sorted by frecency`;
            });

            confirmBar.appendChild(confirmMsg);
            confirmBar.appendChild(cancelBtn);
            confirmBar.appendChild(confirmDeleteBtn);
            dangerZone.appendChild(confirmBar);
        });

        dangerZone.appendChild(dangerLabel);
        dangerZone.appendChild(dangerDesc);
        dangerZone.appendChild(clearBtn);

        settingsInner.appendChild(maxGroup);
        settingsInner.appendChild(hlGroup);
        settingsInner.appendChild(saveGroup);
        settingsInner.appendChild(divider);
        settingsInner.appendChild(dangerZone);
        settingsContent.appendChild(settingsInner);

        // --- Tab switching ---
        historyTab.addEventListener('click', () => {
            historyTab.classList.add('active');
            settingsTab.classList.remove('active');
            historyContent.classList.add('active');
            settingsContent.classList.remove('active');
            searchInput.focus();
        });

        settingsTab.addEventListener('click', () => {
            settingsTab.classList.add('active');
            historyTab.classList.remove('active');
            settingsContent.classList.add('active');
            historyContent.classList.remove('active');
        });

        // --- Keyboard: Escape to close ---
        const onKeyDown = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                document.removeEventListener('keydown', onKeyDown);
            }
        };
        document.addEventListener('keydown', onKeyDown);

        // --- Assemble ---
        panel.appendChild(header);
        panel.appendChild(tabsBar);
        panel.appendChild(historyContent);
        panel.appendChild(settingsContent);
        panel.appendChild(toast);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        searchInput.focus();
    }

    // --- Menu Commands ---
    GM_registerMenuCommand('View History', showHistoryPanel);

    GM_registerMenuCommand('Export History (JSON)', () => {
        const now = Date.now();
        const entries = Array.from(visitHistory.values())
            .map(e => ({ ...e, score: frecencyScore(e, now) }))
            .sort((a, b) => b.score - a.score);
        const data = JSON.stringify(entries, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `x-history-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    console.debug('[X History Tracker] Initialized. Tracking status pages.');
})();
