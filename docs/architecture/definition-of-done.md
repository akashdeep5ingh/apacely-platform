# Definition of Done

## Scope and completion rule

Apacely is a shared multi-tenant managed lead-conversion platform for residential real-estate teams. A deployment is complete only when every required measurable verification check passes with evidence and production activation has separate explicit human approval. Looking correct, creating resources, or writing code is not sufficient.

This phase creates architecture documentation only. It does not claim the platform is implemented, integrations are connected, or operational checks have passed. Cloudflare is the future orchestration/backend layer; no Cloudflare resources or deployments are authorized now.

## Current architecture-phase acceptance

- Only system-overview.md, multi-tenant-design.md, security-boundaries.md, and definition-of-done.md under docs/architecture/ are added; existing README.md is unchanged.
- Read all four documents back from the remote commit and confirm the approved principles, shared/config distinction, and unresolved decisions are present.
- Compare the before/after commits: the changed-file set is exactly the four requested additions, with no implementation files or deployment configuration.
- Confirm the change is documentation-only and no deployment, Cloudflare mutation, or provider connection action was performed. An independent account-wide infrastructure audit is not implied by a GitHub diff.
- No SMS, voice, or final LLM provider is selected. Jev's exact judgment points remain open until approved.

## Shared verification versus tenant-specific evidence

Shared platform checks cover isolation, deterministic orchestration, adapter contracts, idempotency, retries, authorization, secrets handling, configuration validation, and approval gates. These are reusable and must be rerun when relevant shared behavior changes.

Each tenant has tenant/client-ID-linked configuration and evidence: approved source mappings, qualification rules, channel policies, integration mappings, configuration version, test records, and activation decision. Passing checks for one tenant does not prove another tenant's configuration. Prefer reusable shared tests over client-specific code. Never include secrets in test evidence, the repository, or D1.

## Required future verification matrix

The exact latency/availability targets and provider choices are unresolved; they must be defined before execution, not invented in a completion report.

| Check | Measurable pass condition | Required evidence |
| --- | --- | --- |
| Test lead ingestion | One authorized synthetic event creates or resolves the expected tenant-scoped lead/state; malformed or spoofed events are rejected | Tenant ID, fixture/event ID, resulting record, rejection results |
| Tenant isolation | Zero unauthorized disclosures or mutations across at least two synthetic tenant contexts, including colliding external/contact IDs | Negative tests for reads, writes, joins, caches, jobs, callbacks, exports, dashboards, and model context |
| Configuration isolation | Each context loads only its own validated configuration; invalid/missing context fails closed | Config versions and authorized/denied results |
| Deterministic orchestration | Approved transitions occur once; invalid transitions are denied; replay/retry does not duplicate external effects | State/event traces and duplicate-event results |
| SMS send and reply, if in scope | Authorized test message has provider-confirmed delivery; inbound reply maps to the same tenant/conversation | Redacted delivery receipt and inbound-event/record linkage |
| Voice, if in scope | Authorized test call reaches a terminal completed state and transcript/result maps to the same tenant | Redacted provider call status and transcript/result reference |
| Qualification/Jev | Approved qualification fields are stored; Jev runs only at approved judgment points; invalid/uncertain output takes a safe path | Input fixture, validated result, stored state, judgment/fallback trace |
| CRM, if in scope | Approved fields update the correct tenant's CRM record; CRM authority/conflict rules hold | External record ID, read-back, conflict/retry tests |
| Calendar, if in scope | Authorized test booking exists in the correct tenant calendar without duplicate/conflicting bookings | Calendar read-back and retry/conflict results |
| Dashboard | Authorized tenant sees the expected test data and cannot view another tenant's data | Positive/negative query/UI evidence |
| Provider replaceability | Shared contracts pass against mocks and selected adapters; vendor payloads do not become core state dependencies | Contract-test results and capability/migration review |
| Secrets/security | No credentials in repository/D1/logs; unauthorized ingress/callbacks rejected; least-privilege access verified | Redacted scan results and security test results |
| Live/production gates | Unapproved, suspended, revoked, or out-of-scope actions are blocked, including delayed jobs | Denied-action tests and scoped approval record |
| Failure/recovery | Timeouts and provider failures use approved bounded retry/escalation; recovery meets approved targets | Failure-injection results and recovery evidence |

No excluded integration may silently be called PASS. Mark it NOT RUN or N/A with the approved scope rationale. A required check that is blocked or fails prevents completion.

## Tenant #001 rollout sequence

1. Use Apacely as logical Tenant #001 with synthetic data and mocks before any paying client deployment. A second synthetic test context proves isolation; it is not a client activation.
2. Approve outstanding architecture decisions and a measurable test scope before implementation and resource creation.
3. Run shared logic and isolation tests without live external effects.
4. Only after separate integration authorization, connect selected providers and run approved recipient/calendar/CRM tests. No providers are connected by this document.
5. Capture all applicable matrix evidence for Tenant #001, including failure cases and safe rollback.
6. Obtain explicit human production-activation approval. A passing test suite does not activate production automatically.
7. For every paying tenant, validate configuration and rerun tenant-specific checks plus relevant shared/isolation checks before seeking activation approval.

Production activation, destructive changes, DNS/security changes, secret changes, irreversible infrastructure changes, and large-scale live messages/calls remain human-gated. Evidence gathering does not bypass these gates.

## Evidence and failure handling

Record environment, tenant ID, code/config revision, test fixture/event IDs, expected/actual result, provider/CRM/calendar read-back where applicable, timestamp, and reviewer/approval reference. Redact secrets and minimize personal data. Choose the evidence storage/access/retention policy before live tests; no new evidence files are authorized in this phase.

If a check fails: identify the cause, fix the process, rerun the check and affected regression tests, and report the final outcome with evidence. Missing evidence is not PASS. What is the most important thing we may be missing: successful single-tenant happy paths do not prove isolation, provider-failure safety, consent, or authority to activate production.

## Open questions

- What exact functional scope, SLOs, performance limits, recovery targets, and failure scenarios apply to the first release?
- Which SMS, voice, CRM/calendar, and replaceable LLM adapters must pass which capability tests?
- What are Jev's approved judgment fixtures, thresholds, structured output rules, and escalation criteria?
- Who approves integration tests and production activation, and where is redacted evidence stored?
- What legal/operational consent rules, large-scale thresholds, approval expiry, and rollback criteria are required?
