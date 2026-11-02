# Independent suite review

Reviewed the separate consumer suite against Avirx's public compatibility, runtime, API and policy documents. This review examines harness validity and the meaning of results; it does not infer universal correctness from a green run.

## Findings sent to implementation owner

1. **Run provenance needs revalidation.** The original runner read `artifacts/candidate.json` but did not verify that the presently installed package still matched the recorded entry digest, metadata, or declaration set. Installing another dependency can remove or replace an unlisted candidate. Revalidate immediately before qualification entrypoints, and bind every machine report to the candidate SHA/integrity.
2. **Soak seed overrides initially did not vary cases.** The runner supplied `QUALIFICATION_SEED`, while both test suites originally used hardcoded seeds. Accept and validate that override, and print the actual seed and generated fixture in failures.
3. **Browser failures initially hid unexecuted checks.** A failed browser check stopped that engine and produced only the checks reached. Keep the complete plan and explicitly mark remaining checks `not-run`, or independently execute bounded checks and continue after cleanup. An unavailable browser is blocked, never passed.
4. **Report aggregation initially included its own previous output.** Exclude `summary.json` to prevent stale recursive nesting on repeated report commands.
5. **Connection disposal and concurrency/rate interaction need direct assertions.** The hook-order check alone does not exercise stale rate reservations behind a slow concurrency occupant. Add a real HTTP streaming-retry/response-hook-failure close observation, and a slow concurrency occupant followed by queued starts. These observations demonstrate specific cleanup behavior, not general absence of leaks.

Implementation may resolve these after this memo; current code and result records determine disposition.

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
