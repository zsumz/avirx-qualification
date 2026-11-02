import assert from 'node:assert/strict';
import { before, after, describe, test } from 'node:test';
import http from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { avirx, AvirxError, endpoint, parseWithSchema } from 'avirx';
import { assertCandidate } from '../scripts/provenance.mjs';

const candidateManifest = assertCandidate();

// Independent installed-consumer tests. Only the root package export is imported.
const runFile = promisify(execFile);
const opts = { timeout: 8_000 };
const fixtures = [];
let primary;
let secondary;
let sequence = 0;
const unique = (prefix = 'case') => `${prefix}-${++sequence}`;

async function fixture() {
  const requests = [];
  const sockets = new Set();
  const timers = new Set();
  const attempts = new Map();
  const disposal = new Map();
  const schedule = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {});
    res.on('error', () => {});
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://fixture.invalid');
      const record = {
        method: req.method,
        url: req.url,
        pathname: url.pathname,
        query: [...url.searchParams],
        headers: req.headers,
        body: body.toString('utf8'),
        base64: body.toString('base64'),
      };
      requests.push(record);
      res.setHeader('X-Fixture', 'avirx-independent-consumer');
      if (url.pathname === '/fixture/disconnect') { res.destroy(); return; }
      if (url.pathname.startsWith('/fixture/disposal/')) {
        const count = (attempts.get(url.pathname) ?? 0) + 1;
        attempts.set(url.pathname, count);
        if (count === 1) {
          let resolveClosed;
          const item = { closed: new Promise(resolve => { resolveClosed = resolve; }), cancelled: false, chunks: 0 };
          disposal.set(url.pathname, item);
          res.once('close', () => { item.cancelled = !res.writableFinished; resolveClosed(); });
          res.writeHead(503, { 'Content-Type': 'application/octet-stream' });
          res.flushHeaders();
          const send = () => {
            if (res.destroyed) return;
            res.write(Buffer.alloc(32768, 97));
            if (++item.chunks === 32) res.end(); else schedule(send, 50);
          };
          send();
          return;
        }
      }
      if (url.pathname === '/fixture/redirect') {
        res.writeHead(Number(url.searchParams.get('code') ?? 302), { Location: url.searchParams.get('to') });
        res.end();
        return;
      }
      if (url.pathname.startsWith('/fixture/retry/')) {
        const id = url.pathname;
        const count = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, count);
        if (count <= Number(url.searchParams.get('fail') ?? 1)) {
          res.statusCode = Number(url.searchParams.get('code') ?? 503);
          if (url.searchParams.has('after')) res.setHeader('Retry-After', url.searchParams.get('after'));
        }
        res.setHeader('X-Attempt', String(count));
      }
      if (url.pathname === '/fixture/auth-refresh' && req.headers.authorization !== 'Bearer fixture-fresh') res.statusCode = 401;
      if (url.pathname === '/fixture/status') res.statusCode = Number(url.searchParams.get('code'));
      if (url.pathname === '/fixture/empty') {
        res.statusCode = Number(url.searchParams.get('code') ?? 204);
        res.end();
        return;
      }
      if (url.pathname === '/fixture/invalid-json') {
        res.setHeader('Content-Type', 'application/json');
        res.end('{not-valid-json');
        return;
      }
      if (url.pathname === '/fixture/download') {
        const data = Buffer.from('qualification\nπ\n');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', "attachment; filename=plain.txt; filename*=UTF-8''report%20%CF%80.txt");
        res.setHeader('Content-Length', data.byteLength);
        res.end(data);
        return;
      }
      if (url.pathname === '/fixture/truncated') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Length', '1000');
        res.write('{"partial":');
        schedule(() => res.destroy(), 20);
        return;
      }
      if (url.pathname === '/fixture/slowbody') {
        res.setHeader('Content-Type', 'text/plain');
        res.flushHeaders();
        res.write('first\n');
        schedule(() => res.end('last\n'), 120);
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(record));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const result = {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    disposal,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
  fixtures.push(result);
  return result;
}

before(async () => { primary = await fixture(); secondary = await fixture(); });
after(async () => { for (const item of fixtures.reverse()) await item.close(); });

const errorKind = kind => error => error instanceof AvirxError && error.kind === kind;
const jsonAt = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) }).then(response => response.json());

// Parse only the literal argv grammar emitted by curl(); never execute a shell.
// Operators/substitution outside quotes are rejected, and destinations must be fixtures.
function literalCurlArgv(command) {
  const argv = [];
  let current = '';
  let quote = null;
  let present = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\') current += command[++i];
      else { assert(!'$`'.includes(ch), 'nonliteral double quote'); current += ch; }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; present = true; }
    else if (/\s/.test(ch)) { if (present) { argv.push(current); current = ''; present = false; } }
    else if (ch === '\\') {
      const escaped = command[++i];
      if (escaped !== '\n') { current += escaped; present = true; }
    }
    else { assert(!'|;&<>$`()'.includes(ch), 'shell operator'); current += ch; present = true; }
  }
  assert.equal(quote, null, 'balanced quoting');
  if (present) argv.push(current);
  assert.equal(argv.shift(), 'curl');
  assert(argv.some(arg => arg.startsWith(primary.origin + '/')), 'local fixture destination');
  return argv;
}

describe('URL routing, encoding and immutable consumer values', { concurrency: false }, () => {
  const joins = [
    ['', '/prefix/'], ['?fixed=1', '/prefix/?fixed=1'], ['/', '/prefix/'],
    ['//', '/prefix//'], ['///', '/prefix///'], ['item', '/prefix/item'],
    ['item/', '/prefix/item/'], ['/item//', '/prefix/item//'],
    ['item?x=1#ignored', '/prefix/item?x=1'],
    ['a b/', '/prefix/a%20b/'], ['already%2Fencoded/', '/prefix/already%2Fencoded/'],
  ];
  for (const [route, wirePath] of joins) test(`base prefix + ${JSON.stringify(route)} retains wire suffix`, opts, async () => {
    const result = await avirx(primary.origin + '/prefix/').get(route).json();
    assert.equal(result.url, wirePath);
  });
  test('absolute route changes destination but retains explicit client policy', opts, async () => {
    const result = await avirx(primary.origin + '/prefix').header('x-client', 'retained').get(secondary.origin + '/absolute//').json();
    assert.equal(result.url, '/absolute//');
    assert.equal(result.headers['x-client'], 'retained');
  });
  for (const key of ['id', '__proto__', 'constructor', 'toString', 'name.with:punctuation', '用户']) {
    test(`exact placeholder ${key} accepts encoded Unicode and separators`, opts, async () => {
      const value = 'é/ space?x#π%';
      const params = Object.fromEntries([[key, value]]);
      const result = await avirx(primary.origin).get(`/users/{${key}}/`).path(params).json();
      assert.equal(result.pathname, `/users/${encodeURIComponent(value)}/`);
    });
  }
  test('query arrays, booleans, reserved names and replacement survive the wire', opts, async () => {
    const query = Object.fromEntries([['__proto__', ['a', 'b']], ['constructor', 'safe'], ['unicode', '雪 ?&'], ['flag', false], ['ignored', undefined], ['nil', null]]);
    const request = avirx(primary.origin).get('/query?base=yes').query(query).query({ unicode: ['new', 'π'], n: 0 });
    const response = await request.json();
    const values = new URLSearchParams(response.query);
    assert.deepEqual(values.getAll('__proto__'), ['a', 'b']);
    assert.equal(values.get('constructor'), 'safe');
    assert.deepEqual(values.getAll('unicode'), ['new', 'π']);
    assert.equal(values.get('flag'), 'false');
    assert.equal(values.get('n'), '0');
    assert.equal(values.get('base'), 'yes');
    assert.equal(values.has('ignored'), false);
    assert.equal(values.has('nil'), false);
  });
  test('URLSearchParams and query arrays snapshot external mutation', opts, async () => {
    const params = new URLSearchParams([['a', '1'], ['a', '2']]);
    const request = avirx(primary.origin).get('/query').query(params);
    params.set('a', 'changed');
    assert.deepEqual(new URLSearchParams((await request.json()).query).getAll('a'), ['1', '2']);
    const values = ['first', 'second'];
    const immutable = request.query({ values });
    values[0] = 'changed';
    assert(Object.isFrozen(immutable.state.query.values));
    assert.deepEqual(new URLSearchParams((await immutable.json()).query).getAll('values'), ['first', 'second']);
  });
  test('derived headers and URL inspection cannot mutate source or siblings', opts, async () => {
    const client = avirx(primary.origin + '/stable').header('x-client', 'one');
    const source = client.get('/a').header('x-request', 'one');
    const sibling = source.header('x-request', 'two').query({ q: 'two' });
    const built = await source.build();
    built.url.pathname = '/changed';
    built.redactedUrl.pathname = '/changed-again';
    client.state.baseUrl.pathname = '/external';
    assert(Object.isFrozen(source.state.headers));
    assert.equal((await source.json()).url, '/stable/a');
    assert.equal((await source.json()).headers['x-request'], 'one');
    assert.equal((await sibling.json()).url, '/stable/a?q=two');
    assert.equal((await sibling.json()).headers['x-request'], 'two');
  });
  for (const value of ['.', '..', '%2e', '%2E%2e']) test(`path value ${value} treats dots as segments and percent escapes as data`, opts, async () => {
    // Literal percent escapes are encoded as data; only actual dot segments reject.
    const before = primary.requests.length;
    const request = avirx(primary.origin).get('/users/{id}').path({ id: value });
    if (value.includes('%')) {
      assert.equal((await request.json()).pathname, `/users/${encodeURIComponent(value)}`);
    } else {
      await assert.rejects(async () => request.json());
      assert.equal(primary.requests.length, before);
    }
  });
  for (const route of [' /unsafe', '/unsafe ', '/unsafe\tsegment', '/unsafe\nsegment', '/unsafe\u0000segment']) test(`unsafe static template ${JSON.stringify(route)} rejects before transport`, opts, async () => {
    const before = primary.requests.length;
    await assert.rejects(async () => avirx(primary.origin).get(route).json());
    assert.equal(primary.requests.length, before);
  });
  for (const route of ['/x/{}', '/x/{two words}', '/x/{a/b}', '/x/{a?b}', '/x/{a#b}', '/x/{a\\b}']) test(`malformed placeholder ${route} rejects`, opts, async () => {
    const before = primary.requests.length;
    await assert.rejects(async () => avirx(primary.origin).get(route).build());
    assert.equal(primary.requests.length, before);
  });
  test('URL credentials reject without leaking userinfo to diagnostic errors', opts, async () => {
    for (const destination of [`http://fixture-user:fixture-password@127.0.0.1:${new URL(primary.origin).port}`, `http://fixture-user@127.0.0.1:${new URL(primary.origin).port}`]) {
      await assert.rejects(async () => avirx(destination).get('/').build(), error => !String(error).includes('fixture-user') && !String(error).includes('fixture-password'));
      await assert.rejects(async () => avirx(primary.origin).get(destination + '/').preview(), error => !String(error).includes('fixture-user'));
    }
  });
  test('missing and extra path keys reject before transport', opts, async () => {
    const before = primary.requests.length;
    for (const params of [{}, { id: 'a', extra: 'b' }]) await assert.rejects(async () => avirx(primary.origin).get('/x/{id}').path(params).json());
    assert.equal(primary.requests.length, before);
  });
});

describe('body serialization and reusable builders over real HTTP', { concurrency: false }, () => {
  test('JSON attachment deeply snapshots caller data and inspection copies', opts, async () => {
    const input = { nested: { value: 'original' }, array: ['original'] };
    const request = avirx(primary.origin).post('/echo').body(input);
    input.nested.value = 'changed';
    input.array[0] = 'changed';
    for (const inspected of [request.state, await request.build(), await request.preview()]) {
      if (inspected.body && typeof inspected.body === 'object') inspected.body.nested.value = 'inspection-change';
    }
    const result = await request.json();
    assert.deepEqual(JSON.parse(result.body), { nested: { value: 'original' }, array: ['original'] });
    assert.equal(result.headers['content-type'], 'application/json');
    assert.equal(request.state.headers['content-type'], undefined);
  });
  const variants = {
    json: () => ({ value: '雪' }),
    text: () => 'plain π',
    form: () => new URLSearchParams([['a', 'one two'], ['a', 'π']]),
    bytes: () => new Uint8Array([0, 1, 127, 255]).buffer,
    blob: () => new Blob(['blob π'], { type: 'application/x-fixture' }),
    multipart: () => { const data = new FormData(); data.set('field', 'multipart π'); data.set('file', new Blob(['file-value']), 'fixture.txt'); return data; },
    null: () => null,
    undefined: () => undefined,
  };
  const expectedMime = { json: /^application\/json$/, text: /^text\/plain/, form: /^application\/x-www-form-urlencoded/, bytes: undefined, blob: /^application\/x-fixture$/, multipart: /^multipart\/form-data; boundary=/, null: undefined, undefined: undefined };
  for (const [from, initial] of Object.entries(variants)) {
    for (const [to, replacement] of Object.entries(variants)) {
      test(`body replacement ${from} → ${to} has native final MIME and bytes`, opts, async () => {
        const final = replacement();
        const request = avirx(primary.origin).post('/echo').body(initial()).body(final);
        const result = await request.json();
        const mime = result.headers['content-type'];
        if (expectedMime[to]) assert.match(mime, expectedMime[to]); else assert.equal(mime, undefined);
        if (to === 'json') assert.deepEqual(JSON.parse(result.body), { value: '雪' });
        if (to === 'text') assert.equal(result.body, 'plain π');
        if (to === 'form') assert.equal(result.body, final.toString());
        if (to === 'bytes') assert.equal(result.base64, Buffer.from([0, 1, 127, 255]).toString('base64'));
        if (to === 'blob') assert.equal(result.body, 'blob π');
        if (to === 'multipart') {
          const boundary = mime.slice(mime.indexOf('boundary=') + 9);
          assert(result.body.startsWith(`--${boundary}\r\n`));
          assert(result.body.includes('name="field"'));
          assert(result.body.includes('multipart π'));
          assert(result.body.includes('filename="fixture.txt"'));
          assert(result.body.includes('file-value'));
        }
        if (to === 'null' || to === 'undefined') assert.equal(result.body, '');
      });
    }
  }
  for (const mime of ['application/custom', 'application/problem+json', '']) test(`explicit Content-Type ${JSON.stringify(mime)} remains caller-owned after replacement`, opts, async () => {
    const client = avirx(primary.origin).header('content-type', mime);
    const request = client.post('/echo').body({ old: true }).body('replacement');
    const result = await request.json();
    assert.equal(result.headers['content-type'], mime);
    assert.equal(result.body, 'replacement');
  });
  test('ArrayBuffer, URLSearchParams, and FormData attach immutable snapshots', opts, async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const binary = avirx(primary.origin).put('/echo').body(bytes.buffer);
    bytes[0] = 255;
    const stateCopy = binary.state.body;
    new Uint8Array(stateCopy)[1] = 255;
    assert.equal((await binary.json()).base64, Buffer.from([1, 2, 3]).toString('base64'));
    const form = new URLSearchParams({ q: 'original' });
    const formRequest = avirx(primary.origin).post('/echo').body(form);
    form.set('q', 'changed');
    (await formRequest.build()).body.set('q', 'inspection-change');
    assert.equal((await formRequest.json()).body, 'q=original');
    const data = new FormData(); data.set('field', 'original');
    const multipart = avirx(primary.origin).post('/echo').body(data);
    data.set('field', 'changed');
    (await multipart.preview()).body.set('field', 'inspection-change');
    assert((await multipart.json()).body.includes('\r\noriginal\r\n'));
  });
  test('multipart fluent field/file derivation snapshots source builder', opts, async () => {
    const source = avirx(primary.origin).post('/upload').multipart().field('count', 2).field('enabled', false);
    const derived = source.file('upload', new Blob(['file-data'], { type: 'text/plain' }), 'data.txt');
    assert(!(await source.json()).body.includes('data.txt'));
    const result = await derived.json();
    assert(result.body.includes('name="count"\r\n\r\n2'));
    assert(result.body.includes('name="enabled"\r\n\r\nfalse'));
    assert(result.body.includes('filename="data.txt"'));
    assert(result.body.includes('file-data'));
  });
  test('native streaming upload is single-use and sends exact bytes', opts, async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream π')); controller.close(); } });
    const request = avirx(primary.origin).put('/upload').body(stream);
    assert.equal(request.state.body, stream);
    assert.equal((await request.json()).body, 'stream π');
    await assert.rejects(request.json(), errorKind('network'));
  });
  test('GET and HEAD reject body and multipart calls before transport', opts, async () => {
    const before = primary.requests.length;
    for (const method of ['get', 'head']) {
      const builder = avirx(primary.origin)[method]('/');
      await assert.rejects(async () => builder.body('illegal').json());
      await assert.rejects(async () => builder.multipart().field('illegal', 'body').json());
    }
    assert.equal(primary.requests.length, before);
  });
});

describe('auth, redirect and diagnostic credential boundaries', { concurrency: false }, () => {
  test('bearer/basic/header/query auth produce real fake fixture credentials and redacted state', opts, async () => {
    const cases = [
      ['bearer', client => client.auth.bearer(() => 'fixture-token'), echo => assert.equal(echo.headers.authorization, 'Bearer fixture-token'), ['fixture-token']],
      ['basic', client => client.auth.basic('fixture-user', 'fixture-password'), echo => assert.equal(echo.headers.authorization, `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`), ['fixture-password', Buffer.from('fixture-user:fixture-password').toString('base64')]],
      ['header', client => client.auth.apiKey('x-custom-credential', () => 'fixture-key'), echo => assert.equal(echo.headers['x-custom-credential'], 'fixture-key'), ['fixture-key']],
      ['query', client => client.auth.query('credential', () => 'fixture-query-key'), echo => assert.equal(new URLSearchParams(echo.query).get('credential'), 'fixture-query-key'), ['fixture-query-key']],
    ];
    for (const [name, auth, verify, secrets] of cases) {
      const client = auth(avirx(primary.origin));
      const request = client.get('/auth');
      verify(await request.json());
      for (const value of [client.state, request.state, await request.preview(), await request.curl()]) {
        const rendered = JSON.stringify(value);
        for (const secret of secrets) assert(!rendered.includes(secret), `${name} leaked into diagnostic`);
      }
      const built = await request.build();
      assert.equal(built.authenticated, true);
      assert(secrets.some(secret => JSON.stringify(built.headers).includes(secret) || built.url.href.includes(secret)), `${name}: built request retains transport credential`);
    }
  });
  test('request auth overrides client auth and provider refreshes each retry', opts, async () => {
    const api = avirx(primary.origin).auth.bearer(() => 'old-client-token');
    assert.equal((await api.get('/auth').auth.apiKey('x-key', () => 'request-key').json()).headers.authorization, undefined);
    let token = 'fixture-expired';
    let calls = 0;
    const events = [];
    const fresh = avirx(primary.origin).auth.bearer(async () => { calls++; return token; }).retry({ attempts: 1, on: [401] }).on('response', context => {
      events.push(context.response().status);
      if (context.response().status === 401) token = 'fixture-fresh';
    });
    const result = await fresh.get('/fixture/auth-refresh').json();
    assert.equal(result.headers.authorization, 'Bearer fixture-fresh');
    assert.equal(calls, 2);
    assert.deepEqual(events, [401, 200]);
  });
  test('known direct secret headers are redacted in preview and curl', opts, async () => {
    const request = avirx(primary.origin).get('/auth').headers({ Authorization: 'Bearer fixture-sensitive', Cookie: 'fixture=session', 'X-API-Key': 'fixture-direct-key' });
    const preview = JSON.stringify(await request.preview());
    const curl = await request.curl();
    for (const secret of ['fixture-sensitive', 'fixture=session', 'fixture-direct-key']) { assert(!preview.includes(secret)); assert(!curl.includes(secret)); }
    assert((await request.curl({ redacted: false })).includes('fixture-sensitive'));
  });
  test('query API credential remains redacted after explicit query overrides', opts, async () => {
    const request = avirx(primary.origin).auth.query('key', () => 'fixture-provider-key').get('/auth').query({ key: 'fixture-override-key' });
    const preview = JSON.stringify(await request.preview());
    assert(!preview.includes('fixture-provider-key'));
    assert(!preview.includes('fixture-override-key'));
  });
  for (const sameOrigin of [true, false]) {
    for (const credential of ['managed-header', 'direct-known']) {
      test(`${credential} blocks ${sameOrigin ? 'same' : 'cross'}-origin redirect before destination`, opts, async () => {
        const target = sameOrigin ? primary : secondary;
        const path = '/redirect-target/' + unique();
        let api = avirx(primary.origin);
        if (credential === 'managed-header') api = api.auth.apiKey('x-fixture-secret', () => 'fake-redirect-key');
        if (credential === 'direct-known') api = api.header('x-api-key', 'fake-redirect-key');
        const result = await api.get('/fixture/redirect').query({ to: target.origin + path }).result();
        assert.equal(result.ok, false);
        assert.equal(result.error.kind, 'network');
        assert(!target.requests.some(record => record.pathname === path));
      });
    }
  }
  for (const sameOrigin of [true, false]) test(`query credential follows native redirect URL semantics (${sameOrigin ? 'same' : 'cross'} origin)`, opts, async () => {
    const target = sameOrigin ? primary : secondary;
    const path = '/query-redirect-target/' + unique();
    const result = await avirx(primary.origin).auth.query('secret', () => 'fake-query-secret').get('/fixture/redirect').query({ to: target.origin + path }).json();
    assert.equal(new URLSearchParams(result.query).has('secret'), false);
    assert.equal(result.pathname, path);
    const initial = primary.requests.findLast(record => record.pathname === '/fixture/redirect');
    assert.equal(new URLSearchParams(initial.query).get('secret'), 'fake-query-secret');
  });
  test('explicit credential redirect opt-in trusts destination and forwards fake key', opts, async () => {
    const result = await avirx(primary.origin, { allowCredentialRedirects: true }).auth.apiKey('x-fixture-secret', () => 'fake-opt-in-key').get('/fixture/redirect').query({ to: secondary.origin + '/opt-in' }).json();
    assert.equal(result.headers['x-fixture-secret'], 'fake-opt-in-key');
  });
  test('native bearer auth is stripped on cross-origin redirect', opts, async () => {
    const result = await avirx(primary.origin).auth.bearer(() => 'fake-bearer-key').get('/fixture/redirect').query({ to: secondary.origin + '/bearer-target' }).json();
    assert.equal(result.headers.authorization, undefined);
  });
  test('ordinary redirects preserve final response URL and status metadata', opts, async () => {
    const path = '/ordinary-redirect/' + unique();
    const response = await avirx(primary.origin).get('/fixture/redirect').query({ to: secondary.origin + path }).send();
    assert.equal(response.url, secondary.origin + path);
    assert.equal(response.native.redirected, true);
    assert.equal(response.status, 200);
    assert.equal((await response.native.json()).pathname, path);
  });
});

describe('conservative retries, replay and callback contracts', { concurrency: false }, () => {
  for (const method of ['get', 'head', 'delete', 'options', 'put', 'post', 'patch']) test(`${method.toUpperCase()} follows documented retry safety`, opts, async () => {
    const path = '/fixture/retry/' + unique(method);
    const request = avirx(primary.origin).retry(1)[method](path);
    const result = await request.result();
    const records = primary.requests.filter(record => record.pathname === path);
    const safe = !['post', 'patch'].includes(method);
    assert.equal(records.length, safe ? 2 : 1);
    assert.equal(result.ok, safe);
    if (!safe) assert.equal(result.error.kind, 'http');
  });
  test('replayable PUT JSON snapshots identical bytes for every attempt', opts, async () => {
    const path = '/fixture/retry/' + unique();
    const input = { message: 'same π', nested: [1, 2] };
    const request = avirx(primary.origin).put(path).body(input).retry(2).query({ fail: 2 });
    input.nested[0] = 99;
    const result = await request.json();
    assert.equal(result.body, JSON.stringify({ message: 'same π', nested: [1, 2] }));
    const records = primary.requests.filter(record => record.pathname === path);
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map(record => record.body)).size, 1);
  });
  for (const kind of ['multipart', 'stream']) test(`${kind} PUT remains single attempt under retry policy`, opts, async () => {
    const path = '/fixture/retry/' + unique();
    let request = avirx(primary.origin).put(path).retry(2);
    if (kind === 'multipart') request = request.multipart().field('name', 'fixture');
    else request = request.body(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('fixture')); controller.close(); } }));
    const result = await request.result();
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(primary.requests.filter(record => record.pathname === path).length, 1);
  });
  test('expected retryable status is accepted without retry', opts, async () => {
    const path = '/fixture/retry/' + unique();
    const result = await avirx(primary.origin).get(path).retry(3).expect(503).result();
    assert.equal(result.ok, true);
    assert.equal(result.status, 503);
    assert.equal(primary.requests.filter(record => record.pathname === path).length, 1);
  });
  test('retry hook reports attempt status and bounded Retry-After metadata', opts, async () => {
    const events = [];
    const path = '/fixture/retry/' + unique();
    const response = await avirx(primary.origin).get(path).query({ fail: 2, after: '0' }).retry(2).on('retry', context => events.push(context.retry())).send();
    await response.native.arrayBuffer();
    assert.deepEqual(events.map(event => [event.attempt, event.status, event.delayMs]), [[1, 503, 0], [2, 503, 0]]);
    assert.deepEqual(response.timing.retryEvents, events);
  });
  test('client/request hooks run in registration order for every attempt', opts, async () => {
    const events = [];
    const api = avirx(primary.origin).on('request', () => events.push('client-request')).on('response', () => events.push('client-response'));
    await api.get('/fixture/retry/' + unique()).retry(1).on('request', () => events.push('request')).on('response', () => events.push('response')).on('retry', () => events.push('retry')).json();
    assert.deepEqual(events, ['client-request', 'request', 'client-response', 'response', 'retry', 'client-request', 'request', 'client-response', 'response']);
  });
  for (const terminal of ['send', 'json', 'text', 'download', 'result']) {
    for (const phase of ['request', 'response', 'retry', 'auth']) test(`${phase} callback failure rejects original value from ${terminal}`, opts, async () => {
      const sentinel = { fixture: unique(), phase };
      let operationErrors = 0;
      let request = avirx(primary.origin).on('error', () => { operationErrors++; }).get(phase === 'retry' ? '/fixture/retry/' + unique() : '/callback').retry(1);
      if (phase === 'auth') request = request.auth.bearer(async () => { throw sentinel; });
      else request = request.on(phase, async () => { throw sentinel; });
      await assert.rejects(request[terminal](), error => error === sentinel);
      assert.equal(operationErrors, 0);
    });
  }
  test('error-hook failure rejects original value without recursive error hooks', opts, async () => {
    const sentinel = new Error('fixture-error-hook');
    let count = 0;
    const request = avirx(primary.origin).get('/fixture/status').query({ code: 409 }).on('error', () => { count++; throw sentinel; });
    await assert.rejects(request.result(), error => error === sentinel);
    assert.equal(count, 1);
  });
  test('discarded retry response cancels an unfinished native body before retry', opts, async () => {
    const path = '/fixture/disposal/' + unique();
    const result = await avirx(primary.origin).get(path).retry(1).json();
    assert.equal(result.pathname, path);
    const item = primary.disposal.get(path);
    await item.closed;
    assert.equal(item.cancelled, true);
    assert(item.chunks < 32);
    assert.equal(primary.requests.filter(record => record.pathname === path).length, 2);
  });
  test('response hook failure cancels unfinished native body and preserves sentinel', opts, async () => {
    const path = '/fixture/disposal/' + unique();
    const sentinel = { reason: 'fixture-dispose-hook' };
    await assert.rejects(avirx(primary.origin).get(path).on('response', () => { throw sentinel; }).result(), error => error === sentinel);
    const item = primary.disposal.get(path);
    await item.closed;
    assert.equal(item.cancelled, true);
    assert(item.chunks < 32);
  });
  test('policy validation rejects invalid retries without transport', opts, async () => {
    const before = primary.requests.length;
    for (const attempts of [-1, 11, 1.5, NaN, Infinity]) assert.throws(() => avirx(primary.origin).retry(attempts));
    assert.equal(primary.requests.length, before);
  });
});

describe('response terminals, schemas and metadata', { concurrency: false }, () => {
  test('transport disconnect before headers is a network operation error', opts, async () => {
    const result = await avirx(primary.origin).get('/fixture/disconnect').result();
    assert.equal(result.ok, false);
    assert.equal(result.error.kind, 'network');
    assert.equal(result.status, undefined);
    assert.equal(result.error.request.url.pathname, '/fixture/disconnect');
    assert(result.error.cause instanceof Error);
  });
  test('send returns untouched native response and complete response metadata', opts, async () => {
    const response = await avirx(primary.origin).get('/raw').send();
    assert.equal(response.native.bodyUsed, false);
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    assert.equal(response.headers['x-fixture'], 'avirx-independent-consumer');
    assert.equal(response.request.method, 'GET');
    assert.equal(response.url, primary.origin + '/raw');
    assert(response.timing.durationMs >= 0);
    assert(response.timing.startedAt > 0);
    assert(response.timing.endedAt >= response.timing.startedAt);
    assert.equal((await response.native.json()).pathname, '/raw');
  });
  test('text and download retain exact Unicode bytes and content metadata', opts, async () => {
    const request = avirx(primary.origin).get('/fixture/download');
    const text = await request.text();
    assert.equal(text, 'qualification\nπ\n');
    const download = await request.download();
    assert.equal(await download.blob.text(), text);
    assert.equal(download.status, 200);
    assert.equal(download.filename, 'report π.txt');
    assert.equal(download.contentType, 'text/plain; charset=utf-8');
    assert.equal(download.contentLength, Buffer.byteLength(text));
    assert.equal(download.response.url, primary.origin + '/fixture/download');
  });
  for (const code of [204, 205]) test(`${code} JSON is undefined and schema explicitly transforms it`, opts, async () => {
    const request = avirx(primary.origin).get('/fixture/empty').query({ code });
    assert.equal(await request.json(), undefined);
    assert.equal(await request.as({ async parse(input) { assert.equal(input, undefined); return 'empty'; } }), 'empty');
  });
  test('HEAD JSON/contract result is undefined without parsing echo body', opts, async () => {
    assert.equal(await avirx(primary.origin).head('/head').json(), undefined);
    const contracts = avirx(primary.origin).contract({ exists: endpoint.head('/head/{id}') });
    const result = await contracts.exists.result({ path: { id: 'a' } });
    assert.equal(result.ok, true);
    assert.equal(result.data, undefined);
  });
  test('decode failures and schema validation failures have stable kinds and causes', opts, async () => {
    const decode = await avirx(primary.origin).get('/fixture/invalid-json').result();
    assert.equal(decode.ok, false);
    assert.equal(decode.error.kind, 'decode');
    assert.equal(decode.status, 200);
    const cause = new Error('fixture-schema-failure');
    let hookError;
    const validated = await avirx(primary.origin).get('/schema').on('error', context => { hookError = context.error(); }).result({ async parse() { throw cause; } });
    assert.equal(validated.ok, false);
    assert.equal(validated.error.kind, 'validation');
    assert.equal(validated.error.cause, cause);
    assert.equal(hookError, validated.error);
    assert.equal(validated.status, 200);
  });
  test('HTTP error schemas await transformations and preserve parser failure as HTTP cause', opts, async () => {
    const request = avirx(primary.origin).get('/fixture/status').query({ code: 409 });
    const parsed = await request.error({ async parse(input) { return { method: input.method, transformed: true }; } }).result();
    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 409);
    assert.equal(parsed.error.kind, 'http');
    assert.deepEqual(parsed.error.data, { method: 'GET', transformed: true });
    const sentinel = new Error('fixture-error-parser');
    const rejected = await request.error({ async parse() { throw sentinel; } }).result();
    assert.equal(rejected.error.kind, 'http');
    assert.equal(rejected.error.cause, sentinel);
  });
  test('buffered body transport failure retains current response metadata', opts, async t => {
    const observedKinds = {};
    // The public contract promises AvirxError/status/cause, without specifying
    // whether a truncated body is decode or network. Record the observed kinds.
    for (const terminal of ['json', 'text', 'download', 'result']) {
      const request = avirx(primary.origin).get('/fixture/truncated');
      if (terminal === 'result') {
        const result = await request.result();
        assert.equal(result.ok, false);
        assert(result.error instanceof AvirxError);
        observedKinds[terminal] = result.error.kind;
        assert(result.error.cause instanceof TypeError);
        assert.equal(result.status, 200);
      } else await assert.rejects(request[terminal](), error => {
        observedKinds[terminal] = error.kind;
        return error instanceof AvirxError && error.status === 200 && error.cause instanceof TypeError;
      });
    }
    t.diagnostic('Observed truncated-body error kinds: ' + JSON.stringify(observedKinds));
  });
  test('timeout ends at headers and slow body remains consumable', opts, async () => {
    const text = await avirx(primary.origin).get('/fixture/slowbody').timeout(60).text();
    assert.equal(text, 'first\nlast\n');
  });
  test('async contract params/query/body/output parsers exercise real consumer flow', opts, async () => {
    const api = avirx(primary.origin).contract({
      save: endpoint.put('/contract/{id}')
        .params({ async parse(input) { return { id: input.id.trim() }; } })
        .query({ async parse(input) { return { count: Number(input.count) }; } })
        .body({ async parse(input) { return { message: input.message.toUpperCase() }; } })
        .returns({ async parse(input) { return { path: input.pathname, query: input.query, body: JSON.parse(input.body) }; } }),
    });
    assert.deepEqual(await api.save({ path: { id: ' book ' }, query: { count: '2' }, body: { message: 'hello' } }), { path: '/contract/book', query: [['count', '2']], body: { message: 'HELLO' } });
  });
  test('contract input rejection is preflight and remains original in result mode', opts, async () => {
    const sentinel = { reason: 'fixture-input-reject' };
    const before = primary.requests.length;
    const api = avirx(primary.origin).contract({ read: endpoint.get('/contract').query({ async parse() { throw sentinel; } }) });
    await assert.rejects(api.read({ query: {} }), error => error === sentinel);
    await assert.rejects(api.read.result({ query: {} }), error => error === sentinel);
    assert.equal(primary.requests.length, before);
  });
  test('contract rejects then/symbol keys and retains nonenumerable own endpoints', opts, async () => {
    const api = avirx(primary.origin);
    assert.throws(() => api.contract({ then: endpoint.get('/') }));
    assert.throws(() => api.contract({ [Symbol('hidden')]: endpoint.get('/') }));
    const definition = Object.create({ inherited: endpoint.get('/inherited') });
    Object.defineProperty(definition, 'hidden', { value: endpoint.get('/nonenumerable'), enumerable: false });
    const contract = api.contract(definition);
    assert.equal(contract.inherited, undefined);
    assert.equal((await contract.hidden({})).pathname, '/nonenumerable');
    assert.equal(await Promise.resolve(contract), contract);
  });
  test('parseWithSchema exposes raw sync/async parser value without HTTP wrapping', opts, async () => {
    assert.equal(parseWithSchema({ parse: value => value + 1 }, 1), 2);
    assert.equal(await parseWithSchema({ async parse(value) { return value + 1; } }, 2), 3);
    const sentinel = { parser: 'raw' };
    assert.throws(() => parseWithSchema({ parse() { throw sentinel; } }, 0), error => error === sentinel);
  });
});

describe('seeded wire combinations and cURL fidelity', { concurrency: false }, () => {
  const rawSeed = process.env.QUALIFICATION_SEED;
  const seed = rawSeed === undefined ? 0x41a71e : Number(rawSeed);
  assert(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff && (rawSeed === undefined || /^\d+$/.test(rawSeed)), 'QUALIFICATION_SEED must be an unsigned 32-bit decimal integer');
  let state = seed || 0x9e3779b9; // xorshift32 requires a nonzero internal state; seed 0 is reproducible.
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const values = ['plain', '雪', 'a/b', 'a?b#c', '%2f', ' spaced ', '\tdata', '__proto__', 'éπ', 'a+b&c=d'];
  for (let i = 0; i < 48; i++) {
    const id = values[next() % values.length];
    const query = [values[next() % values.length], values[next() % values.length]];
    const suffix = ['', '/', '//'][next() % 3];
    test(`seed=${seed} case=${i} path/query/body differential`, opts, async () => {
      const original = { ordinal: i, id, query, suffix };
      const compare = async value => {
        const payload = { ordinal: value.ordinal, id: value.id, query: value.query };
        const actual = await avirx(primary.origin + '/prefix/').put(`/generated/{id}${value.suffix}`).path({ id: value.id }).query({ value: value.query }).body(payload).signal(AbortSignal.timeout(5_000)).json();
        const expectedPath = `/prefix/generated/${encodeURIComponent(value.id)}${value.suffix}`;
        const expectedQuery = new URLSearchParams(value.query.map(item => ['value', item]));
        const native = await jsonAt(primary.origin + expectedPath + '?' + expectedQuery, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
        for (const field of ['url', 'pathname', 'query', 'method', 'body', 'base64']) {
          try { assert.deepEqual(actual[field], native[field]); }
          catch { return { field, actual: actual[field], expected: native[field] }; }
        }
        return null;
      };
      const difference = await compare(original);
      if (difference) {
        // Bounded delta reduction of strings only; this is not a general fuzzer.
        // Shrink only a semantic wire mismatch, never a fixture/transport failure.
        let minimal = structuredClone(original);
        let probes = 0;
        const fields = [
          { get: value => value.id, set: (value, text) => { value.id = text; } },
          ...minimal.query.map((_, index) => ({ get: value => value.query[index], set: (value, text) => { value.query[index] = text; } })),
          { get: value => value.suffix, set: (value, text) => { value.suffix = text; } },
        ];
        for (const field of fields) {
          let size = Math.ceil(field.get(minimal).length / 2);
          while (size > 0 && probes < 30) {
            let reduced = false;
            for (let offset = 0; offset < field.get(minimal).length && probes < 30; offset += size) {
              const trial = structuredClone(minimal);
              const text = field.get(trial);
              field.set(trial, text.slice(0, offset) + text.slice(offset + size));
              probes++;
              if (await compare(trial)) { minimal = trial; reduced = true; break; }
            }
            if (!reduced) size = Math.floor(size / 2);
          }
        }
        const artifact = new URL(`../artifacts/failure-url-${seed}-${i}.json`, import.meta.url);
        await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
        await writeFile(artifact, JSON.stringify({ sourceSha: candidateManifest.candidateCommit, seed, case: i, original, minimal, difference, shrinkProbes: probes, replay: `QUALIFICATION_SEED=${seed} node --test --test-name-pattern='seed=${seed} case=${i} ' test/http.test.mjs` }, null, 2) + '\n');
        assert.fail(`seed=${seed};case=${i}; minimized fixture=${artifact.pathname};difference=${JSON.stringify(difference)}`);
      }
    });
  }
  test('rendered literal cURL reproduces wire URL, body, inferred MIME and explicit empty header', opts, async t => {
    try { await runFile('curl', ['--version'], { timeout: 5_000 }); }
    catch (error) { if (error.code === 'ENOENT') { t.skip('curl executable unavailable'); return; } throw error; }
    const request = avirx(primary.origin).post('/curl/{id}').path({ id: 'π/a' }).query({ q: "a'b & π" }).header('x-empty', '').body({ note: "customer's π", control: '\nline' });
    const direct = await request.json();
    const rendered = await request.curl();
    const argv = literalCurlArgv(rendered);
    const { stdout } = await runFile('curl', ['--silent', '--show-error', '--max-time', '5', ...argv], { timeout: 6_000, maxBuffer: 1_000_000 });
    const actual = JSON.parse(stdout);
    for (const field of ['url', 'pathname', 'query', 'method', 'body', 'base64']) assert.deepEqual(actual[field], direct[field]);
    assert.equal(actual.headers['content-type'], direct.headers['content-type']);
    assert.equal(actual.headers['x-empty'], '');
  });
  test('cURL omits binary, multipart, stream and unrepresentable NUL body without consuming resources', opts, async () => {
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close(); } });
    const requests = [
      avirx(primary.origin).post('/curl').body(new Uint8Array([0, 1]).buffer),
      avirx(primary.origin).post('/curl').multipart().field('secret-form-field', 'fixture'),
      avirx(primary.origin).post('/curl').body(stream),
      avirx(primary.origin).post('/curl').body('literal\0body'),
    ];
    for (const request of requests) {
      const command = await request.curl();
      const executable = command.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');
      assert(!executable.includes('--data'), command);
      assert(!command.includes('\0'));
    }
    assert.equal(stream.locked, false);
    await stream.cancel();
  });
});
