# Slice 001 — Local D1 persistence

## Authority and status

This implements the separately authorized local D1 adaptation of Slice 001. The documentation-only prohibitions in `vertical-slice-001.md` describe the historical phase; this authorization supersedes them only for this local persistence work. No Cloudflare account, database, Worker ingress, deployment, UI, provider connection, credential, queue, workflow or production activation was created. The only emulator script is an in-memory test harness required by Miniflare, not an ingress implementation or deployed Worker.

Qualification remains the synthetic `mock-qualification-v1` policy. Local execution is not staging/production verification or commercial eligibility evidence.

## Shared acceptance boundary

`src/persistence.ts` defines `AcceptanceRepository`, `AcceptanceStore`, and the shared row/table types. `Processor` depends on these contracts, not SQLite. Its one shared `accept()` function owns identity/fingerprint handling, strict sequence ordering, normalization, qualification merging/evaluation, action selection and the immutable outcome snapshot. There is no second D1 processing implementation.

The existing `Repository` implements the contract using its synchronous SQLite transaction and scoped repository. Its existing API, mock outbox consumer and CLI remain usable. `D1Repository` takes a structural D1 binding (`prepare`, prepared statement operations, `batch`); it has no Cloudflare SDK dependency. Miniflare/workerd is dev-only.

The acceptance callback is synchronous: the D1 adapter runs it against an in-memory read/plan view, then awaits the atomic batch. Effects do not belong in this callback. Trusted tenant/environment and source binding are captured before asynchronous execution; mutation of caller-owned scope/context cannot redirect later reads, writes or output identities.

## D1 atomicity, sequencing and replay

1. Validate the input and trusted development binding. Confirm the tenant is active.
2. Fetch the active tenant and tenant-filtered business rows in one transactional read batch. This avoids mixing qualification from one revision with a lead version from another. A duplicate returns its original JSON outcome without generating IDs, touching current state or submitting a write batch. Changed semantic contents under the same identity are a typed conflict.
3. Run shared acceptance against that snapshot, accumulating parameter-bound SQL rather than issuing provisional writes. A thrown planning checkpoint submits no writes.
4. Execute one atomic D1 write batch. Its first SQL assertion requires the tenant still to be active. Lead advancement compares the captured tenant, lead ID, version and last source sequence. The immediately following SQL assertion checks `changes() = 1`.
5. A failed named CHECK constraint aborts the *entire batch*, including statements preceding the failing assertion. Checking affected rows in JavaScript after a successful batch would be too late and is deliberately not used. `acceptance_assertions` is an internal assertion table added idempotently in the shared schema; successful batches insert/delete their assertions and leave no rows.
6. CAS failures and the exact tenant-scoped lead/event identity or event-sequence unique races become `LOCAL_VERSION_CONFLICT`. The shared processor retries the whole read/plan/write unit with its configured budget (0–3 retries). After rereading, a loser becomes an identical replay or a typed identity/sequence conflict. Other constraint failures are not reclassified or retried. IDs allocated by a losing plan are discarded; an already persisted duplicate consumes none.

D1 batch execution, not `BEGIN`/interactive transactions, is the adapter's transaction boundary. State, message, event, qualification, action outbox and final snapshot either commit together or all roll back. Composite foreign keys retain tenant, lead, conversation and event ownership, including same-tenant wrong-parent protection. Foreign identifiers cannot authorize a scoped read/update; ownership columns cannot be changed through the read/plan API.

References: [D1 binding and atomic batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 enforced foreign keys](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

## Local execution and network boundary

```sh
npm test                 # original SQLite/core suite, then local D1 suite
npm run test:sqlite      # original fail-on-all-network guard, unchanged
npm run test:d1          # actual Miniflare D1 binding, numeric loopback only
npm run typecheck
npm run build
npm run demo             # existing SQLite CLI
npm audit
```

The D1 suite uses the real local D1 prepared statement/batch API and persistence, not a transactional batch double. Its fault wrapper inserts a failing real SQL statement into the submitted batch. It tests failures after every SQL statement, including after the final snapshot; both first-event inserts and subsequent updates must restore the previous six-table snapshot. Separate tests cover all eleven shared planning checkpoints for both paths, CAS rollback, scope revocation, bounded rereads, independent-adapter races, immutable replay, qualification transitions, isolation, FK constraints and restart persistence.

Miniflare needs local transport. Its isolated preload permits only numeric `127.0.0.1`/`::1` socket connections; external/other addresses, external DNS, TLS and UDP are blocked. The workerd outbound service throws on attempted external requests. Guard tests exercise both external rejection and working numeric loopback. The original SQLite suite keeps its stronger no-network preload. Neither local suite needs a Cloudflare account or external service. Dependency installation/audit is a development network operation, not a runtime dependency.

Miniflare 3 is used for the existing Node 20 runtime. Audited transitive overrides for undici, ws and busboy remove the vulnerabilities observed during initial installation; the full dependency audit passes with these overrides and the emulator tests exercise compatibility.

## Limitations before Worker ingress

- This is a development binding adapter, not a deployed service. Remote D1 limits, error envelopes, regional placement, latency, sessions/read-replication consistency, resource migrations and operations have not been validated against a real Cloudflare account. A primary binding is assumed; any future session wrapper must guarantee current/coherent acceptance reads. Error normalization recognizes exact constraint names/messages exercised locally and fails closed on unfamiliar errors.
- Snapshot loading currently reads all six business tables for the authorized tenant. This intentionally preserves the existing simple scoped repository contract, but grows with tenant history and is not an approved production query/row-budget design. A targeted acceptance-read contract and limits must precede high-volume ingress.
- The synchronous read/plan callback and guarded lead advancement assume acceptance writes use this shared path. Arbitrary direct database maintenance or independent qualification writers need their own consistency contract; the low-level repository is not an authorization API for untrusted callers.
- The core still imports Node crypto for UUIDs/fingerprints. Worker runtime compatibility or Web Crypto adaptation needs separate testing/authorization; no Worker-compatible packaging claim is made here.
- D1 commits pending provider-independent outbox intents only. The existing synchronous `drain()` is SQLite-specific and unchanged. No D1 consumer, lease/ack protocol, distributed exactly-once guarantee or external delivery is implemented.
- Schema application is performed by the local harness. A reviewed deployed migration procedure, authenticated source resolution and environment binding remain prerequisites to any future ingress/deployment; this local work authorizes none of them.

## Actual verification evidence

On Node `v20.20.2`, the final combined command `npm test && npm run typecheck && npm run build && npm run demo && npm audit` exited 0:

- Original SQLite/core suite: **32 passed, 0 failed**.
- Local D1 suite: **19 passed, 0 failed** (17 adapter/persistence tests plus 2 transport-guard tests).
- Typecheck and build: passed; compiled schema/CLI asset checks are included in the original suite.
- Existing CLI: `durable_verified: true`, exactly one row in each T1 business table, zero T2 business rows, one mock receipt.
- Full dependency audit: **0 vulnerabilities**.

Vertical RED/GREEN evidence used the local D1 command before each new production behavior: absent adapter failed with `ERR_MODULE_NOT_FOUND` then passed; zero-row CAS initially failed with `Missing expected rejection` then passed with SQL rollback; commit-time lifecycle revocation initially failed with `Missing expected rejection` then passed; independent-adapter duplicate race initially failed with the scoped lead UNIQUE constraint then passed after retry/reread mapping; read-batch revocation before duplicate replay initially failed with `Missing expected rejection` then passed. Already-supported SQLite/core behaviors were subsequently exercised as D1 regression coverage. No commit or push was performed.
