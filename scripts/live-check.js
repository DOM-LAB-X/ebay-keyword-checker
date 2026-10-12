// Runs one real check cycle against eBay inside Electron (no Discord).
// Usage: npx electron scripts/live-check.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');
const { Store } = require('../src/main/store');
const { EbayFetcher } = require('../src/main/ebay');
const { extractListings } = require('../src/main/parser');
const { parseHTML } = require('linkedom');
const { runCycle } = require('../src/main/checker');

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-live-'));
  const store = new Store(path.join(dir, 'data.json'));
  store.updateSettings({ notifyFirstCheck: true });
  store.upsertWatch({ name: 'RTX 4090 no damage', query: 'rtx 4090 +4090 -broken -parts -"box only"', minPrice: 500, maxPrice: 3000 });
  store.upsertWatch({ name: 'Lego Star Wars', query: 'lego +star +wars -minifig*', maxPrice: 200, listingType: 'buy_it_now' });
  const fetcher = new EbayFetcher({ BrowserWindow, session, extractSource: extractListings.toString(), extract: extractListings, parseHTML });
  const t0 = Date.now();
  let peak = 0;
  const memTimer = setInterval(() => {
    const total = app.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0);
    peak = Math.max(peak, total);
  }, 250);
  const out = await runCycle({
    store,
    fetchListings: async (url) => {
      const r = await fetcher.fetchListings(url);
      console.log(`fetched via=${r.via} ${r.status} http=${r.httpStatus} listings=${r.listings.length}  ${url}`);
      return r;
    },
    sendDiscord: async () => ({ sent: 0 }),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 3000))),
  });
  fetcher.close();
  await new Promise((r) => setTimeout(r, 1500));
  const idle = app.getAppMetrics().reduce((s, m) => s + m.memory.workingSetSize, 0);
  clearInterval(memTimer);
  console.log(`failed=${out.failed} found=${out.totalFound} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const m of store.state.matches.slice(0, 8)) console.log(`  [${m.watchName}] ${m.priceText} ${m.format} | ${m.title}`);
  for (const r of out.results) console.log(`  ${r.watchId.slice(0, 8)} ${r.status} scanned=${r.scanned} matched=${r.found.length}`);
  console.log(`memory: peak ${(peak / 1024).toFixed(0)} MB during check, ${(idle / 1024).toFixed(0)} MB after scraper closed`);
  store.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  app.quit();
});
