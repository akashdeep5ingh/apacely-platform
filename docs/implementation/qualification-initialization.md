# Nonpublic first birth and sealed qualification transition

## Status and scope

Offline artifacts only; no account calls, namespace creation, deployments, secrets, ingress, schedules or spending were authorized or performed. Baseline `src/staging-bootstrap-worker.ts`, `src/staging-worker.ts`, their exported class identity and `STAGING_POLICY` are unchanged. Their storage helper defaults remain the baseline policy. The new bootstrap is a separate **qualification preparation artifact**, not a replacement approved for the existing staging namespace.

The checked-in configs have a zero account sentinel, disabled Worker names, no routes, `workers_dev:false`, `preview_urls:false`, and empty cron lists. They are not release-ready configs. Compatibility date is deliberately pinned to the existing reviewed runtime rather than silently advancing it. Observability is disabled for these offline sentinels; reviewed remote preparation must enable appropriately restricted logs/traces without logging state or tickets.

## Capability chain that actually invokes the object

1. A temporary trusted runner calls the initializer via a **service binding**: `await env.INITIALIZER.invokeFirstBirth()`.
2. The initializer selects exactly `QUALIFICATION_ADMISSION.idFromName('distributed-admission-v1')`, in the externally bound target script/namespace, and calls the Durable Object's `initializeOnce()` RPC method.
3. While the qualification bootstrap artifact is deployed, that exported `StagingAdmissionCoordinator` writes marker and initial admission state in one SQLite-backed storage transaction. The constructor does not initialize. The transaction checks bounded emptiness and schema first. A second request, including after a new constructor/runtime, rejects rather than reseeding.
4. The initializer awaits the complete operation and propagates errors. It has no retries or reset. All three HTTP handlers return empty 503 regardless of path, query or body. A service binding is an account capability, not a public authentication endpoint; restrict who may deploy/bind a caller.

This differs deliberately from the **original baseline bootstrap**, which initializes in its constructor and then returns 503. Merely deploying either artifact does not instantiate its fixed object. The new initializer RPC requires the new qualification bootstrap; it cannot invoke `initializeOnce` on the baseline bootstrap. If the original baseline is ever separately approved for first birth, a reviewed temporary caller must instead invoke its fixed namespace stub's `fetch(new Request('https://admission.internal/'))` while that baseline bootstrap is deployed. That internal fetch creates the object and exercises the constructor; 503 is an expected closed response, **not proof of successful birth**. Constructor restart on existing storage rejects. Do not add an HTTP bootstrap route or change baseline semantics to obtain an acknowledgement.

## Freshness authority is external, not emptiness

Before any remote first-birth permission, retain independent account/control-plane evidence of a **demonstrably new namespace**: account, script, exported class, creation migration, namespace identifier and recorded binding identity; absence from the prior namespace inventory/history; reviewed deployment/config/artifact hashes; and proof it is neither the baseline nor a previously used/deleted/recreated target. Empty KV, an unused object name, a new epoch, a successful deployment, a 503 or a local fresh directory is insufficient. The application cannot distinguish never-used storage from destructive deletion. No initialization method is authorized on uncertain storage.

Namespace evidence and account-scoped binding/deployment authority are prerequisites to permitting the temporary service capability. The code's marker/emptiness guards do not supply this authority. No freshness claim is accepted from an HTTP request, RPC argument, environment variable or storage row.

## Viable remote invocation (gated, not performed)

Cloudflare documents service-binding RPC and scheduled handlers. The prepared `initialization-runner-worker.ts` has a scheduled handler that makes exactly one awaited service call per delivered event; its HTTP handler cannot trigger it. An operator can, **after explicit approval for the exact resources/actions**, deploy a nonpublic runner bound only to the temporary initializer, and temporarily install a reviewed cron trigger through Wrangler configuration or the authenticated control-plane schedule API:

- `PUT /accounts/{account_id}/workers/scripts/{script_name}/schedules`, permission `Workers Scripts Write`, body an array of `{ "cron": "<reviewed UTC expression>" }`.
- Read back that exact target's schedule/config/bindings before execution. Cron registration is not immediate direct DO access and may take time to propagate.
- Observe a scheduled event actually completing the awaited RPC. Cron delivery is **recurring**, not a guaranteed single-shot API. Each event is bounded to one call, and repeated initialization is durably rejected. Restrict the scheduling window and remove the schedule promptly; no automatic polling/retry loop is provided here. Account mutation/spending remains separately gated.
- Set schedules to `[]`, read back the empty schedule list, remove runner/initializer bindings and temporary artifacts, and verify absence of routes, workers.dev and preview URLs. Delayed cron events/removal propagation must be accounted for before transition.

Do not invent a Wrangler direct-DO invocation command or treat local `/cdn-cgi/local/scheduled` testing as a remotely authenticated invocation endpoint. No remote invocation or scheduler-delivery assertion is established by the local tests.

References: [Service-binding RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [schedule update API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/).

## Sealed transition and future profile composition

Keep the **same target Worker name, namespace ID, exported `StagingAdmissionCoordinator` class, SQLite migration lineage, fixed object name, policy and epoch/digest** across bootstrap and sealed deployments. Do not create a second namespace as a substitute for a transition. Keep ingress/effects disabled throughout. The sealed constructor validates without writes, reseeding or clock advancement; absent, partial, extra or corrupt storage stays closed. Remove the RPC initializer capability from the sealed bundle and all temporary bindings. Re-read exact target version/binding identities and verify integrity through a reviewed nonpublic verification path before any qualification traffic approval.

`initializeFreshAdmission(storage, now, policy)` and `validateSealedAdmission(storage, policy)` now accept a trusted build-time policy, captured before awaiting; omission preserves baseline. This is preparation for a separately reviewed profile composition, **not HTTP/env-selected policy**. Current new bootstrap uses the baseline default solely to test mechanics offline. The offline synthetic profile module explicitly forbids deployable imports. For a future qualification release, independently review a fixed deployable policy constant, bootstrap/sealed entrypoint pair and target config; compose the same constant into bootstrap storage, sealed validator and admission core. The sealed entrypoint must import only the validator/adapter, never the initializer. No current profile is remotely ready merely because storage helpers are parameterized.

## Verification and evidence

Strict TDD logs and focused execution are in `/root/apacely-staging-evidence/phase4/initialization/`. The runtime command uses pinned Node `v22.23.3`, Wrangler's installed Miniflare 5/workerd, loopback-only guard, `MINIFLARE_ASSERT_BODIES_CONSUMED=true`, `GOMAXPROCS=1`, serial test concurrency and restricted CPU affinity/UV threadpool to keep container PID usage bounded. No full suite, project build/typecheck or dependency mutation is part of this task.

The focused run covers private service invocation and actual fixed-object birth, repeated requests and constructor restarts, same-namespace sealed restart preserving exact state, HTTP closure, policy marker/decoder pairing, sealed bundle capability exclusion, original baseline behavior, actual SQLite interrupted transaction rollback after either write, charged lifecycle preservation, and absent/corrupt/extra storage fail-closed without reseeding. Original runtime tests and historical evidence are retained. Scoped TypeScript compilation and source/evidence hashes are recorded separately; per-file automatic lint timeouts are infrastructure evidence, not a compilation PASS.

Remote-only release blockers: independent new-namespace evidence, actual account/binding identities, approved fixed qualification composition, exact deployment/migration lineage, scheduler delivery/removal propagation, remote state verification and independently reviewed release hashes. Offline PASS never grants mutation or deployment permission.
