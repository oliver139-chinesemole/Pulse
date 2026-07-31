# PULSE — Live Music Radar

### ▶ **[View the live site — oliver139-chinesemole.github.io/Pulse](https://oliver139-chinesemole.github.io/Pulse/)**

A US live-music discovery page: presales about to open, stadium tours, festival
lineups, warehouse raves, and rising artists — all in one filterable radar,
refreshed daily from the Ticketmaster Discovery API.

**~4,000 events**, up from 147 hand-typed entries.

[![Preview](preview.png)](https://oliver139-chinesemole.github.io/Pulse/)

## How it works

```
data/curated.json ──┐
                    ├──> scripts/fetch-events.mjs ──> data/events.json ──> index.html
Ticketmaster API ───┘        (daily, via Actions)
```

Two layers get merged:

- **`data/curated.json`** — hand-sourced entries with presale codes, on-sale
  times and editorial context the API doesn't carry. These win on collision.
- **Ticketmaster Discovery API** — US coverage. Individual dates are grouped by
  act, so a 22-date tour renders as one card rather than 22 near-identical ones.

Discovery caps any single query at 1,000 events while the US has ~11,000, so the
script sweeps 8 months in **14-day windows** and merges the results. Adding
another country is one line in `MARKETS` — Discovery also covers CA, MX, GB, IE,
DE, ES, NL, BE, IT, AT, CH, the Nordics, PL, CZ, AU and NZ well.

`index.html` fetches `data/events.json` at load. No build step, no framework.

## Running it locally

The page fetches a JSON file, and browsers block `fetch` over `file://`, so it
needs to be served rather than opened directly:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk shows a message telling you the same thing.

## Refreshing the data

Automatic: `.github/workflows/refresh-events.yml` runs daily at 09:00 UTC and
commits `data/events.json` only when the event payload actually changed — a
moved timestamp alone won't produce a commit.

Manually, from the repo root:

```sh
export TICKETMASTER_API_KEY=your_key
node scripts/fetch-events.mjs
```

Without the key the script still succeeds and emits the curated layer alone, so
a missing secret degrades the site instead of breaking it.

### The API key

Get one at [developer.ticketmaster.com](https://developer.ticketmaster.com) —
it's the **Consumer Key** (32 alphanumeric characters) from your app's
Credentials tab. The Consumer Secret is not used; Discovery authenticates with
the key alone.

For the scheduled workflow, store it as a repository secret named
`TICKETMASTER_API_KEY` under **Settings → Secrets and variables → Actions**.
Never commit it — the free tier is capped at 5,000 requests/day and a leaked
key lets anyone exhaust that quota.

## Discovery

The interface is built around finding shows you wouldn't otherwise hear about —
about 2,500 of the events are single-night local shows rather than arena tours.

- **📍 Near me** — browser geolocation, then a real distance filter (25–250 mi)
  computed against per-city coordinates, sorted nearest first
- **💎 Hidden gems** — hides multi-city tours, leaving only one-night local shows
- **Date** — this weekend / next 7 days / next 30 days
- **Genre** — 18 genres with enough depth to browse
- **🔀 Surprise me** — shuffles the filtered set for serendipity
- Free-text search, city autocomplete, and category chips
- Rows render 40 at a time behind **Load more**

Ticket buttons say what they do: **Tickets** for a real ticket page, **Find
tickets** for an artist search when no direct link exists, **Read more** when
only the source announcement is available.

## Event schema

```js
{
  cat: 'concert',              // concert | festival | edm | rising
  flags: ['radar'],            // radar (on-sale within 7 days) | hot | now
  title: "Artist — Tour Name",
  sub: "One-line hook",
  when: "Sep 5 – Nov 21 · 12 dates",
  details: "Longer description",
  genre: "pop",
  cities: ["Los Angeles, CA"],
  tix: "https://…",            // or null
  src: "https://…",            // source announcement
  source: 'curated',           // curated | ticketmaster
  country: 'US',
  region: 'North America'
}
```

To add a curated entry by hand, edit `data/curated.json` and re-run the script.

## Known gaps

- **Ticketmaster-only.** Events sold exclusively through other platforms —
  Tixr, Dice, AXS, Eventbrite, Resident Advisor, See Tickets — do not appear.
  That gap is widest for clubs, warehouse raves and independent promoters.
  Closing it means adding sources, not tuning this one.
- **Capped at 4,000 cards** to keep the payload near 1.8 MB (~350 KB gzipped).
  The fetch finds ~4,800; the soonest survive, so far-future events are the ones
  dropped.
- **Up to 24 hours stale**, by design — daily cron, not live queries.
- **Junk filtering is a denylist.** Discovery's music classification includes
  parking, season passes and gift-shop hours; `JUNK` in the fetch script catches
  the common shapes but the tail is long.
- **Curated dates are parsed from prose.** `when` strings like "Oct 28 – Nov 22"
  carry no year, so the parser assumes the next occurrence. 135 of 147 parse;
  the rest sort to the bottom.
- **Link checking can't see through bot walls.** Ticketing sites answer
  automated requests with 401/403, so those links are left alone rather than
  being wrongly pruned. Only DNS failures, 4xx/5xx and parked-domain landers
  are treated as dead.
- **Fonts load from a CDN**, so the page falls back to system fonts offline.
- Dates and presale details change constantly — always confirm on the ticketing page.
