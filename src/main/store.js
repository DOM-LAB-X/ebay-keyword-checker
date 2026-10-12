'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clampInterval } = require('./scheduler');

const SEEN_LIMIT = 3000;
const MATCH_LIMIT = 200;
const LOG_LIMIT = 200;

const DEFAULT_SETTINGS = Object.freeze({
  webhookUrl: '',
  discordMention: '',
  intervalMinMinutes: 12,
  intervalMaxMinutes: 15,
  theme: 'system', // system | light | dark
  launchAtStartup: true,
  closeToTray: true,
  notifyFirstCheck: false,
  desktopNotifications: true,
});

const LISTING_TYPES = ['all', 'auction', 'buy_it_now'];
const CONDITIONS = ['any', 'new', 'used'];

function defaultState() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    watches: [],
    seen: {}, // watchId -> [listingId, ...] newest last
    matches: [], // recent matches for the UI, newest first
    log: [],
    lastCycleAt: null,
  };
}

function priceOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

/** Validates/normalizes a watch coming from the UI. Throws on invalid input. */
function sanitizeWatch(input, existing) {
  const query = String(input.query || '').trim();
  if (!query) throw new Error('Enter at least one keyword.');
  if (query.length > 300) throw new Error('Keywords are too long (300 characters max).');
  const minPrice = priceOrNull(input.minPrice);
  const maxPrice = priceOrNull(input.maxPrice);
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new Error('Minimum price can’t be higher than maximum price.');
  }
  const webhookUrl = String(input.webhookUrl || '').trim();
  return {
    id: existing ? existing.id : input.id || crypto.randomUUID(),
    name: String(input.name || '').trim().slice(0, 80) || query.slice(0, 80),
    query,
    minPrice,
    maxPrice,
    includeShipping: Boolean(input.includeShipping),
    listingType: LISTING_TYPES.includes(input.listingType) ? input.listingType : 'all',
    condition: CONDITIONS.includes(input.condition) ? input.condition : 'any',
    webhookUrl,
    enabled: input.enabled == null ? true : Boolean(input.enabled),
    createdAt: existing ? existing.createdAt : Date.now(),
    lastCheckedAt: existing ? existing.lastCheckedAt || null : null,
    lastStatus: existing ? existing.lastStatus || null : null,
  };
}

function sanitizeSettings(input, current = DEFAULT_SETTINGS) {
  const next = { ...current };
  if ('webhookUrl' in input) next.webhookUrl = String(input.webhookUrl || '').trim();
  if ('discordMention' in input) next.discordMention = String(input.discordMention || '').trim().slice(0, 100);
  if ('intervalMinMinutes' in input || 'intervalMaxMinutes' in input) {
    const c = clampInterval(
      input.intervalMinMinutes ?? current.intervalMinMinutes,
      input.intervalMaxMinutes ?? current.intervalMaxMinutes
    );
    next.intervalMinMinutes = c.min;
    next.intervalMaxMinutes = c.max;
  }
  if ('theme' in input) next.theme = ['system', 'light', 'dark'].includes(input.theme) ? input.theme : 'system';
  for (const key of ['launchAtStartup', 'closeToTray', 'notifyFirstCheck', 'desktopNotifications']) {
    if (key in input) next[key] = Boolean(input[key]);
  }
  return next;
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = this.load();
    this.saveTimer = null;
  }

  load() {
    const base = defaultState();
    for (const candidate of [this.filePath, `${this.filePath}.bak`]) {
      try {
        const raw = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        if (!raw || typeof raw !== 'object') continue;
        return {
          ...base,
          ...raw,
          settings: sanitizeSettings(raw.settings || {}, DEFAULT_SETTINGS),
          watches: Array.isArray(raw.watches) ? raw.watches : [],
          seen: raw.seen && typeof raw.seen === 'object' ? raw.seen : {},
          matches: Array.isArray(raw.matches) ? raw.matches : [],
          log: Array.isArray(raw.log) ? raw.log : [],
        };
      } catch {
        // missing or corrupt: try the backup, then fall back to defaults
      }
    }
    return base;
  }

  /** Atomic write: temp file + rename, keeping the previous file as .bak */
  saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    if (fs.existsSync(this.filePath)) {
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
      } catch {
        // best effort
      }
    }
    fs.renameSync(tmp, this.filePath);
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 300);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /** Cancels a pending debounced save (used by tests). */
  dispose() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  get settings() {
    return this.state.settings;
  }

  updateSettings(patch) {
    this.state.settings = sanitizeSettings(patch, this.state.settings);
    this.save();
    return this.state.settings;
  }

  upsertWatch(input) {
    const idx = this.state.watches.findIndex((w) => w.id === input.id);
    const existing = idx >= 0 ? this.state.watches[idx] : null;
    const watch = sanitizeWatch(input, existing);
    if (existing) {
      // a changed query means old "seen" ids no longer describe this search
      if (existing.query !== watch.query) delete this.state.seen[watch.id];
      this.state.watches[idx] = watch;
    } else {
      this.state.watches.push(watch);
    }
    this.save();
    return watch;
  }

  removeWatch(id) {
    this.state.watches = this.state.watches.filter((w) => w.id !== id);
    delete this.state.seen[id];
    this.state.matches = this.state.matches.filter((m) => m.watchId !== id);
    this.save();
  }

  hasSeenAny(watchId) {
    return Array.isArray(this.state.seen[watchId]);
  }

  isSeen(watchId, listingId) {
    const list = this.state.seen[watchId];
    return Array.isArray(list) && list.includes(listingId);
  }

  markSeen(watchId, ids) {
    const list = Array.isArray(this.state.seen[watchId]) ? this.state.seen[watchId] : [];
    const set = new Set(list);
    for (const id of ids) {
      if (!set.has(id)) {
        set.add(id);
        list.push(id);
      }
    }
    if (list.length > SEEN_LIMIT) list.splice(0, list.length - SEEN_LIMIT);
    this.state.seen[watchId] = list;
    this.save();
  }

  addMatches(matches) {
    this.state.matches = [...matches, ...this.state.matches].slice(0, MATCH_LIMIT);
    this.save();
  }

  clearMatches() {
    this.state.matches = [];
    this.save();
  }

  addLog(level, message) {
    this.state.log.unshift({ at: Date.now(), level, message });
    if (this.state.log.length > LOG_LIMIT) this.state.log.length = LOG_LIMIT;
    this.save();
  }
}

module.exports = {
  Store,
  DEFAULT_SETTINGS,
  sanitizeWatch,
  sanitizeSettings,
  priceOrNull,
  SEEN_LIMIT,
  MATCH_LIMIT,
  LOG_LIMIT,
};
