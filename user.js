// ==UserScript==
// @name         X History Tracker
// @namespace    https://github.com/tizee-tampermonkey-scripts/tampermonkey-x-history-tracker
// @version      1.4.0
// @description  Automatically tracks visited X/Twitter posts with tweet text and newest-first ordering. Stores URL + text in localStorage with a configurable cap.
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
        maxEntries: 2000,
    };
    // Previous default, used to migrate saved settings that were never customized
    const LEGACY_DEFAULT_MAX_ENTRIES = 200;
    // Hard limit for maxEntries, shared by the settings slider/input
    const MAX_ENTRIES_LIMIT = 5000;

    function loadSettings() {
        const saved = GM_getValue(SETTINGS_KEY);
        if (!saved) return { ...DEFAULT_SETTINGS };
        try {
            const parsed = JSON.parse(saved);
            // Migrate: user never changed the old default, so follow the new one
            const maxEntries = parsed.maxEntries === LEGACY_DEFAULT_MAX_ENTRIES
                ? DEFAULT_SETTINGS.maxEntries
                : parsed.maxEntries;
            return { maxEntries: maxEntries || DEFAULT_SETTINGS.maxEntries };
        } catch {
            return { ...DEFAULT_SETTINGS };
        }
    }

    function saveSettings(settings) {
        GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    }

    let settings = loadSettings();

    // --- Storage ---
    // v3 compact format: array of tuples [username, statusId, title, lastVisitSec]
    // - URL is reconstructed on load (saves the repeated "https://x.com/.../status/" prefix)
    // - title is stored as "" when it's just the URL fallback (restored on load)
    // v2 legacy tuples [username, statusId, title, score, lastVisitSec]
    // v1 legacy objects { url, title, visits, lastVisit } are still accepted on load.

    /**
     * Serialize an entry to its compact tuple form.
     * @param {object} entry - { url, title, lastVisit }
     * @returns {Array|object}
     */
    function serializeEntry(entry) {
        const match = STATUS_URL_REGEX.exec(entry.url);
        if (!match) return entry; // defensive: keep legacy form for non-status URLs
        const title = entry.title === entry.url ? '' : entry.title;
        return [match[1], match[2], title, Math.floor(entry.lastVisit / 1000)];
    }

    /**
     * Deserialize a stored entry (v3 tuple, v2 tuple, or v1 object) to the
     * in-memory form. Returns null for malformed data.
     * @param {Array|object} raw
     * @returns {object|null} { url, title, lastVisit }
     */
    function deserializeEntry(raw) {
        if (Array.isArray(raw)) {
            // v2 tuples have 5 fields; v3 tuples have 4.
            const lastVisitSec = raw[raw.length >= 5 ? 4 : 3];
            const [username, statusId, title] = raw;
            if (typeof username !== 'string' || typeof statusId !== 'string' ||
                typeof lastVisitSec !== 'number') {
                return null;
            }
            const url = `https://x.com/${username}/status/${statusId}`;
            return { url, title: title || url, lastVisit: lastVisitSec * 1000 };
        }
        // v1 legacy object
        if (raw && typeof raw.url === 'string' && typeof raw.lastVisit === 'number') {
            return { url: raw.url, title: raw.title || raw.url, lastVisit: raw.lastVisit };
        }
        return null;
    }

    /**
     * Load history from localStorage.
     * @returns {Map<string, object>} url -> { url, title, lastVisit }
     */
    function loadHistory() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return new Map();
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return new Map();
            const map = new Map();
            for (const rawEntry of arr) {
                const entry = deserializeEntry(rawEntry);
                if (entry) map.set(entry.url, entry);
            }
            return map;
        } catch (e) {
            console.error('[X History Tracker] Failed to load history:', e);
            return new Map();
        }
    }

    /**
     * Save history to localStorage, evicting oldest entries if over cap.
     * @param {Map<string, object>} map
     * @param {string|null} [pinnedUrl] - URL that must survive eviction.
     *   The visit that just triggered the save may be older than entries in
     *   another tab, so pin it explicitly.
     */
    function saveHistory(map, pinnedUrl = null) {
        let entries = Array.from(map.values());

        // Evict by oldest visit when over cap
        if (entries.length > settings.maxEntries) {
            entries.sort((a, b) => b.lastVisit - a.lastVisit);
            entries = entries.slice(0, settings.maxEntries);
            if (pinnedUrl && !entries.some(e => e.url === pinnedUrl)) {
                const pinned = map.get(pinnedUrl);
                if (pinned) {
                    entries.pop();
                    entries.push(pinned);
                }
            }
            // Rebuild map
            map.clear();
            for (const entry of entries) {
                map.set(entry.url, entry);
            }
        }

        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.map(serializeEntry)));
        } catch (e) {
            console.error('[X History Tracker] Failed to save history:', e);
        }
    }

    // --- Title Extraction ---
    // X's og:title meta tag is written on full page load and not reliably
    // updated during SPA navigation. Read the rendered tweet instead.

    const MAX_TITLE_LENGTH = 500;
    const TWEET_SELECTOR = 'article[data-testid="tweet"]';
    // Page-translation extensions inject translated copies of each text node.
    const TRANSLATION_SELECTOR = '[class*="immersive-translate-target"]';

    /**
     * Read visible text from an element, preserving emoji alt text and line breaks.
     * @param {Element} el
     * @returns {string}
     */
    function textOf(el) {
        let out = '';
        (function walk(node) {
            for (const child of node.childNodes) {
                if (child.nodeType === Node.TEXT_NODE) {
                    out += child.nodeValue;
                } else if (child.nodeType === Node.ELEMENT_NODE) {
                    if (child.matches(TRANSLATION_SELECTOR)) continue;
                    if (child.tagName === 'IMG') out += child.getAttribute('alt') || '';
                    else if (child.tagName === 'BR') out += '\n';
                    else walk(child);
                }
            }
        })(el);
        return out.trim();
    }

    /** A quoted post sits in a div[role=link] inside the article. */
    function inQuote(el, article) {
        const quote = el.closest('div[role="link"]');
        return !!quote && article.contains(quote);
    }

    /** Find the first matching element that belongs to the post itself. */
    function own(article, selector) {
        return [...article.querySelectorAll(selector)].find(el => !inQuote(el, article));
    }

    /**
     * Find the article for the status page being viewed.
     * @param {string} statusId
     * @returns {Element|null}
     */
    function findTweetArticle(statusId) {
        for (const article of document.querySelectorAll(TWEET_SELECTOR)) {
            const time = own(article, 'a[href*="/status/"] time');
            if (!time) continue; // ads have no timestamp link
            const href = time.closest('a')?.getAttribute('href') || '';
            const match = /^\/([^/?#]+)\/status\/(\d+)/.exec(href);
            if (match && match[2] === statusId) return article;
        }
        return null;
    }

    /**
     * Build a readable title from the rendered tweet.
     * @param {string} statusId
     * @returns {string} e.g. 'Name on X: "tweet text"', or '' if not rendered yet
     */
    function extractTweetTitle(statusId) {
        const article = findTweetArticle(statusId);
        if (!article) return '';

        const nameBlock = own(article, '[data-testid="User-Name"]');
        const name = nameBlock
            ? textOf(nameBlock.firstElementChild || nameBlock).split('\n')[0].trim()
            : '';

        const textEl = own(article, '[data-testid="tweetText"]');
        let text = textEl ? textOf(textEl) : '';
        if (!text) {
            if (own(article, '[data-testid="tweetPhoto"]')) text = '[image]';
            else if (own(article, '[data-testid="videoPlayer"]')) text = '[video]';
            else if (own(article, '[data-testid="card.wrapper"]')) text = '[link]';
        }

        if (!name && !text) return '';
        const title = !name ? text : (text ? `${name} on X: "${text}"` : `${name} on X`);
        return title.slice(0, MAX_TITLE_LENGTH);
    }

    // --- Core Tracking ---
    const visitHistory = loadHistory();
    let lastTrackedUrl = null;

    /**
     * Reject empty, "X", and bare "Username on X" (no tweet content).
     * @param {string} title
     * @returns {boolean}
     */
    function isMeaningfulTitle(title) {
        if (!title) return false;
        const stripped = title.trim();
        if (stripped === 'X' || stripped.length <= 1) return false;
        if (/on X$/.test(stripped)) return false;
        return true;
    }

    /**
     * Record a visit for the given URL. The visit is saved immediately with a
     * URL fallback, so a slow-rendering tweet is never lost.
     * @param {string} normalizedUrl
     * @param {string} title
     */
    function recordVisit(normalizedUrl, title) {
        const now = Date.now();
        const existing = visitHistory.get(normalizedUrl);
        const meaningful = isMeaningfulTitle(title);

        if (existing) {
            existing.lastVisit = now;
            if (meaningful) existing.title = title;
        } else {
            visitHistory.set(normalizedUrl, {
                url: normalizedUrl,
                title: meaningful ? title : normalizedUrl,
                lastVisit: now,
            });
        }

        saveHistory(visitHistory, normalizedUrl);
    }

    /**
     * Replace a fallback title once the tweet has rendered.
     * @param {string} normalizedUrl
     * @param {string} title
     */
    function updateTitle(normalizedUrl, title) {
        const entry = visitHistory.get(normalizedUrl);
        if (!entry || !isMeaningfulTitle(title) || entry.title === title) return;
        entry.title = title;
        saveHistory(visitHistory);
        console.debug(`[X History Tracker] Title: ${title}`);
    }

    /**
     * Poll the rendered tweet until its text is available.
     * @param {string} normalizedUrl
     * @param {string} statusId
     * @param {number} attempt
     */
    function extractTitleWithRetry(normalizedUrl, statusId, attempt) {
        const MAX_ATTEMPTS = 8;
        const RETRY_INTERVAL_MS = 750;

        const title = extractTweetTitle(statusId);
        if (isMeaningfulTitle(title)) {
            updateTitle(normalizedUrl, title);
            return;
        }
        if (attempt >= MAX_ATTEMPTS) return;
        setTimeout(() => extractTitleWithRetry(normalizedUrl, statusId, attempt + 1), RETRY_INTERVAL_MS);
    }

    /**
     * Check if current URL is a status page and record it.
     */
    function trackCurrentPage() {
        const match = STATUS_URL_REGEX.exec(window.location.href);
        if (!match) {
            // Leaving a status page means a later return is a new visit.
            lastTrackedUrl = null;
            return;
        }

        // Normalize: strip query params and hash
        const normalizedUrl = `https://x.com/${match[1]}/status/${match[2]}`;
        if (normalizedUrl === lastTrackedUrl) return;
        lastTrackedUrl = normalizedUrl;

        recordVisit(normalizedUrl, '');
        extractTitleWithRetry(normalizedUrl, match[2], 0);
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

    // X may navigate without calling the patched methods. Any DOM change can
    // hide a URL change, so check the URL after mutations, at most once a frame.
    let navCheckQueued = false;
    const bodyObserver = new MutationObserver(() => {
        if (navCheckQueued) return;
        navCheckQueued = true;
        requestAnimationFrame(() => {
            navCheckQueued = false;
            trackCurrentPage();
        });
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });

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

        let entries = Array.from(visitHistory.values())
            .sort((a, b) => b.lastVisit - a.lastVisit);

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
        stats.textContent = `${entries.length} / ${settings.maxEntries} posts | newest first`;

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
                row.title = entry.title;

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

                const timeEl = document.createElement('span');
                timeEl.textContent = timeAgo(entry.lastVisit);

                meta.appendChild(urlEl);
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
                    stats.textContent = `${entries.length} / ${settings.maxEntries} posts | newest first`;
                });

                row.addEventListener('click', () => {
                    window.open(entry.url, '_blank');
                });

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
                stats.textContent = `${entries.length} / ${settings.maxEntries} posts | newest first`;
                return;
            }
            const filtered = entries.filter(e =>
                e.title.toLowerCase().includes(query) ||
                e.url.toLowerCase().includes(query)
            );
            renderEntries(filtered);
            stats.textContent = `${filtered.length} of ${entries.length} / ${settings.maxEntries} posts | newest first`;
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
        maxDesc.textContent = 'Maximum number of posts to keep. Oldest entries are evicted when exceeded.';

        const maxRow = document.createElement('div');
        maxRow.className = 'xht-setting-row';

        const maxRange = document.createElement('input');
        maxRange.type = 'range';
        maxRange.className = 'xht-setting-range';
        maxRange.min = '50';
        maxRange.max = String(MAX_ENTRIES_LIMIT);
        maxRange.step = '50';
        maxRange.value = draft.maxEntries;

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.className = 'xht-setting-input';
        maxInput.min = '10';
        maxInput.max = String(MAX_ENTRIES_LIMIT);
        maxInput.value = draft.maxEntries;

        maxRange.addEventListener('input', () => {
            draft.maxEntries = parseInt(maxRange.value, 10);
            maxInput.value = draft.maxEntries;
        });

        maxInput.addEventListener('change', () => {
            let val = parseInt(maxInput.value, 10);
            if (isNaN(val) || val < 10) val = 10;
            if (val > MAX_ENTRIES_LIMIT) val = MAX_ENTRIES_LIMIT;
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
            stats.textContent = `${visitHistory.size} / ${settings.maxEntries} posts | newest first`;
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
                stats.textContent = `0 / ${settings.maxEntries} posts | newest first`;
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
        const entries = Array.from(visitHistory.values())
            .sort((a, b) => b.lastVisit - a.lastVisit);
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
