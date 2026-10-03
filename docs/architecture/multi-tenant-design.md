# Multi-Tenant Design

## Status and invariant

This document defines required isolation behavior for one shared Apacely platform serving residential real-estate teams. It is a design foundation, not an implemented schema or a claim that isolation has been tested. Every client-specific record and configuration must carry a tenant/client ID. Client data must never leak across tenants.

Use `tenant_id` as the conceptual name in this document; the final identifier format and schema are unresolved. Apacely is Tenant #001 for testing before paying clients, but no tenant record is created here.

## Tenant context across the lifecycle

- Resolve tenant context from an authenticated identity, approved source mapping, or verified integration binding. An untrusted request's tenant ID alone is never authority.
- Authorize the actor and action against the resolved tenant. Reject absent, ambiguous, conflicting, unknown, or inactive tenant context; never fall back to another tenant.
- Carry tenant context through ingestion, jobs, state transitions, provider calls, callbacks, retries, dashboard queries, exports, and audit events.
- Resolve callback tenant ownership from verified provider/account/operation mappings, not user-supplied payload hints. Shared provider accounts require unambiguous ownership mappings.
- Revalidate authorization and tenant status before delayed work causes external effects. Retries cannot lose or change tenant identity.

## Data isolation requirements

Client-specific leads/projections, conversations, messages, transcripts, qualification state, tasks, bookings, integration mappings, policies, and configuration revisions require tenant association. So do client-specific audit, analytics, cache entries, files, and any future embeddings or model memory.

All reads, updates, deletes, joins, deduplication keys, idempotency keys, external-ID lookups, caches, and object paths must enforce tenant scope. IDs alone do not authorize access. Relationships must prevent a child owned by one tenant from referencing another tenant's parent. Where supported, storage constraints complement application enforcement; do not assume automatic row-level security exists.

Physical isolation is undecided: shared tables, separate databases, or a hybrid may be evaluated. Regardless of topology, enforce explicit tenant association and authorization at every access boundary. Global platform records must be explicitly classified as global, contain no client data, and not be used as a loophole for unscoped access.

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

- What is the canonical tenant/client ID format, and how are users, teams, memberships, and integration accounts bound to it?
- Which storage topology and enforceable constraints provide the required isolation and recovery characteristics?
- What are the role model, support-access approval process, tenant lifecycle transitions, and quota limits?
- How are shared provider accounts safely mapped and tenant offboarding/migrations performed?
- Which CRM projections, retention rules, export controls, and configuration approval/versioning workflow are needed?
