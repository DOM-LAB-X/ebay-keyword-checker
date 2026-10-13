'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const api = window.api;
  let state = null;
  let editingId = null;
  let toastTimer = null;

  if (navigator.userAgent.includes('Mac')) document.body.classList.add('mac');

  // ---------- helpers ----------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c);
    return node;
  }

  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  function money(n) {
    return n == null ? '' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
  }

  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    return new Date(ts).toLocaleDateString();
  }

  function countdown(ts) {
    const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function priceLabel(w) {
    if (w.minPrice == null && w.maxPrice == null) return null;
    const suffix = w.includeShipping ? ' incl. ship' : '';
    if (w.minPrice != null && w.maxPrice != null) return `${money(w.minPrice)}–${money(w.maxPrice)}${suffix}`;
    if (w.minPrice != null) return `≥ ${money(w.minPrice)}${suffix}`;
    return `≤ ${money(w.maxPrice)}${suffix}`;
  }

  function queryChips(parts, w) {
    const chips = [];
    for (const s of parts.search) chips.push(el('span', { class: 'chip', text: s }));
    for (const r of parts.required) chips.push(el('span', { class: 'chip plus', text: `+${r}` }));
    for (const x of parts.excluded) chips.push(el('span', { class: 'chip minus', text: `−${x}` }));
    if (w) {
      const p = priceLabel(w);
      if (p) chips.push(el('span', { class: 'chip price', text: p }));
      if (w.listingType === 'auction') chips.push(el('span', { class: 'chip', text: 'Auction' }));
      if (w.listingType === 'buy_it_now') chips.push(el('span', { class: 'chip', text: 'Buy It Now' }));
      if (w.condition !== 'any') chips.push(el('span', { class: 'chip', text: w.condition === 'new' ? 'New' : 'Used' }));
    }
    return chips;
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  }
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]');
    if (a) {
      e.preventDefault();
      showTab(a.dataset.goto);
    }
  });

  // ---------- rendering ----------
  function renderStatus() {
    const { status, watches, lastCycleAt, requestsPerHour } = state;
    const dot = $('#status-dot');
    const title = $('#status-title');
    const sub = $('#status-sub');
    const enabled = watches.filter((w) => w.enabled).length;

    dot.className = 'dot';
    if (status.running) {
      dot.classList.add('busy');
      const p = status.progress;
      const w = p && watches.find((x) => x.id === p.watchId);
      title.textContent = w ? `Checking “${w.name}”` : 'Checking…';
      sub.textContent = p ? `Search ${p.index + 1} of ${p.total}` : '';
    } else if (status.paused) {
      title.textContent = 'Paused';
      sub.textContent = 'No searches will run until you resume.';
    } else if (!enabled) {
      title.textContent = 'Ready';
      sub.textContent = 'Add a search to start watching eBay.';
    } else {
      dot.classList.add(status.failureStreak ? 'warn' : 'ok');
      title.textContent = status.nextAt ? `Next check in ${countdown(status.nextAt)}` : 'Waiting…';
      const parts = [`Last check ${ago(lastCycleAt)}`, `${enabled} active search${enabled === 1 ? '' : 'es'}`, `~${requestsPerHour} eBay requests/hr`];
      if (status.failureStreak) parts.unshift('eBay asked to slow down — backing off');
      sub.textContent = parts.join(' · ');
    }

    $('#pause-btn').textContent = status.paused ? 'Resume' : 'Pause';
    $('#check-btn').disabled = status.running || status.paused || !enabled;
  }

  function renderWatches() {
    const list = $('#watch-list');
    list.replaceChildren(
      ...state.watches.map((w) => {
        const toggle = el('input', { type: 'checkbox', class: 'switch', title: w.enabled ? 'On' : 'Off' });
        toggle.checked = w.enabled;
        toggle.addEventListener('click', (e) => e.stopPropagation());
        toggle.addEventListener('change', () => api.toggleWatch(w.id, toggle.checked));
        const busy = state.status.running;
        const checkingThis = busy && state.status.progress && state.status.progress.watchId === w.id;
        const statusText = checkingThis
          ? 'Checking…'
          : w.lastStatus === 'blocked' ? 'Slowed by eBay' : w.lastStatus === 'error' ? 'Last check failed' : `Checked ${ago(w.lastCheckedAt)}`;
        const stop = (fn) => (e) => {
          e.stopPropagation();
          fn();
        };
        const checkBtn = el('button', { class: 'btn small', text: 'Check', title: 'Check this search now', disabled: busy, onclick: stop(() => checkWatch(w.id)) });
        const editBtn = el('button', { class: 'btn small', text: 'Edit', title: 'Edit this search', onclick: stop(() => openSheet(w)) });
        return el(
          'li',
          { class: `watch clickable${w.enabled ? '' : ' disabled'}`, onclick: () => openSheet(w) },
          el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: w.name }), el('div', { class: 'chips' }, queryChips(w.parts, w))),
          el('div', { class: 'item-side' }, el('span', { class: 'muted small', text: statusText }), checkBtn, editBtn, toggle)
        );
      })
    );
    $('#watch-empty').hidden = state.watches.length > 0;
    $('#webhook-hint').hidden = Boolean(state.settings.webhookUrl) || state.watches.length === 0;
  }

  function renderMatches() {
    const list = $('#match-list');
    list.replaceChildren(
      ...state.matches.map((m) => {
        const img = m.image ? el('img', { class: 'thumb', src: m.image, alt: '', loading: 'lazy' }) : el('div', { class: 'thumb' });
        const sub = [m.watchName, m.condition, m.format === 'auction' ? m.bidsText || 'Auction' : 'Buy It Now', ago(m.foundAt)].filter(Boolean).join(' · ');
        const ship = m.shipping === 0 ? 'Free shipping' : m.shipping ? `+${money(m.shipping)} ship` : '';
        return el(
          'li',
          { class: 'clickable', onclick: () => api.openExternal(m.url), title: 'Open on eBay' },
          img,
          el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: m.title }), el('div', { class: 'item-sub', text: sub })),
          el('div', { class: 'item-side' }, el('div', {}, el('div', { class: 'price', text: m.priceText || money(m.price) }), el('div', { class: 'muted small', text: ship })))
        );
      })
    );
    $('#match-empty').hidden = state.matches.length > 0;
    $('#clear-matches').hidden = state.matches.length === 0;
  }

  let settingsFilled = false;
  function renderSettings() {
    const s = state.settings;
    if (!settingsFilled) {
      $('#set-webhook').value = s.webhookUrl;
      $('#set-mention').value = s.discordMention;
      $('#set-min').value = s.intervalMinMinutes;
      $('#set-max').value = s.intervalMaxMinutes;
      settingsFilled = true;
    }
    $('#set-desktop').checked = s.desktopNotifications;
    $('#set-firstcheck').checked = s.notifyFirstCheck;
    $('#set-startup').checked = s.launchAtStartup;
    $('#set-tray').checked = s.closeToTray;
    document.querySelectorAll('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.theme === s.theme));
    $('#set-startup').closest('.row').querySelector('span').textContent = state.platform === 'win32' ? 'Start with Windows' : 'Start at login';
    $('#rate-note').textContent = `Each cycle waits a random ${s.intervalMinMinutes}–${s.intervalMaxMinutes} minutes (at most ${Math.floor(60 / s.intervalMinMinutes)} per hour), with an 8–25 second pause between searches. Backs off automatically if eBay pushes back.`;
    $('#version').textContent = state.version;

    const u = state.update || {};
    const labels = {
      checking: 'Checking…',
      downloading: `Downloading ${u.version || ''} ${u.percent ? `(${u.percent}%)` : ''}`,
      'up-to-date': 'Up to date',
      ready: `${u.version} ready`,
      error: 'Couldn’t check',
    };
    $('#update-status').textContent = labels[u.status] || '';
    $('#update-banner').hidden = u.status !== 'ready';
    $('#update-text').textContent = `Version ${u.version} is ready to install.`;

    const log = $('#log-list');
    log.replaceChildren(
      ...state.log.map((l) =>
        el('li', {}, el('time', { text: new Date(l.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }), el('span', { class: l.level, text: l.message }))
      )
    );
  }

  function render() {
    if (!state) return;
    renderStatus();
    renderWatches();
    renderMatches();
    renderSettings();
  }

  // ---------- sheet (create/edit search) ----------
  const form = $('#sheet');
  const field = (name) => form.elements.namedItem(name);
  function openSheet(w) {
    editingId = w ? w.id : null;
    $('#sheet-title').textContent = w ? 'Edit Search' : 'New Search';
    $('#sheet-delete').hidden = !w;
    $('#sheet-error').hidden = true;
    field('name').value = w ? w.name : '';
    field('query').value = w ? w.query : '';
    field('minPrice').value = w && w.minPrice != null ? w.minPrice : '';
    field('maxPrice').value = w && w.maxPrice != null ? w.maxPrice : '';
    field('includeShipping').checked = w ? w.includeShipping : false;
    field('listingType').value = w ? w.listingType : 'all';
    field('condition').value = w ? w.condition : 'any';
    field('webhookUrl').value = w ? w.webhookUrl || '' : '';
    updatePreview();
    $('#sheet-backdrop').hidden = false;
    setTimeout(() => field('query').focus(), 30);
  }
  function closeSheet() {
    $('#sheet-backdrop').hidden = true;
  }
  function updatePreview() {
    $('#query-preview').replaceChildren(...queryChips(window.Query.describeQuery(field('query').value)));
  }
  field('query').addEventListener('input', updatePreview);
  $('#add-watch').addEventListener('click', () => openSheet(null));
  $('#sheet-cancel').addEventListener('click', closeSheet);
  $('#sheet-backdrop').addEventListener('mousedown', (e) => {
    if (e.target.id === 'sheet-backdrop') closeSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#sheet-backdrop').hidden) closeSheet();
  });
  $('#sheet-delete').addEventListener('click', async () => {
    if (!editingId) return;
    const btn = $('#sheet-delete');
    if (btn.dataset.confirm !== '1') {
      btn.dataset.confirm = '1';
      btn.textContent = 'Click again to delete';
      setTimeout(() => {
        btn.dataset.confirm = '';
        btn.textContent = 'Delete';
      }, 2500);
      return;
    }
    btn.dataset.confirm = '';
    btn.textContent = 'Delete';
    await api.deleteWatch(editingId);
    closeSheet();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const existing = editingId && state.watches.find((w) => w.id === editingId);
    const res = await api.saveWatch({
      id: editingId || undefined,
      name: field('name').value,
      query: field('query').value,
      minPrice: field('minPrice').value,
      maxPrice: field('maxPrice').value,
      includeShipping: field('includeShipping').checked,
      listingType: field('listingType').value,
      condition: field('condition').value,
      webhookUrl: field('webhookUrl').value,
      enabled: existing ? existing.enabled : true,
    });
    if (!res.ok) {
      $('#sheet-error').textContent = res.message;
      $('#sheet-error').hidden = false;
      return;
    }
    closeSheet();
    toast(existing ? 'Search updated' : 'Search added — it will run on the next check');
  });

  // ---------- actions ----------
  $('#check-btn').addEventListener('click', async () => {
    const r = await api.checkNow();
    if (!r.ok) toast(r.message);
  });
  async function checkWatch(id) {
    const r = await api.checkWatch(id);
    if (r && r.message) toast(r.message);
  }
  $('#pause-btn').addEventListener('click', () => api.togglePause());
  $('#clear-matches').addEventListener('click', () => api.clearMatches());
  $('#update-restart').addEventListener('click', () => api.installUpdate());
  $('#check-updates').addEventListener('click', async () => {
    const r = await api.checkForUpdates();
    if (!r.ok) toast(r.message);
  });

  $('#test-webhook').addEventListener('click', async () => {
    const url = $('#set-webhook').value.trim();
    await api.saveSettings({ webhookUrl: url });
    const btn = $('#test-webhook');
    btn.disabled = true;
    const r = await api.testWebhook(url);
    btn.disabled = false;
    toast(r.ok ? 'Test message sent to Discord' : r.message);
  });

  const saveField = (sel, key, read = (n) => n.value) => {
    $(sel).addEventListener('change', async (e) => {
      const res = await api.saveSettings({ [key]: read(e.target) });
      if (key.startsWith('interval')) {
        $('#set-min').value = res.settings.intervalMinMinutes;
        $('#set-max').value = res.settings.intervalMaxMinutes;
      }
    });
  };
  saveField('#set-webhook', 'webhookUrl');
  saveField('#set-mention', 'discordMention');
  saveField('#set-min', 'intervalMinMinutes', (n) => Number(n.value));
  saveField('#set-max', 'intervalMaxMinutes', (n) => Number(n.value));
  saveField('#set-desktop', 'desktopNotifications', (n) => n.checked);
  saveField('#set-firstcheck', 'notifyFirstCheck', (n) => n.checked);
  saveField('#set-startup', 'launchAtStartup', (n) => n.checked);
  saveField('#set-tray', 'closeToTray', (n) => n.checked);
  document.querySelectorAll('#theme-seg button').forEach((b) => b.addEventListener('click', () => api.saveSettings({ theme: b.dataset.theme })));

  // ---------- boot ----------
  api.onState((s) => {
    state = s;
    render();
  });
  api.getState().then((s) => {
    state = s;
    render();
  });
  // Only the countdown needs ticking; skip work while the window is hidden.
  setInterval(() => {
    if (state && !document.hidden) renderStatus();
  }, 1000);
})();
