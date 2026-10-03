# Vertical Slice 001 — Mock-Only Development

## Status, scope, and authority

This is an implementation specification, not implemented code or operational evidence. Only this documentation file is authorized now. Do not create migrations, source code, Workers, D1 databases, Queues, Workflows, resources, provider connections, live credentials, or deployments. Do not add Jev or an external LLM.

The approved flow is mock inbound lead → trusted tenant resolution → create/update lead → create/update conversation → normalize inbound event → persist state → deterministic qualification → provider-independent action → persist resulting state. All persistence steps belong to one atomic unit of work, not separately committed partial writes.

This slice proves local core behavior with synthetic data and mock actions. It does not prove Cloudflare runtime behavior, real delivery, live CRM/calendar integration, staging readiness, or production readiness. Approved architecture remains Workers/D1/Queues/Workflows; local SQLite is the proposed D1-compatible development backing store, not a production database replacement. R2 is excluded.

See [System Overview](../architecture/system-overview.md), [Event Model](../architecture/event-model.md), [Provider Adapters](../architecture/provider-adapters.md), and [Definition of Done](../architecture/definition-of-done.md).

## Concrete development design choices

These choices make the mock slice implementable; test qualification policy below is synthetic, not approved client/production eligibility policy.

- Generate all internal entity IDs with UUIDv4 from the same injected ID generator. Tests may supply a deterministic UUID sequence to make assertions reproducible. No business-name IDs or hard-coded privileged Apacely IDs.
- Seed Apacely as logical Tenant #001 in a local development fixture through the ordinary tenant-creation path; seed a second synthetic tenant for isolation tests. Both use the same generator. Display labels are not authorization or IDs.
- Use one local development SQLite database with shared tenant-scoped tables, foreign keys enabled, and repository APIs that require trusted tenant/environment context. Future D1 uses the same conceptual relational constraints; no D1 row-level-security assumption.
- Keep trusted source bindings in a development-only in-memory registry constructed by the harness, not in caller-controlled event data. No authentication provider, password, API key, or security-policy change is involved.
- Use a fixed injected clock for fixture assertions and a pure deterministic evaluator. No model or provider inference from free text.
- A local outbox recorder consumes committed action intents without network calls. The outbox is the authoritative record of emission; the handler never dispatches directly before commit.

## Exact input fixture and trusted setup

Set the test clock to `2026-01-01T12:00:01.000Z`. Let T1, T2 denote generated tenant IDs; L1, C1, M1, E1, Q1, A1 denote generated entity IDs captured from the implementation. These are assertion aliases, not literal stored IDs. The actual generation sequence is observable and controllable in tests, not a global hard-coded fixture ID.

Trusted harness invocation context: environment `development`, source binding `mock-source-001`, resolved tenant T1, allowed operation `ingest_mock_lead`. The harness registry binds this source to active Tenant #001 in development. Caller data cannot override this binding. A binding for the second synthetic tenant is separate even if external lead/event IDs match.

The exact synthetic inbound data is:

| Field | Exact value |
| --- | --- |
| schema_version | `1` |
| source_event_id | `mock-event-001` |
| source_lead_id | `mock-lead-001` |
| source_sequence | `1` |
| occurred_at | `2026-01-01T12:00:00.000Z` |
| channel | `mock` |
| contact_reference | `synthetic-contact-001` |
| text | `I want to buy a condo in Toronto within three months. I am preapproved and ready for a handoff.` |
| qualification.intent | `buy` |
| qualification.timeline | `0_3_months` |
| qualification.financing_status | `preapproved` |
| qualification.location | `Toronto` |
| qualification.property_type | `condo` |
| handoff_requested | `true` |

Input schema_version must be 1; source identifiers are non-empty strings; source_sequence is a positive integer; channel must be mock; timestamps are UTC ISO 8601; text is a string; qualification is a declared-field patch; handoff_requested is a required boolean on every event, not a sticky value carried from a prior request. The qualification inputs are explicitly structured fixture values, not NLP extracted from text. `handoff_ready` is derived by core policy, never accepted as authority from inbound data. No personal phone number, real email, credentials, or live endpoint exists in this fixture. Caller tenant_id/environment/source binding overrides are rejected rather than silently trusted.

## Expected normalized event

After resolving trusted context and provisional lead/conversation IDs, normalization produces this exact logical envelope; ID aliases are substituted with generated values:

| Field | Expected value |
| --- | --- |
| event_id | E1 |
| event_type | `lead.inbound_received` |
| schema_version | `1` |
| tenant_id / environment | T1 / `development` |
| source | `mock-source-001` |
| source_event_id / source_sequence | `mock-event-001` / `1` |
| occurred_at / received_at | `2026-01-01T12:00:00.000Z` / `2026-01-01T12:00:01.000Z` |
| lead_id / conversation_id / message_id | L1 / C1 / M1 |
| correlation_id / causation_id | E1 / absent for this root event |
| policy_version | `mock-qualification-v1` |
| payload.contact_reference | `synthetic-contact-001` |
| payload.channel / text | `mock` / exact fixture text above |
| payload.qualification | Exact five supplied qualification values above |
| payload.handoff_requested | `true` |

The deduplication identity is the tuple (development, T1, mock-source-001, mock-event-001), not string concatenation that can collide. Version 1 accepts only its declared fields/types. Store a canonical semantic-input fingerprint to detect event-ID reuse with changed contents; specify canonical field ordering and encoding in implementation tests. A logical redelivery reuses E1 and its original received_at/correlation/state outcome.

## Deterministic qualification policy

Required stored fields: intent, timeline, financing_status, location, property_type, handoff_ready. Missing values are represented as null; unknown enumerated values are `unknown`, not guessed. The result also stores status, reason/missing-field codes, policy_version, evaluated_event_id, and version.

Mock-only vocabulary: intent = buy, rent, sell, unknown; timeline = 0_3_months, 3_6_months, over_6_months, unknown; financing_status = preapproved, cash, not_started, unknown; property_type = condo, house, townhouse, commercial, unknown. Location is a non-empty trimmed string, maximum 120 characters. Intentional unknown/null values are valid incomplete information; arbitrary invalid enum/type values fail validation.

The synthetic policy is buyer-only. It does not define Apacely's eventual commercial qualification policy. Evaluate in this precedence:

1. Explicit intent rent or sell, or property_type commercial → `disqualified`, handoff_ready false, reason `outside_mock_scope`.
2. Any missing/null/unknown qualification value, empty location, or financing_status not_started → `needs_more_information`, handoff_ready false. Report missing fields in the fixed order intent, timeline, financing_status, location, property_type; not_started uses reason `financing_pending`.
3. Buy intent, any declared known timeline, financing_status preapproved or cash, non-empty location, and condo/house/townhouse → `qualified`, unless handoff_requested is true.
4. The same qualified facts plus handoff_requested true → `handoff_ready`, handoff_ready true.

No numeric score, geographic service-area inference, model judgment, or inferred contact consent. `qualified` and `handoff_ready` are distinct: readiness requires this explicit synthetic request. Never interpret mock handoff_requested as real messaging/calling consent.

For the baseline fixture expect status `handoff_ready`, all five values unchanged, handoff_ready true, no missing fields, reason `qualified_and_handoff_requested`.

## Required state transitions and atomic processing

1. Validate fixture syntax and trusted source binding; reject unknown/inactive/cross-environment context before writes.
2. Open a local transaction. Resolve or insert lead by tenant/source/source_lead_id. Resolve or insert the one active mock conversation for that tenant/lead/source. These are provisional transaction writes, not externally visible partial state.
3. Normalize with generated references and check duplicate/conflict/sequence rules. A duplicate with identical semantic input returns the original stored outcome without writes. A conflicting duplicate or invalid sequence rolls back.
4. Insert the inbound event and its message, with tenant-matching references. Persist a pending evaluation only within the transaction if needed; it must not remain after success or failure.
5. Evaluate qualification deterministically. On a first event, qualification moves absent → evaluated outcome. Later valid events move the existing outcome → newly evaluated outcome with version increment; no absorbing terminal lock in this slice. Lead qualification_status mirrors the result; conversation status stays `open`.
6. Insert exactly one provider-independent action intent for this accepted event in the outbox, with status `pending`. Commit lead/conversation/message/event/qualification/outbox changes together.
7. After commit, an optional local drain records the action through a no-network mock sink and changes outbox status pending → recorded. Return the persisted outcome. No real handoff, delivery, or provider call occurs.

A first fixture transaction never creates partially committed qualified state without its outbox intent. Injected failure at any step before commit must leave all six business tables unchanged (tenant seeds remain). Outbox draining is separate and cannot roll back committed business state.

## Expected emitted action

Baseline action: A1, action_type `request_handoff`, tenant T1, environment development, lead L1, conversation C1, causation/event E1, correlation E1, policy_version mock-qualification-v1. Payload: qualification_status handoff_ready; reason qualified_and_handoff_requested; qualification snapshot equal to the six evaluated fields; destination_reference `mock-handoff-inbox`. The destination is a development-only symbolic mock target, never a URL or live account.

Enforce one action per accepted event with unique key (tenant_id, event_id, action_slot), action_slot `qualification_result`. Per-outcome action map for tests:

| Outcome | Action | Exact distinguishing payload |
| --- | --- | --- |
| needs_more_information | `send_message` | channel mock, template `qualification_missing_fields`, ordered missing fields/reason; recipient_reference is the synthetic contact |
| qualified | `schedule_followup` | due_at = received_at plus 24 hours, reason `qualified_without_handoff_request`; no real timer or Workflows instance |
| handoff_ready | `request_handoff` | Baseline payload described above |
| disqualified | `request_handoff` | reason `review_disqualification`, qualification_status disqualified, destination mock-review-inbox; handoff_ready remains false |

The last action requests internal mock review, not a qualified sales handoff. Every outcome therefore has an observable provider-independent action without asserting suitability or triggering live effects. Text templates, schedules, and review paths are synthetic development fixtures, not real client configuration.

## Minimum D1-compatible relational data model

Use a separate database per environment; environment is also validated in execution context and event/outbox metadata. For this local slice only the development database exists later, when implementation is authorized. No migration/DDL is provided or created here.

All entity IDs use the same UUIDv4 generator. Every client-specific table has non-null tenant_id. Composite parent keys/foreign keys and tenant-scoped uniqueness prevent cross-tenant references even when code receives a valid foreign ID. Repository reads/updates always constrain tenant_id; generated IDs are not authorization.

| Table | Minimum attributes and constraints |
| --- | --- |
| tenants | id primary key, display_name, lifecycle_status, created_at; generated id; active testing state used by fixture |
| leads | id, tenant_id, source_binding, source_lead_id, contact_reference, qualification_status, last_source_sequence, version, created_at, updated_at; tenant foreign key; unique tenant/source/source_lead_id; unique tenant/id |
| conversations | id, tenant_id, lead_id, source_binding, channel, status, version, timestamps; composite foreign key tenant/lead_id to leads; unique tenant/id and tenant/lead_id/source_binding for this slice |
| events | id, tenant_id, lead_id, conversation_id, source_binding, source_event_id, source_sequence, event_type, schema_version, occurred_at, received_at, normalized_payload, input_fingerprint, policy_version, correlation_id, outcome_snapshot; composite lead/conversation ownership foreign keys; unique tenant/id and tenant/source_binding/source_event_id; unique tenant/lead_id/source_sequence |
| messages | id, tenant_id, lead_id, conversation_id, event_id, direction, channel, text, created_at; composite owned lead/conversation/event foreign keys; unique tenant/event_id for one inbound message per event; only inbound direction in this slice |
| qualification_state | id, tenant_id, lead_id, conversation_id, evaluated_event_id, intent, timeline, financing_status, location, property_type, handoff_ready, status, reasons/missing_fields, policy_version, version, updated_at; composite ownership foreign keys; unique tenant/lead_id for one current result |
| action_outbox | id, tenant_id, lead_id, conversation_id, event_id, action_slot, action_type, payload, correlation_id, environment, policy_version, status, attempts, created_at, recorded_at; composite ownership foreign keys; unique tenant/event_id/action_slot |

Conversation uniqueness is deliberately one conversation per lead/source for this mock slice, not final multi-channel lifecycle design. Ensure conversations expose a unique tenant/id/lead_id key so event/message/qualification/outbox relationships validate that the conversation belongs to the referenced lead, not just to the same tenant. Retain event outcome_snapshot for exact duplicate replies even after later events change current qualification state. Normalized payload retains only synthetic allowed data; there are no secrets.

Tenant-user/membership tables, appointments, CRM mappings, provider config tables, durable workflow reference tables, and general event-history projections are intentionally deferred because this slice uses trusted harness bindings and no such operations. This does not remove their approved V1 responsibilities.

## Expected writes and counts

Starting after seeding two tenant fixtures, the baseline accepts one event and adds one lead, one conversation, one event, one inbound message, one qualification_state, and one pending action_outbox. Exactly zero rows belonging to T2 change. No tenant row is created by ingestion.

The optional drain updates only A1 to recorded with attempts 1 and recorded_at equal to the injected clock, and records one action in the in-memory mock sink. It does not create outbound messages, bookings, provider receipts, or another event.

A valid second source event for the same lead updates the lead/conversation timestamps and versions, replaces supplied structured qualification fields (missing fields preserve existing values; explicit null clears), reevaluates all six fields, inserts one new event/message/action, and updates the one current qualification row. It does not create a second lead/conversation. Event normalization stores the actual patch input; action payload uses the resulting merged qualification snapshot.

## Idempotency, ordering, and concurrency

- Duplicate identity is tenant/source_binding/source_event_id inside the development database. Canonical semantic fingerprint includes schema_version, source_lead_id, sequence, occurred_at, channel, contact_reference, text, supplied qualification fields and handoff_requested; exclude generated IDs, receipt time, and transport retry metadata.
- Same key/same fingerprint: return original event IDs/outcome/action reference; no rows, timestamps, versions, or outbox attempts change. Same key/different fingerprint: conflict, no writes.
- Sequence is a positive integer, starts at 1 per tenant/source lead, and increments exactly by 1. Same sequence with another event key, gaps, or stale sequences fail with a typed conflict; no silent overwrites. occurred_at is informational, not ordering authority.
- The harness serializes accepted events per tenant/source lead. Enforce unique keys and transactional version/sequence comparison anyway. A concurrency loser rolls back and retries the whole unit after rereading; it either becomes an identical duplicate or a typed conflict. Set a bounded retry budget (maximum 3 retries) for local lock/version conflicts only; do not retry invalid input or conflicting identity.
- Local outbox drain is a single consumer. The mock sink deduplicates on action id and returns the original receipt when drained again. If failure occurs after sink record but before outbox acknowledgment, redrain must leave one sink entry and mark the original record recorded. This is local crash-test semantics, not a distributed exactly-once guarantee.
- No external calls, cross-service transaction, broker, lease protocol, production retry policy, or queue ordering guarantee is claimed. The D1 transaction boundary is represented by the unit-of-work interface; a future D1 adapter must implement atomic writes with its supported APIs rather than assuming interactive SQLite transactions transfer unchanged.

## Acceptance criteria and failure fixtures

Required local tests when code is separately authorized:

1. Baseline fixture gives exact normalized event and handoff_ready qualification; creates the expected six rows, one pending request_handoff, and no T2 changes.
2. Drain records one mock action and marks only its outbox recorded. Running ingestion/drain twice produces identical business result and exactly one action receipt.
3. Same fixture with handoff_requested false → qualified / schedule_followup. Same fixture with financing_status unknown → needs_more_information / send_message, missing_fields [financing_status]. Same fixture with intent rent → disqualified / request_handoff for review, handoff_ready false. These are independent clean-database tests, not same event IDs reused with changed input.
4. A second event (mock-event-002, sequence 2, same lead) demonstrates update/merge without extra lead/conversation/qualification rows. Explicit null, omitted fields, and readiness true/false are tested distinctly.
5. Missing/forged tenant or source binding, inactive tenant, caller environment override, foreign-tenant lead/conversation IDs, unknown enum, invalid timestamp/sequence, malformed schema, and unknown version all fail with typed errors and no state change.
6. Conflicting duplicate, out-of-order event, sequence gap, concurrent duplicate, and concurrent different event for the same sequence cannot corrupt state or duplicate actions.
7. Failure injection after each provisional write, qualification evaluation, or outbox insert rolls back the entire unit. Local post-commit drain failure leaves committed state and a recoverable pending outbox; repeated drain has one receipt.
8. Use T1 and T2 with identical external event/lead/contact identifiers. Both obtain distinct owned rows/actions. Reads, updates, joins, event replay, outbox reads/drains and attempted cross-tenant composite references cannot expose or mutate another tenant. Assert zero unauthorized rows returned/changed; reject unscoped repository access.
9. Every run uses generated tenant IDs; Apacely's display label does not confer authority. Verify tenant creation uses the same generator for both fixtures.
10. Local runner succeeds without Cloudflare credentials, provider keys, network calls, or model calls. Test suite includes a fail-on-network guard. Persist state to a temporary local database, reopen it to prove durable storage, and query the committed rows rather than trusting printed output alone.

All applicable tests must pass with actual evidence before claiming the slice implemented. Staging and production Definition of Done are NOT RUN here, not PASS. Synthetic fixture outcomes are not real-world eligibility evidence.

## Intentionally mocked and excluded

Mocked: inbound source, trusted source binding, fixed clock/ID test inputs, qualification policy, action sink, follow-up due-time intent, handoff targets, and local persistence of the D1-compatible relational model. No unnecessary SMS/voice/LLM/CRM/calendar stubs are required merely to appear integrated; outbox action contract and no-network recorder are sufficient.

Excluded: Jev/LLMs, live contacts/consent inference, provider connections/SDKs/credentials, Workers handlers/resources, D1 service/database creation, Queues/Workflows resources and remote delivery, R2, CRM/calendar sync, actual messages/calls/bookings, dashboards, production authentication, live security/DNS/secret changes, deployment, and tenant activation. No migration or source file is authorized now.

## Remaining decisions and smallest next code structure

No missing vendor, model, secret, or Cloudflare-resource choice prevents the mock-only local implementation. This specification supplies a concrete test policy, fixture, identity mechanism, persistence boundary, action map, and ordering assumptions. These are scoped development design choices, not claims of additional approved production policy. If the synthetic policy should differ, change the fixture/expectations before coding; do not silently replace them.

Recommended next step after explicit code authorization: a small TypeScript package with one contracts module, one pure qualification module, one tenant-aware transactional repository (local SQLite behind a D1-compatible unit-of-work boundary), one process-inbound use case, one mock outbox recorder, one local CLI runner, and one focused integration/unit test suite. Package/test configuration and the later local schema definition are necessary at that implementation step only. Do not add web UI, Workers scaffolding, five empty vendor adapters, live SDKs, or distributed orchestration yet.

The exact local SQLite driver and test runner are ordinary implementation choices to validate against the available Node runtime, not a business architecture blocker. Use the local CLI and tests to prove the behavior before designing a real D1/Workers adapter. Further human authorization is still required to write implementation code; this document alone authorizes none.
