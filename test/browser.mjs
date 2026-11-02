import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { assertCandidate } from '../scripts/provenance.mjs';

// Native browser consumers import only the installed artifact's public entrypoint.
// Browser-engine qualification does not change Avirx's documented support promise.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = assertCandidate();
const playwrightVersion = JSON.parse(await readFile(resolve(repo, 'node_modules/playwright/package.json'), 'utf8')).version;
const packageRoot = dirname(fileURLToPath(import.meta.resolve('avirx')));
const engines = { chromium, firefox, webkit };
const selected = process.argv.includes('--all')
    ? Object.keys(engines)
    : [(process.argv.find(value => value.startsWith('--browser=')) ?? '--browser=chromium').split('=')[1]];
if (selected.some(name => !engines[name])) throw new Error('Use --browser=chromium|firefox|webkit or --all');
const counts = new Map();
const versions = new Map();
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
        res.writeHead(302, { location: url.searchParams.get('to') }); res.end(); return;
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

const first = await fixture();
const second = await fixture();
await mkdir(resolve(repo, 'artifacts'), { recursive: true });
let failed = false;

try {
    for (const name of selected) {
        const result = { engine: name, status: 'running', node: process.version, browserVersion: null,
            playwrightVersion, candidateCommit: candidate.candidateCommit,
            packageIntegrity: candidate.package.integrity,
            platform: process.platform, plannedChecks: 25, checks: [], assertions: 0,
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
            const check = async (title, task) => {
                const began = performance.now();
                try {
                    const evidence = await bounded(task(), 8000, title);
                    result.assertions += evidence?.assertions ?? 1;
                    result.checks.push({ name: title, status: 'passed', durationMs: Math.round(performance.now() - began), ...evidence });
                } catch (error) {
                    result.checks.push({ name: title, status: 'failed', error: String(error.stack ?? error) });
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
            result.status = 'passed';
        } catch (error) {
            result.status = browser ? 'failed' : 'blocked';
            result.error = String(error.stack ?? error);
            failed = true;
        } finally {
            await bounded(context?.close() ?? Promise.resolve(), 5000, 'context cleanup').catch(() => {});
            await bounded(browser?.close() ?? Promise.resolve(), 5000, 'browser cleanup').catch(() => {});
            result.notRunChecks = result.plannedChecks - result.checks.length;
            result.finishedAt = new Date().toISOString();
            await writeFile(resolve(repo, 'artifacts', `browser-${name}.json`), JSON.stringify(result, null, 2) + '\n');
            console.log(`${name}: ${result.status}; ${result.checks.filter(value => value.status === 'passed').length}/${result.checks.length} checks; ${result.assertions} assertions; browser ${result.browserVersion ?? 'unavailable'}`);
            if (result.error) console.error(result.error);
        }
    }
} finally {
    for (const timer of activeTimers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await Promise.all([first.server, second.server].map(server => new Promise(resolveClose => server.close(resolveClose))));
}
if (failed) process.exitCode = 1;
