# Worker ingress contract — local executable boundary

## Authority and scope

Separately authorized local implementation atop baseline `cb0f11247f085983f4ecc969c00a5c1a45601e0d`. Historical documentation-only exclusions remain applicable outside this local slice. `src/worker-ingress.ts` exports a reusable class with `handle(Request)`; it is **not a Worker entrypoint**, has no default export or production `fetch`, deployment configuration, public endpoint or real verifier. Tests construct Requests inside an in-memory test-only Worker service-binding RPC harness. Real existing shared `Processor`/D1 acceptance commits state and pending outbox atomically. No policy duplication, consumer, provider, UI, resource mutation, deploy, commit or push is included.

All route, size, timestamp-window and response choices below are **synthetic local test policy**, not approved production security policy. Qualification remains `mock-qualification-v1`, not client eligibility or consent policy.

## Trust boundary and lifecycle

1. Generate an internal UUID request ID (ignore external correlation headers).
2. Require POST, exact `/v1/ingress/{provider}` with provider `[a-z][a-z0-9_-]{0,31}` and no query. Version 1 is the only route version.
3. Require `application/json` (optional UTF-8 charset); reject Content-Encoding. Read the stream with a 16,384-byte limit, cancel on overflow, never trust Content-Length as the actual size. Broken streams reject safely. Fatal UTF-8 decode precedes JSON parsing.
4. Reject duplicate decoded JSON property names, including escaped-equivalent names, before JSON.parse can silently choose the last value. Inspect all object nesting; depth greater than four fails. The lexical inspection is not a replacement JSON parser: JSON.parse still rejects malformed syntax. Unknown fields (including tenant_id/environment/source_binding) fail at top level and qualification level.
5. Reuse `validateInput` for required exact fields, types, safe positive sequence integers, schema 1, mock channel, real UTC calendar timestamps and synthetic enum vocabulary. Add ingress-only limits: source event/lead/contact references `[A-Za-z0-9_.:-]{1,128}`, text at most 4,096 UTF-16 code units; occurred_at at most 24 characters. Shared location normalization/120-character trimmed limit and null-versus-omitted semantics remain unchanged. Total UTF-8 byte limit applies independently. Text may be empty; no free-text interpretation.
6. Hash exact raw bytes using pinned portable SHA-256. Invoke mandatory injected verifier with provider, method, path, headers, copied raw bytes and digest. There is no default verifier, no always-accept production implementation and no header-based tenant lookup.
7. Capture immutable verified principal metadata. Require provider/method/path/body digest to match the actual request. Principal/source/nonce must be bounded opaque reference strings; signed_at must be valid UTC, at most 24 characters, within 300 seconds past or 30 seconds future of the injected server clock, inclusive. These are test policy constants, not selected-provider limits. occurred_at is informational fact time; it is not freshness/ordering authority. Freshness binds the **authenticated signed_at**, never an unverified body/header timestamp.
8. Retrieve server-side source mappings by verified authority. Require exactly one result, not a default or first match. Its principal, provider and source must exactly match the verifier's authority. Require development environment and action `ingest_mock_lead`; authentication alone is not action authorization. Capture the mapping before further awaits. Missing/ambiguous/wrong-source/wrong-action mappings fail closed. Active tenant is checked before nonce binding; existing repository checks lifecycle again in coherent acceptance reads and atomic writes, including replay.
9. Atomically bind scoped nonce identity to exact authenticated request identity; conflict rejects before core. Then call the unchanged shared Processor with trusted mapping-derived context and validated data. Core retains semantic fingerprint, event idempotency, sequencing, qualification and atomic D1/outbox invariants. No untrusted tenant reaches it.
10. Return 200 only after durable acceptance or immutable replay. Reply contains generated request_id and original internal event_id, not payload/qualification/tenant/provider identifiers. No external effects occur.

## Verification abstraction and future protocols

`Dependencies.verifier.verify` returns null or a `Principal`: principal, provider, source, signed_at, nonce, body_digest, method, path. This is a **trusted adapter output**, not a structure callers may supply as authorization. Adapter implementations must establish all those claims cryptographically or through an explicitly approved equivalent protocol. An OAuth token alone does not bind request bytes/source/time/nonce; a shared-secret header alone does not satisfy this contract. Future signatures, shared secrets and OAuth need reviewed authority, request-binding and replay mechanisms behind this interface. The raw body copy prevents adapter mutation of the bytes used for validation/hash.

Only test harnesses implement synthetic verification and memory mappings. They deliberately fabricate trusted metadata for control-flow tests; this is not proof of authenticity against any real protocol. Production adapter registration/credential scopes, provider canonicalization, key rotation, constant-time secret handling, OAuth audience/expiry/scopes, signature/timestamp coverage and source ownership remain blockers for real ingress.

## Replay and recovery contract

`replay.bind(key,digest)` is mandatory: atomically establish the first identity; return true for first or identical subsequent identity, false for conflicting reuse. Errors fail closed. Key is a JSON tuple `(development, provider, principal, source, nonce)`. Digest covers method, path, signed_at, raw-body hash, resolved tenant and source binding. Exact authenticated retry is allowed only while authentication/freshness/lifecycle still passes; changing any authenticated identity component with the same nonce conflicts. Memory implementation exists **only inside tests**.

Binding is not a one-shot consumption flag. Never delete or mark a nonce irreversibly consumed before durable acceptance: identical retries must be able to retry after precommit failure, ambiguous persistence errors or response loss. No cached success skips current authorization. Ledger implementation must be durable/atomic across isolates and retain conflict information through the acceptance window plus clock-skew and maximum in-flight lifetime. Production retention/GC, mapping-version pinning/revocation and distributed race semantics require separate design; no durable nonce store is claimed here.

Core durable identity is `(tenant, source_binding, source_event_id)` with its existing canonical semantic fingerprint. Same event/same semantic input under a fresh valid authentication can return the original internal event/outcome; same event/changed semantic input conflicts even with a new nonce. Exact same-nonce retry is stricter: byte-different JSON conflicts, even when semantic input is equal. After freshness expires, recovery requires newly authenticated delivery with a new nonce and current timestamp; the original semantic event identity remains unchanged. A 503/500 does not prove rollback. Explicit replay reconciles an already committed outcome without duplicate action intent. This test executes real local D1 acceptance and then injects response loss on each allowed application attempt, followed by successful explicit replay.

## Safe errors and closed logging

| Status | Safe code / meaning |
| --- | --- |
| 400 | invalid_input: malformed JSON/UTF-8/schema/stream |
| 401 | unauthenticated: missing/rejected or mismatched verified proof, stale/future authentication |
| 403 | forbidden: missing/ambiguous/unauthorized mapping, inactive context |
| 404 / 405 / 415 / 413 | route / method / media_type / too_large |
| 409 | conflict: nonce reuse or core event/sequence conflict |
| 503 | unavailable: existing bounded persistence retry budget exhausted, possibly committed |
| 500 | internal: unexpected/permanent/unknown persistence, resolver/verifier/ledger errors |

Only typed known boundary/core errors are classified; raw database messages, exceptions, causes, headers, payloads, stacks, secrets and PII are never returned or logged. Permanent/unknown failures are not blindly retried by ingress; existing Processor owns bounded acceptance retries. Response headers set no-store and nosniff. All responses carry generated request_id. The log callback receives only `{request_id,status,code}`; no spread of input/exception objects, external IDs or tenant labels. Logger exceptions are swallowed to avoid changing an already committed result; production monitoring of logger health is a future operational requirement.

## Local verification and RED/GREEN evidence

```sh
npx tsx --test --import ./tests/d1/loopback-guard.mjs tests/d1/ingress.test.ts
npm test
npm run typecheck
npm run build
npm audit
git diff --check
```

Tests bundle browser-target shared core/D1/ingress with existing esbuild, assert no Node/SQLite-driver imports, and execute inside actual workerd with no nodejs_compat. Test-only default RPC class has no fetch. Miniflare uses numeric loopback, local D1 and denied external outbound requests. Existing network guards remain unchanged.

Vertical observations: initial acceptance failed because ingress module was missing, then passed with real six-table atomic writes and zero T2 changes; transport/schema rejection first propagated JSON failure, then returned safe rejection with zero core calls; exact source authorization first accepted cross-source proof, then failed closed; authenticated replay first accepted mismatched raw digest, then rejected proof/freshness/nonce conflicts; response-loss recovery first returned wrong status, then returned 503 and allowed original replay without another outbox row; broken stream first returned 500, then returned safe 400; mapping-await mutation first switched ownership to T2, then captured T1 and preserved isolation. Each implementation slice followed its observed RED before GREEN. A test fixture initially used unsupported lifecycle value suspended; corrected to existing schema's inactive (no schema change).

Final counts/results are reported with actual terminal output by the implementing agent and independently rerun by the parent; this document is not independent approval. Baseline 33 core/SQLite and 38 D1/runtime tests are retained unchanged. Eight additional ingress runtime scenarios cover strict validation, bounded streams, exact authority, two tenants with overlapping IDs, replay/freshness, mutation capture, safe logs and ambiguous durable recovery.

## Exclusions and remaining real-ingress gates

No production verifier, durable mapping/nonce adapter, deployed handler, public endpoint, real signature/OAuth/shared-secret protocol, consumer, SDK, resource, configuration, dependency or credentials were added. Independent security review passed for this local scope, with two nonblocking limitations: source-mapping revocation during an in-flight request is not enforced at acceptance, and dependency wiring remains caller-mutable (trusted composition must not mutate it). Captured mapping ownership is stable, but it is not commit-time mapping authorization. Before real ingress, define and test versioned mapping/revocation enforcement at the acceptance boundary and immutable adapter/repository wiring. Production implementation additionally requires separately approved identity/protocol policy, reviewed source-mapping lifecycle and change/race semantics, isolated bindings, durable replay implementation, request timeouts/slow-body defenses, quotas/rate/concurrency limits, observability access/retention, PII retention/deletion and operational failure/reconciliation procedures. Local bounded byte reads do not establish slowloris/CPU/latency/SLO or distributed correctness. Remote D1, staging and production are NOT RUN; local technical results do not grant activation, security-policy, secret or infrastructure approval.

Runtime references consulted: [Workers Streams](https://developers.cloudflare.com/workers/runtime-apis/streams/) and [Miniflare testing](https://developers.cloudflare.com/workers/testing/miniflare/). Existing project's compatibility date, dependency versions and no-Node runtime harness were retained.
