import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { avirx, endpoint } from 'avirx';
import { assertCandidate } from '../scripts/provenance.mjs';
assertCandidate();
const opts = { timeout: 8_000 };
async function fixture(t) {
 const sockets = new Set(); const observed = [];
 const server = http.createServer((request, response) => {
  observed.push(request.url);
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ key: decodeURIComponent(new URL(request.url, 'http://local.invalid').pathname.slice(1)) }));
 });
 server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
 await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
 t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
 return { api: avirx(`http://127.0.0.1:${server.address().port}`), observed };
}
const ownKeys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'name', 'length', 'prototype'];
for (const enumerable of [true, false]) {
 test(`KEYS-OWN-${enumerable ? 'ENUM' : 'HIDDEN'} reserved own contract names remain callable without prototype mutation`, opts, async t => {
  const { api, observed } = await fixture(t);
  const definitions = Object.create(null);
  for (const key of ownKeys) Object.defineProperty(definitions, key, { value: endpoint.get(`/${encodeURIComponent(key)}`), enumerable });
  const originalObjectPrototype = Object.getOwnPropertyNames(Object.prototype);
  const contract = api.contract(definitions);
  assert.equal(await Promise.resolve(contract), contract, 'valid contract must not become a thenable');
  assert.equal(observed.length, 0, 'Promise assimilation must not dispatch');
  for (const key of ownKeys) {
   assert(Object.hasOwn(contract, key), `${key} must be an own endpoint`);
   assert.equal((await contract[key]({})).key, key);
   const result = await contract[key].result({});
   assert.equal(result.ok, true); assert.equal(result.data.key, key);
  }
  assert.equal(observed.length, ownKeys.length * 2);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype), originalObjectPrototype);
 });
}
for (const enumerable of [true, false]) {
 test(`KEYS-THEN-${enumerable} reserved then rejects before Promise assimilation and transport`, opts, async t => {
  const { api, observed } = await fixture(t);
  const definitions = Object.create(null);
  Object.defineProperty(definitions, 'then', { value: endpoint.get('/unintended'), enumerable });
  assert.throws(() => api.contract(definitions));
  assert.equal(observed.length, 0);
 });
 test(`KEYS-SYMBOL-${enumerable} own symbols reject rather than disappear`, opts, async t => {
  const { api, observed } = await fixture(t);
  const definitions = { safe: endpoint.get('/safe') };
  Object.defineProperty(definitions, Symbol('hidden-endpoint'), { value: endpoint.get('/unintended'), enumerable });
  assert.throws(() => api.contract(definitions)); assert.equal(observed.length, 0);
 });
}
test('KEYS-INHERITED only own endpoint strings are included', opts, async t => {
 const { api, observed } = await fixture(t);
 const definitions = Object.create({ inheritedFixture: endpoint.get('/unintended') });
 definitions.own = endpoint.get('/own');
 const contract = api.contract(definitions);
 assert.equal(Object.hasOwn(contract, 'inheritedFixture'), false);
 assert.equal(contract.inheritedFixture, undefined);
 assert.equal((await contract.own({})).key, 'own');
 assert.deepEqual(observed, ['/own']);
});
test('KEYS-ASYNC-PATH awaited extra schema output keys reject before dispatch', opts, async t => {
 const { api, observed } = await fixture(t);
 const sentinel = new Error('fixture-input-parser');
 const invalid = api.contract({
  extra: endpoint.get('/{id}').params({ async parse() { return { id: 'safe', extra: 'forbidden' }; } }),
  missing: endpoint.get('/{id}').params({ async parse() { return {}; } }),
  rejects: endpoint.get('/{id}').params({ async parse() { throw sentinel; } }),
 });
 await assert.rejects(invalid.extra({ path: {} }));
 await assert.rejects(invalid.extra.result({ path: {} }));
 await assert.rejects(invalid.missing({ path: {} }));
 await assert.rejects(invalid.rejects.result({ path: {} }), error => error === sentinel);
 assert.equal(observed.length, 0);
});
