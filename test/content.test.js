// Drives content.js the way the side panel does: through its onMessage handler and chrome.storage,
// with fetch, the DOM and timers stubbed. No browser, no Instagram.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { join } = require('node:path');

const SOURCE = fs.readFileSync(join(__dirname, '..', 'content.js'), 'utf8');
const BASE = 'https://www.instagram.com/';
const RESULT_KEYS = ['profile', 'followers', 'following', 'unfollowed', 'scannedAt'];
const GET_HEADERS = { 'X-IG-App-ID': '936619743392459', 'X-ASBD-ID': '198387', 'X-Requested-With': 'XMLHttpRequest' };
const STATUS_KEYS = ['at', 'done', 'job', 'message', 'phase', 'resumeAt', 'state', 'total'];
const FINAL = ['done', 'stopped', 'error'];

const tick = () => new Promise((resolve) => setImmediate(resolve));
// Storage and messaging hand over plain data; cloning also keeps vm-realm objects out of assertions.
const clone = (value) => JSON.parse(JSON.stringify(value));

const ok = (body = {}) => [200, { status: 'ok', ...body }];
const ig = (pk, extra = {}) => ({ pk, username: `u${pk}`, full_name: `User ${pk}`, profile_pic_url: `pic${pk}`, ...extra });
const user = (id, extra = {}) => ({ id, username: `u${id}`, fullName: `User ${id}`, pic: `pic${id}`, verified: false, isPrivate: false, ...extra });
const following = (...ids) => ids.map((id) => user(id));

// A fake instagram.com for logged-in user 42: both lists paged by index, and unfollow.
function instagram({ followers = [[]], following = [[]], destroy = () => ok() } = {}) {
  const lists = { followers, following };
  return (path) => {
    const list = path.match(/^api\/v1\/friendships\/42\/(followers|following)\/\?(.*)$/);
    if (list) {
      const pages = lists[list[1]];
      const page = Number(new URLSearchParams(list[2]).get('max_id') ?? 0);
      return ok({ users: pages[page], ...(page + 1 < pages.length && { next_max_id: String(page + 1) }) });
    }
    const target = path.match(/^web\/friendships\/(\d+)\/unfollow\/$/);
    if (target) return destroy(target[1]);
    return assert.fail(`unexpected request: ${path}`);
  };
}

// A profile link's count, as Instagram renders it: the shown text, plus the exact number in a title when abbreviated.
const countLink = (text, title = '') => ({
  querySelector: (s) => (s === 'span[title]' ? (title ? { title, textContent: text } : null) : s === 'span' ? { title: '', textContent: text } : null),
});
// Your own profile page: it links to Edit profile.
const ownProfile = (followers = countLink('3'), following = countLink('2')) => ({
  'a[href="/me/followers/"]': followers,
  'a[href="/me/following/"]': following,
  'a[href="/accounts/edit/"]': {},
  'header img': { src: 'me.jpg' },
});
const SELECTOR = /^(a\[href="\/[\w.]+\/(followers|following)\/"\]|a\[href="\/accounts\/edit\/"\]|header img)$/;

async function load({ stored = {}, pathname = '/me/', dom = ownProfile(), route = instagram() } = {}) {
  const env = {
    store: clone(stored),
    cookie: 'a=1; csrftoken=tok; ds_user_id=42',
    location: { pathname },
    writes: [], // every storage.set() call, in order
    statuses: [], // every status written
    calls: [], // every fetch
    clock: 0,
    maxSleep: 0,
    minSleep: 0,
  };
  const start = Date.now();
  const listeners = [];
  let onMessage;

  env.set = async (items) => {
    const written = clone(items);
    env.writes.push(written);
    if (written.status) env.statuses.push(written.status);
    Object.assign(env.store, written);
    const changes = Object.fromEntries(Object.keys(written).map((key) => [key, { newValue: written[key] }]));
    listeners.forEach((listener) => listener(changes));
  };
  env.send = (msg) => {
    let reply;
    onMessage(msg, {}, (r) => (reply = clone(r)));
    return reply;
  };

  const sandbox = {
    chrome: {
      storage: {
        local: {
          get: async (keys) => clone(Object.fromEntries([].concat(keys).filter((k) => k in env.store).map((k) => [k, env.store[k]]))),
          set: env.set,
        },
        onChanged: { addListener: (fn) => listeners.push(fn) },
      },
      runtime: { onMessage: { addListener: (fn) => (onMessage = fn) } },
    },
    fetch: async (url, init) => {
      assert.ok(url.startsWith(BASE), url);
      const path = url.slice(BASE.length);
      const { method, credentials, headers, body } = init;
      env.calls.push({ path, method, credentials, headers: { ...headers }, body: body && String(body) });
      const [code, json, extra = {}] = await route(path);
      const parse = async () => {
        if (json === undefined) throw new SyntaxError('Unexpected token <'); // as res.json() does on an HTML page
        return json;
      };
      return { ok: code < 400, status: code, redirected: !!extra.redirected, json: parse };
    },
    document: {
      get cookie() {
        return env.cookie;
      },
      // Only the selectors content.js should use; like a real DOM, anything malformed throws.
      querySelector: (selector) => {
        if (!SELECTOR.test(selector)) throw new SyntaxError(`invalid selector: ${selector}`);
        return dom[selector] ?? null;
      },
      querySelectorAll: () => [],
    },
    location: env.location,
    // Virtual time: timers fire at once, but the clock advances by what was asked (or by minSleep, for a
    // background tab that fires timers late), so pacing stays measurable and Date.now() agrees with it.
    setTimeout: (fn, ms) => {
      env.clock += Math.max(ms, env.minSleep);
      env.maxSleep = Math.max(env.maxSleep, ms);
      env.onSleep?.();
      setImmediate(fn);
    },
    Date: { now: () => start + env.clock },
    URLSearchParams,
  };
  vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'content.js' });
  await tick(); // let the on-load storage read settle
  return env;
}

// Polls storage as the panel would, until the job reaches a final state.
async function finished(env) {
  for (let i = 0; i < 200000 && !FINAL.includes(env.store.status?.state); i++) await tick();
  const { status } = env.store;
  assert.ok(FINAL.includes(status?.state), `job never finished: ${JSON.stringify(status)}`);
  for (const written of env.statuses) assert.deepEqual(Object.keys(written).sort(), STATUS_KEYS);
  return status;
}

test('scan pages through both lists, dedupes by id, and saves everything in one set()', async () => {
  const bob = { pk: 'old', pk_id: 11, username: 'bob', full_name: null, profile_pic_url: null, is_private: true };
  const verified = ig('10', { is_verified: true });
  const route = instagram({
    followers: [[verified, bob], [verified, ig('12')]],
    following: [[verified, ig('13')]],
  });
  const env = await load({ route, stored: { followers: following('99'), unfollowed: ['13'] } });

  assert.deepEqual(env.send({ type: 'scan' }), { ok: true });
  const status = await finished(env);

  assert.equal(status.state, 'done');
  assert.equal(status.message, 'Found 3 followers and 2 following.');
  assert.deepEqual(env.store.followers, [
    user('10', { verified: true }),
    { id: '11', username: 'bob', fullName: '', pic: '', verified: false, isPrivate: true },
    user('12'),
  ]);
  assert.deepEqual(env.store.following.map((u) => u.id), ['10', '13']);
  assert.deepEqual(env.store.unfollowed, []);
  assert.deepEqual(env.store.profile, { id: '42', username: 'me', fullName: '', pic: 'me.jpg', followerCount: 3, followingCount: 2 });
  assert.equal(typeof env.store.scannedAt, 'number');

  const saves = env.writes.filter((written) => RESULT_KEYS.some((key) => key in written));
  assert.equal(saves.length, 1);
  assert.deepEqual(Object.keys(saves[0]).sort(), [...RESULT_KEYS].sort());

  assert.deepEqual(env.calls.map((c) => c.path), [
    'api/v1/friendships/42/followers/?count=25',
    'api/v1/friendships/42/followers/?count=25&max_id=1',
    'api/v1/friendships/42/following/?order=date_followed_latest',
  ]);
  assert.deepEqual(env.calls[0], {
    path: 'api/v1/friendships/42/followers/?count=25',
    method: 'GET',
    credentials: 'include',
    headers: GET_HEADERS,
    body: undefined,
  });
  const progress = env.statuses.filter((s) => s.phase).map((s) => [s.phase, s.done, s.total]);
  assert.deepEqual(progress, [['followers', 2, 3], ['followers', 3, 3], ['following', 2, 2]]);
});

for (const [name, pathname, dom] of [
  ["someone else's profile", '/other/', { 'a[href="/other/followers/"]': countLink('999'), 'a[href="/other/following/"]': countLink('9') }],
  ['a page that is not a profile', '/', {}],
]) {
  test(`scan on ${name} still reads your account, without borrowing that page's label or totals`, async () => {
    const env = await load({ pathname, dom, route: instagram({ followers: [[ig('10')]], following: [[ig('11')]] }) });

    env.send({ type: 'scan' });
    assert.equal((await finished(env)).state, 'done');

    assert.ok(env.calls.every((c) => c.path.startsWith('api/v1/friendships/42/')), 'the ds_user_id account');
    assert.deepEqual(env.store.profile, { id: '42', username: null, fullName: '', pic: '', followerCount: null, followingCount: null });
  });
}

for (const [shown, title, count] of [['1,234', '', 1234], ['1.234', '', 1234], ['1\u202f234', '', 1234], ['12.3K', '12,345', 12345], ['1,2 M', '', null]]) {
  test(`your profile's follower count "${shown}"${title && ` (title "${title}")`} reads as ${count}`, async () => {
    const env = await load({ dom: ownProfile(countLink(shown, title)), route: instagram({ followers: [[ig('10')]] }) });

    env.send({ type: 'scan' });
    await finished(env);

    assert.equal(env.store.profile.followerCount, count);
  });
}

for (const [name, response, message] of [
  ['login_required', [403, { status: 'fail', message: 'login_required' }], 'Log in to Instagram in this tab first.'],
  ['a failure with a title', [400, { status: 'fail', message: 'nope', feedback_title: 'Action blocked' }], 'Action blocked'],
  ['a failure with only a message', [400, { status: 'fail', message: 'Something went wrong' }], 'Something went wrong'],
  ['a response that is not JSON', [502, undefined], 'Instagram returned HTTP 502.'],
  ['a redirect to a login or check page', [200, undefined, { redirected: true }], 'Instagram sent this tab to a login or security check — finish it on instagram.com, then try again.'],
]) {
  test(`scan reports ${name} in plain words and saves nothing`, async () => {
    const env = await load({ route: () => response });

    env.send({ type: 'scan' });
    const status = await finished(env);

    assert.deepEqual([status.state, status.message], ['error', message]);
    assert.ok(env.writes.every((written) => !RESULT_KEYS.some((key) => key in written)), 'nothing saved');
  });
}

test('without a ds_user_id cookie nothing is requested and the user is told to log in', async () => {
  const env = await load();
  env.cookie = 'csrftoken=tok';

  env.send({ type: 'scan' });
  const status = await finished(env);

  assert.deepEqual([status.state, status.message, env.calls.length], ['error', 'Log in to Instagram in this tab first.', 0]);
});

test('unfollow skips followers, already-unfollowed ids and ids not in following, and persists unfollowed', async () => {
  const stored = { following: following('1', '2', '3', '4', '5'), followers: following('2'), unfollowed: ['3'] };
  const env = await load({ stored });

  assert.deepEqual(env.send({ type: 'unfollow', ids: ['1', '2', '3', '4', '999'] }), { ok: true });
  const status = await finished(env);

  assert.equal(status.state, 'done');
  assert.equal(status.message, 'Unfollowed 2 accounts.');
  assert.deepEqual([status.done, status.total], [2, 2]);
  assert.deepEqual(env.calls.map((c) => [c.method, c.path, c.body]), [
    ['POST', 'web/friendships/1/unfollow/', undefined],
    ['POST', 'web/friendships/4/unfollow/', undefined],
  ]);
  assert.deepEqual(env.calls[0].headers, {
    ...GET_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-CSRFToken': 'tok',
    'X-Instagram-AJAX': '1',
  });
  assert.deepEqual(env.store.unfollowed, ['3', '1', '4']);
});

for (const [name, limited] of [
  ['HTTP 429', [429, {}]],
  ['spam: true', [400, { status: 'fail', message: 'Try again later', spam: true }]],
  ['feedback_required', [400, { status: 'fail', message: 'feedback_required' }]],
]) {
  test(`unfollow stops at the first rate-limit (${name}) and makes no further destroy calls`, async () => {
    const route = instagram({ destroy: (id) => (id === '2' ? limited : ok()) });
    const env = await load({ route, stored: { following: following('1', '2', '3') } });

    env.send({ type: 'unfollow', ids: ['1', '2', '3'] });
    const status = await finished(env);

    assert.equal(status.state, 'error');
    assert.match(status.message, /^Instagram is limiting unfollows right now/);
    assert.deepEqual(env.calls.map((c) => c.path), ['web/friendships/1/unfollow/', 'web/friendships/2/unfollow/']);
    assert.deepEqual(env.store.unfollowed, ['1']);
  });
}

// The panel also writes status on Stop; these tests write only stopAt so that polling sees the engine's own final write.
for (const [name, requestOnStop, calls] of [
  ['during the first request', 'followers/?count=25', 1], // nothing may be requested after it
  ['between pages', 'max_id=1', 2],
  ['during the very last page', 'order=date_followed_latest', 3], // the lists are complete, but must still not be saved
]) {
  test(`stopAt halts a running scan (${name}) and saves nothing`, async () => {
    const world = instagram({ followers: [[ig('10')], [ig('11')]], following: [[ig('12')]] });
    const stored = { followers: following('1'), scannedAt: 5 };
    const env = await load({
      stored,
      route: (path) => {
        if (path.endsWith(requestOnStop)) env.set({ stopAt: Date.now() });
        return world(path);
      },
    });

    env.send({ type: 'scan' });
    const status = await finished(env);

    assert.equal(status.state, 'stopped');
    assert.equal(status.message, 'Scan stopped — nothing saved.');
    assert.equal(env.calls.length, calls);
    assert.deepEqual([env.store.followers, env.store.scannedAt], [stored.followers, 5]);
    assert.ok(env.writes.every((written) => !RESULT_KEYS.some((key) => key in written)), 'nothing saved');
  });
}

test('stopAt halts a running unfollow before the next request, and the next job is not stopped', async () => {
  let stopOnce = true;
  const destroy = () => {
    if (stopOnce) env.set({ stopAt: Date.now() });
    stopOnce = false;
    return ok();
  };
  const env = await load({ route: instagram({ destroy }), stored: { following: following('1', '2', '3') } });

  env.send({ type: 'unfollow', ids: ['1', '2', '3'] });
  const status = await finished(env);

  assert.equal(status.state, 'stopped');
  assert.deepEqual(env.calls.map((c) => c.path), ['web/friendships/1/unfollow/']);
  assert.deepEqual(env.store.unfollowed, ['1']); // the unfollow that went through is still recorded

  env.send({ type: 'unfollow', ids: ['2', '3'] });
  assert.equal((await finished(env)).state, 'done');
  assert.deepEqual(env.store.unfollowed, ['1', '2', '3']);
});

test('Stop lands within a tick even in the middle of a 5 minute rest', async () => {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const env = await load({ stored: { following: following(...ids) } });
  let stoppedAt;
  env.onSleep = () => {
    if (env.store.status.resumeAt && stoppedAt === undefined) {
      stoppedAt = env.clock; // first tick of the rest
      env.set({ stopAt: Date.now() });
    }
  };

  env.send({ type: 'unfollow', ids });
  const status = await finished(env);

  assert.equal(status.state, 'stopped');
  assert.equal(env.clock, stoppedAt, 'never slept again after Stop');
  assert.deepEqual(env.store.unfollowed, ids.slice(0, 5));
});

test('unfollow caps a run at 150 and paces it: 10-20 s apart, plus a 5 minute rest after every 5th', async () => {
  const ids = Array.from({ length: 160 }, (_, i) => String(i + 1));
  const times = []; // virtual time of each unfollow
  const destroy = () => {
    times.push(env.clock);
    return ok();
  };
  const env = await load({ route: instagram({ destroy }), stored: { following: following(...ids) } });

  env.send({ type: 'unfollow', ids });
  const status = await finished(env);

  assert.equal(status.state, 'done');
  assert.match(status.message, /^Unfollowed 150 accounts\. Stopped at 150 for today/);
  assert.deepEqual(env.store.unfollowed, ids.slice(0, 150));
  times.slice(1).forEach((time, i) => {
    const gap = time - times[i];
    const rest = (i + 1) % 5 === 0 ? 5 * 60 * 1000 : 0;
    assert.ok(gap >= 10000 + rest && gap <= 20000 + rest, `gap before unfollow ${i + 2}: ${gap}`);
  });
  const rests = env.statuses.filter((s) => s.resumeAt);
  assert.equal(rests.length, 29); // after unfollows 5, 10, ... 145 (nothing to rest for after the last)
  assert.ok(rests.every((s) => s.resumeAt - s.at === 5 * 60 * 1000 && s.message === "Pausing to stay under Instagram's limits"));
  assert.ok(env.maxSleep <= 1000, 'sleeps in ticks of a second or less');
});

test('a background tab that fires timers late still keeps to the clock', async () => {
  const times = [];
  const destroy = () => {
    times.push(env.clock);
    return ok();
  };
  const env = await load({ route: instagram({ destroy }), stored: { following: following('1', '2', '3') } });
  env.minSleep = 60 * 1000; // hidden tabs fire timers about once a minute

  env.send({ type: 'unfollow', ids: ['1', '2', '3'] });
  await finished(env);

  // One late tick ends each 10-20 s wait; counting ticks alone would take 10+ minutes.
  assert.deepEqual(times.slice(1).map((time, i) => time - times[i]), [60000, 60000]);
});

test('a rate limit on the very first request fails fast: the account is already limited', async () => {
  const env = await load({ route: () => [429, { status: 'fail', message: 'Please wait a few minutes before you try again.' }] });

  env.send({ type: 'scan' });
  const status = await finished(env);

  assert.equal(status.state, 'error');
  assert.match(status.message, /^Instagram is rate-limiting your account \(HTTP 429\)\. Wait 15–30 minutes/);
  assert.deepEqual([env.calls.length, env.clock], [1, 0], 'one request, no waiting');
});

test('scan waits out rate limits mid-scan and retries, then gives up after 3 in a row', async () => {
  const world = instagram({ followers: [[ig('10')], [ig('11')]], following: [[ig('12')]] });
  const secondPage = (path) => path.endsWith('max_id=1');
  let limited = 2; // the second followers page is rate-limited twice
  let env = await load({ route: (path) => (secondPage(path) && limited-- > 0 ? [429, {}] : world(path)) });

  env.send({ type: 'scan' });
  assert.equal((await finished(env)).state, 'done');
  assert.equal(env.statuses.filter((s) => s.resumeAt).length, 2);
  assert.ok(env.clock >= 2 * 2 * 60 * 1000, 'waited 2 minutes each time');

  env = await load({ route: (path) => (secondPage(path) ? [429, {}] : world(path)) });
  env.send({ type: 'scan' });
  const status = await finished(env);

  assert.equal(status.state, 'error');
  assert.match(status.message, /^Instagram is rate-limiting your account/);
  assert.equal(env.calls.filter((c) => secondPage(c.path)).length, 4); // the try plus 3 retries
  assert.ok(env.writes.every((written) => !RESULT_KEYS.some((key) => key in written)), 'nothing saved');
});

test('a job still alive in another tab blocks a new one until its status goes quiet', async () => {
  const now = Date.now();
  const other = { state: 'unfollowing', job: 'unfollow', phase: null, done: 3, total: 9, message: 'Unfollowing @x…', resumeAt: null, at: now };
  const env = await load({ stored: { status: other } });
  assert.equal(env.writes.length, 0, "loading leaves the other tab's status alone");
  assert.deepEqual([env.send({ type: 'scan' }).ok, env.send({ type: 'ping' }).busy], [false, true]);

  env.clock += 2 * 60 * 1000; // two quiet minutes: that tab died with its job
  assert.equal(env.send({ type: 'scan' }).ok, true);
  await finished(env);

  // A long rest announces resumeAt, so it stays alive while quiet; a write from another tab counts too.
  const resting = await load({ stored: { status: { ...other, at: now - 4 * 60 * 1000, resumeAt: now + 60 * 1000 } } });
  assert.equal(resting.send({ type: 'unfollow', ids: ['1'] }).ok, false);
  const fresh = await load();
  await fresh.set({ status: other });
  assert.equal(fresh.send({ type: 'scan' }).ok, false);
});

test('ping reports the profile username and busy; a second job is refused while one runs', async () => {
  const env = await load({ route: () => new Promise(() => {}) }); // requests never answer, so the job stays running
  const ping = () => env.send({ type: 'ping' });

  assert.deepEqual(ping(), { ok: true, username: 'me', busy: false });
  for (const pathname of ['/', '/explore/', '/direct/inbox/', '/"]x[href="/']) {
    env.location.pathname = pathname;
    assert.equal(ping().username, null, pathname);
  }

  env.location.pathname = '/me/';
  assert.deepEqual(env.send({ type: 'scan' }), { ok: true });
  assert.equal(ping().busy, true);
  for (const msg of [{ type: 'scan' }, { type: 'unfollow', ids: ['1'] }]) {
    const reply = env.send(msg);
    assert.deepEqual([reply.ok, typeof reply.error], [false, 'string']);
  }
  assert.equal(env.send({ type: 'something else' }), undefined);
});
