# Consumer coverage matrix

The contract authority is the baseline source's `docs/api.md`, `runtime.md`, `policies.md`, `compatibility.md`, and `review-pass-2026-11.md`. No `AGENTS.md`, `.agents/`, or `.codex/` instruction files were present in that source checkout. Tests use public package exports; expected results derive from declared contracts and independent native wire observations.

| Contract/risk | Independent checks | Layer |
| --- | --- | --- |
| Package identity and distribution | Build pinned clean source, npm pack/install, integrity and every packaged file hash, root exports/ESM/deep import rejection/zero runtime deps | candidate/provenance/compat |
| URLs | Base prefixes, absolute destinations, empty/query-only/root/slash counts, trailing slash, repeated query/replacement, unicode, encoded delimiters, reserved keys, exact path, dot values, malformed/control/whitespace/userinfo rejection | HTTP + browser + types |
| Immutability/body transitions | 8×8 JSON/text/form/bytes/blob/multipart/null/undefined replacements; MIME inference versus explicit MIME, native multipart boundary/bytes; attach/state/build/preview copies and stream single-use | HTTP + browser |
| Authentication and redirects | Refresh providers per attempt, bearer/basic/header/query, override, redacted state/preview/cURL, same/cross-origin custom-header protection, opt-in fake credential forwarding, native bearer stripping | HTTP + browser |
| Retry | Method safety, replayed immutable PUT, no POST/PATCH/multipart/stream replay, expected statuses, Retry-After zero, ordered hooks, retry/body cancellation and resource disposal | HTTP + policies + browser |
| Cancellation | Original reason/current request identity in preflight/queue/fetch/retry/body, signal composition, timeout through headers, raw body ownership | policies + browser |
| Admission | FIFO concurrency/rate queues, abort removal, capacity exhaustion/timeouts, no stale rate starts behind hooks or blocked concurrency, public live handles, cleanup | policies |
| Clocks | Cache TTL/rate behavior under wall-clock jumps; native response timing metadata separately checked | policies |
| Cache privacy | Explicit public requirement; auth/sensitive headers/request directives/cookies/Set-Cookie/private/no-store/no-cache/Vary-star/unconfigured Vary/partial bodies; browser CORS bypass and ambient cookies | policies + browser |
| Cache semantics | Six conditional/range fields including empty presence, both ordering directions; missing versus empty Vary; bounds/LRU/expiry/body limits/HEAD; hits bypass hooks/admission; send doesn't fill cache; native redirected URL metadata checked separately | policies + browser |
| Cache invalidation | Network and async output validation races, reusable builders/new generation, explicit set and shared handle behavior, real mutation-clear scenario | policies + browser |
| Terminals/error semantics | raw/json/text/download/HEAD/204/205/status overrides, metadata/filename/bytes, malformed/truncated/slow bodies, stable error kinds, callback failures unchanged across terminals | HTTP + policies + browser + compat |
| Schemas/contracts | Async input/output/error transforms and failure behavior, exact awaited path outputs, own non-enumerable keys, reserved then and symbol rejection, inference/common-builder helpers/unknown-property rejection | HTTP + browser + types |
| Custom transport | Supplied signal and redirect metadata; responsibility to honor transport behavior, public native resource ownership | policies |
| Actual application flows | Expired-token refresh, immutable multipart derivation, streaming cancellation, mutation with cache invalidation | HTTP + browser |
| Generative/repeatability | Bounded seeded unicode/path/query and policy interaction combinations, five seed lanes, named failures and bounded URL reducer when applicable | HTTP + policies + soak |
| Compatibility | Full Node22/24/26, basic Node18.17.0; strict TS5.0.4/5.9.3/7.0.2; Chromium/Firefox/WebKit native installed-bundle consumers | CI + local reports |
| cURL | Literal argv parser + execFile, exact local wire bytes/content type/empty headers/quoting; binary/multipart/NUL omission rules | HTTP |

Each row names exercised examples, not every permutation. Cache invalidation across every possible preflight stage, real clock suspension, Retry-After's 60-second clamp under real elapsed time, transport pool internals, every error body/MIME combination and memory retention under long-running production load remain bounded or partial coverage. Keep product unit/architecture/coverage/package release checks alongside this suite.
