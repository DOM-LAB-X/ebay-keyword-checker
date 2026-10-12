import { describe, it, expect, vi } from 'vitest';
import {
  clampInterval,
  nextDelayMs,
  betweenSearchDelayMs,
  canRunManual,
  estimateRequestsPerHour,
  Scheduler,
  MAX_BACKOFF_MS,
  MANUAL_COOLDOWN_MS,
} from '../src/main/scheduler.js';

const MIN = 60 * 1000;
const settings = { intervalMinMinutes: 12, intervalMaxMinutes: 15 };

describe('interval rules', () => {
  it('never allows more than 5 cycles per hour', () => {
    expect(clampInterval(1, 2)).toEqual({ min: 12, max: 14 });
  });

  it('keeps at least 2 minutes of jitter', () => {
    expect(clampInterval(20, 20)).toEqual({ min: 20, max: 22 });
  });

  it('fixes a reversed range and bad input', () => {
    expect(clampInterval(30, 10).max).toBeGreaterThanOrEqual(30);
    expect(clampInterval('abc', null)).toEqual({ min: 12, max: 15 });
  });

  it('random delays stay inside the 12–15 minute window', () => {
    for (let i = 0; i < 500; i++) {
      const d = nextDelayMs(settings);
      expect(d).toBeGreaterThanOrEqual(12 * MIN);
      expect(d).toBeLessThanOrEqual(15 * MIN);
    }
  });

  it('delays actually vary between cycles', () => {
    const set = new Set(Array.from({ length: 20 }, () => nextDelayMs(settings)));
    expect(set.size).toBeGreaterThan(15);
  });

  it('backs off exponentially after failures and caps at 2 hours', () => {
    const rng = () => 0;
    expect(nextDelayMs(settings, 1, rng)).toBe(24 * MIN);
    expect(nextDelayMs(settings, 2, rng)).toBe(48 * MIN);
    expect(nextDelayMs(settings, 10, rng)).toBe(MAX_BACKOFF_MS);
  });

  it('pauses 8–25 seconds between searches', () => {
    expect(betweenSearchDelayMs(() => 0)).toBe(8000);
    expect(betweenSearchDelayMs(() => 1)).toBe(25000);
  });

  it('enforces a 5 minute cooldown on manual checks', () => {
    const now = 1_000_000_000;
    expect(canRunManual(null, now).ok).toBe(true);
    expect(canRunManual(now - 60 * 1000, now).ok).toBe(false);
    expect(canRunManual(now - MANUAL_COOLDOWN_MS, now).ok).toBe(true);
  });

  it('estimates requests per hour for the UI', () => {
    expect(estimateRequestsPerHour(settings, 3)).toBeCloseTo(13.3, 1);
    expect(estimateRequestsPerHour(settings, 0)).toBe(0);
  });
});

describe('Scheduler', () => {
  it('runs, then schedules the next cycle', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue({ failed: false });
    const s = new Scheduler({ run, getSettings: () => settings });
    s.scheduleNext(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.nextAt).not.toBeNull();
    s.cancel();
    vi.useRealTimers();
  });

  it('counts failures and resets on success', async () => {
    const results = [{ failed: true }, { failed: true }, { failed: false }];
    const s = new Scheduler({ run: async () => results.shift(), getSettings: () => settings, setTimer: () => 1, clearTimer: () => {} });
    await s.tick();
    await s.tick();
    expect(s.failureStreak).toBe(2);
    await s.tick();
    expect(s.failureStreak).toBe(0);
  });

  it('treats a thrown error as a failure without crashing', async () => {
    const s = new Scheduler({ run: async () => { throw new Error('boom'); }, getSettings: () => settings, setTimer: () => 1, clearTimer: () => {} });
    await s.tick();
    expect(s.failureStreak).toBe(1);
    expect(s.running).toBe(false);
  });

  it('never runs two cycles at once', async () => {
    let release;
    const run = vi.fn(() => new Promise((r) => (release = r)));
    const s = new Scheduler({ run, getSettings: () => settings, setTimer: () => 1, clearTimer: () => {} });
    const first = s.tick();
    s.tick();
    expect(run).toHaveBeenCalledTimes(1);
    release({ failed: false });
    await first;
  });

  it('pause stops scheduling; resume restarts it', () => {
    const s = new Scheduler({ run: async () => ({}), getSettings: () => settings, setTimer: () => 1, clearTimer: () => {} });
    s.pause();
    s.scheduleNext(1000);
    expect(s.nextAt).toBeNull();
    s.resume(500);
    expect(s.nextAt).not.toBeNull();
  });
});
