import { environmentStatements } from '../scripts/environment-schema.js';

/** Explicit offline mode only; the legacy strict-empty generator is unchanged. */
export function stagingMigrationStatements(mode: unknown): string[] {
 if (mode !== 'wrangler-4.149.0-initial') throw new Error('Explicit pinned initial versioned migration mode required');
 // This schema is taken from pinned Wrangler getCreateMigrationsTableQuery,
 // not a name-only exemption. Unknown metadata requires renewed qualification.
 const compact = (expression:string):string => `replace(replace(replace(replace(${expression},' ',''),char(9),''),char(10),''),char(13),'')`;
 const expected = 'CREATETABLE"d1_migrations"(idINTEGERPRIMARYKEYAUTOINCREMENT,nameTEXTUNIQUE,applied_atTIMESTAMPDEFAULTCURRENT_TIMESTAMPNOTNULL)';
 const checks = [
  `NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT IN ('environment_provisioning','d1_migrations','sqlite_sequence','sqlite_autoindex_d1_migrations_1','_cf_METADATA'))`,
  `(SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='_cf_METADATA' AND tbl_name='_cf_METADATA' AND ${compact('sql')}='CREATETABLE_cf_METADATA(keyINTEGERPRIMARYKEY,valueBLOB)')=1`,
  // Internal columns/rows/indexes are validated by the wrapper's read-only physical
  // preflight; workerd's SQL authorizer forbids even internal table-info pragmas.
  `(SELECT count(*) FROM sqlite_schema WHERE type='table' AND name='d1_migrations' AND tbl_name='d1_migrations' AND ${compact('sql')}='${expected}')=1`,
  `(SELECT count(*) FROM pragma_table_info('d1_migrations'))=3`,
  `(SELECT count(*) FROM pragma_table_info('d1_migrations') WHERE (cid=0 AND name='id' AND type='INTEGER' AND "notnull"=0 AND dflt_value IS NULL AND pk=1) OR (cid=1 AND name='name' AND type='TEXT' AND "notnull"=0 AND dflt_value IS NULL AND pk=0) OR (cid=2 AND name='applied_at' AND type='TIMESTAMP' AND "notnull"=1 AND dflt_value='CURRENT_TIMESTAMP' AND pk=0))=3`,
  `(SELECT count(*) FROM sqlite_schema WHERE type='index' AND name='sqlite_autoindex_d1_migrations_1' AND tbl_name='d1_migrations' AND sql IS NULL)=1`,
  `(SELECT count(*) FROM pragma_index_list('d1_migrations'))=1`,
  `(SELECT count(*) FROM pragma_index_list('d1_migrations') WHERE name='sqlite_autoindex_d1_migrations_1' AND "unique"=1 AND origin='u' AND partial=0)=1`,
  `(SELECT count(*) FROM pragma_index_info('sqlite_autoindex_d1_migrations_1'))=1`,
  `(SELECT count(*) FROM pragma_index_info('sqlite_autoindex_d1_migrations_1') WHERE seqno=0 AND cid=1 AND name='name')=1`,
  `(SELECT count(*) FROM sqlite_schema WHERE name='sqlite_sequence' AND type='table' AND tbl_name='sqlite_sequence' AND sql='CREATE TABLE sqlite_sequence(name,seq)')=1`,
  `NOT EXISTS(SELECT 1 FROM d1_migrations)`,
  `NOT EXISTS(SELECT 1 FROM sqlite_sequence)`
 ];
 const strict = environmentStatements('staging');
 if (strict.length < 4 || !strict[0]!.startsWith('CREATE TABLE environment_provisioning') || !strict[1]!.startsWith('INSERT INTO environment_provisioning') || strict[2] !== 'DROP TABLE environment_provisioning;') throw new Error('Canonical empty guard changed');
 return [strict[0]!, `INSERT INTO environment_provisioning SELECT (${checks.join(' AND ')});`, ...strict.slice(2)];
}
