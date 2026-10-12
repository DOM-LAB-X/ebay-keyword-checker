'use strict';

/**
 * Extracts listings from an eBay search results document.
 *
 * This function is serialized with .toString() and run inside the hidden
 * scraper page, so it must be fully self-contained (no outer references).
 * It supports eBay's current "s-card" layout and the older "s-item" layout.
 */
function extractListings(doc) {
  var clean = function (s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  };
  var text = function (el) {
    return el ? clean(el.textContent) : '';
  };

  var result = { status: 'ok', listings: [] };
  var bodyText = doc.body ? doc.body.textContent || '' : '';
  var title = doc.title || '';

  if (/Pardon Our Interruption|Security Measure|verify yourself/i.test(title + ' ' + bodyText.slice(0, 4000)) &&
      !doc.querySelector('ul.srp-results')) {
    result.status = 'blocked';
    return result;
  }
  if (/Error Page \| eBay/i.test(title)) {
    result.status = 'blocked';
    return result;
  }

  var list = doc.querySelector('ul.srp-results');
  if (!list) {
    var none = doc.querySelector('.srp-save-null-search, .srp-controls__count-heading');
    result.status = none ? 'ok' : 'unrecognized';
    return result;
  }

  var children = list.children;
  for (var i = 0; i < children.length; i++) {
    var li = children[i];
    var cls = li.getAttribute('class') || '';

    // eBay inserts "Results matching fewer words" below the real matches.
    if (/REWRITE_START|srp-river-answer--REWRITE/.test(cls)) break;
    if (/srp-river-answer/.test(cls) && /fewer words/i.test(text(li))) break;

    var isCard = /\bs-card\b/.test(cls);
    var isItem = /\bs-item\b/.test(cls);
    if (!isCard && !isItem) continue;

    var id = li.getAttribute('data-listingid') || '';
    var link = li.querySelector(isCard ? 'a.s-card__link' : 'a.s-item__link');
    var href = link ? link.getAttribute('href') || '' : '';
    if (!id) {
      var m = href.match(/\/itm\/(?:[^/?]+\/)?(\d{9,})/);
      if (m) id = m[1];
    }
    if (!id || !/^\d+$/.test(id)) continue;

    var titleEl = li.querySelector(isCard ? '.s-card__title' : '.s-item__title');
    var itemTitle = '';
    if (titleEl) {
      var primary = titleEl.querySelector('.su-styled-text.primary, span[role="heading"]');
      itemTitle = primary ? text(primary) : text(titleEl);
    }
    itemTitle = itemTitle
      .replace(/^New Listing\s*/i, '')
      .replace(/Opens in a new window or tab$/i, '')
      .trim();
    if (!itemTitle || /^Shop on eBay$/i.test(itemTitle)) continue;

    var priceEl = li.querySelector(isCard ? '.s-card__price' : '.s-item__price');
    var priceText = text(priceEl);

    var rows = [];
    var rowEls = li.querySelectorAll(
      isCard ? '.s-card__attribute-row' : '.s-item__details span, .s-item__shipping, .s-item__bids, .s-item__purchase-options'
    );
    for (var r = 0; r < rowEls.length; r++) rows.push(text(rowEls[r]));

    var subtitles = [];
    var subEls = li.querySelectorAll(isCard ? '.s-card__subtitle' : '.s-item__subtitle');
    for (var s = 0; s < subEls.length; s++) subtitles.push(text(subEls[s]));

    var condition = '';
    var condEl = li.querySelector('.SECONDARY_INFO');
    if (condEl) condition = text(condEl);
    else if (subtitles.length) condition = subtitles[subtitles.length - 1];

    var shippingText = '';
    var bidsText = '';
    var buyItNow = false;
    var bestOffer = false;
    var listedAt = '';
    var location = '';
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      if (!shippingText && /deliver|shipping|postage|pickup/i.test(row)) shippingText = row;
      if (!bidsText && /^\d+\s+bids?\b/i.test(row)) bidsText = row;
      if (/Buy It Now/i.test(row)) buyItNow = true;
      if (/Best Offer/i.test(row)) bestOffer = true;
      if (/^Located in /i.test(row)) location = row.replace(/^Located in /i, '');
      if (!listedAt && /^[A-Z][a-z]{2}-\d{1,2} \d{1,2}:\d{2}$/.test(row)) listedAt = row;
    }

    var img = li.querySelector(isCard ? 'img.s-card__image' : '.s-item__image-wrapper img, .s-item__image img');
    var image = img ? img.getAttribute('src') || img.getAttribute('data-src') || '' : '';
    if (/ebaystatic\.com\/rs\//.test(image)) image = '';

    result.listings.push({
      id: id,
      title: itemTitle,
      url: 'https://www.ebay.com/itm/' + id,
      priceText: priceText,
      shippingText: shippingText,
      bidsText: bidsText,
      buyItNow: buyItNow,
      bestOffer: bestOffer,
      condition: condition,
      subtitles: subtitles,
      location: location,
      listedAt: listedAt,
      image: image,
    });
  }

  return result;
}

/** "$1,234.56" -> 1234.56, "$10.00 to $20.00" -> 10, "C $5" -> 5. */
function parsePrice(textValue) {
  const s = String(textValue || '');
  const m = s.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const whole = m[1].replace(/,/g, '');
  return Number(`${whole}.${m[2] || '0'}`);
}

/** Free -> 0, "+$12.50 delivery" -> 12.5, unknown -> null. */
function parseShipping(textValue) {
  const s = String(textValue || '');
  if (!s) return null;
  if (/free/i.test(s)) return 0;
  if (/not specified/i.test(s)) return null;
  if (/pickup/i.test(s) && !/\d/.test(s)) return 0;
  return parsePrice(s);
}

/** Adds numeric fields and a listing format to a raw extracted listing. */
function enrichListing(raw) {
  const price = parsePrice(raw.priceText);
  const shipping = parseShipping(raw.shippingText);
  const isAuction = Boolean(raw.bidsText);
  return {
    ...raw,
    price,
    shipping,
    total: price == null ? null : Math.round((price + (shipping || 0)) * 100) / 100,
    format: isAuction ? 'auction' : 'buy_it_now',
  };
}

module.exports = { extractListings, parsePrice, parseShipping, enrichListing };
