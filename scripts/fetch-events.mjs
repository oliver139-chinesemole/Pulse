#!/usr/bin/env node
/**
 * Builds data/events.json for the PULSE radar.
 *
 * Merges two layers:
 *   1. data/curated.json  — hand-sourced US entries (presales, on-sale alerts)
 *   2. Ticketmaster Discovery API — worldwide music events, grouped into tours
 *
 * Without TICKETMASTER_API_KEY the script still succeeds and emits the curated
 * layer alone, so a missing secret degrades the site rather than breaking it.
 *
 *   node scripts/fetch-events.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Overridable so the pipeline can be exercised against a mock in tests.
const API = process.env.TM_API_BASE
  ?? 'https://app.ticketmaster.com/discovery/v2/events.json';
const KEY = process.env.TICKETMASTER_API_KEY;

// US-only for now. Adding a market is one line — Discovery also covers CA, MX,
// GB, IE, DE, ES, NL, BE, IT, AT, CH, SE, NO, DK, FI, PL, CZ, AU, NZ well.
const MARKETS = [
  { code: 'US', region: 'North America' },
];

// Discovery caps paging at (page * size) <= 1000, so 5 pages of 200 is the
// deepest a single country query can reach.
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const MAX_CARDS = 4000;        // keeps events.json a reasonable download
const MONTHS_AHEAD = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(params, attempt = 0) {
  const url = `${API}?${new URLSearchParams(params)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) {                     // rate limited — back off
      if (attempt >= 4) return null;
      await sleep(2000 * (attempt + 1));
      return getJSON(params, attempt + 1);
    }
    if (!res.ok) {
      console.warn(`  ! HTTP ${res.status} for ${params.countryCode ?? '?'}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    if (attempt >= 3) {
      console.warn(`  ! ${params.countryCode ?? '?'}: ${err.message}`);
      return null;
    }
    await sleep(1000 * (attempt + 1));
    return getJSON(params, attempt + 1);
  }
}

/**
 * Discovery caps any single query at 1,000 events, but the US has ~10,000.
 * Slicing the range into short windows lifts that ceiling to 1,000 per slice.
 *
 * Fixed-length day arithmetic rather than setMonth(): month arithmetic
 * overflows (Sep 31 rolls into Oct), producing uneven, confusingly-labelled
 * windows. Windows are contiguous and half-open — each starts where the last ended.
 */
function timeWindows(totalDays, sliceDays) {
  const out = [];
  const origin = Date.now();
  for (let day = 0; day < totalDays; day += sliceDays) {
    const start = new Date(origin + day * 86400000);
    const end = new Date(origin + Math.min(day + sliceDays, totalDays) * 86400000);
    out.push([
      start.toISOString().slice(0, 19) + 'Z',
      end.toISOString().slice(0, 19) + 'Z',
    ]);
  }
  return out;
}

/** Every event Discovery will give us for one country, across the window. */
async function fetchMarket(market, startISO, endISO) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJSON({
      apikey: KEY,
      classificationName: 'music',
      countryCode: market.code,
      startDateTime: startISO,
      endDateTime: endISO,
      size: String(PAGE_SIZE),
      page: String(page),
      sort: 'date,asc',
    });
    const batch = data?._embedded?.events;
    if (!batch?.length) break;
    out.push(...batch);
    if (page + 1 >= (data.page?.totalPages ?? 0)) break;
    await sleep(250);                             // stay under 5 req/sec
  }
  return out;
}

/**
 * Discovery's music classification includes things that aren't shows: parking,
 * season passes, camping, shuttles, gift cards. They carry placeholder dates
 * and sort to the top, so they're dropped before grouping.
 */
const JUNK = new RegExp([
  'parking', 'season pass', 'season ticket', 'entry to all shows',
  "i'm on the list", 'gift card', 'gift certificate', 'camping',
  'shuttle', 'hotel package', 'test event', 'gift voucher',
  'membership', 'donation', 'gratuity', 'upgrade only',
  'concert package', 'show-pass', 'show pass', 'package event',
  'gift shop', 'shop hours', 'museum admission', 'guided tour',
].join('|'), 'i');
// A denylist is inherently incomplete — Discovery's music classification has a
// long tail of venue admin listings. This catches the common shapes.

function isJunk(ev) {
  const name = ev.name ?? '';
  if (JUNK.test(name)) return true;
  // Parking listings sometimes classify as music but sit in a Parking segment.
  const seg = ev.classifications?.[0]?.segment?.name ?? '';
  if (/parking|miscellaneous/i.test(seg)) return true;
  return false;
}

const fmtDate = iso => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** Ticketmaster classifications -> the four categories the UI filters on. */
function categorize(ev, name) {
  const c = ev.classifications?.[0] ?? {};
  const genre = (c.genre?.name ?? '').toLowerCase();
  const sub = (c.subGenre?.name ?? '').toLowerCase();
  if (/festival|fest\b/i.test(name)) return 'festival';
  if (genre.includes('electronic') || sub.includes('house') ||
      sub.includes('techno') || sub.includes('trance')) return 'edm';
  return 'concert';
}

function genreLabel(ev) {
  const c = ev.classifications?.[0] ?? {};
  const parts = [c.genre?.name, c.subGenre?.name]
    .filter(g => g && !/^(undefined|other)$/i.test(g));
  return [...new Set(parts)].join('/').toLowerCase() || 'music';
}

function cityLabel(ev, market) {
  const v = ev._embedded?.venues?.[0];
  if (!v) return null;
  const city = v.city?.name;
  if (!city) return null;
  // US/CA read naturally as "City, ST"; elsewhere "City, Country" is clearer.
  const qualifier = (market.code === 'US' || market.code === 'CA')
    ? v.state?.stateCode
    : v.country?.name;
  return qualifier ? `${city}, ${qualifier}` : city;
}

/**
 * Collapses many dated events into one card per act, so a 22-date tour reads
 * as a single entry the way the curated cards do.
 */
function groupIntoCards(events, market) {
  const groups = new Map();
  for (const ev of events) {
    const act = ev._embedded?.attractions?.[0];
    // No attraction (one-off local shows) — key on the event name instead.
    const key = act?.id ?? `name:${ev.name}`;
    if (!groups.has(key)) groups.set(key, { act, events: [] });
    groups.get(key).events.push(ev);
  }

  const cards = [];
  for (const { act, events: evs } of groups.values()) {
    const name = act?.name ?? evs[0].name;
    // A residency or series can have started months ago; only upcoming dates
    // belong on a radar, so past ones are dropped and empty cards discarded.
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const dates = evs
      .map(e => e.dates?.start?.dateTime ?? e.dates?.start?.localDate)
      .filter(Boolean)
      .filter(d => d >= cutoff.slice(0, d.length))
      .sort();
    if (!dates.length) continue;
    const cities = [...new Set(evs.map(e => cityLabel(e, market)).filter(Boolean))];
    if (!cities.length) continue;

    const first = fmtDate(dates[0]);
    const last = fmtDate(dates[dates.length - 1]);
    const when = dates.length > 1 && first !== last
      ? `${first} – ${last} · ${evs.length} dates`
      : first ?? 'Date TBA';

    // "on-sale within the next week" is what the radar chip is for.
    const soon = evs.some(e => {
      const s = e.sales?.public?.startDateTime;
      if (!s) return false;
      const days = (new Date(s) - Date.now()) / 86400000;
      return days > 0 && days <= 7;
    });

    const venues = [...new Set(
      evs.map(e => e._embedded?.venues?.[0]?.name).filter(Boolean)
    )].slice(0, 3);

    cards.push({
      cat: categorize(evs[0], name),
      flags: soon ? ['radar'] : [],
      title: name,
      sub: evs.length > 1
        ? `${evs.length} dates across ${cities.length} ${cities.length === 1 ? 'city' : 'cities'}`
        : (evs[0]._embedded?.venues?.[0]?.name ?? ''),
      when,
      details: venues.length ? `Playing ${venues.join(', ')}.` : '',
      genre: genreLabel(evs[0]),
      cities,
      tix: evs[0].url ?? null,
      src: act?.url ?? evs[0].url ?? null,
      source: 'ticketmaster',
      country: market.code,
      region: market.region,
      // sort key — earliest date, used to surface soonest events first
      _t: dates[0] ?? '',
    });
  }
  return cards;
}

async function main() {
  const curated = JSON.parse(readFileSync(join(ROOT, 'data/curated.json'), 'utf8'))
    .map(e => ({ ...e, region: 'North America', source: 'curated' }));

  let apiCards = [];

  if (!KEY) {
    console.log('TICKETMASTER_API_KEY not set — emitting curated layer only.');
    console.log('Add the secret to enable worldwide coverage.');
  } else {
    // 14-day slices: short enough that few windows hit the 1,000-event cap.
    const windows = timeWindows(MONTHS_AHEAD * 30, 14);
    console.log(`  ${windows.length} windows x ${MARKETS.length} market(s)`);

    for (const market of MARKETS) {
      const all = [];
      const seen = new Set();
      let junked = 0;
      for (const [startISO, endISO] of windows) {
        const evs = await fetchMarket(market, startISO, endISO);
        let added = 0;
        for (const e of evs) {
          if (isJunk(e)) { junked++; continue; }
          // Windows can overlap at boundaries; keep one copy of each event.
          const id = e.id ?? `${e.name}|${e.dates?.start?.dateTime}`;
          if (seen.has(id)) continue;
          seen.add(id);
          all.push(e);
          added++;
        }
        const capped = evs.length >= PAGE_SIZE * MAX_PAGES ? ' (CAPPED)' : '';
        console.log(`  ${market.code} ${startISO.slice(0, 10)}: +${added}${capped}`);
        await sleep(250);
      }
      // Grouped after every window is in, so tours spanning months stay one card.
      const cards = groupIntoCards(all, market);
      console.log(`  ${market.code}: ${all.length} events -> ${cards.length} cards ` +
                  `(${junked} non-events filtered)`);
      apiCards.push(...cards);
    }

    // Soonest first, then trim to keep the payload sane.
    apiCards.sort((a, b) => a._t.localeCompare(b._t));
    if (apiCards.length > MAX_CARDS) {
      console.log(`  trimming ${apiCards.length} -> ${MAX_CARDS} cards`);
      apiCards = apiCards.slice(0, MAX_CARDS);
    }
    apiCards.forEach(c => delete c._t);
  }

  // Curated entries win on collision — they carry presale detail the API lacks.
  const seen = new Set(curated.map(e => e.title.toLowerCase().split('—')[0].trim()));
  const merged = [
    ...curated,
    ...apiCards.filter(c => !seen.has(c.title.toLowerCase().trim())),
  ];

  const payload = {
    updated: new Date().toISOString(),
    counts: {
      total: merged.length,
      curated: curated.length,
      ticketmaster: merged.length - curated.length,
      countries: new Set(merged.map(e => e.country)).size,
    },
    events: merged,
  };

  writeFileSync(join(ROOT, 'data/events.json'), JSON.stringify(payload));
  console.log(`\nwrote data/events.json — ${payload.counts.total} cards across ` +
              `${payload.counts.countries} countries`);
}

main().catch(err => { console.error(err); process.exit(1); });
