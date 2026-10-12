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
