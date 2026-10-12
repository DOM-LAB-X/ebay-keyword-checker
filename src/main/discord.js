'use strict';

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?(?:discord|discordapp)\.com\/api\/webhooks\/\d{5,}\/[\w-]{20,}\/?$/;
const MAX_EMBEDS_PER_MESSAGE = 10;
const EMBED_COLOR = 0x0a84ff;

function isValidWebhook(url) {
  return WEBHOOK_RE.test(String(url || '').trim());
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function money(n) {
  if (n == null) return null;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function listingEmbed(listing, watchName) {
  const fields = [];
  const price = listing.priceText || money(listing.price) || 'Unknown';
  fields.push({ name: 'Price', value: truncate(price, 100), inline: true });
  const ship = listing.shipping === 0 ? 'Free' : listing.shipping != null ? money(listing.shipping) : listing.shippingText || 'Not specified';
  fields.push({ name: 'Shipping', value: truncate(ship, 100), inline: true });
  if (listing.total != null && listing.shipping) fields.push({ name: 'Total', value: money(listing.total), inline: true });
  if (listing.condition) fields.push({ name: 'Condition', value: truncate(listing.condition, 100), inline: true });
  const format =
    listing.format === 'auction'
      ? `Auction${listing.bidsText ? ` · ${listing.bidsText}` : ''}${listing.buyItNow ? ' · Buy It Now' : ''}`
      : `Buy It Now${listing.bestOffer ? ' · Best Offer' : ''}`;
  fields.push({ name: 'Format', value: format, inline: true });
  if (listing.location) fields.push({ name: 'Location', value: truncate(listing.location, 100), inline: true });

  const embed = {
    title: truncate(listing.title, 256),
    url: listing.url,
    color: EMBED_COLOR,
    fields,
    footer: { text: truncate(`${watchName} · eBay Keyword Checker`, 2048) },
    timestamp: new Date(listing.foundAt || Date.now()).toISOString(),
  };
  if (listing.image) embed.thumbnail = { url: listing.image };
  return embed;
}

/** Groups listings into webhook payloads of at most 10 embeds. */
function buildPayloads(listings, watchName, { mention = '' } = {}) {
  const payloads = [];
  for (let i = 0; i < listings.length; i += MAX_EMBEDS_PER_MESSAGE) {
    const chunk = listings.slice(i, i + MAX_EMBEDS_PER_MESSAGE);
    const payload = {
      username: 'eBay Keyword Checker',
      embeds: chunk.map((l) => listingEmbed(l, watchName)),
      allowed_mentions: { parse: ['everyone', 'roles', 'users'] },
    };
    const header = `**${chunk.length} new listing${chunk.length === 1 ? '' : 's'}** for *${truncate(watchName, 80)}*`;
    payload.content = mention && i === 0 ? `${mention} ${header}` : header;
    payloads.push(payload);
  }
  return payloads;
}

/**
 * Sends payloads one at a time. Honors Discord's 429 retry_after and retries
 * transient 5xx/network errors. Returns { sent, failed, error? }.
 */
async function sendPayloads(webhookUrl, payloads, { fetchImpl = globalThis.fetch, sleep = defaultSleep, maxRetries = 3 } = {}) {
  let sent = 0;
  for (const payload of payloads) {
    let attempt = 0;
    for (;;) {
      let res;
      try {
        res = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        if (attempt++ < maxRetries) {
          await sleep(1000 * attempt);
          continue;
        }
        return { sent, failed: payloads.length - sent, error: `Network error: ${err.message}` };
      }

      if (res.status === 429) {
        let wait = 1000;
        try {
          const body = await res.json();
          if (body && body.retry_after != null) wait = Math.ceil(Number(body.retry_after) * 1000);
        } catch {
          const h = res.headers && res.headers.get && res.headers.get('retry-after');
          if (h) wait = Math.ceil(Number(h) * 1000);
        }
        if (attempt++ < maxRetries + 2) {
          await sleep(Math.min(Math.max(wait, 250), 60000));
          continue;
        }
        return { sent, failed: payloads.length - sent, error: 'Discord rate limit' };
      }

      if (res.status >= 500 && attempt++ < maxRetries) {
        await sleep(1000 * attempt);
        continue;
      }

      if (!res.ok) {
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          // ignore
        }
        return { sent, failed: payloads.length - sent, error: `Discord HTTP ${res.status}${detail ? `: ${truncate(detail, 200)}` : ''}` };
      }

      sent++;
      // stay well under Discord's 5 requests / 2 seconds per webhook
      if (sent < payloads.length) await sleep(500);
      break;
    }
  }
  return { sent, failed: 0 };
}

function testPayload() {
  return {
    username: 'eBay Keyword Checker',
    content: '✅ Webhook connected. New eBay listings that match your searches will appear here.',
  };
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { isValidWebhook, listingEmbed, buildPayloads, sendPayloads, testPayload, MAX_EMBEDS_PER_MESSAGE };
