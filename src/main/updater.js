'use strict';

const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Turns electron-updater's long errors into one readable line, or null if it isn't a real problem. */
function friendlyUpdateError(err) {
  const msg = String((err && err.message) || err || '');
  // a release whose files are still uploading: nothing to install yet
  if (/latest\.yml|HttpError: 404|status maybe not reported, but 404/i.test(msg)) return null;
  if (/ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|net::/i.test(msg)) {
    return 'Couldn’t reach GitHub. Check your internet connection.';
  }
  if (/HttpError: (403|429)|rate limit/i.test(msg)) return 'GitHub is busy right now. Will try again later.';
  if (/sha512 checksum mismatch|signature/i.test(msg)) return 'The update download was damaged. Will retry.';
  const first = msg.split('\n')[0].replace(/\s*Headers:.*$/, '').trim();
  return first.length > 160 ? `${first.slice(0, 157)}…` : first || 'Unknown error';
}

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
  const fail = (err) => {
    const text = friendlyUpdateError(err);
    if (!text) return set({ status: 'up-to-date' });
    log(`Update check failed: ${text}`);
    set({ status: 'error' });
  };
  autoUpdater.on('error', fail);
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
    // the 'error' event already reports failures; this only prevents an unhandled rejection
    return autoUpdater.checkForUpdates().catch(() => {});
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

module.exports = { setupUpdater, friendlyUpdateError, UPDATE_CHECK_INTERVAL_MS };
