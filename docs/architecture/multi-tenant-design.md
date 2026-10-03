# Multi-Tenant Design

## Status and invariant

This document defines required isolation behavior for one shared Apacely platform serving residential real-estate teams. It is a design foundation, not an implemented schema or a claim that isolation has been tested. Every client-specific record and configuration must carry a tenant/client ID. Client data must never leak across tenants.

Use `tenant_id` as the conceptual name. Tenant IDs must be opaque generated IDs, not business names. The exact generation algorithm/encoding is not selected. Apacely is Tenant #001 for testing before paying clients; its internal ID must use the same generated-ID mechanism as every future client. No tenant record is created here.

## Tenant context across the lifecycle

- Resolve tenant context from an authenticated identity, approved source mapping, or verified integration binding. An untrusted request's tenant ID alone is never authority.
- Authorize the actor and action against the resolved tenant. Reject absent, ambiguous, conflicting, unknown, or inactive tenant context; never fall back to another tenant.
- Carry tenant context through ingestion, jobs, state transitions, provider calls, callbacks, retries, dashboard queries, exports, and audit events.
- Resolve callback tenant ownership from verified provider/account/operation mappings, not user-supplied payload hints. Shared provider accounts require unambiguous ownership mappings.
- Revalidate authorization and tenant status before delayed work causes external effects. Retries cannot lose or change tenant identity.

## Data isolation requirements

Client-specific leads/projections, conversations, messages, transcripts, qualification state, tasks, bookings, integration mappings, policies, and configuration revisions require tenant association. So do client-specific audit, analytics, cache entries, files, and any future embeddings or model memory.

All reads, updates, deletes, joins, deduplication keys, idempotency keys, external-ID lookups, caches, and object paths must enforce tenant scope. IDs alone do not authorize access. Relationships must prevent a child owned by one tenant from referencing another tenant's parent. Where supported, storage constraints complement application enforcement; do not assume automatic row-level security exists.

Cloudflare D1 is approved for tenants, tenant users/membership references, leads, conversations, messages, qualification state, appointments/references, workflow state references, and provider/integration configuration references. Physical D1 topology remains undecided: shared tables/database, separate D1 databases, or a hybrid may be evaluated. Regardless of topology, enforce explicit tenant association and authorization at every access boundary. Global platform records must be explicitly classified as global, contain no client data, and not be used as a loophole for unscoped access.

## Asynchronous and environment isolation

Cloudflare Workers enforce tenant scope at every API and data-access boundary. Queues messages and Workflows inputs/steps must preserve validated tenant identity and environment. Consumers and resumed steps revalidate ownership, tenant status, and authorization before effects. Unknown, missing, conflicting, or spoofed context fails closed. Event IDs, idempotency, deduplication, workflow references, and provider callbacks are scoped by tenant and environment. A shared queue/workflow is not permission to access all tenants.

Development, staging, and production are separate environments. Data, bindings, credential references, and provider mappings cannot silently cross environments. Tenant #001 must pass staging Definition of Done before production activation is considered; production remains human-gated. No environments are created here. R2 is outside the first vertical slice.

## Shared platform code versus tenant configuration

Shared code owns orchestration, authorization, data-access enforcement, adapter interfaces, schema/config validation, lifecycle controls, and observability. Tenant configuration contains tenant identity, approved workflow options, qualification criteria, business rules, timezone, channel settings, integration mappings, and non-secret credential references. Credentials themselves are never stored in the repository or D1.

Configuration must be versioned, validated, and linked to tenant context and audit evidence. Tenant customization selects supported reusable behaviors; it does not inject arbitrary executable code or disable safety gates. Custom requirements should become shared capabilities where appropriate, with explicit approval if scope changes.

## CRM and integration ownership

An existing client CRM remains the source of truth. Apacely stores operational state and approved projections, linked with tenant-scoped external record IDs. Identical phone numbers, email addresses, or provider IDs in two tenants must not merge their records. CRM reconciliation, calendar routing, and channel adapters must preserve this boundary.

SMS, voice, and LLM providers remain replaceable and unselected. Tenant configuration may eventually select a compatible adapter; platform logic must not depend on vendor-specific identifiers or payloads. Jev receives only the minimum data from the authorized tenant at a defined judgment point, never a shared pool of tenant context.

## Lifecycle and noisy-neighbor controls

Logical tenant states should support testing, pending approval, active, and suspended operation; exact state names and transitions remain open. Tenant #001 uses synthetic fixtures and mock integrations initially. Internal testing does not grant platform-wide access. Production activation requires human approval and verified readiness.

Require per-tenant usage accounting and bounded execution so one tenant cannot exhaust the shared platform. Suspension must prevent new live actions, including queued actions, while preserving approved diagnostic access. Quota values, deletion/retention procedures, and tenant migration strategy remain undecided. Destructive changes require human approval.

## Required isolation verification

Use at least two synthetic tenant contexts, Tenant #001 and a test-only second context; no paying client or persistent second tenant is created in this phase. Verify cross-tenant reads, writes, joins, callbacks, jobs, retries, exports, caches, and dashboard queries are denied or confined correctly. Exercise identical contact/external IDs across tenants, forged tenant IDs, and missing context. Evidence must show zero unauthorized disclosure or mutation. See [Definition of Done](definition-of-done.md).

## Open questions

- Which opaque generated-ID algorithm/encoding will be used, and how are users, teams, membership references, and integration accounts bound to it?
- Which D1 topology and enforceable tenant relationship constraints provide the required isolation and recovery characteristics?
- What are the role model, support-access approval process, tenant lifecycle transitions, and quota limits?
- How are shared provider accounts safely mapped and tenant offboarding/migrations performed?
- Which CRM projections, retention rules, export controls, and configuration approval/versioning workflow are needed?
