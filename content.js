// Followback engine. Runs inside a logged-in instagram.com tab and calls the same internal API the
// site's own Followers dialog uses. chrome.storage.local is the source of truth; the side panel only
// renders it. Contract and rationale: PLAN.md.

const PAGE_PAUSE_MS = [1000, 2500]; // random gap between list pages, so paging reads like scrolling
const UNFOLLOW_PAUSE_MS = [10000, 20000]; // random gap between unfollows; faster is what trips action blocks
const BATCH_SIZE = 5; // a long rest after every 5th unfollow keeps bursts short
const BATCH_PAUSE_MS = 5 * 60 * 1000; // with the gaps above, this works out to about 45 unfollows an hour
const MAX_UNFOLLOWS = 150; // per run; past roughly this many in a day, blocks get likely
const RATE_LIMIT_WAIT_MS = 2 * 60 * 1000; // a rate-limited scan usually recovers within a couple of minutes
const MAX_RETRIES = 3; // if three waits in a row didn't help, waiting longer in this run won't either
const TICK_MS = 1000; // longest sleep between stop-flag checks, so Stop lands within about a second
const STALE_MS = 2 * 60 * 1000; // a live job writes status at least this often; longer rests announce resumeAt

const USERNAME = /^[\w.]+$/;
const LOGIN_ERROR = 'Log in to Instagram in this tab first.';
const CHECK_ERROR = 'Instagram sent this tab to a login or security check — finish it on instagram.com, then try again.';
const SCAN_LIMITED =
  'Instagram is rate-limiting your account (HTTP 429). Wait 15–30 minutes, then scan again — retrying sooner tends to extend it.';
const UNFOLLOW_LIMITED =
  'Instagram is limiting unfollows right now — wait a few hours (ideally a day) before continuing.';

class Stopped extends Error {}
class RateLimited extends Error {}

let status = {}; // this tab's job status: merged into, then written whole (no read-modify-write)
let stored = {}; // the latest status in storage, whichever Instagram tab wrote it
let stopRequested = false;

const running = (s) => s?.state === 'scanning' || s?.state === 'unfollowing';
// A job dies silently with its tab, so a running status only counts while it keeps being written.
const alive = (s) => running(s) && Date.now() - Math.max(s.at || 0, s.resumeAt || 0) < STALE_MS;
// One job across all tabs: a second one alongside it would double the pace Instagram sees.
const busy = () => running(status) || alive(stored);
const cookie = (name) =>
  document.cookie.split('; ').find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
const between = ([min, max]) => min + Math.random() * (max - min);
const check = () => {
  if (stopRequested) throw new Stopped();
};

function save(patch) {
  Object.assign(status, patch, { at: Date.now() });
  return chrome.storage.local.set({ status });
}
const finish = (state, message) => save({ state, phase: null, resumeAt: null, message });

// Sleeps in short ticks so Stop is noticed quickly. The tick count (not the clock) bounds the loop, so
// stubbed timers terminate; the deadline ends it on time when a background tab fires timers late.
async function wait(ms) {
  const end = Date.now() + ms;
  for (let left = ms; ; left -= TICK_MS) {
    check();
    if (left <= 0 || Date.now() >= end) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, TICK_MS)));
  }
}

// A long wait the panel renders as a countdown.
async function pause(ms, message) {
  save({ message, resumeAt: Date.now() + ms });
  await wait(ms);
  save({ resumeAt: null });
}

// Requests and headers mirror a known-working web client (PLAN.md); anything unusual reads as a bot to Instagram.
async function api(path, post = false) {
  check(); // also gates the first request of a job, which has no wait() before it
  if (!cookie('ds_user_id')) throw new Error(LOGIN_ERROR);
  const headers = { 'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '198387', 'X-Requested-With': 'XMLHttpRequest' };
  if (post) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['X-CSRFToken'] = cookie('csrftoken') || '';
    headers['X-Instagram-AJAX'] = '1';
  }
  const res = await fetch(`https://www.instagram.com/${path}`, { method: post ? 'POST' : 'GET', credentials: 'include', headers });
  if (res.redirected) throw new Error(CHECK_ERROR); // to a login or "confirm it's you" page
  const json = await res.json().catch(() => ({}));
  if (res.status === 429 || json.spam || json.message === 'feedback_required') throw new RateLimited();
  if (json.message === 'login_required') throw new Error(LOGIN_ERROR);
  if (!res.ok || json.status !== 'ok') {
    throw new Error(json.feedback_title || json.message || `Instagram returned HTTP ${res.status}.`);
  }
  return json;
}

// A rate limit mid-scan is waited out. One on the very first request means the account is already limited, and
// retrying then only prolongs it, so that fails fast. Unfollows never retry (see unfollow()).
async function read(path, patient) {
  for (let retries = 0; ; retries++) {
    try {
      return await api(path);
    } catch (e) {
      if (!(e instanceof RateLimited)) throw e;
      if (!patient || retries === MAX_RETRIES) throw new Error(SCAN_LIMITED);
      await pause(RATE_LIMIT_WAIT_MS, `Rate-limited by Instagram — retrying (${retries + 1} of ${MAX_RETRIES}).`);
    }
  }
}

const toUser = (u) => ({
  id: String(u.pk_id ?? u.pk),
  username: u.username,
  fullName: u.full_name || '',
  pic: u.profile_pic_url || '',
  verified: !!u.is_verified,
  isPrivate: !!u.is_private,
});

async function readList(id, kind, total) {
  const users = new Map();
  let cursor = '';
  do {
    // Instagram serves followers about 25 at a time whatever count asks for.
    const params = new URLSearchParams(kind === 'followers' ? { count: '25' } : { order: 'date_followed_latest' });
    if (cursor) params.set('max_id', cursor);
    const page = await read(`api/v1/friendships/${id}/${kind}/?${params}`, kind === 'following' || !!cursor);
    for (const raw of page.users) {
      const user = toUser(raw);
      users.set(user.id, user);
    }
    cursor = page.next_max_id;
    save({ state: 'scanning', phase: kind, done: users.size, total, message: `Reading ${kind}…` });
    if (cursor) await wait(between(PAGE_PAUSE_MS));
  } while (cursor);
  return [...users.values()];
}

// The panel's label and totals, read off the page when it's your own profile (it links to Edit profile). Best
// effort, so no extra request: the progress totals and the incomplete-scan warning cope with null.
function pageProfile(id) {
  const segment = location.pathname.split('/')[1];
  const own = USERNAME.test(segment) && !!document.querySelector('a[href="/accounts/edit/"]');
  const count = (kind) => {
    const link = own && document.querySelector(`a[href="/${segment}/${kind}/"]`);
    const span = link && (link.querySelector('span[title]') || link.querySelector('span')); // title: exact "12,345" behind "12.3K"
    const text = span ? span.title || span.textContent : '';
    return /^[\d.,\s]+$/.test(text) ? Number(text.replace(/\D/g, '')) : null;
  };
  return {
    id,
    username: own ? segment : null,
    fullName: '',
    pic: (own && document.querySelector('header img')?.src) || '',
    followerCount: count('followers'),
    followingCount: count('following'),
  };
}

async function scan() {
  const profile = pageProfile(cookie('ds_user_id')); // always the logged-in account, whatever page the tab is on
  const followers = await readList(profile.id, 'followers', profile.followerCount);
  const following = await readList(profile.id, 'following', profile.followingCount);
  check(); // a Stop that landed during the last page must still save nothing
  await chrome.storage.local.set({ profile, followers, following, unfollowed: [], scannedAt: Date.now() });
  return `Found ${followers.length} followers and ${following.length} following.`;
}

async function unfollow(ids) {
  const stored = await chrome.storage.local.get(['followers', 'following', 'unfollowed']);
  const unfollowed = stored.unfollowed || [];
  // Re-check here, whatever the panel sent: a panel bug must never unfollow someone who follows you.
  const skip = new Set([...(stored.followers || []).map((u) => u.id), ...unfollowed]);
  const wanted = new Set(ids);
  const queue = (stored.following || [])
    .filter((u) => wanted.has(u.id) && !skip.has(u.id))
    .slice(0, MAX_UNFOLLOWS);

  for (const [i, user] of queue.entries()) {
    if (i) {
      await wait(between(UNFOLLOW_PAUSE_MS));
      if (i % BATCH_SIZE === 0) await pause(BATCH_PAUSE_MS, "Pausing to stay under Instagram's limits");
    }
    save({ message: `Unfollowing @${user.username}…`, done: i, total: queue.length });
    try {
      await api(`web/friendships/${user.id}/unfollow/`, true);
    } catch (e) {
      // Never retry: pushing on after a limit is how accounts get blocked.
      throw e instanceof RateLimited ? new Error(UNFOLLOW_LIMITED) : e;
    }
    unfollowed.push(user.id);
    await chrome.storage.local.set({ unfollowed });
    save({ done: i + 1, message: `Unfollowed @${user.username}.` });
  }
  const capNote = ` Stopped at ${MAX_UNFOLLOWS} for today — run again tomorrow to avoid an Instagram block.`;
  return `Unfollowed ${queue.length} account${queue.length === 1 ? '' : 's'}.${queue.length === MAX_UNFOLLOWS ? capNote : ''}`;
}

async function run(job, work) {
  stopRequested = false;
  const state = job === 'scan' ? 'scanning' : 'unfollowing';
  save({ state, job, phase: null, done: 0, total: null, message: 'Starting…', resumeAt: null });
  try {
    finish('done', await work());
  } catch (e) {
    if (!(e instanceof Stopped)) return finish('error', e.message);
    const unfollowed = `Unfollow stopped after ${status.done} of ${status.total}.`;
    finish('stopped', job === 'scan' ? 'Scan stopped — nothing saved.' : unfollowed);
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.stopAt) stopRequested = true;
  if (changes.status) stored = changes.status.newValue || {};
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === 'ping') {
    // A hint only: a profile page links to /<username>/followers/. The segment goes into a selector, so validate it.
    const segment = location.pathname.split('/')[1];
    const onProfile = USERNAME.test(segment) && document.querySelector(`a[href="/${segment}/followers/"]`);
    reply({ ok: true, username: onProfile ? segment : null, busy: busy() });
  } else if (msg.type === 'scan' || msg.type === 'unfollow') {
    if (busy()) return reply({ ok: false, error: 'Another job is already running.' });
    run(msg.type, msg.type === 'scan' ? scan : () => unfollow(msg.ids));
    reply({ ok: true });
  }
});

// Another tab may be mid-job. Don't touch its status: the panel shows a job that went quiet as interrupted.
chrome.storage.local.get('status').then((result) => {
  if (!stored.at) stored = result.status || {}; // unless a fresher write already arrived
});
