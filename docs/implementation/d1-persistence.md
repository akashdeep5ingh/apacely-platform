# Slice 001 — Local D1 persistence hardening

## Authority and status

This is the separately authorized local D1 adaptation and hardening of Slice 001. Historical documentation-only prohibitions in `vertical-slice-001.md` are superseded only for this local work. No Cloudflare account mutation, database creation, deployment, Worker HTTP ingress, provider connection, credential, queue, workflow, outbox consumer or production activation is included. The Worker entrypoint exists only as an in-memory **test-only service-binding RPC** harness, with no `fetch` handler and no deployment configuration.

Qualification remains the synthetic `mock-qualification-v1` policy. Local execution is not staging/production verification, commercial eligibility evidence or authorization to activate anything.

## Shared acceptance boundary

`src/persistence.ts` defines `AcceptanceRepository`, `AcceptanceStore`, and `AcceptanceTarget`. One shared synchronous `accept()` routine owns semantic identity, strict source sequence ordering, normalization, qualification merging/evaluation, action selection and immutable outcome snapshots. The SQLite repository retains its synchronous transaction/API, CLI and mock consumer. D1 reads a coherent snapshot, runs the same callback synchronously, then submits one atomic write batch. No effects belong inside planning callbacks.

`Processor` captures trusted tenant/environment/source and validated input before queueing. It always supplies the exact `(source_binding, source_event_id, source_lead_id)` target to the repository, including every retry. Lifecycle validation is performed by the repository's acceptance unit, not a separate preliminary processor query. SQLite validates within its transaction; D1 validates inside its read batch and again inside its write batch.

## Bounded acceptance reads

The D1 processor path never loads tenant history and never falls back to the maintenance snapshot. One transactional read batch retrieves:

| Read | Scope and maximum rows |
| --- | --- |
| Active tenant | tenant primary key; 1 |
| Lead | tenant/source/source lead identity; 1 |
| Conversation | tenant/current lead/source, resolving the lead by an owned scalar subquery; 1 |
| Original event | tenant/source/source event identity, **independent of requested lead identity**; 1 |
| Current qualification | tenant/current lead, resolving the lead by an owned scalar subquery; 1 |
| Messages and action outbox | tenant-scoped constant-false queries; 0 |

Schema uniqueness enforces each one-row bound; the seven-result shape retains the synchronous store's six-table view without loading message/outbox history. All values are parameter-bound. Reading the event independently of the lead is essential: one event identity can contend across different per-lead queues. An identical duplicate returns its original JSON outcome without generating IDs or writing; changed semantic contents return `conflict` even if the caller requests another lead. Qualification and lead CAS expectations come from the same read batch, not separately awaited reads.

The low-level `repo.accept(scope, callback)` overload without a target is **trusted maintenance/testing only**, not a processor or untrusted access API. Its snapshot is capped at 100 rows per business table; queries request at most 101 rows to detect overflow. Overflow fails closed before the callback rather than silently planning against truncated state. Large tenants continue to use the exact processor path. `rows()` remains an intentionally history-sized diagnostic helper, not a bounded acceptance read: tenant activity and tenant-owned row retrieval occur in one atomic read batch. Inactive tenants cause `context`, even for an empty table. The row query also checks activity in SQL. Revocation after that coherent snapshot cannot retract data already read; the guarantee is activity at the snapshot boundary, not continuous authorization across arbitrary caller delays.

## Primary/session consistency contract

Pass the **original D1Database binding**, not a D1DatabaseSession or an adapter hiding a session. Per Cloudflare's documented API, without the Sessions API **all queries execute on the primary**, even when replication is enabled. This implementation deliberately never calls `withSession()` and uses that explicit primary policy for acceptance, diagnostics, retries and writes. The constructor rejects bindings exposing `getBookmark`, including both unconstrained and bookmarked session shapes. Structural wrappers used for instrumentation must forward the original primary binding; JavaScript shape checks cannot discover a wrapper deliberately concealing a session.

A session started with `first-primary` is **not** permanently primary: only its first query must use primary; later reads may use sequentially consistent replicas. Reusing such a session could still miss an independently committed lifecycle revocation. Sessions/bookmarks and unconstrained read replication are therefore unsupported here, not assumed safe. A future session implementation would require a fresh first-primary session for each coherent read unit plus reviewed lifecycle/replica tests; it is not enabled by this work.

Local tests assert no session is opened, reject injected session shapes, and exercise fresh primary rereads after transient failure and revocation. Miniflare 3 does **not** prove remote replication routing, bookmark guarantees or regional freshness; these are API-contract tests plus local transactional evidence, not distributed-replication emulator proof.

References: [D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 global read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).

## Atomic commit, ordering and retry policy

The write batch first asserts active tenant lifecycle in SQL. Lead advancement compares tenant, lead ID, captured version and last source sequence. The immediately following named CHECK assertion requires `changes() = 1`. Failure aborts the **entire batch**, including previous inserts/updates/outbox changes. A JavaScript check after batch success would be too late to roll back and is not used. Successful insert/delete assertions leave the internal assertion table empty. State, event, message, qualification, action intent and final immutable snapshot commit together. Composite FKs enforce tenant/lead/conversation/event ownership, including same-tenant wrong-parent protection.

The exact named CAS failure and scoped lead/event identity or lead/event sequence unique races become `LOCAL_VERSION_CONFLICT`; the processor rereads so the loser becomes replay or a typed conflict. Lifecycle revocation becomes `context` and never retries. Other constraints are not classified as optimistic races.

Only D1 database batch failures are normalized; callback/validation errors are not mistaken for transport failures. The allowlist requires a `D1_ERROR` envelope and exact documented transient details, supporting current prefixed messages and older `error.cause.message` envelopes. Cause traversal inspects at most four messages and must reach the end of the cause chain before transient classification. If a further cause remains at the bound or a cycle is encountered, the original error propagates without retry; an allowlisted prefix cannot hide a deeper permanent or unknown detail. Unknown or contradictory details fail closed. Allowed transient details are:

- `D1 DB reset because its code was updated.`
- `Internal error while starting up D1 DB storage caused object to be reset.`
- `Network connection lost.`
- `Replica disconnected from primary.`
- `Internal error in D1 DB storage caused object to be reset.`
- `Cannot resolve D1 DB due to transient issue on remote node.`
- `Can't read from request stream because client disconnected.`

Quota/storage limits, overload/timeout requiring query optimization, CPU/memory limits, SQL syntax/type errors, FK errors, validation/conflict/context failures and unfamiliar envelopes are nonretryable. The processor retains SQLite lock/version retries and adds only `D1_TRANSIENT`. A single configured budget of 0–3 retries (1–4 application attempts) covers the whole read/plan/write unit, with a short asynchronous yield. Exhaustion returns `retry_exhausted`, preserving the last failure as its Error `cause` (and the original D1 transport failure beneath the normalized `D1_TRANSIENT` cause). There is no nested application retry budget, no unlimited retry and no generic “all D1 errors are transient” rule. Cloudflare may separately retry read-only requests internally; the application budget does not count or control those provider-internal attempts.

A failed write response can be ambiguous after commit. Each retry starts by rereading the original event on primary. If the write actually succeeded, it returns the immutable outcome with no second state change or outbox action. Tests execute the real local write batch and then throw a transport error to demonstrate reconciliation, rather than assuming every error means rollback. If the response is lost on the final permitted attempt (including `maxRetries: 0`), the processor returns `retry_exhausted` without an extra reconciliation read; this does **not** prove rollback or absence of a committed event. A real-batch response-loss test verifies all six business rows, the immutable outcome and one pending outbox action remain committed, with no partial writes. A subsequent explicit replay returns that stored outcome without allocating IDs, changing rows or adding an action. Unknown failures propagate without blind automatic retry; a later explicit replay remains protected by durable identity.

References: [D1 debugging/error list and automatic retries](https://developers.cloudflare.com/d1/observability/debug-d1/), [D1 foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Worker compatibility and network boundary

`src/contracts.ts` uses native `globalThis.crypto.randomUUID()` for UUIDv4 and pinned portable `@noble/hashes` SHA-256 for synchronous fingerprints. The fixed canonical JSON array, qualification field order, UTF-8 encoding, null-versus-omitted semantics and hex digest are unchanged; there is no migration or changed historical fingerprint. Keeping hashing synchronous preserves SQLite's synchronous transaction API. Tests compare portable hashes against Node SHA-256 and native Worker Web Crypto for fixture, Unicode, null patches, block-boundary and larger inputs.

The dev-only esbuild harness bundles the shared contracts/evaluator/processor/D1 graph for a browser runtime, asserts its import graph excludes SQLite/Node modules, then executes real acceptance/update/replay/diagnostic reads and a retry timer through workerd service-binding RPC. There is no `nodejs_compat` flag, no Node global `Buffer`/`process` in the Worker, no fs/SQLite driver import, and no Worker HTTP ingress. Native Worker SHA-256 and generated UUIDs are verified inside workerd. This proves the bundled local runtime path, not a deployed service or production performance guarantee. Miniflare/esbuild/workerd remain dev-only; the portable hash library is a runtime dependency.

The original SQLite suite retains its fail-on-all-network guard. The isolated D1 suite permits only numeric `127.0.0.1`/`::1` transport and rejects external DNS/TLS/UDP/socket/fetch access. All workerd harnesses deny external requests through `outboundService`. Dependency installation/audit is a development operation, not a runtime network dependency. No Cloudflare credentials or external services are used by the local tests.

Reference: [Workers Web Crypto, SHA-256 and randomUUID](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).

## Local verification

```sh
npm test                 # SQLite/core, then D1 and Worker runtime suites
npm run test:sqlite      # fail-on-all-network suite
npm run test:d1          # local D1 plus workerd RPC; numeric loopback only
npm run typecheck
npm run build
npm run demo
npm audit
```

The D1 suite preserves existing insert/update rollback coverage after every write statement, all planning checkpoints, zero-row CAS, commit/read-time lifecycle checks, tenant isolation, FK ownership, immutable replay, independent adapters, bounded version retries and persistence restart. New coverage observes actual bounded read result sizes despite unrelated tenant history, diagnostic revocation, changed-fingerprint contention including another lead, session rejection/primary-only operations, seven transient details across read/write and current/legacy envelopes, nonretryable errors, bounded exhaustion and post-commit response loss. One harness change confines acceptance fault hooks to acceptance batches; diagnostic batches now use their own atomic path and must not accidentally trigger acceptance-write fault injection.

Vertical RED/GREEN observations for hardening: history-size test failed with 12–14 rows per table then passed with one-row identity bounds; diagnostic revocation failed with `Missing expected rejection` then passed; transient snapshot failure propagated `D1_ERROR: Network connection lost.` then passed on reread; injected sessions failed with `Missing expected exception` then were rejected; standalone activity-read test failed with `Separate acceptance read forbidden` then passed with batch lifecycle checks; maintenance overflow failed with `Missing expected rejection` then failed closed; conflicting error causes and planning exceptions initially became `retry_exhausted` then correctly propagated without retry; Worker bundling failed on `node:crypto` then passed real workerd RPC without Node compatibility. Existing concurrency/atomicity invariants were expanded with regression cases rather than replaced.

Review-blocker RED/GREEN: the three deep-cause regressions (fifth-message FK failure, fifth-message unknown detail and cyclic chain) first failed because the original errors were replaced by `retry_exhausted`; after completeness-aware bounded traversal they passed for both read and write batches, propagating the original error after one attempt with no writes. The final-attempt real-commit/response-loss test first failed because exhaustion discarded the normalized failure cause; preserving that cause made it pass, including explicit replay of the committed outcome and unchanged rows/IDs. The final rerun passed all 33 SQLite/core and 38 D1/runtime tests; standalone `npm run test:d1`, typecheck, build, demo, audit and whitespace checks also passed.

### Actual verification evidence

On Node `v20.20.2`, `npm test && npm run typecheck && npm run build && npm run demo && npm audit && git diff --check` exited 0:

- SQLite/core: **33 passed, 0 failed**, including all original 32 tests unchanged and one portable-crypto regression test.
- D1/runtime: **38 passed, 0 failed** (35 adapter tests, 2 transport-guard tests, 1 real workerd RPC test).
- Typecheck, build and diff whitespace check: passed. The original compiled schema/CLI test passed.
- CLI: `durable_verified: true`; one row per T1 business table, zero per T2, one mock receipt.
- Full dependency audit: **0 vulnerabilities**.

No commit, push, deployment, Cloudflare account mutation or live provider call was performed. Independent review/publication approval is separate from these local results.

## Remaining limitations

- No remote D1/replication/latency/limits/regional-placement verification, staging deployment, migration rollout or production activation was performed. Emulator results and documented consistency contracts do not prove those.
- Primary-only reads trade replica latency for current lifecycle safety. Session support is intentionally rejected. Untrusted/authenticated source resolution and reviewed environment bindings remain future ingress prerequisites.
- The trusted low-level store is not a public authorization API. Arbitrary direct maintenance or independent qualification writers need their own consistency contract; acceptance CAS assumes all business acceptance writes follow this shared path.
- Diagnostic history reads are activity-safe but still history-sized; any future dashboard/export must define pagination, row/payload limits and authorization instead of treating this test helper as production query policy. Acceptance row bounds do not set total byte limits for arbitrary large input text.
- D1 only commits pending provider-independent outbox intents. SQLite's existing mock `drain()` is unchanged. There is no D1 lease/ack consumer, external delivery, distributed exactly-once guarantee, HTTP handler or provider integration.
