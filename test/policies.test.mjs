import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { avirx, endpoint, AvirxError } from 'avirx';
import { assertCandidate } from '../scripts/provenance.mjs';

assertCandidate();

// This suite deliberately consumes only the installed public entrypoint.
const options = { timeout: 10_000 };
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t, handler) {
  const sockets = new Set();
  const timers = new Set();
  const records = [];
  const schedule = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  const server = createServer((req, res) => {
    records.push({ url: req.url, method: req.method, headers: { ...req.headers } });
    res.on('error', () => {});
    Promise.resolve(handler(req, res, { records, schedule })).catch(e => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(e));
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { base: `http://127.0.0.1:${server.address().port}`, records };
}
function json(res, data, headers = {}, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
async function eventually(check) {
  const deadline = performance.now() + 2000;
  while (!check()) {
    if (performance.now() >= deadline) assert.fail('condition did not become true within 2 seconds');
    await delay(2);
  }
}
function assertAborted(result, reason, pathname, status) {
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'aborted');
  assert.equal(result.error.cause, reason);
  assert.equal(result.error.request.url.pathname, pathname);
  assert.equal(result.error.status, status);
}

const conditionalHeaders = ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'];
for (const header of conditionalHeaders) {
  for (const value of ['', header === 'Range' ? 'bytes=0-2' : 'fixture-value']) {
    for (const order of ['warm-first', 'conditional-first']) {
      test(`cache preserves ${header}=${JSON.stringify(value)} (${order})`, options, async t => {
        const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public' }));
        const api = avirx(f.base).cache({ ttl: '5s' });
        const plain = api.get('/conditional');
        const conditional = plain.headers({ [header]: value });
        if (order === 'warm-first') {
          assert.equal((await plain.json()).n, 1);
          assert.equal((await conditional.json()).n, 2);
          assert.equal((await plain.json()).n, 1);
        } else {
          assert.equal((await conditional.json()).n, 1);
          assert.equal((await plain.json()).n, 2);
          assert.equal((await plain.json()).n, 2);
        }
        assert.equal(f.records.length, 2);
      });
    }
  }
}

const responsePrivacyCases = [
  ['missing public', {}, 200],
  ['private', { 'cache-control': 'public, private' }, 200],
  ['no-store', { 'cache-control': 'public, no-store' }, 200],
  ['no-cache', { 'cache-control': 'public, no-cache' }, 200],
  ['set-cookie', { 'cache-control': 'public', 'set-cookie': 'fake=session; HttpOnly' }, 200],
  ['vary star', { 'cache-control': 'public', vary: '*' }, 200],
  ['unconfigured vary', { 'cache-control': 'public', vary: 'x-locale' }, 200],
  ['partial', { 'cache-control': 'public', 'content-range': 'bytes 0-4/10' }, 206],
];
for (const [name, headers, status] of responsePrivacyCases) {
  test(`cache bypasses response ${name}`, options, async t => {
    const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, headers, status));
    const api = avirx(f.base).cache({ ttl: '5s' });
    assert.equal((await api.get('/private').json()).n, 1);
    assert.equal((await api.get('/private').json()).n, 2);
    assert.equal(api.state.cache.size(), 0);
  });
}
for (const [name, configure] of [
  ['bearer', api => api.auth.bearer(() => 'FAKE_TOKEN')],
  ['API key header', api => api.auth.apiKey('x-fixture-secret', () => 'FAKE_KEY')],
  ['authorization', api => api.headers({ authorization: 'Bearer FAKE_TOKEN' })],
  ['cookie', api => api.headers({ cookie: 'fixture=private' })],
  ['request no-cache', api => api.headers({ 'cache-control': 'no-cache' })],
  ['request no-store', api => api.headers({ 'cache-control': 'no-store' })],
]) {
  test(`cache bypasses request ${name}`, options, async t => {
    const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public' }));
    const api = configure(avirx(f.base).cache({ ttl: '5s' }));
    assert.equal((await api.get('/private').json()).n, 1);
    assert.equal((await api.get('/private').json()).n, 2);
    assert.equal(api.state.cache.size(), 0);
  });
}

test('cache keys distinguish missing/empty vary, replay bodies, and avoid hooks/admission on hits', options, async t => {
  let hooks = 0;
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public', vary: 'accept-language' }));
  const api = avirx(f.base).cache({ ttl: '5s', vary: ['accept-language'] }).concurrency(1).rateLimit({ requests: 1, per: '5s', queue: 0 }).on('request', () => { hooks++; });
  const missing = api.get('/reference');
  assert.equal((await missing.json()).n, 1);
  assert.equal((await missing.json()).n, 1);
  const cached = await missing.send();
  assert.equal(cached.timing.durationMs, 0);
  assert.equal((await cached.native.json()).n, 1);
  assert.equal(hooks, 1);
  assert.equal(f.records.length, 1);
  // Install a fresh rate policy while deliberately retaining the shared cache.
  const empty = api.rateLimit({ requests: 10, per: '1s' }).get('/reference').headers({ 'accept-language': '' });
  assert.equal((await empty.json()).n, 2);
  assert.equal((await empty.json()).n, 2);
  assert.equal(api.state.cache.size(), 2);
  assert.equal((await missing.json()).n, 1);
});

test('send leaves network bodies caller-owned and does not populate cache', options, async t => {
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public' }));
  const api = avirx(f.base).cache({ ttl: '5s' });
  for (let i = 0; i < 2; i++) {
    const response = await api.get('/raw').send();
    await response.native.body.cancel();
  }
  assert.equal(f.records.length, 2);
  assert.equal(api.state.cache.size(), 0);
  await api.get('/raw').json();
  assert.equal((await (await api.get('/raw').send()).native.json()).n, 3);
});

test('cache bounds entries/bytes, applies LRU, and rejects over-limit bodies', options, async t => {
  const f = await fixture(t, (req, res) => json(res, { key: req.url }, { 'cache-control': 'public' }));
  const api = avirx(f.base).cache({ ttl: '5s', maxEntries: 2, maxTotalBytes: 100, maxBytes: 50 });
  for (const key of ['/a', '/b', '/a', '/c', '/a', '/b']) await api.get(key).json();
  assert.equal(f.records.length, 4);
  assert.equal(api.state.cache.size(), 2);
  const tiny = avirx(f.base).cache({ ttl: '5s', maxEntries: 2, maxTotalBytes: 3 });
  await tiny.get('/large').json();
  await tiny.get('/large').json();
  assert.equal(tiny.state.cache.size(), 0);
  assert.equal(f.records.length, 6);
});

test('maxBytes requires valid Content-Length; HEAD cache preserves undefined JSON', options, async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/chunked') { res.writeHead(200, { 'cache-control': 'public' }); res.write('hello'); res.end(); }
    else { res.writeHead(200, { 'cache-control': 'public', 'content-length': '0' }); res.end(); }
  });
  const api = avirx(f.base).cache({ ttl: '5s', maxBytes: 100, methods: ['GET', 'HEAD'] });
  await api.get('/chunked').text(); await api.get('/chunked').text();
  assert.equal(f.records.length, 2);
  assert.equal(await api.head('/head').json(), undefined);
  assert.equal(await api.head('/head').json(), undefined);
  assert.equal(f.records.length, 3);
});

for (const phase of ['request hook', 'network', 'response parser', 'contract input']) {
  test(`cache clear blocks older execution during ${phase}`, options, async t => {
    const entered = deferred(); const release = deferred(); let gate = true;
    const f = await fixture(t, async (req, res, { records }) => {
      if (phase === 'network' && gate) { entered.resolve(); await release.promise; }
      json(res, { n: records.length }, { 'cache-control': 'public' });
    });
    let api = avirx(f.base).cache({ ttl: '5s' });
    if (phase === 'request hook') api = api.on('request', async () => { if (gate) { entered.resolve(); await release.promise; } });
    const parser = { async parse(value) { if (gate && phase === 'response parser') { entered.resolve(); await release.promise; } return value; } };
    let execute;
    if (phase === 'contract input') {
      const contract = api.contract({ value: endpoint.get('/value').query({ async parse(value) { if (gate) { entered.resolve(); await release.promise; } return value; } }) });
      execute = () => contract.value({ query: { fixture: 'yes' } });
    } else execute = () => api.get('/value').as(parser);
    const pending = execute();
    await entered.promise;
    api.state.cache.clear(); gate = false; release.resolve();
    assert.equal((await pending).n, 1);
    assert.equal(api.state.cache.size(), 0);
    assert.equal((await execute()).n, 2);
    assert.equal((await execute()).n, 2);
    assert.equal(f.records.length, 2);
  });
}

test('validation failures never poison a public cache', options, async t => {
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public' }));
  const api = avirx(f.base).cache({ ttl: '5s' });
  const failure = new Error('fixture schema failure');
  const result = await api.get('/validate').result({ async parse() { throw failure; } });
  assert.equal(result.ok, false); assert.equal(result.error.kind, 'validation'); assert.equal(result.error.cause, failure);
  assert.equal(api.state.cache.size(), 0);
  assert.equal((await api.get('/validate').json()).n, 2);
});

test('cache TTL and rate windows survive a host wall-clock jump', options, async t => {
  const originalNow = Date.now;
  t.after(() => { Date.now = originalNow; });
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, { 'cache-control': 'public' }));
  const api = avirx(f.base).cache({ ttl: 500 }).rateLimit({ requests: 1, per: 500, queue: 0 });
  assert.equal((await api.get('/clock').json()).n, 1);
  Date.now = () => originalNow() + 86_400_000;
  assert.equal((await api.get('/clock').json()).n, 1);
  const blocked = await api.get('/other').result();
  assert.equal(blocked.ok, false); assert.equal(blocked.error.kind, 'queue-full');
  Date.now = () => originalNow() - 86_400_000;
  await delay(550);
  assert.equal((await api.get('/clock').json()).n, 2);
});

test('concurrency FIFO removes aborted waiters and frees capacity at headers', options, async t => {
  const held = deferred(); const entered = deferred();
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/first') { entered.resolve(); await held.promise; }
    json(res, { path: req.url });
  });
  const api = avirx(f.base).concurrency(1);
  const first = api.get('/first').json(); await entered.promise;
  const controller = new AbortController();
  const reason = new AvirxError('sibling queue reason', { request: await api.get('/sibling').build(), status: 409, kind: 'http' });
  const cancelled = api.get('/cancelled').signal(controller.signal).result();
  const second = api.get('/second').json(); const third = api.get('/third').json();
  await eventually(() => api.state.concurrency.queued() === 3);
  controller.abort(reason);
  assertAborted(await cancelled, reason, '/cancelled', undefined);
  held.resolve();
  await Promise.all([first, second, third]);
  assert.deepEqual(f.records.map(r => r.url), ['/first', '/second', '/third']);
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0);
});

test('slow body does not occupy concurrency or extend fetch timeout', options, async t => {
  const started = deferred(); const finish = deferred();
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first-'); started.resolve();
      await finish.promise; res.end('last');
    } else json(res, { ok: true });
  });
  const api = avirx(f.base).concurrency(1).timeout(80);
  const pending = api.get('/body').text(); await started.promise;
  assert.deepEqual(await api.get('/other').json(), { ok: true });
  await delay(110); finish.resolve();
  assert.equal(await pending, 'first-last');
  assert.equal(api.state.concurrency.active(), 0);
});

test('rate FIFO, queue bounds, queue timeout and cancellation release concurrency', options, async t => {
  const f = await fixture(t, (req, res) => json(res, { path: req.url }));
  const api = avirx(f.base).concurrency(5).rateLimit({ requests: 1, per: 100, queue: 2, queueTimeout: 500 });
  await api.get('/first').json();
  const controller = new AbortController();
  const reason = new AvirxError('sibling rate reason', { request: await api.get('/sibling').build(), status: 409, kind: 'http' });
  const cancelled = api.get('/cancelled').signal(controller.signal).result();
  const second = api.get('/second').json();
  await eventually(() => api.state.rateLimit.queued() === 2);
  const overflow = await api.get('/overflow').result();
  assert.equal(overflow.error.kind, 'queue-full');
  controller.abort(reason); assertAborted(await cancelled, reason, '/cancelled', undefined);
  const third = api.get('/third').json(); await Promise.all([second, third]);
  assert.deepEqual(f.records.map(r => r.url), ['/first', '/second', '/third']);
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.rateLimit.queued(), 0);
  const limited = api.rateLimit({ requests: 1, per: '5s', queue: 1, queueTimeout: 15 });
  await limited.get('/start').json();
  const timeout = await limited.get('/queue-timeout').result();
  assert.equal(timeout.error.kind, 'queue-timeout'); assert.equal(limited.state.concurrency.active(), 0);
});

test('hooks complete before policy admission', options, async t => {
  const hold = deferred(); const inHook = deferred();
  const f = await fixture(t, (req, res) => json(res, { ok: true }));
  let blocked = true;
  const api = avirx(f.base).concurrency(1).rateLimit({ requests: 1, per: 80, queue: 2 }).on('request', async () => {
    if (blocked) { inHook.resolve(); await hold.promise; }
  });
  const pending = api.get('/one').json(); await inHook.promise;
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.rateLimit.starts(), 0);
  blocked = false; await api.get('/two').json(); hold.resolve(); await pending;
  assert.deepEqual(f.records.map(r => r.url), ['/two', '/one']);
});

for (const phase of ['pre-aborted', 'auth preflight', 'request hook', 'fetch', 'body', 'retry delay']) {
  test(`abort owns current identity during ${phase}`, options, async t => {
    const entered = deferred(); const release = deferred();
    const f = await fixture(t, async (req, res) => {
      if (req.url === '/sibling') { json(res, { error: 'sibling' }, {}, 409); return; }
      if (phase === 'fetch') { entered.resolve(); await release.promise; json(res, { ok: true }); }
      else if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":');
        await release.promise; res.end('true}');
      } else if (phase === 'retry delay') { json(res, {}, { 'retry-after': '1' }, 503); }
      else json(res, { ok: true });
    });
    const sibling = await avirx(f.base).get('/sibling').result();
    const reason = sibling.error; assert.equal(reason.kind, 'http');
    const controller = new AbortController(); let api = avirx(f.base);
    if (phase === 'auth preflight') api = api.auth.bearer(async () => { entered.resolve(); await release.promise; return 'FAKE'; });
    if (phase === 'request hook') api = api.on('request', async () => { entered.resolve(); await release.promise; });
    if (phase === 'body') api = api.on('response', () => entered.resolve());
    if (phase === 'retry delay') api = api.retry(2).on('retry', () => entered.resolve());
    if (phase === 'pre-aborted') controller.abort(reason);
    const pending = api.get('/current').signal(controller.signal).result();
    if (phase !== 'pre-aborted') {
      await entered.promise;
      // Header delivery must have reached the consumer; a server write alone is insufficient.
      if (phase === 'body') await delay(10);
      controller.abort(reason); release.resolve();
    }
    assertAborted(await pending, reason, '/current', phase === 'body' ? 200 : undefined);
  });
}

test('fetch timeout is normalized; disabling inherited timeout permits delayed headers', options, async t => {
  const f = await fixture(t, (req, res, { schedule }) => schedule(() => json(res, { ok: true }), 70));
  const api = avirx(f.base).timeout(15);
  const result = await api.get('/timeout').result();
  assert.equal(result.ok, false); assert.equal(result.error.kind, 'timeout');
  assert.deepEqual(await api.get('/disabled').timeout(false).json(), { ok: true });
});

for (const terminal of ['send', 'json', 'text', 'download', 'as', 'result']) {
  for (const callback of ['auth', 'request', 'response', 'error', 'retry']) {
    test(`${terminal} preserves original ${callback} callback rejection`, options, async t => {
      const sentinel = { fixture: `${terminal}/${callback}` }; let errors = 0;
      const f = await fixture(t, (req, res) => json(res, { ok: true }, {}, callback === 'retry' ? 503 : callback === 'error' ? 400 : 200));
      let api = avirx(f.base).on('error', () => { errors++; });
      if (callback === 'auth') api = api.auth.bearer(async () => { throw sentinel; });
      else api = api.on(callback, async () => { throw sentinel; });
      if (callback === 'retry') api = api.retry(1);
      const request = api.get('/callback');
      await assert.rejects(() => terminal === 'as' ? request.as({ parse: v => v }) : request[terminal](), value => value === sentinel);
      assert.equal(errors, callback === 'error' ? 1 : 0);
    });
  }
}

test('operation errors have stable kinds; custom transport failures normalize and callbacks retain ownership', options, async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/decode') { res.writeHead(200); res.end('{'); }
    else json(res, { error: true }, {}, 400);
  });
  let events = 0;
  const api = avirx(f.base).on('error', () => { events++; });
  assert.equal((await api.get('/decode').result()).error.kind, 'decode');
  const parserFailure = new Error('fixture parser');
  const http = await api.get('/http').error({ async parse() { throw parserFailure; } }).result();
  assert.equal(http.error.kind, 'http'); assert.equal(http.error.cause, parserFailure);
  assert.equal(events, 2);
  const networkFailure = new Error('custom fixture transport');
  const custom = avirx(f.base, { fetch: async () => { throw networkFailure; } });
  const network = await custom.get('/custom').result();
  assert.equal(network.error.kind, 'network'); assert.equal(network.error.cause, networkFailure);
  assert.equal(network.error.request.url.pathname, '/custom');
});

test('custom fetch receives redirect and composed signal and must honor them', options, async () => {
  const controller = new AbortController(); const clientController = new AbortController();
  const reason = new Error('custom cancellation'); const called = deferred();
  const api = avirx('http://fixture.invalid', { fetch: async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal); called.resolve();
    return await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } }).signal(clientController.signal).auth.apiKey('x-fixture-secret', () => 'FAKE');
  const pending = api.get('/custom').signal(controller.signal).result();
  await called.promise; controller.abort(reason);
  assertAborted(await pending, reason, '/custom', undefined);
});

test('shared policy handles support explicit ownership and derivation', options, async t => {
  const f = await fixture(t, (req, res) => json(res, { ok: true }));
  const api = avirx(f.base).cache({ ttl: '5s' }).concurrency(1).rateLimit({ requests: 5, per: '1s' });
  const child = api.headers({ 'x-fixture': 'child' });
  assert.equal(child.state.cache, api.state.cache);
  assert.equal(child.state.concurrency, api.state.concurrency);
  assert.equal(child.state.rateLimit, api.state.rateLimit);
  assert.notEqual(api.cache({ ttl: '1s' }).state.cache, api.state.cache);
  const release = await api.state.concurrency.acquire();
  assert.equal(api.state.concurrency.active(), 1);
  const pending = child.get('/queued').json();
  await eventually(() => api.state.concurrency.queued() === 1);
  release(); await pending;
  assert.equal(api.state.concurrency.active(), 0);
});

// Bounded xorshift32 interactions; names preserve the actual unsigned seed and exact fixture.
const seedInput = process.env.QUALIFICATION_SEED;
if (seedInput !== undefined && (!/^[0-9]+$/.test(seedInput) || Number(seedInput) > 0xffffffff)) {
  throw new TypeError('QUALIFICATION_SEED must be a decimal unsigned 32-bit integer (0..4294967295).');
}
const seed = seedInput === undefined ? 0x5a17c0de : Number(seedInput);
let randomState = seed;
function random() { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; }
for (let index = 0; index < 24; index++) {
  const vary = (random() & 1) !== 0;
  const authenticated = (random() & 3) === 0;
  const requestPrivate = (random() & 3) === 0;
  const serverPrivate = (random() & 3) === 0;
  test(`seed=${seed} cache interaction #${index} ${JSON.stringify({ vary, authenticated, requestPrivate, serverPrivate })}`, options, async t => {
    const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, {
      'cache-control': serverPrivate ? 'public, private' : 'public', ...(vary ? { vary: 'accept-language' } : {}),
    }));
    let api = avirx(f.base).cache({ ttl: '5s', vary: ['accept-language'] }).concurrency(1).retry(1);
    if (authenticated) api = api.auth.bearer(() => 'FAKE');
    if (requestPrivate) api = api.headers({ 'cache-control': 'no-cache' });
    const request = api.get('/seeded').headers({ 'accept-language': 'en' });
    assert.equal((await request.json()).n, 1);
    assert.equal((await request.json()).n, authenticated || requestPrivate || serverPrivate ? 2 : 1);
    assert.equal(api.state.concurrency.active(), 0);
  });
}

test('explicit cache set after clear is a new write; clear during body copy blocks that write', options, async t => {
  const started = deferred(); const finish = deferred();
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/copy') {
      res.writeHead(200, { 'cache-control': 'public', 'content-type': 'text/plain' });
      res.write('one-'); started.resolve(); await finish.promise; res.end('two');
    } else json(res, { fixture: 'explicit' }, { 'cache-control': 'public' });
  });
  const api = avirx(f.base).cache({ ttl: '5s' });
  const request = await api.get('/explicit').build();
  const response = await avirx(f.base).get('/explicit').send();
  api.state.cache.clear();
  assert.equal(api.state.cache.canCacheRequest(request), true);
  assert.equal(api.state.cache.canCacheResponse(response), true);
  await api.state.cache.set(request, response);
  const cached = api.state.cache.get(request);
  assert.equal((await cached.native.json()).fixture, 'explicit');
  assert.equal((await api.get('/explicit').json()).fixture, 'explicit');
  assert.equal(f.records.length, 1);
  await response.native.body.cancel();
  const copyingRequest = await api.get('/copy').build();
  const copyingResponse = await avirx(f.base).get('/copy').send();
  await started.promise;
  const copying = api.state.cache.set(copyingRequest, copyingResponse);
  api.state.cache.clear(); finish.resolve(); await copying;
  assert.equal(api.state.cache.size(), 0);
  await copyingResponse.native.body.cancel();
});

test('retry response hooks can invalidate cache without cancelling caller result', options, async t => {
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, {
    'cache-control': 'public', 'retry-after': '0',
  }, records.length === 1 ? 503 : 200));
  const api = avirx(f.base).cache({ ttl: '5s' }).retry(1);
  const request = api.get('/retry-clear').on('retry', () => api.state.cache.clear());
  assert.equal((await request.json()).n, 2);
  assert.equal(api.state.cache.size(), 0);
  assert.equal((await api.get('/retry-clear').json()).n, 3);
  assert.equal((await api.get('/retry-clear').json()).n, 3);
});

test('custom constructed errors default to unknown; throwing one from a hook preserves it', options, async () => {
  const request = await avirx('http://fixture.invalid').get('/constructed').build();
  const reason = new AvirxError('caller-owned', { request });
  assert.equal(reason.kind, 'unknown');
  await assert.rejects(() => avirx('http://fixture.invalid').on('request', () => { throw reason; }).get('/constructed').result(), e => e === reason);
});

test('aggregate byte budget evicts entries and default budgets are finite', options, async t => {
  const f = await fixture(t, (req, res) => {
    const data = '123456';
    res.writeHead(200, { 'cache-control': 'public', 'content-length': data.length }); res.end(data);
  });
  const defaults = avirx(f.base).cache({ ttl: '5s' }).state.cache;
  assert.equal(defaults.maxEntries, 128); assert.equal(defaults.maxTotalBytes, 16 * 1024 * 1024);
  const api = avirx(f.base).cache({ ttl: '5s', maxEntries: 10, maxTotalBytes: 10 });
  await api.get('/a').text(); await api.get('/b').text();
  assert.equal(api.state.cache.size(), 1);
  await api.get('/b').text(); assert.equal(f.records.length, 2);
  await api.get('/a').text(); assert.equal(f.records.length, 3);
  assert.equal(api.state.cache.size(), 1);
});

test('queued concurrency work cannot reserve a rate start before the occupant releases', options, async t => {
  const occupantEntered = deferred(); const releaseOccupant = deferred();
  const secondEntered = deferred();
  const f = await fixture(t, async (req, res) => {
    if (req.url === '/occupant') { occupantEntered.resolve(); await releaseOccupant.promise; }
    if (req.url === '/second') secondEntered.resolve();
    json(res, { path: req.url });
  });
  const api = avirx(f.base).concurrency(1).rateLimit({ requests: 1, per: 1000, queue: 2 });
  const occupant = api.get('/occupant').json(); await occupantEntered.promise;
  const second = api.get('/second').json(); const third = api.get('/third').json();
  await eventually(() => api.state.concurrency.queued() === 2);
  // Let only the real dispatch's window expire while its response headers stay held.
  await delay(1100);
  assert.equal(api.state.rateLimit.starts(), 0);
  assert.equal(api.state.rateLimit.queued(), 0);
  assert.deepEqual(f.records.map(r => r.url), ['/occupant']);
  releaseOccupant.resolve(); await secondEntered.promise;
  await eventually(() => api.state.rateLimit.queued() === 1);
  assert.equal(api.state.rateLimit.starts(), 1);
  assert.equal(api.state.concurrency.active(), 1);
  assert.deepEqual(f.records.map(r => r.url), ['/occupant', '/second']);
  await Promise.all([occupant, second, third]);
  assert.deepEqual(f.records.map(r => r.url), ['/occupant', '/second', '/third']);
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.rateLimit.queued(), 0);
});

test('retry cancels a never-ending discarded HTTP body and restores concurrency capacity', options, async t => {
  let discardedClosed = false; let discardedEnded;
  const f = await fixture(t, (req, res, { records }) => {
    if (req.url === '/retry-stream' && records.length === 1) {
      res.on('close', () => { discardedClosed = true; discardedEnded = res.writableEnded; });
      res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '0' });
      res.write('fixture response intentionally never ends');
      return;
    }
    json(res, { path: req.url });
  });
  const api = avirx(f.base).concurrency(1).retry(1);
  assert.deepEqual(await api.get('/retry-stream').json(), { path: '/retry-stream' });
  await eventually(() => discardedClosed);
  assert.equal(discardedEnded, false, 'server did not end the discarded body; client cancellation closed it');
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0);
  assert.deepEqual(await api.get('/after-retry').json(), { path: '/after-retry' });
  assert.equal(f.records.length, 3);
});

test('response-hook rejection cancels its never-ending HTTP body and restores concurrency capacity', options, async t => {
  let rejectedClosed = false; let rejectedEnded;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/hook-stream') {
      res.on('close', () => { rejectedClosed = true; rejectedEnded = res.writableEnded; });
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('fixture response intentionally never ends');
      return;
    }
    json(res, { path: req.url });
  });
  const sentinel = new Error('consumer response hook failure');
  const api = avirx(f.base).concurrency(1).on('response', ({ request }) => {
    if (request().url.pathname === '/hook-stream') throw sentinel;
  });
  await assert.rejects(() => api.get('/hook-stream').send(), error => error === sentinel);
  await eventually(() => rejectedClosed);
  assert.equal(rejectedEnded, false, 'server did not end the rejected body; client cancellation closed it');
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0);
  assert.deepEqual(await api.get('/after-hook').json(), { path: '/after-hook' });
  assert.equal(f.records.length, 2);
});
