# System Overview

## Status and scope

This is the documentation-only architecture foundation for Apacely, a multi-tenant managed lead-conversion platform for residential real-estate teams. Approved principles are requirements; conceptual components below describe intended responsibilities, not implemented or deployed services. No infrastructure, integrations, implementation code, or production activation is authorized by this document.

## Approved architecture

One shared platform serves multiple client tenants. The following V1 responsibilities are approved, but no resources are created by this documentation:

| Component | Approved V1 responsibility |
| --- | --- |
| Cloudflare Workers | API and orchestration layer; authenticated ingress, normalization, core rules, adapter dispatch, and asynchronous handlers |
| Cloudflare D1 | Tenants; tenant users/membership references; leads; conversations; messages; qualification state; appointments/references; workflow state references; provider/integration configuration references |
| Cloudflare Queues | Asynchronous work, retries, and event processing |
| Cloudflare Workflows | Durable multi-step processes, follow-up sequences, waits, and long-running orchestration |
| R2 | Not required for the first vertical slice; reserved for future client files/documents if needed |

D1 holds tenant-scoped application records and orchestration references; Workflows executes durable processes. This does not make Apacely a replacement CRM. Never store provider secrets in plaintext in D1. The existing stricter boundary remains: store credentials only in approved secret storage, not in the repository or D1; D1 stores non-secret references. D1 database topology, schema, constraints, and execution ownership details still need design.

Conceptual flow:

1. A lead arrives from an authorized tenant lead source.
2. Ingress authenticates the source, resolves a trusted tenant/client ID, validates the event, and rejects missing or ambiguous tenant context.
3. Shared orchestration loads that tenant's configuration and records tenant-scoped conversation, qualification, orchestration state, and platform metadata.
4. Deterministic rules handle routing, validation, scheduling of work, retries, and state transitions.
5. Defined judgment points may invoke Jev through a replaceable LLM boundary. Model outputs are validated before any state change or external action.
6. Provider adapters perform approved SMS, voice, CRM synchronization, or calendar actions when those integrations are eventually authorized.
7. Provider callbacks are authenticated, mapped to the original tenant and operation, and reconciled idempotently.
8. Tenant-scoped observability and dashboards expose results only to authorized users.

The internal model is event-driven. Provider-specific inbound events are normalized into shared Apacely events before core business logic handles them. Provider-independent core actions include `send_message`, `initiate_voice_call`, `schedule_followup`, `update_crm`, `offer_booking`, and `request_handoff`. Actions express intent; adapters execute external effects and report normalized outcomes. Scheduling follow-up is owned by orchestration, not an SMS vendor. See [Event Model](event-model.md) and [Provider Adapters](provider-adapters.md). These responsibilities are architecture decisions, not deployed services.

## Data ownership

Where a client already has a CRM, that CRM remains the source of truth for client business records. Apacely stores conversation state, qualification state, orchestration data, and platform-specific metadata. Any necessary CRM projections must retain tenant-scoped external IDs and freshness metadata; a cache must not silently become authoritative. Field ownership, conflict handling, and synchronization directions require approval before implementation. The no-existing-CRM case is unresolved.

## Shared code versus tenant configuration

| Shared reusable platform logic | Tenant-specific configuration/data |
| --- | --- |
| Event validation, authorization, isolation, state machine, idempotency, retry policies, adapter contracts, audit and metrics | Tenant/client ID, lead-source mappings, approved qualification criteria, business hours/timezone, escalation contacts, channel policy, selected adapters, CRM/calendar identifiers, non-secret integration settings |
| Versioned judgment-point definitions and output validation | Approved tenant prompt/policy parameters and workflow options |

Builder should extend reusable capabilities rather than fork platform code for individual clients. Configuration is validated and versioned; it cannot bypass isolation, consent, approval, or safety controls. Secrets are held in approved secret storage, with only non-secret references in configuration.

## Replaceable integrations

SMS, voice, CRM, calendar, and LLM capabilities sit behind provider-neutral contracts. Core state must use internal tenant-scoped identifiers, with provider identifiers confined to mappings/metadata. Adapters translate normalized commands, responses, errors, and callback events. Capability differences must be explicit; switching a provider is not assumed to be a drop-in change. Contract tests and a controlled migration plan must precede a switch.

No SMS provider is selected. No voice provider is selected; Retell versus Bland remains open. No final LLM provider is selected. Jev is reserved for genuine intent, qualification sufficiency, handoff readiness, and ambiguous next-action judgment. These judgment categories are approved; exact triggers, structured outputs, confidence rules, and fallbacks remain to be specified. Jev does not perform every deterministic action and cannot grant itself authorization.

## Test-first rollout and controls

Apacely is Tenant #001 for testing before any paying client deployment. Tenant #001 is a human-facing designation, not its internal ID. All tenants, including Apacely, use the same opaque generated-ID mechanism, never business names. No tenant record is created by this phase. Initial environments are development, staging, and production, with isolated data, bindings, integrations, and authorization scope. Start with synthetic data and mocks; any live provider test needs appropriate authorization. Tenant #001 must reach staging and pass the applicable Definition of Done before production activation is considered. No environment is provisioned by this phase. Production activation remains blocked until measurable checks and explicit human approval both exist. See [Definition of Done](definition-of-done.md), [Multi-Tenant Design](multi-tenant-design.md), and [Security Boundaries](security-boundaries.md).

Human approval is required for production activation, destructive changes, DNS/security changes, secret changes, and large-scale live messaging. No blanket approval is implied by architecture documentation.

## Open questions

- What D1 database topology, schema/constraints, regional requirements, and Workers/Queues/Workflows execution boundaries apply to the first slice?
- What are the normalized event/adapter contracts, capability matrix, timeout/retry limits, and provider-switch migration process?
- Which SMS, voice, CRM/calendar, and LLM integrations will be approved first?
- How will Jev's approved judgment categories map to exact triggers, outputs, thresholds, deterministic fallback, and human escalation?
- Which CRM fields are authoritative, how are conflicts reconciled, and what applies to clients without a CRM?
- What are the availability, latency, throughput, retention, and recovery targets?
