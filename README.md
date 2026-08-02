# X History Tracker

A Tampermonkey userscript that automatically tracks visited X/Twitter posts with [frecency](https://developer.mozilla.org/en-US/docs/Mozilla/Tech/Places/Frecency_algorithm)-based scoring for easy retrieval.

## Problem

Posts you've seen on X but didn't Like or Bookmark are nearly impossible to find later. Searching by vague memory is painful.

## Solution

This script silently records every status page you visit, storing the URL and a title summary (from `og:title` meta tag) in `localStorage`. Entries are ranked by **frecency** -- a combination of visit frequency and recency -- so the posts you visit often and recently always float to the top.

## Features

- **Automatic tracking** -- Detects SPA navigation via `pushState`/`replaceState` interception. No manual action required.
- **Frecency ranking** -- Inspired by [z (jump)](https://github.com/rupa/z) / [autojump](https://github.com/wting/autojump). Each visit credits +1 point; points decay as `2^(-age / half_life)`. Recent + frequent = highest rank.
- **Deduplication** -- URLs are normalized to `https://x.com/{user}/status/{id}`. Revisits add a recency credit and refresh the title.
- **Title extraction** -- Reads `<meta property="og:title">` with retry logic (up to 6 attempts, 1s apart) to handle SPA async updates.
- **Browsable history panel** -- Search/filter by title or URL, sorted by frecency score. Click to open, hover to delete.
- **Configurable settings** -- Max entries cap and frecency half-life, adjustable via the Settings tab.
- **Export** -- One-click JSON export of all tracked entries with scores.
- **Danger zone** -- Clear all history with two-step inline confirmation.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Create a new script and paste the contents of [`user.js`](user.js)
3. Visit any post on [x.com](https://x.com) -- tracking starts automatically

## Usage

### View History

Tampermonkey menu > **View History**

Opens a panel with two tabs:

**History tab**
- Search bar to filter by title or URL
- Entries sorted by frecency score (shown on the left)
- Click an entry to open in a new tab
- Hover to reveal the delete button
- Export button to download as JSON

**Settings tab**
- **Max entries** -- Slider (50-2000) or manual input (10-5000). Lowest-frecency entries are evicted when exceeded (the post you just visited is never evicted).
- **Frecency half-life** -- Slider (1-30 days). Lower values make recent visits dominate. Higher values let older entries persist.
- **Danger Zone** -- Clear all history with two-step confirmation.

Changes take effect after clicking **Save Settings**.

### Export

Tampermonkey menu > **Export History (JSON)** for quick export without opening the panel.

## How Frecency Works

```
on each visit:  score = score * 2^(-age_since_last_visit / half_life) + 1
displayed rank: score * 2^(-age_since_last_visit / half_life)
```

Only the accumulated score and last-visit timestamp are stored; the decayed value is computed on the fly.

| Scenario | half_life=7d | score |
|---|---|---|
| Visited once, just now | | 1.0 |
| Visited once, 7 days ago, untouched since | | 0.5 |
| Score 10, untouched for 14 days | | 2.5 |
| Visited once a day for the last 5 days | | ~4.1 |

Posts you visit frequently and recently rank highest. Old, rarely-visited posts naturally sink and get evicted when the cap is reached.

## Storage

- **History data** -- `localStorage` key `x-history-tracker` (stays within x.com origin). Stored as compact tuples `[username, statusId, title, score, lastVisitSec]`; the full URL is reconstructed on load. Legacy object format is migrated automatically.
- **Settings** -- `GM_setValue` key `x-history-tracker-settings` (persisted by Tampermonkey)

## License

MIT
