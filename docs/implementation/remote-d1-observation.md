# Future remote D1 observation contract (offline only)

**STOP.** The dedicated `apacely-staging` D1 has not been created; its physical ID is UNKNOWN (`null`), not a placeholder or fabricated UUID. The nonsecret proposed account is `dfd3d98054e547f897606de8c8ebac92`. Approval is absent. All remote S01–S37 remain NOT RUN. This addition grants no resource, query, deployment, routing, billing or secret authority.

## Surface and phase boundary

```sh
/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node --import tsx --import ./tests/network-guard.mjs scripts/remote-d1-observation.ts plan --offline
/root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node --import tsx --import ./tests/network-guard.mjs --test tests/remote-d1-observation.test.ts
```

The CLI accepts exactly `plan --offline`; extra arguments are refused. It emits a fixed seven-query pre-migration inventory/metadata catalogue and bounded approval request, never commands. The pure module has no network, subprocess, filesystem reader/writer or SQL executor. Ordinary in-memory SQLite execution belongs only to the test, using Node22 built-in SQLite, not an emulator. Test DDL and the integer bookmark `123` are synthetic local fixtures, not observations of Cloudflare or migration execution.

The seven fixed statements cover full unfiltered `sqlite_schema`, `table_list`, exact `_cf_METADATA` columns/indexes/contents (key/value/storage classes), foreign-key check and quick check. There are no dynamic selectors, mutation PRAGMAs, imports, migration-list commands or reserved-prefix exemptions. This catalogue deliberately targets a hypothetical **fresh pre-ledger** database: it does not initialize a ledger or certify the initial versioned migration. Existing post-apply queries remain in [qualification-remote-operator.md](qualification-remote-operator.md) and `scripts/qualification-d1-manifest.ts`; they are not duplicated here.

`prepareObservationPacket({config,migration,source,wrangler})` accepts exactly four bounded supplied UTF-8 strings, hashes their actual bytes and returns an immutable original-reference packet. It does not read paths, verify source origin, confirm installed package provenance, bind real config IDs or authenticate human approval. The CLI's artifacts remain null because it cannot read files. Tests supply actual local config, migration, module and pinned installed Wrangler bytes; these are local hash evidence only. A copied packet is not the original capability.

`compareObservation(packet, expected, observed)` requires exact own-data envelopes with `packetHash,catalogueHash,sourceHash,origin,requestId,complete,results`. Origins are only `ordinary-local-sqlite` or `unverified-remote`; neither asserts attestation. Request ID is null or bounded nonsecret text. Complete must be true. Both result maps must contain exactly all fixed query IDs, bounded dense own-data arrays and exact query-specific scalar columns. Row order is preserved; column key order is fixed. Error objects, unknown IDs, accessors, symbols, inherited records, truncated snapshots and binding/hash mismatches yield UNKNOWN. Valid different snapshots yield MISMATCH; matching snapshots outside the narrow synthetic local shape yield UNKNOWN. No returned rows are echoed by comparison.

A MATCH additionally requires only the exact local `_cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)` object, its two exact visible columns, no indexes, one key-2 nonnegative safe-integer bookmark stored as integer, the three explicit ordinary SQLite schema/table-list entries, no FK violations and `quick_check=ok`. This is intentionally **not** a remote schema exemption. Even MATCH always returns `status=STOP`, `remoteReady=false`, `provenance=UNVERIFIED`, `remoteEquivalence=UNPROVEN`. Apparent source-hash consistency, caller expectations, request IDs and `complete=true` cannot certify authentic or primary remote provenance. A caller that disguises a failed query as an empty success cannot establish provenance; this API cannot authenticate capture. No remoteReady success path exists.

## Exact blocker and minimum future approval

> No supported remote path is qualified for exact _cf_METADATA schema, columns, indexes and key-2 integer bookmark contents; local physical preflight has no remote counterpart. Baseline guard unchanged.

Pinned local workerd denies the relevant internal reads. Public `_cf_KV` examples in the [D1 SQL documentation](https://developers.cloudflare.com/d1/sql-api/sql-statements/index.md), already discussed in the operator document, do not prove remote equivalence or authorize internal-table access. No network retrieval occurred in this task. Unsupported/absent metadata or forbidden readback stops; never change the baseline guard or fall back to `_cf_%`/`sqlite_%` exemptions, ad hoc SQL imports or empty results.

The smallest bounded future approval is **one newly created, dedicated synthetic-only `apacely-staging` D1 in the fixed account**, plus at most one execution of each fixed query after supported-visibility review and independent target/permission readback. Bind the genuine returned physical ID, exact reviewed artifacts/query hashes, operator, region, owner, expiry, explicit creation/query cost ceiling and retention to authenticated approval. No such approval is present. If supported metadata visibility remains unavailable, stop before issuing these candidate internal queries; request engineering/review, not an authorizer bypass. Failure stops with raw evidence and no retries/substitutes. Separately approve any changed supported catalogue.

Never query existing NoLater databases `3f9aef9a-a5be-4808-94e2-14b7d13316e8` or `dfb46cb7-a2f9-4426-99f4-45c5e2d046dc`. The API accepts no target selector. This request excludes migration/list/import, Workers/DO creation, deployment, Access, routes, DNS, secrets, traffic, upgrades, restore, production and live effects. It does not waive cost approval.

## Source inspection and evidence

The requested `manifests/staging-migrations` path is absent. Inspected actual `migrations/staging/0001_staging.sql`, `src/staging-migrations.ts`, existing operator catalogue and documentation. Pinned Wrangler `node_modules/wrangler/wrangler-dist/cli.js` lines 238932–238953 initialize the migration ledger via `executeSql`; migration-list lines 239359–239367 call that initializer before listing. Thus migration-list is excluded, not presumed read-only.

Durable raw RED/GREEN TAP, actual synthetic SQLite snapshot, CLI output/refusal, scoped compiler result, source hash manifest, counts and checkpoint are in `/root/apacely-staging-evidence/phase4/phase4b-closure/d1/`. That historical child execution covered five focused tests; the comparator's later independent IR1 re-review and regression evidence are separate. The current procedure verification below runs only guarded pure tests; baseline 347 D1 / 227 SQLite / 24 runtime suites, emulators, heavy builds, remote operations and historical DA11 investigation are excluded. Node's built-in SQLite prints its experimental-feature warning; it is not suppressed. Independent parent review remains pending. Local completion is not remote readiness or approval.

## Inspected pinned transport is not a supported exact-metadata method

Inspected installed Wrangler **4.149.0**, not a newer CLI or network response. The source inspection is bounded to these paths in `node_modules/wrangler/wrangler-dist/cli.js`:

| Surface / source lines | Observed implementation | Qualification decision |
| --- | --- | --- |
| `executeRemotely`, 237590–237705; `d1ApiPost`, 237785–237805 | Command mode sends supplied SQL to a general POST `/accounts/{accountId}/d1/database/{uuid}/query`; file mode instead initializes/upload/imports. Command mode itself does not initialize the migration ledger. | A fixed SELECT/inspection PRAGMA is a candidate read-only SQL request, but the transport accepts mutations too; no read-only capability or internal-table visibility guarantee is established. Not executed. |
| `d1InfoCommand`, 238260–238394 | Resolves database information and asks GraphQL for 24-hour analytics. | Control-plane size/state/query metrics are not internal SQL schema/column/index/key-2 contents. Not a substitute. |
| `getBookmarkIdFromTimestamp`, 239427–239442 | Fetches a Time Travel bookmark endpoint with an optional timestamp. | Time Travel bookmark is not the local-development integer metadata value; cannot fill the metadata-bookmark query. Not executed. |
| `initMigrationsTable`, 238932–238953; list handler, 239359–239367 | Executes migration-table initialization before listing. | Excluded because it may mutate a fresh target. |

No inspected surface establishes a supported method for **all exact internal metadata** required by the unchanged guard. This is a scoped source finding, not a proof that Cloudflare has no possible read-only endpoint. General SQL transport availability cannot resolve provider authorizer/visibility semantics. No CLI help, credentials, API or network executor was invoked in this procedure task; the existing official links are reference requirements, not fresh retrieval evidence.

## Frozen candidate query bounds

These are inert review inputs, not runnable remote commands. Catalogue SHA256 is computed over the exact ordered query objects by the pure planner; operators must preserve its emitted hash and packet hash rather than copying a guessed digest. No LIMIT is added to hide unexpected objects. Each query is permitted **at most once** only under a future approved supported-visibility path; any failure stops the sequence, with no automatic retry.

| ID | Exact SQL |
| --- | --- |
| inventory | `SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name` |
| table-list | `PRAGMA table_list` |
| metadata-columns | `PRAGMA table_xinfo('_cf_METADATA')` |
| metadata-indexes | `PRAGMA index_list('_cf_METADATA')` |
| metadata-bookmark | `SELECT key,value,typeof(key) AS key_type,typeof(value) AS value_type FROM _cf_METADATA ORDER BY key` |
| fk-check | `PRAGMA foreign_key_check` |
| quick-check | `PRAGMA quick_check` |

Parser bounds are 1,000 rows per query, exact query-specific columns, scalar strings at most 32,768 JavaScript code units, null or safe integers, no BLOB exports, and supplied artifact strings at most 32 MiB UTF-8 each. These are **comparison input bounds**, not provider scan/cost/transport limits. A future executor must separately specify and approve timeout, response-byte ceiling, scan/cost ceiling and cancellation/ambiguous-outcome handling before any request. It must reject excess/incomplete evidence, never truncate it to pass. Forbidden/BLOB/noninteger metadata remains UNKNOWN/STOP; no decoding trick or type coercion is authorized.

## Operator checklist and target/provenance guard

1. **Offline freeze:** record inspected HEAD, exact config/migration/source/installed Wrangler bytes and hashes, pinned package version and dependency provenance, complete seven-query catalogue/hash, and comparator review applicability. Reject changed bytes, redirected paths and symlinks; the pure API does not inspect filesystem provenance. Generate the original-reference packet from supplied text only; record packetHash. Keep physical ID null and approval absent until real independent discovery. No packet reference authenticates an approver.
2. **Approval boundary:** obtain a separately authenticated creation authorization for one new synthetic-only target in the fixed account. Creation is not performed here. Obtain its genuine control-plane physical ID/freshness record under that approval; never substitute a format-valid synthetic UUID or an existing NoLater database. Freeze those actual identities and the exact config binding in a separately reviewed external observation record. The existing packet has no target-ID/approval setter: do not pretend to bind it by spreading/rebuilding it. A future target-bound executor/record design requires independent approval and review.
3. **Visibility before SQL:** independently establish a documented supported visibility path for every candidate query, least-privilege effective permission, exact operator/account/database/region and approval expiry. Authenticate and bind creation and bounded query authority separately; authority for either does not grant migration/deployment. If exact metadata is unsupported or unknown, STOP **before** internal SQL. No observation path is qualified now.
4. **External capture contract (not implemented):** bind the exact packet/catalogue/source/config/installed-package hashes to a trusted capture manifest with actual account/database identity, primary/provenance evidence where available, authenticated operator, approval identity/actions/expiry/cost ceiling, real UTC start/end, transport status, provider request identifiers and each complete query success/error. Protect raw evidence with owner/access/retention controls outside Git; record query result hashes and ordering. Unknown primary or physical binding remains a blocker. A caller-provided `origin`, requestId or `complete=true` is only a consistency claim; never relabel it authenticated evidence. Do not log credentials or existing client data.
5. **Compare, never authorize:** feed complete bounded envelopes with every query ID to the unchanged comparator. Missing/errors/accessors/sparse arrays/extra fields/hash drift are UNKNOWN; drift is MISMATCH; narrow ordinary SQLite shape can MATCH. All outcomes still STOP/UNVERIFIED/UNPROVEN with remoteReady=false. Authentic capture and independently reviewed remote schema/guard engineering, then separately approved real versioned migration rollback/history qualification, are prerequisites for any future remote readiness decision.
6. **Contain and report:** unsupported metadata, changed target, forbidden read, timeout, incomplete/oversized capture, authority expiry or cost-bound uncertainty ends this observation run. Preserve raw failure and identity/hash evidence; do not retry, substitute queries, initialize a ledger, apply/import, alter authorizers or relax baseline guards. Obtain narrowly revised approval/review for any different catalogue or executor. Current source-key windows are not renewed or bypassed by observation approval.

## Current scoped executable verification

Run from `/root/apacely-platform` with installed dependencies only:

```sh
# Node22 built-in SQLite metadata fixtures; no native better-sqlite3 load.
TMPDIR=/root/apacely-staging-evidence/phase4/parent-tmp /root/apacely-toolchain/node-v22.23.3-linux-x64/bin/node --import tsx --import ./tests/network-guard.mjs --test --test-concurrency=1 tests/remote-d1-procedure.test.ts tests/remote-d1-observation.test.ts tests/qualification-operator-plan.test.ts
# Existing canonical catalogue uses installed better-sqlite3 built for ordinary Node20.
TMPDIR=/root/apacely-staging-evidence/phase4/parent-tmp node --import tsx --import ./tests/network-guard.mjs --test --test-concurrency=1 tests/qualification-d1-manifest.test.ts
```

The new procedure regression first failed on the absent complete subcase register (other three checks already passed and are audit coverage, not invented feature RED). The register preserves actual normative input/oracle cells for all 37 IDs, not a reduced private variant list. Current raw commands/TAP, source excerpts, preserved comparator/guard hashes, documentation/link checks and exact result manifest live at `/root/apacely-staging-evidence/phase4/phase4c-offline/d1-procedure/`. Exact-byte independent review remains parent-owned; no full suite/emulator/build/typecheck, remote query, creation, deployment, commit or publication is performed by this worker.
