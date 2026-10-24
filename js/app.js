/*
 * Turf Cricket Pro — UI controller.
 * All cricket logic lives in engine.js; this file only renders state and records events.
 */
(function () {
  'use strict';
  const E = window.CricketEngine;

  // ---------- storage bootstrap ----------
  function memoryBackend() {
    const mem = {};
    return { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };
  }
  let storageOk = true;
  let backend;
  try {
    backend = window.localStorage;
    backend.setItem('tcp.probe', '1');
    backend.removeItem('tcp.probe');
  } catch (e) {
    storageOk = false;
    backend = memoryBackend();
  }
  const store = window.TCPStore.create(backend);

  const app = {
    match: null, // current (live) match record
    state: null, // replayed state of app.match
    sc: null, // { match, state } shown on the scorecard screen
    dirty: false,
    prevHash: location.hash || '#/',
    settings: store.getSettings(),
    statsCache: null,
  };

  // ---------- utils ----------
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const view = () => document.getElementById('view');
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const fmt2 = n => (Math.round(n * 100) / 100).toFixed(2);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const go = hash => { if (location.hash === hash) route(); else location.hash = hash; };
  function localToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function slug(s) { return String(s || 'match').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'match'; }
  function isActive(st) { return !!st && st.status !== 'complete' && st.status !== 'abandoned'; }
  function hasBalls(m) { return m.events.some(e => e.type !== 'start_innings' && e.type !== 'set_bowler'); }
  function initials(name) {
    const w = String(name || '?').trim().split(/\s+/);
    return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
  }
  // Dark text on light team colours, white text on dark ones.
  function inkFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 > 0.62 ? '#1b2236' : '#fff';
  }
  // ---------- photos ----------
  function photos() { if (!app.photos) app.photos = store.getPhotos(); return app.photos; }
  function teamPhotoKey(team) { const id = team.savedTeamId || team.id; return id ? 't:' + id : null; }
  // Team badge: the team's logo photo if one is set, otherwise initials on the team colour.
  function flag(team, cls) {
    const key = teamPhotoKey(team);
    const src = key && photos()[key];
    if (src) return `<img class="flag ${cls || ''}" src="${src}" alt="" aria-hidden="true">`;
    const c = team.color || '#0d47c5';
    return `<span class="flag ${cls || ''}" style="--c:${esc(c)};--fc:${inkFor(c)}" aria-hidden="true">${esc(initials(team.name))}</span>`;
  }
  // Player avatar: their photo, otherwise initials on a soft team-colour tint.
  function avatar(pid, name, cls, color) {
    const src = photos()[pid];
    if (src) return `<img class="ava ${cls || ''}" src="${src}" alt="" aria-hidden="true">`;
    const c = color || '#0d47c5';
    return `<span class="ava ${cls || ''}" style="--c:${esc(c)};--fc:${inkFor(c)}" aria-hidden="true">${esc(initials(name))}</span>`;
  }
  // Centre-crops an image file to a square and compresses it to a small JPEG (~6–12 KB).
  function readPhoto(file, size) {
    const px = size || 192;
    return new Promise((resolve, reject) => {
      if (!file || !/^image\//.test(file.type)) { reject(new Error('Please choose a photo (JPG or PNG).')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement('canvas');
        c.width = px; c.height = px;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read. Try a JPG or PNG.')); };
      img.src = url;
    });
  }
  // Opens the phone's camera / gallery and saves the photo under `key`. Resolves true when saved.
  function pickPhoto(key) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        try {
          const data = await readPhoto(input.files[0]);
          app.photos = store.setPhoto(key, data);
          toast('Photo saved', 'ok');
          resolve(true);
        } catch (err) { toast(err.message, 'error'); resolve(false); }
      };
      input.click();
    });
  }
  function removePhoto(key) { app.photos = store.setPhoto(key, null); toast('Photo removed'); }
  // Main (non super over) innings of a team, if it has batted.
  function teamInnings(st, ti) { return st.innings.find(i => i.started && !i.isSuper && i.battingTeam === ti) || null; }

  const ICON = {
    logo: '<svg class="brand-logo" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="14" fill="#fff"/><circle cx="24" cy="24" r="14" fill="#0d47c5"/><path d="M15 14.5c4.2 5 4.2 14 0 19M33 14.5c-4.2 5-4.2 14 0 19" fill="none" stroke="#fff" stroke-width="2.2" stroke-dasharray="2.6 2.2"/><circle cx="35" cy="13" r="4" fill="#ffad0d"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1c.5.4 1.1.7 1.7 1l.4 2.6h4l.4-2.6c.6-.3 1.2-.6 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4 9h4l5-4v14l-5-4H4z"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15.5 4 7.5 12l8 8" stroke="currentColor" stroke-width="2.6" fill="none"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M11 4h2v16h-2zM4 11h16v2H4z"/></svg>',
    share: '<svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.7l6.8-4M8.6 13.3l6.8 4" stroke="currentColor" stroke-width="2" fill="none"/></svg>',
    teams: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.8"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6zM15.5 20c0-2.2-.6-3.9-1.7-5.1.9-.6 2-.9 3.2-.9 2.9 0 4.5 2 4.5 6z"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5zm3 6v2h8V9zm0 4v2h8v-2zm0 4v2h5v-2z"/></svg>',
    stats: '<svg viewBox="0 0 24 24"><path d="M4 20V11h3.5v9zM10.25 20V5h3.5v15zM16.5 20v-6H20v6z"/></svg>',
  };

  // ---------- feedback: toast, flash, sound, vibration ----------
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    const box = document.getElementById('toasts');
    box.appendChild(el);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => el.remove(), type === 'error' ? 4200 : 2400);
  }
  let flashTimer;
  // `who` (optional) = { id, name, color } shows the player's photo and name under the text.
  function flash(text, cls, who) {
    const el = document.getElementById('flash');
    el.innerHTML = who
      ? `<span class="${cls} with-ava">${avatar(who.id, who.name, 'xl', who.color)}<b>${esc(text)}</b><small>${esc(who.name)}</small></span>`
      : `<span class="${cls}">${esc(text)}</span>`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.innerHTML = ''; }, who ? 1500 : 800);
  }
  let actx = null;
  function sound(kind) {
    if (!app.settings.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const seqs = {
        tap: [[540, 0.05]], four: [[660, 0.09], [880, 0.14]], six: [[660, 0.08], [880, 0.08], [1175, 0.18]],
        wicket: [[330, 0.14], [220, 0.26]], end: [[523, 0.12], [659, 0.12], [784, 0.26]], undo: [[420, 0.06], [340, 0.08]],
      };
      let t = actx.currentTime;
      (seqs[kind] || seqs.tap).forEach(([f, d]) => {
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'triangle'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.2, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d);
        o.connect(g); g.connect(actx.destination);
        o.start(t); o.stop(t + d + 0.02);
        t += d * 0.92;
      });
    } catch (e) { /* audio unsupported: silent */ }
  }
  function buzz(pattern) {
    // Browsers only allow vibration after a real tap on the page.
    const tapped = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (app.settings.vibrate && navigator.vibrate && tapped) { try { navigator.vibrate(pattern); } catch (e) { /* ignore */ } }
  }

  // ---------- sheet (bottom modal) ----------
  function sheet(opts) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'sheet-wrap';
      wrap.innerHTML = `<div class="sheet-backdrop" data-close></div>
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
          <div class="sheet-head"><h2 id="sheet-title">${esc(opts.title)}</h2><button class="icon-btn" data-close aria-label="Close">✕</button></div>
          <div class="sheet-body"></div>
        </div>`;
      const body = wrap.querySelector('.sheet-body');
      const prevFocus = document.activeElement;
      const on = opts.on || {};
      const api = { state: opts.state || {}, body, close, render };
      function render() { body.innerHTML = opts.render(api.state, api); if (opts.afterRender) opts.afterRender(api); }
      function close(value) {
        if (!wrap.isConnected) return;
        wrap.remove();
        document.removeEventListener('keydown', onKey);
        if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
        resolve(value);
      }
      function onKey(e) { if (e.key === 'Escape') close(); }
      wrap.addEventListener('click', e => {
        if (e.target.closest('[data-close]')) { close(); return; }
        const el = e.target.closest('[data-on]');
        if (el && !el.disabled && on[el.dataset.on]) on[el.dataset.on](el, api, e);
      });
      ['change', 'input'].forEach(type => wrap.addEventListener(type, e => {
        const el = e.target.closest(`[data-${type}]`);
        if (el && on[el.dataset[type]]) on[el.dataset[type]](el, api, e);
      }));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      render();
      if (opts.mounted) opts.mounted(api);
      const first = wrap.querySelector('[autofocus]') || wrap.querySelector('.sheet-body button:not([disabled])');
      if (first) first.focus({ preventScroll: true });
    });
  }

  function confirmDialog(message, opts) {
    const o = Object.assign({ title: 'Are you sure?', ok: 'Confirm', danger: false, typed: null }, opts);
    return sheet({
      title: o.title,
      render: () => `<p>${message}</p>
        ${o.typed ? `<label class="field"><span>Type ${esc(o.typed)} to confirm</span><input type="text" data-input="typed" autocomplete="off" autocapitalize="characters"></label>` : ''}
        <div class="sheet-actions"><button class="btn" data-close>Cancel</button>
        <button class="btn ${o.danger ? 'danger solid' : 'primary'}" data-on="ok" ${o.typed ? 'disabled' : ''}>${esc(o.ok)}</button></div>`,
      on: {
        ok: (el, api) => api.close(true),
        typed: (el, api) => { $('[data-on=ok]', api.body).disabled = el.value.trim().toUpperCase() !== o.typed.toUpperCase(); },
      },
    }).then(v => v === true);
  }

  // ---------- clipboard / files / share ----------
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) throw new Error('Copy is not supported in this browser');
    }
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function shareText(title, text) {
    if (navigator.share) {
      try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    await copyText(text);
    toast('Score copied — paste it into WhatsApp or anywhere', 'ok');
  }

  // ---------- live match state ----------
  function loadCurrent() {
    const id = store.getCurrentId();
    if (!id) { app.match = null; app.state = null; return null; }
    if (app.match && app.match.id === id) return app.match;
    const m = store.getMatch(id);
    if (!m) { store.setCurrentId(null); return null; }
    app.match = m; app.state = null;
    return m;
  }
  function currentState() {
    const m = loadCurrent();
    if (!m) return null;
    if (!app.state) app.state = E.replay(m);
    return app.state;
  }
  function liveSummary() {
    try { const st = currentState(); return isActive(st) ? st : null; } catch (e) { return null; }
  }

  // Replays the candidate event list; only saves if every event is valid.
  function commit(events) {
    const before = app.match.events;
    const m = Object.assign({}, app.match, { events, updatedAt: Date.now() });
    let st;
    try { st = E.replay(m); } catch (err) { toast(err.message, 'error'); buzz([50, 40, 50]); return null; }
    m.summary = E.summarize(st);
    try { store.saveMatch(m); } catch (err) { toast(err.message, 'error'); return null; }
    app.match = m; app.state = st; app.statsCache = null;
    if (m.live) pushLive(SYNC.diffOp(before, events));
    return st;
  }
  function saveMeta(m) {
    m.updatedAt = Date.now();
    try { store.saveMatch(m); app.statsCache = null; } catch (err) { toast(err.message, 'error'); return false; }
    if (m.live) pushLiveMeta(m);
    return true;
  }

  function addEvent(e) {
    if (!app.match) return null;
    const prev = app.state;
    const ev = Object.assign({ id: E.uid('e'), ts: Date.now() }, e);
    const st = commit(app.match.events.concat([ev]));
    if (!st) return null;
    feedback(prev, st, ev);
    renderLive();
    return st;
  }

  function feedback(prev, st, e) {
    if (st.status === 'complete' && (!prev || prev.status !== 'complete')) {
      flash(st.result.tie ? 'TIED!' : 'MATCH OVER', 'fi'); sound('end'); buzz([80, 60, 160]);
      return;
    }
    if (prev && st.current !== prev.current) {
      flash(st.innings[st.current].isSuper ? 'SUPER OVER' : 'INNINGS BREAK', 'fi'); sound('end'); buzz([80, 60, 80]);
      return;
    }
    if (e.type !== 'ball') { sound('tap'); buzz(12); return; }
    const batBoundary = e.boundary !== false && (e.kind === 'normal' || (e.kind === 'nb' && (e.nbType || 'bat') === 'bat'));
    if (e.wicket) { flash('OUT!', 'fw'); sound('wicket'); buzz([120, 60, 120]); }
    else if (batBoundary && e.runs === 6) { flash('SIX!', 'f6'); sound('six'); buzz([30, 40, 30]); }
    else if (batBoundary && e.runs === 4) { flash('FOUR!', 'f4'); sound('four'); buzz(30); }
    else { sound('tap'); buzz(12); }
    const inn = st.innings[st.current];
    const legal = e.kind === 'normal' || e.kind === 'b' || e.kind === 'lb';
    if (legal && st.status === 'live' && inn.legalBalls > 0 && inn.legalBalls % 6 === 0 && !e.wicket) {
      toast(`End of over ${inn.legalBalls / 6} — ${inn.runs}/${inn.wickets}`);
    }
    if (prev && prev.current === st.current) {
      const m = milestone(prev.innings[st.current], inn, st);
      if (m) setTimeout(() => { flash(m.text, 'fm', m.who); sound('end'); buzz([60, 40, 60, 40, 120]); }, 820);
    }
  }

  // Detects a milestone reached on the last delivery: 50/100, 3-fer/5-fer, hat-trick, maiden.
  function milestone(before, inn, st) {
    const d = inn.deliveries[inn.deliveries.length - 1];
    if (!d || before.deliveries.length === inn.deliveries.length) return null;
    const color = st.config.teams[inn.battingTeam].color;
    const bcolor = st.config.teams[inn.bowlingTeam].color;
    const bat = inn.batters[d.striker], batBefore = before.batters[d.striker];
    if (bat && batBefore) {
      for (const mark of [100, 50]) {
        if (batBefore.runs < mark && bat.runs >= mark) return { text: mark === 100 ? 'HUNDRED!' : 'FIFTY!', who: { id: bat.id, name: bat.name, color } };
      }
    }
    const bw = inn.bowlers[d.bowler], bwBefore = before.bowlers[d.bowler];
    if (bw && bwBefore) {
      // Wides/no-balls without a wicket don't break a hat-trick sequence.
      const mine = inn.deliveries.filter(x => x.bowler === d.bowler && (x.legal || x.wicket));
      const last3 = mine.slice(-3);
      if (last3.length === 3 && last3.every(x => x.wicket && E.BOWLER_CREDIT.includes(x.wkind))) return { text: 'HAT-TRICK!', who: { id: bw.id, name: bw.name, color: bcolor } };
      for (const n of [5, 3]) {
        if (bwBefore.wickets < n && bw.wickets >= n) return { text: `${n}-WICKET HAUL!`, who: { id: bw.id, name: bw.name, color: bcolor } };
      }
      if (bw.maidens > bwBefore.maidens) return { text: 'MAIDEN OVER', who: { id: bw.id, name: bw.name, color: bcolor } };
    }
    return null;
  }

  function doUndo() {
    if (!app.match || !app.match.events.length) { toast('Nothing to undo'); return; }
    const r = E.undo(app.match.events);
    const st = commit(r.events);
    if (!st) return;
    sound('undo'); buzz(20);
    toast('Undone: ' + E.describeEvent(r.removed[0], st.names));
    renderLive();
  }

  // =====================================================================
  // LIVE SHARING — scorer links, viewer links (see js/sync.js and firestore.rules)
  // =====================================================================
  const SYNC = window.TCPSync;
  const liveEnabled = () => !!(SYNC && SYNC.available());
  const appUrl = () => location.origin + location.pathname;
  const viewerUrl = id => `${appUrl()}#/watch/${encodeURIComponent(id)}`;
  const scorerUrl = (id, key) => `${appUrl()}#/join/${encodeURIComponent(id)}/${encodeURIComponent(key)}`;
  const sameEvents = (a, b) => a.length === b.length && a.every((e, i) => (e.id || '') === (b[i].id || '') && JSON.stringify(e) === JSON.stringify(b[i]));

  // Photos of everyone in the match (and team logos), so viewers see the same avatars.
  function matchPhotos(cfg) {
    const all = photos(), out = {};
    cfg.teams.forEach(t => {
      const k = teamPhotoKey(t);
      if (k && all[k]) out[k] = all[k];
      t.players.forEach(p => { if (all[p.id]) out[p.id] = all[p.id]; });
    });
    return out;
  }

  // Keeps the current shared match in sync with the cloud log.
  function ensureLiveSync() {
    const m = app.match;
    if (!m || !m.live || !liveEnabled()) { stopLiveSync(); return; }
    if (app.sync && app.sync.id === m.live.id) return;
    stopLiveSync();
    const sync = app.sync = { id: m.live.id, seq: -1, inflight: 0, first: true, status: 'connecting', unsub: null };
    sync.unsub = SYNC.watch(m.live.id, d => onLiveData(sync, d), err => {
      sync.status = 'error'; sync.error = err.message; refreshSyncChip();
    });
  }
  function stopLiveSync() { if (app.sync && app.sync.unsub) app.sync.unsub(); app.sync = null; }

  function onLiveData(sync, d) {
    if (app.sync !== sync || !app.match) return;
    if (!sync.inflight) sync.seq = d.seq; else sync.seq = Math.max(sync.seq, d.seq);
    sync.status = d.pending ? (navigator.onLine ? 'sending' : 'offline') : 'synced';
    const m = app.match;
    if (sync.first) {
      sync.first = false;
      // Balls scored while live sync wasn't running (e.g. reopened offline): send them now.
      const op = SYNC.diffOp(d.events, m.events);
      if (op.r === 0 && op.a.length) { pushLive(op); refreshSyncChip(); return; }
    }
    const metaChanged = JSON.stringify(d.meta.config) !== JSON.stringify(m.config) || (d.meta.potm || null) !== (m.potm || null) || !!d.meta.paused !== !!m.paused;
    if (sameEvents(d.events, m.events) && !metaChanged) { refreshSyncChip(); return; }
    // Another scorer changed the match (or one of our writes was rejected): the cloud log wins.
    const next = Object.assign({}, m, { config: d.meta.config, events: d.events, potm: d.meta.potm || null, paused: !!d.meta.paused, updatedAt: Date.now() });
    let st;
    try { st = E.replay(next); } catch (err) { sync.status = 'error'; sync.error = err.message; refreshSyncChip(); return; }
    next.summary = E.summarize(st);
    try { store.saveMatch(next); } catch (err) { /* keep going in memory */ }
    const grew = d.events.length > m.events.length;
    app.match = next; app.state = st; app.statsCache = null;
    if (d.meta.photos) { app.photos = Object.assign({}, store.getPhotos(), d.meta.photos); }
    if (location.hash.startsWith('#/live')) {
      renderLive();
      if (!d.pending) toast(grew ? 'Updated by another scorer' : 'Score updated from the live match');
    }
    refreshSyncChip();
  }

  // Sends one scoring change. If another scorer got there first the server rejects it,
  // the local copy rolls back to the server's version and the scorer is told.
  function pushLive(op) {
    const sync = app.sync;
    if (!sync || sync.first || !app.match || !app.match.live) return; // first snapshot will reconcile
    if (!op.r && !op.a.length) return;
    const seq = sync.seq + 1;
    sync.seq = seq; sync.inflight++;
    sync.status = navigator.onLine ? 'sending' : 'offline';
    refreshSyncChip();
    SYNC.push(sync.id, seq, op)
      .catch(err => {
        if (app.sync !== sync) return;
        toast(err && err.code === 'permission-denied'
          ? 'Another scorer recorded a ball at the same moment — your last tap was not saved. Check the score.'
          : 'Could not sync: ' + (err.message || err), 'error');
        buzz([80, 40, 80]);
      })
      .finally(() => { sync.inflight = Math.max(0, sync.inflight - 1); if (app.sync === sync && !sync.inflight) { sync.status = 'synced'; refreshSyncChip(); } });
  }
  function pushLiveMeta(m) {
    if (!m.live || !liveEnabled()) return;
    SYNC.updateMeta(m.live.id, { config: m.config, title: m.config.name, potm: m.potm || null, paused: !!m.paused })
      .catch(err => toast('Could not sync: ' + (err.message || err), 'error'));
  }

  function syncChipHTML() {
    const m = app.match;
    if (!m || !m.live) return '';
    const s = app.sync ? app.sync.status : 'connecting';
    const label = { synced: 'Live · synced', sending: 'Live · sending…', offline: 'Offline · will sync', connecting: 'Live · connecting…', error: 'Live · sync error' }[s] || 'Live';
    return `<span class="sync-chip ${s}" id="sync-chip" role="status">${label}</span>`;
  }
  function refreshSyncChip() { const el = $('#sync-chip'); if (el) el.outerHTML = syncChipHTML(); }

  // ---------- QR codes (library loaded on first use) ----------
  let qrLib = null;
  function loadQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) qrLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      s.onload = () => resolve(window.qrcode);
      s.onerror = () => { qrLib = null; reject(new Error('QR code needs an internet connection')); };
      document.head.appendChild(s);
    });
    return qrLib;
  }
  async function fillQr(el, url) {
    try {
      const qrcode = await loadQr();
      const q = qrcode(0, 'M'); q.addData(url); q.make();
      el.innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    } catch (err) { el.innerHTML = `<span class="small muted">${esc(err.message)}</span>`; }
  }

  async function shareLink(title, url) {
    if (navigator.share) {
      try { await navigator.share({ title, text: title, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    await copyText(url);
    toast('Link copied', 'ok');
  }

  // The "Share" sheet on the live screen.
  async function liveShareSheet() {
    const m = app.match;
    if (!liveEnabled()) return;
    if (!m.live) {
      const go = await sheet({
        title: 'Share this match live',
        render: () => `<p class="muted" style="margin-top:0">Going live lets you send two kinds of links:</p>
          <div class="share-what"><b>👀 Watch link</b><span>Anyone can follow the score live — no app or login needed.</span></div>
          <div class="share-what"><b>🏏 Scorer link</b><span>Lets a trusted friend score on their phone too. Every ball syncs between phones.</span></div>
          <label class="field" style="margin-top:12px"><span>Your name (shown to other scorers)</span><input type="text" id="gl-name" maxlength="40" value="${esc(app.settings.scorerName || '')}" placeholder="e.g. Hanif"></label>
          <div class="sheet-actions"><button class="btn" data-close>Not now</button><button class="btn primary" data-on="go">Go live</button></div>`,
        on: { go: (el, api) => api.close($('#gl-name', api.body).value.trim() || 'Owner') },
      });
      if (!go) return;
      app.settings.scorerName = go; store.saveSettings(app.settings);
      toast('Going live…');
      try {
        const res = await SYNC.goLive(m, matchPhotos(m.config), go);
        m.live = { id: res.id, role: 'owner', key: res.key };
        saveMeta(m);
        ensureLiveSync();
        renderLive();
      } catch (err) {
        toast(navigator.onLine ? 'Could not go live: ' + (err.message || err) : 'You are offline — connect to the internet to go live.', 'error');
        return;
      }
    }
    const live = app.match.live;
    const owner = live.role === 'owner';
    return sheet({
      title: 'Share live match',
      state: { scorers: null },
      render: s => `
        <div class="share-block">
          <div class="share-head"><b>👀 Watch link</b><span class="pill">Anyone</span></div>
          <p class="small muted">Read-only live score. Share in the WhatsApp group or show the QR at the ground.</p>
          <div class="qr" id="qr-view" aria-label="QR code for the watch link"></div>
          <div class="link-box">${esc(viewerUrl(live.id))}</div>
          <div class="btn-row"><button class="btn" data-on="copy" data-u="v">Copy</button><button class="btn primary" data-on="share" data-u="v">Share</button></div>
        </div>
        ${owner ? `<div class="share-block danger-zone">
          <div class="share-head"><b>🏏 Scorer link</b><span class="pill warn">Trusted only</span></div>
          <p class="small muted">Whoever opens this can score balls for this match. Send it privately.</p>
          <div class="link-box">${esc(scorerUrl(live.id, live.key))}</div>
          <div class="btn-row"><button class="btn" data-on="copy" data-u="s">Copy</button><button class="btn primary" data-on="share" data-u="s">Share</button></div>
          <button class="btn sm ghost" data-on="rotate" style="margin-top:6px">↻ Make a new scorer link (old one stops working)</button>
          <div class="lbl">Scorers on this match</div>
          ${s.scorers == null ? '<p class="small muted">Loading…</p>' : s.scorers.map(x => `<div class="kv"><span>${esc(x.name)}${x.uid === s.me ? ' (you)' : ''}</span>
            ${x.uid === s.me ? '' : `<button class="btn sm danger" data-on="remove" data-uid="${esc(x.uid)}">Remove</button>`}</div>`).join('') || '<p class="small muted">Only you so far.</p>'}
        </div>` : '<p class="small muted">You are a scorer on this match. Only the match creator can invite more scorers.</p>'}`,
      on: {
        copy: async el => { await copyText(el.dataset.u === 's' ? scorerUrl(live.id, live.key) : viewerUrl(live.id)); toast('Link copied', 'ok'); },
        share: el => (el.dataset.u === 's'
          ? shareLink(`Score ${app.match.config.name} with me`, scorerUrl(live.id, live.key))
          : shareLink(`Watch ${app.match.config.name} live`, viewerUrl(live.id))),
        rotate: async (el, api) => {
          if (!await confirmDialog('The current scorer link will stop working for anyone who hasn’t joined yet. People already scoring stay until you remove them.', { title: 'New scorer link?', ok: 'Make new link' })) return;
          try { live.key = await SYNC.rotateKey(live.id); saveMeta(app.match); api.render(); toast('New scorer link ready', 'ok'); }
          catch (err) { toast('Could not change the link: ' + (err.message || err), 'error'); }
        },
        remove: async (el, api) => {
          try { await SYNC.removeScorer(live.id, el.dataset.uid); api.state.scorers = api.state.scorers.filter(x => x.uid !== el.dataset.uid); api.render(); toast('Scorer removed'); }
          catch (err) { toast('Could not remove: ' + (err.message || err), 'error'); }
        },
      },
      afterRender: api => fillQr($('#qr-view', api.body), viewerUrl(live.id)),
      mounted: api => {
        if (owner) Promise.all([SYNC.listScorers(live.id), SYNC.uid()]).then(([list, me]) => {
          api.state.scorers = list; api.state.me = me; api.render();
        }).catch(() => { api.state.scorers = []; api.render(); });
      },
    });
  }

  // ---------- #/join/<id>/<key>: become a scorer ----------
  function viewJoin(id, key) {
    if (!liveEnabled()) { view().innerHTML = topbar('Join as scorer', { back: '#/' }) + '<div class="card empty"><b>Live sharing is not available</b>This copy of the app is not connected to live sharing.</div>'; return; }
    const local = store.getMatch(id);
    if (local && local.live && local.live.role !== 'viewer') { store.setCurrentId(id); app.match = null; app.state = null; go('#/live'); return; }
    view().innerHTML = `${topbar('Join as scorer', { back: '#/' })}
      <section class="card"><div id="join-match" class="muted">Loading match…</div></section>
      <section class="card">
        <p class="muted" style="margin-top:0">You've been invited to score this match. Every ball you record appears on the other scorer's phone and for everyone watching.</p>
        <label class="field"><span>Your name</span><input type="text" id="join-name" maxlength="40" value="${esc(app.settings.scorerName || '')}" placeholder="e.g. Arjun"></label>
        <p class="err" id="join-err" role="alert"></p>
        <button class="btn primary block lg" id="join-go">Join and start scoring</button>
        <a class="btn ghost block" href="#/watch/${encodeURIComponent(id)}" style="margin-top:8px">Just watch instead</a>
      </section>`;
    let first = null;
    const stop = SYNC.watch(id, d => {
      first = d;
      try {
        const st = E.replay({ config: d.meta.config, events: d.events });
        const box = $('#join-match');
        if (box) box.outerHTML = matchCardHTML(st, { title: d.meta.title || 'Live match', pill: '<span class="pill live">Live</span>', sub: d.meta.config.venue || '' });
      } catch (e) { /* shown on join */ }
    }, err => { const e = $('#join-err'); if (e) e.textContent = err.message; });
    app.liveCleanup = stop;
    $('#join-go').onclick = async () => {
      const btn = $('#join-go'), err = $('#join-err');
      const name = $('#join-name').value.trim();
      if (!name) { err.textContent = 'Enter your name so the other scorer knows who joined.'; return; }
      btn.disabled = true; btn.textContent = 'Joining…'; err.textContent = '';
      try {
        await SYNC.join(id, key, name);
        app.settings.scorerName = name; store.saveSettings(app.settings);
        for (let i = 0; i < 50 && !first; i++) await new Promise(r => setTimeout(r, 100));
        if (!first) throw new Error('Could not load the match. Check your internet and try again.');
        const now = Date.now();
        const m = { id, version: 1, config: first.meta.config, events: first.events, potm: first.meta.potm || null, paused: !!first.meta.paused, createdAt: now, updatedAt: now, live: { id, role: 'scorer' } };
        m.summary = E.summarize(E.replay(m));
        store.saveMatch(m);
        Object.entries(first.meta.photos || {}).forEach(([k, v]) => { if (!photos()[k]) app.photos = store.setPhoto(k, v); });
        store.setCurrentId(id);
        app.match = m; app.state = null;
        toast('You are now scoring this match', 'ok');
        go('#/live');
      } catch (e) {
        btn.disabled = false; btn.textContent = 'Join and start scoring';
        err.textContent = e && e.code === 'permission-denied'
          ? 'This scorer link has expired or was replaced. Ask for a new one.'
          : (navigator.onLine ? (e.message || String(e)) : 'You are offline — connect to the internet to join.');
      }
    };
  }

  // ---------- #/watch/<id>: read-only live score ----------
  function viewWatch(id) {
    if (!liveEnabled()) { view().innerHTML = topbar('Live score', { back: '#/' }) + '<div class="card empty"><b>Live sharing is not available</b>This copy of the app is not connected to live sharing.</div>'; return; }
    view().innerHTML = `${topbar('Live score', { back: '#/' })}<div class="card empty" id="watch-body"><b>Connecting…</b>Loading the live score.</div>`;
    const w = app.watch = { id, tab: 'live', data: null, at: 0 };
    const draw = () => {
      if (app.watch !== w || !w.data || !location.hash.startsWith('#/watch/')) return;
      const d = w.data;
      let st;
      try { st = E.replay({ config: d.meta.config, events: d.events }); } catch (err) { view().innerHTML = errorCard(err.message); return; }
      app.photos = Object.assign({}, store.getPhotos(), d.meta.photos || {});
      app.sc = { match: { id, config: d.meta.config, events: d.events, potm: d.meta.potm }, state: st };
      const inn = st.innings[st.current];
      const active = isActive(st);
      const cfg = st.config;
      const tabs = [['live', 'Live'], ['card', 'Scorecard'], ['rep', 'Report']];
      let body = '';
      if (w.tab === 'live') {
        if (!active) body = `<section class="card result-card"><div class="trophy" aria-hidden="true">${st.result && st.result.tie ? '🤝' : st.status === 'abandoned' ? '⛔' : '🏆'}</div><h2>${esc(st.result ? st.result.text : 'Match over')}</h2></section>`;
        else if (!inn.started) body = `<section class="card empty"><b>${inn.index ? 'Innings break' : 'Starting soon'}</b>${inn.target ? `${esc(cfg.teams[inn.battingTeam].name)} need ${inn.target} to win.` : 'Waiting for the scorer to pick the openers.'}</section>`;
        else body = scoreboardHTML(st, inn) + creaseHTML(st, inn) + (d.meta.paused ? '<div class="paused-banner">Match paused</div>' : '');
      } else if (w.tab === 'card') {
        body = st.innings.filter(i => i.started).map(i => inningsCardHTML(st, i)).join('') || '<div class="card empty"><b>No balls bowled yet</b></div>';
      } else body = reportHTML(st);
      const ago = Math.max(0, Math.round((Date.now() - w.at) / 1000));
      view().innerHTML = `${topbar(active ? 'Live score' : 'Final score', { back: '#/', sub: cfg.name })}
        <section class="card">${matchCardHTML(st, {
          title: active ? 'Live Match' : 'Result', pill: active ? '<span class="pill live">Live</span>' : '',
          sub: [cfg.venue, `${cfg.overs} overs`].filter(Boolean).join(' · '), result: active ? null : (st.result ? st.result.text : 'Abandoned'),
        })}<div class="small muted" style="margin-top:8px">${d.fromCache ? '⚠️ Offline — showing the last score received' : `Updates automatically · ${ago < 5 ? 'just now' : ago + 's ago'}`}</div></section>
        <div class="tabs" role="tablist" id="w-tabs">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === w.tab}" class="${k === w.tab ? 'on' : ''}" data-wtab="${k}">${l}</button>`).join('')}</div>
        <div id="w-body">${body}</div>
        <p class="center small muted" style="margin-top:16px">Watching on Turf Cricket Pro</p>`;
      $('#w-tabs').onclick = e => { const b = e.target.closest('[data-wtab]'); if (b) { w.tab = b.dataset.wtab; draw(); } };
      $('#w-body').onclick = e => {
        const hit = e.target.closest('[data-ov-tip]');
        if (hit) { const tip = hit.closest('.chart-card').querySelector('.chart-tip'); if (tip) tip.textContent = hit.dataset.ovTip; }
      };
    };
    const stop = SYNC.watch(id, d => {
      const prev = w.data;
      w.data = d; w.at = Date.now();
      draw();
      if (prev && d.events.length > prev.events.length) {
        const e = d.events[d.events.length - 1];
        if (e.type === 'ball' && e.wicket) flash('OUT!', 'fw');
        else if (e.type === 'ball' && e.boundary !== false && e.kind === 'normal' && e.runs === 6) flash('SIX!', 'f6');
        else if (e.type === 'ball' && e.boundary !== false && e.kind === 'normal' && e.runs === 4) flash('FOUR!', 'f4');
      }
    }, err => {
      const b = $('#watch-body') || view();
      b.innerHTML = `<b>Can't load this match</b>${esc(navigator.onLine ? err.message : 'You are offline — the score will appear when you reconnect.')}`;
    });
    const tick = setInterval(() => { if (app.watch === w && w.tab === 'live') draw(); }, 15000);
    app.liveCleanup = () => { stop(); clearInterval(tick); if (app.watch === w) app.watch = null; app.photos = null; };
  }

  // ---------- router ----------
  const routes = [
    [/^#?\/?$/, () => viewHome()],
    [/^#\/new$/, () => viewSetup({})],
    [/^#\/edit$/, () => viewSetup({ edit: true })],
    [/^#\/rematch\/(.+)$/, id => viewSetup({ rematch: id })],
    [/^#\/live$/, () => viewLive()],
    [/^#\/match\/(.+)$/, id => viewScorecard(id)],
    [/^#\/teams$/, () => viewTeams()],
    [/^#\/teams\/(.+)$/, id => viewTeamEdit(id)],
    [/^#\/history$/, () => viewHistory()],
    [/^#\/stats$/, () => viewStats()],
    [/^#\/settings$/, () => viewSettings()],
    [/^#\/watch\/([^/]+)$/, id => viewWatch(id)],
    [/^#\/join\/([^/]+)\/([^/]+)$/, (id, key) => viewJoin(id, key)],
  ];
  const NAV_OF = { '': 'home', new: 'home', edit: 'live', rematch: 'home', live: 'live', match: 'history', teams: 'teams', history: 'history', stats: 'stats', settings: 'home', watch: 'home', join: 'live' };

  function route() {
    const h = location.hash || '#/';
    if (app.dirty && h !== app.prevHash) {
      const target = h;
      history.replaceState(null, '', app.prevHash);
      confirmDialog('You have unsaved changes on this screen. Leave without saving them?', { title: 'Leave this screen?', ok: 'Leave', danger: true })
        .then(ok => { if (ok) { app.dirty = false; location.hash = target; } });
      return;
    }
    app.prevHash = h;
    app.dirty = false;
    const root = view();
    root.onclick = null; root.oninput = null;
    if (app.liveCleanup) { app.liveCleanup(); app.liveCleanup = null; }
    for (const [re, fn] of routes) {
      const m = h.match(re);
      if (m) {
        try { fn(...m.slice(1).map(decodeURIComponent)); }
        catch (err) { console.error(err); view().innerHTML = errorCard(err.message); }
        setNav(h);
        window.scrollTo(0, 0);
        view().focus({ preventScroll: true });
        return;
      }
    }
    location.hash = '#/';
  }
  function setNav(h) {
    const key = NAV_OF[(h || location.hash).replace(/^#\/?/, '').split('/')[0]] || 'home';
    $$('.bottom-nav a').forEach(a => {
      const on = a.dataset.nav === key;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('.bottom-nav .live-dot').hidden = !liveSummary();
    ensureLiveSync();
    updateWakeLock();
  }

  // Keeps the phone screen on while a live match is open on the scoring screen.
  let wakeLock = null;
  async function updateWakeLock() {
    const want = app.settings.wakeLock && location.hash.startsWith('#/live') && !!liveSummary() && document.visibilityState === 'visible';
    try {
      if (want && !wakeLock && 'wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!want && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { wakeLock = null; /* not supported or denied: screen follows phone settings */ }
  }
  function errorCard(msg) {
    return `<div class="card empty"><b>Something went wrong</b>${esc(msg)}<div style="margin-top:14px"><a class="btn" href="#/">Go home</a></div></div>`;
  }
  function topbar(title, opts) {
    const o = opts || {};
    return `<header class="topbar">${o.back ? `<a class="icon-btn" href="${o.back}" aria-label="Back">${ICON.back}</a>` : ''}
      <h1>${esc(title)}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</h1>${o.right || ''}</header>`;
  }

  // ---------- all-match data for stats ----------
  function getEntries() {
    const idx = store.getMatchIndex();
    const sig = idx.map(x => x.id + ':' + x.updatedAt).join('|');
    if (app.statsCache && app.statsCache.sig === sig) return app.statsCache.entries;
    const entries = [];
    store.getAllMatches().forEach(match => {
      try { entries.push({ match, state: E.replay(match) }); } catch (e) { /* skip unreadable match */ }
    });
    app.statsCache = { sig, entries };
    return entries;
  }

  // "Live Match" / "Result" card: two team lines with badge, score and overs.
  function matchCardHTML(st, o) {
    const cfg = st.config;
    const cur = st.innings[st.current];
    const live = isActive(st) && cur.started;
    const decided = st.status === 'complete' && st.result && st.result.winner != null;
    const first = st.innings[0].battingTeam;
    const line = ti => {
      const t = cfg.teams[ti];
      const inn = teamInnings(st, ti);
      const batting = live && cur.battingTeam === ti;
      const bowling = live && cur.bowlingTeam === ti;
      const cls = decided ? (st.result.winner === ti ? 'win' : 'lose') : (batting ? 'bat' : '');
      const score = inn
        ? `${inn.runs}/${inn.wickets}<small>(${E.oversStr(inn.legalBalls)}/${inn.maxOvers} ov${inn.target != null ? `, target ${inn.target}` : ''})</small>`
        : '<small>Yet to bat</small>';
      return `<div class="team-line">${flag(t)}
        <span class="tn ${cls}">${esc(t.name)}${batting ? ' <span class="bat-ico" title="Batting">🏏</span>' : ''}${bowling ? '<span class="bowl-ico" title="Bowling"></span>' : ''}</span>
        <span class="ts ${cls === 'lose' ? 'lose' : ''}">${score}</span></div>`;
    };
    return `<div class="mc-head"><h2>${esc(o.title)}</h2>${o.pill || ''}</div>
      <div class="mc-sub">${esc(o.sub || '')}</div>
      ${line(first)}<div class="vs-row"><span class="vs">vs</span></div>${line(1 - first)}
      ${o.result ? `<div class="mc-result">${esc(o.result)}</div>` : ''}`;
  }

  function scoreLinesFromSummary(s) {
    if (!s) return '';
    return s.innings.map(i => `${esc(s.teams[i.team].name)}${i.isSuper ? ' (SO)' : ''} ${i.runs}/${i.wickets} (${i.overs})`).join(' · ');
  }

  // =====================================================================
  // HOME
  // =====================================================================
  function viewHome() {
    const idx = store.getMatchIndex().slice().sort((a, b) => b.updatedAt - a.updatedAt);
    const done = idx.filter(x => x.summary && (x.summary.status === 'complete' || x.summary.status === 'abandoned'));
    const teams = store.getTeams();
    let live = null;
    try { live = liveSummary(); } catch (e) { live = null; }

    const winsByTeam = teams.map(t => {
      let w = 0, l = 0, p = 0;
      done.forEach(x => {
        const i = x.summary.teams.findIndex(tt => tt.savedTeamId === t.id);
        if (i < 0) return;
        p++;
        if (x.summary.winner === i) w++;
        else if (x.summary.winner != null) l++;
      });
      return { t, w, l, p };
    }).filter(r => r.p).sort((a, b) => b.w - a.w);

    let liveCard = '';
    if (live) {
      const inn = live.innings[live.current];
      const c = E.chase(inn);
      const status = live.status === 'innings_break' ? 'Innings break' : (c && inn.started ? `Need ${c.need} from ${plural(c.ballsLeft, 'ball')}` : (inn.started ? `Run rate ${fmt2(E.rate(inn.runs, inn.legalBalls))}` : 'Waiting for openers'));
      liveCard = `<section class="card" aria-label="Live match">
        ${matchCardHTML(live, {
          title: 'Live Match',
          pill: `<span class="pill live">${app.match && app.match.paused ? 'Paused' : 'Live'}</span>`,
          sub: [live.config.name, live.config.venue].filter(Boolean).join(' · '),
          result: status,
        })}
        <a class="btn primary block lg" href="#/live" style="margin-top:14px">Resume scoring</a></section>`;
    }

    const recent = idx.slice(0, 5).map(matchRowHTML).join('');
    const lastBackup = app.settings.lastBackup;
    const needBackup = done.length >= 3 && (!lastBackup || Date.now() - lastBackup > 14 * 864e5);
    view().innerHTML = `
      <header class="topbar"><div class="brand">${ICON.logo}<h1>Turf Cricket <b>Pro</b><span class="sub">Live scoring for turf matches</span></h1></div>
        <a class="icon-btn" href="#/settings" aria-label="Settings and backup">${ICON.gear}</a></header>
      ${storageOk ? '' : '<div class="card"><b style="color:var(--danger)">Storage is blocked.</b> <span class="muted small">This browser (private mode?) won’t keep your data after you close it.</span></div>'}
      ${liveCard}
      ${needBackup ? `<section class="card backup-nudge"><div class="row"><span style="font-size:26px" aria-hidden="true">💾</span>
        <div class="grow"><b>Back up your ${done.length} matches</b><div class="small muted">${lastBackup ? `Last backup ${esc(fmtDate(new Date(lastBackup).toISOString().slice(0, 10)))}` : 'Never backed up'} — data lives only on this phone.</div></div>
        <button class="btn sm primary" data-act="export">Back up</button></div></section>` : ''}
      <section class="card">
        ${live ? '' : '<div class="mc-head"><h2>Ready to play?</h2></div><div class="mc-sub">Teams, toss and overs — set up a match in under a minute.</div>'}
        <a class="btn ${live ? '' : 'primary'} block lg" href="#/new">${ICON.plus.replace('<svg', '<svg width="22" height="22" fill="currentColor"')} Start New Match</a>
        <nav class="quick" aria-label="Sections" style="margin-top:12px">
          <a href="#/teams">${ICON.teams}Manage Teams</a>
          <a href="#/history">${ICON.history}Match History</a>
          <a href="#/stats">${ICON.stats}Statistics</a>
        </nav>
      </section>
      <div class="kpis">
        <div class="kpi"><b>${done.length}</b><span>Matches played</span></div>
        <div class="kpi"><b>${teams.length}</b><span>Saved teams</span></div>
        <div class="kpi"><b>${idx.length - done.length}</b><span>In progress</span></div>
      </div>
      ${winsByTeam.length ? `<h2 class="section-title">Wins by team</h2><div class="card">${winsByTeam.map(r => `<div class="kv" style="align-items:center"><span style="display:flex;align-items:center;gap:10px">${flag(r.t, 'sm')}${esc(r.t.name)}</span><span><b>${r.w}</b> W · ${r.l} L · ${r.p} P</span></div>`).join('')}</div>` : ''}
      <h2 class="section-title">Recent matches</h2>
      ${recent ? `<div class="list">${recent}</div>` : '<div class="card empty"><b>No matches yet</b>Create your teams, then tap Start New Match.</div>'}`;
  }

  function matchRowHTML(x) {
    const s = x.summary;
    const st = s ? s.status : 'ready';
    const badge = st === 'complete' ? '' : st === 'abandoned' ? '<span class="pill warn">Abandoned</span>' : '<span class="pill live">In progress</span>';
    return `<a class="list-item match-row" href="#/match/${encodeURIComponent(x.id)}">
      <div class="grow"><div class="t">${esc(x.name)}</div>
        <div class="s">${esc([fmtDate(x.date), x.venue].filter(Boolean).join(' · '))}</div>
        ${s && s.innings.length ? `<div class="scores">${scoreLinesFromSummary(s)}</div>` : ''}
        ${s && s.result && st === 'complete' ? `<div class="res">${esc(s.result)}</div>` : ''}</div>
      ${badge}<span class="chev" aria-hidden="true">›</span></a>`;
  }

  // =====================================================================
  // MATCH SETUP
  // =====================================================================
  const OVERS = [5, 6, 8, 10, 12, 15, 20];
  const SIDES = [5, 6, 7, 8, 9, 10, 11];

  function viewSetup(mode) {
    let base = null;
    if (mode.edit) {
      const m = loadCurrent();
      if (!m || hasBalls(m)) { toast('Match settings can only be edited before the first ball', 'error'); go('#/live'); return; }
      base = m.config;
    } else if (mode.rematch) {
      const m = store.getMatch(mode.rematch);
      if (m) base = Object.assign({}, m.config, { name: '', date: localToday() });
    }
    const teams = store.getTeams();
    const S = app.setup = { mode, base, teams, extraIds: [{}, {}] };
    const overs = base ? base.overs : 6;
    const pps = base ? base.playersPerSide : 6;
    const rules = base ? base.rules : { wideRuns: 1, noBallRuns: 1, freeHit: true, lastManStands: false, superOver: true };
    const sel = (list, v) => list.map(n => `<option value="${n}" ${n === v ? 'selected' : ''}>${n}</option>`).join('') +
      `<option value="custom" ${list.includes(v) ? '' : 'selected'}>Custom…</option>`;
    const toss = base ? base.toss : { winner: 0, decision: 'bat' };
    const ballTypes = ['Tennis ball', 'Leather ball'];
    const ballVal = base ? base.ballType : 'Tennis ball';

    view().innerHTML = `
      ${topbar(mode.edit ? 'Edit match settings' : (mode.rematch ? 'Rematch' : 'New match'), { back: mode.edit ? '#/live' : '#/', sub: 'Only team players and toss are needed' })}
      <form id="setup" novalidate autocomplete="off">
        <section class="card">
          <h2>Match details</h2>
          <label class="field"><span>Match name (optional)</span><input type="text" id="m-name" maxlength="60" value="${esc(base && base.name)}" placeholder="Team A vs Team B"></label>
          <div class="grid2">
            <label class="field"><span>Date</span><input type="date" id="m-date" value="${esc((base && base.date) || localToday())}"></label>
            <label class="field"><span>Venue / turf (optional)</span><input type="text" id="m-venue" maxlength="60" value="${esc(base && base.venue)}" placeholder="e.g. Green Turf"></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Overs per innings</span><select id="m-overs">${sel(OVERS, overs)}</select>
              <input type="number" id="m-overs-c" min="1" max="50" inputmode="numeric" placeholder="Overs" value="${OVERS.includes(overs) ? '' : overs}" ${OVERS.includes(overs) ? 'hidden' : ''} style="margin-top:6px"></label>
            <label class="field"><span>Players per side</span><select id="m-pps">${sel(SIDES, pps)}</select>
              <input type="number" id="m-pps-c" min="2" max="15" inputmode="numeric" placeholder="Players" value="${SIDES.includes(pps) ? '' : pps}" ${SIDES.includes(pps) ? 'hidden' : ''} style="margin-top:6px"></label>
          </div>
          <div class="grid2">
            <label class="field"><span>Max overs per bowler</span><input type="number" id="m-maxov" min="1" max="50" inputmode="numeric" placeholder="No limit" value="${esc(base && base.maxOversPerBowler)}"></label>
            <label class="field"><span>Ball type</span><select id="m-ball">${ballTypes.map(b => `<option ${b === ballVal ? 'selected' : ''}>${b}</option>`).join('')}<option value="custom" ${ballTypes.includes(ballVal) ? '' : 'selected'}>Custom…</option></select>
              <input type="text" id="m-ball-c" maxlength="30" placeholder="e.g. Cork ball" value="${ballTypes.includes(ballVal) ? '' : esc(ballVal)}" ${ballTypes.includes(ballVal) ? 'hidden' : ''} style="margin-top:6px"></label>
          </div>
          <label class="field"><span>Format</span><select id="m-format"><option value="standard">Standard innings</option><option value="custom" ${base && base.format === 'custom' ? 'selected' : ''}>Custom rules</option></select></label>
          <div id="rules" ${base && base.format === 'custom' ? '' : 'hidden'}>
            <div class="grid2">
              <label class="field"><span>Runs for a wide</span><input type="number" id="r-wd" min="0" max="5" inputmode="numeric" value="${rules.wideRuns}"></label>
              <label class="field"><span>Runs for a no-ball</span><input type="number" id="r-nb" min="0" max="5" inputmode="numeric" value="${rules.noBallRuns}"></label>
            </div>
            <label class="check"><input type="checkbox" id="r-fh" ${rules.freeHit ? 'checked' : ''}> Free hit after a no-ball</label>
            <label class="check"><input type="checkbox" id="r-lms" ${rules.lastManStands ? 'checked' : ''}> Last man stands (last batter can bat alone)</label>
          </div>
          <label class="check"><input type="checkbox" id="r-so" ${rules.superOver ? 'checked' : ''}> Super Over if the match is tied</label>
        </section>
        ${[0, 1].map(i => teamBlockHTML(i, base, teams)).join('')}
        <section class="card">
          <div class="mc-head"><h2>Toss</h2><button type="button" class="btn sm" data-flip>🪙 Flip a coin</button></div>
          <div id="coin" class="coin-out" aria-live="polite"></div>
          <label class="field"><span>Toss won by</span><select id="toss-w"><option value="0">Team A</option><option value="1" ${toss.winner === 1 ? 'selected' : ''}>Team B</option></select></label>
          <div class="field" style="margin-bottom:0"><span class="small muted" style="display:block;margin-bottom:6px;font-weight:600">Elected to</span>
            <div class="seg" role="radiogroup" aria-label="Toss decision">
              <button type="button" role="radio" data-dec="bat" class="${toss.decision === 'bat' ? 'on' : ''}" aria-checked="${toss.decision === 'bat'}">Bat first</button>
              <button type="button" role="radio" data-dec="bowl" class="${toss.decision === 'bowl' ? 'on' : ''}" aria-checked="${toss.decision === 'bowl'}">Bowl first</button>
            </div></div>
        </section>
        <p class="err" id="setup-err" role="alert"></p>
        <button type="submit" class="btn primary block lg">${mode.edit ? 'Save settings' : 'Start match'}</button>
      </form>`;

    S.decision = toss.decision;
    [0, 1].forEach(i => {
      const bt = base && base.teams[i];
      const saved = bt && bt.savedTeamId ? teams.find(t => t.id === bt.savedTeamId) : null;
      const checked = saved ? bt.players.filter(p => saved.players.some(sp => sp.id === p.id)).map(p => p.id) : [];
      renderRoster(i, saved, checked);
      if (bt) {
        const extras = bt.players.filter(p => !checked.includes(p.id));
        extras.forEach(p => { S.extraIds[i][p.name.toLowerCase()] = p.id; });
        $(`#t${i}-extra`).value = extras.map(p => p.name).join('\n');
        if (saved) $(`#t${i}-saved`).value = saved.id;
      }
      updateTeamUI(i);
    });
    updateTossNames();

    const form = $('#setup');
    form.addEventListener('input', () => { app.dirty = true; });
    form.addEventListener('change', e => {
      app.dirty = true;
      const id = e.target.id;
      if (id === 'm-overs') $('#m-overs-c').hidden = e.target.value !== 'custom';
      if (id === 'm-pps') { $('#m-pps-c').hidden = e.target.value !== 'custom'; }
      if (id === 'm-ball') $('#m-ball-c').hidden = e.target.value !== 'custom';
      if (id === 'm-format') $('#rules').hidden = e.target.value !== 'custom';
      const tm = id.match(/^t(\d)-saved$/);
      if (tm) onSavedTeamChange(+tm[1]);
      [0, 1].forEach(updateTeamUI);
      updateTossNames();
    });
    form.addEventListener('input', e => {
      if (/^t\d-(name|extra|color)$/.test(e.target.id) || e.target.id === 'm-pps-c') { [0, 1].forEach(updateTeamUI); updateTossNames(); }
    });
    form.addEventListener('click', e => {
      if (e.target.closest('[data-flip]')) {
        const r = new Uint8Array(1);
        crypto.getRandomValues(r);
        const winner = r[0] & 1;
        const out = $('#coin');
        out.innerHTML = '<span class="coin spin" aria-hidden="true">🪙</span> Flipping…';
        sound('tap');
        setTimeout(() => {
          $('#toss-w').value = String(winner);
          const name = $(`#t${winner}-name`).value.trim() || (winner ? 'Team B' : 'Team A');
          out.innerHTML = `<span class="coin" aria-hidden="true">🪙</span> <b>${esc(name)}</b> won the toss — pick bat or bowl`;
          sound('four'); buzz(40);
          app.dirty = true;
        }, 1100);
        return;
      }
      const b = e.target.closest('[data-dec]');
      if (!b) return;
      S.decision = b.dataset.dec;
      $$('[data-dec]', form).forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
      app.dirty = true;
    });
    form.addEventListener('submit', e => { e.preventDefault(); submitSetup(); });
  }

  function teamBlockHTML(i, base, teams) {
    const bt = base && base.teams[i];
    const color = (bt && bt.color) || (i ? '#7c3aed' : '#1f9d55');
    return `<section class="card" aria-label="Team ${i ? 'B' : 'A'}">
      <h2><span class="dot" id="t${i}-dot" style="background:${esc(color)}"></span> Team ${i ? 'B' : 'A'}</h2>
      <label class="field"><span>Choose a saved team</span><select id="t${i}-saved"><option value="">+ New team (type below)</option>
        ${teams.map(t => `<option value="${esc(t.id)}">${esc(t.name)} (${t.players.length} players)</option>`).join('')}</select></label>
      <div class="row"><label class="field grow"><span>Team name</span><input type="text" id="t${i}-name" maxlength="30" value="${esc(bt && bt.name)}" placeholder="${i ? 'Team B' : 'Team A'}"></label>
        <label class="field"><span>Colour</span><input type="color" id="t${i}-color" value="${esc(color)}" aria-label="Team ${i ? 'B' : 'A'} colour"></label></div>
      <div id="t${i}-roster"></div>
      <label class="field"><span id="t${i}-extra-lbl">Players — one name per line</span><textarea id="t${i}-extra" rows="4" placeholder="Rahul&#10;Arjun&#10;Vikram"></textarea></label>
      <p class="hint" id="t${i}-count" aria-live="polite"></p>
      <label class="check"><input type="checkbox" id="t${i}-save" checked> <span id="t${i}-save-lbl">Save this team to My Teams</span></label>
    </section>`;
  }

  function renderRoster(i, saved, checkedIds) {
    const box = $(`#t${i}-roster`);
    if (!saved) { box.innerHTML = ''; $(`#t${i}-extra-lbl`).textContent = 'Players — one name per line'; return; }
    box.innerHTML = `<div class="small muted" style="margin-bottom:6px;font-weight:600">Playing players</div><div class="roster">${saved.players.map(p => `
      <label class="check"><input type="checkbox" data-pid="${esc(p.id)}" ${checkedIds.includes(p.id) ? 'checked' : ''}><span>${esc(p.name)}${saved.captain === p.id ? ' (c)' : ''}${saved.keeper === p.id ? ' (wk)' : ''}</span></label>`).join('')}</div>`;
    $(`#t${i}-extra-lbl`).textContent = 'Add guest players (optional, one per line)';
  }

  function onSavedTeamChange(i) {
    const S = app.setup;
    const id = $(`#t${i}-saved`).value;
    const saved = S.teams.find(t => t.id === id) || null;
    if (saved) {
      $(`#t${i}-name`).value = saved.name;
      $(`#t${i}-color`).value = saved.color || (i ? '#7c3aed' : '#1f9d55');
      const pps = readNum('m-pps', 'm-pps-c');
      const xi = (saved.defaultXI || []).filter(pid => saved.players.some(p => p.id === pid));
      renderRoster(i, saved, xi.length ? xi : saved.players.slice(0, pps || saved.players.length).map(p => p.id));
    } else {
      renderRoster(i, null, []);
    }
  }

  function readNum(selId, customId) {
    const v = $('#' + selId).value;
    const raw = v === 'custom' ? $('#' + customId).value : v;
    const n = Number(raw);
    return raw === '' || !Number.isFinite(n) ? null : n;
  }
  function extraNames(i) {
    return $(`#t${i}-extra`).value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
  }
  function readTeam(i) {
    const S = app.setup;
    const saved = S.teams.find(t => t.id === $(`#t${i}-saved`).value) || null;
    const name = $(`#t${i}-name`).value.trim() || (i ? 'Team B' : 'Team A');
    const picked = saved ? $$(`#t${i}-roster input:checked`).map(el => saved.players.find(p => p.id === el.dataset.pid)).filter(Boolean).map(p => ({ id: p.id, name: p.name })) : [];
    const seen = new Set(picked.map(p => p.name.toLowerCase()));
    const extra = [];
    extraNames(i).forEach(n => {
      const k = n.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      extra.push({ id: S.extraIds[i][k] || E.uid('p'), name: n });
    });
    return {
      saved, name, color: $(`#t${i}-color`).value, save: $(`#t${i}-save`).checked,
      players: picked.concat(extra), extra,
      captain: saved ? saved.captain : null, keeper: saved ? saved.keeper : null,
    };
  }
  function updateTeamUI(i) {
    const t = readTeam(i);
    const pps = readNum('m-pps', 'm-pps-c');
    const n = t.players.length;
    const el = $(`#t${i}-count`);
    el.textContent = pps ? `${n} of ${pps} players${n > pps ? ' — too many, untick or remove some' : n < pps ? ` — ${pps - n} more needed` : ' ✓'}` : `${n} players`;
    el.className = 'hint ' + (pps && n === pps ? 'count-ok' : 'count-bad');
    $(`#t${i}-dot`).style.background = t.color;
    $(`#t${i}-save-lbl`).textContent = t.saved ? (t.extra.length ? 'Add guest players to this saved team' : 'Saved team') : 'Save this team to My Teams';
    $(`#t${i}-save`).disabled = !!t.saved && !t.extra.length;
  }
  function updateTossNames() {
    const opts = $$('#toss-w option');
    [0, 1].forEach(i => { opts[i].textContent = $(`#t${i}-name`).value.trim() || (i ? 'Team B' : 'Team A'); });
  }

  async function submitSetup() {
    const S = app.setup;
    const errEl = $('#setup-err');
    errEl.textContent = '';
    const showErr = msg => { errEl.textContent = msg; errEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); buzz([40, 30, 40]); };
    const overs = readNum('m-overs', 'm-overs-c');
    const pps = readNum('m-pps', 'm-pps-c');
    if (!overs) return showErr('Enter the number of overs.');
    if (!pps) return showErr('Enter the number of players per side.');
    const tA = readTeam(0), tB = readTeam(1);
    if (tA.saved && tB.saved && tA.saved.id === tB.saved.id) return showErr('Pick two different teams.');
    for (const t of [tA, tB]) {
      if (t.players.length > pps) return showErr(`${t.name} has ${t.players.length} players but the match is ${pps}-a-side. Untick or remove ${t.players.length - pps}.`);
    }
    const short = [tA, tB].filter(t => t.players.length < pps);
    if (short.length) {
      const ok = await confirmDialog(short.map(t => `<b>${esc(t.name)}</b> has ${t.players.length} of ${pps} players.`).join('<br>') +
        '<br><br>Fill the empty places with numbered players (for example “' + esc(short[0].name) + ' ' + pps + '”)? You can rename players later in Teams.',
      { title: 'Not enough players', ok: 'Fill and continue' });
      if (!ok) return;
      short.forEach(t => {
        for (let k = t.players.length + 1; k <= pps; k++) t.players.push({ id: E.uid('p'), name: `${t.name} ${k}`, filler: true });
      });
    }
    const ballSel = $('#m-ball').value;
    const isCustom = $('#m-format').value === 'custom';
    const input = {
      name: $('#m-name').value, date: $('#m-date').value || localToday(), venue: $('#m-venue').value,
      ballType: ballSel === 'custom' ? $('#m-ball-c').value : ballSel,
      format: isCustom ? 'custom' : 'standard', overs, playersPerSide: pps,
      maxOversPerBowler: $('#m-maxov').value,
      rules: {
        wideRuns: isCustom ? $('#r-wd').value : 1, noBallRuns: isCustom ? $('#r-nb').value : 1,
        freeHit: isCustom ? $('#r-fh').checked : true, lastManStands: isCustom ? $('#r-lms').checked : false,
        superOver: $('#r-so').checked,
      },
      teams: [tA, tB].map(t => ({ name: t.name, color: t.color, savedTeamId: t.saved ? t.saved.id : null, captain: t.captain, keeper: t.keeper, players: t.players.map(p => ({ id: p.id, name: p.name })) })),
      toss: { winner: Number($('#toss-w').value), decision: S.decision },
    };
    try { E.normalizeConfig(input); } catch (err) { return showErr(err.message); }

    // Validated: now persist teams the user asked to save.
    try {
      [tA, tB].forEach((t, i) => {
        if (!t.save) return;
        const real = t.players.filter(p => !p.filler).map(p => ({ id: p.id, name: p.name }));
        if (t.saved) {
          if (!t.extra.length) return;
          const team = store.getTeam(t.saved.id);
          t.extra.forEach(p => { if (!team.players.some(x => x.id === p.id)) team.players.push({ id: p.id, name: p.name }); });
          store.saveTeam(team);
        } else {
          const existing = store.getTeams().find(x => x.name.toLowerCase() === t.name.toLowerCase());
          if (existing) {
            real.forEach(p => { if (!existing.players.some(x => x.id === p.id || x.name.toLowerCase() === p.name.toLowerCase())) existing.players.push(p); });
            // reuse ids of same-named players so career stats stay linked
            input.teams[i].players = input.teams[i].players.map(p => {
              const ex = existing.players.find(x => x.name.toLowerCase() === p.name.toLowerCase());
              return ex ? { id: ex.id, name: ex.name } : p;
            });
            store.saveTeam(existing);
            input.teams[i].savedTeamId = existing.id;
          } else {
            const team = { id: E.uid('t'), name: t.name, color: t.color, players: real, captain: null, keeper: null, defaultXI: real.map(p => p.id), createdAt: Date.now() };
            store.saveTeam(team);
            input.teams[i].savedTeamId = team.id;
          }
        }
      });
    } catch (err) { return showErr(err.message); }

    let match;
    try {
      if (S.mode.edit) {
        const oldEvents = app.match.events;
        match = Object.assign({}, app.match, { config: E.normalizeConfig(input), events: [], updatedAt: Date.now() });
        if (match.live) { app.match = match; pushLive(SYNC.diffOp(oldEvents, [])); pushLiveMeta(match); }
      } else {
        const live = liveSummary();
        if (live) {
          const ok = await confirmDialog(`<b>${esc(live.config.name)}</b> is still in progress. It stays in Match History and you can resume it later.`, { title: 'Start another match?', ok: 'Start new match' });
          if (!ok) return;
        }
        match = E.createMatch(input);
      }
      match.summary = E.summarize(E.replay(match));
      store.saveMatch(match);
      store.setCurrentId(match.id);
    } catch (err) { return showErr(err.message); }
    app.match = match; app.state = null; app.statsCache = null; app.dirty = false;
    toast(S.mode.edit ? 'Settings saved' : 'Match created — select the openers', 'ok');
    go('#/live');
  }

  // =====================================================================
  // LIVE SCORING
  // =====================================================================
  function viewLive() {
    const m = loadCurrent();
    if (!m) {
      view().innerHTML = topbar('Live scoring') + `<div class="card empty"><b>No match in progress</b>Start a new match, or resume one from Match History.
        <div class="btn-row" style="margin-top:16px"><a class="btn primary lg" href="#/new">Start New Match</a><a class="btn lg" href="#/history">Match History</a></div></div>`;
      return;
    }
    renderLive();
  }

  function renderLive() {
    if (!location.hash.startsWith('#/live')) return;
    const m = app.match;
    let st;
    try { st = currentState(); } catch (err) {
      view().innerHTML = topbar('Live scoring') + `<div class="card"><b>This match could not be loaded.</b><p class="muted">${esc(err.message)}</p>
        <div class="btn-row"><button class="btn" data-act="undo">Remove last event</button><a class="btn" href="#/settings">Backup</a></div></div>`;
      return;
    }
    const inn = st.innings[st.current];
    const cfg = st.config;
    const active = isActive(st);
    const paused = m.paused && active;
    const innLabel = inn.isSuper ? 'Super Over' : `Innings ${inn.index + 1} of 2`;
    let control;
    if (!active) control = resultHTML(st, m);
    else if (st.needs === 'openers') control = openersHTML(st, inn);
    else if (paused) control = `<div class="pad" aria-hidden="true">${'<button class="k" disabled> </button>'.repeat(4)}</div>`;
    else if (st.needs === 'batter') control = batterPromptHTML(st, inn);
    else if (st.needs === 'bowler') control = bowlerPromptHTML(st, inn);
    else control = padHTML(m);

    view().innerHTML = `<div class="live">
      <div class="live-head">
        <div class="title"><b>${esc(cfg.name)}</b><span>${esc([innLabel, `${cfg.overs} ov`, cfg.venue].filter(Boolean).join(' · '))}</span>${syncChipHTML()}</div>
        ${liveEnabled() ? `<button class="icon-btn" data-act="share-live" aria-label="Share live: watch and scorer links">${ICON.share}</button>` : ''}
        <button class="icon-btn" data-act="mute" aria-label="${app.settings.sound ? 'Mute sounds' : 'Turn sounds on'}" aria-pressed="${!app.settings.sound}">${app.settings.sound ? ICON.soundOn : ICON.soundOff}</button>
        ${active ? `<button class="icon-btn" data-act="pause" aria-label="${m.paused ? 'Resume match' : 'Pause match'}">${m.paused ? ICON.play : ICON.pause}</button>` : ''}
        <button class="icon-btn" data-act="more" aria-label="More options">${ICON.more}</button>
      </div>
      ${paused ? `<div class="paused-banner" role="status">Match paused<button class="btn sm primary" data-act="pause">Resume</button></div>` : ''}
      <div class="col-a">${inn.started || inn.index > 0 ? scoreboardHTML(st, inn) : ''}${inn.started && active ? creaseHTML(st, inn) : ''}</div>
      <div class="col-b">${control}</div>
    </div>`;
    setNav('#/live');
  }

  function scoreboardHTML(st, inn) {
    const t = st.config.teams[inn.battingTeam];
    const prev = inn.index % 2 === 1 ? st.innings[inn.index - 1] : null;
    const c = inn.started && !inn.complete ? E.chase(inn) : null;
    const p = inn.partnerships[inn.partnerships.length - 1];
    const label = inn.isSuper ? 'Super Over' : (inn.index === 0 ? '1st innings' : '2nd innings');
    const fh = inn.freeHit && st.config.rules.freeHit && !inn.complete;
    const other = st.config.teams[inn.bowlingTeam];
    const otherInn = prev || null;
    return `<section class="card scoreboard" aria-label="Scoreboard">
      <div class="sb-main">${flag(t)}
        <span class="tn">${esc(t.name)} <span class="bat-ico" title="Batting">🏏</span>
          <small class="sb-vs"><span class="pill ${inn.complete ? '' : 'live'}">${label}</span> vs ${esc(other.name)}${otherInn ? ` · ${otherInn.runs}/${otherInn.wickets}` : ''}</small></span>
        <div><div class="sb-score" aria-label="${inn.runs} for ${inn.wickets}">${inn.runs}/${inn.wickets}</div>
        <div class="sb-overs">${E.oversStr(inn.legalBalls)} / ${inn.maxOvers} ov</div></div></div>
      <div class="sb-meta"><span>CRR <b>${fmt2(E.rate(inn.runs, inn.legalBalls))}</b></span><span>Extras <b>${E.extrasTotal(inn)}</b></span>
        ${p && p.open ? `<span>P'ship <b>${p.runs} (${p.balls})</b></span>` : ''}
        ${!c && !inn.isSuper && !inn.complete && inn.legalBalls >= 6 ? `<span>Projected <b>${inn.runs + Math.round(E.rate(inn.runs, inn.legalBalls) * (inn.maxBalls - inn.legalBalls) / 6)}</b></span>` : ''}</div>
      ${c ? `<div class="sb-chase">Need <b>${c.need}</b> run${c.need === 1 ? '' : 's'} from <b>${c.ballsLeft}</b> ball${c.ballsLeft === 1 ? '' : 's'}
        <span class="small">Target ${c.target} · Req. rate ${c.rrr == null ? '—' : fmt2(c.rrr)}</span></div>` : ''}
      ${fh ? '<div style="margin-top:8px"><span class="pill warn">FREE HIT</span></div>' : ''}
      ${recentHTML(inn)}
    </section>`;
  }

  function ballClass(d) {
    if (d.wicket) return 'bw';
    if (d.boundary && d.batRuns === 6) return 'b6';
    if (d.boundary && d.batRuns === 4) return 'b4';
    if (d.kind !== 'normal') return 'bx';
    return '';
  }
  function recentHTML(inn) {
    const list = E.recentDeliveries(inn, 6);
    if (!list.length) return '';
    let html = '', over = list[0].over;
    list.forEach(d => {
      if (d.over !== over) { html += '<span class="ball sep" aria-hidden="true"></span>'; over = d.over; }
      html += `<span class="ball ${ballClass(d)}">${esc(d.label)}</span>`;
    });
    return `<div class="balls" aria-label="Last six balls"><span class="lbl">Last 6</span>${html}</div>`;
  }

  function creaseHTML(st, inn) {
    const batColor = st.config.teams[inn.battingTeam].color, bowlColor = st.config.teams[inn.bowlingTeam].color;
    const batRow = (id, onStrike) => {
      if (!id) return `<div class="p"><span class="role" aria-hidden="true"></span><span class="nm muted">${inn.complete ? '—' : 'Awaiting batter'}</span></div>`;
      const b = inn.batters[id];
      return `<div class="p"><span class="role" aria-hidden="true">${onStrike ? '▶' : ''}</span>${avatar(id, b.name, 'sm', batColor)}
        <span class="nm ${onStrike ? 'on' : ''}">${esc(b.name)}${onStrike ? ' *' : ''}</span>
        <span class="fig">${b.runs} <span class="muted small">(${b.balls})</span></span>
        <span class="ex">${b.fours} · ${b.sixes} · ${Math.round(E.strikeRate(b.runs, b.balls))}</span></div>`;
    };
    const bid = inn.bowler || inn.lastOverBowler;
    const bw = bid ? inn.bowlers[bid] : null;
    const p = inn.partnerships[inn.partnerships.length - 1];
    return `<section class="card crease" aria-label="At the crease">
      <div class="hd"><span>Batters</span><span>R (B)</span><span style="min-width:78px;text-align:right">4s · 6s · SR</span></div>
      ${batRow(inn.striker, true)}${inn.nonStriker || !inn.striker || availableCount(st, inn) ? batRow(inn.nonStriker, false) : ''}
      ${bw ? `<div class="hd"><span>Bowler</span><span>O-M-R-W</span><span style="min-width:78px;text-align:right">Econ</span></div><div class="p"><span class="role" aria-hidden="true">◉</span>${avatar(bw.id, bw.name, 'sm', bowlColor)}<span class="nm">${esc(bw.name)}${inn.bowler ? '' : ' <span class="muted small">(last over)</span>'}</span>
        <span class="fig">${E.oversShort(bw.balls)}-${bw.maidens}-${bw.runs}-${bw.wickets}</span><span class="ex">${fmt2(E.rate(bw.runs, bw.balls))}</span></div>` : ''}
    </section>`;
  }
  function availableCount(st, inn) { return E.availableBatters(st, inn).length; }

  function padHTML(m) {
    const runBtn = (r, cls, sub) => `<button class="k ${cls || ''}" data-act="run" data-r="${r}" aria-label="${r === 0 ? 'Dot ball' : plural(r, 'run')}">${r}<small>${sub}</small></button>`;
    return `<div class="pad" role="group" aria-label="Scoring buttons">
      ${runBtn(0, '', 'dot')}${runBtn(1, '', 'run')}${runBtn(2, '', 'runs')}${runBtn(3, '', 'runs')}
      ${runBtn(4, 'k4', 'four')}${runBtn(6, 'k6', 'six')}
      <button class="k kx" data-act="extra" data-k="wd" aria-label="Wide">WD<small>wide</small></button>
      <button class="k kx" data-act="extra" data-k="nb" aria-label="No-ball">NB<small>no-ball</small></button>
      <button class="k kx" data-act="extra" data-k="b" aria-label="Byes">BYE<small>byes</small></button>
      <button class="k kx" data-act="extra" data-k="lb" aria-label="Leg byes">LB<small>leg bye</small></button>
      <button class="k kw" data-act="wicket" aria-label="Wicket">OUT<small>wicket</small></button>
      <button class="k ku" data-act="undo" aria-label="Undo last ball" ${m.events.length ? '' : 'disabled'}>↶<small>undo</small></button>
    </div>
    <div class="subpad">
      <button class="btn" data-act="swap">⇄ Swap strike</button>
      <button class="btn" data-act="other-runs">5 / 7 runs</button>
      <button class="btn" data-act="scorecard">Scorecard</button>
    </div>`;
  }

  function openersHTML(st, inn) {
    const bat = E.playersOf(st, inn.battingTeam), bowl = E.playersOf(st, inn.bowlingTeam);
    const opt = (list, sel) => `<option value="">Select…</option>` + list.map(p => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const tBat = st.config.teams[inn.battingTeam], tBowl = st.config.teams[inn.bowlingTeam];
    let intro = '';
    if (inn.index > 0) {
      const prev = st.innings[inn.index - 1];
      const tPrev = st.config.teams[prev.battingTeam];
      intro = inn.target != null
        ? `<section class="card result-card" style="padding:16px"><div class="small muted">${inn.isSuper ? 'Super Over' : 'Innings break'}</div>
            <h2>${esc(tPrev.name)} ${prev.runs}/${prev.wickets} <span class="muted small">(${E.oversStr(prev.legalBalls)} ov)</span></h2>
            <div>${esc(tBat.name)} need <b style="color:var(--brand)">${inn.target}</b> to win from ${inn.maxBalls} balls</div></section>`
        : `<section class="card result-card" style="padding:16px"><div class="trophy" aria-hidden="true">⚡</div><h2>Super Over</h2><div>${esc(tBat.name)} bat first · 1 over · 2 wickets</div></section>`;
    }
    const firstTwo = bat.slice(0, 2).map(p => p.id);
    return `${intro}<section class="card prompt">
      <h2>${inn.index === 0 ? 'Openers' : 'Openers — ' + esc(tBat.name)}</h2>
      <p class="hint" style="margin:0 0 12px">${esc(tBat.name)} batting · ${esc(tBowl.name)} bowling${st.config.toss && inn.index === 0 ? ` · ${esc(st.config.teams[st.config.toss.winner].name)} won the toss and chose to ${st.config.toss.decision}` : ''}</p>
      <label class="field"><span>Striker (faces first ball)</span><select id="op-s">${opt(bat, firstTwo[0])}</select></label>
      <label class="field"><span>Non-striker</span><select id="op-ns">${opt(bat, firstTwo[1])}</select></label>
      <label class="field"><span>Opening bowler</span><select id="op-b">${opt(bowl, null)}</select></label>
      <button class="btn primary block lg" data-act="start-innings">Start ${inn.isSuper ? 'Super Over' : (inn.index === 0 ? 'match' : '2nd innings')}</button>
      <div class="btn-row" style="margin-top:8px">
        ${inn.index === 0 ? '<a class="btn" href="#/edit">Edit match settings</a>' : '<button class="btn" data-act="undo">↶ Undo last ball</button>'}
      </div>
    </section>`;
  }

  function batterPromptHTML(st, inn) {
    const avail = E.availableBatters(st, inn);
    const last = inn.deliveries[inn.deliveries.length - 1];
    const wasWicket = last && last.wicket && inn.fow.length && inn.fow[inn.fow.length - 1].batter === last.out;
    const defaultStrike = !inn.striker;
    return `<section class="card prompt">
      <h2>${wasWicket ? 'Wicket! ' : ''}Select the next batter</h2>
      <p class="hint" style="margin:0 0 10px">${wasWicket ? esc(inn.batters[last.out].name) + ' ' + esc(inn.batters[last.out].howOut) + ' · ' : ''}${inn.runs}/${inn.wickets}</p>
      <div class="choices">${avail.map(id => {
        const b = inn.batters[id];
        return `<button class="choice with-ava" data-act="pick-batter" data-id="${esc(id)}">${avatar(id, st.names[id], 'md', st.config.teams[inn.battingTeam].color)}<span>${esc(st.names[id])}${b && b.retiredHurt ? `<small>Retired hurt on ${b.runs} — returning</small>` : ''}</span></button>`;
      }).join('')}</div>
      ${inn.striker || inn.nonStriker ? `<label class="check"><input type="checkbox" id="nb-strike" ${defaultStrike ? 'checked' : ''}> New batter faces the next ball</label>` : ''}
      <div class="btn-row" style="margin-top:6px"><button class="btn" data-act="undo">↶ Undo last ball</button></div>
    </section>`;
  }

  function bowlerPromptHTML(st, inn) {
    const overNo = Math.floor(inn.legalBalls / 6);
    const list = E.playersOf(st, inn.bowlingTeam).map(p => {
      const block = E.bowlerBlock(st, inn, p.id);
      const b = inn.bowlers[p.id];
      const fig = b ? `${E.oversShort(b.balls)}-${b.maidens}-${b.runs}-${b.wickets}` : 'Yet to bowl';
      const why = block ? (/previous over/.test(block) ? 'Bowled last over' : /maximum/.test(block) ? 'Max overs bowled' : block) : fig;
      return { p, block, why, bowled: b ? b.balls : -1 };
    }).sort((a, b) => (!!a.block - !!b.block) || (b.bowled - a.bowled));
    return `<section class="card prompt">
      <h2>${overNo ? `End of over ${overNo} — next bowler` : 'Select the bowler'}</h2>
      <p class="hint" style="margin:0 0 10px">${inn.runs}/${inn.wickets} after ${E.oversStr(inn.legalBalls)} overs${st.config.maxOversPerBowler ? ` · max ${st.config.maxOversPerBowler} overs each` : ''}</p>
      <div class="choices">${list.map(x => `<button class="choice with-ava" data-act="pick-bowler" data-id="${esc(x.p.id)}" ${x.block ? 'disabled' : ''}>${avatar(x.p.id, x.p.name, 'md', st.config.teams[inn.bowlingTeam].color)}<span>${esc(x.p.name)}<small>${esc(x.why)}</small></span></button>`).join('')}</div>
      <div class="btn-row" style="margin-top:10px"><button class="btn" data-act="undo">↶ Undo last ball</button></div>
    </section>`;
  }

  function resultHTML(st, m) {
    const r = st.result || {};
    const icon = r.abandoned ? '⛔' : r.tie ? '🤝' : '🏆';
    const lines = st.innings.filter(i => i.started).map(i => `${esc(E.inningsTitle(st, i))} ${i.runs}/${i.wickets} (${E.oversStr(i.legalBalls)})`).join('<br>');
    return `<section class="card result-card">
      <div class="trophy" aria-hidden="true">${icon}</div>
      <h2>${esc(r.text || 'Match over')}</h2>
      <p class="muted">${lines}</p>
      <div class="btn-row">
        ${r.canSuperOver ? '<button class="btn primary lg block" data-act="super-over">⚡ Play Super Over</button>' : ''}
        <a class="btn ${r.canSuperOver ? '' : 'primary'} lg" href="#/match/${encodeURIComponent(m.id)}">Full scorecard</a>
        <a class="btn lg" href="#/rematch/${encodeURIComponent(m.id)}">Rematch</a>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn" data-act="undo">↶ Undo last ball</button>
        <button class="btn" data-act="finish">Done</button>
      </div>
    </section>`;
  }

  // ---------- scoring dialogs ----------
  function runsGrid(values, act, labeler) {
    return `<div class="runs-grid">${values.map(v => `<button class="btn" data-on="${act}" data-r="${v}">${labeler ? labeler(v) : v}</button>`).join('')}</div>`;
  }

  function extrasDialog(kind) {
    const cfg = app.state.config;
    if (kind === 'wd') {
      return sheet({
        title: 'Wide',
        render: () => `<div class="lbl">Runs taken on the wide (plus ${plural(cfg.rules.wideRuns, 'wide run')})</div>
          ${runsGrid([0, 1, 2, 3, 4, 5], 'r', v => (v === 0 ? 'Wide' : v === 4 ? '+4 ⟶' : '+' + v))}
          <p class="hint">+4 ⟶ = the wide went to the boundary. All runs off a wide count as wides.</p>
          <div class="lbl">Wicket on this wide?</div><button class="btn danger block" data-on="w">Stumped / run out on a wide</button>`,
        on: {
          r: (el, api) => { api.close(); addEvent({ type: 'ball', kind: 'wd', runs: +el.dataset.r }); },
          w: (el, api) => { api.close(); wicketDialog('wd'); },
        },
      });
    }
    if (kind === 'nb') {
      return sheet({
        title: 'No-ball',
        state: { nbType: 'bat' },
        render: s => `<div class="lbl">Runs scored off</div>
          <div class="seg">${[['bat', 'Bat'], ['b', 'Byes'], ['lb', 'Leg byes']].map(([v, l]) => `<button data-on="t" data-v="${v}" class="${s.nbType === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="lbl">Runs (plus ${plural(cfg.rules.noBallRuns, 'no-ball run')})</div>
          ${runsGrid([0, 1, 2, 3, 4, 6, 5], 'r', v => (v === 0 ? 'NB' : '+' + v))}
          <p class="hint">${s.nbType === 'bat' ? '4 and 6 off the bat count as boundaries for the batter.' : 'Byes/leg byes off a no-ball are not charged to the bowler.'}${cfg.rules.freeHit ? ' Next ball is a free hit.' : ''}</p>
          <div class="lbl">Wicket on this no-ball?</div><button class="btn danger block" data-on="w">Run out on a no-ball</button>`,
        on: {
          t: (el, api) => { api.state.nbType = el.dataset.v; api.render(); },
          r: (el, api) => { api.close(); addEvent({ type: 'ball', kind: 'nb', runs: +el.dataset.r, nbType: api.state.nbType }); },
          w: (el, api) => { api.close(); wicketDialog('nb'); },
        },
      });
    }
    const name = kind === 'b' ? 'Byes' : 'Leg byes';
    return sheet({
      title: name,
      render: () => `<div class="lbl">${name} taken</div>${runsGrid([1, 2, 3, 4, 5], 'r', v => (v === 4 ? '4 ⟶' : v))}
        <p class="hint">Counts as a legal ball. Runs go to extras, not to the batter or bowler.</p>
        <div class="lbl">Wicket while running?</div><button class="btn danger block" data-on="w">Run out on ${name.toLowerCase()}</button>`,
      on: {
        r: (el, api) => { api.close(); addEvent({ type: 'ball', kind, runs: +el.dataset.r }); },
        w: (el, api) => { api.close(); wicketDialog(kind); },
      },
    });
  }

  function wicketDialog(delivery) {
    const st = app.state;
    const inn = st.innings[st.current];
    const cfg = st.config;
    const bowlTeam = cfg.teams[inn.bowlingTeam];
    const DEL = [['normal', 'Legal'], ['wd', 'Wide'], ['nb', 'No-ball'], ['b', 'Bye'], ['lb', 'Leg bye']];
    const NEEDS_FIELDER = ['caught', 'run out', 'stumped'];
    return sheet({
      title: 'Wicket',
      state: { delivery: delivery || 'normal', kind: null, out: inn.striker, fielder: '', runs: 0, nbType: 'bat' },
      render: s => {
        const freeHit = cfg.rules.freeHit && inn.freeHit;
        const allowed = E.WICKETS_ON[s.delivery].filter(k => !freeHit || E.FREE_HIT_OK.includes(k));
        if (s.kind && !allowed.includes(s.kind)) s.kind = null;
        const showWho = s.kind && E.NON_STRIKER_OUT.includes(s.kind) && inn.nonStriker;
        if (!showWho) s.out = inn.striker;
        const showRuns = s.kind === 'run out' || s.kind === 'obstructing' || s.delivery !== 'normal';
        if (!showRuns) s.runs = 0;
        if (s.kind === 'stumped' && !s.fielder && bowlTeam.keeper) s.fielder = bowlTeam.keeper;
        return `<div class="lbl">Delivery</div>
          <div class="seg">${DEL.map(([v, l]) => `<button data-on="del" data-v="${v}" class="${s.delivery === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          ${freeHit ? '<p class="hint freehit">Free hit — only run out is possible.</p>' : ''}
          <div class="lbl">How out</div>
          <div class="choices">${E.DISMISSALS.filter(d => allowed.includes(d.id)).map(d => `<button class="choice ${s.kind === d.id ? 'sel' : ''}" data-on="kind" data-v="${d.id}">${d.label}</button>`).join('')}</div>
          ${showWho ? `<div class="lbl">Who is out</div><div class="seg">
            <button data-on="who" data-v="${esc(inn.striker)}" class="${s.out === inn.striker ? 'on' : ''}">${esc(st.names[inn.striker])} (striker)</button>
            <button data-on="who" data-v="${esc(inn.nonStriker)}" class="${s.out === inn.nonStriker ? 'on' : ''}">${esc(st.names[inn.nonStriker])}</button></div>` : ''}
          ${s.kind && NEEDS_FIELDER.includes(s.kind) ? `<div class="lbl">${s.kind === 'stumped' ? 'Wicketkeeper' : 'Fielder'} (optional)</div>
            <select data-change="fielder" aria-label="Fielder"><option value="">Not recorded</option>${bowlTeam.players.map(p => `<option value="${esc(p.id)}" ${s.fielder === p.id ? 'selected' : ''}>${esc(p.name)}${p.id === inn.bowler ? ' (bowler)' : ''}</option>`).join('')}</select>` : ''}
          ${showRuns ? `<div class="lbl">Runs completed before the wicket</div>
            <div class="seg">${[0, 1, 2, 3].map(r => `<button data-on="runs" data-v="${r}" class="${s.runs === r ? 'on' : ''}">${r}</button>`).join('')}</div>` : ''}
          ${s.delivery === 'nb' && s.runs > 0 ? `<div class="lbl">Runs off</div><div class="seg">${[['bat', 'Bat'], ['b', 'Byes'], ['lb', 'Leg byes']].map(([v, l]) => `<button data-on="nbt" data-v="${v}" class="${s.nbType === v ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
          <div class="sheet-actions"><button class="btn" data-close>Cancel</button>
            <button class="btn danger solid" data-on="save" ${s.kind ? '' : 'disabled'}>Record wicket</button></div>`;
      },
      on: {
        del: (el, api) => { api.state.delivery = el.dataset.v; api.render(); },
        kind: (el, api) => { api.state.kind = el.dataset.v; api.render(); },
        who: (el, api) => { api.state.out = el.dataset.v; api.render(); },
        runs: (el, api) => { api.state.runs = +el.dataset.v; api.render(); },
        nbt: (el, api) => { api.state.nbType = el.dataset.v; api.render(); },
        fielder: (el, api) => { api.state.fielder = el.value; },
        save: (el, api) => {
          const s = api.state;
          const ev = { type: 'ball', kind: s.delivery, runs: s.runs, wicket: { kind: s.kind, out: s.out, fielder: s.fielder || null } };
          if (s.delivery === 'nb') ev.nbType = s.nbType;
          if (s.runs === 4 || s.runs === 6) ev.boundary = false;
          if (addEvent(ev)) api.close();
        },
      },
    });
  }

  function otherRunsDialog() {
    return sheet({
      title: 'Other runs off the bat',
      render: () => `<div class="lbl">All run / overthrows (not a boundary)</div>${runsGrid([4, 5, 6, 7], 'r')}
        <div class="lbl">Overthrow to the boundary</div>${runsGrid([5, 7], 'rb', v => v + ' ⟶')}
        <p class="hint">Odd numbers change the strike. For extras use WD / NB / BYE / LB.</p>`,
      on: {
        r: (el, api) => { api.close(); addEvent({ type: 'ball', kind: 'normal', runs: +el.dataset.r, boundary: false }); },
        rb: (el, api) => { api.close(); addEvent({ type: 'ball', kind: 'normal', runs: +el.dataset.r, boundary: false }); },
      },
    });
  }

  function pickerSheet(title, items, hint) {
    return sheet({
      title,
      render: () => `${hint ? `<p class="hint" style="margin-top:0">${hint}</p>` : ''}<div class="choices">${items.map(x => `<button class="choice" data-on="pick" data-id="${esc(x.id)}" ${x.disabled ? 'disabled' : ''}>${esc(x.label)}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</button>`).join('')}</div>`,
      on: { pick: (el, api) => api.close(el.dataset.id) },
    });
  }

  function moreSheet() {
    const m = app.match, st = app.state;
    const inn = st.innings[st.current];
    const active = isActive(st);
    const scoring = active && inn.started;
    const item = (act, label, opts) => `<button class="btn block ${opts && opts.cls ? opts.cls : ''}" data-on="go" data-a="${act}" style="justify-content:flex-start;margin-bottom:8px" ${opts && opts.disabled ? 'disabled' : ''}>${label}</button>`;
    return sheet({
      title: 'Match options',
      render: () => [
        item('scorecard', '📋 Full scorecard'),
        item('share', '📤 Share live score'),
        scoring ? item('change-bowler', '🔁 Change bowler (injury / mid-over)', { disabled: !inn.bowler }) : '',
        scoring ? item('retire', '🩹 Retire a batter') : '',
        scoring ? item('adjust', '✏️ Correct the score (penalty / fix)') : '',
        active && !hasBalls(m) ? item('edit', '⚙️ Edit match settings') : '',
        active ? item('pause', m.paused ? '▶️ Resume match' : '⏸ Pause match') : '',
        scoring ? item('end-innings', '🏁 End this innings now', { cls: 'danger' }) : '',
        active && inn.index > 0 || scoring ? item('reset-innings', '♻️ Reset this innings', { cls: 'danger' }) : '',
        active ? item('abandon', '⛔ Abandon match', { cls: 'danger' }) : '',
      ].join(''),
      on: { go: (el, api) => { api.close(); moreAction(el.dataset.a); } },
    });
  }

  async function moreAction(a) {
    const m = app.match, st = app.state;
    const inn = st.innings[st.current];
    switch (a) {
      case 'scorecard': go('#/match/' + encodeURIComponent(m.id)); break;
      case 'share': await shareText(st.config.name, E.shareText(st, m)); break;
      case 'edit': go('#/edit'); break;
      case 'pause': togglePause(); break;
      case 'change-bowler': {
        const items = E.playersOf(st, inn.bowlingTeam).filter(p => p.id !== inn.bowler).map(p => {
          const block = E.bowlerBlock(st, inn, p.id);
          return { id: p.id, label: p.name, sub: block || '', disabled: !!block };
        });
        const id = await pickerSheet('Change bowler', items, inn.overDeliveries ? 'The new bowler finishes this over. No maiden is credited for a shared over.' : '');
        if (id) addEvent({ type: 'set_bowler', bowler: id });
        break;
      }
      case 'retire': {
        const items = [inn.striker, inn.nonStriker].filter(Boolean).map(id => ({ id, label: st.names[id], sub: `${inn.batters[id].runs} (${inn.batters[id].balls})` }));
        const id = await pickerSheet('Retire which batter?', items);
        if (!id) break;
        const kind = await sheet({
          title: `Retire ${st.names[id]}`,
          render: () => `<p class="muted" style="margin-top:0">Retired hurt is not a wicket and the batter can return later. Retired out counts as a wicket (e.g. a “retire at 30” rule).</p>
            <div class="sheet-actions"><button class="btn" data-on="k" data-v="hurt">Retired hurt</button><button class="btn danger" data-on="k" data-v="out">Retired out</button></div>`,
          on: { k: (el, api) => api.close(el.dataset.v) },
        });
        if (kind) addEvent({ type: 'retire', batter: id, kind });
        break;
      }
      case 'adjust': {
        const res = await sheet({
          title: 'Correct the score',
          render: () => `<p class="muted" style="margin-top:0">Adds (or removes) runs as penalty extras — for umpire penalties or to fix a missed run. It shows in the extras and can be undone.</p>
            <label class="field"><span>Runs (use a minus sign to remove)</span><input type="number" id="adj-r" inputmode="numeric" placeholder="e.g. 5 or -1" autofocus></label>
            <label class="field"><span>Reason (optional)</span><input type="text" id="adj-n" maxlength="80" placeholder="e.g. 5 penalty runs"></label>
            <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-on="ok">Apply</button></div>`,
          on: { ok: (el, api) => api.close({ runs: Number($('#adj-r', api.body).value), note: $('#adj-n', api.body).value }) },
        });
        if (!res) break;
        if (!Number.isInteger(res.runs) || res.runs === 0) { toast('Enter a whole number of runs, not 0', 'error'); break; }
        const ok = await confirmDialog(`${res.runs > 0 ? 'Add' : 'Remove'} <b>${Math.abs(res.runs)}</b> run${Math.abs(res.runs) === 1 ? '' : 's'} ${res.runs > 0 ? 'to' : 'from'} ${esc(st.config.teams[inn.battingTeam].name)}'s total?`, { title: 'Confirm correction', ok: 'Apply correction' });
        if (ok) addEvent({ type: 'adjust', runs: res.runs, note: res.note });
        break;
      }
      case 'end-innings': {
        const ok = await confirmDialog(`End ${esc(st.config.teams[inn.battingTeam].name)}'s innings at <b>${inn.runs}/${inn.wickets}</b> (${E.oversStr(inn.legalBalls)} ov)?${inn.index % 2 ? ' The match result will be decided now.' : ''}`, { title: 'End innings?', ok: 'End innings', danger: true });
        if (ok) addEvent({ type: 'end_innings', reason: 'declared' });
        break;
      }
      case 'reset-innings': {
        const ok = await confirmDialog(`This clears <b>every ball</b> of the current innings (${inn.runs}/${inn.wickets}). Earlier innings are kept. This can't be undone.`, { title: 'Reset this innings?', ok: 'Reset innings', danger: true, typed: 'RESET' });
        if (!ok) break;
        if (commit(E.resetCurrentInnings(app.match))) { toast('Innings reset', 'ok'); renderLive(); }
        break;
      }
      case 'abandon': {
        const ok = await confirmDialog('Abandon this match? It will be saved as “no result” and no winner will be declared. You can still undo this.', { title: 'Abandon match?', ok: 'Abandon', danger: true });
        if (ok) addEvent({ type: 'abandon' });
        break;
      }
      default: break;
    }
  }

  function togglePause() {
    const m = app.match;
    m.paused = !m.paused;
    if (saveMeta(m)) { toast(m.paused ? 'Match paused' : 'Match resumed'); renderLive(); }
  }

  // =====================================================================
  // SCORECARD
  // =====================================================================
  function viewScorecard(id) {
    const m = app.match && app.match.id === id ? app.match : store.getMatch(id);
    if (!m) { view().innerHTML = topbar('Scorecard', { back: '#/history' }) + '<div class="card empty"><b>Match not found</b>It may have been deleted.</div>'; return; }
    let st;
    try { st = E.replay(m); } catch (err) { view().innerHTML = topbar('Scorecard', { back: '#/history' }) + errorCard(err.message); return; }
    app.sc = { match: m, state: st };
    const cfg = st.config;
    const active = isActive(st);
    const isCurrent = store.getCurrentId() === m.id;
    const aw = E.awards(st);
    const allPlayers = cfg.teams.flatMap((t, ti) => t.players.map(p => ({ p, ti })));
    const potmOpts = allPlayers.map(({ p, ti }) => `<option value="${esc(p.id)}" ${m.potm === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(cfg.teams[ti].name)})</option>`).join('');
    const resultText = st.result ? st.result.text : (st.status === 'abandoned' ? 'Abandoned' : 'In progress');
    const started = st.innings.filter(i => i.started);
    // Tabs: one per innings + Summary. Live matches open on the current innings, finished ones on Summary.
    const short = n => (n.length > 11 ? n.split(/\s+/)[0].slice(0, 11) : n);
    const tabs = started.map(i => ({ id: 'i' + i.index, label: i.isSuper ? `SO · ${initials(cfg.teams[i.battingTeam].name)}` : short(cfg.teams[i.battingTeam].name) }))
      .concat(started.length ? [{ id: 'rep', label: 'Report' }] : [], [{ id: 'sum', label: 'Summary' }]);
    if (!app.scTab || app.scTab.id !== m.id || !tabs.some(t => t.id === app.scTab.tab)) {
      app.scTab = { id: m.id, tab: active && started.length ? 'i' + st.current : 'sum' };
    }
    const potmPlayer = m.potm ? allPlayers.find(x => x.p.id === m.potm) : null;
    const summaryHTML = () => `
      ${st.status === 'complete' ? `<section class="card"><div class="potm"><div style="flex:1;min-width:0">
          <div class="lbl2">Player Of The Match</div>
          <div class="who">${potmPlayer ? esc(potmPlayer.p.name) : '<span class="muted" style="font-weight:500;font-size:17px">Not selected yet</span>'}
            ${potmPlayer ? `<small>${esc(cfg.teams[potmPlayer.ti].name)}</small>` : ''}</div></div>
          ${potmPlayer ? `<button class="ava-btn" data-act="player" data-id="${esc(potmPlayer.p.id)}" aria-label="Open ${esc(potmPlayer.p.name)}'s profile">${avatar(potmPlayer.p.id, potmPlayer.p.name, 'lg', cfg.teams[potmPlayer.ti].color)}</button>` : ''}</div>
        <label class="field" style="margin:14px 0 0"><span>Choose Player of the Match</span><select id="potm"><option value="">Not selected</option>${potmOpts}</select></label></section>
        <section class="card"><h2>Awards</h2><div class="awards">
          <div class="award"><span>Best batter</span><b>${aw.bestBatter ? `${esc(aw.bestBatter.name)} ${aw.bestBatter.runs} (${aw.bestBatter.balls})` : '—'}</b></div>
          <div class="award"><span>Best bowler</span><b>${aw.bestBowler ? `${esc(aw.bestBowler.name)} ${aw.bestBowler.wickets}/${aw.bestBowler.runs}` : '—'}</b></div></div></section>` : ''}
      <section class="card"><h2>Match info</h2>
        <div class="kv"><span>Date</span><b>${esc(fmtDate(cfg.date))}</b></div>
        ${cfg.venue ? `<div class="kv"><span>Venue</span><b>${esc(cfg.venue)}</b></div>` : ''}
        <div class="kv"><span>Toss</span><b>${esc(cfg.teams[cfg.toss.winner].name)}, chose to ${cfg.toss.decision}</b></div>
        <div class="kv"><span>Format</span><b>${cfg.overs} overs · ${cfg.playersPerSide}-a-side · ${esc(cfg.ballType)}</b></div></section>
      <section class="card"><h2>Share & export</h2>
        <div class="grid2">
          <button class="btn" data-act="sc-share">📤 Share score</button>
          <button class="btn" data-act="sc-copy">📋 Copy summary</button>
          <button class="btn" data-act="sc-image">🖼️ Scorecard image</button>
          <button class="btn" data-act="sc-csv">⬇️ Export CSV</button>
          <a class="btn" href="#/rematch/${encodeURIComponent(m.id)}">🔁 Rematch</a>
          <button class="btn" data-act="sc-json">💾 Save match file</button>
        </div></section>
      <button class="btn danger block" data-act="sc-delete" style="margin-top:4px">Delete this match</button>`;
    const tabBody = () => {
      if (app.scTab.tab === 'sum') return summaryHTML();
      if (app.scTab.tab === 'rep') return reportHTML(st);
      const inn = st.innings[+app.scTab.tab.slice(1)];
      return inn ? inningsCardHTML(st, inn) : '';
    };
    const draw = () => {
      $('#sc-tabs').innerHTML = tabs.map(t => `<button role="tab" aria-selected="${t.id === app.scTab.tab}" class="${t.id === app.scTab.tab ? 'on' : ''}" data-tab="${t.id}">${esc(t.label)}</button>`).join('');
      $('#sc-body').innerHTML = tabBody();
      $('#sc-body').onclick = e => {
        const hit = e.target.closest('[data-ov-tip]');
        if (hit) { const tip = hit.closest('.chart-card').querySelector('.chart-tip'); if (tip) tip.textContent = hit.dataset.ovTip; }
      };
      const potm = $('#potm');
      if (potm) potm.addEventListener('change', () => {
        m.potm = potm.value || null;
        if (saveMeta(m)) { if (app.match && app.match.id === m.id) app.match.potm = m.potm; toast('Player of the Match saved', 'ok'); viewScorecard(id); }
      });
    };
    view().innerHTML = `
      ${topbar('Scorecard', { back: active && isCurrent ? '#/live' : '#/history', sub: cfg.name })}
      <section class="card">${matchCardHTML(st, {
        title: active ? 'Live' : (st.status === 'abandoned' ? 'Abandoned' : 'Result'),
        pill: active ? '<span class="pill live">Live</span>' : '',
        sub: [`${cfg.overs} overs`, fmtDate(cfg.date), cfg.venue].filter(Boolean).join(' · '),
        result: active ? null : resultText,
      })}
      ${active ? `<button class="btn primary lg block" style="margin-top:14px" data-act="resume" data-id="${esc(m.id)}">${isCurrent ? 'Back to live scoring' : 'Resume scoring this match'}</button>` : ''}</section>
      <div class="tabs" role="tablist" id="sc-tabs"></div>
      <div id="sc-body"></div>`;
    $('#sc-tabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      app.scTab.tab = b.dataset.tab;
      draw();
    });
    draw();
  }

  // ---------- Report tab: worm + Manhattan charts and over-by-over list ----------
  // Per-over summary of one innings, from the ball-by-ball record.
  function overSummary(inn) {
    const list = [];
    let cum = 0, wk = 0;
    inn.deliveries.forEach(d => {
      const o = list[d.over] || (list[d.over] = { over: d.over, runs: 0, wkts: 0, legal: 0, balls: [], bowler: d.bowler });
      if (d.legal) o.legal++;
      o.runs += d.teamRuns;
      if (d.wicket) o.wkts++;
      o.balls.push(d);
    });
    return list.filter(Boolean).map(o => { cum += o.runs; wk += o.wkts; return Object.assign(o, { cum, cumW: wk }); });
  }
  const niceMax = v => { const step = v <= 30 ? 10 : v <= 120 ? 20 : 50; return Math.max(step, Math.ceil(v / step) * step); };
  const ink = { grid: '#e6eaf2', axis: '#a3abbd', text: '#7b8499', strong: '#1b2236', surface: '#ffffff' };

  // Cumulative runs per over for both main innings; second team dashed so identity is not colour-only.
  function wormSVG(st, list) {
    const W = 340, H = 210, L = 34, R = 56, T = 12, B = 26;
    const maxO = Math.max(...list.map(x => x.inn.maxOvers));
    const maxR = niceMax(Math.max(10, ...list.map(x => (x.ov.length ? x.ov[x.ov.length - 1].cum : 0))));
    const xs = o => L + (o / maxO) * (W - L - R), ys = r => T + (1 - r / maxR) * (H - T - B);
    let g = '';
    for (let r = 0; r <= maxR; r += maxR / 4) g += `<line x1="${L}" x2="${W - R}" y1="${ys(r)}" y2="${ys(r)}" stroke="${ink.grid}"/><text x="${L - 6}" y="${ys(r) + 3}" text-anchor="end" font-size="10" fill="${ink.text}">${Math.round(r)}</text>`;
    const tickStep = maxO <= 10 ? 1 : maxO <= 20 ? 2 : 5;
    for (let o = 0; o <= maxO; o += tickStep) g += `<text x="${xs(o)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${ink.text}">${o}</text>`;
    let lines = '', marks = '', labels = '';
    list.forEach((x, k) => {
      const c = x.team.color || '#0d47c5';
      const pts = [[0, 0]].concat(x.ov.map(o => [o.over + Math.min(o.legal, 6) / 6, o.cum]));
      lines += `<polyline fill="none" stroke="${esc(c)}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" ${k ? 'stroke-dasharray="6 4"' : ''} points="${pts.map(p => `${xs(p[0]).toFixed(1)},${ys(p[1]).toFixed(1)}`).join(' ')}"/>`;
      x.ov.filter(o => o.wkts).forEach(o => {
        marks += `<circle cx="${xs(o.over + Math.min(o.legal, 6) / 6)}" cy="${ys(o.cum)}" r="5" fill="${esc(c)}" stroke="${ink.surface}" stroke-width="2"><title>${esc(x.team.name)}: wicket in over ${o.over + 1}</title></circle>`;
      });
      const last = pts[pts.length - 1];
      labels += `<text x="${xs(last[0]) + 7}" y="${ys(last[1]) + 4 + (k && list.length > 1 && Math.abs(ys(last[1]) - ys(list[0].ov.length ? list[0].ov[list[0].ov.length - 1].cum : 0)) < 12 ? 12 : 0)}" font-size="11" font-weight="600" fill="${ink.strong}">${esc(initials(x.team.name))} ${last[1]}</text>`;
    });
    // invisible per-over hit columns (tap to read the values)
    let hits = '';
    for (let o = 1; o <= maxO; o++) {
      const vals = list.map(x => { const ov = x.ov.find(v => v.over === o - 1); return ov ? `${x.team.name} ${ov.cum}/${ov.cumW}` : null; }).filter(Boolean);
      if (!vals.length) continue;
      const w = (W - L - R) / maxO;
      hits += `<rect x="${xs(o) - w / 2}" y="${T}" width="${w}" height="${H - T - B}" fill="transparent" data-ov-tip="${esc(`After over ${o}: ${vals.join(' · ')}`)}"><title>${esc(`After over ${o}: ${vals.join(' · ')}`)}</title></rect>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Worm chart: cumulative runs per over">${g}<line x1="${L}" x2="${W - R}" y1="${ys(0)}" y2="${ys(0)}" stroke="${ink.axis}"/>${lines}${marks}${labels}${hits}</svg>`;
  }

  // Runs per over as bars (4px rounded tops anchored to the baseline), with wicket markers above.
  function manhattanSVG(team, inn, ov) {
    const W = 340, H = 170, L = 28, R = 8, T = 18, B = 24;
    const maxR = niceMax(Math.max(6, ...ov.map(o => o.runs)));
    const slot = (W - L - R) / inn.maxOvers;
    const bw = Math.max(4, Math.min(28, slot - 2));
    const ys = r => T + (1 - r / maxR) * (H - T - B);
    const c = team.color || '#0d47c5';
    let g = '';
    for (let r = 0; r <= maxR; r += maxR / 2) g += `<line x1="${L}" x2="${W - R}" y1="${ys(r)}" y2="${ys(r)}" stroke="${ink.grid}"/><text x="${L - 6}" y="${ys(r) + 3}" text-anchor="end" font-size="10" fill="${ink.text}">${Math.round(r)}</text>`;
    let bars = '';
    ov.forEach(o => {
      const x = L + o.over * slot + (slot - bw) / 2, y = ys(o.runs), h = ys(0) - y;
      const rad = Math.min(4, h, bw / 2);
      const tip = `Over ${o.over + 1}: ${plural(o.runs, 'run')}${o.wkts ? `, ${plural(o.wkts, 'wicket')}` : ''}`;
      if (h > 0) bars += `<path d="M${x},${ys(0)} V${y + rad} Q${x},${y} ${x + rad},${y} H${x + bw - rad} Q${x + bw},${y} ${x + bw},${y + rad} V${ys(0)} Z" fill="${esc(c)}"/>`;
      for (let k = 0; k < o.wkts; k++) bars += `<circle cx="${x + bw / 2}" cy="${y - 7 - k * 11}" r="4.5" fill="${ink.strong}" stroke="${ink.surface}" stroke-width="1.5"/>`;
      bars += `<rect x="${L + o.over * slot}" y="${T - 14}" width="${slot}" height="${H - T - B + 14}" fill="transparent" data-ov-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>`;
    });
    const step = inn.maxOvers <= 10 ? 1 : inn.maxOvers <= 20 ? 2 : 5;
    let xl = '';
    for (let o = step; o <= inn.maxOvers; o += step) xl += `<text x="${L + (o - 0.5) * slot}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${ink.text}">${o}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(team.name)} runs per over">${g}<line x1="${L}" x2="${W - R}" y1="${ys(0)}" y2="${ys(0)}" stroke="${ink.axis}"/>${bars}${xl}</svg>`;
  }

  function reportHTML(st) {
    const cfg = st.config;
    const main = st.innings.filter(i => i.started && !i.isSuper);
    if (!main.some(i => i.deliveries.length)) return '<div class="card empty"><b>No balls bowled yet</b>Charts appear once scoring starts.</div>';
    const list = main.map(inn => ({ inn, team: cfg.teams[inn.battingTeam], ov: overSummary(inn) }));
    const legend = list.map((x, k) => `<span class="lg-item"><svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke="${esc(x.team.color)}" stroke-width="2.5" ${k ? 'stroke-dasharray="6 4"' : ''}/></svg>${esc(x.team.name)}</span>`).join('');
    return `
      <section class="card chart-card"><h2>Run comparison</h2>
        <div class="legend">${legend}<span class="lg-item"><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="${ink.text}"/></svg>Wicket</span></div>
        ${wormSVG(st, list)}
        <p class="chart-tip hint" aria-live="polite">Tap the chart to see the score after any over.</p></section>
      ${list.map(x => `
      <section class="card chart-card"><div class="inn-title">${flag(x.team, 'sm')}<h3>${esc(x.team.name)} — runs per over</h3></div>
        ${manhattanSVG(x.team, x.inn, x.ov)}
        <p class="chart-tip hint" aria-live="polite">● = wicket. Tap a bar for details.</p>
        <div class="over-list">${x.ov.slice().reverse().map(o => `
          <div class="ov-row"><div class="ov-no">Ov ${o.over + 1}</div>
            <div class="ov-mid"><div class="small muted">${esc(st.names[o.bowler] || '')}</div>
              <div class="balls" style="margin:4px 0 0">${o.balls.map(d => `<span class="ball ${ballClass(d)}">${esc(d.label)}</span>`).join('')}</div></div>
            <div class="ov-sum"><b>${o.runs}</b><small>${o.cum}/${o.cumW}</small></div></div>`).join('')}</div>
      </section>`).join('')}`;
  }

  function inningsCardHTML(st, inn) {
    const cfg = st.config;
    const t = cfg.teams[inn.battingTeam];
    const bt = cfg.teams[inn.bowlingTeam];
    const mark = (team, id) => (team.captain === id ? ' (c)' : '') + (team.keeper === id ? ' (wk)' : '');
    const batRows = inn.battingOrder.map(id => {
      const b = inn.batters[id];
      const atCrease = !inn.complete && (inn.striker === id || inn.nonStriker === id);
      const how = b.out ? b.howOut : b.retiredHurt ? 'retired hurt' : (atCrease ? 'batting' : 'not out');
      return `<tr class="${b.out ? '' : 'notout'}"><td><div class="nm"><button class="sc-name" data-act="player" data-id="${esc(id)}">${avatar(id, b.name, 'sm', t.color)}<span>${esc(b.name)}${esc(mark(t, id))}</span></button></div><div class="how">${esc(how)}</div></td>
        <td><b>${b.runs}</b></td><td>${b.balls}</td><td>${b.fours}</td><td>${b.sixes}</td><td>${E.strikeRate(b.runs, b.balls).toFixed(1)}</td></tr>`;
    }).join('');
    const dnb = t.players.filter(p => !inn.batters[p.id]).map(p => p.name);
    const bowlRows = inn.bowlingOrder.map(id => {
      const b = inn.bowlers[id];
      const extras = [b.wides ? `${b.wides} wd` : '', b.noballs ? `${b.noballs} nb` : ''].filter(Boolean).join(', ');
      return `<tr><td><div class="nm"><button class="sc-name" data-act="player" data-id="${esc(id)}">${avatar(id, b.name, 'sm', bt.color)}<span>${esc(b.name)}</span></button></div>${extras ? `<div class="how">${extras}</div>` : ''}</td>
        <td>${E.oversShort(b.balls)}</td><td>${b.maidens}</td><td>${b.runs}</td><td><b>${b.wickets}</b></td><td>${fmt2(E.rate(b.runs, b.balls))}</td></tr>`;
    }).join('');
    const fow = inn.fow.map(f => `<b>${f.runs}-${f.wicket}</b> (${esc(st.names[f.batter])}, ${f.overs})`).join(', ');
    const parts = inn.partnerships.filter(p => p.runs || p.balls).map(p => {
      const names = p.batters.map(id => `${esc(st.names[id])} ${p.contrib[id] || 0}`).join(' & ');
      return `<div class="kv"><span>${p.endWicket ? `${ordinal(p.endWicket)} wkt` : (p.open && !inn.complete ? 'Current' : 'Unbroken')} · ${names}</span><span><b>${p.runs}</b> (${p.balls})</span></div>`;
    }).join('');
    const adj = inn.adjustments.length ? `<div class="hint">Score corrections: ${inn.adjustments.map(a => `${a.runs > 0 ? '+' : ''}${a.runs}${a.note ? ' — ' + esc(a.note) : ''}`).join('; ')}</div>` : '';
    const cols = '<colgroup><col class="n"><col class="c2"><col class="c"><col class="c"><col class="c"><col class="c2"></colgroup>';
    return `<section class="card sc-card">
      <div class="inn-title">${flag(t, 'sm')}<h3>${esc(E.inningsTitle(st, inn))}</h3>
        <span class="tot">${inn.runs}/${inn.wickets}</span><span class="small muted">(${E.oversStr(inn.legalBalls)})</span></div>
      ${inn.target != null ? `<div class="small muted pad-x" style="margin:-6px 0 10px">Target ${inn.target}</div>` : ''}
      <table class="sc" aria-label="${esc(t.name)} batting">${cols}
        <thead><tr><th>Batsmen</th><th>R</th><th>B</th><th>4s</th><th>6s</th><th>SR</th></tr></thead>
        <tbody>${batRows}
          <tr class="ext"><td>Extras <span class="how">b ${inn.extras.b}, lb ${inn.extras.lb}, wd ${inn.extras.wd}, nb ${inn.extras.nb}${inn.extras.pen ? ', pen ' + inn.extras.pen : ''}</span></td><td><b>${E.extrasTotal(inn)}</b></td><td colspan="4"></td></tr>
          <tr class="tot"><td>Total <span class="how">RR ${fmt2(E.rate(inn.runs, inn.legalBalls))}</span></td><td>${inn.runs}/${inn.wickets}</td><td colspan="4" style="text-align:left;padding-left:8px">${E.oversStr(inn.legalBalls)} ov</td></tr>
        </tbody></table>
      ${bowlRows ? `<table class="sc" aria-label="${esc(bt.name)} bowling">${cols}
        <thead><tr><th>Bowlers</th><th>O</th><th>M</th><th>R</th><th>W</th><th>Eco</th></tr></thead><tbody>${bowlRows}</tbody></table>` : ''}
      <div class="pad-x pad-b" style="padding-top:12px">
        ${adj}
        ${dnb.length ? `<div class="fow"><b>${inn.complete ? 'Did not bat' : 'Yet to bat'}:</b> ${dnb.map(esc).join(', ')}</div>` : ''}
        ${fow ? `<div class="fow" style="margin-top:6px"><b>Fall of wickets:</b> ${fow}</div>` : ''}
        ${parts ? `<h3 style="margin:14px 0 4px">Partnerships</h3>${parts}` : ''}
      </div>
    </section>`;
  }
  function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  // Draws a 1080×1350 share card.
  function loadImage(src) {
    return new Promise(resolve => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; });
  }
  async function scorecardImage(st, m) {
    const potmImg = m.potm && photos()[m.potm] ? await loadImage(photos()[m.potm]) : null;
    const logos = await Promise.all(st.config.teams.map(t => { const k = teamPhotoKey(t); return k && photos()[k] ? loadImage(photos()[k]) : null; }));
    const cfg = st.config;
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1350;
    const g = c.getContext('2d');
    g.fillStyle = '#eef1f7'; g.fillRect(0, 0, 1080, 1350);
    g.fillStyle = '#0d47c5'; g.fillRect(0, 0, 1080, 380);
    const font = (w, s) => `${w} ${s}px Outfit, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    const text = (t, x, y, f, color, align) => { g.font = f; g.fillStyle = color; g.textAlign = align || 'left'; g.fillText(t, x, y); };
    const fit = (t, f, max) => { g.font = f; let s = String(t); while (s.length > 3 && g.measureText(s).width > max) s = s.slice(0, -2); return s === String(t) ? s : s + '…'; };
    const card = (x, y, w, h, fill) => {
      g.save(); g.shadowColor = 'rgba(17,38,92,.12)'; g.shadowBlur = 30; g.shadowOffsetY = 8; g.fillStyle = fill || '#fff';
      g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, 32); else g.rect(x, y, w, h); g.fill(); g.restore();
    };
    text('TURF CRICKET PRO', 72, 100, font(700, 30), '#ffad0d');
    text(fit(cfg.name, font(700, 54), 936), 72, 170, font(700, 54), '#ffffff');
    text([fmtDate(cfg.date), cfg.venue, `${cfg.overs} overs`].filter(Boolean).join('  ·  '), 72, 220, font(400, 30), 'rgba(255,255,255,.75)');
    let y = 280;
    st.innings.filter(i => i.started).slice(0, 4).forEach(inn => {
      const t = cfg.teams[inn.battingTeam];
      const h = inn.isSuper ? 120 : 250;
      card(56, y, 968, h);
      const logo = logos[inn.battingTeam];
      if (logo) { g.save(); g.beginPath(); g.arc(112, y + 62, 26, 0, Math.PI * 2); g.clip(); g.drawImage(logo, 86, y + 36, 52, 52); g.restore(); }
      else { g.fillStyle = t.color || '#0d47c5'; g.beginPath(); g.arc(112, y + 62, 26, 0, Math.PI * 2); g.fill(); text(initials(t.name), 112, y + 71, font(700, 22), inkFor(t.color), 'center'); }
      text(fit(E.inningsTitle(st, inn), font(600, 40), 520), 156, y + 76, font(600, 40), '#1b2236');
      text(`${inn.runs}/${inn.wickets}`, 900, y + 82, font(700, 64), '#1b2236', 'right');
      text(`(${E.oversStr(inn.legalBalls)})`, 990, y + 80, font(400, 28), '#7b8499', 'right');
      if (!inn.isSuper) {
        g.fillStyle = '#f6f8fc'; g.fillRect(56, y + 110, 968, 116);
        const bats = Object.values(inn.batters).sort((a, b) => b.runs - a.runs).slice(0, 2);
        const bowls = Object.values(inn.bowlers).filter(b => b.balls).sort((a, b) => b.wickets - a.wickets || a.runs - b.runs).slice(0, 2);
        bats.forEach((b, k) => text(fit(`${b.name}  ${b.runs}${b.out ? '' : '*'} (${b.balls})`, font(500, 30), 430), 96, y + 158 + k * 46, font(500, 30), '#0d47c5'));
        bowls.forEach((b, k) => text(fit(`${b.name}  ${b.wickets}/${b.runs} (${E.oversShort(b.balls)})`, font(500, 30), 430), 560, y + 158 + k * 46, font(500, 30), '#7b8499'));
      }
      y += h + 24;
    });
    const res = st.result ? st.result.text : (st.status === 'abandoned' ? 'Match abandoned' : 'Match in progress');
    card(56, y + 6, 968, 110, '#0d47c5');
    text(fit(res, font(700, 42), 920), 540, y + 76, font(700, 42), '#ffffff', 'center');
    if (m.potm && st.names[m.potm]) {
      if (potmImg && y < 880) {
        const cx = 540, cy = y + 230, r = 70;
        g.save(); g.beginPath(); g.arc(cx, cy, r + 6, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip(); g.drawImage(potmImg, cx - r, cy - r, r * 2, r * 2); g.restore();
        text('PLAYER OF THE MATCH', 540, y + 340, font(600, 24), '#7b8499', 'center');
        text(st.names[m.potm], 540, y + 384, font(700, 38), '#1b2236', 'center');
      } else {
        text(`Player of the Match: ${st.names[m.potm]}`, 540, y + 180, font(600, 34), '#1b2236', 'center');
      }
    }
    text('Scored with Turf Cricket Pro', 540, 1300, font(500, 26), '#a3abbd', 'center');
    return new Promise(resolve => c.toBlob(resolve, 'image/png'));
  }

  async function scorecardAction(a) {
    const sc = app.sc;
    if (!sc) return;
    const { match: m, state: st } = sc;
    const base = `${slug(st.config.name)}-${st.config.date}`;
    try {
      if (a === 'sc-share') await shareText(st.config.name, E.shareText(st, m));
      else if (a === 'sc-copy') { await copyText(E.scorecardText(st, m)); toast('Full scorecard copied', 'ok'); }
      else if (a === 'sc-csv') { downloadBlob(new Blob([E.toCSV(st, m)], { type: 'text/csv' }), base + '.csv'); toast('CSV downloaded', 'ok'); }
      else if (a === 'sc-json') { downloadBlob(new Blob([JSON.stringify({ app: 'turf-cricket-pro', version: 1, teams: [], matches: [m] }, null, 1)], { type: 'application/json' }), base + '.json'); toast('Match file saved — import it in Settings on any phone', 'ok'); }
      else if (a === 'sc-image') {
        const blob = await scorecardImage(st, m);
        if (!blob) throw new Error('Could not create the image');
        const file = new File([blob], base + '.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: st.config.name }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
        }
        downloadBlob(blob, base + '.png');
        toast('Scorecard image saved', 'ok');
      } else if (a === 'sc-delete') {
        const ok = await confirmDialog(`Permanently delete <b>${esc(st.config.name)}</b> and its scorecard? Player and team stats from this match will be removed. Export a backup first if unsure.`, { title: 'Delete match?', ok: 'Delete match', danger: true, typed: 'DELETE' });
        if (!ok) return;
        store.deleteMatch(m.id);
        if (app.match && app.match.id === m.id) { app.match = null; app.state = null; }
        app.statsCache = null;
        toast('Match deleted');
        go('#/history');
      }
    } catch (err) { toast(err.message || 'Something went wrong', 'error'); }
  }

  // =====================================================================
  // TEAMS
  // =====================================================================
  function teamRecord(teamId) {
    let w = 0, l = 0, p = 0;
    store.getMatchIndex().forEach(x => {
      const s = x.summary;
      if (!s || (s.status !== 'complete' && s.status !== 'abandoned')) return;
      const i = s.teams.findIndex(t => t.savedTeamId === teamId);
      if (i < 0) return;
      p++;
      if (s.winner === i) w++; else if (s.winner != null) l++;
    });
    return { w, l, p };
  }

  function viewTeams() {
    const teams = store.getTeams().slice().sort((a, b) => a.name.localeCompare(b.name));
    view().innerHTML = `${topbar('My Teams', { sub: 'Saved rosters you can reuse in any match' })}
      <a class="btn light block lg" href="#/teams/new" style="margin-bottom:14px">+ Create team</a>
      ${teams.length ? `<div class="list">${teams.map(t => {
        const r = teamRecord(t.id);
        return `<a class="list-item" href="#/teams/${encodeURIComponent(t.id)}">${flag(t)}
          <div class="grow"><div class="t">${esc(t.name)}</div><div class="s">${plural(t.players.length, 'player')}${r.p ? ` · ${r.w} W, ${r.l} L of ${r.p}` : ''}</div></div><span class="chev" aria-hidden="true">›</span></a>`;
      }).join('')}</div>` : '<div class="card empty"><b>No saved teams</b>Create a team once, then pick it in every new match. Teams typed during match setup are saved here too.</div>'}`;
  }

  function viewTeamEdit(id) {
    const isNew = id === 'new';
    const orig = isNew ? null : store.getTeam(id);
    if (!isNew && !orig) { view().innerHTML = topbar('Team', { back: '#/teams' }) + '<div class="card empty"><b>Team not found</b></div>'; return; }
    const d = orig ? JSON.parse(JSON.stringify(orig)) : { id: E.uid('t'), name: '', color: '#1f9d55', players: [], captain: null, keeper: null, defaultXI: [], createdAt: Date.now() };
    d.defaultXI = d.defaultXI || [];
    app.dirty = false;

    function render() {
      view().innerHTML = `${topbar(isNew ? 'New team' : 'Edit team', { back: '#/teams' })}
        <section class="card">
          <div class="row" style="align-items:flex-end">
            <button type="button" class="ava-btn" data-te="logo" aria-label="${photos()['t:' + d.id] ? 'Change or remove team logo' : 'Add team logo'}" style="margin-bottom:14px">${flag(d)}</button>
            <label class="field grow"><span>Team name</span><input type="text" id="te-name" maxlength="30" value="${esc(d.name)}" placeholder="e.g. Royal Strikers"></label>
            <label class="field"><span>Colour</span><input type="color" id="te-color" value="${esc(d.color || '#1f9d55')}" aria-label="Team colour"></label></div>
          <p class="hint" style="margin-top:-6px">Tap the badge to add a team logo.</p>
        </section>
        <section class="card">
          <h2>Players (${d.players.length})</h2>
          <p class="hint" style="margin:-4px 0 8px">C = captain · WK = wicketkeeper · XI = in the default playing side</p>
          <div id="te-players">${d.players.map((p, i) => `<div class="player-row">
            <div class="pr-top">
              <button type="button" class="ava-btn" data-te="photo" data-pi="${i}" aria-label="${photos()[p.id] ? 'Change or remove photo of' : 'Add photo of'} ${esc(p.name)}">${avatar(p.id, p.name, '', d.color)}</button>
              <input type="text" value="${esc(p.name)}" data-pi="${i}" aria-label="Player ${i + 1} name" maxlength="30">
              <button type="button" class="tog del" data-te="del" data-pi="${i}" aria-label="Remove ${esc(p.name)}">✕</button>
            </div>
            <div class="pr-tags">
              <button type="button" class="tog ${d.captain === p.id ? 'on' : ''}" data-te="cap" data-pi="${i}" aria-pressed="${d.captain === p.id}" aria-label="Captain">C</button>
              <button type="button" class="tog ${d.keeper === p.id ? 'on' : ''}" data-te="wk" data-pi="${i}" aria-pressed="${d.keeper === p.id}" aria-label="Wicketkeeper">WK</button>
              <button type="button" class="tog ${d.defaultXI.includes(p.id) ? 'on' : ''}" data-te="xi" data-pi="${i}" aria-pressed="${d.defaultXI.includes(p.id)}" aria-label="In default playing side">XI</button>
              ${orig ? `<button type="button" class="tog wide" data-te="stats" data-pi="${i}">📊 Profile</button>` : ''}
            </div></div>`).join('') || '<p class="muted small">No players yet.</p>'}</div>
          <div class="row" style="margin-top:10px"><input type="text" id="te-add" class="grow" placeholder="Player name (or paste a list)" maxlength="400" aria-label="New player name">
            <button type="button" class="btn turf" data-te="add">Add</button></div>
          <p class="hint">Default XI: ${d.defaultXI.length} selected</p>
        </section>
        <p class="err" id="te-err" role="alert"></p>
        <button class="btn primary block lg" data-te="save">Save team</button>
        ${orig ? '<button class="btn danger block" data-te="delete" style="margin-top:10px">Delete team</button>' : ''}`;
      wire();
    }
    function syncInputs() {
      const n = $('#te-name'); if (n) d.name = n.value;
      const c = $('#te-color'); if (c) d.color = c.value;
      $$('#te-players input[data-pi]').forEach(el => { d.players[+el.dataset.pi].name = el.value; });
    }
    function addPlayers() {
      const input = $('#te-add');
      const names = input.value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
      if (!names.length) { input.focus(); return; }
      names.forEach(name => {
        const p = { id: E.uid('p'), name };
        d.players.push(p);
        d.defaultXI.push(p.id);
      });
      app.dirty = true;
      render();
      $('#te-add').focus();
    }
    function wire() {
      const root = view();
      root.oninput = () => { app.dirty = true; };
      $('#te-add').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); syncInputs(); addPlayers(); } };
      root.onclick = async e => {
        const b = e.target.closest('[data-te]');
        if (!b) return;
        syncInputs();
        const p = b.dataset.pi != null ? d.players[+b.dataset.pi] : null;
        const act = b.dataset.te;
        if (act === 'add') return addPlayers();
        if (act === 'cap') { d.captain = d.captain === p.id ? null : p.id; app.dirty = true; return render(); }
        if (act === 'wk') { d.keeper = d.keeper === p.id ? null : p.id; app.dirty = true; return render(); }
        if (act === 'xi') { d.defaultXI = d.defaultXI.includes(p.id) ? d.defaultXI.filter(x => x !== p.id) : d.defaultXI.concat(p.id); app.dirty = true; return render(); }
        if (act === 'stats') return playerSheet(p.id, { name: p.name, color: d.color, team: d.name }).then(render);
        if (act === 'photo' || act === 'logo') {
          const key = act === 'logo' ? 't:' + d.id : p.id;
          if (photos()[key]) {
            const choice = await sheet({
              title: act === 'logo' ? 'Team logo' : p.name || 'Player photo',
              render: () => `<div class="center">${act === 'logo' ? flag(d, 'xl') : avatar(p.id, p.name, 'xl', d.color)}</div>
                <div class="sheet-actions"><button class="btn danger" data-on="c" data-v="remove">Remove</button><button class="btn primary" data-on="c" data-v="change">Change photo</button></div>`,
              on: { c: (el, api) => api.close(el.dataset.v) },
            });
            if (choice === 'remove') { removePhoto(key); return render(); }
            if (choice !== 'change') return;
          }
          if (await pickPhoto(key)) render();
          return;
        }
        if (act === 'del') {
          const ok = await confirmDialog(`Remove <b>${esc(p.name || 'this player')}</b> from ${esc(d.name || 'the team')}? Past scorecards keep their name.`, { title: 'Remove player?', ok: 'Remove', danger: true });
          if (!ok) return;
          d.players = d.players.filter(x => x.id !== p.id);
          d.defaultXI = d.defaultXI.filter(x => x !== p.id);
          if (d.captain === p.id) d.captain = null;
          if (d.keeper === p.id) d.keeper = null;
          app.dirty = true;
          return render();
        }
        if (act === 'save') return save();
        if (act === 'delete') {
          const ok = await confirmDialog(`Delete the saved team <b>${esc(orig.name)}</b>? Matches already played keep their scorecards.`, { title: 'Delete team?', ok: 'Delete team', danger: true, typed: 'DELETE' });
          if (!ok) return;
          store.deleteTeam(orig.id);
          app.dirty = false;
          toast('Team deleted');
          go('#/teams');
        }
      };
    }
    function save() {
      const err = $('#te-err');
      d.name = d.name.trim();
      d.players.forEach(p => { p.name = p.name.trim(); });
      if (!d.name) { err.textContent = 'Enter a team name.'; return; }
      if (store.getTeams().some(t => t.id !== d.id && t.name.toLowerCase() === d.name.toLowerCase())) { err.textContent = 'Another saved team already has this name.'; return; }
      if (d.players.some(p => !p.name)) { err.textContent = 'Every player needs a name (or remove the empty row).'; return; }
      const seen = new Set();
      for (const p of d.players) {
        const k = p.name.toLowerCase();
        if (seen.has(k)) { err.textContent = `“${p.name}” is listed twice. Use a surname or initial to tell them apart.`; return; }
        seen.add(k);
      }
      d.defaultXI = d.defaultXI.filter(x => d.players.some(p => p.id === x));
      try { store.saveTeam(d); } catch (e2) { err.textContent = e2.message; return; }
      app.dirty = false;
      toast('Team saved', 'ok');
      go('#/teams');
    }
    render();
  }

  // Batting and bowling rows for one player across finished matches, newest first.
  function playerForm(pid) {
    const rows = [];
    getEntries().filter(x => x.state.status === 'complete' || x.state.status === 'abandoned')
      .sort((a, b) => (b.match.config.date || '').localeCompare(a.match.config.date || '') || b.match.updatedAt - a.match.updatedAt)
      .forEach(({ match, state }) => {
        // one row per match: batting from one innings, bowling from the other
        const ti = state.teamOf[pid];
        if (ti == null) return;
        const main = state.innings.filter(i => i.started && !i.isSuper);
        const bat = main.map(i => i.batters[pid]).find(Boolean) || null;
        const bowl = main.map(i => i.bowlers[pid]).find(w => w && w.balls) || null;
        if (bat || bowl) rows.push({ matchId: match.id, date: match.config.date, opp: state.config.teams[1 - ti].name, bat, bowl });
      });
    return rows;
  }

  // Player profile: photo, rename (inside a match), career numbers and recent form.
  // o = { name, color, team, match } — `match` enables renaming inside that match.
  function playerSheet(pid, o) {
    const opts = o || {};
    const p = E.buildStats(getEntries()).players[pid];
    const row = (k, v) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`;
    const form = playerForm(pid).slice(0, 5);
    return sheet({
      title: 'Player profile',
      state: { name: opts.name || (p && p.name) || 'Player' },
      render: st => `
        <div class="profile-head">
          <button type="button" class="ava-btn" data-on="photo" aria-label="Add or change photo">${avatar(pid, st.name, 'xl', opts.color)}</button>
          <div style="min-width:0"><div class="pn">${esc(st.name)}</div><div class="muted small">${esc(opts.team || (p && p.team) || '')}</div>
            <div class="btn-row" style="margin-top:8px">
              ${photos()[pid] ? '<button class="btn sm" data-on="unphoto">Remove photo</button>' : '<button class="btn sm primary" data-on="photo">📷 Add photo</button>'}
              ${opts.match ? '<button class="btn sm" data-on="rename">✏️ Rename</button>' : ''}
            </div></div>
        </div>
        ${!p ? '<p class="muted">Career stats appear after this player’s first finished match.</p>' : `
        <div class="kpis" style="margin:14px 0 4px">
          <div class="kpi"><b>${p.runs}</b><span>Runs</span></div>
          <div class="kpi"><b>${p.wickets}</b><span>Wickets</span></div>
          <div class="kpi"><b>${p.matches}</b><span>Matches</span></div>
        </div>
        <div class="lbl">Batting</div>
        ${row('Innings', p.innings)}
        ${row('Highest score', p.innings ? p.hs + (p.hsNotOut ? '*' : '') : '—')}
        ${row('Average', p.innings - p.notOuts ? fmt2(p.runs / (p.innings - p.notOuts)) : '—')}
        ${row('Strike rate', p.balls ? fmt2(E.strikeRate(p.runs, p.balls)) : '—')}
        ${row('Fours / Sixes', `${p.fours} / ${p.sixes}`)}${row('50s', p.fifties)}
        <div class="lbl">Bowling</div>
        ${row('Overs', E.oversShort(p.ballsBowled))}
        ${row('Best', p.best && p.ballsBowled ? `${p.best.wickets}/${p.best.runs}` : '—')}
        ${row('Economy', p.ballsBowled ? fmt2(E.rate(p.runsConceded, p.ballsBowled)) : '—')}
        ${form.length ? `<div class="lbl">Recent form</div>${form.map(f => `<div class="kv"><span>vs ${esc(f.opp)} · ${esc(fmtDate(f.date))}</span><b>${[
          f.bat ? `${f.bat.runs}${f.bat.out ? '' : '*'} (${f.bat.balls})` : '',
          f.bowl ? `${f.bowl.wickets}/${f.bowl.runs}` : '',
        ].filter(Boolean).join(' · ')}</b></div>`).join('')}` : ''}`}`,
      on: {
        photo: async (el, api) => { if (await pickPhoto(pid)) api.render(); },
        unphoto: (el, api) => { removePhoto(pid); api.render(); },
        rename: async (el, api) => {
          const name = await sheet({
            title: 'Rename player',
            render: () => `<p class="muted" style="margin-top:0">Fixes the name in this match${opts.match.config.teams.some(t => t.savedTeamId) ? ' and in the saved team' : ''}. Scores are not affected.</p>
              <label class="field"><span>Name</span><input type="text" id="rn-name" maxlength="30" value="${esc(api.state.name)}" autofocus></label>
              <div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn primary" data-on="ok">Save</button></div>`,
            on: { ok: (e2, a2) => a2.close($('#rn-name', a2.body).value.trim()) },
          });
          if (!name || name === api.state.name) return;
          if (renamePlayer(opts.match, pid, name)) { api.state.name = name; api.render(); }
        },
      },
    });
  }

  // Renames a player inside one match (ids are unchanged, so every score stays linked) and in its saved team.
  function renamePlayer(m, pid, name) {
    const team = m.config.teams.find(t => t.players.some(p => p.id === pid));
    if (!team) return false;
    if (team.players.some(p => p.id !== pid && p.name.toLowerCase() === name.toLowerCase())) {
      toast(`${team.name} already has a player called ${name}`, 'error');
      return false;
    }
    team.players.find(p => p.id === pid).name = name;
    m.summary = E.summarize(E.replay(m));
    if (!saveMeta(m)) return false;
    const saved = team.savedTeamId && store.getTeam(team.savedTeamId);
    if (saved && saved.players.some(p => p.id === pid)) {
      saved.players.find(p => p.id === pid).name = name;
      try { store.saveTeam(saved); } catch (err) { toast(err.message, 'error'); }
    }
    if (app.match && app.match.id === m.id) { app.match = m; app.state = null; }
    toast('Name updated', 'ok');
    return true;
  }

  // =====================================================================
  // HISTORY
  // =====================================================================
  function viewHistory() {
    const idx = store.getMatchIndex().slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updatedAt - a.updatedAt);
    view().innerHTML = `${topbar('Match History', { sub: `${plural(idx.length, 'match')} saved on this phone` })}
      ${idx.length > 4 ? '<input type="search" id="h-q" placeholder="Search team, match or venue" aria-label="Search matches" style="margin-bottom:12px">' : ''}
      <div class="list" id="h-list">${idx.map(matchRowHTML).join('') || '<div class="card empty"><b>No matches yet</b>Completed and in-progress matches appear here.</div>'}</div>`;
    const q = $('#h-q');
    if (q) q.addEventListener('input', () => {
      const term = q.value.trim().toLowerCase();
      $('#h-list').innerHTML = idx.filter(x => !term || [x.name, x.venue, ...(x.summary ? x.summary.teams.map(t => t.name) : [])].join(' ').toLowerCase().includes(term)).map(matchRowHTML).join('') || '<p class="muted center">No matches found.</p>';
    });
  }

  // =====================================================================
  // STATISTICS
  // =====================================================================
  function viewStats() {
    const entries = getEntries();
    const s = E.buildStats(entries);
    const rec = (label, main, sub) => `<div class="award"><span>${label}</span><b>${main}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
    const players = Object.values(s.players);
    const topList = (f, fmt) => players.filter(p => f(p) > 0).sort((a, b) => f(b) - f(a)).slice(0, 5)
      .map((p, i) => `<div class="kv"><span>${i + 1}. ${esc(p.name)} <span class="small">(${esc(p.team)})</span></span><b>${fmt(p)}</b></div>`).join('') || '<p class="muted small">No data yet.</p>';
    view().innerHTML = `${topbar('Statistics', { sub: 'From completed matches on this phone' })}
      <div class="kpis"><div class="kpi"><b>${s.totalMatches}</b><span>Total matches</span></div>
        <div class="kpi"><b>${s.completed}</b><span>With a result</span></div>
        <div class="kpi"><b>${players.length}</b><span>Players</span></div></div>
      ${s.totalMatches ? `
      <section class="card"><h2>Team records</h2>
        <table class="sc"><colgroup><col class="n"><col class="c"><col class="c"><col class="c"><col class="c"><col class="c2"></colgroup>
        <thead><tr><th>Team</th><th>P</th><th>W</th><th>L</th><th>T/NR</th><th>Win%</th></tr></thead>
        <tbody>${s.teams.map(t => `<tr><td><div class="nm">${esc(t.name)}</div></td><td>${t.played}</td><td><b>${t.won}</b></td><td>${t.lost}</td><td>${t.tied + t.nr}</td><td>${t.winPct}</td></tr>`).join('')}</tbody></table></section>
      <section class="card"><h2>Records</h2><div class="rec">
        ${rec('Highest team total', s.highestTotal ? `${s.highestTotal.runs}/${s.highestTotal.wickets}` : '—', s.highestTotal ? `${esc(s.highestTotal.team)} · ${s.highestTotal.overs} ov` : '')}
        ${rec('Highest score', s.highestScore ? `${s.highestScore.runs}${s.highestScore.notOut ? '*' : ''} (${s.highestScore.balls})` : '—', s.highestScore ? esc(s.highestScore.player) : '')}
        ${rec('Best bowling', s.bestBowling ? `${s.bestBowling.wickets}/${s.bestBowling.runs}` : '—', s.bestBowling ? `${esc(s.bestBowling.player)} · ${s.bestBowling.overs} ov` : '')}
        ${rec('Most runs', s.mostRuns ? s.mostRuns.runs : '—', s.mostRuns ? esc(s.mostRuns.name) : '')}
        ${rec('Most wickets', s.mostWickets ? s.mostWickets.wickets : '—', s.mostWickets ? esc(s.mostWickets.name) : '')}
        ${rec('Most fours', s.mostFours ? s.mostFours.fours : '—', s.mostFours ? esc(s.mostFours.name) : '')}
        ${rec('Most sixes', s.mostSixes ? s.mostSixes.sixes : '—', s.mostSixes ? esc(s.mostSixes.name) : '')}
      </div></section>
      <section class="card"><h2>Top run scorers</h2>${topList(p => p.runs, p => `${p.runs} <span class="small muted">(${p.innings} inn)</span>`)}</section>
      <section class="card"><h2>Top wicket takers</h2>${topList(p => p.wickets, p => `${p.wickets} <span class="small muted">(econ ${fmt2(E.rate(p.runsConceded, p.ballsBowled))})</span>`)}</section>
      ${s.teams.length >= 2 ? `<section class="card"><h2>Head to head</h2>
        <div class="grid2"><select id="h2h-a" aria-label="First team">${s.teams.map((t, i) => `<option value="${esc(t.key)}" ${i === 0 ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
        <select id="h2h-b" aria-label="Second team">${s.teams.map((t, i) => `<option value="${esc(t.key)}" ${i === 1 ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
        <div id="h2h-out"></div></section>` : ''}
      ` : '<div class="card empty"><b>No completed matches yet</b>Finish a match to see team records, top scorers and head-to-head stats.</div>'}`;
    const a = $('#h2h-a'), b = $('#h2h-b');
    if (a && b) {
      const upd = () => {
        const out = $('#h2h-out');
        if (a.value === b.value) { out.innerHTML = '<p class="muted small">Pick two different teams.</p>'; return; }
        const h = E.headToHead(entries, a.value, b.value);
        const na = a.options[a.selectedIndex].text, nb = b.options[b.selectedIndex].text;
        out.innerHTML = h.played ? `<div class="h2h">${h.a} – ${h.b}</div><p class="center muted small" style="margin:0">${esc(na)} vs ${esc(nb)} · ${plural(h.played, 'match')}${h.tied ? ` · ${h.tied} tied` : ''}${h.nr ? ` · ${h.nr} no result` : ''}</p>` : '<p class="muted small">These teams have not played each other yet.</p>';
      };
      a.onchange = upd; b.onchange = upd; upd();
    }
  }

  // =====================================================================
  // SETTINGS & BACKUP
  // =====================================================================
  function viewSettings() {
    const s = app.settings;
    let bytes = 0;
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('tcp.')) bytes += (localStorage.getItem(k) || '').length * 2; } } catch (e) { bytes = 0; }
    view().innerHTML = `${topbar('Settings & backup', { back: '#/' })}
      <section class="card"><h2>Feedback</h2>
        <label class="check"><input type="checkbox" id="s-sound" ${s.sound ? 'checked' : ''}> Sound effects for boundaries and wickets</label>
        <label class="check"><input type="checkbox" id="s-vib" ${s.vibrate ? 'checked' : ''}> Vibrate on each tap (Android)</label>
        <label class="check"><input type="checkbox" id="s-wake" ${s.wakeLock ? 'checked' : ''}> Keep the screen on while scoring</label></section>
      <section class="card"><h2>Backup</h2>
        <p class="muted small" style="margin-top:0">Your teams and matches are stored only on this phone (${(bytes / 1024).toFixed(0)} KB used). Export a backup regularly, and import it to move everything to another phone.</p>
        <div class="grid2"><button class="btn" data-act="export">⬇️ Export backup</button>
          <label class="btn" for="s-import" style="cursor:pointer">⬆️ Import backup</label></div>
        <input type="file" id="s-import" accept="application/json,.json" hidden></section>
      <section class="card"><h2>Install on your phone</h2>
        <p class="small muted" style="margin:0"><b>Android (Chrome):</b> ⋮ menu → <i>Add to Home screen</i> / <i>Install app</i>.<br><b>iPhone (Safari):</b> Share → <i>Add to Home Screen</i>.<br>Once opened, it works offline at the ground.</p></section>
      <section class="card"><h2>Danger zone</h2>
        <button class="btn danger block" data-act="clear-all">Delete all teams and matches</button></section>
      <p class="center small muted">Turf Cricket Pro v1.0 · data never leaves this device</p>`;
    $('#s-sound').onchange = e => { app.settings.sound = e.target.checked; store.saveSettings(app.settings); if (e.target.checked) sound('four'); };
    $('#s-vib').onchange = e => { app.settings.vibrate = e.target.checked; store.saveSettings(app.settings); buzz(30); };
    $('#s-wake').onchange = e => { app.settings.wakeLock = e.target.checked; store.saveSettings(app.settings); };
    $('#s-import').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        const ok = await confirmDialog(`Import <b>${plural((data.teams || []).length, 'team')}</b> and <b>${plural((data.matches || []).length, 'match')}</b>? Items with the same ID on this phone will be replaced.`, { title: 'Import backup?', ok: 'Import' });
        if (!ok) return;
        (data.matches || []).forEach(m => { try { m.summary = E.summarize(E.replay(m)); } catch (err) { /* keep raw; it will show as unreadable */ } });
        const r = store.importAll(data);
        app.match = null; app.state = null; app.statsCache = null;
        toast(`Imported ${plural(r.teams, 'team')} and ${plural(r.matches, 'match')}`, 'ok');
      } catch (err) { toast(err instanceof SyntaxError ? 'That file is not valid JSON.' : err.message, 'error'); }
    };
  }

  // =====================================================================
  // GLOBAL ACTIONS (event delegation)
  // =====================================================================
  const actions = {
    run: el => addEvent({ type: 'ball', kind: 'normal', runs: +el.dataset.r }),
    extra: el => extrasDialog(el.dataset.k),
    wicket: () => wicketDialog('normal'),
    undo: () => doUndo(),
    swap: () => addEvent({ type: 'swap_strike' }),
    'other-runs': () => otherRunsDialog(),
    scorecard: () => go('#/match/' + encodeURIComponent(app.match.id)),
    player: el => {
      const sc = app.sc;
      if (!sc) return;
      const id = el.dataset.id;
      const ti = sc.state.teamOf[id];
      const team = sc.state.config.teams[ti];
      playerSheet(id, { name: sc.state.names[id], color: team && team.color, team: team && team.name, match: store.getMatch(sc.match.id) || sc.match })
        .then(() => { if (location.hash.startsWith('#/match/')) viewScorecard(sc.match.id); });
    },
    more: () => moreSheet(),
    pause: () => togglePause(),
    mute: () => { app.settings.sound = !app.settings.sound; store.saveSettings(app.settings); toast(app.settings.sound ? 'Sound on' : 'Sound off'); renderLive(); },
    'start-innings': () => {
      const s = $('#op-s').value, ns = $('#op-ns').value, b = $('#op-b').value;
      if (!s || !ns || !b) { toast('Select both opening batters and the bowler', 'error'); return; }
      addEvent({ type: 'start_innings', striker: s, nonStriker: ns, bowler: b });
    },
    'pick-batter': el => {
      const box = $('#nb-strike');
      const ev = { type: 'new_batter', batter: el.dataset.id };
      if (box) ev.onStrike = box.checked;
      addEvent(ev);
    },
    'pick-bowler': el => addEvent({ type: 'set_bowler', bowler: el.dataset.id }),
    'share-live': () => liveShareSheet(),
    'super-over': async () => {
      const ok = await confirmDialog('Play a one-over Super Over to decide the winner? Each side gets 6 balls and 2 wickets.', { title: 'Super Over', ok: 'Start Super Over' });
      if (ok) addEvent({ type: 'start_super_over' });
    },
    finish: () => { const id = app.match.id; store.setCurrentId(null); app.match = null; app.state = null; go('#/match/' + encodeURIComponent(id)); },
    resume: el => { store.setCurrentId(el.dataset.id); app.match = null; app.state = null; go('#/live'); },
    'sc-share': () => scorecardAction('sc-share'),
    'sc-copy': () => scorecardAction('sc-copy'),
    'sc-image': () => scorecardAction('sc-image'),
    'sc-csv': () => scorecardAction('sc-csv'),
    'sc-json': () => scorecardAction('sc-json'),
    'sc-delete': () => scorecardAction('sc-delete'),
    export: () => {
      const data = store.exportAll();
      downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `turf-cricket-backup-${localToday()}.json`);
      toast(`Backup saved: ${plural(data.teams.length, 'team')}, ${plural(data.matches.length, 'match')}`, 'ok');
      app.settings.lastBackup = Date.now();
      store.saveSettings(app.settings);
      if (location.hash === '#/' || location.hash === '') viewHome();
    },
    'clear-all': async () => {
      const ok = await confirmDialog('This permanently deletes <b>every team and match</b> on this phone. Export a backup first if you might need them.', { title: 'Delete everything?', ok: 'Delete everything', danger: true, typed: 'DELETE' });
      if (!ok) return;
      store.clearAll();
      app.match = null; app.state = null; app.statsCache = null;
      toast('All data deleted');
      go('#/');
    },
  };

  // Guard against accidental double taps on scoring buttons.
  let lastTap = 0;
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled || !actions[el.dataset.act]) return;
    if (el.closest('.sheet-wrap')) return;
    const now = Date.now();
    if (el.closest('.pad, .choices') && now - lastTap < 250) return;
    lastTap = now;
    e.preventDefault();
    try { actions[el.dataset.act](el, e); } catch (err) { console.error(err); toast(err.message || 'Something went wrong', 'error'); }
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', updateWakeLock);
  window.addEventListener('beforeunload', e => { if (app.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('storage', e => { if (e.key && e.key.startsWith('tcp.')) { app.match = null; app.state = null; app.statsCache = null; } });

  // Not on localhost, so edits during development are never served from a stale cache.
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache unavailable */ }); });
  }

  route();
})();
