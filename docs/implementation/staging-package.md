# Apacely closed Cloudflare staging package

## Current scope and status

**Closed local staging composition implemented; remote deployment, resource creation, protected routing, real secrets, spending, production and live effects NOT AUTHORIZED.** Component qualifications below are real local executions, not remote acceptance. Release additionally requires the fresh frozen-byte full regression and final independent review in the Definition of Done; the consolidated completion report records their results and immutable publication SHA.

The distributed-admission milestone is published as `eb0c8b7db8580870c947dd21596e7e98835483d1` (parent `3cf331b943f5b0319e2cd5542a72bafbf232fc39`). Parent-owned independent public Git readback verified its exact twelve final files. Prior full 386/386 and separate distributed 56/56 verification applies to that milestone, not to this new staging composition. The user accepted the historical DA11 transport uncertainty for offline publication and local engineering. The original `fetch failed` cause remains unknown, its evidence is preserved, and remote behavior is not verified. See [distributed admission](distributed-admission.md), [ingress contract](worker-ingress-contract.md), and [remote staging acceptance matrix](staging-readiness.md#7-exact-acceptance-matrix--all-remote-cases-not-run).

## Architecture and trust boundaries

The normal release is synthetic-only: closed default fetch boundary → unchanged bounded ingress pipeline → standard cryptographic Access transport verification → unchanged synthetic HMAC proof → trusted active D1 mapping/tenant → fixed SQLite Durable Object admission → original-primary staging D1 nonce claim and atomic business/pending-outbox acceptance. No consumer, CRM, calendar, SMS, voice, model, queue, workflow or live provider is introduced.

- Select exactly `staging` and `ingest_mock_lead` from trusted composition. Request body, headers, query, Access claims and provider proof cannot choose environment, tenant, database, policy or object name.
- Defaults are ingress disabled and effects disabled. Disabled ingress touches no body, keys, DB, coordinator or network. Missing/malformed configuration fails closed. No health, admin, reset, diagnostics, fault or arbitrary proxy endpoint exists.
- Pass exactly the configured three-key application binding object to the reusable handler; all D1 adapters and distributed-issued observers share the identical original `DB`, never a session or replica wrapper. Verify the immutable physical staging marker.
- Reuse shared counter-only preauthentication controls. Do not create per-request counters or shared in-flight promises. Access/JWKS and lazy HMAC creation run inside the existing retained request deadline/`waitUntil` pipeline; a subordinate network timeout cannot renew the total request budget.
- App-level Access verification consequently follows bounded body parsing and physical marker checking. Do not claim it happens before all DB/body work. The later separately approved Access edge transport is an independent outer boundary.
- Standard Access RS256 JWT verification requires trusted exact issuer/application audience, signature and timestamp checks. It does not choose source/tenant or certify an actual strict Service Auth policy. JWKS retrieval is fixed to the trusted team issuer's `/cdn-cgi/access/certs`, bounded, abort-aware and redirect-denying. There is no token-supplied URL, bearer/cookie fallback, mock verifier or request-selected test resolver.
- Existing synthetic HMAC protocol, five mandatory proof headers, canonical raw-body digest, source identity and lifecycle/rotation restrictions remain authoritative. Future signing keys use secret bindings only; no deployable key, public-vector fallback or key material enters config, SQL, Git or evidence.
- Stable fixed coordinator name, policy epoch and digest survive releases. Permanent owner/key tombstones and indefinite charged uncertain work remain unchanged. Missing state, policy drift, clock anomalies or damaged storage never authorize a replacement grant.

## Durable Object first-birth contract

Missing storage cannot prove that a coordinator has never existed. A birth marker detects partial damage but cannot establish freshness after privileged whole-store deletion or historical restore. The package therefore uses separate artifacts:

1. **One-time constructor bootstrap build**: only for a demonstrably new, dedicated, empty namespace and the fixed object, after separate resource/bootstrap deployment approval. Freshness comes from the approved provisioning inventory, not from a request or missing key. The bootstrap constructor atomically writes the marker and canonical seed using the actual transaction's own methods. Unknown keys/schema, existing state/marker, malformed data or policy mismatch reject; no repair, reset, upsert, deletion or restore occurs.
2. **Sealed normal build**: validates intact marker/state and never seeds an empty or damaged store. This is the only artifact eligible for later enabled ingress. A fixed-name service call can reach the coordinator, but the normal build cannot initialize it.

The bootstrap default HTTP handler stays closed. Any private service-binding bootstrap caller must be separately approved with exact identity, target, single-use invocation and evidence; it is not a public/admin route. No route, service caller, schedule or secret is provisioned by this package. Bootstrap authority must be removed by a sealed deployment and verified before ingress is considered. Privileged namespace renames, delete/restore, policy epochs, whole-store replacement or operator reclamation are forbidden ordinary release operations and require separate incident/security approval. If existing ownership history is missing, quarantine; do not bootstrap it again.

## Initial versioned D1 migration

`src/schema.sql` remains the sole canonical application schema. Initial staging SQL is deterministic generated output with staging-only marker/mapping/outbox constraints and the complete tables, triggers, indexes and tenant-scoped foreign keys. An explicit versioned-migration generation mode may admit only the precisely validated pinned-Wrangler migration metadata and empty initial history. It must still reject foreign application schemas, forged metadata or unexpected ledger records. Ordinary strict empty-target generation remains unchanged.

The actual local Wrangler migration runner qualified first apply, recorded history, runner reapply/no-op, direct SQL reapplication rejection, fault rollback, complete schema/FK equivalence and absence of fixture tenants/sources. Successful `CREATE IF NOT EXISTS`, a direct batch, or an import is not sufficient versioned migration evidence. The initial migration initializes schema only; tenant/mapping fixture bootstrap and every remote migration remain separately gated.

The fixed wrapper first validates the physical `_cf_METADATA` table read-only: exact pinned table/column/index definition and one key-2, nonnegative safe integer local-development bookmark. This is narrowly observed platform metadata, not a reserved-prefix schema exemption. Forged internal schema/content and foreign/development/history targets are rejected before migration invocation. First apply comprises 28 canonical migration statements plus Wrangler's ledger append; real D1 tests exercise 30 failure/rollback positions including ledger insertion and a subsequent failure. Runtime and physical-file inspection are distinct oracles.

## Tooling and release containment

Project-local tooling is exactly pinned and lockfile-backed. Existing Node20/Miniflare3 regression tooling is preserved; Wrangler's supported Node22 binary is separately installed outside Git from an official checksum-verified distribution. No Node compatibility flag is added to the Worker bundle. Validate installed Wrangler help/schema, generated platform types and the actual browser/runtime import graph rather than substituting current documentation.

The placeholder-only config contains an explicit disabled top-level sentinel and named `staging`, empty routes, `workers_dev=false`, `preview_urls=false`, explicit placeholder account/D1 IDs, SQLite class migration, and duplicated non-inheritable vars/bindings. There is no production configuration, real account identifier, remote binding or credential file.

The ordinary release wrapper accepts only a closed offline command vocabulary with explicit config/environment/local targeting, sanitized environment, isolated CLI home and no inherited credentials or `.env`/`.dev.vars`. It rejects arbitrary flags, implicit environment, real target IDs and remote/resource/deploy/secret/preview/version commands. Dry-run proves packaging, not deployment authorization or remote safety. Future approved remote operations require a separately scoped operator procedure; do not remove the offline guard to get around it.

## Local Definition of Done

Completion requires recorded evidence for all of the following, not a plausible bundle:

- Closed and malformed flag/config paths deny with no body/key/DB/network/coordinator work where specified.
- Real cryptographic Access and HMAC both required; expiry, wrong issuer/audience/key/algorithm, tampering, malformed/ambiguous proof and JWKS network/body failures cannot accept an event.
- Total deadline and retained lifetime cover lazy crypto and network work without renewal or late downstream writes; cross-request anonymous protection remains shared.
- Actual SQLite-backed platform DO class/bootstrap/sealed restart, transaction rollback and missing/corrupt state denial preserve ownership and charges.
- Actual versioned local D1 migration, full security schema/FK equivalence, reapply and rollback checks pass.
- Real local HTTP → Access/HMAC → original D1/DO acceptance works for two synthetic tenants with overlapping external identifiers, staging-only events and pending mock outbox; all foreign tenant rows remain unchanged.
- Browser bundle excludes Node/SQLite native modules, test signers/resolvers, fault/admin/reset/maintenance/consumer capability and normal-build bootstrap initialization.
- Focused suites and fresh complete serial regression, typecheck/build/demo, installed-tool packaging/type checks, audit, secret-pattern/scope/diff/doc checks and independent final exact-byte security review pass.
- Reviewed staging-preparation code is committed/published and independently read back at its immutable SHA; local journal and raw private evidence remain excluded.

## Local qualification and operator commands

Verified components: Access **70/70**, retained-deadline composition **15/15**, Node bundle guard **1/1**, real SQLite DO **4/4**, migration/release pure tests **14/14**, real pinned D1 migration **2/2**, and enabled sealed HTTP end-to-end **1/1**. The independent scoped integration reviewer independently executed the 86 pure Access/composition/bundle cases and reviewed the actual DO evidence. Final full release review is separate; these counts must not be added to fresh full-suite totals as additional unique tests.

The enabled HTTP qualification uses the actual sealed handler, real RS256 and HMAC, primary D1, actual SQLite DO, two tenants with overlapping source identifiers, replay/conflict, tenant forgery and isolated pending mock outbox. It checks state before disposal, restart persistence, invalid proof zero effects and disabled/malformed configuration. The prepared audit initially expected four JWKS calls even though invalid tenant-body schema is rejected before authentication. That failed run is preserved. Exact per-step counts (1, 2, 3, then unchanged 3 on schema rejection) replaced the mistaken oracle; application source and all state/security assertions were unchanged. Synthetic keys are generated only in the private test harness and never included in deployable artifacts.

The current local release workstation uses the checksum-verified, pinned Linux Node22 toolchain at `/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node`. No toolchain binary is committed. The wrapper intentionally refuses another location/version; portability requires an explicitly reviewed local tooling change, not bypassing the guard.

```sh
# Baseline Node20 suites, now explicitly serialized.
npm test
npm run typecheck
npm run build
npm run demo

# Separate Node22 actual Worker/D1/DO suite; loopback-only, serialized.
npm run test:staging-runtime

# Deterministic migration check: output-only; does not execute SQL.
npm run staging:migration-check
```

Types and sealed/bootstrap dry-run packaging are the fixed `staging:types`, `staging:dry-run`, and `staging:bootstrap-dry-run` scripts. Invoke them only in a credential-free environment; their wrapper rejects credential/override variables and ambient `.env`/`.dev.vars` files and isolates the Wrangler home. The exact standalone command vocabulary is:

```sh
env -i PATH=/usr/bin:/bin HOME=/tmp GOMAXPROCS=1 \
  /root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node \
  --import tsx scripts/staging-release.ts types \
  --config wrangler.staging.jsonc --env staging
```

Replace only the fixed mode with `dry-run`, `migration-status-local`, `query-local` or `migration-apply`. `migration-apply` operates exclusively on `.wrangler/staging-local`; it is not a remote deployment or a tenant fixture initializer. Only `dry-run` also accepts `wrangler.staging-bootstrap.jsonc`. CLI generated types, browser bundles/maps, persistence and all private runtime inspection live under ignored `.wrangler/` or external private evidence, never Git. The local continuity journal stays excluded. Bootstrap is **not idempotent on subsequent constructors**: existing storage rejects; after the approved first birth, transition to sealed before any later activation.

## Separate future deployment approval

Local PASS will not authorize remote execution. The final approval packet must identify exact account/region, dedicated new Worker/D1/SQLite DO targets, costs and least-privilege operator roles; code/config/migration/bootstrap/sealed hashes; disabled routing/ingress/effects; secret slots but no values; one-time birth evidence and sealed transition; empty-target migration/backup/containment steps; private protected transport and strict Access policy; synthetic fixture/test scope and budgets; and applicable S01–S37 remote acceptance oracles. Request approval for the exact resource, migration, bootstrap, secret and disabled deployment actions before any are performed. Public routing, test traffic, production activation and live effects require their own explicit scope. All remote acceptance cases remain **NOT RUN** until that approval and actual evidence exist.
