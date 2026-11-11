# X History Tracker

A Tampermonkey userscript that automatically tracks visited X/Twitter posts and shows their text in a newest-first list.

## Problem

Posts you've seen on X but didn't Like or Bookmark are nearly impossible to find later. Searching by vague memory is painful.

## Solution

This script records every status page you visit. It reads the rendered tweet from the page, so the stored entry contains the author and tweet text, not just a URL. Entries are sorted by last visit: the post you opened most recently is always at the top.

## Features

- **Automatic tracking** -- Detects SPA navigation via `pushState`/`replaceState`, `popstate`, and a body mutation observer.
- **Readable titles** -- Extracts text from the live tweet DOM (`article[data-testid="tweet"]`, `[data-testid="tweetText"]`), with `og:title` as fallback.
- **Image/video posts** -- Shows `[image]`, `[video]`, or `[link]` when a post has no text.
- **Newest first** -- Sorted by `lastVisit` descending. No score, no decay, no tuning.
- **Deduplication** -- URLs are normalized to `https://x.com/{user}/status/{id}`. A revisit moves the post to the top and refreshes its title.
- **Browsable history panel** -- Search/filter by title or URL. Click to open, hover to delete, hover to see the full title.
- **Configurable cap** -- Max entries adjustable in the Settings tab. Oldest entries are evicted first.
- **Export** -- One-click JSON export sorted by last visit.
- **Danger zone** -- Clear all history with two-step inline confirmation.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/)
2. Create a new script and paste the contents of [`user.js`](user.js)
3. Visit any post on [x.com](https://x.com) -- tracking starts automatically

## Usage

Tampermonkey menu > **View History**

**History tab**
- Search bar to filter by title or URL
- Entries sorted by last visit (newest first)
- Click an entry to open it in a new tab
- Hover to reveal the delete button; hover the row to see the full title
- Export button to download as JSON

**Settings tab**
- **Max entries** -- Slider (50-5000) or manual input (10-5000). Oldest entries are evicted when exceeded; the post you just visited is never evicted.
- **Danger Zone** -- Clear all history with two-step confirmation.

Changes take effect after clicking **Save Settings**.

## Title Extraction

X writes `<meta property="og:title">` on full page load but does not reliably update it during SPA navigation. The script therefore reads the rendered tweet:

```
article[data-testid="tweet"]      -> the post
  [data-testid="User-Name"]       -> display name
  [data-testid="tweetText"]       -> tweet text (emoji, line breaks preserved)
  a[href*="/status/"] time        -> matches the status page being viewed
```

It retries up to 8 times, 750 ms apart, because the tweet can render after the URL changes. If the tweet never renders, the URL is stored as a fallback. A later visit replaces the fallback with the real text.

`og:title` is not used. X leaves that tag stale after SPA navigation, so it can carry the previous page's text.

## Storage

- **History data** -- `localStorage` key `x-history-tracker` (stays within the x.com origin). Stored as compact tuples `[username, statusId, title, lastVisitSec]`; the full URL is reconstructed on load. Legacy v2 tuples (`[username, statusId, title, score, lastVisitSec]`) and v1 objects load automatically.
- **Settings** -- `GM_setValue` key `x-history-tracker-settings` (persisted by Tampermonkey)

## License

MIT
