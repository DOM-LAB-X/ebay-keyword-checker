'use strict';

const { parseQuery, matchListing } = require('./query');
const { enrichListing } = require('./parser');
const { buildSearchUrl } = require('./ebay');
const { buildPayloads, isValidWebhook } = require('./discord');
const { betweenSearchDelayMs } = require('./scheduler');

/** Applies keyword, price, format and condition rules. Returns { ok, reason }. */
function filterListing(watch, listing, parsed = parseQuery(watch.query)) {
  const kw = matchListing(parsed, listing);
  if (!kw.ok) return kw;

  const value = watch.includeShipping ? listing.total : listing.price;
  if (watch.minPrice != null || watch.maxPrice != null) {
    if (value == null) return { ok: false, reason: 'no price' };
    if (watch.minPrice != null && value < watch.minPrice) return { ok: false, reason: 'below min price' };
    if (watch.maxPrice != null && value > watch.maxPrice) return { ok: false, reason: 'above max price' };
  }

  if (watch.listingType === 'auction' && listing.format !== 'auction') return { ok: false, reason: 'not an auction' };
  if (watch.listingType === 'buy_it_now' && listing.format === 'auction' && !listing.buyItNow) return { ok: false, reason: 'not Buy It Now' };

  const cond = String(listing.condition || '').toLowerCase();
  if (watch.condition === 'new' && cond && !/\bnew\b/.test(cond)) return { ok: false, reason: 'not new' };
  if (watch.condition === 'used' && cond && /^(brand )?new\b/.test(cond)) return { ok: false, reason: 'not used' };

  return { ok: true };
}

/**
 * Runs one search for one watch.
 * Returns { status, found: [...newMatches], scanned, seeded }
 */
async function checkWatch(watch, { store, fetchListings, now = Date.now }) {
  const url = buildSearchUrl(watch);
  const page = await fetchListings(url);
  if (page.status === 'blocked') return { status: 'blocked', found: [], scanned: 0 };
  if (page.status !== 'ok') return { status: 'error', found: [], scanned: 0, error: 'Unrecognized eBay page' };

  const parsed = parseQuery(watch.query);
  const firstRun = !store.hasSeenAny(watch.id);
  const allIds = new Set();
  const found = [];
  for (const raw of page.listings) {
    if (allIds.has(raw.id)) continue; // eBay can repeat a listing on one page
    allIds.add(raw.id);
    if (store.isSeen(watch.id, raw.id) || store.wasNotified(raw.id)) continue;
    const listing = enrichListing(raw);
    if (!filterListing(watch, listing, parsed).ok) continue;
    found.push({ ...listing, watchId: watch.id, watchName: watch.name, foundAt: now() });
  }
  store.markSeen(watch.id, [...allIds]);
  return { status: 'ok', found, scanned: page.listings.length, seeded: firstRun };
}

/**
 * Runs every enabled watch once with randomized pauses in between.
 * Returns { failed, totalFound, results }
 */
async function runCycle({ store, fetchListings, sendDiscord, notifyDesktop, sleep, rng = Math.random, now = Date.now, onProgress = () => {}, onlyWatchId = null }) {
  // onlyWatchId: check just that one search (its own Check button), even if it is switched off
  const watches = onlyWatchId ? store.state.watches.filter((w) => w.id === onlyWatchId) : store.state.watches.filter((w) => w.enabled);
  const settings = store.settings;
  const results = [];
  let blocked = 0;
  let errors = 0;
  let totalFound = 0;

  if (!onlyWatchId) store.state.lastCycleAt = now();

  for (let i = 0; i < watches.length; i++) {
    const watch = watches[i];
    if (i > 0) await sleep(betweenSearchDelayMs(rng));
    onProgress({ watchId: watch.id, index: i, total: watches.length });

    let result;
    try {
      result = await checkWatch(watch, { store, fetchListings, now });
    } catch (err) {
      result = { status: 'error', found: [], scanned: 0, error: err.message };
    }
    results.push({ watchId: watch.id, ...result });
    watch.lastCheckedAt = now();
    watch.lastStatus = result.status;

    if (result.status === 'blocked') {
      blocked++;
      store.addLog('warn', `eBay asked to slow down on “${watch.name}”. Backing off.`);
      break; // stop the cycle; the scheduler will wait longer next time
    }
    if (result.status === 'error') {
      errors++;
      store.addLog('error', `“${watch.name}”: ${result.error}`);
      continue;
    }

    if (result.found.length) {
      store.addMatches(result.found);
      totalFound += result.found.length;
    }

    const silent = result.seeded && !settings.notifyFirstCheck;
    if (silent) {
      store.addLog('info', `“${watch.name}” is set up — ${result.scanned} current listings marked as seen. You’ll be alerted to new ones.`);
      continue;
    }
    if (!result.found.length) continue;

    // record before sending: a listing is never alerted twice, even across searches or after a crash
    store.markNotified(result.found.map((l) => l.id));
    store.addLog('info', `“${watch.name}”: ${result.found.length} new match${result.found.length === 1 ? '' : 'es'}.`);
    const webhook = isValidWebhook(watch.webhookUrl) ? watch.webhookUrl : settings.webhookUrl;
    if (isValidWebhook(webhook)) {
      const payloads = buildPayloads(result.found, watch.name, { mention: settings.discordMention });
      const sent = await sendDiscord(webhook, payloads);
      if (sent && sent.error) store.addLog('error', `Discord: ${sent.error}`);
    }
    if (settings.desktopNotifications && notifyDesktop) notifyDesktop(watch, result.found);
  }

  store.save();
  const failed = blocked > 0 || (watches.length > 0 && errors === watches.length);
  return { failed, blocked: blocked > 0, totalFound, results };
}

module.exports = { filterListing, checkWatch, runCycle };
