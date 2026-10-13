// Followback side panel (classic script). Contract: PLAN.md "Contracts" and "UI - side panel".
//
// - chrome.storage.local is the source of truth; this file only renders it and listens to onChanged.
// - It writes to storage in exactly one place: Stop (stopAt + a stopped status).
// - It talks to content.js only through chrome.tabs.sendMessage: ping, scan, unfollow.
// - Instagram strings (username, fullName, pic) reach the DOM only via textContent / setAttribute.
//   There is no innerHTML anywhere in this file.
'use strict';

(() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const IG = 'https://www.instagram.com/';
  const KEYS = ['status', 'profile', 'followers', 'following', 'unfollowed', 'scannedAt'];
  const LIST_KEYS = ['followers', 'following', 'unfollowed', 'profile']; // the only keys that rebuild the list
  const TAB_ORDER = ['nfb', 'followers', 'following'];

  // Mirrors the engine's pacing (PLAN.md), used only for the estimate in the confirm step.
  const RUN_CAP = 150;
  const AVG_GAP_S = 15;
  const PAUSE_EVERY = 5;
  const PAUSE_S = 300;

  // PLAN.md "Liveness": a running status counts only while it keeps being written (or announces a resumeAt).
  const LIVE_MS = 2 * 60 * 1000;
  const INTERRUPTED = 'Interrupted \u2014 the Instagram tab was reloaded or closed.';

  const FIRST_CHUNK = 400; // rows built synchronously on a tab/search change; the rest follow in chunks of this size

  // ---------- state ----------

  const S = {
    status: null, profile: null, followers: null, following: null, unfollowed: [], scannedAt: null,
    reach: null, // null until the first ping answers; then { ok: false } or { ok: true, username }
    tabId: null,
    tab: 'nfb',
    q: '',
    unticked: new Set(), // ids the user unchecked, kept in memory across re-renders and rescans
    confirming: false,
    starting: false, // a scan/unfollow message is in flight, or its status has not landed yet
    focusStop: false, // the user just started a job; hand keyboard focus to its Stop button once it shows
    notice: null, // { scope: 'scan' | 'unfollow', text } from a { ok: false, error } reply
    snap: null, // followers-phase progress, remembered so the Following phase can show it as finished
  };
  // Derived from the stored lists; recomputed only when they change.
  const D = { has: false, followerIds: new Set(), unf: new Set(), nfb: [], selectable: [] };
  let V = []; // rows currently listed (after tab + search)

  function derive() {
    D.has = !!(S.profile && S.followers && S.following);
    D.followerIds = new Set((S.followers || []).map((u) => u.id));
    D.unf = new Set(S.unfollowed || []);
    D.nfb = D.has ? S.following.filter((u) => !D.followerIds.has(u.id)) : [];
    D.selectable = D.nfb.filter((u) => !D.unf.has(u.id));
  }

  const selectedIds = () => D.selectable.filter((u) => !S.unticked.has(u.id)).map((u) => u.id);
  const selectedCount = () => {
    let n = 0;
    for (const u of D.selectable) if (!S.unticked.has(u.id)) n++;
    return n;
  };

  const isRunning = (s) => !!s && (s.state === 'scanning' || s.state === 'unfollowing');
  const isLive = (s) => isRunning(s) && Date.now() - Math.max(s.at || 0, s.resumeAt || 0) < LIVE_MS;
  // The status as the UI should read it: a job that went quiet died with its tab, so show it as interrupted
  // (and let the user start again). Everything below reads this, never S.status directly.
  function effective() {
    const s = S.status || {};
    return isRunning(s) && !isLive(s) ? { ...s, state: 'stopped', resumeAt: null, message: INTERRUPTED } : s;
  }

  // Quiet jobs write nothing, so a timer re-renders the moment a running status expires.
  let liveTimer = 0;
  function armLiveness() {
    clearTimeout(liveTimer);
    const s = S.status;
    if (isLive(s)) liveTimer = setTimeout(renderLight, Math.max(s.at || 0, s.resumeAt || 0) + LIVE_MS - Date.now() + 100);
  }

  function flags() {
    const s = effective();
    const scanning = s.state === 'scanning';
    const unfollowing = s.state === 'unfollowing';
    const r = S.reach;
    return {
      s, scanning, unfollowing,
      unreachable: !!r && !r.ok,
      // The ping's `busy` is not used: it goes stale once a job ends, and the engine rejects a second job anyway
      // (that reply shows up as a notice).
      canAct: !!r && r.ok && !scanning && !unfollowing && !S.starting,
    };
  }

  // ---------- elements ----------

  const E = {};
  for (const id of [
    'scroll', 'chip', 'chipAv', 'chipName', 'live',
    'cardUnreach', 'btnOpen', 'btnReload',
    'cardReady', 'btnScan', 'btnScanText', 'hint', 'hintDot',
    'cardScan', 'btnStopScan', 'progFollowers', 'pfN', 'pfBar', 'progFollowing', 'pgN', 'pgBar', 'scanMsg', 'scanCd',
    'cardErr', 'errTitle', 'errMsg', 'btnRetry', 'result', 'resultText',
    'stats', 'tFollowers', 'tFollowing', 'tNfb', 'ago', 'agoUnf', 'btnRescan', 'warn', 'warnText',
    'toolbar', 'cNfb', 'cFollowers', 'cFollowing', 'q', 'qClear',
    'panel', 'listCard', 'listHead', 'selAll', 'selText', 'list', 'empty', 'emptyText',
    'dock', 'dockNote', 'dockNoteText', 'dockIdle', 'btnUnfollow', 'dockConfirm', 'confirmText', 'btnCancel', 'btnYes',
    'dockRun', 'runTitle', 'btnStopRun', 'runBar', 'runMsg', 'runCd',
  ]) {
    E[id] = document.getElementById(id);
    if (!E[id]) throw new Error('sidepanel.html is missing #' + id);
  }
  const tabBtns = Array.from(document.querySelectorAll('.tab'));
  const tileBtns = Array.from(document.querySelectorAll('.tile'));

  // ---------- small helpers ----------

  const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString() : '–');
  const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
  const show = (el, on) => { if (el.hidden === !!on) el.hidden = !on; };

  function mk(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function icon(name, cls, label) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'ic ' + cls);
    if (label) {
      s.setAttribute('role', 'img');
      s.setAttribute('aria-label', label);
    } else {
      s.setAttribute('aria-hidden', 'true');
    }
    const u = document.createElementNS(SVG_NS, 'use');
    u.setAttribute('href', '#i-' + name);
    s.append(u);
    return s;
  }

  function agoText(at) {
    const sec = Math.max(0, (Date.now() - at) / 1000);
    if (sec < 45) return 'just now';
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }

  function countdown(at) {
    const s = Math.ceil((at - Date.now()) / 1000);
    if (s <= 0) return 'Resuming…';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return 'Resumes in ' + (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + sec;
  }

  // Rough run time for n unfollows at the engine's pacing: ~15 s apart, plus a 5 min pause after every 5th.
  function eta(n) {
    const secs = n * AVG_GAP_S + Math.floor((n - 1) / PAUSE_EVERY) * PAUSE_S;
    let m = Math.max(1, Math.round(secs / 60));
    if (m >= 10) m = Math.round(m / 5) * 5;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? h + ' h' + (r ? ' ' + r + ' min' : '') : m + ' min';
  }

  function confirmCopy(n) {
    let t = 'Unfollow ' + fmt(n) + (n === 1 ? ' account' : ' accounts') + '? About 45 per hour, max ' + RUN_CAP +
      ' per run (≈ ' + eta(Math.min(n, RUN_CAP)) + '). Keep the Instagram tab open.';
    if (n > RUN_CAP) t += ' Only the first ' + RUN_CAP + ' will run now.';
    return t;
  }

  function setBar(bar, pct) {
    const known = typeof pct === 'number' && isFinite(pct);
    bar.classList.toggle('indet', !known);
    if (known) {
      bar.firstElementChild.style.setProperty('--p', pct + '%');
      bar.setAttribute('aria-valuenow', String(Math.round(pct)));
    } else {
      bar.removeAttribute('aria-valuenow');
    }
  }

  // ---------- avatars ----------

  function hue(s) {
    let n = 0;
    for (const c of s) n = (n * 31 + c.codePointAt(0)) >>> 0;
    return n % 360;
  }

  function initials(u) {
    const parts = (u.fullName || u.username || '').trim().split(/[\s._-]+/).filter(Boolean);
    const out = parts.slice(0, 2).map((p) => Array.from(p)[0]).join('').toUpperCase();
    return out || '?';
  }

  // The initials sit underneath the photo: they show while it lazy-loads, and the error handler below
  // just removes a broken <img> to reveal them (Instagram CDN URLs expire).
  function fillAvatar(av, u) {
    av.setAttribute('data-i', initials(u));
    av.style.setProperty('--h', String(hue(u.username || '')));
    av.replaceChildren();
    if (!u.pic) return;
    const small = av.classList.contains('sm');
    const img = mk('img');
    img.setAttribute('alt', '');
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    img.setAttribute('width', small ? '20' : '36');
    img.setAttribute('height', small ? '20' : '36');
    img.setAttribute('src', u.pic); // last, so the lazy/referrer attributes are in place before the fetch
    av.append(img);
  }

  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.parentElement && img.parentElement.classList.contains('av')) img.remove();
  }, true); // 'error' does not bubble; capture lets one listener cover every avatar

  // ---------- render: header, context card, stats, tabs ----------

  function renderHeader() {
    const name = S.profile ? S.profile.username : (S.reach && S.reach.ok && S.reach.username) || '';
    show(E.chip, !!name);
    if (!name) return;
    setText(E.chipName, '@' + name);
    const pic = S.profile ? S.profile.pic || '' : '';
    const key = name + '|' + pic;
    if (E.chipAv.getAttribute('data-key') !== key) {
      E.chipAv.setAttribute('data-key', key);
      fillAvatar(E.chipAv, { username: name, fullName: S.profile ? S.profile.fullName : '', pic });
    }
  }

  function prog(row, nEl, bar, mode, done, total) {
    row.classList.toggle('is-done', mode === 'done');
    row.classList.toggle('is-wait', mode === 'wait');
    let text;
    let pct;
    if (mode === 'wait') {
      text = 'Waiting';
      pct = 0;
    } else if (mode === 'done') {
      text = done == null ? 'Done' : fmt(done);
      pct = 100;
    } else {
      text = total ? fmt(done) + ' / ' + fmt(total) : fmt(done);
      pct = total ? Math.min(100, (done / total) * 100) : null;
    }
    setText(nEl, text);
    setBar(bar, pct);
  }

  function renderScan(s) {
    const following = s.phase === 'following';
    if (s.phase === 'followers') S.snap = { done: s.done, total: s.total };
    if (following) {
      prog(E.progFollowers, E.pfN, E.pfBar, 'done', S.snap ? S.snap.done : null, null);
      prog(E.progFollowing, E.pgN, E.pgBar, 'active', s.done, s.total);
    } else {
      prog(E.progFollowers, E.pfN, E.pfBar, 'active', s.done, s.total);
      prog(E.progFollowing, E.pgN, E.pgBar, 'wait');
    }
    setText(E.scanMsg, s.message || '');
    show(E.scanCd, !!s.resumeAt);
    if (s.resumeAt) setText(E.scanCd, countdown(s.resumeAt));
    show(E.scanMsg.parentElement, !!(s.message || s.resumeAt));
  }

  function renderContext() {
    const { s, scanning, unreachable, canAct } = flags();
    const failure = s.state === 'error' && s.job !== 'unfollow' ? s.message || 'Something went wrong.' : '';
    const notice = S.notice && S.notice.scope === 'scan' ? S.notice.text : '';
    const banner = scanning ? '' : notice || failure;
    const stopped = s.state === 'stopped' && s.job !== 'unfollow' && !!s.message;

    show(E.cardUnreach, unreachable);
    show(E.cardScan, scanning);
    if (scanning && S.focusStop) E.btnStopScan.focus(); // the button that started it just disappeared
    show(E.cardErr, !!banner);
    show(E.cardReady, !D.has && !scanning && !unreachable && !banner);
    show(E.result, stopped);

    const user = S.reach && S.reach.ok ? S.reach.username : null;
    setText(E.hint, !S.reach ? 'Checking this tab\u2026' : user ? '@' + user : 'Open your profile first');
    E.hintDot.classList.toggle('on', !!user);
    E.btnScan.disabled = !canAct;
    E.btnScan.classList.toggle('is-busy', S.starting);
    setText(E.btnScanText, S.starting ? 'Starting…' : 'Scan followers & following');

    if (banner) {
      setText(E.errTitle, notice ? "Couldn't start the scan" : s.job === 'scan' ? 'Scan failed' : 'Something went wrong');
      setText(E.errMsg, banner);
      E.btnRetry.disabled = !canAct;
    }
    if (stopped) setText(E.resultText, s.message);
    if (scanning) renderScan(s);
    renderEmpty();
    announce(s);
  }

  function renderAgo() {
    if (!D.has) return;
    setText(E.ago, S.scannedAt ? 'Scanned ' + agoText(S.scannedAt) : '');
    show(E.agoUnf, D.unf.size > 0);
    setText(E.agoUnf, D.unf.size + ' unfollowed');
  }

  function renderStats() {
    show(E.stats, D.has);
    show(E.toolbar, D.has);
    if (!D.has) return;
    const nf = S.followers.length;
    setText(E.tFollowers, fmt(nf));
    setText(E.tFollowing, fmt(S.following.length));
    setText(E.tNfb, fmt(D.nfb.length));
    setText(E.cFollowers, fmt(nf));
    setText(E.cFollowing, fmt(S.following.length));
    setText(E.cNfb, fmt(D.nfb.length));
    E.btnRescan.disabled = !flags().canAct;
    const partial = nf < 0.95 * S.profile.followerCount;
    show(E.warn, partial);
    if (partial) {
      setText(E.warnText, 'Only found ' + fmt(nf) + ' of ' + fmt(S.profile.followerCount) +
        ' followers — some people may be wrongly listed as not following back.');
    }
    renderAgo();
  }

  function renderTabs() {
    for (const t of tabBtns) {
      const on = t.dataset.tab === S.tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    }
    for (const t of tileBtns) t.setAttribute('aria-pressed', String(t.dataset.tab === S.tab));
    E.panel.setAttribute('aria-labelledby', 'tab-' + S.tab);
  }

  // Everything except the list. Cheap; safe to call on every status write.
  function renderLight() {
    renderHeader();
    renderContext();
    renderStats();
    renderDock();
    S.focusStop = false;
  }

  // ---------- screen-reader announcements ----------

  let lastLive = '';
  // Announce state changes and final messages, not every progress tick.
  const liveKey = (s) => (s.state === 'scanning' || s.state === 'unfollowing'
    ? s.state + (s.resumeAt ? '|pause' : '')
    : s.state + '|' + (s.message || ''));

  function announce(s) {
    const k = liveKey(s);
    if (k === lastLive) return;
    lastLive = k;
    setText(E.live, s.message || '');
  }

  // ---------- render: list ----------

  let listToken = 0;

  function viewItems() {
    if (!D.has) return [];
    const base = S.tab === 'followers' ? S.followers : S.tab === 'following' ? S.following : D.nfb;
    const q = S.q;
    if (!q) return base;
    return base.filter((u) => u.username.toLowerCase().includes(q) || (u.fullName || '').toLowerCase().includes(q));
  }

  function emptyCopy(items) {
    if (items.length) return '';
    if (!D.has) return flags().scanning ? 'Results appear here when the scan finishes.' : "Scan your profile to see who doesn't follow you back.";
    if (S.tab === 'nfb' && !D.nfb.length) return 'Everyone you follow follows you back 🎉';
    return S.q ? 'No matches' : 'Nothing here yet.';
  }

  function rowEl(u, selectable) {
    const done = D.unf.has(u.id);
    const li = mk('li', done ? 'row is-done' : 'row');
    li.dataset.id = u.id;
    const hit = mk(selectable ? 'label' : 'div', 'hit');
    if (selectable) {
      const cb = mk('input', 'chk');
      cb.type = 'checkbox';
      cb.checked = !S.unticked.has(u.id);
      cb.setAttribute('aria-label', 'Select @' + u.username);
      hit.append(cb);
    }
    const av = mk('span', 'av');
    fillAvatar(av, u);
    hit.append(av);

    const who = mk('span', 'who');
    const l1 = mk('span', 'l1');
    const a = mk('a', 'un', u.username);
    a.setAttribute('href', IG + encodeURIComponent(u.username) + '/');
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
    l1.append(a);
    if (u.verified) l1.append(icon('verified', 'vf', 'Verified'));
    who.append(l1);
    if (u.fullName) {
      const n = mk('span', 'l2', u.fullName);
      n.setAttribute('title', u.fullName);
      who.append(n);
    }
    hit.append(who);
    li.append(hit);
    if (done) li.append(mk('span', 'pill', 'Unfollowed'));
    return li;
  }

  function buildRows(items, nfb) {
    const frag = document.createDocumentFragment();
    for (const u of items) frag.append(rowEl(u, nfb && !D.unf.has(u.id)));
    return frag;
  }

  function renderEmpty() {
    const empty = emptyCopy(V);
    show(E.empty, !!empty);
    if (empty) setText(E.emptyText, empty);
  }

  // keepScroll: a data refresh (build everything at once, restore the scroll position).
  // Otherwise a tab/search change: first chunk now, the rest in timer-sized chunks.
  function renderList(keepScroll) {
    const token = ++listToken;
    const items = viewItems();
    V = items;
    const nfb = S.tab === 'nfb';
    renderEmpty();
    show(E.listCard, items.length > 0);
    show(E.listHead, nfb && items.length > 0);

    const top = E.scroll.scrollTop;
    E.list.replaceChildren(buildRows(keepScroll ? items : items.slice(0, FIRST_CHUNK), nfb));
    if (keepScroll) {
      E.scroll.scrollTop = top;
    } else {
      // Keep the list head just under the sticky toolbar instead of leaving the user mid-way down the old list.
      const listTop = Math.max(0, E.panel.offsetTop - E.toolbar.offsetHeight);
      if (top > listTop) E.scroll.scrollTop = listTop;
      let i = FIRST_CHUNK;
      const more = () => {
        if (token !== listToken || i >= items.length) return;
        E.list.append(buildRows(items.slice(i, i + FIRST_CHUNK), nfb));
        i += FIRST_CHUNK;
        setTimeout(more, 0); // not rAF: that stalls while the panel is hidden, and a timer lets input events in between chunks
      };
      if (items.length > FIRST_CHUNK) setTimeout(more, 0);
    }
    renderSelection();
  }

  function renderSelection() {
    if (D.has && S.tab === 'nfb') {
      let vis = 0;
      let on = 0;
      for (const u of V) {
        if (D.unf.has(u.id)) continue;
        vis++;
        if (!S.unticked.has(u.id)) on++;
      }
      E.selAll.checked = vis > 0 && on === vis;
      E.selAll.indeterminate = on > 0 && on < vis;
      E.selAll.disabled = vis === 0;
      const total = selectedCount();
      setText(E.selText, fmt(on) + ' of ' + fmt(vis) + ' selected' + (total !== on ? ' · ' + fmt(total) + ' total' : ''));
    }
    renderDock();
  }

  // ---------- render: sticky footer ----------

  function renderRun(s) {
    const done = s.done || 0;
    setText(E.runTitle, 'Unfollowed ' + fmt(done) + (s.total ? ' / ' + fmt(s.total) : ''));
    setBar(E.runBar, s.total ? Math.min(100, (done / s.total) * 100) : null);
    setText(E.runMsg, s.message || '');
    show(E.runCd, !!s.resumeAt);
    if (s.resumeAt) setText(E.runCd, countdown(s.resumeAt));
    show(E.runMsg.parentElement, !!(s.message || s.resumeAt));
  }

  function renderDock() {
    const { s, unfollowing, canAct } = flags();
    // The controls belong to the Not following back tab; a running job's progress and Stop show on every tab.
    const idleOk = D.has && S.tab === 'nfb' && D.nfb.length > 0 && !unfollowing;
    const n = idleOk ? selectedCount() : 0;
    if (S.confirming && (!idleOk || n === 0)) S.confirming = false;

    let note = '';
    let isErr = false;
    if (S.notice && S.notice.scope === 'unfollow') {
      note = S.notice.text;
      isErr = true;
    } else if (s.job === 'unfollow' && ['done', 'stopped', 'error'].includes(s.state) && s.message) {
      note = s.message;
      isErr = s.state === 'error';
    }
    show(E.dockNote, !!note);
    if (note) {
      setText(E.dockNoteText, note);
      E.dockNote.classList.toggle('is-err', isErr);
    }

    show(E.dockIdle, idleOk && !S.confirming);
    show(E.dockConfirm, idleOk && S.confirming);
    show(E.dockRun, unfollowing);
    show(E.dock, unfollowing || idleOk || !!note);
    if (unfollowing && S.focusStop) E.btnStopRun.focus();

    if (idleOk) {
      setText(E.btnUnfollow, 'Unfollow ' + fmt(n) + ' selected');
      E.btnUnfollow.disabled = n === 0 || !canAct;
      if (S.confirming) {
        setText(E.confirmText, confirmCopy(n));
        setText(E.btnYes, S.starting ? 'Starting…' : 'Yes, unfollow');
        E.btnYes.disabled = S.starting;
        E.btnCancel.disabled = S.starting;
      }
    }
    if (unfollowing) renderRun(s);
  }

  // ---------- actions ----------

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function send(msg) {
    const tab = await activeTab();
    if (!tab) throw new Error('no active tab');
    S.tabId = tab.id;
    return chrome.tabs.sendMessage(tab.id, msg);
  }

  function endStarting() {
    if (!S.starting) return;
    S.starting = false;
    S.confirming = false;
    renderLight();
  }

  // Sends scan/unfollow. Any rejection (not an Instagram tab, content script missing) means "open / reload Instagram".
  async function command(msg, scope) {
    S.starting = true;
    S.notice = null;
    renderLight();
    try {
      const r = await send(msg);
      if (r && r.ok) {
        // The status write normally lands first and clears this; the timer covers a silent engine.
        setTimeout(endStarting, 1500);
        return;
      }
      S.notice = { scope, text: (r && r.error) || 'Instagram did not accept the request.' };
    } catch (err) {
      S.reach = { ok: false };
      schedulePing(1500); // recovers by itself if this was a blip rather than a wrong tab
    }
    S.starting = false;
    S.confirming = false;
    renderLight();
    if (S.notice) setText(E.live, S.notice.text); // a rejected request is not a status change, so announce it here
  }

  const startScan = () => command({ type: 'scan' }, 'scan');
  const startUnfollow = () => command({ type: 'unfollow', ids: selectedIds() }, 'unfollow');

  function stop() {
    chrome.storage.local.set({
      stopAt: Date.now(),
      status: { ...S.status, state: 'stopped', message: 'Stopped.', resumeAt: null },
    });
  }

  function setTab(t) {
    if (t === S.tab) return;
    S.tab = t;
    S.confirming = false;
    renderTabs();
    renderList(false);
  }

  // ---------- reachability: ping the active tab ----------

  let pingSeq = 0;
  let pingTimer = 0;
  let retryTimer = 0;

  function setReach(r) {
    const p = S.reach;
    S.reach = r;
    if (!p || p.ok !== r.ok || p.username !== r.username) renderLight();
  }

  async function ping(isRetry) {
    const seq = ++pingSeq;
    let reach = { ok: false };
    try {
      const tab = await activeTab();
      if (tab) {
        S.tabId = tab.id;
        const r = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
        if (r && r.ok) reach = { ok: true, username: r.username || null };
      }
    } catch (err) {
      // rejected: not an Instagram tab, or the content script is not there yet
    }
    if (seq !== pingSeq) return;
    setReach(reach);
    clearTimeout(retryTimer);
    // A page that just finished loading may not have registered its listener yet; look once more.
    if (!reach.ok && !isRetry) retryTimer = setTimeout(() => ping(true), 1500);
  }

  function schedulePing(delay) {
    clearTimeout(pingTimer);
    pingTimer = setTimeout(ping, delay);
  }

  // ---------- storage ----------

  const touched = new Set(); // keys changed by onChanged before the initial read returned

  function onStatus(prev, cur) {
    const state = cur ? cur.state : null;
    if (state === 'scanning' && !(prev && prev.state === 'scanning')) S.snap = null;
    if (state === 'scanning' || state === 'unfollowing') {
      if (S.starting) S.focusStop = true;
      S.starting = false;
      S.confirming = false;
    }
    S.notice = null; // any new status supersedes a message from an earlier rejected request
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let lists = false;
    let onlyUnfollowed = true;
    for (const k of Object.keys(changes)) {
      if (!KEYS.includes(k)) continue; // e.g. stopAt, which only the panel writes
      touched.add(k);
      const prev = S[k];
      const next = changes[k].newValue;
      S[k] = next === undefined ? (k === 'unfollowed' ? [] : null) : next;
      if (k === 'status') {
        onStatus(prev, S.status);
        armLiveness();
      }
      if (LIST_KEYS.includes(k)) {
        lists = true;
        if (k !== 'unfollowed') onlyUnfollowed = false;
      }
    }
    if (!lists) {
      renderLight(); // status / scannedAt: never touches the list
      return;
    }
    derive();
    renderTabs();
    renderLight();
    // The Followers rows do not depend on `unfollowed`, so a run's per-account writes skip rebuilding them.
    if (onlyUnfollowed && S.tab === 'followers') renderSelection();
    else renderList(true);
  });

  // ---------- events ----------

  for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => setTab(b.dataset.tab));

  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    let i = TAB_ORDER.indexOf(S.tab);
    if (e.key === 'ArrowRight') i = (i + 1) % 3;
    else if (e.key === 'ArrowLeft') i = (i + 2) % 3;
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = 2;
    else return;
    e.preventDefault();
    setTab(TAB_ORDER[i]);
    document.getElementById('tab-' + TAB_ORDER[i]).focus();
  });

  let qTimer = 0;
  E.q.addEventListener('input', () => {
    show(E.qClear, E.q.value !== '');
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      S.q = E.q.value.trim().replace(/^@/, '').toLowerCase();
      renderList(false);
    }, 120);
  });
  E.qClear.addEventListener('click', () => {
    E.q.value = '';
    E.q.dispatchEvent(new Event('input'));
    E.q.focus();
  });

  E.list.addEventListener('change', (e) => {
    const cb = e.target;
    const li = cb.closest && cb.closest('li');
    if (!li || !cb.classList.contains('chk')) return;
    if (cb.checked) S.unticked.delete(li.dataset.id);
    else S.unticked.add(li.dataset.id);
    renderSelection();
  });

  E.selAll.addEventListener('change', () => {
    const on = E.selAll.checked;
    for (const u of V) {
      if (D.unf.has(u.id)) continue;
      if (on) S.unticked.delete(u.id);
      else S.unticked.add(u.id);
    }
    for (const cb of E.list.querySelectorAll('.chk')) cb.checked = on;
    renderSelection();
  });

  E.btnScan.addEventListener('click', startScan);
  E.btnRescan.addEventListener('click', startScan);
  E.btnRetry.addEventListener('click', startScan);
  E.btnStopScan.addEventListener('click', stop);
  E.btnStopRun.addEventListener('click', stop);

  E.btnUnfollow.addEventListener('click', () => {
    S.confirming = true;
    renderDock();
    E.btnCancel.focus(); // Enter right after the click should cancel, not confirm
  });
  const cancelConfirm = () => {
    if (!S.confirming || S.starting) return;
    S.confirming = false;
    renderDock();
    E.btnUnfollow.focus();
  };
  E.btnCancel.addEventListener('click', cancelConfirm);
  E.btnYes.addEventListener('click', startUnfollow);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelConfirm(); });

  E.btnOpen.addEventListener('click', async () => {
    try {
      const tab = await activeTab();
      if (tab) await chrome.tabs.update(tab.id, { url: IG });
    } catch (err) {
      // nothing to recover: the next ping shows the state
    }
  });
  E.btnReload.addEventListener('click', async () => {
    try {
      const tab = await activeTab();
      if (tab) await chrome.tabs.reload(tab.id);
    } catch (err) {
      // as above
    }
  });

  chrome.tabs.onActivated.addListener(() => schedulePing(150));
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if ((tabId === S.tabId || (tab && tab.active)) && (info.status === 'complete' || info.url)) schedulePing(300);
  });
  window.addEventListener('focus', () => schedulePing(150));

  // The 1 s timer touches only the countdown text; the "Scanned ... ago" text has its own slow one.
  setInterval(() => {
    const at = effective().resumeAt;
    if (!at) return;
    const t = countdown(at);
    for (const el of [E.scanCd, E.runCd]) if (!el.hidden) setText(el, t);
  }, 1000);
  setInterval(renderAgo, 30000);

  // ---------- init ----------

  async function init() {
    const got = await chrome.storage.local.get(KEYS);
    for (const k of KEYS) if (got[k] !== undefined && !touched.has(k)) S[k] = got[k];
    if (!Array.isArray(S.unfollowed)) S.unfollowed = [];
    derive();
    lastLive = liveKey(effective()); // do not announce a stale message on open
    armLiveness();
    renderTabs();
    renderLight();
    renderList(false);
    ping();
  }

  init();
})();
