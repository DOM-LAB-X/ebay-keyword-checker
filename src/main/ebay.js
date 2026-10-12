'use strict';

const { parseQuery, buildSearchText } = require('./query');

const CONDITION_CODES = { new: '1000', used: '3000' };

/** Builds a "newly listed first" eBay search URL for a watch. */
function buildSearchUrl(watch) {
  const parsed = parseQuery(watch.query);
  const params = new URLSearchParams();
  params.set('_nkw', buildSearchText(parsed));
  params.set('_sop', '10'); // Time: newly listed
  params.set('_ipg', '60');

  const min = toNumber(watch.minPrice);
  const max = toNumber(watch.maxPrice);
  // eBay's price filter ignores shipping, so only the upper bound is safe to
  // send when the user filters on price + shipping.
  if (min != null && !watch.includeShipping) params.set('_udlo', String(min));
  if (max != null) params.set('_udhi', String(max));

  if (watch.listingType === 'auction') params.set('LH_Auction', '1');
  if (watch.listingType === 'buy_it_now') params.set('LH_BIN', '1');
  if (CONDITION_CODES[watch.condition]) params.set('LH_ItemCondition', CONDITION_CODES[watch.condition]);

  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

function toNumber(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Upgrade-Insecure-Requests': '1',
};

/** Removes the parts of an eBay page we never read, so parsing stays cheap. */
function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Parses raw eBay HTML into { status, listings } using the shared extractor. */
function parseSearchHtml(html, { parseHTML, extract }) {
  const { document } = parseHTML(stripHtml(html));
  return extract(document);
}

/**
 * Fetches eBay search pages through Chromium's own network stack
 * (session.fetch). eBay rejects ordinary HTTP clients with a 403, but this
 * looks like a real Chrome browser and shares a persistent cookie jar, while
 * using no renderer at all (~150 MB total instead of >1 GB for a page load).
 *
 * If eBay ever answers with a bot challenge, it falls back to loading the page
 * once in a hidden window (images/fonts/media blocked), which solves the
 * challenge and stores the cookie; then it goes back to the light path.
 */
class EbayFetcher {
  constructor({ BrowserWindow, session, extractSource, extract, parseHTML, timeoutMs = 45000 }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session.fromPartition('persist:ebay');
    this.extractSource = extractSource;
    this.extract = extract;
    this.parseHTML = parseHTML;
    this.timeoutMs = timeoutMs;
    this.win = null;

    this.userAgent = this.session.getUserAgent().replace(/\s?Electron\/\S+/, '').replace(/\s?ebay-keyword-checker\/\S+/i, '');
    this.session.setUserAgent(this.userAgent, 'en-US,en');
    this.session.webRequest.onBeforeRequest((details, cb) => {
      const blocked = details.resourceType === 'image' || details.resourceType === 'font' || details.resourceType === 'media';
      cb({ cancel: blocked });
    });
  }

  async fetchListings(url) {
    let res;
    try {
      res = await this.session.fetch(url, { headers: { ...BROWSER_HEADERS, 'User-Agent': this.userAgent }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`Network error: ${err.message}`);
    }
    if (res.status === 200) {
      const html = await res.text();
      const parsed = parseSearchHtml(html, { parseHTML: this.parseHTML, extract: this.extract });
      if (parsed.status === 'ok') return { ...parsed, httpStatus: 200, via: 'fetch' };
    } else if (res.status === 429) {
      return { status: 'blocked', listings: [], httpStatus: 429, via: 'fetch' };
    } else {
      await res.arrayBuffer().catch(() => {});
    }
    // Challenge, 403, or unexpected page: let a real page load handle it.
    try {
      return { ...(await this.loadInWindow(url)), via: 'window' };
    } finally {
      this.close();
    }
  }

  open() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new this.BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        session: this.session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    this.win.webContents.setAudioMuted(true);
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return this.win;
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  async loadInWindow(url) {
    const win = this.open();
    let httpStatus = 0;
    const onNav = (_e, _url, code) => {
      httpStatus = code;
    };
    win.webContents.on('did-navigate', onNav);
    try {
      await win.loadURL(url).catch((err) => {
        // ERR_ABORTED happens when eBay's challenge page redirects; that's fine.
        if (!/ERR_ABORTED/.test(String(err && err.message))) throw err;
      });

      const deadline = Date.now() + this.timeoutMs;
      const probe = `(${this.extractSource})(document)`;
      let last = { status: 'unrecognized', listings: [] };
      while (Date.now() < deadline) {
        if (win.isDestroyed()) throw new Error('Scraper window closed');
        const current = win.webContents.getURL();
        if (!/splashui\/challenge/.test(current) && !win.webContents.isLoading()) {
          last = await win.webContents.executeJavaScript(probe, true);
          if (last.status === 'ok' || last.status === 'blocked') break;
        }
        await delay(750);
      }
      return { ...last, httpStatus };
    } finally {
      if (!win.isDestroyed()) win.webContents.removeListener('did-navigate', onNav);
    }
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { buildSearchUrl, EbayFetcher, toNumber, stripHtml, parseSearchHtml };
