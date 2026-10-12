// Launches the real app with sample data and saves screenshots of each tab in
// light and dark mode. Usage: node scripts/smoke.js <outDir>
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const outDir = path.resolve(process.argv[2] || 'smoke-out');
fs.mkdirSync(outDir, { recursive: true });
const now = Date.now();
const watch = (id, name, query, extra = {}) => ({ id, name, query, minPrice: null, maxPrice: null, includeShipping: false, listingType: 'all', condition: 'any', webhookUrl: '', enabled: true, createdAt: now, lastCheckedAt: now - 4 * 60000, lastStatus: 'ok', ...extra });
const sample = {
  version: 1,
  settings: { webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz', discordMention: '', intervalMinMinutes: 12, intervalMaxMinutes: 15, launchAtStartup: true, closeToTray: true, notifyFirstCheck: false, desktopNotifications: true },
  watches: [
    watch('a', 'RTX 4090 Founders', 'rtx 4090 +(fe,founders) -broken -"for parts"', { minPrice: 900, maxPrice: 1600 }),
    watch('b', 'Lego Star Wars UCS', 'lego +ucs -minifig* -"no box"', { maxPrice: 400, listingType: 'buy_it_now' }),
    watch('c', 'Pokémon PSA 10', 'pokemon +psa +10 -lot', { condition: 'any', enabled: false }),
  ],
  seen: {},
  matches: [
    { id: '1', title: 'NVIDIA GeForce RTX 4090 Founders Edition 24GB — Excellent', url: 'https://www.ebay.com/itm/1', priceText: '$1,449.00', price: 1449, shipping: 0, condition: 'Pre-Owned', format: 'buy_it_now', watchId: 'a', watchName: 'RTX 4090 Founders', foundAt: now - 3 * 60000 },
    { id: '2', title: 'LEGO Star Wars UCS Millennium Falcon 75192 Sealed', url: 'https://www.ebay.com/itm/2', priceText: '$389.99', price: 389.99, shipping: 24.5, condition: 'Brand New', format: 'buy_it_now', watchId: 'b', watchName: 'Lego Star Wars UCS', foundAt: now - 40 * 60000 },
    { id: '3', title: 'RTX 4090 FE 24GB GDDR6X with original box', url: 'https://www.ebay.com/itm/3', priceText: '$1,210.00', price: 1210, shipping: 35, condition: 'Pre-Owned', format: 'auction', bidsText: '7 bids', watchId: 'a', watchName: 'RTX 4090 Founders', foundAt: now - 2 * 3600000 },
  ],
  log: [
    { at: now - 3 * 60000, level: 'info', message: '“RTX 4090 Founders”: 1 new match.' },
    { at: now - 60 * 60000, level: 'warn', message: 'eBay asked to slow down on “Lego Star Wars UCS”. Backing off.' },
  ],
  lastCycleAt: now - 4 * 60000,
};

for (const theme of ['light', 'dark']) {
  for (const tab of ['searches', 'matches', 'settings', 'sheet']) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ekc-smoke-'));
    fs.writeFileSync(path.join(userData, 'data.json'), JSON.stringify({ ...sample, settings: { ...sample.settings, theme } }));
    const out = path.join(outDir, `${theme}-${tab}.png`);
    const env = { ...process.env, EKC_USER_DATA: userData, EKC_SMOKE_SCREENSHOT: out };
    if (tab === 'sheet') env.EKC_SMOKE_SHEET = '1';
    else env.EKC_SMOKE_TAB = tab;
    const r = spawnSync(electron, [path.join(__dirname, '..')], { env, timeout: 30000 });
    fs.rmSync(userData, { recursive: true, force: true });
    console.log(fs.existsSync(out) ? `ok   ${out}` : `FAIL ${out} (exit ${r.status})`);
  }
}
