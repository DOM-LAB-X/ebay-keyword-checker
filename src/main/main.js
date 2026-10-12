'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeTheme, shell, dialog, session, Notification, nativeImage } = require('electron');

const { Store } = require('./store');
const { Scheduler, canRunManual, estimateRequestsPerHour } = require('./scheduler');
const { runCycle } = require('./checker');
const { EbayFetcher } = require('./ebay');
const { extractListings } = require('./parser');
const { parseHTML } = require('linkedom');
const { sendPayloads, testPayload, isValidWebhook } = require('./discord');
const { describeQuery } = require('./query');

if (process.env.EKC_USER_DATA) app.setPath('userData', process.env.EKC_USER_DATA);

const IS_WIN = process.platform === 'win32';
const ASSETS = path.join(__dirname, '..', '..', 'build');
const startHidden = process.argv.includes('--hidden');

app.setAppUserModelId('com.domlabs.ebaykeywordchecker');
// Keep the footprint small: no GPU process for a simple UI.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

let store;
let scheduler;
let fetcher;
let updater = null;
let tray = null;
let mainWindow = null;
let quitting = false;
let progress = null;
let updateState = { status: 'idle' };
let shownTrayHint = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconPath(name) {
  return path.join(ASSETS, name);
}

function themeColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return dark
    ? { bg: '#1c1c1e', symbol: '#f5f5f7' }
    : { bg: '#f5f5f7', symbol: '#1d1d1f' };
}

function applyTheme() {
  nativeTheme.themeSource = store.settings.theme;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const c = themeColors();
    mainWindow.setBackgroundColor(c.bg);
    if (IS_WIN) {
      try {
        mainWindow.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbol, height: 44 });
      } catch {
        // not available on all platforms
      }
    }
  }
}

function createWindow() {
  const c = themeColors();
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: c.bg,
    title: 'eBay Keyword Checker',
    icon: iconPath(IS_WIN ? 'icon.ico' : 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: IS_WIN ? { color: c.bg, symbolColor: c.symbol, height: 44 } : undefined,
    trafficLightPosition: { x: 16, y: 15 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!process.env.EKC_SMOKE_SCREENSHOT) mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  mainWindow.on('close', (e) => {
    if (quitting || !store.settings.closeToTray) return;
    // Destroy instead of hide: frees the renderer's memory while in the tray.
    if (!shownTrayHint && Notification.isSupported()) {
      shownTrayHint = true;
      new Notification({ title: 'Still watching eBay', body: 'eBay Keyword Checker keeps running in the system tray.', silent: true }).show();
    }
    e.preventDefault();
    mainWindow.destroy();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!quitting && !store.settings.closeToTray) {
      quitting = true;
      app.quit();
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath(IS_WIN ? 'icon.ico' : 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('eBay Keyword Checker');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const paused = scheduler && scheduler.paused;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open eBay Keyword Checker', click: showWindow },
      { label: 'Check Now', click: () => manualCheck() },
      { label: paused ? 'Resume Checking' : 'Pause Checking', click: () => togglePause() },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ])
  );
}

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && /(^|\.)(ebay\.com|github\.com|discord\.com)$/.test(u.hostname)) shell.openExternal(u.toString());
  } catch {
    // ignore invalid urls
  }
}

function publicState() {
  const s = store.state;
  const enabledCount = s.watches.filter((w) => w.enabled).length;
  return {
    settings: s.settings,
    watches: s.watches.map((w) => ({ ...w, parts: describeQuery(w.query) })),
    matches: s.matches.slice(0, 100),
    log: s.log.slice(0, 50),
    lastCycleAt: s.lastCycleAt,
    status: {
      running: scheduler.running,
      paused: scheduler.paused,
      nextAt: scheduler.nextAt,
      failureStreak: scheduler.failureStreak,
      progress,
    },
    requestsPerHour: estimateRequestsPerHour(s.settings, enabledCount),
    version: app.getVersion(),
    update: updateState,
    platform: process.platform,
  };
}

let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state', publicState());
  }, 50);
}

function notifyDesktop(watch, found) {
  if (!Notification.isSupported()) return;
  const first = found[0];
  const n = new Notification({
    title: found.length === 1 ? `New: ${watch.name}` : `${found.length} new listings · ${watch.name}`,
    body: `${first.title}${first.priceText ? ` — ${first.priceText}` : ''}`,
    silent: false,
  });
  n.on('click', () => (found.length === 1 ? openExternal(first.url) : showWindow()));
  n.show();
}

async function cycle() {
  pushState();
  try {
    const outcome = await runCycle({
      store,
      fetchListings: (url) => fetcher.fetchListings(url),
      sendDiscord: (url, payloads) => sendPayloads(url, payloads),
      notifyDesktop,
      sleep,
      onProgress: (p) => {
        progress = p;
        pushState();
      },
    });
    return outcome;
  } finally {
    fetcher.close(); // release the scraper's renderer between cycles
    progress = null;
    pushState();
  }
}

async function manualCheck() {
  if (scheduler.running) return { ok: false, message: 'A check is already running.' };
  const gate = canRunManual(store.state.lastCycleAt);
  if (!gate.ok) {
    const mins = Math.ceil(gate.waitMs / 60000);
    return { ok: false, message: `To protect your eBay access, wait ${mins} more minute${mins === 1 ? '' : 's'}.` };
  }
  scheduler.cancel();
  scheduler.tick();
  return { ok: true };
}

function togglePause() {
  if (scheduler.paused) scheduler.resume(30000);
  else scheduler.pause();
  refreshTrayMenu();
  pushState();
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: store.settings.launchAtStartup, args: ['--hidden'] });
}

function registerIpc() {
  ipcMain.handle('state:get', () => publicState());

  ipcMain.handle('watch:save', (_e, watch) => {
    try {
      const saved = store.upsertWatch(watch);
      pushState();
      return { ok: true, watch: saved };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('watch:delete', (_e, id) => {
    store.removeWatch(id);
    pushState();
    return { ok: true };
  });

  ipcMain.handle('watch:toggle', (_e, id, enabled) => {
    const w = store.state.watches.find((x) => x.id === id);
    if (w) store.upsertWatch({ ...w, enabled });
    pushState();
    return { ok: true };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const before = store.settings;
    const next = store.updateSettings(patch || {});
    if (before.theme !== next.theme) applyTheme();
    if (before.launchAtStartup !== next.launchAtStartup) applyLoginItem();
    if (before.intervalMinMinutes !== next.intervalMinMinutes || before.intervalMaxMinutes !== next.intervalMaxMinutes) {
      if (!scheduler.running && !scheduler.paused) scheduler.scheduleNext();
    }
    pushState();
    return { ok: true, settings: next };
  });

  ipcMain.handle('check:now', () => manualCheck());
  ipcMain.handle('check:pause', () => {
    togglePause();
    return { ok: true };
  });

  ipcMain.handle('webhook:test', async (_e, url) => {
    if (!isValidWebhook(url)) return { ok: false, message: 'That doesn’t look like a Discord webhook URL.' };
    const r = await sendPayloads(url, [testPayload()]);
    return r.error ? { ok: false, message: r.error } : { ok: true };
  });

  ipcMain.handle('matches:clear', () => {
    store.clearMatches();
    pushState();
    return { ok: true };
  });

  ipcMain.handle('open:external', (_e, url) => {
    openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('update:check', () => {
    if (!updater) return { ok: false, message: 'Updates are available in the installed app.' };
    updater.check();
    return { ok: true };
  });
  ipcMain.handle('update:install', () => {
    if (updater) updater.installNow();
    return { ok: true };
  });
}

function setupAutoUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  const { setupUpdater } = require('./updater');
  updater = setupUpdater({
    autoUpdater,
    dialog,
    getWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    onStatus: (s) => {
      updateState = s;
      pushState();
    },
    log: (m) => store.addLog('warn', m),
  });
}

async function smokeScreenshot(outPath) {
  // Used by scripts/smoke.js to verify the UI renders in light and dark.
  await sleep(800);
  if (process.env.EKC_SMOKE_TAB) {
    await mainWindow.webContents.executeJavaScript(`document.querySelector('[data-tab="${process.env.EKC_SMOKE_TAB}"]').click()`);
  }
  if (process.env.EKC_SMOKE_SHEET) await mainWindow.webContents.executeJavaScript(`document.querySelector('.watch').click()`);
  await sleep(500);
  const img = await mainWindow.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  quitting = true;
  app.quit();
}

app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'data.json'));
  fetcher = new EbayFetcher({ BrowserWindow, session, extractSource: extractListings.toString(), extract: extractListings, parseHTML });
  scheduler = new Scheduler({ run: cycle, getSettings: () => store.settings });

  nativeTheme.themeSource = store.settings.theme;
  nativeTheme.on('updated', () => {
    applyTheme();
    pushState();
  });

  registerIpc();
  createTray();
  applyLoginItem();
  setupAutoUpdates();

  if (!startHidden) createWindow();
  if (process.env.EKC_SMOKE_SCREENSHOT) {
    mainWindow.webContents.once('did-finish-load', () => smokeScreenshot(process.env.EKC_SMOKE_SCREENSHOT));
    return;
  }

  // First check shortly after launch, then the jittered schedule takes over.
  scheduler.scheduleNext(20000 + Math.round(Math.random() * 20000));
  pushState();
});

app.on('before-quit', () => {
  quitting = true;
  if (store) store.saveNow();
});

// The hidden scraper window opens and closes every cycle, so never quit just
// because no windows are open. Quitting happens from the tray menu, or when the
// user closes the main window with "keep running in tray" turned off.
app.on('window-all-closed', () => {});

app.on('activate', showWindow);
