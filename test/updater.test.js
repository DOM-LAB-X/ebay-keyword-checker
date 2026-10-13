import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { setupUpdater, UPDATE_CHECK_INTERVAL_MS } from '../src/main/updater.js';

function fakeUpdater() {
  const u = new EventEmitter();
  u.checkForUpdates = vi.fn().mockResolvedValue({});
  u.quitAndInstall = vi.fn();
  return u;
}

let handle;
afterEach(() => {
  handle && handle.dispose();
  vi.useRealTimers();
});

describe('auto updates', () => {
  it('checks every 12 hours', () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('downloads in the background and installs on quit if postponed', () => {
    const autoUpdater = fakeUpdater();
    handle = setupUpdater({ autoUpdater, dialog: { showMessageBox: vi.fn() }, getWindow: () => null });
    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('checks shortly after launch and then on the 12 hour interval', async () => {
    vi.useFakeTimers();
    const autoUpdater = fakeUpdater();
    handle = setupUpdater({ autoUpdater, dialog: { showMessageBox: vi.fn() }, getWindow: () => null });
    await vi.advanceTimersByTimeAsync(15000);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('asks to restart when an update is downloaded, and installs on "Restart Now"', async () => {
    const autoUpdater = fakeUpdater();
    const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }) };
    handle = setupUpdater({ autoUpdater, dialog, getWindow: () => null });
    autoUpdater.emit('update-downloaded', { version: '1.2.0' });
    await new Promise((r) => setTimeout(r, 10));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(dialog.showMessageBox.mock.calls[0][0].message).toContain('1.2.0');
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('"Later" does not restart, and the same version is not asked about twice', async () => {
    const autoUpdater = fakeUpdater();
    const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }) };
    handle = setupUpdater({ autoUpdater, dialog, getWindow: () => null });
    autoUpdater.emit('update-downloaded', { version: '1.2.0' });
    autoUpdater.emit('update-downloaded', { version: '1.2.0' });
    await new Promise((r) => setTimeout(r, 10));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports status changes to the UI', () => {
    const autoUpdater = fakeUpdater();
    const onStatus = vi.fn();
    handle = setupUpdater({ autoUpdater, dialog: { showMessageBox: vi.fn() }, getWindow: () => null, onStatus });
    autoUpdater.emit('update-available', { version: '2.0.0' });
    autoUpdater.emit('download-progress', { percent: 42.4 });
    expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'downloading', version: '2.0.0', percent: 42 }));
  });

  it('survives update errors without throwing', () => {
    const autoUpdater = fakeUpdater();
    const log = vi.fn();
    handle = setupUpdater({ autoUpdater, dialog: { showMessageBox: vi.fn() }, getWindow: () => null, log });
    autoUpdater.emit('error', new Error('no internet'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no internet'));
    expect(handle.getState().status).toBe('error');
  });
});

import { friendlyUpdateError } from '../src/main/updater.js';

describe('friendlyUpdateError', () => {
  const raw404 = 'Cannot find latest.yml in the latest release artifacts (https://github.com/DOM-LAB-X/ebay-keyword-checker/releases/download/v1.0.1/latest.yml): HttpError: 404 "method: GET url: ..."\n\nPlease double check that your authentication token is correct. Headers: { "server": "github.com" }';

  it('treats a release that is still uploading as "nothing to install yet"', () => {
    expect(friendlyUpdateError(new Error(raw404))).toBeNull();
  });

  it('explains network problems in plain words', () => {
    expect(friendlyUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/internet connection/);
    expect(friendlyUpdateError(new Error('getaddrinfo ENOTFOUND github.com'))).toMatch(/internet connection/);
  });

  it('explains GitHub rate limits', () => {
    expect(friendlyUpdateError(new Error('HttpError: 403 rate limit exceeded'))).toMatch(/busy/);
  });

  it('keeps unknown errors to one short line without headers or stack', () => {
    const out = friendlyUpdateError(new Error(`Something odd ${'x'.repeat(300)} Headers: {"a":1}\n    at foo (bar.js:1:1)`));
    expect(out).not.toMatch(/\n|Headers|at foo/);
    expect(out.length).toBeLessThanOrEqual(160);
  });
});

describe('update errors in the app', () => {
  it('shows "up to date" instead of an error while a release is still uploading', async () => {
    const { EventEmitter } = await import('events');
    const { setupUpdater } = await import('../src/main/updater.js');
    const au = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn().mockResolvedValue() });
    const log = vi.fn();
    const h = setupUpdater({ autoUpdater: au, dialog: { showMessageBox: vi.fn() }, getWindow: () => null, log });
    au.emit('error', new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404'));
    expect(log).not.toHaveBeenCalled();
    expect(h.getState().status).toBe('up-to-date');
    h.dispose();
  });

  it('logs a failed check only once', async () => {
    const { EventEmitter } = await import('events');
    const { setupUpdater } = await import('../src/main/updater.js');
    const au = new EventEmitter();
    au.checkForUpdates = vi.fn(async () => {
      const err = new Error('getaddrinfo ENOTFOUND github.com');
      au.emit('error', err);
      throw err;
    });
    const log = vi.fn();
    const h = setupUpdater({ autoUpdater: au, dialog: { showMessageBox: vi.fn() }, getWindow: () => null, log });
    await h.check();
    expect(log).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});
