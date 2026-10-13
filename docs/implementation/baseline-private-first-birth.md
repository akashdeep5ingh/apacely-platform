# Baseline private first-birth: offline readiness

Scope: baseline `59eda19d13cbb4187d9e60d79dd6984f649de0fa`; unchanged baseline runtime/config/dependencies. The approved offline packaging increment changes only `scripts/staging-release.ts`, adds `tests/baseline-private-birth-packaging.test.ts`, and updates this document. No deployment, resources, scheduling or remote traffic.

## Supported narrow caller

`BaselinePrivateBirthRunner.invoke()` is a named `WorkerEntrypoint` RPC method, callable only through a separately approved service binding. It accepts no arguments, obtains `STAGING_ADMISSION.idFromName('distributed-admission-v1')`, and sends exactly one private stub.fetch to trigger the existing constructor. It never invokes a nonexistent initializer RPC. It cancels the status-only response body, does not retry, and returns `birthVerified:false` even when the fetch returns HTTP 503. Each invocation issues one fetch; three repeated local invocations were exercised. No public initializer, object/policy selector, reset, scheduled handler or cron exists. Default and named-entrypoint HTTP fetch refuse with 503.

The new config is inert: zero account ID, no routes, workers.dev/previews disabled, no migrations or triggers. Its cross-script DO binding fixes `apacely-ingress-staging` / `StagingAdmissionCoordinator` / `STAGING_ADMISSION`. It does not create a replacement namespace. No trusted invoker service has been configured.

## Actual local evidence

Evidence: `/root/apacely-staging-evidence/phase4/phase4b-closure/birth/`.

- RED: one new test failed because the runner did not exist (`red.log`).
- Final focused run: **4 tests passed, 0 failed/skipped/cancelled** (`passing.log`), including three actual-runtime test groups. Grouped damage/write scenarios are not counted as additional tests.
- Project `tsc --noEmit`: exit 0 (`typecheck-final.log`). esbuild actually bundled the runner and unchanged baseline bootstrap/sealed entries for the runtime tests; no Wrangler release-wrapper build qualification was claimed.
- Pinned Node 22.23.3, Wrangler 4.149.0's installed Miniflare 5.20261006.1-alpha; serial CPU0, GOMAXPROCS=1, UV_THREADPOOL_SIZE=1, numeric loopback guard and strict response consumption enabled. All Miniflare instances disposed in finally blocks.
- Private service-binding RPC activated the unchanged bootstrap artifact. Private local storage-list readback found exactly the baseline birth/state keys. Replacing the local artifact with unchanged sealed code preserved the script, class, persistence root, named object ID and exact storage snapshot. Sealed constructor validation completed; private protocol status itself was not used as birth proof. Local readback used a test-only inspector artifact after disposal/restart in the same persisted namespace, not an exposed production endpoint. Snapshot in `transition-readback.json`.
- Empty and corrupt sealed storage refused invocation with 500 / Invalid sealed admission storage; inspector readback showed no reseeding. Actual transactional fault injection after each of the two birth writes left storage empty. A completed birth rejected duplicate initialization without changing state.

Failed attempts are preserved. First runtime attempt lacked the pinned unsafe inspection opt-in. Enabling it then showed `_cf_KV` SQL access is prohibited and introduced instrumentation schema incompatible with the baseline schema guard. No authorizer bypass or baseline guard change was made. The final fixture removed this instrumentation and used private test-only KV storage.list readback across persisted restarts. Automatic single-file lint produced DOM/dependency diagnostics/timeouts; the actual project typecheck passed.

## Guarded offline release packaging

The staging wrapper now allowlists only `dry-run --config wrangler.staging-private-birth-runner.jsonc --env staging` for this caller. `--env staging` is an explicit wrapper intent, not a forwarded named environment: the unchanged private config is validated as an exact inert top-level object. Types, migrations, deployment, additional arguments, alternate targets, services, scheduling, hooks and config extensions are refused. Existing sealed/bootstrap/migration plans are unchanged. The wrapper reuses qualification's recursive workspace/credential/symlink preflight without changing its target catalogue.

Execution pins Node 22.23.3 and Wrangler 4.149.0, discards ambient environment, uses temporary HOME/XDG_CONFIG_HOME, numeric-loopback guarding and strict response-body diagnostics, and explicitly disables provisioning and auto-create. Each run creates an exclusive Git-ignored UUID output directory and reads back nonempty regular generated files with SHA256; exit zero without a useful JavaScript bundle is refused. Unit launcher fixtures are explicitly synthetic, distinct from actual Wrangler evidence.

Evidence: `/root/apacely-staging-evidence/phase4/phase4c-offline/packaging/`. Two vertical RED/GREEN cycles demonstrate previously rejected private-config planning and the missing isolated executor before implementation. Final focused regression run passed **27 tests, zero failed/skipped/cancelled**, covering the new packaging tests, existing caller unit test, staging-release and qualification-release suites. Project typecheck/build and actual guarded Wrangler dry-run are recorded separately. The genuine generated caller bundle SHA256 is `7aa7df9c4d724337fc03d0267e43158fe472dd6cb276aca899791c824d114c51`; map/README hashes and generated paths are in `wrangler-dry-run.log`. No raw ambient CLI bypass was used. Existing first-birth runtime evidence above is preserved, not rerun or counted as fresh packaging coverage. The private config and runtime bytes were not changed.

## Remote STOP and approval gap

This is locally exercised private caller code, **not a remote-ready executor**. A remote control-plane record proving a demonstrably new physical namespace is separately required before bootstrap. Empty local or remote storage does not establish freshness after deletion. Preserve the existing migration lineage and same physical namespace/object/policy through remote sealing, with separately approved readback/provenance evidence; never reuse bootstrap after sealing or destructive deletion.

No safe remote invocation mechanism is currently configured or approved. Authorize a specific trusted service-bound invoker and its invocation/removal/readback plan, or separately authorize temporary scheduling registration/readback/removal. This change registers neither. Do not use public HTTP activation or treat a CLI scheduling registration as a one-shot DO call. Guarded offline packaging now passes; independent security/exact-byte review of this wrapper increment remains parent-owned and pending. Remote acceptance remains NOT RUN; DA11 remains UNKNOWN; NoLater is untouched.

References: https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/ and https://developers.cloudflare.com/durable-objects/api/namespace/ .
