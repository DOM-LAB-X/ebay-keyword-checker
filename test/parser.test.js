import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseHTML } from 'linkedom';
import { extractListings, parsePrice, parseShipping, enrichListing } from '../src/main/parser.js';

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'ebay-search-scard.html'), 'utf8');
const doc = (html) => parseHTML(html).document;
const live = extractListings(doc(fixture));

describe('extractListings — real eBay page (s-card layout)', () => {
  it('finds all 20 listings', () => {
    expect(live.status).toBe('ok');
    expect(live.listings).toHaveLength(20);
  });

  it('strips "New Listing" and screen-reader text from titles', () => {
    const first = live.listings[0];
    expect(first.title).toBe('MSI GeForce RTX 4090 GAMING X TRIO 24GB GDDR6X Graphics Card GPU');
  });

  it('reads id, clean url, price and shipping', () => {
    const l = enrichListing(live.listings[1]);
    expect(l.id).toBe('198708870519');
    expect(l.url).toBe('https://www.ebay.com/itm/198708870519');
    expect(l.price).toBe(1567.69);
    expect(l.shipping).toBe(170.94);
    expect(l.total).toBe(1738.63);
  });

  it('reads condition, location, listed time and image', () => {
    const l = live.listings[0];
    expect(l.condition).toBe('Brand New');
    expect(l.location).toBe('China');
    expect(l.listedAt).toBe('Oct-12 03:25');
    expect(l.image).toMatch(/^https:\/\/i\.ebayimg\.com\//);
  });

  it('detects auctions (with bids)', () => {
    const auction = live.listings.find((l) => l.id === '198708587539');
    expect(enrichListing(auction).format).toBe('auction');
  });

  it('every listing has a numeric id and a title', () => {
    for (const l of live.listings) {
      expect(l.id).toMatch(/^\d+$/);
      expect(l.title.length).toBeGreaterThan(5);
    }
  });
});

describe('extractListings — edge cases', () => {
  it('flags eBay bot-check pages as blocked', () => {
    const r = extractListings(doc('<html><head><title>Pardon Our Interruption...</title></head><body>verify</body></html>'));
    expect(r.status).toBe('blocked');
  });

  it('flags eBay error pages as blocked', () => {
    const r = extractListings(doc('<html><head><title>Error Page | eBay</title></head><body>SORRY</body></html>'));
    expect(r.status).toBe('blocked');
  });

  it('treats a no-results page as ok with zero listings', () => {
    const r = extractListings(doc('<html><body><div class="srp-save-null-search">No exact matches found</div></body></html>'));
    expect(r).toEqual({ status: 'ok', listings: [] });
  });

  it('reports unknown pages so they are not mistaken for "no new items"', () => {
    expect(extractListings(doc('<html><body><p>hello</p></body></html>')).status).toBe('unrecognized');
  });

  it('stops at "results matching fewer words"', () => {
    const html = `<ul class="srp-results">
      <li class="s-card" data-listingid="111111111111"><a class="s-card__link" href="#"></a><div class="s-card__title"><span class="su-styled-text primary">Real match</span></div></li>
      <li class="srp-river-answer srp-river-answer--REWRITE_START">Results matching fewer words</li>
      <li class="s-card" data-listingid="222222222222"><div class="s-card__title"><span class="su-styled-text primary">Loose match</span></div></li>
    </ul>`;
    const r = extractListings(doc(`<html><body>${html}</body></html>`));
    expect(r.listings.map((l) => l.id)).toEqual(['111111111111']);
  });

  it('supports the older s-item layout', () => {
    const html = `<ul class="srp-results"><li class="s-item">
      <a class="s-item__link" href="https://www.ebay.com/itm/Some-Title/334455667788?hash=x"></a>
      <div class="s-item__title"><span role="heading">New ListingOld Layout Item</span></div>
      <span class="s-item__price">$45.00</span><span class="s-item__shipping">Free shipping</span>
      <span class="SECONDARY_INFO">Pre-Owned</span></li></ul>`;
    const [l] = extractListings(doc(`<html><body>${html}</body></html>`)).listings;
    expect(l.id).toBe('334455667788');
    expect(l.title).toBe('Old Layout Item');
    expect(l.condition).toBe('Pre-Owned');
    expect(enrichListing(l).shipping).toBe(0);
  });

  it('skips "Shop on eBay" placeholder cards', () => {
    const html = `<ul class="srp-results"><li class="s-card" data-listingid="123456789012"><div class="s-card__title"><span class="su-styled-text primary">Shop on eBay</span></div></li></ul>`;
    expect(extractListings(doc(`<html><body>${html}</body></html>`)).listings).toHaveLength(0);
  });

  it('is self-contained so it can be injected into the page', () => {
    // eslint-disable-next-line no-new-func
    const injected = new Function(`return (${extractListings.toString()})`)();
    expect(injected(doc(fixture)).listings).toHaveLength(20);
  });
});

describe('parsePrice / parseShipping', () => {
  it('parses dollar amounts with commas', () => {
    expect(parsePrice('$5,148.64')).toBe(5148.64);
    expect(parsePrice('$1,000,000')).toBe(1000000);
  });

  it('uses the low end of a price range', () => {
    expect(parsePrice('$10.00 to $20.00')).toBe(10);
  });

  it('returns null when there is no number', () => {
    expect(parsePrice('See price')).toBeNull();
  });

  it('understands free, paid and unknown shipping', () => {
    expect(parseShipping('Free delivery')).toBe(0);
    expect(parseShipping('+$12.50 delivery in 2-4 days')).toBe(12.5);
    expect(parseShipping('Shipping not specified')).toBeNull();
    expect(parseShipping('')).toBeNull();
  });
});
