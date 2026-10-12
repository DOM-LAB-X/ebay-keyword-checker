'use strict';

const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Update flow (GitHub Releases via electron-updater):
 *  - checks 15 s after launch and every 12 hours while running
 *  - downloads in the background using blockmaps (only changed blocks)
 *  - asks the user to restart; "Later" installs automatically on next quit
 */
function setupUpdater({ autoUpdater, dialog, getWindow, onStatus = () => {}, log = () => {} }) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  let state = { status: 'idle', version: null, percent: 0 };
  let prompted = null;
  const set = (patch) => {
    state = { ...state, ...patch };
    onStatus(state);
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => set({ status: 'up-to-date' }));
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('error', (err) => {
    log(`Update check failed: ${err && err.message}`);
    set({ status: 'error' });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    set({ status: 'ready', version: info.version, percent: 100 });
    if (prompted === info.version) return;
    prompted = info.version;
    const win = getWindow();
    const opts = {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `eBay Keyword Checker ${info.version} is ready.`,
      detail: 'Restart now to finish updating. If you choose Later, it installs the next time the app restarts.',
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response === 0) installNow();
  });

  function check() {
    return autoUpdater.checkForUpdates().catch((err) => log(`Update check failed: ${err && err.message}`));
  }

  function installNow() {
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
  }

  const startTimer = setTimeout(check, 15000);
  const interval = setInterval(check, UPDATE_CHECK_INTERVAL_MS);

  return {
    check,
    installNow,
    getState: () => state,
    dispose() {
      clearTimeout(startTimer);
      clearInterval(interval);
    },
  };
}

module.exports = { setupUpdater, UPDATE_CHECK_INTERVAL_MS };
