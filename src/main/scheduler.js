'use strict';

const MIN_INTERVAL_MINUTES = 12; // never more than 5 cycles per hour
const MAX_INTERVAL_MINUTES = 120;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 2 * 60 * 60 * 1000;

function clampInterval(minMinutes, maxMinutes) {
  const num = (v) => (v === null || v === '' || v === undefined ? NaN : Number(v));
  let lo = num(minMinutes);
  let hi = num(maxMinutes);
  if (!Number.isFinite(lo)) lo = MIN_INTERVAL_MINUTES;
  if (!Number.isFinite(hi)) hi = lo + 3;
  lo = Math.min(Math.max(lo, MIN_INTERVAL_MINUTES), MAX_INTERVAL_MINUTES);
  hi = Math.min(Math.max(hi, lo), MAX_INTERVAL_MINUTES);
  if (hi - lo < 2) hi = Math.min(lo + 2, MAX_INTERVAL_MINUTES); // always keep some jitter
  return { min: lo, max: hi };
}

function randomBetween(lo, hi, rng = Math.random) {
  return lo + (hi - lo) * rng();
}

/**
 * Milliseconds until the next cycle. Random within the configured window, and
 * multiplied after failures (eBay blocks / network errors) up to 2 hours.
 */
function nextDelayMs(settings, failureStreak = 0, rng = Math.random) {
  const { min, max } = clampInterval(settings.intervalMinMinutes, settings.intervalMaxMinutes);
  const base = randomBetween(min, max, rng) * 60 * 1000;
  if (failureStreak <= 0) return Math.round(base);
  const factor = Math.pow(2, Math.min(failureStreak, 4));
  return Math.round(Math.min(base * factor, MAX_BACKOFF_MS));
}

/** Pause between individual searches inside one cycle (8–25 s, uneven). */
function betweenSearchDelayMs(rng = Math.random) {
  return Math.round(randomBetween(8000, 25000, rng));
}

function canRunManual(lastCycleAt, now = Date.now()) {
  if (!lastCycleAt) return { ok: true, waitMs: 0 };
  const waitMs = lastCycleAt + MANUAL_COOLDOWN_MS - now;
  return waitMs <= 0 ? { ok: true, waitMs: 0 } : { ok: false, waitMs };
}

/** Rough requests per hour, for the UI. */
function estimateRequestsPerHour(settings, searchCount) {
  const { min, max } = clampInterval(settings.intervalMinMinutes, settings.intervalMaxMinutes);
  const cyclesPerHour = 60 / ((min + max) / 2);
  return Math.round(cyclesPerHour * searchCount * 10) / 10;
}

/** A tiny timer wrapper so the main process only ever holds one pending timer. */
class Scheduler {
  constructor({ run, getSettings, rng = Math.random, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now }) {
    this.run = run;
    this.getSettings = getSettings;
    this.rng = rng;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.now = now;
    this.timer = null;
    this.nextAt = null;
    this.failureStreak = 0;
    this.running = false;
    this.paused = false;
  }

  scheduleNext(delayMs) {
    this.cancel();
    if (this.paused) return;
    const ms = delayMs != null ? delayMs : nextDelayMs(this.getSettings(), this.failureStreak, this.rng);
    this.nextAt = this.now() + ms;
    this.timer = this.setTimer(() => this.tick(), ms);
  }

  cancel() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAt = null;
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    this.timer = null;
    this.nextAt = null;
    try {
      const outcome = await this.run();
      this.failureStreak = outcome && outcome.failed ? this.failureStreak + 1 : 0;
    } catch {
      this.failureStreak += 1;
    } finally {
      this.running = false;
      this.scheduleNext();
    }
  }

  pause() {
    this.paused = true;
    this.cancel();
  }

  resume(initialDelayMs) {
    this.paused = false;
    this.scheduleNext(initialDelayMs);
  }
}

module.exports = {
  MIN_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MANUAL_COOLDOWN_MS,
  MAX_BACKOFF_MS,
  clampInterval,
  nextDelayMs,
  betweenSearchDelayMs,
  canRunManual,
  estimateRequestsPerHour,
  Scheduler,
};
