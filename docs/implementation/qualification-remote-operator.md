# Remote D1/operator qualification — offline preparation only

**STOP / remote readiness NOT VERIFIED.** These artifacts are an executable offline planner and comparison catalogue, not a remote runner, resource approval or evidence of remote equivalence. Remote S01–S37 remain NOT RUN. Nothing here authorizes spending, subscriptions, resources, deployment, Access, DNS, secrets, public endpoints, production or live effects.

## Executable surface

From the repository, with its already installed Node/tsx and no credentials:

```sh
node --import tsx --import ./tests/network-guard.mjs scripts/qualification-operator-plan.ts plan --offline
node --import tsx --import ./tests/network-guard.mjs scripts/qualification-d1-manifest.ts manifest --offline
node --import tsx --import ./tests/network-guard.mjs --test --test-concurrency=1 tests/qualification-operator-plan.test.ts tests/qualification-d1-manifest.test.ts
```

The two CLI argument vectors are exact allowlists. Additional modes, flags, wildcards, config redirects, SQL/file inputs and shell-redirection tokens are rejected. The scripts contain no subprocess, fetch, remote API, file reader/writer or SQL executor. Shell redirection outside the argv boundary is inherently controlled by the invoking shell, not by a pure planner; do not use the output as an executable command. The scripts output JSON only. Existing `scripts/staging-release.ts`, `scripts/staging-migration.ts`, migration and baseline configs remain unchanged. The requested `scripts/migration.ts` does not exist; the actual generator is `scripts/staging-migration.ts` with `src/staging-migrations.ts`.

### Pure APIs and exact packet

`validateOperatorPacket(value)` accepts only ordinary own-data fields, rejects unknown fields/accessors/symbols/inherited authority, and returns a frozen packet with a deterministic SHA256. Its exact fields are:

- `environment`: exactly `staging`.
- `accountId`, `namespaceId`: exact lowercase 32-hex nonzero identifiers. These are distinct kinds of inventory identity, not credentials. No real identifiers were obtained in this task.
- `databaseId`: exact lowercase UUIDv4, excluding the committed placeholder.
- `databaseName`: `apacely-staging`; `workerName`: `apacely-ingress-staging`.
- `coordinatorName`: `distributed-admission-v1`; `configPath`: `wrangler.staging.jsonc` only.
- `artifacts`: exactly `config`, `migration`, `bootstrap`, `sealed`, `source`, each a lowercase SHA256. `source` means a frozen, independently reviewed source-file hash manifest; bootstrap/sealed mean the exact generated bundle bytes, not source filenames.
- `approvals`: exactly three distinct nonsecret references matching `approval-[a-z0-9-]{1,80}`, keyed by the three approval classes below.

Identifiers in unit tests are synthetic format examples, never account discovery or approved targets. No credentials, key values, tokens, arbitrary URLs, routing patterns or executable commands are accepted. `verifyArtifactBytes(packet, value)` compares supplied UTF-8 text bytes to the five hashes; it cannot open paths or follow symlinks. Binary artifacts are unsupported. Path provenance, physical file identity, actual config-to-account/D1/namespace binding, region, authenticated operator permissions and human approval authenticity are **NOT VERIFIED**. Packet validation is not a substitute for these checks. The currently committed configs intentionally retain zero-ID placeholders; a packet with proposed nonplaceholder IDs cannot make them deployable.

Human approvals must independently name the packet hash, action list, resource identities, artifact hashes, region, operators, cost ceiling, evidence-retention rules, incident owner and expiry. A reference string or document saying “approved” proves none of that. Do not rebind a packet to a different namespace, database, object name or build after review.

| Approval class | Separately authorized effects | Does not grant |
| --- | --- | --- |
| `resource-closed-deployment` | Dedicated new staging resource provisioning, versioned initial migration, reviewed one-time private birth and closed bootstrap→sealed deployments; separately enumerated secret-slot provisioning via secure tooling | Access/routing, public traffic, fault injection, restore, production or live consumers |
| `access-routing` | Exact protected transport, strict Service Auth policy and approved synthetic traffic, after closed deployment readback | Resource substitution, destructive faults, restore or live effects |
| `fault-restore` | Exact isolated scenario/build, bounded attempts, named containment and replay-preserving recovery exercise | Ordinary reset/delete/rebirth, blanket fault authority, bypass of Access or reopening after unsafe restore |

Secret values never belong in packets, SQL, args, logs or evidence. Actual secret actions require their own explicit action list and secure entry mechanism. All three classes remain unapproved here. Even possession of all references leaves `remoteReady=false` and execution unavailable.

## Fixed read-only D1 catalogue

`d1Manifest(['manifest','--offline'])` returns an immutable catalogue and its hash. Queries cover:

1. Full `sqlite_schema` inventory (`type,name,tbl_name,sql`), including triggers, indexes and all unexpected/system objects; `PRAGMA table_list` as an independent visibility check.
2. `PRAGMA table_xinfo`, `foreign_key_list`, `index_list`, table counts for every canonical application table and `d1_migrations`.
3. `PRAGMA index_xinfo` for every fixed canonical application index and the migration-name uniqueness index. New/absent indexes must fail comparison, not create a dynamically expanded query allowlist.
4. `PRAGMA foreign_key_check`, `quick_check`, the physical staging marker, complete ordered migration history and `sqlite_sequence`.
5. Per-tenant counts for replay and the six business tables, with no body, contact text, nonce, signature, payload or secret export.

The catalogue contains no mutating PRAGMA, import, reset, `SELECT *`, user-selected identifier, statement concatenation or application-row dump. Counts/schema readback is not evidence of immutable row bytes or outbox payload correctness: scenario evidence separately needs protected same-primary snapshots/hashes of relevant synthetic rows and replay/revocation history. Counts alone cannot prove S02/S03/S21/S24 replay preservation.

`verifyD1Readback({catalogueHash,expectedHash,expected,observed})` requires exactly one complete query-id→row-array snapshot for each side, bounded rows and scalar values, no error envelopes or unknown query IDs. `expectedHash` is SHA256 of `JSON.stringify(expected)` in its explicit supplied order; preserve that order when recording evidence. Comparison sorts row-column keys, preserves row order and reports mismatching query IDs without echoing rows. Differently ordered PRAGMA results conservatively mismatch and require reviewed canonical ordering, not omission. A truncated, unauthorized, failed or missing query is UNKNOWN→STOP; never turn it into an empty array. A byte/hash match returns `comparison=MATCH` **and** `status=STOP`, `remoteEquivalence=UNPROVEN`, `remoteReady=false`. Caller-provided expectations and hashes are not trusted remote provenance. This API intentionally cannot issue a remote PASS.

### Exact metadata limitation — do not relax the existing guard

Public Cloudflare [SQL documentation](https://developers.cloudflare.com/d1/sql-api/sql-statements/index.md) says `table_list` includes system-maintained tables and illustrates a remote `_cf_KV` (two columns, WITHOUT ROWID). It documents schema/index/FK inspection and `sqlite_master` queries. That example is **not** a guaranteed immutable definition/content contract for every current remote internal object. No retrieved documentation establishes that remote D1 has the pinned local `_cf_METADATA` layout or exposes its contents, or grants an internal-table authorizer bypass.

The current migration explicitly requires `_cf_METADATA(key INTEGER PRIMARY KEY,value BLOB)` in schema inventory. The local wrapper additionally physically validates exact columns/indexes/one key-2 integer bookmark using the pinned Node22 read-only SQLite reader. Local workerd forbids content/table-info access to this internal table. That physically observed advancing **local-development** bookmark is neither migration history nor a remote Time Travel bookmark. There is no remote filesystem counterpart available to this offline planner.

Therefore a remote empty target with only documented `_cf_KV`, absent `_cf_METADATA`, different internal schema, forbidden readback or an unrecognized system object is **STOP**, not an exception. Do not adopt `_cf_%`/`sqlite_%` blanket exemptions, transplant the physical local check into a remote assumption, patch SQL ad hoc, or call a failed import “equivalent.” A remote-capable initial guard requires separately authorized engineering: exact observed remote inventory and metadata visibility contract, narrowly validated supported metadata, preserved application-empty/history guards, real remote versioned rollback qualification and independent review. The baseline local guard remains byte-exact and is not certified remote-ready by these artifacts.

## Ordered future operator procedure (not executable here)

1. **Containment first:** independently inventory exact account, Worker, D1, SQLite namespace, fixed object, region and ownership. Dedicated synthetic-only staging; no production bindings. Pin permission scopes and operator identity. Disable ingress/effects/consumers/routes/workers.dev/preview URLs. Verify protected alternate-route denial. Capture artifact/config hashes and separately approved actions; preserve the baseline offline wrapper rather than removing guards.
2. **Read-only discovery:** after explicit scoped authorization, obtain target identity and unfiltered schema/system inventory. Migration-list is not assumed read-only: pinned Wrangler creates its ledger if absent before listing. Do not use it as a supposedly zero-mutation empty-target oracle. Unknown remote metadata stops before first apply. The post-apply catalogue requires application/ledger existence; on pre-apply empty targets, missing tables mean “not applicable at this phase,” never fabricate successful empty results.
3. **First migration:** only after the remote guard gap is resolved, inspect exact one-file migration inventory and canonical bytes, initial empty application state, exact empty ledger/system state and pre-operation bookmark. Use the approved versioned runner, not direct SQL import. Pinned Wrangler `buildMigrationQuery` appends the history insertion to the migration SQL and sends that unit to `executeSql`; initial ledger creation can occur separately. Its installed help says a failed migration rolls back, while earlier successful migrations remain applied. Public [D1 batch documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/index.md) describes rollback of the whole batch on statement failure. Neither source proves an unexecuted remote runner's behavior. Require real remote first-apply/failure evidence, including history insertion failure and a failure after it, with unchanged application/history/sequence before and after; an empty ledger table created during runner setup need not disappear.
4. **Post-apply:** compare full canonical tables, triggers, tenant FKs, indexes and marker, one exact `0001_staging.sql` history row, valid timestamp and ledger sequence; zero fixture tenants/mappings/replay/business rows, empty assertion tables, no FK violations and `quick_check=ok`. Record execution/primary metadata where available without assuming absence means primary. Require full readback and provenance, not “CREATE IF NOT EXISTS succeeded.” A separately approved runner no-op must preserve schema/history/application rows; local bookmark advancement is not schema drift. No repeated blind apply after timeout/error; stop, preserve request/result evidence and read back the same target before deciding whether anything committed.
5. **Birth and sealed transition:** use the separately reviewed private initializer/birth manifest and exact new-namespace provisioning evidence. Missing storage is not proof of first birth. Remove bootstrap/private initializer authority and verify sealed build/namespace/object state before routing. This document does not certify a sibling initializer or create a caller.
6. **Access/routing and S01–S37:** separately approved protected transport and fixture scope only after closed deployment readback. Follow the [acceptance matrix](staging-readiness.md#7-exact-acceptance-matrix--all-remote-cases-not-run) and [fault manifest plan](qualification-fault-plan.md). Normal release has no scenario selector, clock/tier header, admin route or fault authority.
7. **Failure/recovery:** contain first; keep ingress/effects and consumers disabled. Preserve latest immutable replay owners/deadlines/tombstones, revocation versions, acknowledged event/outbox identities and coordinator pending charges before any restore. Unknown issued work stays indefinitely charged; retain approved finite tombstone exhaustion, no takeover/reset. [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/index.md) is destructive, overwrites D1 in place and cancels in-flight queries; it does not roll back coordinator history or external acknowledgements. Record pre/restore/undo bookmarks under separate fault/restore approval. Do not restore D1 until replay preservation and a tested reconciliation strategy exist. No automatic replay-history merge tooling is implemented here. Loss of replay/revocation/history is NO-GO; rollback of Worker code is not rollback of DB/DO data. Reopen only after demonstrated reconciliation and old proof/key/session denial with zero duplicate outbox. Otherwise quarantine and escalate.

## Current evidence and gaps

Evidence lives outside Git at `/root/apacely-staging-evidence/phase4/operator/`: named strict RED/GREEN logs, focused no-network Node tests, scoped TypeScript check, emitted catalogue/plan, baseline byte-preservation and final SHA256 manifests. Tests execute catalogue SQL against ordinary in-memory canonical SQLite, **not** an emulator or remote D1; expected snapshots in tests are generated from that real local database, not fabricated remote responses. Full release/regression/package qualification is parent-owned and not run by this worker.

Offline remaining engineering: supported remote metadata/empty-target guard, credential/permission/config-bound approved operator executor, provenance-bearing protected readback and replay-preserving restore tooling; scenario-specific runtime executors described below are absent. Remote-only remaining evidence: exact identities/permissions/costs/approvals, empty-target and first-migration rollback/history, primary D1 semantics, private birth/sealed removal, strict real Access policy and alternate-route containment, all S01–S37 including cross-region contention, disconnect/termination/CPU and restore. The planner reports these gaps instead of inventing remote readiness. Historical DA11 cause remains UNKNOWN under the existing accepted offline uncertainty; it is not reopened or explained by current unit success.
