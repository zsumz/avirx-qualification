# Qualification findings

Candidate: `zsumz/avirx@1992ffba1b9fca800196b6fd8a0912cc8a9ddf16`, consumed as a packed and installed package. The embedded package version is `0.1.0`; this is the source candidate, not the older npm release.

## QF-001: `constructor` path parameters fail on the declared TypeScript floor

**Recommended severity: P2. Status: reproduced, unresolved.** This affects a documented supported path name at the documented TypeScript 5.0.4 compiler floor. The same valid consumer compiles on TypeScript 5.9.3 and current 7.0.2. Runtime behavior is not implicated by this finding.

Contract evidence: [supported compiler floor](https://github.com/zsumz/avirx/blob/1992ffba1b9fca800196b6fd8a0912cc8a9ddf16/docs/compatibility.md) and [reserved path names](https://github.com/zsumz/avirx/blob/1992ffba1b9fca800196b6fd8a0912cc8a9ddf16/docs/api.md).

The independent public-package consumer [repro-constructor.ts](../types/repro-constructor.ts) is:

```ts
import { avirx } from 'avirx';
const api = avirx('http://127.0.0.1:1');
api.get('/{constructor}').path({ constructor: 'value' });
```

After `npm ci` and `npm run candidate`, run from the qualification repository:

```sh
node node_modules/typescript-minimum/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
node node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
node node_modules/typescript-current/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
```

The first command exits `2` with `TS2322: Type 'string' is not assignable to type 'string & Function'`. The second and third exit `0`. The ordinary `npm run test:types` gate also keeps the valid reserved-name case and fails for the minimum compiler; no expected-error suppression was added.

The declarations' exact-key generic interaction can be reproduced in plain TypeScript without Avirx:

```ts
type Params = Readonly<Record<'constructor', string>>;
declare function exact<const T extends Params>(
    value: T & Readonly<Record<Exclude<keyof T, 'constructor'>, never>>
): void;
exact({ constructor: 'value' });
```

Simple assignment to `Params` and a generic taking just `T` compile on 5.0.4; this exact-key intersection introduces the `Function` intersection for the inherited object key. This is evidence of a compiler inference interaction in the library's public declarations, rather than a runtime URL serialization defect. A product fix should preserve exact-key rejection and valid reserved names at the declared compiler floor; changing the compiler floor would alter the advertised compatibility boundary.

No product source was changed. Until resolved and requalified, the comprehensive gate reports failure rather than certifying the candidate without qualification.
