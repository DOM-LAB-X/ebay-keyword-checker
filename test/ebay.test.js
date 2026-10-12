import { describe, it, expect } from 'vitest';
import { buildSearchUrl } from '../src/main/ebay.js';

const params = (watch) => new URL(buildSearchUrl({ listingType: 'all', condition: 'any', ...watch })).searchParams;

describe('buildSearchUrl', () => {
  it('always sorts by newly listed with 60 per page', () => {
    const p = params({ query: 'lego' });
    expect(p.get('_sop')).toBe('10');
    expect(p.get('_ipg')).toBe('60');
    expect(p.get('_nkw')).toBe('lego');
  });

  it('passes min and max price', () => {
    const p = params({ query: 'lego', minPrice: 20, maxPrice: 150 });
    expect(p.get('_udlo')).toBe('20');
    expect(p.get('_udhi')).toBe('150');
  });

  it('omits the minimum when shipping is included (eBay ignores shipping)', () => {
    const p = params({ query: 'lego', minPrice: 20, maxPrice: 150, includeShipping: true });
    expect(p.get('_udlo')).toBeNull();
    expect(p.get('_udhi')).toBe('150');
  });

  it('maps listing format filters', () => {
    expect(params({ query: 'x', listingType: 'auction' }).get('LH_Auction')).toBe('1');
    expect(params({ query: 'x', listingType: 'buy_it_now' }).get('LH_BIN')).toBe('1');
  });

  it('maps condition filters', () => {
    expect(params({ query: 'x', condition: 'new' }).get('LH_ItemCondition')).toBe('1000');
    expect(params({ query: 'x', condition: 'used' }).get('LH_ItemCondition')).toBe('3000');
    expect(params({ query: 'x' }).get('LH_ItemCondition')).toBeNull();
  });

  it('targets ebay.com search', () => {
    expect(buildSearchUrl({ query: 'x' })).toMatch(/^https:\/\/www\.ebay\.com\/sch\/i\.html\?/);
  });
});

import fs from 'fs';
import path from 'path';
import { vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { EbayFetcher, stripHtml, parseSearchHtml } from '../src/main/ebay.js';
import { extractListings } from '../src/main/parser.js';

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ebay-search-scard.html'), 'utf8');

describe('page parsing', () => {
  it('strips scripts, styles, svg and comments before parsing', () => {
    const out = stripHtml('<p>a</p><script>var x="<li>";</script><style>.a{}</style><svg><path/></svg><!-- c --><p>b</p>');
    expect(out).toBe('<p>a</p><p>b</p>');
  });

  it('parses a full page even with heavy inline scripts', () => {
    const heavy = fixture.replace('<body>', `<body><script>${'window.x="<ul class=\\"srp-results\\">";'.repeat(2000)}</script>`);
    const r = parseSearchHtml(heavy, { parseHTML, extract: extractListings });
    expect(r.status).toBe('ok');
    expect(r.listings).toHaveLength(20);
  });
});

function fakeElectron({ responses, windowResult }) {
  const fetch = vi.fn(async () => {
    const r = responses.shift();
    return { status: r.status, text: async () => r.body || '', arrayBuffer: async () => new ArrayBuffer(0) };
  });
  const ses = {
    fetch,
    getUserAgent: () => 'Mozilla/5.0 Chrome/150 Electron/44.0.0 Safari/537.36',
    setUserAgent: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  };
  const destroyed = { value: false };
  const wc = {
    on: vi.fn(),
    removeListener: vi.fn(),
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getURL: () => 'https://www.ebay.com/sch/i.html',
    isLoading: () => false,
    executeJavaScript: vi.fn(async () => windowResult),
  };
  const BrowserWindow = vi.fn(function () {
    this.webContents = wc;
    this.loadURL = vi.fn(async () => {});
    this.isDestroyed = () => destroyed.value;
    this.destroy = () => (destroyed.value = true);
  });
  return { session: { fromPartition: () => ses }, BrowserWindow, ses, wc };
}

const make = (env) => new EbayFetcher({ BrowserWindow: env.BrowserWindow, session: env.session, extractSource: extractListings.toString(), extract: extractListings, parseHTML });

describe('EbayFetcher', () => {
  it('removes "Electron" from the user agent so requests look like Chrome', () => {
    const env = fakeElectron({ responses: [] });
    make(env);
    expect(env.ses.setUserAgent.mock.calls[0][0]).not.toMatch(/Electron/);
  });

  it('uses the light network path when eBay answers normally (no window opened)', async () => {
    const env = fakeElectron({ responses: [{ status: 200, body: fixture }] });
    const r = await make(env).fetchListings('https://www.ebay.com/sch/i.html?_nkw=x');
    expect(r.via).toBe('fetch');
    expect(r.listings).toHaveLength(20);
    expect(env.BrowserWindow).not.toHaveBeenCalled();
  });

  it('falls back to a hidden window on a 403 / challenge, then closes it', async () => {
    const env = fakeElectron({ responses: [{ status: 403, body: 'denied' }], windowResult: { status: 'ok', listings: [{ id: '1' }] } });
    const f = make(env);
    const r = await f.fetchListings('https://www.ebay.com/sch/i.html?_nkw=x');
    expect(r.via).toBe('window');
    expect(r.listings).toHaveLength(1);
    expect(f.win).toBeNull();
  });

  it('treats HTTP 429 as "slow down" without opening a window', async () => {
    const env = fakeElectron({ responses: [{ status: 429 }] });
    const r = await make(env).fetchListings('https://www.ebay.com/sch/i.html?_nkw=x');
    expect(r.status).toBe('blocked');
    expect(env.BrowserWindow).not.toHaveBeenCalled();
  });
});
