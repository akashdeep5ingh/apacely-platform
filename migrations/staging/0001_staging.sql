CREATE TABLE environment_provisioning (empty INTEGER CONSTRAINT apacely_provision_empty CHECK(empty=1));
INSERT INTO environment_provisioning SELECT (NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT IN ('environment_provisioning','d1_migrations','sqlite_sequence','sqlite_autoindex_d1_migrations_1','_cf_METADATA')) AND (SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='_cf_METADATA' AND tbl_name='_cf_METADATA' AND replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),'')='CREATETABLE_cf_METADATA(keyINTEGERPRIMARYKEY,valueBLOB)')=1 AND (SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='d1_migrations' AND tbl_name='d1_migrations' AND replace(replace(replace(replace(sql,' ',''),char(9),''),char(10),''),char(13),'')='CREATETABLE"d1_migrations"(idINTEGERPRIMARYKEYAUTOINCREMENT,nameTEXTUNIQUE,applied_atTIMESTAMPDEFAULTCURRENT_TIMESTAMPNOTNULL)')=1 AND (SELECT count(*) FROM pragma_table_info('d1_migrations'))=3 AND (SELECT count(*) FROM pragma_table_info('d1_migrations') WHERE (cid=0 AND name='id' AND type='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=1) OR (cid=1 AND name='name' AND type='TEXT' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) OR (cid=2 AND name='applied_at' AND type='TIMESTAMP' AND "notnull"=1 AND dflt_value='CURRENT_TIMESTAMP' AND pk=0))=3 AND (SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='sqlite_autoindex_d1_migrations_1' AND tbl_name='d1_migrations' AND sql IS NULL)=1 AND (SELECT count(*) FROM pragma_index_list('d1_migrations'))=1 AND (SELECT count(*) FROM pragma_index_list('d1_migrations') WHERE name='sqlite_autoindex_d1_migrations_1' AND "unique"=1 AND origin='u' AND partial=0)=1 AND (SELECT count(*) FROM pragma_index_info('sqlite_autoindex_d1_migrations_1'))=1 AND (SELECT count(*) FROM pragma_index_info('sqlite_autoindex_d1_migrations_1') WHERE seqno=0 AND cid=1 AND name='name')=1 AND (SELECT count(*) FROM sqlite_schema WHERE name='sqlite_sequence' AND type='table' AND tbl_name='sqlite_sequence' AND sql='CREATE TABLE sqlite_sequence(name,seq)')=1 AND NOT EXISTS(SELECT 1 FROM d1_migrations) AND NOT EXISTS(SELECT 1 FROM sqlite_sequence));
DROP TABLE environment_provisioning;
CREATE TABLE database_environment (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), environment TEXT NOT NULL CHECK(environment='staging')
);
INSERT INTO database_environment SELECT 1,'staging' WHERE NOT EXISTS(SELECT 1 FROM database_environment);
CREATE TRIGGER environment_no_replace BEFORE INSERT ON database_environment
 WHEN EXISTS(SELECT 1 FROM database_environment) BEGIN SELECT RAISE(ABORT,'apacely_environment_immutable'); END;
CREATE TRIGGER environment_no_update BEFORE UPDATE ON database_environment BEGIN SELECT RAISE(ABORT,'apacely_environment_immutable'); END;
CREATE TRIGGER environment_no_delete BEFORE DELETE ON database_environment BEGIN SELECT RAISE(ABORT,'apacely_environment_immutable'); END;
CREATE TABLE acceptance_assertions (
 active INTEGER CONSTRAINT apacely_active_scope CHECK(active=1),
 cas INTEGER CONSTRAINT apacely_cas_conflict CHECK(cas=1)
);
CREATE TABLE tenants (
 id TEXT PRIMARY KEY, display_name TEXT NOT NULL, lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active','inactive')), created_at TEXT NOT NULL
);
CREATE TABLE source_mappings (
 id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version>0), provider TEXT NOT NULL, source TEXT NOT NULL, principal TEXT NOT NULL,
 tenant_id TEXT NOT NULL REFERENCES tenants(id), source_binding TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment='staging'), operation TEXT NOT NULL CHECK(operation='ingest_mock_lead'),
 status TEXT NOT NULL CHECK(status IN ('active','inactive','revoked')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 revoked_at TEXT, revoked_version INTEGER, UNIQUE(provider,source),
 CHECK((status='revoked' AND revoked_at IS NOT NULL AND revoked_version=version) OR (status!='revoked' AND revoked_at IS NULL AND revoked_version IS NULL))
);
CREATE TRIGGER source_mapping_no_replace BEFORE INSERT ON source_mappings
 WHEN EXISTS(SELECT 1 FROM source_mappings WHERE id=NEW.id OR (provider=NEW.provider AND source=NEW.source))
 BEGIN SELECT RAISE(ABORT,'apacely_mapping_tombstone'); END;
CREATE TRIGGER source_mapping_no_delete BEFORE DELETE ON source_mappings BEGIN SELECT RAISE(ABORT,'apacely_mapping_tombstone'); END;
CREATE TRIGGER source_mapping_version BEFORE UPDATE ON source_mappings
 WHEN OLD.status='revoked' OR NEW.id!=OLD.id OR NEW.provider!=OLD.provider OR NEW.source!=OLD.source OR NEW.created_at!=OLD.created_at OR NEW.version!=OLD.version+1 OR NEW.version>9007199254740991
 BEGIN SELECT RAISE(ABORT,'apacely_mapping_version'); END;
CREATE TABLE authority_assertions (authorized INTEGER CONSTRAINT apacely_source_authority CHECK(authorized=1));
CREATE TABLE replay_assertions (fresh INTEGER CONSTRAINT apacely_replay_fresh CHECK(fresh=1));
CREATE TABLE replay_ledger (
 nonce_ref TEXT PRIMARY KEY CHECK(length(nonce_ref)=64), tenant_id TEXT NOT NULL REFERENCES tenants(id),
 mapping_id TEXT NOT NULL REFERENCES source_mappings(id), authority_ref TEXT NOT NULL CHECK(length(authority_ref)=64),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64), signed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 expired INTEGER NOT NULL DEFAULT 0 CHECK(expired IN (0,1)), deadline INTEGER NOT NULL, CHECK(expires_at=signed_at+300000), CHECK(deadline<=expires_at)
);
CREATE TRIGGER replay_owner BEFORE INSERT ON replay_ledger
 WHEN NOT EXISTS(SELECT 1 FROM source_mappings WHERE id=NEW.mapping_id AND tenant_id=NEW.tenant_id)
 BEGIN SELECT RAISE(ABORT,'apacely_replay_owner'); END;
CREATE INDEX replay_expiry ON replay_ledger(tenant_id,expired,deadline,nonce_ref);
CREATE TRIGGER replay_no_replace BEFORE INSERT ON replay_ledger WHEN EXISTS(SELECT 1 FROM replay_ledger WHERE nonce_ref=NEW.nonce_ref) BEGIN SELECT RAISE(ABORT,'apacely_replay_tombstone'); END;
CREATE TRIGGER replay_no_delete BEFORE DELETE ON replay_ledger BEGIN SELECT RAISE(ABORT,'apacely_replay_tombstone'); END;
CREATE TRIGGER replay_immutable BEFORE UPDATE ON replay_ledger
 WHEN OLD.expired=1 OR NEW.expired!=1 OR NEW.nonce_ref!=OLD.nonce_ref OR NEW.tenant_id!=OLD.tenant_id OR NEW.mapping_id!=OLD.mapping_id OR NEW.authority_ref!=OLD.authority_ref OR NEW.fingerprint!=OLD.fingerprint OR NEW.signed_at!=OLD.signed_at OR NEW.expires_at!=OLD.expires_at OR NEW.deadline!=OLD.deadline
 BEGIN SELECT RAISE(ABORT,'apacely_replay_immutable'); END;
CREATE TABLE leads (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), source_binding TEXT NOT NULL, source_lead_id TEXT NOT NULL, contact_reference TEXT NOT NULL,
 qualification_status TEXT, last_source_sequence INTEGER NOT NULL, version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,source_binding,source_lead_id)
);
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, source_binding TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel='mock'), status TEXT NOT NULL CHECK(status='open'), version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,lead_id), UNIQUE(tenant_id,lead_id,source_binding),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id)
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_binding TEXT NOT NULL, source_event_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence>0), event_type TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=1), occurred_at TEXT NOT NULL, received_at TEXT NOT NULL,
 normalized_payload TEXT NOT NULL, input_fingerprint TEXT NOT NULL, policy_version TEXT NOT NULL, correlation_id TEXT NOT NULL, outcome_snapshot TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,lead_id,conversation_id), UNIQUE(tenant_id,source_binding,source_event_id), UNIQUE(tenant_id,lead_id,source_sequence),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id)
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction='inbound'), channel TEXT NOT NULL CHECK(channel='mock'), text TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
CREATE TABLE qualification_state (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, evaluated_event_id TEXT NOT NULL, intent TEXT, timeline TEXT, financing_status TEXT, location TEXT, property_type TEXT, handoff_ready INTEGER NOT NULL CHECK(handoff_ready IN (0,1)), status TEXT NOT NULL, reasons TEXT NOT NULL, missing_fields TEXT NOT NULL, policy_version TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,lead_id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,evaluated_event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
CREATE TABLE action_outbox (
 id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), lead_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL, action_slot TEXT NOT NULL CHECK(action_slot='qualification_result'), action_type TEXT NOT NULL, payload TEXT NOT NULL, correlation_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment='staging'), policy_version TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','recorded')), attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, recorded_at TEXT,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,event_id,action_slot),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),
 FOREIGN KEY(tenant_id,conversation_id,lead_id) REFERENCES conversations(tenant_id,id,lead_id),
 FOREIGN KEY(tenant_id,event_id,lead_id,conversation_id) REFERENCES events(tenant_id,id,lead_id,conversation_id)
);
