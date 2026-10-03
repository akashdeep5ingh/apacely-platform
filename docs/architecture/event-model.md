# Event Model

## Status and approved direction

V1 uses an event-driven internal model. Cloudflare Workers are the API/orchestration layer, D1 stores application state and workflow/configuration references, Queues handles asynchronous work/retries/event processing, and Workflows handles durable multi-step processes, waits, and follow-up sequences. R2 is not required for the first vertical slice. This document defines conceptual contracts, not implementation code, resources, or a final wire schema.

Provider-specific inbound events must be authenticated and normalized into shared Apacely events before core business logic handles them. Events record facts; actions express requested work. Neither event contents nor provider/model output grants permission to act.

## Conceptual event envelope

The following are proposed conceptual fields/responsibilities to finalize before implementation. Names are descriptive, not a deployed schema.

| Field | Meaning and constraint |
| --- | --- |
| event_id | Opaque internal event identity, stable for redelivery of the same logical event |
| event_type and schema_version | Shared Apacely fact type and supported envelope/payload version; unknown or incompatible types/versions are rejected or quarantined |
| tenant_id | Required opaque generated tenant ID; resolved from trusted ownership, not a business name or unverified payload hint |
| environment | Required development, staging, or production context; must match the execution boundary |
| occurred_at / received_at | Fact time and ingress receipt time; timestamps alone do not establish ordering |
| source | Internal component or approved adapter/integration reference; provider identifiers stay in scoped mappings |
| subject references | Tenant-scoped lead/conversation/message/appointment/workflow references needed for processing; validate their ownership |
| correlation_id / causation_id | Trace the business flow and preceding event/action without exposing secrets or other tenants |
| deduplication reference | Tenant/environment/source-scoped logical delivery identity; do not deduplicate across clients |
| payload | Minimal normalized domain data appropriate to event_type; not an unrestricted vendor payload |
| configuration/policy version reference | Version used to interpret the event; delayed effects also revalidate current safety policy |

Authentication proofs, secrets, and unrestricted provider bodies do not belong in the shared envelope. Transport attempt counters and diagnostics may be separate delivery metadata; retries must not create a new logical event identity. Final required/optional fields, encodings, payload limits, and retention are still design decisions.

## Conceptual facts and actions

Illustrative shared facts include lead received, inbound message received, message delivery updated, voice result received, qualification changed, follow-up due, booking outcome received, and handoff requested/completed. Final event names and transition catalog are unresolved.

Approved provider-independent action examples are `send_message`, `initiate_voice_call`, `schedule_followup`, `update_crm`, `offer_booking`, and `request_handoff`. Each action needs tenant/environment context, subject references, normalized inputs, an idempotency/correlation reference, and applicable policy checks. An event is not automatically an authorized action. A booking offer is not a confirmed booking. A provider accepting a message is not proof of delivery.

Scheduling and handoff routing are platform responsibilities, using adapters only where an external effect is required. Jev judges genuine intent, qualification sufficiency, handoff readiness, or ambiguous next action at defined triggers; deterministic rules validate its result and choose authorized transitions.

## Lifecycle and reliability responsibilities

1. Receive input in Workers and authenticate the actor/source/callback before resolving tenant and environment.
2. Normalize via the relevant adapter, validate envelope/payload/schema and all referenced ownership, and reject missing or conflicting context.
3. Durably record accepted facts and state references in D1 and arrange asynchronous delivery through Queues. The exact atomicity/outbox or reconciliation design must be settled; a successful database write must not silently lose the corresponding job.
4. Queue processing rechecks tenant/environment and handles duplicates, invalid transitions, and stale/out-of-order facts before shared logic runs. Do not assume exactly-once delivery or global ordering.
5. Core logic applies deterministic business rules and approved judgment points; records state changes and action intent with correlation/idempotency evidence.
6. Workflows owns durable waits and multi-step orchestration. D1 holds tenant-scoped workflow state references. Define which component owns each retry so Queues and Workflows do not multiply external effects.
7. Immediately before effects, revalidate tenant status, environment, destination, consent, and applicable human approval. Adapter dispatch reports normalized results; authenticated callbacks become further shared events.
8. Transient failures retry within approved limits. Permanent failures, exhausted retries, unknown external outcomes, or invalid events enter a safe failed/quarantined/escalated path. Never blindly resend after an ambiguous provider timeout.
9. Acknowledge processing only after the required durable progress is established. Operator replay must be scoped, authorized, and audited; duplicate effects must remain prevented.

These are required semantics, not a promise of an implemented transaction across D1 and Queues. Retry budgets, dead-letter handling, ordering/version checks, transaction boundaries, cancellation, and resume behavior need concrete design and tests.

## Shared platform versus tenant configuration

Shared code owns envelope validation/versioning, normalized event routing, tenant enforcement, deduplication/idempotency, state transitions, and reliable dispatch. Tenant configuration owns approved source bindings, workflow/qualification settings, timezone, destination policies, and non-secret integration references. Configuration cannot introduce arbitrary executable handlers or bypass isolation/approval. All client-specific records and asynchronous state are tenant-associated.

Existing client CRM remains the system of record for client business records. Apacely owns conversation, qualification, orchestration, and platform metadata. Event replay cannot overwrite CRM-owned fields without approved ownership/conflict rules. No final LLM, SMS, voice, CRM, or calendar vendor is selected.

## Verification and open decisions

Tenant #001 uses the same opaque-ID mechanism as future tenants and must pass staging Definition of Done before production consideration. Verify duplicate ingress/callbacks, queue redelivery, workflow resume/cancellation, lost-delivery recovery, out-of-order facts, spoofed tenant IDs, cross-environment work, invalid versions, and ambiguous external outcomes. Require zero cross-tenant disclosures/mutations and no duplicate authorized effects under the tested failure scenarios.

Blocking design choices for a first asynchronous slice include exact envelope/action/state contracts, D1 persistence and atomic dispatch strategy, ordering/concurrency policy, Queues-versus-Workflows retry ownership, and the selected test scope. Provider selection is not a blocker for a mock-only slice. Live provider callbacks need provider-specific security decisions later. See [Definition of Done](definition-of-done.md).
