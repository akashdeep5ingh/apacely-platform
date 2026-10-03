# Security Boundaries

## Status and security objective

This is a documentation-only security foundation, not an implemented control set or a security-policy change. The shared Apacely platform must never expose one client's data to another. Implementation and verification of controls are future work. No integrations, secrets, Cloudflare resources, or deployments are created here.

## Trust boundaries

| Boundary | Required behavior before implementation can be considered complete |
| --- | --- |
| Lead sources and browser clients to backend | Authenticate/validate ingress, limit abuse, resolve trusted tenant context, reject spoofed tenant IDs and malformed input |
| User/operator to tenant data | Authorize actor, action, and tenant; apply least privilege; deny cross-tenant access including direct record-ID access |
| Orchestration to storage/jobs/caches | Preserve tenant association on every access and event; prevent cross-tenant relationships; make replay/idempotency tenant-scoped |
| Backend to SMS, voice, CRM, calendar | Use approved tenant-bound integration credentials and adapters; validate destination, consent, tenant status, and action authorization |
| Provider callback to backend | Verify authenticity and replay handling using the selected provider's mechanism; map to the original tenant/operation; deny unknown ownership |
| Tenant data to Jev/LLM | Minimize/redact data, isolate tenant context, validate outputs, and enforce deterministic authorization outside the model |
| Backend to logs/dashboards/exports | Redact secrets and unnecessary personal data; authorize tenant-specific views; avoid cross-tenant aggregation leakage |
| Human/operator to production controls | Require explicit scoped approval, least privilege, and an auditable change/test record |

Approved V1 uses Workers for API/orchestration, D1 for application state and non-secret references, Queues for asynchronous work/retries/events, and Workflows for durable multi-step processes. R2 is not required for the first slice. Identity provider, secret storage, and exact enforcement mechanisms remain open. Approval of architecture principles does not authorize changes to DNS, authentication, security policies, or infrastructure.

## V1 asynchronous and environment boundaries

Tenant isolation is mandatory at every data-access and asynchronous-processing boundary, including Queues consumers, retries/replays, Workflows creation and resumed steps, and D1 relationship lookups. Preserve validated tenant/environment context and recheck authority before side effects. Normalize authenticated inbound vendor events before shared business rules; normalization does not grant authority. Provider-independent actions remain subject to deterministic policy and approval gates.

Initial environments are development, staging, and production. Require environment-scoped bindings, data, credentials, and access; prohibit unintended cross-environment effects. Tenant #001 uses an opaque generated ID through the same mechanism as future clients. It must reach staging and pass Definition of Done before production activation is considered. This is a requirement, not a change to any live security policy.

## Shared controls versus tenant configuration

Shared code owns authentication/authorization enforcement, isolation, input validation, output validation, credential resolution, redaction, audit mechanisms, and live-action gates. Tenant configuration holds tenant ID, non-secret integration references, approved channel/routing policy, qualification parameters, and authorized contacts. Tenant configuration must not weaken shared controls. Tenant records/configuration cannot contain credentials or bypass human approval.

Provider-specific security mechanisms belong in adapters behind reusable contracts. SMS, voice, and final LLM providers remain undecided; no Twilio/alternative or Retell/Bland choice is made here. Provider-specific verification and data-handling requirements must be reviewed once providers are selected.

## Secrets and sensitive data

- Never store secrets in the repository or D1, including tokens, passwords, signing keys, or credential-bearing URLs. This applies even if D1 is later selected for non-secret data.
- Use approved secret storage and runtime bindings/references. The final secret-storage mechanism is an open decision.
- Do not print secrets in logs, prompts, error payloads, traces, or documentation. Separate credentials by tenant/integration/environment as required by least privilege.
- Use OAuth or other secure authorization methods where available. Do not request credentials by email or chat.
- Minimize personal data sent to external providers; define retention, consent, recording/transcript access, residency, and deletion requirements before live operation.
- Secret creation, changes, and rotation require human approval. Tenant test status does not waive this boundary.

## Deterministic authority and Jev

Jev is reserved for genuine intent, qualification sufficiency, handoff readiness, and ambiguous next-action judgment. Exact triggers, runtime, thresholds, and fallback rules remain unresolved. Routine validation, routing, retries, tenant authorization, consent checks, and approval gates are deterministic shared logic, not model decisions.

Treat lead messages, transcripts, retrieved content, and model output as untrusted data. They cannot grant access, change tenant identity, reveal secrets, or authorize tools. Validate structured outputs and allowed transitions; uncertain or unsafe judgments fall back to a defined safe path or human escalation. Any model memory/retrieval is tenant-scoped. No autonomous model-driven production activation is allowed.

## Mandatory human approval gates

Stop and obtain explicit human approval before production activation; destructive database/data changes; DNS, authentication, or security-policy changes; secret changes/rotation; irreversible infrastructure changes; or large-scale live messaging/calling. Commercial or client-scope changes also require approval.

Approval must identify scope, environment, affected tenants, action, reviewer, and applicable verification/rollback plan. It is not reusable blanket consent. Define expiry, revocation, and enforcement mechanisms before implementing live controls. Small live tests still need authorized recipients and an approved test scope; their mere size is not consent.

## Verification requirements

Prove denied cross-tenant reads/writes and forged/missing tenant IDs; authenticated callback ownership; replay and duplicate handling; isolation of delayed jobs and LLM context; redaction; secret exclusion from repository/D1; and fail-closed production/live-action gates. Verify both successful authorized paths and rejected unauthorized paths. Tenant #001 must pass these checks before paying client deployment. See [Definition of Done](definition-of-done.md).

## Open questions

- Which identity/role model and audited operator/support-access process will be approved?
- Which secret store and credential scoping/rotation process will be used?
- What consent, opt-out, quiet-hour, recording, retention, residency, and deletion requirements apply in target jurisdictions?
- What constitutes large-scale messaging, and how are approval expiry/revocation and emergency stop enforced?
- Which callback signature/replay controls, abuse limits, encryption arrangements, and incident-response/recovery targets are required?
