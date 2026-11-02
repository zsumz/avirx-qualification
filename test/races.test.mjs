import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { avirx, endpoint } from 'avirx';
import { assertCandidate } from '../scripts/provenance.mjs';

assertCandidate();
const options = { timeout: 10_000 };
const seedInput = process.env.QUALIFICATION_SEED;
if (seedInput !== undefined && (!/^[0-9]+$/.test(seedInput) || Number(seedInput) > 0xffffffff)) throw new TypeError('QUALIFICATION_SEED must be a decimal unsigned 32-bit integer.');
const seed = seedInput === undefined ? 0x72ace091 : Number(seedInput);
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function wait(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Handshake timed out: ${label}`)), 4000); })]); }
  finally { clearTimeout(timer); }
}
async function until(predicate, label) {
  const deadline = performance.now() + 4000;
  while (!predicate()) {
    if (performance.now() > deadline) assert.fail(`Condition timed out: ${label}`);
    await delay(5);
  }
}
async function fixture(t, handler) {
  const sockets = new Set(); const records = []; const releases = [];
  const server = createServer((req, res) => {
    records.push({ url: req.url, method: req.method, headers: { ...req.headers } });
    res.on('error', () => {});
    Promise.resolve(handler(req, res, { records })).catch(error => {
      if (!res.headersSent) res.writeHead(500); res.end(String(error));
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const release of releases) release(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, records, cleanup: release => releases.push(release) };
}
function json(res, value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers }); res.end(body);
}
async function sibling(base) {
  const outcome = await avirx(base).get('/sibling').result();
  assert.equal(outcome.ok, false); assert.equal(outcome.error.kind, 'http'); assert.equal(outcome.error.status, 409);
  await outcome.response.native.body?.cancel();
  return outcome.error;
}
function aborted(outcome, reason, path, bodyStatus = undefined) {
  assert.equal(outcome.ok, false); assert.notEqual(outcome.error, reason);
  assert.equal(outcome.error.kind, 'aborted'); assert.equal(outcome.error.cause, reason);
  assert.equal(outcome.error.request.url.pathname, path);
  assert.equal(outcome.error.status, bodyStatus); assert.notEqual(outcome.error.status, 409);
}

for (const phase of ['pre-aborted', 'auth', 'contract input', 'request hook', 'native fetch', 'concurrency', 'rate', 'retry', 'buffered body']) {
  test(`RACE-ABORT-${phase}: sibling errors remain causes of the current operation`, options, async t => {
    const entered = gate(); const release = gate(); let headersObserved = false;
    const f = await fixture(t, async (req, res) => {
      if (req.url === '/sibling') return json(res, { sibling: true }, 409);
      if (req.url === '/barrier' || req.url === '/prime') return json(res, { barrier: true });
      if (phase === 'native fetch') { entered.resolve(); await release.promise; }
      if (phase === 'buffered body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"value":'); await release.promise; res.end('true}'); return; }
      if (phase === 'retry') return json(res, {}, 503, { 'retry-after': '30' });
      json(res, { value: true });
    });
    f.cleanup(() => release.resolve());
    const reason = await sibling(f.base); const controller = new AbortController();
    let api = avirx(f.base).signal(controller.signal); let unlock;
    if (phase === 'auth') api = api.auth.bearer(async () => { entered.resolve(); await release.promise; return 'FAKE'; });
    if (phase === 'request hook') api = api.on('request', async () => { entered.resolve(); await release.promise; });
    if (phase === 'buffered body') api = api.on('response', () => { headersObserved = true; entered.resolve(); });
    if (phase === 'concurrency') { api = api.concurrency(1); unlock = await api.state.concurrency.acquire(); }
    if (phase === 'rate') { api = api.rateLimit({ requests: 1, per: '30s', queue: 4 }); await api.get('/prime').json(); }
    if (phase === 'retry') api = api.retry(1).on('retry', () => entered.resolve());
    if (phase === 'pre-aborted') controller.abort(reason);
    let pending;
    if (phase === 'contract input') {
      const contract = api.contract({ value: endpoint.get('/victim').query({ async parse(value) { entered.resolve(); await release.promise; return value; } }) });
      pending = contract.value.result({ query: { fixture: 'yes' } });
    } else pending = api.get('/victim').result();
    if (phase === 'concurrency') await until(() => api.state.concurrency.queued() === 1, 'concurrency waiter present');
    else if (phase === 'rate') await until(() => api.state.rateLimit.queued() === 1, 'rate waiter present');
    else if (phase !== 'pre-aborted') await wait(entered.promise, `${phase} entered`);
    if (phase === 'buffered body') {
      assert.equal(headersObserved, true);
      // A separate completed network round trip lets the buffered terminal begin its body read.
      // The victim response stays incomplete until after the abort.
      await avirx(f.base).get('/barrier').json();
    }
    if (phase !== 'pre-aborted') controller.abort(reason);
    release.resolve(); unlock?.();
    aborted(await wait(pending, `${phase} abort result`), reason, '/victim', phase === 'buffered body' ? 200 : undefined);
    if (api.state.concurrency) { assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0); }
    if (api.state.rateLimit) assert.equal(api.state.rateLimit.queued(), 0);
  });
}

test('RACE-ABORT-native-body: reader cancellation retains native ownership and request metadata', options, async t => {
  let closed = false;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/sibling') return json(res, {}, 409);
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'text/plain' }); res.write('first');
  });
  const reason = await sibling(f.base); const controller = new AbortController();
  const response = await avirx(f.base).concurrency(1).get('/native-body').signal(controller.signal).send();
  const reader = response.native.body.getReader();
  assert.equal(new TextDecoder().decode((await wait(reader.read(), 'first native chunk')).value), 'first');
  const reading = reader.read(); controller.abort(reason);
  await assert.rejects(() => wait(reading, 'native reader rejects'), error => error === reason);
  reader.releaseLock();
  assert.equal(response.request.url.pathname, '/native-body'); assert.equal(response.status, 200);
  await until(() => closed, 'native body close visible at server');
});

const terminals = ['send', 'json', 'text', 'download', 'as', 'result'];
for (const callback of ['auth', 'request', 'response', 'retry', 'error']) {
  for (const terminal of terminals) {
    for (const abortInCallback of [false, true]) {
      test(`RACE-CALLBACK-${callback}-${terminal}-aborted=${abortInCallback}: sibling rejection keeps callback identity`, options, async t => {
        const f = await fixture(t, (req, res) => json(res, {}, req.url === '/sibling' ? 409 : callback === 'retry' ? 503 : callback === 'error' ? 400 : 200));
        const reason = await sibling(f.base); const controller = new AbortController(); let errorHooks = 0;
        const fail = () => { if (abortInCallback) controller.abort(reason); throw reason; };
        let api = avirx(f.base).signal(controller.signal).on('error', () => { errorHooks++; });
        const handler = terminals.indexOf(terminal) % 2 === 0 ? fail : async () => fail();
        if (callback === 'auth') api = api.auth.bearer(handler);
        else api = api.on(callback, handler);
        if (callback === 'retry') api = api.retry(1);
        const request = api.get('/callback-victim');
        await assert.rejects(() => terminal === 'as' ? request.as({ parse: value => value }) : request[terminal](), value => value === reason);
        assert.equal(errorHooks, callback === 'error' ? 1 : 0, 'callback failure must not recursively trigger operation error hooks');
        assert.equal(reason.request.url.pathname, '/sibling'); assert.equal(reason.status, 409);
      });
    }
  }
}

for (const mode of ['call', 'result']) {
  test(`RACE-CONTRACT-callback-${mode}: aborted input parser still rejects its own sibling error`, options, async t => {
    const f = await fixture(t, (req, res) => json(res, {}, req.url === '/sibling' ? 409 : 200));
    const reason = await sibling(f.base); const controller = new AbortController(); let errorHooks = 0;
    const contract = avirx(f.base).signal(controller.signal).on('error', () => { errorHooks++; }).contract({
      value: endpoint.get('/contract-victim').query({ async parse() { controller.abort(reason); throw reason; } }),
    });
    await assert.rejects(() => mode === 'call' ? contract.value({ query: {} }) : contract.value.result({ query: {} }), error => error === reason);
    assert.equal(f.records.length, 1); assert.equal(errorHooks, 0);
  });
}

for (const phase of ['request hook', 'network', 'retry', 'contract input', 'output parser']) {
  test(`RACE-CLEAR-${phase}: old generation cannot refill; reusable execution captures fresh generation`, options, async t => {
    const entered = gate(); const release = gate(); let block = true; let arrivals = 0;
    const f = await fixture(t, async (req, res) => {
      arrivals++;
      if (phase === 'network' && block) { entered.resolve(); await release.promise; }
      if (phase === 'retry' && arrivals === 1) return json(res, {}, 503, { 'retry-after': '0' });
      json(res, { version: arrivals }, 200, { 'cache-control': 'public' });
    });
    f.cleanup(() => release.resolve());
    let api = avirx(f.base).cache({ ttl: '30s' });
    if (phase === 'request hook') api = api.on('request', async () => { if (block) { entered.resolve(); await release.promise; } });
    if (phase === 'retry') api = api.retry(1).on('retry', async () => { entered.resolve(); await release.promise; });
    const output = { async parse(value) { if (phase === 'output parser' && block) { entered.resolve(); await release.promise; } return value; } };
    let execute;
    if (phase === 'contract input') {
      const contract = api.contract({ value: endpoint.get('/generation').query({ async parse(value) { if (block) { entered.resolve(); await release.promise; } return value; } }).returns(output) });
      execute = () => contract.value({ query: { fixture: 'yes' } });
    } else {
      const reusable = api.get('/generation'); execute = () => reusable.as(output);
    }
    const pending = execute(); await wait(entered.promise, `${phase} entered`);
    api.state.cache.clear(); block = false; release.resolve();
    const old = await wait(pending, `${phase} finishes`); assert.equal(old.version, phase === 'retry' ? 2 : 1);
    assert.equal(api.state.cache.size(), 0);
    const fresh = await execute(); assert.equal(fresh.version, phase === 'retry' ? 3 : 2);
    assert.deepEqual(await execute(), fresh); assert.equal(arrivals, phase === 'retry' ? 3 : 2);
  });
}

test('RACE-CLEAR-auth: clearing during auth preserves result and privacy; unauthenticated derived client can refill', options, async t => {
  const entered = gate(); const release = gate();
  const f = await fixture(t, (req, res, { records }) => json(res, { n: records.length }, 200, { 'cache-control': 'public' }));
  f.cleanup(() => release.resolve());
  const base = avirx(f.base).cache({ ttl: '30s' });
  const authenticated = base.auth.bearer(async () => { entered.resolve(); await release.promise; return 'FAKE'; });
  const pending = authenticated.get('/auth').json(); await wait(entered.promise, 'auth entered');
  base.state.cache.clear(); release.resolve(); assert.equal((await pending).n, 1);
  // Authenticated operations are always ineligible: this verifies privacy and progress, not generation protection.
  assert.equal(base.state.cache.size(), 0);
  assert.equal((await base.get('/auth').json()).n, 2); assert.equal((await base.get('/auth').json()).n, 2);
});

test('RACE-CLEAR-body-copy: explicit low-level write loses to a concurrent clear; post-clear write is fresh', options, async t => {
  const finish = gate(); const started = gate(); let ended = false;
  const f = await fixture(t, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'public' }); res.write('first-'); started.resolve();
    await finish.promise; ended = true; res.end('last');
  });
  f.cleanup(() => finish.resolve());
  const api = avirx(f.base).cache({ ttl: '30s' }); const request = await api.get('/copy').build();
  const response = await avirx(f.base).get('/copy').send(); await wait(started.promise, 'copy headers');
  const copying = api.state.cache.set(request, response); assert.equal(ended, false);
  api.state.cache.clear(); finish.resolve(); await wait(copying, 'discard old copy'); assert.equal(api.state.cache.get(request), undefined);
  await api.state.cache.set(request, response);
  const first = api.state.cache.get(request); const second = api.state.cache.get(request);
  assert.equal(await first.native.text(), 'first-last'); assert.equal(await second.native.text(), 'first-last');
  assert.equal(await response.native.text(), 'first-last');
});

// If-Range alone does not activate HTTP range processing. Its fixture deliberately echoes
// field presence in a distinct 200 body to prove transmission and independent cache bypass.
const specialHeaders = [
  ['Range', 'bytes=0-1', 206, 'ab'], ['If-Match', '"mismatch"', 412, 'precondition failed'],
  ['If-None-Match', '"fixture-tag"', 304, ''], ['If-Modified-Since', 'Wed, 01 Jan 2020 00:00:00 GMT', 304, ''],
  ['If-Unmodified-Since', 'Wed, 01 Jan 2020 00:00:00 GMT', 412, 'precondition failed'], ['If-Range', '"stale-tag"', 200, 'if-range received'],
];
for (const [header, nonempty, status, expectedBody] of specialHeaders) {
  for (const value of ['', nonempty]) {
    for (const order of ['warm-first', 'special-first']) {
      test(`RACE-COND-${header}-${value === '' ? 'empty' : 'value'}-${order}: native wire semantics survive cache`, options, async t => {
        const name = header.toLowerCase();
        const f = await fixture(t, (req, res) => {
          const special = Object.hasOwn(req.headers, name); const body = special ? expectedBody : 'abcdef';
          res.writeHead(special ? status : 200, { 'cache-control': 'public', 'content-type': 'text/plain', ...(special && status === 206 ? { 'content-range': 'bytes 0-1/6' } : {}) }); res.end(body);
        });
        const api = avirx(f.base).cache({ ttl: '30s' }); const normal = api.get('/conditional');
        const special = normal.headers({ [header]: value }).expect([200, 206, 304, 412]);
        const checkNormal = async () => { const response = await normal.download(); assert.equal(response.status, 200); assert.equal(await response.blob.text(), 'abcdef'); };
        const checkSpecial = async () => { const response = await special.download(); assert.equal(response.status, status); assert.equal(await response.blob.text(), expectedBody); };
        if (order === 'warm-first') { await checkNormal(); await checkSpecial(); await checkNormal(); }
        else { await checkSpecial(); await checkNormal(); await checkNormal(); }
        assert.equal(f.records.length, 2);
        const specialWire = f.records.find(r => Object.hasOwn(r.headers, name));
        assert.ok(specialWire, 'special request reached native HTTP fixture'); assert.equal(specialWire.headers[name], value);
      });
    }
  }
}

for (const retryAfter of ['2', '120', 'date']) {
  test(`RACE-RETRY-AFTER-${retryAfter}: advertised delay is honored or clamped without sleeping it`, options, async t => {
    const f = await fixture(t, (req, res) => json(res, {}, req.url === '/sibling' ? 409 : 503, {
      ...(req.url === '/sibling' ? {} : { 'retry-after': retryAfter === 'date' ? new Date(Date.now() + 120_000).toUTCString() : retryAfter }),
    }));
    const reason = await sibling(f.base); const controller = new AbortController(); let metadata;
    const api = avirx(f.base).retry(1).on('retry', context => { metadata = context.retry(); controller.abort(reason); });
    const outcome = await api.get('/retry-after').signal(controller.signal).result();
    aborted(outcome, reason, '/retry-after');
    assert.equal(metadata.status, 503); assert.equal(metadata.delayMs, retryAfter === '2' ? 2000 : 60_000);
    assert.equal(f.records.length, 2, 'immediate hook abort prevents a retry request');
  });
}

function randomFactory(initial) { let state = initial; return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ state >>> 15, state | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return (value ^ value >>> 14) >>> 0; }; }
test(`RACE-STRESS-mixed seed=${seed}: 192 bounded operations preserve settled queues and fresh post-mutation reads`, options, async t => {
  const random = randomFactory(seed); const attempts = new Map(); let version = 0; const hookGates = new Map();
  const f = await fixture(t, async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'POST') { for await (const chunk of req) void chunk; version++; return json(res, { version }); }
    const id = req.headers['x-race-id'] ?? `shared:${url.searchParams.get('key')}`; const count = (attempts.get(id) ?? 0) + 1; attempts.set(id, count);
    if (url.searchParams.get('retry') === 'yes' && count === 1) return json(res, {}, 503, { 'retry-after': '0' });
    json(res, { key: url.searchParams.get('key'), version }, 200, { 'cache-control': 'public' });
  });
  const api = avirx(f.base).cache({ ttl: '30s', maxEntries: 12, maxTotalBytes: 4096 }).concurrency(4)
    .rateLimit({ requests: 20, per: 100, queue: 64, queueTimeout: 4000 }).retry(1)
    .on('request', async ({ request }) => { const hook = hookGates.get(request().headers['x-race-id']); if (hook) { hook.entered.resolve(); await hook.release.promise; } });
  const shared = api.get('/load').query({ key: '0' });
  assert.equal((await shared.json()).version, 0);
  const warmedCount = f.records.length; assert.equal((await shared.json()).version, 0); assert.equal(f.records.length, warmedCount);
  const specs = Array.from({ length: 192 }, (_, id) => ({ id, kind: random() % 8, key: random() % 7, retry: (random() & 3) === 0 }));
  for (let start = 0; start < specs.length; start += 12) {
    const batch = specs.slice(start, start + 12);
    try {
      await Promise.all(batch.map(async spec => {
        if (spec.kind === 5) { api.state.cache.clear(); return; }
        if (spec.kind === 6) { const mutation = await api.post('/mutation').body({ id: spec.id }).json(); assert.ok(mutation.version > 0); api.state.cache.clear(); return; }
        const controller = new AbortController(); const reason = new Error(`seed=${seed} id=${spec.id}`);
        const id = String(spec.id);
        const query = { key: String(spec.key), ...(spec.retry ? { retry: 'yes' } : {}) };
        const headers = { 'x-race-id': id, ...((spec.kind === 3 || spec.kind === 4) ? { 'cache-control': 'no-cache' } : {}) };
        if (spec.kind === 3) controller.abort(reason);
        let hook;
        if (spec.kind === 4) { hook = { entered: gate(), release: gate() }; hookGates.set(id, hook); f.cleanup(() => hook.release.resolve()); }
        const pending = api.get('/load').query(query).headers(headers).signal(controller.signal).result();
        if (hook) { await wait(hook.entered.promise, `stress hook id=${id}`); controller.abort(reason); hook.release.resolve(); }
        const outcome = await wait(pending, `stress result id=${id}`); hookGates.delete(id);
        if (spec.kind === 3 || spec.kind === 4) aborted(outcome, reason, '/load');
        else { assert.equal(outcome.ok, true); assert.equal(outcome.data.key, String(spec.key)); assert.ok(outcome.data.version >= 0 && outcome.data.version <= version); }
        if (spec.kind === 7) {
          const built = await api.get('/load').query(query).headers(headers).build(); const cached = api.state.cache.get(built);
          if (cached) { const data = await cached.native.json(); assert.equal(data.key, String(spec.key)); }
        }
      }));
      assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0); assert.equal(api.state.rateLimit.queued(), 0);
      assert.ok(api.state.cache.size() <= 12);
      // All mutations and old reads in this batch have settled. Revisit the same URL
      // warmed before load, without an intervening clear that could hide stale refill.
      assert.equal((await shared.json()).version, version);
      const beforeHit = f.records.length; assert.equal((await shared.json()).version, version);
      assert.equal(f.records.length, beforeHit, 'reusable shared URL hits fresh cache after batch barrier');
    } catch (error) { error.message += `\nReplay fixture: ${JSON.stringify({ id: 'RACE-STRESS-mixed', seed, batch })}`; throw error; }
  }
  api.state.cache.clear();
  const expected = version; const fresh = api.get('/load').query({ id: 'final', key: 'final' });
  assert.equal((await fresh.json()).version, expected); const before = f.records.length;
  assert.equal((await fresh.json()).version, expected); assert.equal(f.records.length, before);
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.rateLimit.queued(), 0);
  assert.ok(f.records.length <= 384, 'bounded retries and mutations keep transport work finite');
});

test('RACE-HANDLES-admission: callers release each acquired slot once; aborted waiters leave future capacity usable', options, async t => {
  const f = await fixture(t, (req, res) => json(res, { ok: true })); const api = avirx(f.base).concurrency(2).rateLimit({ requests: 10, per: '30s' });
  const releaseA = await api.state.concurrency.acquire(); const releaseB = await api.state.concurrency.acquire();
  assert.equal(api.state.concurrency.active(), 2);
  const controller = new AbortController(); const reason = new Error('advanced acquire waiter cancelled');
  const cancelled = api.state.concurrency.acquire(controller.signal); await until(() => api.state.concurrency.queued() === 1, 'advanced queued acquire');
  controller.abort(reason); await assert.rejects(() => cancelled, error => error === reason);
  releaseA(); releaseB(); assert.equal(api.state.concurrency.active(), 0);
  const request = await api.get('/manual-rate').build(); await api.state.rateLimit.acquire(request);
  assert.equal(api.state.rateLimit.starts(), 1);
  assert.deepEqual(await api.get('/after-manual-admission').json(), { ok: true });
  assert.equal(api.state.concurrency.active(), 0); assert.equal(api.state.concurrency.queued(), 0);
});
