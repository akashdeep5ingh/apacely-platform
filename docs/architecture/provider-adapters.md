# Provider Adapters

## Status and approved boundaries

Create replaceable adapter boundaries for LLM, SMS, voice, CRM, and calendar. No final vendor is selected or connected. This document defines conceptual interfaces/responsibilities, not implementation signatures, SDK dependencies, credentials, or resources. Workers executes API/orchestration logic; D1 stores application data and non-secret integration references; Queues and Workflows own asynchronous/durable orchestration. R2 is deferred from the first slice.

## Common conceptual contract

Each adapter receives validated tenant/environment context, a non-secret integration/configuration reference, normalized inputs, and operation/correlation/idempotency references. Credential resolution occurs through approved secret storage outside D1/repository and outside model context. Adapter code is shared; tenant configuration selects an approved compatible adapter and its scoped mapping/settings.

Adapters must:

- Declare supported capabilities and limits rather than silently emulate an unsupported action.
- Translate provider-independent commands to vendor requests and return normalized status/results without leaking vendor payloads into core business rules.
- Distinguish accepted, pending, completed, delivered where applicable, failed, unsupported, and unknown outcomes; exact result schema remains to be finalized.
- Normalize errors into actionable transient/permanent/authorization/rate-limit/unknown-outcome categories; supply safe retry hints, not autonomous unlimited retries.
- Bind external IDs/accounts to tenant and environment; identical external IDs across tenants cannot merge data.
- Authenticate relevant inbound callbacks, reject unknown ownership/replay as appropriate, and normalize approved facts into shared Apacely events before core processing.
- Minimize and redact data, never log secrets, and expose safe traceability/cost/latency information where relevant.
- Support mocks and reusable contract tests. Do not claim exactly-once external execution unless the provider and tested reconciliation behavior support it.

The core owns authorization, consent, tenant state, policy, and approval. Adapters cannot weaken these gates. An adapter does not own business workflow retries independently of Queues/Workflows; define one retry owner and reconcile uncertain outcomes before repeat effects.

## Responsibilities by adapter

| Adapter | Expected normalized inputs / operations | Expected normalized results and inbound handling | Not its responsibility |
| --- | --- | --- | --- |
| LLM | Tenant-minimized judgment context, approved task category, policy/prompt version, structured output requirements and budgets | Validated judgment candidate, uncertainty/failure reason, usage metadata where available; core validates schema and authorizes next action | Tenant authorization, direct external side effects, production approval, routine deterministic rules |
| SMS | `send_message` intent with approved recipient/content/channel and operation identity; delivery/reconciliation capability | Accepted vs delivered/failed outcomes, scoped message reference; authenticated inbound messages, delivery updates, opt-out signals normalized as events | Choosing qualification rules, inventing consent, durable follow-up scheduling |
| Voice | `initiate_voice_call` with authorized destination and approved call policy/context | Scoped call reference, lifecycle outcome, transcript/result reference when available; authenticated callback events | Unapproved call decisions, treating call acceptance as completion, cross-tenant transcript storage |
| CRM | `update_crm` and necessary reads using scoped record references and approved field ownership | Read/write confirmation, scoped external IDs, conflicts and sync freshness; normalize inbound CRM changes when supported/in scope | Becoming the system of record over an existing client CRM or silently overwriting CRM-owned fields |
| Calendar | Availability and booking operations needed for `offer_booking`; timezone, approved calendar and participant references | Normalized slots, availability/conflicts, booking confirmation/references; changes/cancellation facts when supported/in scope | Treating an offer as a booking, selecting another tenant's calendar, overriding business rules |

`schedule_followup` is a core Workflows/orchestration action, not an SMS/voice provider dependency. `request_handoff` is a core routing/escalation action that may use messaging or CRM adapters after authorization. Provider-neutral action names do not require every adapter to implement every action.

## Jev and deterministic business rules

Jev is reserved for genuine intent, qualification sufficiency, handoff readiness, and ambiguous next-action judgment. These are approved task categories, not approval of every possible model call. The LLM adapter remains replaceable; Jev's runtime relationship to it, triggers, output schemas, budgets, and fallback rules require specification. It must not replace deterministic routing, validation, consent, retries, or security/approval logic. Invalid/uncertain judgment output takes a defined safe path rather than triggering uncontrolled side effects.

## State ownership and provider switching

Existing client CRM is the CRM system of record. Apacely owns conversation, qualification, orchestration state, and platform metadata. D1 stores tenant-scoped leads and CRM/appointment/workflow/integration references as approved; this is not authority to duplicate all CRM data or store credentials.

Keep internal operation/entity IDs stable and vendor IDs in adapter mappings. A future switch requires capability/contract review, credential authorization, pending-job/callback mapping strategy, and rollback/reconciliation tests. Do not reinterpret old provider receipts as a new provider's receipts. Queued or resumed work must not silently switch credentials/destinations; pin relevant operation/configuration versions and revalidate current safety policy.

## Environments, tests, and approval

Development, staging, and production require isolated data/configuration, bindings, credential references, and provider mappings. Start Tenant #001 with synthetic fixtures and mock adapters, using the same opaque generated tenant ID mechanism as future clients. It must reach staging and pass applicable Definition of Done checks before production activation is considered. Mock success is contract evidence, not proof of live delivery/calling/CRM/booking.

Required contract cases include successful operations, unsupported capabilities, malformed outputs, rate limits, auth failures, timeouts with unknown outcomes, duplicate callbacks, wrong-tenant/account/environment events, and redacted diagnostics. SMS delivery/reply, completed voice/transcript, CRM read-back, and confirmed booking are required only when those integrations enter the approved slice; unconnected providers are N/A or NOT RUN, not PASS.

Production activation, destructive production changes, DNS/security/secret changes, and large-scale live messaging/calling require human approval. Existing stricter destructive-data and irreversible-infrastructure gates remain. This documentation authorizes no provider connections or live actions.

## Remaining decisions

For mock-first implementation: select first-slice operations and exact request/result/event contracts, capability expectations, retry/reconciliation ownership, tenant/environment configuration rules, and any Jev triggers/outputs actually in scope. Identity, D1 topology/schema, and reliability contracts are cross-cutting dependencies.

For later live integrations: select vendors, approve credentials/secret storage and consent/recording policies, specify callback verification, CRM field mappings/conflicts, calendar/timezone semantics, and provider migration behavior. These later choices do not block a deliberately mock-only first slice. See [Event Model](event-model.md) and [Definition of Done](definition-of-done.md).
