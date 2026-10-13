# Offline qualification artifact release runner

## Governing literal-window renewal (2026-10-13)

**Affected local gates PASS; independent exact-byte renewal review remains PENDING. Remote qualification remains BLOCKED.** Trusted literal current windows are now `[2026-10-13T00:00:00.000Z,2026-10-14T00:00:00.000Z)` and next windows `[2026-10-13T23:57:00.000Z,2026-10-15T00:00:00.000Z)`, exactly three minutes overlap, in both date modules and all four profiles. Only literal source dates, the existing window/family regression and the synthetic full-ring observation date change. SOURCE129/FULL258 original-reference factories, layouts, global families, key material, authentication, deadlines, policies and ownership controls remain unchanged; no runtime clock/environment selector exists. Future expiration requires another reviewed rebuild and affected requalification.

Bounded RED evidence captures the updated literal oracle failure, an actual expired contention16 HTTP profile lifecycle failure and the old full-ring overlap observation failure. Fresh focused unit **16/16**, ordinary Node 20 SQLite **227/227**, serial strict/loopback Node 22 staging runtime **24/24**, project typecheck/build and **four actual sealed Wrangler dry runs with generated-byte hash readback PASS**. Full suites have zero failures, skips or cancellations. Actual artifact assertions/statuses/deadlines are unchanged. Dependency graphs for all 19 targets and both baseline bundles prove only four sealed bundles import renewed modules. Original 38 CLI executions/readback hashes are preserved; 34 unaffected executions remain applicable, not fresh. Unchanged full D1 **347/347**, separate storage **15/15**, demo and zero-vulnerability audit remain preserved evidence. Fourteen storage pure cases overlap SQLite, not additional distinct coverage.

Private `phase4/release/expired-window-rebuild/` contains the original 73-file snapshot, source manifest SHA256 `f24af24259fbb75acbe29414f121c4923b1dafd748f81e756e19669d6cbd1a7b`, RED/raw GREEN evidence, actual child exits, source/generated hashes, applicability, exact delta and renewed draft manifest. Seven existing paths change; 66 remain byte-identical. Earlier exact-byte reviews do not approve this delta. Independent review remains pending, followed by staged/committed verification and independently read-back publication. No staging, commit or publication is performed here.

All **37 remote cases remain NOT RUN**; remote metadata/provenance/migration, fault and replay-preserving recovery executors and R10 full258 CPU/native isolate peak/authoritative startup remain UNKNOWN or unverified. Historical DA11 remains UNKNOWN. Fresh staging runtime has three unsuppressed RPC disposal warnings; preserved actual storage has four, not a clean-runtime certificate. Baseline birth remains fresh-only through the unchanged original helper with no reset, takeover or namespace replacement; remote physical freshness and first-birth limits remain unverified. No resources, deployment, Access, DNS, endpoints, real secrets, subscriptions, spending, live effects or production actions are authorized or performed. Earlier checkpoints below are historical, not current literal-window authority. Runtime ownership is released after owned-process verification.

## Historical offline release checkpoint (2026-10-12)

**Offline code release gates PASS; remote qualification remains BLOCKED.** Current full D1347/347, SQLite227/227, staging runtime24/24 and separate storage15/15 pass; storage pure cases overlap SQLite, not fifteen additional distinct cases. Final-byte typecheck/build, demo/audit and independent implementation/fixture reviews pass. Parent38 actual CLI executions across19 targets retain verified log/generated hashes; after the literal lifecycle rebuild, the three affected sealed dry runs were executed again and read back. No unchanged CLI gate is claimed as a fresh execution.

This evidence-only documentation closure still requires final review, staged/committed exact bytes and independent published-byte readback; no commit/publication is claimed here. See private `phase4/release/final-parent-verification.json` and `final-fixture-delta-review.json`. All37 remote cases remain NOT RUN; exact remote D1 metadata/migration, fault/replay-safe recovery executors, authoritative full258 CPU/startup/native peak remain unverified. RPC warnings remain3 in staging and4 in separate storage; historical DA11 stays UNKNOWN. Current keys expire2026-10-13T00:00:00.000Z and next windows end2026-10-14T00:00:00.000Z, requiring reviewed rebuild/requalification rather than runtime overrides. Baseline wrapper/security limits remain unchanged. Offline publication authority grants no resources/deployment/secrets/Access/DNS/endpoints/spending/live-effects authority. The following sections preserve earlier checkpoints; their pending offline gates are superseded only within the verified scope above.

## Historical parent integration evidence — before final release closure

The earlier child results below are retained as historical observations. After the
real source-keys128 four-shard config landed, the parent executed the guarded
qualification and baseline-wrapper tests: **22/22 PASS**, zero skips. The parent
also executed **all 19 targets in both modes: 38 actual pinned local Wrangler
executions**, all exit zero, with useful generated files and SHA256 readback
verified. The frozen source/config manifest matched before and after those runs.
Evidence: `/root/apacely-staging-evidence/phase4/release/sharded-integration/parent-integrated-runner.log`
and `phase4/release/parent-cli/{input-sha256.json,runs.json,result.json}`.

These are genuine CLI executions, not launcher fixtures. They do not verify
remote D1 metadata, edge Access, deployed resource identity, runtime behavior or
fault recovery. A later nonsecret lifecycle rebuild invalidates affected bundles
and requires their requalification. Final integrated release and independent
exact-byte review remain required; no deployment or live-secret authority is
conferred.

## Scope and status

`../../scripts/qualification-release.ts` is separate from the unchanged baseline
`staging-release.ts`. It implements execution, not just a plan: only `types` and
`dry-run` can launch the pinned local CLI. Neither mode authorizes deployment,
resource creation, secret management, migrations, ingress, or fault controls.

The inherited 46-line planner and its tests were preserved and extended in
observed RED/GREEN steps. Pure Node guards and scoped compiler checks are the
child's evidence. **Actual Wrangler types/dry-run execution is NOT RUN by this
child:** the capacity child owns heavy execution. The parent must first acquire
that ownership, then execute the commands below serially. Unit launcher fixtures
exercise wiring/readback/error handling; they are not CLI/build evidence.
Historical DA11 remains UNKNOWN and is not investigated here.

## Exact allowlist

Four profiles each admit only the matching config/artifact pair:

| Profile | Artifacts | Config pattern |
| --- | --- | --- |
| `contention16` | bootstrap, sealed, initializer, runner | `wrangler.qualification-contention16-{artifact}.jsonc` |
| `capacity16-source4` | bootstrap, sealed, initializer, runner | `wrangler.qualification-capacity16-source4-{artifact}.jsonc` |
| `source-keys128` | bootstrap, sealed, initializer, runner | `wrangler.qualification-source-keys128-{artifact}.jsonc` |
| `source-rate100` | bootstrap, sealed, initializer, runner | `wrangler.qualification-source-rate100-{artifact}.jsonc` |

Three standalone pairs complete the 19-target allowlist:

| Artifact | Config |
| --- | --- |
| bootstrap | `wrangler.qualification-initializer-bootstrap.jsonc` |
| initializer | `wrangler.qualification-initializer.jsonc` |
| runner | `wrangler.qualification-initializer-runner.jsonc` |

All require exactly seven runner arguments:
`{types|dry-run} --config {exact-config} --artifact {matching-artifact} --env staging`.
Aliases, traversal, baseline configs, extra flags, remote/local database commands,
and deployment/dev modes are rejected. `--env staging` is an explicit fixed
qualification intent, **not** a Wrangler named environment. These actual configs
are top-level-only; the CLI receives no `--env` and no inheritance is invented.

## Containment

The complete parsed config must equal its fixed expected structure: sentinel
account `00000000000000000000000000000000`, D1 UUID
`00000000-0000-4000-8000-000000000000` where applicable, exact names/mains/bindings,
compatibility date `2025-07-18`, empty compatibility flags/routes/crons,
`workers_dev:false`, `preview_urls:false`, metrics/observability disabled, and
mock ingress/effects flags `false` where applicable. Unknown fields, named envs,
remote IDs/bindings, missing D1 IDs, build hooks, assets, and new resources fail
closed. Initializer/runner configs intentionally contain no ingest flags or D1.

Sealed fixed secret references are exact, ordered lists; no material is accepted.
C16/C4/R100 each retain 16 current/next pairs. Only the source-keys128 sealed
profile now requires exactly these four names, in order:
`QUALIFICATION_HMAC_KEYRING_1`, `QUALIFICATION_HMAC_KEYRING_2`,
`QUALIFICATION_HMAC_KEYRING_3`, `QUALIFICATION_HMAC_KEYRING_4`.
Its six fixed text vars and all other config fields remain unchanged. Old 128/129
per-key lists, mixed transport, missing/extra/duplicate/reordered names, dynamic
or malformed declarations, and metadata/layout vars are refused.

This follows the parent-accepted conditional offline design at
`/root/apacely-staging-evidence/phase4/registry-capacity/architecture-review.json`:
four required ordinary secret bindings, each at most 3056 bytes, trusted build
counts 65/64/0/0 for 129 currents and 65/65/65/63 for full 258 rotation records.
Empty shards remain required. Runtime parsing/key capture is the auth owner's
scope, not implemented or proved by this config validator. Source admission
capacity stays 128; authentic source129 remains a runtime capacity oracle.
The auth owner alone edits the source-keys128 sealed config. Until it lands, the
actual-config test deliberately fails; a guarded four-name fixture is not proof
that the on-disk integration gate passed. No fallback to old declarations exists.

Ambient CF/Cloudflare/Wrangler/Node/dotenv/qualification/application overrides,
proxy aliases, npm proxy/Node/config overrides, and dynamic-loader overrides are
refused. Child environment is an explicit six-key allowlist: PATH, HOME,
XDG_CONFIG_HOME, and the metrics/dotenv/process-environment disable settings.
HOME/XDG_CONFIG_HOME share a private fresh OS temporary directory, removed even
on failure. No saved auth profile is reused.

Workspace preflight rejects dotenv/devvars variants at the root and recursively
under source/migrations/output, deploy/config redirects, source/output/config
symlinks (including dangling links), workspace ancestor links, and links in the
fixed dependency/loopback-guard path chain. The reviewed installed dependencies
and source are trusted inputs, not a hostile-filesystem sandbox. Concurrent
malicious filesystem replacement is outside this wrapper's isolation guarantee;
freeze source/config/dependencies before qualification.

Each execution uses Node `/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node`
(after an exact version check), local Wrangler `4.149.0`, and
`tests/d1/loopback-guard.mjs` via `--import`. The installed Wrangler wrapper forwards
`process.execArgv` to its CLI process. Both CLI modes receive
`--experimental-provision=false --experimental-auto-create=false`; installed
Wrangler's global flags otherwise default both provisioning controls to true.
No install or package-manager download occurs. This JS loopback guard blocks
external Node network/DNS/TLS/UDP; it is not an OS-wide native-process network jail.

Output is Git-ignored and isolated as
`.wrangler/qualification-release/{profile}/{artifact}/{UUID}`. Git ignore status
is verified; the run leaf is created exclusively, never reused. Failed-run output
is retained. A successful exit is insufficient: useful nonempty regular output
files are read back (`types.d.ts` for types; a JS bundle for dry-run), symlinks are
rechecked, and JSON reports status, output path and per-file SHA256 hashes.
Wrangler launch is bounded to 120 seconds; timeout/null status is failure.
Preserve stdout/stderr externally because temporary HOME logs are removed.

## Parent-only serial execution after ownership handoff

From `/root/apacely-platform`, first freeze the intended inputs and confirm the
registry/config integration gate. Commands below are prepared, not execution
evidence. Clean startup matters: Node loads imports/options before the runner's
ambient checks, so use the fixed `env -i` invocation rather than ambient Node
options, raw Wrangler, npm/npx, or a custom config.

```sh
node=/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node
for profile in contention16 capacity16-source4 source-keys128 source-rate100; do
  for artifact in bootstrap sealed initializer runner; do
    for mode in types dry-run; do
      env -i PATH=/usr/bin:/bin "$node" --import tsx \
        --import ./tests/d1/loopback-guard.mjs scripts/qualification-release.ts \
        "$mode" --config "wrangler.qualification-$profile-$artifact.jsonc" \
        --artifact "$artifact" --env staging || exit 1
    done
  done
done
for artifact in bootstrap initializer runner; do
  config="wrangler.qualification-initializer-$artifact.jsonc"
  if [ "$artifact" = initializer ]; then config=wrangler.qualification-initializer.jsonc; fi
  for mode in types dry-run; do
    env -i PATH=/usr/bin:/bin "$node" --import tsx \
      --import ./tests/d1/loopback-guard.mjs scripts/qualification-release.ts \
      "$mode" --config "$config" --artifact "$artifact" --env staging || exit 1
  done
done
```

This is 19 targets and 38 distinct mode/target executions, not 38 tests or runtime
acceptance scenarios. Capture one log per target/mode and inspect returned hashes
and declarations/bundles. A package/types PASS does not prove runtime, remote
metadata, rollback, cost, public endpoint containment, or production readiness.
If a timeout occurs, inspect only the owned process tree before resuming; do not
kill unrelated workers or overlap emulator-heavy runs.

## Scoped verification and evidence

```sh
export TMPDIR=/root/apacely-staging-evidence/phase4/parent-tmp
node --import tsx --import ./tests/network-guard.mjs --test \
  --test-concurrency=1 tests/qualification-release.test.ts tests/staging-release.test.ts
node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop \
  scripts/qualification-release.ts tests/qualification-release.test.ts
```

Observed sharded-integration scoped result: **22 tests, 21 PASS, 1 FAIL**
(14 qualification tests plus 8 unchanged baseline-wrapper tests). The sole failure
is the actual-config integration gate: the source-keys128 sealed config still
listed 128 legacy per-key references at execution time. The complete read-only
matrix in `runner-config-matrix.json` records 19 targets, 18 accepted, one refused;
that is not an overall PASS. Scoped TypeScript checking exits 0. The four-shard
fixture test was observed RED (expected exact-config refusal) before the minimal
runner edit, then GREEN. Negative declarations/metadata tests and unchanged
containment tests pass. Refresh these commands and the complete actual-config
matrix after the auth owner's config edit; do not wait/poll or weaken guards.

Evidence directory:
`/root/apacely-staging-evidence/phase4/release/sharded-integration/`:
`runner-red.log`, `runner-green.log`, `runner-focused.log`,
`runner-typecheck.log`, and `runner-config-matrix.json`.
Original recovered evidence remains untouched at
`/root/apacely-staging-evidence/phase4/release/recovered-tmp-evidence/`;
the earlier `/tmp/qualification-release-evidence/` location is historical.
The original HTTP429 attempt supplied no verdict. Old 129-reference evidence is
historical, not support for four-shard runtime verification. Temporary fixture
workspaces use durable `phase4/parent-tmp` via TMPDIR and are cleaned by tests.
Actual pinned CLI execution remains NOT RUN here: the 38 prepared commands above
are a parent gate, never a planner/fixture execution PASS.

Security review of release readiness is FAIL until actual CLI qualification and
independent exact-byte review complete. Input/argument containment has local unit
evidence. Tenant/auth/provider/database/async/LLM behavior is unchanged and N/A to
this tooling-only review, not requalified by it. No PII or secret values are used;
errors are generic and manifests contain paths/hashes only. Dependency audit and
full/application/emulator suites are NOT RUN in this scoped child; dependencies
and package/core/baseline wrapper are not edited. Production approval is not part
of this offline task, and no remote mutation is permitted.
