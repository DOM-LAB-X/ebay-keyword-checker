import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store } from '../src/main/store.js';
import { filterListing, checkWatch, runCycle } from '../src/main/checker.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123';
let dir;
let store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-'));
  store = new Store(path.join(dir, 'data.json'));
});
afterEach(() => {
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

const raw = (id, title, priceText = '$100.00', extra = {}) => ({ id, title, url: `https://www.ebay.com/itm/${id}`, priceText, shippingText: 'Free delivery', condition: 'Pre-Owned', subtitles: [], ...extra });
const page = (...listings) => ({ status: 'ok', listings });
const enriched = (over) => ({ title: 'RTX 4090', condition: 'Pre-Owned', price: 100, shipping: 20, total: 120, format: 'buy_it_now', buyItNow: true, ...over });
const baseWatch = { query: 'rtx', minPrice: null, maxPrice: null, includeShipping: false, listingType: 'all', condition: 'any' };

describe('filterListing', () => {
  it('applies min and max price', () => {
    const w = { ...baseWatch, minPrice: 50, maxPrice: 110 };
    expect(filterListing(w, enriched({ price: 100 })).ok).toBe(true);
    expect(filterListing(w, enriched({ price: 40 })).ok).toBe(false);
    expect(filterListing(w, enriched({ price: 111 })).ok).toBe(false);
  });

  it('can filter on price + shipping', () => {
    const w = { ...baseWatch, maxPrice: 110, includeShipping: true };
    expect(filterListing(w, enriched({ price: 100, total: 120 })).ok).toBe(false);
  });

  it('drops listings without a price when a price filter is set', () => {
    expect(filterListing({ ...baseWatch, maxPrice: 10 }, enriched({ price: null })).ok).toBe(false);
  });

  it('filters auctions vs Buy It Now', () => {
    const auction = enriched({ format: 'auction', buyItNow: false });
    expect(filterListing({ ...baseWatch, listingType: 'buy_it_now' }, auction).ok).toBe(false);
    expect(filterListing({ ...baseWatch, listingType: 'auction' }, auction).ok).toBe(true);
    expect(filterListing({ ...baseWatch, listingType: 'buy_it_now' }, enriched({ format: 'auction', buyItNow: true })).ok).toBe(true);
  });

  it('filters by condition', () => {
    expect(filterListing({ ...baseWatch, condition: 'new' }, enriched({ condition: 'Brand New' })).ok).toBe(true);
    expect(filterListing({ ...baseWatch, condition: 'new' }, enriched({ condition: 'Pre-Owned' })).ok).toBe(false);
    expect(filterListing({ ...baseWatch, condition: 'used' }, enriched({ condition: 'Brand New' })).ok).toBe(false);
  });

  it('applies +/- keywords', () => {
    expect(filterListing({ ...baseWatch, query: 'rtx -broken' }, enriched({ title: 'RTX 4090 broken' })).ok).toBe(false);
  });
});

describe('checkWatch', () => {
  it('first check marks everything seen and flags it as seeded', async () => {
    const w = store.upsertWatch({ query: 'rtx' });
    const r = await checkWatch(w, { store, fetchListings: async () => page(raw('1', 'RTX a'), raw('2', 'RTX b')) });
    expect(r.seeded).toBe(true);
    expect(store.isSeen(w.id, '1')).toBe(true);
  });

  it('only returns listings not seen before', async () => {
    const w = store.upsertWatch({ query: 'rtx' });
    store.markSeen(w.id, ['1']);
    const r = await checkWatch(w, { store, fetchListings: async () => page(raw('1', 'RTX a'), raw('2', 'RTX b')) });
    expect(r.found.map((f) => f.id)).toEqual(['2']);
    expect(r.seeded).toBe(false);
  });

  it('marks filtered-out listings as seen so they are not re-evaluated', async () => {
    const w = store.upsertWatch({ query: 'rtx -broken' });
    store.markSeen(w.id, []);
    const r = await checkWatch(w, { store, fetchListings: async () => page(raw('9', 'RTX broken')) });
    expect(r.found).toEqual([]);
    expect(store.isSeen(w.id, '9')).toBe(true);
  });

  it('reports blocked pages without touching seen history', async () => {
    const w = store.upsertWatch({ query: 'rtx' });
    const r = await checkWatch(w, { store, fetchListings: async () => ({ status: 'blocked', listings: [] }) });
    expect(r.status).toBe('blocked');
    expect(store.hasSeenAny(w.id)).toBe(false);
  });

  it('sends the right URL for the watch', async () => {
    const w = store.upsertWatch({ query: 'lego -used', maxPrice: 80 });
    const fetchListings = vi.fn().mockResolvedValue(page());
    await checkWatch(w, { store, fetchListings });
    expect(fetchListings.mock.calls[0][0]).toContain('_udhi=80');
    expect(fetchListings.mock.calls[0][0]).toContain('_sop=10');
  });
});

describe('runCycle', () => {
  const deps = (over = {}) => ({
    store,
    fetchListings: async () => page(),
    sendDiscord: vi.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    notifyDesktop: vi.fn(),
    sleep: vi.fn().mockResolvedValue(),
    rng: () => 0.5,
    ...over,
  });

  it('does not alert on a search’s first check (no notification flood)', async () => {
    store.updateSettings({ webhookUrl: HOOK });
    store.upsertWatch({ query: 'rtx' });
    const d = deps({ fetchListings: async () => page(raw('1', 'RTX')) });
    await runCycle(d);
    expect(d.sendDiscord).not.toHaveBeenCalled();
  });

  it('alerts Discord on new matches after the first check', async () => {
    store.updateSettings({ webhookUrl: HOOK });
    const w = store.upsertWatch({ query: 'rtx' });
    store.markSeen(w.id, ['1']);
    const d = deps({ fetchListings: async () => page(raw('1', 'RTX old'), raw('2', 'RTX new')) });
    const out = await runCycle(d);
    expect(out.totalFound).toBe(1);
    expect(d.sendDiscord).toHaveBeenCalledTimes(1);
    const [url, payloads] = d.sendDiscord.mock.calls[0];
    expect(url).toBe(HOOK);
    expect(payloads[0].embeds[0].title).toBe('RTX new');
    expect(d.notifyDesktop).toHaveBeenCalled();
    expect(store.state.matches[0].id).toBe('2');
  });

  it('uses a search’s own webhook when set', async () => {
    store.updateSettings({ webhookUrl: HOOK });
    const own = HOOK.replace('123456789012345678', '999999999999999999');
    const w = store.upsertWatch({ query: 'rtx', webhookUrl: own });
    store.markSeen(w.id, []);
    const d = deps({ fetchListings: async () => page(raw('5', 'RTX')) });
    await runCycle(d);
    expect(d.sendDiscord.mock.calls[0][0]).toBe(own);
  });

  it('skips disabled searches', async () => {
    store.upsertWatch({ query: 'rtx', enabled: false });
    const fetchListings = vi.fn().mockResolvedValue(page());
    await runCycle(deps({ fetchListings }));
    expect(fetchListings).not.toHaveBeenCalled();
  });

  it('pauses randomly between searches', async () => {
    store.upsertWatch({ query: 'a' });
    store.upsertWatch({ query: 'b' });
    store.upsertWatch({ query: 'c' });
    const d = deps();
    await runCycle(d);
    expect(d.sleep).toHaveBeenCalledTimes(2);
    const ms = d.sleep.mock.calls[0][0];
    expect(ms).toBeGreaterThanOrEqual(8000);
    expect(ms).toBeLessThanOrEqual(25000);
  });

  it('stops the cycle and reports failure when eBay blocks', async () => {
    store.upsertWatch({ query: 'a' });
    store.upsertWatch({ query: 'b' });
    const fetchListings = vi.fn().mockResolvedValue({ status: 'blocked', listings: [] });
    const out = await runCycle(deps({ fetchListings }));
    expect(out.failed).toBe(true);
    expect(fetchListings).toHaveBeenCalledTimes(1);
    expect(store.state.log[0].level).toBe('warn');
  });

  it('keeps going when one search throws', async () => {
    store.upsertWatch({ query: 'a' });
    const b = store.upsertWatch({ query: 'b' });
    store.markSeen(b.id, []);
    let n = 0;
    const fetchListings = async () => {
      if (n++ === 0) throw new Error('timeout');
      return page(raw('7', 'b thing'));
    };
    const out = await runCycle(deps({ fetchListings }));
    expect(out.failed).toBe(false);
    expect(out.totalFound).toBe(1);
  });

  it('logs Discord failures', async () => {
    store.updateSettings({ webhookUrl: HOOK });
    const w = store.upsertWatch({ query: 'rtx' });
    store.markSeen(w.id, []);
    const d = deps({ fetchListings: async () => page(raw('3', 'RTX')), sendDiscord: vi.fn().mockResolvedValue({ sent: 0, failed: 1, error: 'Discord HTTP 404' }) });
    await runCycle(d);
    expect(store.state.log.some((l) => /404/.test(l.message))).toBe(true);
  });

  it('records the cycle time and each search’s status', async () => {
    const w = store.upsertWatch({ query: 'rtx' });
    await runCycle(deps({ now: () => 42 }));
    expect(store.state.lastCycleAt).toBe(42);
    expect(store.state.watches.find((x) => x.id === w.id).lastStatus).toBe('ok');
  });
});
