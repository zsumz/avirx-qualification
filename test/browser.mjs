import { suiteEvidence, packageContent } from '../scripts/evidence.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { chromium, firefox, webkit } from 'playwright';
import { assertCandidate } from '../scripts/provenance.mjs';

// Native browser consumers import only the installed artifact's public entrypoint.
// Browser-engine qualification does not change Avirx's documented support promise.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = assertCandidate();
const suite = suiteEvidence();
const playwrightVersion = JSON.parse(await readFile(resolve(repo, 'node_modules/playwright/package.json'), 'utf8')).version;
const packageRoot = dirname(fileURLToPath(import.meta.resolve('avirx')));
const diagnostic = error => String(error?.stack ?? error)
    .replaceAll(repo, '<qualification>')
    .replaceAll(homedir(), '<home>')
    .replaceAll(tmpdir(), '<tmp>');
const engines = { chromium, firefox, webkit };
const selected = process.argv.includes('--all')
    ? Object.keys(engines)
    : [(process.argv.find(value => value.startsWith('--browser=')) ?? '--browser=chromium').split('=')[1]];
if (selected.some(name => !engines[name])) throw new Error('Use --browser=chromium|firefox|webkit or --all');
const counts = new Map();
const versions = new Map();
const observed = new Set();
const observers = new Map();
const plannedCheckIds = Object.freeze(Array.from({ length: 37 }, (_, index) => `B-${String(index + 1).padStart(3, '0')}`));
const activeTimers = new Set();
const sockets = new Set();
const delay = (callback, ms) => {
    const timer = setTimeout(() => { activeTimers.delete(timer); callback(); }, ms);
    activeTimers.add(timer);
    return timer;
};
const json = (res, value, status = 200, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(value));
};
const count = key => { const next = (counts.get(key) ?? 0) + 1; counts.set(key, next); return next; };

async function handler(req, res) {
    const url = new URL(req.url, 'http://fixture.invalid');
    const key = url.searchParams.get('key') ?? 'default';
    // Two truly different browser origins, with fixture-only permissive CORS.
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*');
    res.setHeader('access-control-expose-headers', 'Content-Disposition, Content-Length, X-Fixture, Vary');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Avirx independent browser consumer</title>');
        return;
    }
    if (url.pathname.startsWith('/package/')) {
        const requested = decodeURIComponent(url.pathname.slice('/package/'.length));
        const target = resolve(packageRoot, requested);
        const rel = relative(packageRoot, target);
        if (rel === '..' || rel.startsWith(`..${sep}`) || !requested.endsWith('.js')) {
            res.writeHead(403); res.end(); return;
        }
        const realTarget = await realpath(target);
        const realRoot = await realpath(packageRoot);
        const realRelative = relative(realRoot, realTarget);
        if (realRelative === '..' || realRelative.startsWith(`..${sep}`)) {
            res.writeHead(403); res.end(); return;
        }
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(await readFile(realTarget));
        return;
    }
    if (url.pathname === '/redirect') {
        count(`redirect:${key}`);
        res.writeHead(Number(url.searchParams.get('code') ?? 302), { location: url.searchParams.get('to') }); res.end(); return;
    }
    if (url.pathname === '/vary-language') {
        if (url.searchParams.has('hidden')) {
            // Deliberately hide Vary: the browser consumer must see a filtered CORS
            // response while the fixture's wire response still varies on language.
            res.setHeader('access-control-expose-headers', 'Content-Length, X-Fixture');
        }
        json(res, { count: count(`vary-language:${key}`), language: req.headers['accept-language'] ?? null }, 200,
            { 'cache-control': 'public, max-age=0', vary: 'Accept-Language' });
        return;
    }
    if (url.pathname === '/vary-presence') {
        json(res, { count: count(`vary-presence:${key}`), present: Object.hasOwn(req.headers, 'x-variant'), value: req.headers['x-variant'] ?? null }, 200,
            { 'cache-control': 'public, max-age=0', vary: 'X-Variant' });
        return;
    }
    if (url.pathname === '/hold-headers') {
        observed.add(key);
        observers.get(key)?.();
        const timer = delay(() => json(res, { released: 'fixture deadline' }), 5000);
        res.on('close', () => { clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/wait-observed') {
        if (observed.has(key)) { json(res, { observed: true }); return; }
        const finish = () => { observers.delete(key); clearTimeout(timer); activeTimers.delete(timer); json(res, { observed: observed.has(key) }); };
        const timer = delay(finish, 5000);
        observers.set(key, finish);
        res.on('close', () => { observers.delete(key); clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/public' || url.pathname === '/cors') {
        json(res, { count: count(`${url.pathname}:${key}`), key, version: versions.get(key) ?? 0 }, 200,
            // Avirx owns TTL freshness. Native HTTP freshness is disabled so browser cache
            // cannot make a missed library cache write or privacy bypass look successful.
            { 'cache-control': 'public, max-age=0', vary: 'Accept', 'x-fixture': 'public' });
        return;
    }
    if (url.pathname === '/cookie') {
        json(res, { session: 'fixture' }, 200, { 'set-cookie': 'qualification=fixture; Path=/; SameSite=Lax' });
        return;
    }
    if (url.pathname === '/private') {
        json(res, { count: count(`private:${key}`), cookie: req.headers.cookie ?? '' }, 200,
            { 'cache-control': 'private, max-age=0' });
        return;
    }
    if (url.pathname === '/auth') {
        const accepted = req.headers.authorization === 'Bearer refreshed-fixture-token';
        json(res, { accepted, authorization: req.headers.authorization }, accepted ? 200 : 401);
        return;
    }
    if (url.pathname === '/mutation') {
        versions.set(key, (versions.get(key) ?? 0) + 1);
        json(res, { version: versions.get(key) }); return;
    }
    if (url.pathname === '/slow-headers') {
        const timer = delay(() => json(res, { ok: true }), 100);
        res.on('close', () => { clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/slow-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":');
        const timer = delay(() => res.end('true}'), 1500);
        res.on('close', () => { clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/hold-body') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.write('{"started":');
        const timer = delay(() => res.end('true}'), 5000);
        res.on('close', () => { clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/stream') {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.write('first\n');
        const timer = delay(() => res.end('last\n'), 1500);
        res.on('close', () => { clearTimeout(timer); activeTimers.delete(timer); });
        return;
    }
    if (url.pathname === '/invalid') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end('{invalid'); return;
    }
    if (url.pathname === '/status') {
        json(res, { problem: 'fixture' }, Number(url.searchParams.get('code'))); return;
    }
    if (url.pathname === '/file') {
        const data = Buffer.from('download-雪');
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length,
            'content-disposition': "attachment; filename*=UTF-8''report-%E9%9B%AA.bin" });
        res.end(data); return;
    }
    if (url.pathname === '/head') { res.writeHead(200, { 'x-fixture': 'head' }); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    json(res, { method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'), count: count(`echo:${key}`) });
}

async function fixture() {
    const server = createServer((req, res) => {
        handler(req, res).catch(error => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(error));
        });
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const bounded = async (task, ms, label) => {
    let timer;
    try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms); })]); }
    finally { clearTimeout(timer); }
};

await mkdir(resolve(repo, 'artifacts'), { recursive: true });
const closeFixture = ({ server }) => bounded(new Promise((resolveClose, rejectClose) => {
    server.close(error => error ? rejectClose(error) : resolveClose());
}), 5000, 'HTTP fixture cleanup');
let first;
let second;
try {
    first = await fixture();
    second = await fixture();
} catch (error) {
    for (const timer of activeTimers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    const cleanup = await Promise.allSettled([first, second].filter(Boolean).map(closeFixture));
    const cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], 'Browser fixture startup failed and cleanup also failed.');
    throw error;
}
let failed = false;

try {
    for (const name of selected) {
        const result = { engine: name, status: 'running', node: process.version, browserVersion: null,
            playwrightVersion, suite, packageContentSha256: packageContent(candidate), candidateCommit: candidate.candidateCommit,
            packageIntegrity: candidate.package.integrity,
            platform: process.platform, plannedChecks: plannedCheckIds.length, plannedCheckIds, checks: [], assertions: 0,
            startedAt: new Date().toISOString() };
        let browser;
        let context;
        try {
            browser = await engines[name].launch({ headless: true, timeout: 20_000 });
            result.browserVersion = browser.version();
            context = await browser.newContext();
            const page = await context.newPage();
            page.setDefaultTimeout(10_000);
            await page.goto(first.origin);
            await page.evaluate(async () => { window.qualification = await import('/package/index.js'); });
            const check = async (title, task, id = plannedCheckIds[result.checks.length]) => {
                const began = performance.now();
                try {
                    const evidence = await bounded(task(), 8000, title);
                    result.assertions += evidence?.assertions ?? 1;
                    result.checks.push({ id, name: title, status: 'passed', durationMs: Math.round(performance.now() - began), ...evidence });
                } catch (error) {
                    result.checks.push({ id, name: title, status: 'failed', error: diagnostic(error) });
                    throw error;
                }
            };
            const run = (operation, extra = {}) => page.evaluate(operation, { origin: first.origin, other: second.origin, engine: name, ...extra });
            await check('installed ESM root exports and native required APIs', () => run(() => {
                const { avirx, endpoint, AvirxError } = window.qualification;
                if (![avirx, endpoint.get, AvirxError, AbortSignal.any].every(value => typeof value === 'function')) throw Error('Missing public export/API');
                return { assertions: 4 };
            }));
            await check('encoded path and repeated unicode query reach actual HTTP', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const value = await avirx(origin).get('/echo/{id}/').path({ id: 'a/b 雪' }).query({ q: ['one', '雪'], zero: 0 }).json();
                const url = new URL(value.url, origin);
                if (url.pathname !== '/echo/a%2Fb%20%E9%9B%AA/' || JSON.stringify(url.searchParams.getAll('q')) !== '["one","雪"]' || url.searchParams.get('zero') !== '0') throw Error(JSON.stringify(value));
                return { assertions: 3 };
            }));
            await check('builder and mutable inspection copies stay independent', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const body = { value: 'original' };
                const request = avirx(origin).post('/echo').body(body);
                body.value = 'changed';
                const preview = await request.preview();
                if (typeof preview.body === 'object') preview.body.value = 'inspection mutation';
                const derived = request.header('x-derived', 'only-derived');
                const [a, b] = await Promise.all([request.json(), derived.json()]);
                if (JSON.parse(a.body).value !== 'original' || a.headers['x-derived'] !== undefined || b.headers['x-derived'] !== 'only-derived') throw Error(JSON.stringify({ a, b }));
                return { assertions: 3 };
            }));
            await check('JSON replacement permits native multipart boundary and file bytes', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const reply = await avirx(origin).post('/upload').body({ stale: true }).multipart().field('title', '雪 upload').file('file', new Blob(['file-contents'], { type: 'text/plain' }), 'fixture.txt').json();
                const mime = reply.headers['content-type'];
                const boundary = /boundary=(.+)/.exec(mime)?.[1];
                if (!mime.startsWith('multipart/form-data;') || !boundary || !reply.body.includes(`--${boundary}`) || !reply.body.includes('fixture.txt') || !reply.body.includes('file-contents') || !reply.body.includes('雪 upload')) throw Error(JSON.stringify(reply));
                return { assertions: 6 };
            }));
            await check('explicit custom MIME remains caller owned through body replacement', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const reply = await avirx(origin).post('/echo').header('content-type', 'application/custom').body({ initial: true }).body('final').json();
                if (reply.headers['content-type'] !== 'application/custom' || reply.body !== 'final') throw Error(JSON.stringify(reply));
                return { assertions: 2 };
            }));
            await check('retry resolves refreshed auth each attempt and hook order', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                let providers = 0;
                const events = [];
                const data = await avirx(origin).auth.bearer(async () => ++providers === 1 ? 'stale-fixture-token' : 'refreshed-fixture-token')
                    .retry({ attempts: 1, on: [401] }).on('request', () => events.push('request')).on('response', () => events.push('response')).on('retry', () => events.push('retry')).get('/auth').json();
                if (!data.accepted || providers !== 2 || events.join(',') !== 'request,response,retry,request,response') throw Error(JSON.stringify({ data, providers, events }));
                return { assertions: 3 };
            }));
            await check('preview cURL and public state redact managed custom credentials', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const request = avirx(origin).auth.apiKey('x-fixture-secret', () => 'fixture-secret-123').get('/echo');
                const inspected = JSON.stringify([request.state, request.clientState, await request.preview(), await request.curl()]);
                const built = await request.build();
                if (inspected.includes('fixture-secret-123') || built.headers['x-fixture-secret'] !== 'fixture-secret-123' || !built.authenticated) throw Error('Credential redaction/build mismatch');
                return { assertions: 3 };
            }));
            await check('protected redirect never reaches second origin', async () => {
                const key = `${name}-redirect-blocked`;
                const data = await run(async ({ origin, other, key }) => {
                    const { avirx } = window.qualification;
                    const result = await avirx(origin).auth.apiKey('x-fixture-secret', () => 'fixture-only').get('/redirect').query({ to: `${other}/echo?key=${key}` }).result();
                    return { ok: result.ok, kind: result.error?.kind };
                }, { key });
                assert.deepEqual(data, { ok: false, kind: 'network' });
                assert.equal(counts.get(`echo:${key}`) ?? 0, 0);
                return { assertions: 3 };
            });
            await check('explicit trusted redirect transmits fixture credential to second origin', () => run(async ({ origin, other }) => {
                const { avirx } = window.qualification;
                const data = await avirx(origin, { allowCredentialRedirects: true }).auth.apiKey('x-fixture-secret', () => 'fixture-only').get('/redirect').query({ to: `${other}/echo` }).json();
                if (data.headers['x-fixture-secret'] !== 'fixture-only') throw Error(JSON.stringify(data));
                return { assertions: 1 };
            }));
            await check('native bearer redirect strips authorization across origins', () => run(async ({ origin, other }) => {
                const { avirx } = window.qualification;
                const data = await avirx(origin).auth.bearer(() => 'fixture-bearer').get('/redirect').query({ to: `${other}/echo` }).json();
                if (data.headers.authorization !== undefined) throw Error('Native transport leaked cross-origin Authorization');
                return { assertions: 1 };
            }));
            await check('same-origin public cache hit bypasses hooks and returns independent bytes', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                let hooks = 0;
                const api = avirx(origin).cache({ ttl: '5s' }).on('request', () => ++hooks);
                const request = api.get('/public').query({ key: `${engine}-public` });
                const first = await request.json();
                first.count = 9999;
                const second = await request.result();
                if (!second.ok || second.data.count !== 1 || hooks !== 1 || second.response.timing.durationMs !== 0) throw Error(JSON.stringify({ second, hooks }));
                return { assertions: 4 };
            }));
            await check('raw send never creates a new cache entry', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const request = avirx(origin).cache({ ttl: '5s' }).get('/public').query({ key: `${engine}-raw` });
                const raw = await request.send();
                const first = await raw.native.json();
                const second = await request.json();
                if (first.count !== 1 || second.count !== 2) throw Error(JSON.stringify({ first, second }));
                return { assertions: 2 };
            }));
            await check('CORS public responses bypass cache despite exposed Vary', () => run(async ({ other, engine }) => {
                const { avirx } = window.qualification;
                const request = avirx(other).cache({ ttl: '5s' }).get('/cors').query({ key: `${engine}-cors` });
                const [first, second] = [await request.json(), await request.json()];
                if (first.count !== 1 || second.count !== 2) throw Error(JSON.stringify({ first, second }));
                return { assertions: 2 };
            }));
            await check('browser cookie sessions and private responses never cache', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                await avirx(origin).get('/cookie').json();
                const request = avirx(origin).cache({ ttl: '5s' }).get('/private').query({ key: `${engine}-private` });
                const first = await request.json();
                const second = await request.json();
                if (!first.cookie.includes('qualification=fixture') || first.count !== 1 || second.count !== 2) throw Error(JSON.stringify({ first, second }));
                return { assertions: 3 };
            }));
            await check('auth policy prevents public-response caching', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const request = avirx(origin).cache({ ttl: '5s' }).auth.bearer(() => 'fixture-only').get('/public').query({ key: `${engine}-auth-cache` });
                const first = await request.json();
                const second = await request.json();
                if (first.count !== 1 || second.count !== 2) throw Error(JSON.stringify({ first, second }));
                return { assertions: 2 };
            }));
            await check('application mutation and explicit cache invalidation expose new version', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const key = `${engine}-mutation`;
                const api = avirx(origin).cache({ ttl: '5s' });
                const request = api.get('/public').query({ key });
                const before = await request.json();
                await api.post('/mutation').query({ key }).body({ change: true }).json();
                const cached = await request.json();
                api.state.cache.clear();
                const after = await request.json();
                if (before.version !== 0 || cached.version !== 0 || after.version !== 1) throw Error(JSON.stringify({ before, cached, after }));
                return { assertions: 3 };
            }));
            await check('fetch timeout classifies delayed response headers', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const result = await avirx(origin).timeout(10).get('/slow-headers').result();
                if (result.ok || result.error.kind !== 'timeout') throw Error(JSON.stringify(result));
                return { assertions: 2 };
            }));
            await check('fetch timeout ends at headers while slow body completes', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const result = await avirx(origin).timeout(1000).get('/slow-body').json();
                if (!result.ok) throw Error(JSON.stringify(result));
                return { assertions: 1 };
            }));
            await check('request signal cancellation remains attached to native streaming body', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const client = new AbortController();
                const request = new AbortController();
                const response = await avirx(origin).signal(client.signal).get('/stream').signal(request.signal).send();
                const reader = response.native.body.getReader();
                const first = await reader.read();
                request.abort(new Error('fixture request cancelled'));
                let rejected = false;
                try { while (!(await reader.read()).done) { /* drain buffered bytes until cancellation */ } }
                catch { rejected = true; }
                finally { await reader.cancel().catch(() => {}); }
                if (first.done || !rejected) throw Error('Native response body ignored request cancellation');
                return { assertions: 2 };
            }));
            await check('client signal cancellation classifies buffered body on current request', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const controller = new AbortController();
                const api = avirx(origin).signal(controller.signal).on('response', () => controller.abort(new Error('fixture client cancelled')));
                const result = await api.get('/stream').result();
                if (result.ok || result.error.kind !== 'aborted' || result.status !== 200 || !result.error.request.url.pathname.endsWith('/stream')) throw Error(JSON.stringify(result));
                return { assertions: 4 };
            }));
            await check('HEAD JSON and async schema transformation follow contract', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const request = avirx(origin).head('/head');
                const value = await request.json();
                const transformed = await request.as({ async parse(input) { if (input !== undefined) throw Error('HEAD supplied body'); return 'head-ok'; } });
                if (value !== undefined || transformed !== 'head-ok') throw Error('HEAD schema behavior mismatch');
                return { assertions: 3 };
            }));
            await check('HTTP decode and schema errors retain stable kinds', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const api = avirx(origin);
                const http = await api.get('/status').query({ code: 418 }).result();
                const decode = await api.get('/invalid').result();
                const validation = await api.get('/echo').result({ async parse() { throw Error('fixture validation'); } });
                if (http.ok || http.error.kind !== 'http' || http.status !== 418 || decode.ok || decode.error.kind !== 'decode' || validation.ok || validation.error.kind !== 'validation') throw Error(JSON.stringify({ http, decode, validation }));
                return { assertions: 7 };
            }));
            await check('user callback failures reject original value from result terminal', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const marker = { marker: 'fixture-hook' };
                let operationErrors = 0;
                let caught;
                try { await avirx(origin).on('request', () => { throw marker; }).on('error', () => ++operationErrors).get('/echo').result(); }
                catch (error) { caught = error; }
                if (caught !== marker || operationErrors !== 0) throw Error('Callback was wrapped or sent through operation error hooks');
                return { assertions: 2 };
            }));
            await check('download retains native bytes and available metadata', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const download = await avirx(origin).get('/file').download();
                if (download.status !== 200 || download.filename !== 'report-雪.bin' || download.contentType !== 'application/octet-stream' || await download.blob.text() !== 'download-雪' || download.contentLength !== new TextEncoder().encode('download-雪').byteLength) throw Error('Download metadata/bytes mismatch');
                return { assertions: 5 };
            }));
            await check('contract async input/output parsers execute through installed package', () => run(async ({ origin }) => {
                const { avirx, endpoint } = window.qualification;
                const api = avirx(origin).contract({ item: endpoint.get('/echo/{id}').params({ async parse(input) { return { id: `item-${input.id}` }; } }).returns({ async parse(input) { return new URL(input.url, origin).pathname; } }) });
                const output = await api.item({ path: { id: '雪' } });
                if (output !== '/echo/item-%E9%9B%AA') throw Error(String(output));
                return { assertions: 1 };
            }));
            await check('CORS-hidden Vary never reuses language-specific public bytes', () => run(async ({ other, engine }) => {
                const { avirx } = window.qualification;
                const key = `${engine}-hidden-vary`;
                const native = await fetch(`${other}/vary-language?hidden=1&key=${key}-probe`);
                const nativeType = native.type;
                const nativeVary = native.headers.get('vary');
                await native.text();
                if (nativeType !== 'cors' || nativeVary !== null) throw Error('Fixture did not create genuinely filtered CORS metadata');
                const request = avirx(other).cache({ ttl: '5s' }).get('/vary-language').query({ hidden: 1, key });
                const english = await request.header('accept-language', 'en').json();
                const french = await request.header('accept-language', 'fr').json();
                const englishAgain = await request.header('accept-language', 'en').json();
                if (english.language !== 'en' || french.language !== 'fr' || english.count !== 1 || french.count !== 2 || englishAgain.count !== 3) throw Error(JSON.stringify({ english, french, englishAgain }));
                return { assertions: 7 };
            }), 'B-026');
            await check('same-origin configured Vary retains separate language entries', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                let hooks = 0;
                const request = avirx(origin).cache({ ttl: '5s', vary: ['accept-language'] }).on('request', () => ++hooks)
                    .get('/vary-language').query({ key: `${engine}-configured-vary` });
                const english = await request.header('accept-language', 'en').json();
                const french = await request.header('accept-language', 'fr').json();
                const englishAgain = await request.header('accept-language', 'en').json();
                if (english.count !== 1 || french.count !== 2 || englishAgain.count !== 1 || englishAgain.language !== 'en' || hooks !== 2) throw Error(JSON.stringify({ english, french, englishAgain, hooks }));
                return { assertions: 5 };
            }), 'B-027');
            await check('same-origin unconfigured Vary bypasses cache instead of conflating languages', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const request = avirx(origin).cache({ ttl: '5s' }).get('/vary-language').query({ key: `${engine}-unconfigured-vary` });
                const english = await request.header('accept-language', 'en').json();
                const french = await request.header('accept-language', 'fr').json();
                const englishAgain = await request.header('accept-language', 'en').json();
                if (english.count !== 1 || french.count !== 2 || englishAgain.count !== 3 || english.language !== 'en' || french.language !== 'fr') throw Error(JSON.stringify({ english, french, englishAgain }));
                return { assertions: 5 };
            }), 'B-028');
            await check('native absent and explicitly empty Vary header fields stay distinct', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const emptyHeaders = new Headers([['x-variant', '']]);
                if (new Headers().has('x-variant') || !emptyHeaders.has('x-variant') || emptyHeaders.get('x-variant') !== '') throw Error('Native Headers presence precondition failed');
                let hooks = 0;
                const request = avirx(origin).cache({ ttl: '5s', vary: ['x-variant'] }).on('request', () => ++hooks)
                    .get('/vary-presence').query({ key: `${engine}-presence-vary` });
                const missing = await request.json();
                const empty = await request.headers(emptyHeaders).json();
                const missingAgain = await request.json();
                const emptyAgain = await request.header('x-variant', '').json();
                if (missing.present || missing.value !== null || !empty.present || empty.value !== '' || missing.count !== 1 || empty.count !== 2 || missingAgain.count !== 1 || emptyAgain.count !== 2 || hooks !== 2) throw Error(JSON.stringify({ missing, empty, missingAgain, emptyAgain, hooks }));
                return { assertions: 12 };
            }), 'B-029');
            await check('managed and known direct credentials reject mixed 302/307 chains before the next hop', async () => {
                const data = await run(async ({ origin, other, engine }) => {
                    const { avirx } = window.qualification;
                    const rows = [];
                    for (const code of [302, 307]) {
                        for (const mode of ['managed', 'known-direct']) {
                            const key = `${engine}-chain-blocked-${code}-${mode}`;
                            const terminal = `${other}/echo?key=${key}-terminal`;
                            const middle = `${origin}/redirect?code=${code === 302 ? 307 : 302}&key=${key}-middle&to=${encodeURIComponent(terminal)}`;
                            const api = mode === 'managed' ? avirx(origin).auth.apiKey('x-fixture-secret', () => 'FAKE-BROWSER-REVIEW-KEY') : avirx(origin).header('x-api-key', 'FAKE-BROWSER-REVIEW-KEY');
                            const result = await api.post('/redirect').query({ code, key, to: middle }).body({ payload: 'fixture' }).result();
                            if (result.ok || result.error.kind !== 'network') throw Error(`Protected ${code}/${mode} chain was not rejected`);
                            rows.push({ key, code, mode });
                        }
                    }
                    return rows;
                });
                for (const { key } of data) {
                    assert.equal(counts.get(`redirect:${key}`), 1);
                    assert.equal(counts.get(`redirect:${key}-middle`) ?? 0, 0);
                    assert.equal(counts.get(`echo:${key}-terminal`) ?? 0, 0);
                }
                return { assertions: data.length * 5 };
            }, 'B-030');
            await check('explicit trust follows complete 302/307 chains with native POST rewrite and fixture credentials', async () => {
                const data = await run(async ({ origin, other, engine }) => {
                    const { avirx } = window.qualification;
                    const rows = [];
                    for (const code of [302, 307]) {
                        const key = `${engine}-chain-optin-${code}`;
                        const terminal = `${other}/echo?key=${key}-terminal`;
                        const middle = `${origin}/redirect?code=${code === 302 ? 307 : 302}&key=${key}-middle&to=${encodeURIComponent(terminal)}`;
                        const response = await avirx(origin, { allowCredentialRedirects: true }).auth.apiKey('x-fixture-secret', () => 'FAKE-BROWSER-REVIEW-KEY')
                            .post('/redirect').query({ code, key, to: middle }).body({ payload: 'fixture' }).json();
                        if (response.method !== 'GET' || response.body !== '' || response.headers['x-fixture-secret'] !== 'FAKE-BROWSER-REVIEW-KEY') throw Error(JSON.stringify({ code, response }));
                        rows.push({ key, code });
                    }
                    return rows;
                });
                for (const { key } of data) {
                    assert.equal(counts.get(`redirect:${key}`), 1);
                    assert.equal(counts.get(`redirect:${key}-middle`), 1);
                    assert.equal(counts.get(`echo:${key}-terminal`), 1);
                }
                return { assertions: data.length * 6 };
            }, 'B-031');
            await check('sibling AvirxError callback failures retain identity across phases and every terminal', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const sibling = await avirx(origin).get('/status').query({ code: 503 }).result();
                if (sibling.ok || sibling.error.kind !== 'http' || sibling.status !== 503) throw Error('Sibling error precondition failed');
                let cases = 0;
                for (const phase of ['auth', 'request', 'response', 'retry', 'error']) {
                    for (const terminal of ['send', 'json', 'text', 'as', 'download', 'result']) {
                        let operationErrors = 0;
                        let api = avirx(origin).on('error', () => { ++operationErrors; if (phase === 'error') throw sibling.error; });
                        if (phase === 'auth') api = api.auth.bearer(() => { throw sibling.error; });
                        if (['request', 'response', 'retry'].includes(phase)) api = api.on(phase, () => { throw sibling.error; });
                        let request = api.get(phase === 'retry' || phase === 'error' ? '/status' : '/echo').query({ code: phase === 'retry' ? 503 : 418 });
                        if (phase === 'retry') request = request.retry({ attempts: 1, on: [503] });
                        let caught;
                        try { await (terminal === 'as' ? request.as({ parse: value => value }) : request[terminal]()); }
                        catch (error) { caught = error; }
                        if (caught !== sibling.error || operationErrors !== (phase === 'error' ? 1 : 0)) throw Error(`Callback identity/operation-hook mismatch: ${phase}/${terminal}`);
                        ++cases;
                    }
                }
                await sibling.response.native.body?.cancel().catch(() => {});
                return { assertions: cases * 2 + 3, cases };
            }), 'B-032');
            await check('abort during async auth preflight preserves sibling cause and current request without sibling status', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const sibling = await avirx(origin).get('/status').query({ code: 503 }).result();
                const controller = new AbortController();
                const request = avirx(origin).auth.bearer(async () => { await Promise.resolve(); controller.abort(sibling.error); return 'fixture-token'; })
                    .get('/echo').query({ key: 'preflight-victim' }).signal(controller.signal);
                const result = await request.result();
                if (result.ok || result.error === sibling.error || result.error.kind !== 'aborted' || result.error.cause !== sibling.error || result.error.request.url.pathname !== '/echo' || result.status !== undefined || result.response !== undefined) throw Error('Preflight cancellation inherited sibling metadata');
                await sibling.response.native.body?.cancel().catch(() => {});
                return { assertions: 7 };
            }), 'B-033');
            await check('native active-fetch sibling abort retains victim identity after server-confirmed dispatch', () => run(async ({ origin, engine }) => {
                const { avirx } = window.qualification;
                const sibling = await avirx(origin).get('/status').query({ code: 503 }).result();
                const key = `${engine}-fetch-sibling-abort`;
                const controller = new AbortController();
                const outcome = avirx(origin).get('/hold-headers').query({ key }).signal(controller.signal).result();
                const confirmation = await (await fetch(`${origin}/wait-observed?key=${key}`)).json();
                if (!confirmation.observed) throw Error('Victim fetch was never dispatched');
                controller.abort(sibling.error);
                const result = await outcome;
                if (result.ok || result.error === sibling.error || result.error.kind !== 'aborted' || result.error.cause !== sibling.error || result.error.request.url.pathname !== '/hold-headers' || result.status !== undefined || result.response !== undefined) throw Error('Native fetch cancellation inherited sibling metadata');
                await sibling.response.native.body?.cancel().catch(() => {});
                return { assertions: 8 };
            }), 'B-034');
            await check('buffered body sibling abort keeps current response status and original sibling cause', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const sibling = await avirx(origin).get('/status').query({ code: 503 }).result();
                const controller = new AbortController();
                let headersArrived;
                const headers = new Promise(resolveHeaders => { headersArrived = resolveHeaders; });
                let settled = false;
                const operation = avirx(origin).get('/hold-body').signal(controller.signal)
                    .on('response', () => headersArrived()).result().then(result => { settled = true; return result; });
                await headers;
                // A separate real HTTP roundtrip runs after the response hook has returned,
                // while JSON remains incomplete, so cancellation targets pending buffering.
                await (await fetch(`${origin}/echo?key=buffering-phase-barrier`)).json();
                if (settled) throw Error('Buffered operation completed before the cancellation phase barrier');
                controller.abort(sibling.error);
                const outcome = await operation;
                if (outcome.ok || outcome.error === sibling.error || outcome.error.kind !== 'aborted' || outcome.error.cause !== sibling.error || outcome.error.request.url.pathname !== '/hold-body' || outcome.status !== 200 || outcome.response?.status !== 200) throw Error('Buffered cancellation inherited sibling response');
                await sibling.response.native.body?.cancel().catch(() => {});
                await outcome.response?.native.body?.cancel().catch(() => {});
                return { assertions: 8 };
            }), 'B-035');
            await check('native Request serialization preserves final body and explicit versus inferred MIME transitions', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                let observation;
                const nativeTransport = async (input, init) => {
                    const request = new Request(input, init);
                    observation = { mime: request.headers.get('content-type'), body: await request.clone().text() };
                    return fetch(request);
                };
                const data = new FormData();
                data.append('label', '雪 native');
                data.append('file', new Blob(['file-data'], { type: 'text/plain' }), 'fixture.txt');
                const values = [
                    { name: 'text', body: 'final text', expected: 'final text', mime: 'text/plain;charset=UTF-8' },
                    { name: 'form', body: new URLSearchParams([['value', '雪 space']]), expected: 'value=%E9%9B%AA+space', mime: 'application/x-www-form-urlencoded;charset=UTF-8' },
                    { name: 'blob', body: new Blob(['blob-value'], { type: 'application/fixture-blob' }), expected: 'blob-value', mime: 'application/fixture-blob' },
                    { name: 'buffer', body: new TextEncoder().encode('buffer-value').buffer, expected: 'buffer-value', mime: null },
                    { name: 'multipart', body: data },
                    { name: 'null', body: null, expected: '', mime: null },
                    { name: 'undefined', body: undefined, expected: '', mime: null },
                ];
                let assertions = 0;
                for (const explicit of [undefined, 'application/fixture-explicit', '']) {
                    for (const item of values) {
                        let request = avirx(origin, { fetch: nativeTransport }).post('/echo').body({ stale: 'JSON inference must disappear' });
                        if (explicit !== undefined) request = request.header('content-type', explicit);
                        const reply = await request.body(item.body).json();
                        if ((reply.headers['content-type'] ?? null) !== observation.mime || reply.body !== observation.body) throw Error(`Native/wire mismatch ${item.name}/${String(explicit)}`);
                        assertions += 2;
                        if (explicit !== undefined) {
                            if (observation.mime !== explicit) throw Error(`Explicit MIME lost: ${item.name}/${explicit}`);
                        } else if (item.name === 'multipart') {
                            const boundary = /boundary=(.+)/.exec(observation.mime)?.[1];
                            if (!boundary || !observation.mime.startsWith('multipart/form-data;') || !observation.body.includes(`--${boundary}`) || !observation.body.includes('fixture.txt')) throw Error('Native multipart boundary/body mismatch');
                        } else if (observation.mime !== item.mime) throw Error(`Inferred/native MIME mismatch ${item.name}: ${observation.mime}`);
                        ++assertions;
                        if (item.expected !== undefined) { if (observation.body !== item.expected) throw Error(`Final body mismatch ${item.name}`); ++assertions; }
                    }
                }
                return { assertions, cases: values.length * 3 };
            }), 'B-036');
            await check('safe unusual placeholders preserve encoded bytes while unsafe grammar and dot segments reject', () => run(async ({ origin }) => {
                const { avirx } = window.qualification;
                const api = avirx(origin);
                let assertions = 0;
                let cases = 0;
                for (const name of ['constructor', '__proto__', 'toString', 'a.b', 'a:b', 'a-b', '雪']) {
                    for (const value of ['雪/../x', '%2e', '.', '..']) {
                        const request = api.get(`/guard/{${name}}/users/{id}`).path(Object.fromEntries([[name, value], ['id', '42']]));
                        if (value === '.' || value === '..') {
                            let rejected = false;
                            try { await request.build(); } catch { rejected = true; }
                            if (!rejected) throw Error(`Dot segment accepted for ${name}`);
                        } else {
                            const result = await request.json();
                            if (new URL(result.url, origin).pathname !== `/guard/${encodeURIComponent(value)}/users/42`) throw Error(`Unsafe target rewrite ${name}/${value}: ${result.url}`);
                        }
                        ++assertions;
                        ++cases;
                    }
                }
                for (const name of ['a/b', 'a\\b', 'a?b', 'a#b', '{a}', 'a b', 'a\tb', '', 'a\nb']) {
                    let rejected = false;
                    try { await api.get(`/guard/{${name}}/users/{id}`).path(Object.fromEntries([[name, 'safe'], ['id', '..']])).build(); }
                    catch { rejected = true; }
                    if (!rejected) throw Error(`Unsafe placeholder accepted: ${JSON.stringify(name)}`);
                    ++assertions;
                    ++cases;
                }
                return { assertions, cases };
            }), 'B-037');
            result.status = 'passed';
        } catch (error) {
            result.status = browser ? 'failed' : 'blocked';
            result.error = diagnostic(error);
            failed = true;
        } finally {
            result.cleanupErrors = [];
            for (const [target, resource] of [['context', context], ['browser', browser]]) {
                if (!resource) continue;
                try { await bounded(resource.close(), 5000, `${target} cleanup`); }
                catch (error) { result.cleanupErrors.push({ target, error: diagnostic(error) }); }
            }
            if (result.cleanupErrors.length) {
                result.status = 'failed';
                failed = true;
                result.error ??= 'Browser cleanup failed. See cleanupErrors for details.';
            }
            result.notRunChecks = result.plannedChecks - result.checks.length;
            result.notRunCheckIds = plannedCheckIds.filter(id => !result.checks.some(check => check.id === id));
            result.finishedAt = new Date().toISOString();
            await writeFile(resolve(repo, 'artifacts', `browser-${name}.json`), JSON.stringify(result, null, 2) + '\n');
            console.log(`${name}: ${result.status}; ${result.checks.filter(value => value.status === 'passed').length}/${result.checks.length} checks; ${result.assertions} assertions; browser ${result.browserVersion ?? 'unavailable'}`);
            if (result.error) console.error(result.error);
        }
    }
} finally {
    for (const timer of activeTimers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([first, second].map(closeFixture));
}
if (failed) process.exitCode = 1;
