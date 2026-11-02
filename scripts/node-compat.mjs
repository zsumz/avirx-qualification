// Runs under the declared Node 18.17 floor, independently of the suite runner.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { avirx, endpoint, AvirxError, isAvirxError, parseWithSchema } from 'avirx';
import { assertCandidate } from './provenance.mjs';

const candidate = assertCandidate();
const cases = [];
const sockets = new Set();
const server = http.createServer(async (request, response) => {
    try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const url = new URL(request.url, 'http://local.invalid');
        if (url.pathname === '/download') {
            response.writeHead(200, { 'content-type': 'text/plain', 'content-length': 4, 'content-disposition': 'attachment; filename="test.txt"' });
            response.end('file');
        } else if (url.pathname === '/empty' || request.method === 'HEAD') {
            response.writeHead(request.method === 'HEAD' ? 200 : 204); response.end();
        } else if (url.pathname === '/status') {
            response.writeHead(418, { 'content-type': 'application/json' }); response.end('{"code":"teapot"}');
        } else {
            response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public', 'x-fixture': 'consumer' });
            response.end(JSON.stringify({ method: request.method, url: request.url, body, authorization: request.headers.authorization }));
        }
    } catch (error) { response.destroy(error); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
let timer;
async function check(name, run) {
    try { await run(); cases.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
    catch (error) { cases.push({ name, status: 'failed', error: error.stack ?? String(error) }); throw error; }
}
async function run() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = avirx(base);
    await check('installed ESM export and metadata boundary', async () => {
        const metadata = JSON.parse(await readFile(new URL('../node_modules/avirx/package.json', import.meta.url), 'utf8'));
        assert.equal(metadata.type, 'module');
        assert.deepEqual(Object.keys(metadata.exports), ['.']);
        assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
        assert.equal(typeof (await import('avirx')).formatCurl, 'function');
        await assert.rejects(import('avirx/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    });
    await check('native fetch JSON, encoded path, repeated query', async () => {
        const value = await api.get('/echo/{id}').path({ id: 'a/b ü' }).query({ page: 2, tag: ['a', 'b'] }).json();
        assert.equal(value.method, 'GET');
        assert.equal(value.url, '/echo/a%2Fb%20%C3%BC?page=2&tag=a&tag=b');
    });
    await check('JSON POST body and reusable builder', async () => {
        const original = { title: 'first' };
        const builder = api.post('/echo').body(original);
        original.title = 'changed';
        assert.equal((await builder.json()).body, '{"title":"first"}');
        assert.equal((await builder.json()).body, '{"title":"first"}');
    });
    await check('text and native raw response', async () => {
        const raw = await api.get('/echo').send();
        assert.equal(raw.headers['x-fixture'], 'consumer');
        assert.equal(raw.native instanceof Response, true);
        assert.equal((await raw.native.json()).method, 'GET');
        assert.equal(typeof await api.get('/echo').text(), 'string');
    });
    await check('HEAD and 204 undefined JSON', async () => {
        assert.equal(await api.head('/echo').json(), undefined);
        assert.equal(await api.get('/empty').json(), undefined);
    });
    await check('binary download metadata', async () => {
        const download = await api.get('/download').download();
        assert.equal(download.filename, 'test.txt');
        assert.equal(download.contentLength, 4);
        assert.equal(download.contentType, 'text/plain');
        assert.equal(await download.blob.text(), 'file');
    });
    await check('HTTP failure result and custom expected status', async () => {
        const outcome = await api.get('/status').result();
        assert.equal(outcome.ok, false);
        assert.equal(isAvirxError(outcome.error), true);
        assert.equal(outcome.error instanceof AvirxError, true);
        assert.equal(outcome.error.kind, 'http');
        assert.equal(outcome.status, 418);
        if (outcome.response?.native.body) await outcome.response.native.body.cancel();
        assert.equal((await api.get('/status').expect(418).json()).code, 'teapot');
    });
    await check('async schema and contract consumer', async () => {
        const schema = { async parse(input) { assert.equal(input.method, 'GET'); return { accepted: true }; } };
        assert.deepEqual(await api.get('/echo').as(schema), { accepted: true });
        const contract = api.contract({ get: endpoint.get('/echo/{id}').returns(schema) });
        assert.deepEqual(await contract.get({ path: { id: 'book' } }), { accepted: true });
        assert.equal(await parseWithSchema({ async parse(input) { return input + 1; } }, 1), 2);
    });
    await check('bearer auth refresh and inspection redaction', async () => {
        let sequence = 0;
        const authenticated = api.auth.bearer(() => `fixture-${++sequence}`);
        assert.equal((await authenticated.get('/echo').json()).authorization, 'Bearer fixture-1');
        assert.equal((await authenticated.get('/echo').json()).authorization, 'Bearer fixture-2');
        assert.equal((await authenticated.get('/echo').curl()).includes('fixture-'), false);
    });
    await check('shared public cache and hook ownership', async () => {
        let requests = 0;
        const cached = api.cache({ ttl: '1s' }).on('request', () => { requests++; });
        assert.deepEqual(await cached.get('/echo').json(), await cached.get('/echo').json());
        assert.equal(requests, 1);
        assert.equal(cached.state.cache.size(), 1);
        cached.state.cache.clear();
        await cached.get('/echo').json();
        assert.equal(requests, 2);
    });
}
let failure;
try {
    await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Node compatibility harness deadline (20s) exceeded')), 20_000); })]);
} catch (error) { failure = error; console.error(error); process.exitCode = 1; }
finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
    await writeFile(new URL(`../artifacts/node-compat-${process.versions.node}.json`, import.meta.url), `${JSON.stringify({
        generatedAt: new Date().toISOString(), node: process.version, platform: process.platform,
        candidateCommit: candidate.candidateCommit, integrity: candidate.package.integrity,
        nativeAbortSignalAny: typeof AbortSignal.any === 'function', status: failure ? 'failed' : 'passed',
        cases, failure: failure ? failure.stack ?? String(failure) : undefined,
        boundary: 'Basic installed-package compatibility; policies requiring native AbortSignal.any are exercised in full lanes.',
    }, null, 2)}\n`);
}
