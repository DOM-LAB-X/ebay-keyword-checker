import { describe, it, expect, vi } from 'vitest';
import { isValidWebhook, listingEmbed, buildPayloads, sendPayloads } from '../src/main/discord.js';

const HOOK = 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123';
const listing = (i = 0, extra = {}) => ({
  id: String(100000000000 + i),
  title: `Item ${i}`,
  url: `https://www.ebay.com/itm/${100000000000 + i}`,
  priceText: '$10.00',
  price: 10,
  shipping: 5,
  total: 15,
  condition: 'Pre-Owned',
  format: 'buy_it_now',
  image: 'https://i.ebayimg.com/images/g/x/s-l500.webp',
  foundAt: 1700000000000,
  ...extra,
});
const res = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
const noSleep = () => Promise.resolve();

describe('isValidWebhook', () => {
  it('accepts discord and discordapp webhook urls', () => {
    expect(isValidWebhook(HOOK)).toBe(true);
    expect(isValidWebhook(HOOK.replace('discord.com', 'discordapp.com'))).toBe(true);
    expect(isValidWebhook(HOOK.replace('discord.com', 'ptb.discord.com'))).toBe(true);
  });

  it('rejects other urls', () => {
    expect(isValidWebhook('https://example.com/api/webhooks/1/2')).toBe(false);
    expect(isValidWebhook('http://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(isValidWebhook('')).toBe(false);
  });
});

describe('payloads', () => {
  it('builds a rich embed with price, shipping and link', () => {
    const e = listingEmbed(listing(), 'My Search');
    expect(e.title).toBe('Item 0');
    expect(e.url).toBe('https://www.ebay.com/itm/100000000000');
    expect(e.thumbnail.url).toMatch(/ebayimg/);
    const names = e.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Price', 'Shipping', 'Total', 'Condition', 'Format']));
    expect(e.footer.text).toContain('My Search');
  });

  it('truncates long titles to Discord’s 256 character limit', () => {
    expect(listingEmbed(listing(0, { title: 'x'.repeat(400) }), 'w').title.length).toBe(256);
  });

  it('batches at most 10 embeds per message', () => {
    const payloads = buildPayloads(Array.from({ length: 23 }, (_, i) => listing(i)), 'w');
    expect(payloads.map((p) => p.embeds.length)).toEqual([10, 10, 3]);
  });

  it('adds the mention only to the first message', () => {
    const payloads = buildPayloads(Array.from({ length: 12 }, (_, i) => listing(i)), 'w', { mention: '@everyone' });
    expect(payloads[0].content.startsWith('@everyone')).toBe(true);
    expect(payloads[1].content.includes('@everyone')).toBe(false);
  });
});

describe('sendPayloads', () => {
  it('posts JSON to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(204));
    const r = await sendPayloads(HOOK, [{ content: 'hi' }], { fetchImpl, sleep: noSleep });
    expect(r).toEqual({ sent: 1, failed: 0 });
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ content: 'hi' });
  });

  it('waits for retry_after on 429 then succeeds', async () => {
    const sleep = vi.fn(noSleep);
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(429, { retry_after: 1.5 })).mockResolvedValueOnce(res(204));
    const r = await sendPayloads(HOOK, [{ content: 'a' }], { fetchImpl, sleep });
    expect(r.sent).toBe(1);
    expect(sleep).toHaveBeenCalledWith(1500);
  });

  it('retries server errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(204));
    expect((await sendPayloads(HOOK, [{}], { fetchImpl, sleep: noSleep })).sent).toBe(1);
  });

  it('retries network errors, then reports failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const r = await sendPayloads(HOOK, [{}, {}], { fetchImpl, sleep: noSleep, maxRetries: 2 });
    expect(r.sent).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.error).toMatch(/offline/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a bad webhook (404)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, { message: 'Unknown Webhook' }));
    const r = await sendPayloads(HOOK, [{}], { fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/404/);
  });

  it('spaces out multiple messages', async () => {
    const sleep = vi.fn(noSleep);
    const fetchImpl = vi.fn().mockResolvedValue(res(204));
    await sendPayloads(HOOK, [{}, {}, {}], { fetchImpl, sleep });
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
