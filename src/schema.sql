PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tenants (
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active','inactive')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), source_binding TEXT NOT NULL, source_lead_id TEXT NOT NULL, contact_reference TEXT NOT NULL,
 qualification_status TEXT, last_source_sequence INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,source_binding,source_lead_id)
);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, source_binding TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel='mock'), status TEXT NOT NULL CHECK(status='open'), version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,lead_id), UNIQUE(tenant_id,lead_id,source_binding),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_binding TEXT NOT NULL, source_event_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>0), event_type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1), occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
 normalized_payload TEXT NOT NULL, input_fingerprint TEXT NOT NULL, policy_version TEXT NOT NULL, correlation_id TEXT NOT NULL, outcome_snapshot TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,lead_id,conversation_id), UNIQUE(tenant_id,source_binding,source_event_id), UNIQUE(tenant_id,lead_id,source_sequence),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction='inbound'), channel TEXT NOT NULL CHECK(channel='mock'), text TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS qualification_state (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, evaluated_event_id TEXT NOT NULL, intent TEXT, timeline TEXT, financing_status TEXT, location TEXT, property_type TEXT, handoff_ready INTEGER NOT NULL CHECK(handoff_ready IN (0,1)), status TEXT NOT NULL, reasons TEXT NOT NULL, missing_fields TEXT NOT NULL, policy_version TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,lead_id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,evaluated_event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
CREATE TABLE IF NOT EXISTS action_outbox (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL, action_slot TEXT NOT NULL CHECK(action_slot='qualification_result'), action_type TEXT NOT NULL, payload TEXT NOT NULL, correlation_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment='development'), policy_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','recorded')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, recorded_at TEXT,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_id,action_slot),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
