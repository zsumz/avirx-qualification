# Avirx qualification

Independent consumer and end-to-end qualification of the **packed artifact built from pinned source**. This repository is private. It does not publish Avirx, change its source, or extend its support promises.

The baseline is `zsumz/avirx@1992ffba1b9fca800196b6fd8a0912cc8a9ddf16`, the merged stabilization candidate. Its package metadata is still `0.1.0`; the registry's older `avirx@0.1.0` is **not** an equivalent candidate. `candidate.json` is the baseline authority.

```sh
npm ci --ignore-scripts
npm run candidate
npm test
npx playwright install chromium firefox webkit
npm run test:browsers
npm run test:soak
npm run report
```

Node 22 or newer runs the harness. Candidate builds use the source lockfile and official build. The installed compatibility script separately runs on Node 18.17.0 in CI. TypeScript 5.0.4, 5.9.3 and current pinned 7.0.2 compile a strict installed consumer with positive and negative checks.

**Qualification is currently blocked by QF-001:** a documented `constructor` path parameter fails to compile on TypeScript 5.0.4. [Evidence and minimal reproduction](docs/findings.md). A failing qualification gate stays failing until the product changes or its contract changes explicitly.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run candidate` | Clone pinned source into ignored `.work/`, build, pack, install tarball, record hashes. |
| `npm run candidate -- --source /absolute/clean/checkout` | Build matching clean checkout without checking out or changing its tracked files. Reject dirty/untracked source inputs. |
| `npm run candidate -- --commit FULL_40_CHARACTER_SHA` | Deliberately test a candidate override; baseline file stays unchanged. |
| `npm test` | Fast Node real HTTP/policies, three compiler consumers, compatibility. |
| `npm run test:runtime` | Node real HTTP/policies and basic installed-package compatibility. |
| `npm run test:types` | All three compilers; known baseline failure is retained. |
| `npm run test:compat` | Runtime-floor script, directly usable on Node 18.17.0. |
| `npm run test:browser -- --browser=chromium` | One native engine; also accepts firefox/webkit. |
| `npm run test:browsers` | All three native engines, separately reported. |
| `npm run test:soak` | Five bounded seed lanes, complete deterministic suites each time. |
| `npm run qualify` | Fast suite plus all native engines. |
| `npm run report` | Combine current JSON reports into `artifacts/summary.json`. |

`QUALIFICATION_SEED=123 npm run test:runtime` reproduces generated cases. Seeds must be unsigned 32-bit integers. Test names contain the actual seed and case. The bounded seed suite exercises interaction diversity and repeatability; it is not a long-duration performance or memory stress claim. Failure fixtures are retained where a reducer applies; other failures use a named deterministic reproduction.

## Evidence and release gates

`artifacts/candidate.json` records the source commit/tree, tarball SHA-256 and SHA-512 integrity, packaged file list and hashes, package metadata, build Node/npm versions and platform. All entrypoints verify the installed package's files against the manifest before testing. Results record the candidate identity, runtime/compiler/browser versions, counts and failures. Generated artifacts are ignored; compact recorded execution evidence lives under `docs/results/`, and CI uploads complete artifacts for 14 days. Re-run rather than treating an old report as current qualification.

CI runs independent runtime lanes on Node 22/24/26, the Node 18.17.0 installed-package lane, a three-compiler lane, and native Chromium/Firefox/WebKit lanes. Failures remain visible independently. A manual workflow run optionally adds five seeds. Jobs are time-bounded and have read-only repository permissions; no secrets, paid services or external APIs are used by tests. Local fixtures bind only to loopback ephemeral ports and close sockets/timers/processes.

Before a release: require all runtime lanes, Node floor, TypeScript floor and release compiler, Chromium, and the bounded seed run on the **same candidate SHA**. Current TypeScript and Firefox/WebKit provide additional compatibility evidence; review any failures rather than expanding the product promise automatically. A blocked engine is incomplete qualification, never a pass. Product release checks remain required alongside this independent suite.

See [coverage and limits](docs/coverage.md), [findings](docs/findings.md), [independent suite review](docs/suite-review.md), and [execution evidence](docs/results/README.md).

## Boundaries

This is black-box evidence, not proof of every possible behavior. It imports only Avirx's public root export and serves the actual installed bundle to browsers. It does not duplicate the product's private unit suite. It tests HTTP/1.1 loopback, fake fixture credentials, deterministic failures, async callbacks, native fetch and a documented custom transport boundary. TLS/proxies/HTTP2, every OS/browser build, real authentication providers, real production servers and unbounded fuzzing are outside this run. No fragile latency throughput target or claim of leak freedom is inferred from socket cleanup. Browser native caches are controlled in fixtures to distinguish Avirx's cache behavior.
