# Qualification findings

Original merged baseline: `zsumz/avirx@1992ffba1b9fca800196b6fd8a0912cc8a9ddf16`. Current pinned draft candidate: `5b1df16e1c55ce9940b20f319529bea1291760fe`. Both are consumed as packed and installed packages. The embedded package version is `0.1.0`; this is the source candidate, not the older npm release.

## QF-001: `constructor` path parameters fail on the declared TypeScript floor

**Recommended severity:P2. Status: resolved on the pinned draft candidate only; unresolved on merged main.** This affects a documented supported path name at the documented TypeScript 5.0.4 compiler floor. The same valid consumer compiles on TypeScript 5.9.3 and current 7.0.2. Runtime behavior is not implicated by this finding.

Contract evidence: [supported compiler floor](https://github.com/zsumz/avirx/blob/1992ffba1b9fca800196b6fd8a0912cc8a9ddf16/docs/compatibility.md) and [reserved path names](https://github.com/zsumz/avirx/blob/1992ffba1b9fca800196b6fd8a0912cc8a9ddf16/docs/api.md).

The independent public-package consumer [repro-constructor.ts](../types/repro-constructor.ts) is:

```ts
import { avirx } from 'avirx';
const api = avirx('http://127.0.0.1:1');
api.get('/{constructor}').path({ constructor: 'value' });
```

To reproduce the original failure, run `npm ci --ignore-scripts`, then `npm run candidate -- --commit 1992ffba1b9fca800196b6fd8a0912cc8a9ddf16`. Run the following from the qualification repository:

```sh
node node_modules/typescript-minimum/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
node node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
node node_modules/typescript-current/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2022,DOM,DOM.Iterable types/repro-constructor.ts
```

On the merged baseline, the first command exits `2` with `TS2322: Type 'string' is not assignable to type 'string & Function'`. The second and third exit `0`. The ordinary `npm run test:types` gate keeps valid reserved-name cases. It fails on the baseline and passes on the fix; no expected-error suppression was added to valid input.

The declarations' exact-key generic interaction can be reproduced in plain TypeScript without Avirx:

```ts
type Params = Readonly<Record<'constructor', string>>;
declare function exact<const T extends Params>(
    value: T & Readonly<Record<Exclude<keyof T, 'constructor'>, never>>
): void;
exact({ constructor: 'value' });
```

Simple assignment to `Params` and a generic taking just `T` compile on 5.0.4; this exact-key intersection introduces the `Function` intersection for the inherited object key. This is evidence of a compiler inference interaction in the library's public declarations, rather than a runtime URL serialization defect. A product fix should preserve exact-key rejection and valid reserved names at the declared compiler floor; changing the compiler floor would alter the advertised compatibility boundary.

The product fix is isolated in [draft PR #2](https://github.com/zsumz/avirx/pull/2), commit `5b1df16e1c55ce9940b20f319529bea1291760fe`. It avoids the TypeScript 5.0.4 inference interaction when no extra keys exist while retaining rejection when they do. Product packed regressions cover12 reserved names and combinations; independent consumers cover the seven previously failing Object names, generic helpers, and 25 negative cases. TypeScript 5.0.4/5.9.3/7.0.2 all pass.

Restore the fixed candidate with `npm run candidate`, then run `npm test` and the browser/seed/review gates. The product's full release checks and [exact-headCI](https://github.com/zsumz/avirx/actions/runs/41366792658) pass. This is candidate validation, not evidence that the fix has merged. No version, tag or release was created.
