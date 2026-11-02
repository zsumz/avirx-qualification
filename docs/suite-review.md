# Independent suite review

Reviewed the separate consumer suite against Avirx's public compatibility, runtime, API and policy documents. This review examines harness validity and the meaning of results; it does not infer universal correctness from a green run.

## Review dispositions

| Finding | Final review disposition |
| --- | --- |
| Installed candidate provenance could drift after preparation | Resolved: every test entrypoint verifies metadata and SHA-256 of every packaged file, including declarations, against the candidate manifest. Machine reports retain the source SHA and tarball integrity. |
| Soak seed overrides repeated identical cases | Resolved: both suites validate the unsigned 32-bit override and report the actual seed/fixture. The HTTP differential includes a bounded string reducer for semantic mismatches. |
| Browser fail-fast omitted unexecuted coverage | Resolved: each engine records 25 planned checks and an explicit `notRunChecks` count; unavailable launch is blocked and fails the command. |
| Report aggregation recursively included prior summary | Resolved: the aggregation excludes its own output. |
| Disposal and blocked-concurrency/rate interaction lacked direct observations | Resolved: real unfinished responses must close after retry/hook rejection, and queued requests cannot reserve stale starts behind a held concurrency occupant. |
| Fresh default candidate bootstrap checked a no-checkout clone as dirty | Resolved: preparation now makes a populated clone before cleanliness checks. The owner successfully exercised a fresh default clone/build/pack/install; `artifacts/bootstrap.log` records that run. |

Final CI inspection found read-only repository permissions, pinned official actions, explicit quoted candidate input, separate runtime/compiler/browser lanes and job deadlines. The Node 18.17 compatibility entrypoint and provenance helper use floor-compatible syntax/APIs and avoid policies requiring unavailable native signal composition.

Coverage claims were narrowed to the observed wall-clock-jump checks for TTL/rate and ordinary response metadata. Redirected cache-hit final-URL preservation and response-duration clock-jump interactions remain partial coverage rather than implied passes.

## Strengths and evidence boundaries

- Tests import the installed root export and serve the actual packed ESM browser entry. They do not import private implementation modules.
- Real loopback HTTP, different origins, native multipart boundaries, native redirects and browser cookie/CORS behavior exercise risks that mocked transport tests cannot establish.
- Table-driven body transitions and conditional cache permutations are useful finite checks. Seeded cases remain bounded and reproducible; they are not exhaustive fuzzing.
- Frozen/read-only snapshots, preflight contracts, callback rejection identity, current-request abort attribution, and TypeScript negative cases check observable supported APIs.
- Tracked server sockets and timers, runner process-group deadlines, browser-context closure and explicit caller-owned body cancellation provide bounded cleanup. A killed or timed-out run must fail rather than qualify.
- Node 18.17 compatibility is a deliberate basic subset because policies requiring native `AbortSignal.any` have a separate documented API requirement. Do not label it a full floor-runtime policy run.
- Compiler 5.0.4, product compiler 5.9.3 and current compiler checks are distinct. Compiler failures require isolation before being called product defects.

## Remaining limits

No suite proves every possible timing interleaving, proxy/TLS/network behavior, platform, browser release or resource-lifetime property. This suite deliberately uses local synthetic data, finite body sizes and bounded delays. A single pass on Firefox/WebKit does not broaden Avirx's declared browser support. Socket-close probes do not establish no memory/socket leak under arbitrary workloads. Performance thresholds need measured baselines before they become release gates.
