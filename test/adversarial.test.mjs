import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avirx, AvirxError } from 'avirx';
import { assertCandidate } from '../scripts/provenance.mjs';

// Oracles below use explicit URL expectations or separately constructed native
// fetch/Request inputs. Agreement among Avirx build/preview/execute is insufficient.
const manifest = assertCandidate();
const opts = { timeout: 10_000 };
const execute = promisify(execFile);
const pendingGates = new Set();
const rawSeed = process.env.QUALIFICATION_SEED;
const seed = rawSeed === undefined ? 0x5eeda11 : Number(rawSeed);
assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff && (rawSeed === undefined || /^\d+$/.test(rawSeed)), 'QUALIFICATION_SEED must be an unsigned 32-bit decimal integer');
let randomState = seed || 0x9e3779b9;
const next = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const deadline = () => AbortSignal.timeout(7_000);
let origins;
let temporary;
let serial = 0;
const id = prefix => `${prefix}-${++serial}`;

async function serve() {
  const routes = new Map();
  const records = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      const parsed = new URL('http://qualification.invalid' + request.url);
      const record = { method: request.method, url: request.url, pathname: parsed.pathname, query: [...parsed.searchParams], headers: request.headers, body: bytes.toString('utf8'), base64: bytes.toString('base64') };
      records.push(record);
      const handler = routes.get(parsed.pathname);
      if (handler) { await handler(record, response); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(record));
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    routes,
    records,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}

before(async () => {
  origins = [await serve(), await serve()];
  temporary = await mkdtemp(join(tmpdir(), 'avirx-adversarial-'));
});
after(async () => {
  for (const gate of pendingGates) gate.resolve();
  if (origins) for (const origin of origins) await origin.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

async function nativeJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: deadline() });
  return { data: await response.json(), url: response.url, status: response.status, type: response.type };
}

function chain(prefix, codes, destinationOrigins, { publicFinal = false } = {}) {
  const caseId = id(prefix);
  const paths = Array.from({ length: codes.length + 1 }, (_, index) => `/ADV-REDIRECT/${caseId}/${index}`);
  const URLs = paths.map((path, index) => origins[destinationOrigins[index]].origin + path + (index === codes.length ? '?final=1' : ''));
  for (let index = 0; index < codes.length; index++) {
    origins[destinationOrigins[index]].routes.set(paths[index], (_record, response) => {
      response.writeHead(codes[index], { Location: URLs[index + 1] });
      response.end();
    });
  }
  if (publicFinal) origins[destinationOrigins.at(-1)].routes.set(paths.at(-1), (record, response) => {
    const body = JSON.stringify(record);
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  });
  return { caseId, paths, URLs, records: () => origins.flatMap(origin => origin.records).filter(record => record.pathname.includes(`/${caseId}/`)) };
}

function configureAuth(client, kind) {
  if (kind === 'managed') return client.auth.apiKey('x-review-credential', () => 'FAKE-QUALIFICATION-KEY');
  if (kind === 'direct') return client.header('X-API-Key', 'FAKE-QUALIFICATION-KEY');
  if (kind === 'bearer') return client.auth.bearer(() => 'FAKE-QUALIFICATION-BEARER');
  return client;
}
function nativeAuth(kind) {
  if (kind === 'managed') return { 'x-review-credential': 'FAKE-QUALIFICATION-KEY' };
  if (kind === 'direct') return { 'x-api-key': 'FAKE-QUALIFICATION-KEY' };
  if (kind === 'bearer') return { authorization: 'Bearer FAKE-QUALIFICATION-BEARER' };
  return {};
}
function assertWireEquivalent(actual, expected) {
  for (const field of ['method', 'body', 'base64']) assert.deepEqual(actual[field], expected[field], field);
  for (const name of ['authorization', 'x-review-credential', 'x-api-key', 'content-type']) assert.equal(actual.headers[name], expected.headers[name], `header:${name}`);
}

describe('ADV-REDIRECT: full-chain native behavior and credential decisions', { concurrency: false }, () => {
  const statuses = [301, 302, 303, 307, 308];
  for (const [statusIndex, status] of statuses.entries()) {
    for (const crossOrigin of [false, true]) {
      const placement = crossOrigin ? [0, 1, 0] : [0, 0, 0];
      const secondStatus = statuses[(statusIndex + 2) % statuses.length];
      for (const kind of ['managed', 'direct']) {
        test(`ADV-REDIRECT-default-${status}-${crossOrigin ? 'cross-return' : 'same-chain'}-${kind}`, opts, async () => {
          const route = chain('blocked', [status, secondStatus], placement);
          const method = statusIndex % 2 ? 'post' : 'get';
          let request = configureAuth(avirx(origins[0].origin), kind)[method](route.URLs[0]).signal(deadline());
          if (method === 'post') request = request.body('fixture-body');
          const result = await request.result();
          assert.equal(result.ok, false);
          assert(result.error instanceof AvirxError);
          assert.equal(result.error.kind, 'network');
          assert.equal(result.error.request.url.href, route.URLs[0]);
          assert.equal(result.status, undefined);
          assert.deepEqual(route.records().map(record => record.pathname), [route.paths[0]], 'even the first redirected recipient must not be reached');
          assert.equal(route.records()[0].headers[kind === 'managed' ? 'x-review-credential' : 'x-api-key'], 'FAKE-QUALIFICATION-KEY');
        });
        test(`ADV-REDIRECT-trusted-${status}-${crossOrigin ? 'cross-return' : 'same-chain'}-${kind}`, opts, async () => {
          const actualRoute = chain('trusted-actual', [status, secondStatus], placement);
          const controlRoute = chain('trusted-native', [status, secondStatus], placement);
          const method = statusIndex % 2 ? 'PUT' : 'POST';
          const payload = 'redirect-payload π';
          let client = configureAuth(avirx(origins[0].origin, { allowCredentialRedirects: true }), kind);
          // Derivation must retain the creation-time decision through body/policy changes.
          client = client.header('x-derived', 'retained').concurrency(1);
          const actual = await client[method.toLowerCase()](actualRoute.URLs[0]).body(payload).signal(deadline()).json();
          const expected = await nativeJson(controlRoute.URLs[0], { method, headers: nativeAuth(kind), body: payload });
          assertWireEquivalent(actual, expected.data);
          assert.equal(actual.pathname, actualRoute.paths.at(-1));
          assert.equal(actualRoute.records().length, 3);
          assert.equal(actual.headers[kind === 'managed' ? 'x-review-credential' : 'x-api-key'], 'FAKE-QUALIFICATION-KEY');
        });
      }
      for (const kind of ['ordinary', 'bearer']) test(`ADV-REDIRECT-native-${status}-${crossOrigin ? 'cross-return' : 'same-chain'}-${kind}`, opts, async () => {
        const actualRoute = chain('native-actual', [status, secondStatus], placement);
        const controlRoute = chain('native-control', [status, secondStatus], placement);
        const method = statusIndex % 2 ? 'POST' : 'GET';
        const payload = method === 'POST' ? 'native-redirect-body' : undefined;
        let request = configureAuth(avirx(origins[0].origin), kind)[method.toLowerCase()](actualRoute.URLs[0]).signal(deadline());
        if (payload !== undefined) request = request.body(payload);
        const actual = await request.json();
        const expected = await nativeJson(controlRoute.URLs[0], { method, headers: nativeAuth(kind), body: payload });
        assertWireEquivalent(actual, expected.data);
        assert.equal(actualRoute.records().length, 3);
        if (kind === 'bearer') {
          assert.equal(actual.headers.authorization, crossOrigin ? undefined : 'Bearer FAKE-QUALIFICATION-BEARER');
          const finalRecord = origins[0].records.find(record => record.pathname === actualRoute.paths.at(-1));
          assert.equal(finalRecord.headers.authorization, crossOrigin ? undefined : 'Bearer FAKE-QUALIFICATION-BEARER', 'returning to original origin must not resurrect stripped auth');
        }
      });
    }
  }
});

function multipartData() {
  const data = new FormData();
  data.append('field', 'Ada π');
  data.append('empty', '');
  data.append('file', new Blob(['file π\n'], { type: 'text/plain' }), 'fixture.txt');
  return data;
}
const bodyFactories = {
  multipart: multipartData,
  text: () => 'text π\r\n',
  form: () => new URLSearchParams([['repeated', 'one two'], ['repeated', 'π']]),
  blob: () => new Blob(['blob π'], { type: 'application/x-fixture' }),
  null: () => null,
  undefined: () => undefined,
};
function normalizeWire(record, kind) {
  let mime = record.headers['content-type'];
  let body = record.body;
  if (kind === 'multipart') {
    const boundary = body.match(/^--([^\r\n]+)\r\n/)?.[1];
    assert(boundary, 'multipart bytes include a transport boundary');
    body = body.split(boundary).join('TRANSPORT-BOUNDARY');
    if (mime?.startsWith('multipart/form-data;')) mime = mime.replace(/boundary=[^;]+/, 'boundary=TRANSPORT-BOUNDARY');
  }
  return { method: record.method, body, mime };
}
function mutateInspection(body) {
  if (body instanceof FormData) body.set('field', 'inspection-mutation');
  else if (body instanceof URLSearchParams) body.set('repeated', 'inspection-mutation');
}

describe('ADV-BODY: JSON derivation compared with fresh native serialization', { concurrency: false }, () => {
  const MIME = [
    { name: 'inferred', client: undefined, request: undefined, expected: undefined },
    { name: 'client-custom', client: 'application/x-caller', request: undefined, expected: 'application/x-caller' },
    { name: 'request-empty-over-client', client: 'application/json', request: '', expected: '' },
    { name: 'request-vendor-over-client', client: 'application/x-client', request: 'application/vnd.fixture+json', expected: 'application/vnd.fixture+json' },
  ];
  for (const method of ['post', 'put']) for (const [kind, factory] of Object.entries(bodyFactories)) for (const policy of MIME) {
    test(`ADV-BODY-${method}-${kind}-${policy.name}`, opts, async () => {
      let client = avirx(origins[0].origin);
      if (policy.client !== undefined) client = client.header('Content-Type', policy.client);
      let source = client[method]('/ADV-BODY/echo').body({ original: true });
      if (policy.request !== undefined) source = source.header('content-type', policy.request);
      assert.equal(source.state.headers['content-type'], policy.request);
      const sourceBuilt = await source.build();
      assert.equal(sourceBuilt.headers['content-type'], policy.expected ?? 'application/json');
      const sourceBeforeDerivation = await source.signal(deadline()).json();
      let derived;
      if (kind === 'multipart') derived = source.multipart().field('field', 'Ada π').field('empty', '').file('file', new Blob(['file π\n'], { type: 'text/plain' }), 'fixture.txt');
      else derived = source.body(factory());
      for (const inspected of [derived.state, await derived.build(), await derived.preview()]) mutateInspection(inspected.body);
      const actual = await derived.signal(deadline()).json();
      const headers = policy.expected === undefined ? {} : { 'Content-Type': policy.expected };
      const expected = await nativeJson(origins[0].origin + '/ADV-BODY/native', { method: method.toUpperCase(), headers, body: factory() });
      assert.deepEqual(normalizeWire(actual, kind), normalizeWire(expected.data, kind));
      assert.equal(derived.state.headers['content-type'], policy.request, 'inferred final MIME must not leak into explicit state');
      const original = await source.signal(deadline()).json();
      assert.equal(original.body, sourceBeforeDerivation.body, 'derived body/inspection never rewrites the original builder');
      assert.equal(original.headers['content-type'], sourceBeforeDerivation.headers['content-type']);
      // Explicit custom MIME may select native string conversion for an object;
      // source preservation is established against its own pre-derivation build.
      const originalNative = new Request(origins[0].origin + '/unused', { method: method.toUpperCase(), headers: sourceBuilt.headers, body: sourceBuilt.body instanceof Blob || typeof sourceBuilt.body === 'string' ? sourceBuilt.body : JSON.stringify(sourceBuilt.body) });
      if ((policy.expected ?? 'application/json').includes('json')) assert.equal(original.body, await originalNative.text());
      assert.equal((await source.build()).headers['content-type'], policy.expected ?? 'application/json');
    });
  }
});

const joinCases = [];
for (const base of ['/', '//', '/api', '/api/', '/api//']) {
  for (const route of ['', '?q=one', '/', '//', 'items/', '/items//?q=π']) {
    const prefix = base.replace(/\/+$/, '');
    const split = route.indexOf('?');
    const path = split < 0 ? route : route.slice(0, split);
    const query = split < 0 ? '' : route.slice(split);
    const expectedPath = path === '' ? base : /^\/+$/u.test(path) ? prefix + path : prefix + '/' + path.replace(/^\/+/, '');
    const native = new URL('http://qualification.invalid' + expectedPath + query);
    joinCases.push({ base, route, expected: native.pathname + native.search });
  }
}

describe('ADV-URL: explicit resource oracles and original dot-guard bypass shapes', { concurrency: false }, () => {
  for (const [index, item] of joinCases.entries()) test(`ADV-URL-join-${index}: ${JSON.stringify(item)}`, opts, async () => {
    const api = avirx(origins[0].origin + item.base);
    const relative = await api.delete(item.route).signal(deadline()).json();
    const absolute = await nativeJson(origins[0].origin + item.expected, { method: 'DELETE' });
    assert.equal(relative.url, item.expected);
    assert.equal(relative.url, absolute.data.url);
    assert.equal((await api.delete(origins[0].origin + item.expected).signal(deadline()).json()).url, item.expected);
  });
  for (const [index, path] of ['interior space/end', 'encoded%20space/end', 'encoded%00control/end', 'encoded%09tab/end', 'encoded%0Aline/end', 'encoded%0Dreturn/end'].entries()) test(`ADV-URL-static-data-${index}`, opts, async () => {
    const expected = new URL('/api/' + path, origins[0].origin);
    const actual = await avirx(origins[0].origin + '/api').get(path).signal(deadline()).json();
    assert.equal(actual.url, expected.pathname);
    assert.equal(actual.url, (await nativeJson(expected.href)).data.url);
  });
  for (const [index, name] of ['a/b', 'a?b', 'a#b', 'a\\b', 'a b', 'a\tb', 'a{b', 'a}b'].entries()) test(`ADV-URL-invalid-placeholder-${index}-dot-second-param`, opts, async () => {
    const route = `/x/{${name}}/users/{id}`;
    const params = Object.fromEntries([[name, 'safe'], ['id', '..']]);
    const previous = origins[0].records.length;
    await assert.rejects(async () => avirx(origins[0].origin + '/api').get(route).path(params).signal(deadline()).json());
    assert.equal(origins[0].records.length, previous);
  });
  for (const [index, name] of ['a%2Fb', 'a%3Fb', 'a%23b', 'a%20b', 'a%09b', 'a%5Cb', '__proto__', 'constructor', 'toString', '用户'].entries()) {
    test(`ADV-URL-valid-placeholder-${index}-dot-second-param`, opts, async () => {
      const route = `/x/{${name}}/users/{id}`;
      const before = origins[0].records.length;
      await assert.rejects(async () => avirx(origins[0].origin + '/api').get(route).path(Object.fromEntries([[name, 'safe'], ['id', '..']])).signal(deadline()).json());
      assert.equal(origins[0].records.length, before);
      const actual = await avirx(origins[0].origin + '/api').get(route).path(Object.fromEntries([[name, 'safe'], ['id', '%2e%2e']])).signal(deadline()).json();
      assert.equal(actual.url, '/api/x/safe/users/%252e%252e');
    });
  }
  test('ADV-URL-reserved-name-multiple-placeholder-occurrences', opts, async () => {
    const request = avirx(origins[0].origin).get('/{__proto__}/{constructor}/{__proto__}').path(Object.fromEntries([['__proto__', '雪/?#'], ['constructor', 'safe']]));
    const expected = `/${encodeURIComponent('雪/?#')}/safe/${encodeURIComponent('雪/?#')}`;
    assert.equal((await request.signal(deadline()).json()).url, expected);
  });
  for (const [index, credentials] of ['fixture-user:', ':fixture-password', 'fixture%20user:fixture%2Fpassword'].entries()) test(`ADV-URL-userinfo-${index}-rejected-without-diagnostics-leak`, opts, async () => {
    const destination = origins[0].origin.replace('://', `://${credentials}@`) + '/private';
    const before = origins[0].records.length;
    await assert.rejects(async () => avirx(origins[0].origin).get(destination).preview(), error => !String(error).includes('fixture') && !String(error).includes(credentials));
    assert.equal(origins[0].records.length, before);
  });
});

// Restricted shell-literal tokenizer; the rendered command is never passed to a
// shell. All executed destinations must be a known loopback fixture.
function curlArgv(command) {
  const args = [];
  let current = '';
  let quote;
  let started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") { if (char === "'") quote = undefined; else current += char; continue; }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\') current += command[++index];
      else { assert(!'$`'.includes(char)); current += char; }
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === '\\') { const escaped = command[++index]; if (escaped !== '\n') { current += escaped; started = true; } }
    else if (/\s/u.test(char)) { if (started) { args.push(current); current = ''; started = false; } }
    else if (char === '#' && !started) { while (index < command.length && command[index] !== '\n') index++; }
    else { assert(!'|;&<>$`()'.includes(char)); current += char; started = true; }
  }
  assert.equal(quote, undefined);
  if (started) args.push(current);
  assert.equal(args.shift(), 'curl');
  assert(args.some(arg => arg.startsWith(origins[0].origin + '/')));
  return args;
}

describe('ADV-CURL/CLOCK/CACHE: wire fidelity and public timing metadata', { concurrency: false }, () => {
  test('ADV-CURL-leading-at-is-inline-data-empty-header-is-present', opts, async t => {
    try { await execute('curl', ['--version'], { timeout: 5_000 }); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('curl executable unavailable'); return; } throw error; }
    const file = join(temporary, 'harmless-curl-control.txt');
    await writeFile(file, 'THIS-FILE-MUST-NOT-BECOME-THE-REQUEST-BODY');
    for (const payload of ['@' + file, '@-', '@inline π\nsecond line', "customer's 'literal' @data"]) {
      const request = avirx(origins[0].origin).post('/ADV-CURL/echo').header('x-empty', '').body(payload);
      const { stdout } = await execute('curl', ['--silent', '--show-error', '--max-time', '5', ...curlArgv(await request.curl())], { timeout: 6_000, maxBuffer: 1_000_000 });
      const actual = JSON.parse(stdout);
      const expected = await nativeJson(origins[0].origin + '/ADV-CURL/native', { method: 'POST', headers: { 'x-empty': '' }, body: payload });
      assert.equal(actual.body, payload);
      assert.equal(actual.base64, expected.data.base64);
      assert.equal(actual.headers['x-empty'], '');
      assert.equal(actual.headers['content-type'], expected.data.headers['content-type']);
    }
    assert.equal(await readFile(file, 'utf8'), 'THIS-FILE-MUST-NOT-BECOME-THE-REQUEST-BODY');
  });
  for (const shift of [-60_000, 60_000]) test(`ADV-CLOCK-native-headers-wall-shift-${shift}`, opts, async () => {
    const reached = deferred();
    const release = deferred();
    pendingGates.add(release);
    const path = '/ADV-CLOCK/' + id('headers');
    origins[0].routes.set(path, async (_record, response) => {
      reached.resolve();
      await release.promise;
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('done');
    });
    const wallNow = Date.now;
    const monotonicStart = performance.now();
    const pending = avirx(origins[0].origin).get(path).signal(deadline()).send();
    try {
      await Promise.race([reached.promise, pending.then(() => { throw Error('Clock fixture response arrived before release'); })]);
      Date.now = () => wallNow() + shift;
      release.resolve();
      const response = await pending;
      const outerDuration = performance.now() - monotonicStart;
      assert(response.timing.durationMs > 0);
      assert(response.timing.durationMs <= outerDuration, 'elapsed response duration fits inside independently measured monotonic execution');
      const wallDelta = response.timing.endedAt - response.timing.startedAt;
      assert.equal(Math.sign(wallDelta), Math.sign(shift));
      assert(Math.abs(wallDelta - shift) <= outerDuration + 1, 'public timestamps retain wall time rather than masquerading as elapsed duration');
      assert.equal(await response.native.text(), 'done');
    } finally {
      Date.now = wallNow;
      release.resolve();
      pendingGates.delete(release);
      origins[0].routes.delete(path);
    }
  });
  for (const crossOrigin of [false, true]) test(`ADV-CACHE-redirected-${crossOrigin ? 'cors-chain-bypasses-cache' : 'same-origin-hit-retains-final-URL'}`, opts, async () => {
    const route = chain('cache', [307, 302], crossOrigin ? [0, 1, 0] : [0, 0, 0], { publicFinal: true });
    const request = avirx(origins[0].origin).cache({ ttl: '30s' }).get(route.URLs[0]).signal(deadline());
    const first = await request.result();
    assert.equal(first.ok, true);
    assert.equal(first.response.url, route.URLs.at(-1));
    assert.equal(route.records().length, 3);
    const second = await request.send();
    assert.equal(second.url, route.URLs.at(-1));
    assert.deepEqual(await second.native.json(), first.data);
    if (crossOrigin) {
      assert.equal(first.response.native.type, 'cors');
      assert.equal(second.native.type, 'cors');
      assert.equal(route.records().length, 6, 'CORS-tainted redirect response must bypass cache despite returning to the initial origin');
    } else {
      assert.equal(second.timing.durationMs, 0);
      assert.equal(route.records().length, 3, 'cache hit has no redirect or destination network traffic');
    }
    await first.response.native.arrayBuffer();
  });
});

async function generatedDifference(value) {
  const { pathValue, query, trailing, staticPart, method } = value;
  const base = origins[0].origin + '/pairwise//';
  const template = `/static/${staticPart}/{constructor}${trailing}`;
  const request = avirx(base)[method](template).path({ constructor: pathValue }).query(Object.fromEntries([['__proto__', query], ['empty', '']])).signal(deadline());
  const expectedPath = `/pairwise/static/${staticPart}/${encodeURIComponent(pathValue)}${trailing}`;
  const expectedQuery = new URLSearchParams([...query.map(item => ['__proto__', item]), ['empty', '']]);
  const native = await nativeJson(origins[0].origin + expectedPath + '?' + expectedQuery, { method: method.toUpperCase() });
  const actual = await request.json();
  for (const field of ['method', 'url', 'query', 'body']) if (JSON.stringify(actual[field]) !== JSON.stringify(native.data[field])) return { field, actual: actual[field], expected: native.data[field] };
  return null;
}

describe('ADV-PROPERTY: bounded independently addressed native resource pairs', { concurrency: false }, () => {
  const values = ['snow 雪', 'a/b?c#d', '%2e%2e', '\tparameter', '__proto__', 'constructor', 'a+b&c=d', 'encoded%00'];
  for (let ordinal = 0; ordinal < 24; ordinal++) {
    const sample = { pathValue: values[next() % values.length], query: [values[next() % values.length], values[next() % values.length]], trailing: ['', '/', '//'][next() % 3], staticPart: ['interior space', 'literal%20space', 'encoded%09control'][next() % 3], method: ['get', 'delete', 'options'][next() % 3] };
    test(`ADV-PROPERTY-seed=${seed}-case=${ordinal}`, opts, async () => {
      const difference = await generatedDifference(sample);
      if (!difference) return;
      let minimal = structuredClone(sample);
      let minimalDifference = difference;
      let probes = 0;
      // This reducer operates only after a semantic mismatch; transport/harness
      // failures reject directly. At most 24 additional candidate probes run.
      for (const key of ['pathValue', 'trailing']) {
        let width = Math.ceil(minimal[key].length / 2);
        while (width > 0 && probes < 24) {
          let changed = false;
          for (let offset = 0; offset < minimal[key].length && probes < 24; offset += width) {
            const trial = structuredClone(minimal);
            trial[key] = trial[key].slice(0, offset) + trial[key].slice(offset + width);
            probes++;
            const trialDifference = await generatedDifference(trial);
            if (trialDifference) { minimal = trial; minimalDifference = trialDifference; changed = true; break; }
          }
          if (!changed) width = Math.floor(width / 2);
        }
      }
      const artifact = new URL(`../artifacts/failure-adversarial-${seed}-${ordinal}.json`, import.meta.url);
      await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
      await writeFile(artifact, JSON.stringify({ sourceSha: manifest.candidateCommit, seed, ordinal, original: sample, minimal, originalDifference: difference, minimalDifference, shrinkProbes: probes, replay: `QUALIFICATION_SEED=${seed} node --test --test-name-pattern='ADV-PROPERTY-seed=${seed}-case=${ordinal}$' test/adversarial.test.mjs` }, null, 2) + '\n');
      assert.fail(`semantic mismatch; seed=${seed};case=${ordinal}; minimized fixture=${artifact.pathname}`);
    });
  }
});
