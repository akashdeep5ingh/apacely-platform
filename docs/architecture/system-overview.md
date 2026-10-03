# System Overview

## Status and scope

This is the documentation-only architecture foundation for Apacely, a multi-tenant managed lead-conversion platform for residential real-estate teams. Approved principles are requirements; conceptual components below describe intended responsibilities, not implemented or deployed services. No infrastructure, integrations, implementation code, or production activation is authorized by this document.

## Approved architecture

One shared platform serves multiple client tenants. Cloudflare is the orchestration/backend layer. Exact Cloudflare services, storage layout, and execution topology remain open. D1 is not selected as the final storage design; secrets must never be stored in D1 or the repository regardless of storage choices.

Conceptual flow:

1. A lead arrives from an authorized tenant lead source.
2. Ingress authenticates the source, resolves a trusted tenant/client ID, validates the event, and rejects missing or ambiguous tenant context.
3. Shared orchestration loads that tenant's configuration and records tenant-scoped conversation, qualification, orchestration state, and platform metadata.
4. Deterministic rules handle routing, validation, scheduling of work, retries, and state transitions.
5. Defined judgment points may invoke Jev through a replaceable LLM boundary. Model outputs are validated before any state change or external action.
6. Provider adapters perform approved SMS, voice, CRM synchronization, or calendar actions when those integrations are eventually authorized.
7. Provider callbacks are authenticated, mapped to the original tenant and operation, and reconciled idempotently.
8. Tenant-scoped observability and dashboards expose results only to authorized users.

These are logical boundaries, not a commitment to queues, a particular database, or separate deployed services.

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

No SMS provider is selected. No voice provider is selected; Retell versus Bland remains open. No final LLM provider is selected. Jev is reserved for defined judgment points, such as ambiguous qualification interpretation or escalation assessment; the exact points, confidence rules, and fallbacks are not yet approved. Jev does not perform every deterministic action and cannot grant itself authorization.

## Test-first rollout and controls

Apacely is Tenant #001 for testing before any paying client deployment. This is a logical tenant designation, not a tenant record created by this phase. Start with synthetic data and mocks; any live provider test needs appropriate authorization. Production activation remains blocked until measurable checks and explicit human approval both exist. See [Definition of Done](definition-of-done.md), [Multi-Tenant Design](multi-tenant-design.md), and [Security Boundaries](security-boundaries.md).

Human approval is required for production activation, destructive changes, DNS/security changes, secret changes, and large-scale live messaging. No blanket approval is implied by architecture documentation.

## Open questions

- Which Cloudflare services, storage topology, durable execution mechanism, and hosting regions meet the workload and isolation needs?
- What are the normalized event/adapter contracts, capability matrix, timeout/retry limits, and provider-switch migration process?
- Which SMS, voice, CRM/calendar, and LLM integrations will be approved first?
- What is Jev's exact role/runtime, which judgment points are approved, and what triggers deterministic fallback or human escalation?
- Which CRM fields are authoritative, how are conflicts reconciled, and what applies to clients without a CRM?
- What are the availability, latency, throughput, retention, and recovery targets?
