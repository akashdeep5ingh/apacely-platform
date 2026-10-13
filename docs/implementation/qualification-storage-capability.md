# Qualification-only storage capability

## Scope and invariants

This is an offline synthetic component, not a production quota change, deployment approval, or remote freshness proof. The baseline canonical state bound remains **65536** ASCII characters. Only the original trusted capability for one of the four reviewed fixed SQLite compositions selects **262144** characters. The admission message maximum remains **8192**. Admission policy, policy/ticket digests, the `distributed-admission-v1` domain/object name, source ownership, fences, clock high-water, rate windows, and charged quarantine semantics are unchanged.

The capability is an opaque frozen original-reference token in a private WeakMap. Profile and fixed-policy selectors reject clones, strings, accessors and proxy lookalikes without reading their fields. The offline wrapper requires the original named profile, its exact trusted namespace and SQLite backing; legacy KV backing is rejected. The internal fixed registrar checks the exact reviewed digest/namespace allowlist and the actual policy digest. It exposes no numeric budget parameter. No HTTP, environment variable, parsed profile name or tenant payload selects the budget. Tokens, policies and bound coordinator collaborators are captured synchronously before asynchronous work. This is trusted import authority, not operator permission or proof of the physical remote namespace.

The fixed policy capability factory hashes canonical policy bytes synchronously. It does **not** create a random ticket at module initialization: actual workerd startup demonstrated that the inherited ticket-based digest calculation was invalid in global scope.

## Durable configuration and atomicity

The dedicated key `distributed-admission/storage-budget/v1` stores exact immutable JSON with `version:1`, `representationVersion:1`, `maxStateChars:262144`, `policyDigest` and `namespace`. Its identity is separate from the unchanged admission policy digest.

Fresh qualified bootstrap atomically creates state and this seal only when both are absent. The first-birth wrapper additionally creates the existing birth marker in the same transaction. Existing state, seal-only, state-only, mismatched or corrupted stores are never repaired, upgraded, reset or reseeded. There is no migration/downgrade, reclamation, eviction or namespace/profile switching mechanism.

Every qualified coordinator transaction compares all seal bytes before parsing state; missing, malformed, extra-field, lower/higher-budget, version, digest or namespace mismatches fail closed. A default coordinator rejects a qualified seal even when the state is still below 65536 characters. Both fresh initialization and sealed validation capture configuration before their first await. Qualified sealed validation expects exactly state, birth and seal, and uses the capability-aware complete core decoder. Default validation still expects exactly the original two keys. The SQL schema guard is unchanged and does not grant broad reserved-prefix exemptions.

The same captured bound is used by the encoder, preparse decoder, conservative longest-lifecycle allocation check, both reserve/absent-cancellation rollback decodes, bootstrap and sealed validation. Failed tentative allocations retain existing owners, keys, fences and arrival counters while preserving legitimate earlier lifecycle/clock work. Terminal recovery remains possible at finite capacity. Neither history nor charged ACTIVE/QUARANTINED ownership is reclaimed.

## Fixed pairs

All four pairs explicitly construct `fixedStorageCapability(policy,'sqlite')` and pass that original token to initialization, validation and the sealed core:

- `contention16-bootstrap.ts` / `contention16-sealed.ts`
- `capacity16-source4-bootstrap.ts` / `capacity16-source4-sealed.ts`
- `source-keys128-bootstrap.ts` / `source-keys128-sealed.ts`
- `source-rate100-bootstrap.ts` / `source-rate100-sealed.ts`

Their policies, epochs, namespaces, class/object names, migration/config/database identities remain unchanged. Configuration intent and local SQLite execution do not establish remote physical identity or freshness. Baseline policy/config/migration/release-wrapper defaults were not edited by this component owner.

## Local verification and provenance

Evidence is retained outside the repository under `/root/apacely-staging-evidence/phase4/capacity/recovery/`; the previous architecture review and RED/GREEN logs were preserved. The full independent architecture regression checklist was read before resuming inherited partial work.

Vertical observed RED/GREEN evidence covers the qualified absent-cancellation boundary, qualified three-key sealed initialization/validation, all four artifact capability wires, rejection of unreviewed registrar configurations, and the actual workerd global-randomness defect followed by pure digest calculation. Additional rejection/default/max-width tests characterize already-inherited behavior; they are not falsely attributed new RED-first implementation history.

Focused guarded execution covers:

- Exact **100** admitted/settled arrivals followed by the **101st** source-rate denial, without advancing the ten-second window.
- Exact **128** retained sources followed by **129th** source-key denial.
- Default 65536 enforcement on reserve and absent cancellation with longest legal authority fields, allocation rollback and later owned ACTIVE/QUARANTINED terminal recovery.
- Original-reference capture, foreign policies/backing/namespaces, clone/accessor/proxy inputs, bootstrap interruption, seal-only/state-only/rebootstrap and seal mutation/canonical/size corruption negatives.
- All four full record/key/tenant capacities with longest legal authority/mapping/time/fence widths; RESERVED, ACTIVE, QUARANTINED, RELEASED, CANCELLED and EXPIRED states; restart, repeated inspect and no history reclamation.
- Actual SQLite-backed DO bootstrap and same-namespace sealed restarts for all four fixed pairs, three exact keys, post-write transaction failure rollback, enlarged persisted canonical state, full record-capacity terminal recovery, corruption denial and no repair on rebootstrap.

Observed maximum-width terminal state lengths (characters/ASCII bytes, not CPU or remote-throughput guarantees): contention16 **50549**, capacity16-source4 **120004**, source-keys128 **230977**, source-rate100 **172096**. Admission checks also exercised conservative future-lifecycle bounds during every allocation; the analytic architecture-review upper bounds remain separate evidence.

The capability file registers fourteen ordinary unit tests. Its actual SQLite oracle registers only during an explicitly owned guarded loopback execution, yielding fifteen tests in that mode; it never starts an emulator in ordinary network-denying unit execution. This grouped runtime oracle is one test, not four independent tests. Pinned runtime: Node **22.23.3**, CPU affinity **0**, `UV_THREADPOOL_SIZE=1`, `GOMAXPROCS=1`, strict body-consumption diagnostics and loopback guard. All dispatched response bodies are consumed.

The final focused guarded run passed **25/25** tests (nine policy tests, fifteen capability tests including one grouped actual-SQLite oracle, and one baseline bundle-separation test); the focused capability-only ordinary unit mode has fourteen tests. The selected unchanged core rerun passed **8/8**, and selected artifact parity/bundle/config tests passed **3/3**. These counts are scoped runs, not additive full-release counts. The final focused run still emitted four RPC-stub disposal warnings from the test harness; assertions and strict response-consumption checks passed, but output was not warning-free. No warning suppression or compatibility change was introduced.

A qualified `state-size` allocation rollback cannot be forced with legal full-capacity state under these exact reviewed profiles: their conservative maximum widths fit 262144. Both rollback decode branches now explicitly share the captured bound and are exercised by the default-bound state-size regressions; no unreviewed custom policy/budget or fabricated enlarged state was used to manufacture qualified rollback execution. Large qualified restart/codec/terminal paths and ordinary quota-denial retention are exercised separately.

Independently selected core regressions cover SQLite reboot, rate/clock rollback, finite key/record saturation, ownership negatives, expiry/quarantine, corruption, fence exhaustion and exact R32 terminal headroom. Artifact parity/bundle/config tests are separately scoped. See the external result/hash manifest for actual counts, final file/log hashes and limitations; repeated runs are not additive unique-test counts.

## Remaining parent integration gates and limitations

- Full integration/full-suite/build/final independent-byte review remain parent-owned. No component count substitutes for full S14/S15 contender matrix outcomes, S16 HTTP 4-of-64, or S29/S30 authenticated HTTP nonce/business-vector assertions and unchanged original-primary readback.
- `tests/staging-runtime/qualification-artifacts-runtime.test.ts` has an inherited two-key birth assertion. Its owner must wire the approved three-key expectation; this component owner did not edit that cross-owned test file.
- An attempted broader core run exhausted the existing 512 MiB `/tmp` filesystem and emitted `SQLITE_FULL` before timing out; it is not a complete core-suite PASS. Only this worker's stopped-run fixture directories were relocated intact with per-file hash verification to external evidence, preserving their bytes and old logs. The unchanged selected core rerun then passed. The parent must arrange sufficient scratch headroom before a full run, without deleting historical evidence or changing application guards.
- Initial runtime harness startup failure and disposal-warning experiments are retained, not overwritten. Runtime warnings must be reported separately from assertion counts; no strict-consumption flag was disabled or error suppressed.
- Historical DA11 provider/transport cause remains **UNKNOWN**. Current focused passes do not resolve it. Remote backing identity, freshness, metadata, deployments and all remote/provider fault scenarios remain NOT RUN/UNPROVEN.
- No dependency/package/global configuration, commit, publication, remote resources, secrets, Access, DNS, live endpoints/messages/subscriptions or spend changes were performed by this component owner.

Release security status remains **FAIL/pending parent integration and independent final-byte review**, not a deployment authorization. Local input/capability/ownership/default-bound/SQLite atomicity negatives are exercised; providers, LLM and client PII operations are outside this synthetic component. No dependency change was made; dependency audit is parent-owned/NOT RUN here.
