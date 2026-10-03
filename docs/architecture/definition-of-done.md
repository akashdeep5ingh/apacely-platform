# Definition of Done

## Scope and completion rule

Apacely is a shared multi-tenant managed lead-conversion platform for residential real-estate teams. A deployment is complete only when every required measurable verification check passes with evidence and production activation has separate explicit human approval. Looking correct, creating resources, or writing code is not sufficient.

This phase creates architecture documentation only. It does not claim the platform is implemented, integrations are connected, or operational checks have passed. Cloudflare is the future orchestration/backend layer; no Cloudflare resources or deployments are authorized now.

## Current V1 documentation-phase acceptance

- Update the four existing architecture documents and add only event-model.md and provider-adapters.md under docs/architecture/; README.md remains unchanged.
- Read all six documents back from the committed revision; confirm approved V1 decisions replace superseded open questions and remaining decisions are explicit.
- Compare before/after commits: only these six architecture Markdown documents change, with four modifications and two additions. No implementation or deployment configuration is added.
- No deployment, Cloudflare mutation, secret change, or provider connection action is performed. A GitHub diff is not an independent account-wide infrastructure audit.
- Workers, D1, Queues, Workflows, opaque generated tenant IDs, event-driven normalization, and the three environments are approved. R2 is deferred; final providers remain unselected.

## Shared verification versus tenant-specific evidence

Shared platform checks cover isolation, deterministic orchestration, adapter contracts, idempotency, retries, authorization, secrets handling, configuration validation, and approval gates. These are reusable and must be rerun when relevant shared behavior changes.

Each tenant has tenant/client-ID-linked configuration and evidence: approved source mappings, qualification rules, channel policies, integration mappings, configuration version, test records, and activation decision. Passing checks for one tenant does not prove another tenant's configuration. Prefer reusable shared tests over client-specific code. Never include secrets in test evidence, the repository, or D1.

## Required future verification matrix

The exact latency/availability targets and provider choices are unresolved; they must be defined before execution, not invented in a completion report.

| Check | Measurable pass condition | Required evidence |
| --- | --- | --- |
| Test lead ingestion | One authorized synthetic event creates or resolves the expected tenant-scoped lead/state; malformed or spoofed events are rejected | Tenant ID, fixture/event ID, resulting record, rejection results |
| Tenant isolation | Zero unauthorized disclosures or mutations across at least two synthetic tenant contexts, including colliding external/contact IDs | Negative tests for reads, writes, joins, caches, jobs, callbacks, exports, dashboards, and model context |
| Environment isolation | Development/staging/production data, bindings, jobs, and integration mappings do not cross environment boundaries | Positive/negative API, queue, workflow, and configuration tests |
| Generated tenant identity | Tenant #001 and synthetic peers use the same opaque ID mechanism; business names are not IDs | Fixture creation and invalid/colliding ID tests |
| Event normalization | Core logic receives validated shared events, not vendor payloads; duplicate and out-of-order events are safe | Adapter fixtures, schema/version rejection, replay and ordering tests |
| Durable/asynchronous processing | Queues and Workflows preserve tenant/environment context through retries and waits without duplicate effects | Failure/replay/resume tests and persisted workflow references |
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
2. Specify the first-slice scope and remaining blocking implementation decisions. Use the approved Workers/D1/Queues/Workflows architecture and opaque tenant IDs. Implementation and resource creation still require separate authorization; this phase authorizes neither.
3. Run shared logic and isolation tests without live external effects.
4. Only after separate integration authorization, connect selected providers and run approved recipient/calendar/CRM tests. No providers are connected by this document.
5. Tenant #001 must reach staging and pass all applicable Definition of Done checks, including failure cases, environment isolation, and safe rollback. Development success alone is insufficient. Providers outside the approved slice are N/A, never falsely PASS.
6. Obtain explicit human production-activation approval. A passing test suite does not activate production automatically.
7. For every paying tenant, validate configuration and rerun tenant-specific checks plus relevant shared/isolation checks before seeking activation approval.

Production activation, destructive changes, DNS/security changes, secret changes, irreversible infrastructure changes, and large-scale live messages/calls remain human-gated. Evidence gathering does not bypass these gates.

## Evidence and failure handling

Record environment, tenant ID, code/config revision, test fixture/event IDs, expected/actual result, provider/CRM/calendar read-back where applicable, timestamp, and reviewer/approval reference. Redact secrets and minimize personal data. Choose the evidence storage/access/retention policy before live tests; no new evidence files are authorized in this phase.

If a check fails: identify the cause, fix the process, rerun the check and affected regression tests, and report the final outcome with evidence. Missing evidence is not PASS. What is the most important thing we may be missing: successful single-tenant happy paths do not prove isolation, provider-failure safety, consent, or authority to activate production.

## Open questions

- What exact functional scope, SLOs, performance limits, recovery targets, and failure scenarios apply to the first release?
- Which SMS, voice, CRM/calendar, and replaceable LLM adapters must pass which capability tests?
- What fixtures, triggers, thresholds, outputs, and escalation criteria implement Jev's approved genuine-intent, qualification-sufficiency, handoff-readiness, and ambiguous-next-action categories?
- Who approves integration tests and production activation, and where is redacted evidence stored?
- What legal/operational consent rules, large-scale thresholds, approval expiry, and rollback criteria are required?

## Decisions that block first-slice implementation

- Define the end-to-end first-slice behavior and scope: entry point, qualification fields, terminal outcome, which actions/Jev categories are exercised, mock-only versus later live tests, and explicit acceptance fixtures. No first-slice scope is assumed here.
- Specify the minimum authorized tenant/user or source binding, D1 topology/schema/tenant constraints, and opaque-ID generation algorithm. A tenant ID supplied by a caller alone is not authorization.
- Finalize the versioned event/action contracts and state transitions needed by that scope, including durable dispatch atomicity, concurrency/ordering, idempotency, and bounded retry ownership across Queues/Workflows.
- If Jev is in the slice, specify its runtime/LLM-boundary relationship, triggers, structured results, sufficiency/handoff criteria, and safe fallback. Otherwise explicitly defer it from the initial test scope.

These block a reliable end-to-end implementation, not preparatory local exploration. Final vendors, R2, live secret provisioning, and production activation are not blockers for a mock-only development slice. They become requirements only when the relevant live/staging/production scope is authorized. Implementation, resource creation, and deployment remain unauthorized in this documentation phase.
