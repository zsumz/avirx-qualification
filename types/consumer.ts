// Installed-package consumer. This file is compiled, never executed.
// Negative cases must keep producing a compiler diagnostic on every compiler.
import {
    avirx, endpoint, parseWithSchema, AvirxError, isAvirxError, formatCurl,
    type AvirxSchema, type AvirxRequestBuilder, type AvirxBuiltRequest,
    type AvirxInferSchema, type AvirxContractInput, type AvirxContractOutput,
    type AvirxErrorKind, type AvirxResponse, type AvirxResult,
} from 'avirx';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const api = avirx('http://127.0.0.1:1/base/');
const book = {
    async parse(input: unknown): Promise<{ id: string; title: string }> {
        const value = input as { id: string; title: string };
        return { id: value.id, title: value.title };
    },
};
type AsyncOutput = Expect<Equal<AvirxInferSchema<typeof book>, { id: string; title: string }>>;

const read = api.get('/books/{id}').path({ id: 'café' }).query({ include: ['author', 'reviews'] });
const reserved = api.get('/{constructor}/{__proto__}/{用户.id}').path({
    constructor: 'a', ['__proto__']: 'b', '用户.id': 'c',
});
// TS-RESERVED: inherited Object names are valid own path keys at the compiler floor.
api.get('/{toString}').path({ toString: 'value' });
api.get('/{valueOf}').path({ valueOf: 'value' });
api.get('/{hasOwnProperty}').path({ hasOwnProperty: 'value' });
api.get('/{isPrototypeOf}').path({ isPrototypeOf: 'value' });
api.get('/{propertyIsEnumerable}').path({ propertyIsEnumerable: 'value' });
api.get('/{toLocaleString}').path({ toLocaleString: 'value' });
api.get('/{constructor}').path({ constructor: 'value' });
api.get('/{__proto__}').path({ ['__proto__']: 'value' });
const inheritedKeys = { constructor: 'one', toString: 'two', valueOf: 'three' };
api.get('/{constructor}/{toString}/{valueOf}').path(inheritedKeys);
// @ts-expect-error TS-EXACT-RESERVED: inherited names do not permit an extra own key.
api.get('/{constructor}').path({ constructor: 'value', extra: 'value' });
const reservedExtra = { toString: 'value', extra: 'value' };
// @ts-expect-error TS-EXACT-RESERVED-VARIABLE: extra keys on a variable also reject.
api.get('/{toString}').path(reservedExtra);
const pathSymbol = Symbol('path');
// @ts-expect-error TS-EXACT-SYMBOL: a symbol does not silently evade exact path keys.
api.get('/{constructor}').path({ constructor: 'value', [pathSymbol]: 'extra' });
// @ts-expect-error Missing exact path key.
api.get('/{id}/{edition}').path({ id: 'a' });
// @ts-expect-error Extra exact path key from a literal.
api.get('/{id}').path({ id: 'a', edition: 1 });
const extraParams = { id: 'a', edition: 1 };
// @ts-expect-error Extra path keys from a variable must also reject.
api.get('/{id}').path(extraParams);
// @ts-expect-error No body operation exists on a concrete GET builder.
api.get('/books').body({ title: 'x' });
// @ts-expect-error No multipart operation exists on a concrete HEAD builder.
api.head('/books').multipart();
// @ts-expect-error Unknown builder fields are not silently admitted.
api.post('/books').nonexistent;
// @ts-expect-error Unknown templated builder fields are not silently admitted.
read.nonexistent;
// @ts-expect-error Client state snapshots are readonly.
api.state.timeoutMs = 1;
// @ts-expect-error Request state snapshots are readonly.
read.state.route = '/changed';

function commonHelper(request: AvirxRequestBuilder) {
    return request.header('accept', 'application/json').timeout(false).preview();
}
commonHelper(api.get('/books'));
commonHelper(api.head('/books/{id}').path({ id: 'a' }));
commonHelper(api.post('/books/{id}').path({ id: 'a' }).body({ value: 1 }));
function bodyHelper<Route extends string>(request: AvirxRequestBuilder<Route, true>) {
    return request.body({ title: 'x' });
}
bodyHelper(api.post('/books'));
bodyHelper(api.put('/books/{id}').path({ id: 2 }));
// @ts-expect-error A body helper cannot accept GET.
bodyHelper(api.get('/books'));

const transformedQuery: AvirxSchema<{ limit: number }, { limit: string }> = {
    parse(input) { return { limit: Number(input.limit) }; },
};
const asyncParams = {
    async parse(input: { publicId: number }) { return { id: String(input.publicId) }; },
};
const createBody = {
    async parse(input: { rawTitle: string }) { return { title: input.rawTitle.trim() }; },
};
const getDefinition = endpoint.get('/books/{id}').params(asyncParams).query(transformedQuery).returns(book);
const createDefinition = endpoint.post('/books').body(createBody).returns(book);
const routes = api.contract({
    get: getDefinition,
    create: createDefinition,
    exists: endpoint.head('/books/{id}'),
    remove: endpoint.delete('/books/{id}'),
});
type Input = Expect<Equal<AvirxContractInput<typeof getDefinition>['path'], { publicId: number }>>;
type Output = Expect<Equal<AvirxContractOutput<typeof getDefinition>, { id: string; title: string }>>;
const getOutput: Promise<{ id: string; title: string }> = routes.get({
    path: { publicId: 12 }, query: { limit: '10' },
});
const createOutput: Promise<{ id: string; title: string }> = routes.create({ body: { rawTitle: ' x ' } });
const headOutput: Promise<undefined> = routes.exists({ path: { id: '12' } });
// @ts-expect-error Contract input uses the parser's input type, not transformed output.
routes.get({ path: { id: '12' }, query: { limit: 10 } });
// @ts-expect-error Query schema input is required.
routes.get({ path: { publicId: 12 } });
// @ts-expect-error Body schema input is required.
routes.create({});
// @ts-expect-error Contract HEAD has no body input.
routes.exists({ path: { id: '12' }, body: {} });
// @ts-expect-error Unknown contract calls are rejected.
routes.nonexistent({});
// @ts-expect-error Reserved then is rejected at definition.
api.contract({ then: endpoint.get('/books') });
const symbolKey = Symbol('endpoint');
// @ts-expect-error Symbol keys cannot disappear silently from a contract.
api.contract({ [symbolKey]: endpoint.get('/books') });
// @ts-expect-error Async path schema outputs must contain exactly the route keys.
endpoint.get('/books/{id}').params({ async parse() { return { id: 'a', extra: 'b' }; } });
// @ts-expect-error Path schema cannot omit required keys.
endpoint.get('/books/{id}/{edition}').params({ parse() { return { id: 'a' }; } });
// @ts-expect-error GET endpoint definitions cannot accept body schemas.
endpoint.get('/books').body(createBody);

const legacyParser = { parse(_value: unknown) { return { limit: 3 }; } };
const legacy = api.contract({ list: endpoint.get('/books').query(legacyParser) });
legacy.list({ query: { limit: 2 } });
// @ts-expect-error An unknown-input legacy parser uses its output shape at the caller.
legacy.list({ query: { limit: '2' } });

async function terminalAndHandles() {
    const parsed: { id: string; title: string } = await read.as(book);
    const raw: AvirxResponse = await read.send();
    const asserted: { arbitrary: boolean } = await read.json<{ arbitrary: boolean }>();
    const direct: Promise<{ id: string; title: string }> = parseWithSchema(book, {});
    const result = await read.error({ async parse() { return { code: 'missing' }; } }).result(book);
    if (result.ok) {
        const title: string = result.data.title;
        const response: AvirxResponse<{ id: string; title: string }> = result.response;
    } else {
        const code: string | undefined = result.error.data?.code;
        const kind: AvirxErrorKind = result.error.kind;
        const original: unknown = result.error.cause;
    }
    const headResult: AvirxResult<undefined> = await routes.exists.result({ path: { id: 'a' } });
    const inspected: AvirxBuiltRequest = await reserved.build();
    const authenticated: boolean = inspected.authenticated;
    const snapshot: URL = inspected.url;
    const state = read.clientState;
    const cacheApi = api.cache({ ttl: '1s', maxEntries: 3, maxTotalBytes: 1024 });
    const cache = cacheApi.state.cache;
    if (cache) {
        const allowed: boolean = cache.canCacheRequest(inspected);
        const cached: AvirxResponse | undefined = cache.get(inspected);
        await cache.set(inspected, raw);
        const count: number = cache.size();
        cache.clear();
    }
    const admitted = api.concurrency(1).rateLimit({ requests: 1, per: '1s' });
    const limiter = admitted.state.concurrency;
    if (limiter) {
        const release: () => void = await limiter.acquire();
        const active: number = limiter.active();
        const queued: number = limiter.queued();
        release();
    }
    if (admitted.state.rateLimit) {
        await admitted.state.rateLimit.acquire(inspected);
        const starts: number = admitted.state.rateLimit.starts();
    }
    const curl: string = formatCurl(inspected);
    const guarded: boolean = isAvirxError(new AvirxError('consumer example', { request: inspected }));
}

const allErrorKinds: readonly AvirxErrorKind[] = [
    'aborted', 'timeout', 'network', 'http', 'decode', 'validation',
    'queue-full', 'queue-timeout', 'unknown',
];
// @ts-expect-error Error kinds reject invented discriminator strings.
const invalidKind: AvirxErrorKind = 'cancelled';
