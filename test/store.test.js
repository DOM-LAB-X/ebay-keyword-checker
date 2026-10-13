import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Store, sanitizeWatch, sanitizeSettings, priceOrNull, SEEN_LIMIT, MATCH_LIMIT } from '../src/main/store.js';

let dir;
let file;
let made = [];
const RealStore = Store;
const make = (f) => {
  const s = new RealStore(f);
  made.push(s);
  return s;
};
beforeEach(() => {
  made = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-'));
  file = path.join(dir, 'data.json');
});
afterEach(() => {
  made.forEach((s) => s.dispose());
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('sanitizeWatch', () => {
  it('requires keywords', () => {
    expect(() => sanitizeWatch({ query: '   ' })).toThrow(/keyword/i);
  });

  it('rejects min price above max price', () => {
    expect(() => sanitizeWatch({ query: 'x', minPrice: 50, maxPrice: 10 })).toThrow(/price/i);
  });

  it('fills sensible defaults', () => {
    const w = sanitizeWatch({ query: 'lego star wars' });
    expect(w).toMatchObject({ name: 'lego star wars', listingType: 'all', condition: 'any', enabled: true, minPrice: null, maxPrice: null });
    expect(w.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('parses prices typed with $ and commas', () => {
    expect(priceOrNull('$1,250.5')).toBe(1250.5);
    expect(priceOrNull('')).toBeNull();
    expect(priceOrNull('-5')).toBeNull();
  });

  it('rejects unknown enum values', () => {
    const w = sanitizeWatch({ query: 'x', listingType: 'hack', condition: 'weird' });
    expect(w.listingType).toBe('all');
    expect(w.condition).toBe('any');
  });
});

describe('sanitizeSettings', () => {
  it('clamps the check interval to safe values', () => {
    const s = sanitizeSettings({ intervalMinMinutes: 1, intervalMaxMinutes: 1 });
    expect(s.intervalMinMinutes).toBe(12);
    expect(s.intervalMaxMinutes).toBe(14);
  });

  it('only accepts known themes', () => {
    expect(sanitizeSettings({ theme: 'dark' }).theme).toBe('dark');
    expect(sanitizeSettings({ theme: 'neon' }).theme).toBe('system');
  });
});

describe('Store', () => {
  it('starts with defaults when no file exists', () => {
    const s = make(file);
    expect(s.state.watches).toEqual([]);
    expect(s.settings.intervalMinMinutes).toBe(12);
  });

  it('persists and reloads data', () => {
    const s = make(file);
    s.upsertWatch({ query: 'pokemon +psa' });
    s.updateSettings({ webhookUrl: 'https://discord.com/api/webhooks/1/abc' });
    s.saveNow();
    const again = make(file);
    expect(again.state.watches[0].query).toBe('pokemon +psa');
    expect(again.settings.webhookUrl).toContain('discord.com');
  });

  it('recovers from a corrupt file using the backup', () => {
    const s = make(file);
    s.upsertWatch({ query: 'first' });
    s.saveNow();
    s.upsertWatch({ query: 'second' });
    s.saveNow(); // .bak now holds the "first" state
    fs.writeFileSync(file, '{ not json');
    const again = make(file);
    expect(again.state.watches.map((w) => w.query)).toEqual(['first']);
  });

  it('falls back to defaults if everything is corrupt', () => {
    fs.writeFileSync(file, 'garbage');
    expect(make(file).state.watches).toEqual([]);
  });

  it('tracks seen listings and caps the history', () => {
    const s = make(file);
    expect(s.hasSeenAny('w')).toBe(false);
    s.markSeen('w', ['1', '2', '2']);
    expect(s.state.seen.w).toEqual(['1', '2']);
    expect(s.isSeen('w', '2')).toBe(true);
    s.markSeen('w', Array.from({ length: SEEN_LIMIT + 50 }, (_, i) => `n${i}`));
    expect(s.state.seen.w.length).toBe(SEEN_LIMIT);
    expect(s.isSeen('w', '1')).toBe(false);
  });

  it('resets seen history when a search’s keywords change', () => {
    const s = make(file);
    const w = s.upsertWatch({ query: 'old' });
    s.markSeen(w.id, ['1']);
    s.upsertWatch({ ...w, name: 'renamed' });
    expect(s.hasSeenAny(w.id)).toBe(true);
    s.upsertWatch({ ...w, query: 'new' });
    expect(s.hasSeenAny(w.id)).toBe(false);
  });

  it('removing a search removes its matches and history', () => {
    const s = make(file);
    const w = s.upsertWatch({ query: 'x' });
    s.markSeen(w.id, ['1']);
    s.addMatches([{ id: '1', watchId: w.id }]);
    s.removeWatch(w.id);
    expect(s.state.watches).toEqual([]);
    expect(s.state.matches).toEqual([]);
    expect(s.state.seen[w.id]).toBeUndefined();
  });

  it('keeps only the most recent matches', () => {
    const s = make(file);
    s.addMatches(Array.from({ length: MATCH_LIMIT + 20 }, (_, i) => ({ id: String(i) })));
    expect(s.state.matches.length).toBe(MATCH_LIMIT);
  });
});

describe('notified history', () => {
  it('remembers alerted listings across restarts and caps the list', async () => {
    const { Store, NOTIFIED_LIMIT } = await import('../src/main/store.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-n-'));
    const file = path.join(d, 'data.json');
    const s = new Store(file);
    s.markNotified(['a', 'b', 'a']);
    expect(s.state.notified).toEqual(['a', 'b']);
    expect(new Store(file).wasNotified('b')).toBe(true);
    s.markNotified(Array.from({ length: NOTIFIED_LIMIT + 10 }, (_, i) => `x${i}`));
    expect(s.state.notified.length).toBe(NOTIFIED_LIMIT);
    s.dispose();
    fs.rmSync(d, { recursive: true, force: true });
  });
});
