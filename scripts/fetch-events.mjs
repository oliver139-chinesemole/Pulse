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
const ATTRACTIONS_API = API.replace('/events.json', '/attractions.json');
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

async function getJSON(params, attempt = 0, base = API) {
  const url = `${base}?${new URLSearchParams(params)}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) {                     // rate limited — back off
      if (attempt >= 4) return null;
      await sleep(2000 * (attempt + 1));
      return getJSON(params, attempt + 1, base);
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

/**
 * Best artist/event image for a card. Prefers the attraction's own photo (an
 * artist shot) over the event's (often generic venue art), and a 16:9 crop
 * around 640px — big enough for a thumbnail, small enough to load fast.
 */
function pickImage(ev, act) {
  const pools = [act?.images, ev.images].filter(Array.isArray);
  for (const pool of pools) {
    const wide = pool.filter(i => i.ratio === '16_9' && i.width >= 500 && i.width <= 1200);
    const best = wide.sort((a, b) => a.width - b.width)[0] ?? pool.find(i => i.width >= 500);
    if (best?.url) return best.url;
  }
  return null;
}

/** City label -> [lat, lng], harvested from venues so curated rows can borrow it. */
const CITY_COORDS = new Map();

function venueCoords(ev) {
  const loc = ev._embedded?.venues?.[0]?.location;
  if (!loc) return null;
  const lat = Number(loc.latitude), lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  // 2dp is ~1km — plenty for "shows near me", and a third the bytes.
  return [Math.round(lat * 100) / 100, Math.round(lng * 100) / 100];
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

    // One coordinate per city, in the same order as `cities`.
    const geo = cities.map(city => {
      const match = evs.find(e => cityLabel(e, market) === city && venueCoords(e));
      const c = match ? venueCoords(match) : null;
      if (c && !CITY_COORDS.has(city)) CITY_COORDS.set(city, c);
      return c;
    });

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

    const cat = categorize(evs[0], name);

    cards.push({
      cat,
      flags: soon ? ['radar'] : [],
      title: name,
      sub: evs.length > 1
        ? `${evs.length} dates across ${cities.length} ${cities.length === 1 ? 'city' : 'cities'}`
        : (evs[0]._embedded?.venues?.[0]?.name ?? ''),
      when,
      details: venues.length ? `Playing ${venues.join(', ')}.` : '',
      genre: genreLabel(evs[0]),
      // Primary genre alone — 200+ combined labels are too many to browse.
      g0: (evs[0].classifications?.[0]?.genre?.name ?? '').toLowerCase() || 'other',
      cities,
      geo,
      // Machine-readable range, so the page can filter by date rather than
      // pattern-matching the display string in `when`.
      d0: dates[0].slice(0, 10),
      d1: dates[dates.length - 1].slice(0, 10),
      // A single night in one city is the long tail; tours are the famous stuff.
      gem: cities.length === 1 && evs.length === 1 && cat !== 'festival',
      img: pickImage(evs[0], act),
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

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

/**
 * Curated `when` strings are prose ("Oct 28 – Nov 22 · 22 dates", "Aug 3 ·
 * United Center"). Pulling dates out of them lets curated rows sort and filter
 * alongside API events instead of piling up dateless at the top of the page.
 */
function datesFromProse(when) {
  if (!when) return null;
  const found = [...when.matchAll(/\b([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2})\b/g)]
    .map(m => [MONTH_NAMES.indexOf(m[1].toLowerCase()), Number(m[2])])
    .filter(([mo, d]) => mo >= 0 && d >= 1 && d <= 31);
  if (!found.length) return null;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // An explicit year in the text always wins ("Boston Calling 2027").
  const stated = when.match(/\b(20\d{2})\b/);

  const iso = found.map(([mo, d]) => {
    const year = stated
      ? Number(stated[1])
      // Otherwise assume the next occurrence: a month well behind us is next year.
      : (mo < now.getMonth() - 1 ? now.getFullYear() + 1 : now.getFullYear());
    return `${year}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }).sort();

  let [d0, d1] = [iso[0], iso[iso.length - 1]];

  // A run that already ended is almost certainly next year's edition.
  if (d1 < today && !stated) {
    const bump = s => `${Number(s.slice(0, 4)) + 1}${s.slice(4)}`;
    [d0, d1] = [bump(d0), bump(d1)];
  }
  // A run already under way should read as starting today, not months ago.
  if (d0 < today && d1 >= today) d0 = today;

  return [d0, d1];
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Curated links rot: tour microsites expire and get picked up by domain
 * squatters, which serve a 200 for a parking page. Status alone can't tell
 * those apart, so tiny bodies that bounce to a lander count as dead too.
 *
 * Ticketing sites block automated requests (401/403/429). That is not death —
 * those stay untouched rather than being replaced with a worse link.
 */
async function checkUrl(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(12000),
    });
    if ([401, 403, 429].includes(res.status)) return 'blocked';
    if (!res.ok) return 'dead';
    const body = await res.text();
    if (body.length < 1500 &&
        /\/lander|parking|domain (is )?for sale|sedoparking|afternic|buy this domain/i.test(body)) {
      return 'parked';
    }
    return 'ok';
  } catch {
    return 'dead';                      // DNS failure, timeout, refused
  }
}

/** Runs checks a few at a time so 150 links take seconds, not minutes. */
async function checkAll(urls, concurrency = 8) {
  const results = new Map();
  const queue = [...new Set(urls)];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const url = queue.shift();
      results.set(url, await checkUrl(url));
    }
  }));
  return results;
}

/**
 * Curated rows carry no artwork, and they sort to the top because they're the
 * most imminent — so the page opens on a wall of placeholders. Looking each act
 * up in Discovery's attraction index borrows a real press photo.
 */
async function addCuratedImages(rows) {
  const targets = rows.filter(e => !e.img);
  let found = 0;

  for (const e of targets) {
    const act = e.title.split('—')[0].split('(')[0].trim();
    if (!act) continue;
    const data = await getJSON({
      apikey: KEY,
      keyword: act,
      size: '1',
    }, 0, ATTRACTIONS_API);
    const hit = data?._embedded?.attractions?.[0];
    // Only trust an exact-ish name match; a fuzzy hit means the wrong artist's face.
    if (hit && hit.name.toLowerCase().startsWith(act.toLowerCase().slice(0, 6))) {
      const img = pickImage({}, hit);
      if (img) { e.img = img; found++; }
    }
    await sleep(220);
  }
  console.log(`  matched artwork for ${found}/${targets.length} curated rows`);
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

  // Curated rows have no coordinates of their own, but the API pass just built
  // a city -> coordinate map covering most US cities, so they can borrow it.
  // Their `when` strings are freeform prose, so they carry no d0/d1 and are
  // therefore skipped by date filters.
  let located = 0, searched = 0, dated = 0;
  for (const e of curated) {
    e.geo = (e.cities || []).map(c => CITY_COORDS.get(c) ?? null);
    if (e.geo.some(Boolean)) located++;
    // "Multiple cities" is a placeholder, not a city — a nationwide tour is the
    // opposite of a one-night local show.
    const real = (e.cities || []).filter(c => c !== 'Multiple cities');
    // Festivals run for days and draw crowds — never a "one night only" find.
    e.gem = real.length === 1 && e.cat !== 'festival';
    e.g0 = (e.genre || 'other').split('/')[0];
    const range = datesFromProse(e.when);
    if (range) { [e.d0, e.d1] = range; dated++; }
  }

  // Prune curated links that no longer resolve, then give every row without a
  // working ticket link a search fallback.
  const health = await checkAll(
    curated.flatMap(e => [e.tix, e.src].filter(Boolean))
  );
  let pruned = 0;
  for (const e of curated) {
    for (const field of ['tix', 'src']) {
      const state = e[field] && health.get(e[field]);
      if (state === 'dead' || state === 'parked') {
        console.log(`  ${state}: ${e[field]}`);
        e[field] = null;
        pruned++;
      }
    }
    // Some rows only ever cited a news article. Rather than send people to a
    // write-up under a "Tickets" button, offer a search for the act itself.
    if (!e.tix) {
      const act = e.title.split('—')[0].split('(')[0].trim();
      if (act) {
        e.tixq = 'https://www.ticketmaster.com/search?q=' + encodeURIComponent(act);
        searched++;
      }
    }
  }
  if (pruned) console.log(`  pruned ${pruned} dead or parked curated links`);
  if (KEY) console.log(`  located ${located}/${curated.length} curated rows via city map`);
  if (searched) console.log(`  added a ticket search to ${searched} rows lacking a direct link`);
  if (KEY) {
    console.log(`  parsed dates out of ${dated}/${curated.length} curated 'when' strings`);
    await addCuratedImages(curated);
  }

  // Curated entries win on collision — they carry presale detail the API lacks.
  const seen = new Set(curated.map(e => e.title.toLowerCase().split('—')[0].trim()));
  const merged = [
    ...curated,
    ...apiCards.filter(c => !seen.has(c.title.toLowerCase().trim())),
  ];

  // Soonest first, so the page opens on what's imminent. Rows whose date could
  // not be determined sink to the bottom rather than heading the list.
  merged.sort((a, b) => (a.d0 ?? '9999').localeCompare(b.d0 ?? '9999'));

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
