# Phase 4 synthetic admission policy profiles

## Status: partial implementation; readiness BLOCKED

Source baseline: `9613e43ac6021aae73960760c4a7db0e33be58e0`. This is an offline Node-only qualification slice, not a deployment policy or production tier. The [S01–S37 matrix](staging-readiness.md#7-exact-acceptance-matrix--all-remote-cases-not-run) remains authoritative. Four immutable captured named profiles are implemented in `src/qualification/policies.ts`; the published `src/staging-policy.ts` is byte-identical (SHA256 `cc93bce80d68330b6adbcea094c1d8923ef9eec753ef3507c1895736d43464a1`). No normal release composition imports these profiles.

**Important additional blocker:** nominal record/key limits do not establish actual capacity. The unchanged [distributed admission core](../../src/distributed-admission.ts) has a 65,536-character canonical state limit and conservative lifecycle-size reservation. With short synthetic authority fields, S30 admits only **68** settled arrivals, then rejects arrival69 as `state-size`; S29 source cardinality admits only **58** distinct settled sources, then rejects source59 as `state-size`. Consequently the 100/101 source-rate and 128/129 source-key oracles cannot pass merely by changing policy limits. Both exact readiness tests remain failing deliberately; there is no weakened acceptance oracle, skip or fabricated PASS. Longer legal authority names can reduce the effective capacity further.

## Explicit separate bounds

All rates below are arrivals per 10,000ms fixed window, not live owner counts. Records, tenant keys and source keys are permanent finite tombstones; terminal owners still occupy records. All profiles have reservation/diagnostic TTL30,000ms and controlAttempts2. TTL never reclaims ACTIVE/QUARANTINED work. No evictions, resets, recycling or automatic takeover are provided.

| Named export | Scenario | Aggregate / tenant / source live caps | Tenant / source key caps | Admission budget + record headroom = recordCap | Aggregate / tenant / source arrival rates |
| --- | --- | --- | --- | --- | --- |
| `contention16` | S14 or S15, separate fresh runs | 16 / 16 / 16 | 16 / 16 | 16 + 16 = 32 | 1000 / 1000 / 1000 |
| `capacity16Source4` | S16; S29 held permits | 16 / 16 / 4 | 16 / 16 | 64 + 16 = 80 | 1000 / 1000 / 1000 |
| `sourceKeys128` | S29 129th-source rejection | 256 / 256 / 256 | 16 / **128** | 129 + 16 = 145 | 1000 / 1000 / 1000 |
| `sourceRate100` | S30 sequential settled admissions | 16 / 16 / 4 | 16 / 16 | 100 + 16 = 116 | 1000 / 1000 / **100** |

Headroom is a nominal record allowance for independently owned control tombstones, not reserved space or a claim of usable encoded-state capacity. Source-key qualification uses one tenant so tenant-key capacity cannot confound rejection. Rates/live caps are deliberately nonconfounding there. S30 settles each admitted owner before the next; aggregate and tenant rates exceed100. After storage-capacity remediation, source attempt101 must deny `rate-source` with Retry-After1–60 before nonce/business effects. The first128 source keys must survive settlement, and distinct source129 must deny `keys`, not `records`, `state-size`, live caps or rates.

## Identity and isolated storage

Each profile owns a distinct stable UUIDv4 epoch (suffix000001–000004), core-compatible SHA256 policy digest and deterministic namespace label containing name, epoch and digest. Digest hashes the complete captured validated canonical policy, including every cap, rate, duration and control budget. A changed field changes the digest or fails core validation. Exported profiles, policies, scenario arrays and the catalogue are frozen. `captureQualificationProfile` accepts only original constant object identities, never names, clones, getters, environment variables or requests.

`bootstrapQualificationNamespace(profile, storage, namespace, now)` is an explicit offline harness helper. It requires the exact original profile and namespace label before touching storage, then delegates to the core's atomic fresh-only bootstrap. Reapplying the same profile or another profile to initialized storage rejects without mutation. A changed coordinator policy over existing storage fails closed as `storage-corrupt`; a foreign-profile ticket is denied as `policy` before mutation. The storage namespace label is an assertion by trusted harness composition, not cryptographic proof of physical namespace birth.

For each distinct profile allocate a genuinely dedicated fresh namespace; do not switch policy on previously initialized storage. For multiple cases/repetitions of one profile, allocate additional distinct physical targets/run identities while retaining that profile's expected namespace label. Never clear an old target to manufacture freshness. No profile selector, tier, fault or initialization endpoint may be added to the ordinary release entrypoint.

## Execution and evidence

Evidence is outside Git at `/root/apacely-staging-evidence/phase4/policy/`:

- `red-01.log`: module-presence regression failed (1fail); `green-01.log`: immutable profile slice passed1/1.
- `red-02.log`: original identity-capture regression failed (1pass/1fail); `green-02.log`: identity plus fresh-only bootstrap slice passed2/2.
- `readiness-03-corrected.log`: first capacity observations; additional failures were test-harness null-prototype comparisons and a TTL mutation exceeding the legal bound, not application defects. Harness corrected, core unchanged.
- `final-exact.log`: final test-byte rerun confirms **9tests / 7pass / 2fail**, zero skipped/cancelled/todo. `typecheck-final.log`: targeted strict NodeNext/ES2022 TypeScript check of these source/test files and their imports exits0. This is not the canonical whole-project typecheck or full suite.
- `final-focused-retry.log`: 9tests, **7pass / 2fail**, zero skipped/cancelled/todo; genuine failures are S30 and S29 source-key capacity. Existing-core audit tests do not acquire invented RED/GREEN implementation history.
- An earlier `readiness-03.log` was a transform failure after a filesystem tool accidentally included `bash: fork: retry: Resource temporarily unavailable` in edited text; that line was removed. Automatic single-file lint repeatedly used unsuitable compiler defaults or timed out. An outer run (`final-focused.log`) stalled before any test result under shared PID pressure; only its verified expired owned shell/Node descendants were terminated. Unrelated/sibling processes were left untouched. The completed retry used bounded thread settings, with the same no-network guard and no emulator.

Focused command: `UV_THREADPOOL_SIZE=1 GOMAXPROCS=1 timeout 150 node --import tsx --import ./tests/network-guard.mjs --test --test-concurrency=1 tests/qualification-policies.test.ts`. Real core Request/Response codec and transaction-capable memory storage are exercised directly. No global fetch, socket, DNS, emulator, Miniflare, workerd or Wrangler is used. Memory tests are sequential; they do not certify distributed concurrency, SQLite durability, actual Worker HTTP, D1 effects or remote behavior.

## Prepared integration requirements / no-go

1. Coordinator/core owner must remediate encoded-state capacity within an explicitly reviewed bounded design, preserving descriptor validation, permanent owner/key tombstones, fail-closed exhaustion, atomic ownership and lifecycle-size guarantees. Merely raising recordCap is insufficient. This file scope does not authorize changing that core. Retain the two exact failing regressions and bring them GREEN without lowering100/128, resetting, evicting or reclaiming history.
2. Serialized emulator owner should import an original profile at trusted construction/build time, pass its exact captured policy to bootstrap/coordinator/admission, use a fresh dedicated physical namespace, and freeze build/policy/epoch/digest/birth evidence together. The fixed core object name remains `distributed-admission-v1`; isolate by physical namespace, not request-selected object names.
3. Run S14 and S15 separately with actual16 contenders/barriers; run S16 with64 contenders and four held same-source grants. Exercise independent16-aggregate/4-source limits and charged timeout/quarantine. Node owner-count checks are not the matrix's event/nonce or concurrency proof.
4. After capacity is genuinely fixed, execute full S29 key and S30 rate paths against the same retained core storage, with before/after nonce/business-table and permit observations; no denied nonce or business delta. Namespace setup/control overhead must fit explicit headroom without consuming the scenario's arrival budget.
5. Require independent review and parent-owned full/typecheck/build release checks before offline publication. No commit, publication, dependency edits, remote action or full suite was performed by this slice.

Security/readiness verdict: **FAIL/BLOCKED**, because exact mandatory capacity oracles fail. Identity/input validation, finite exhaustion, policy mismatch and held-owner quota tests pass locally; authentication/providers/PII/D1/remote checks are outside this slice, not remote PASS. Dependency audit NOT RUN; no dependencies changed. Historical DA11 transport cause and disposed-runtime state remain **UNKNOWN**; these deterministic memory results neither reproduce nor resolve them. All remote S01–S37 remain NOT RUN. Production support, deployments, Cloudflare creation, secrets, public endpoints, DNS/security changes, subscriptions/spending and live effects remain unauthorized.
