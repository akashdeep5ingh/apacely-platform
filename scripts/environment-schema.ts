import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
/** Offline provisioning only. No runtime imports; src/schema.sql is the sole canonical SQL. */
export function environmentSchema(environment:unknown):string {
 if(environment!=='development'&&environment!=='staging')throw new Error('Unsupported database environment');
 const canonical=readFileSync(new URL('../src/schema.sql',import.meta.url),'utf8');
 // Exact schema sites, not a wholesale source/literal replacement. Fail on canonical drift.
 const check="CHECK(environment='development')",seed="SELECT 1,'development' WHERE NOT EXISTS(SELECT 1 FROM database_environment)";
 if(canonical.split(check).length!==4||canonical.split(seed).length!==2)throw new Error('Canonical environment sites changed');
 const emptyGuard="CREATE TABLE environment_provisioning (empty INTEGER CONSTRAINT apacely_provision_empty CHECK(empty=1));\nINSERT INTO environment_provisioning SELECT NOT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name!='environment_provisioning');\nDROP TABLE environment_provisioning;\n";
 return emptyGuard+canonical.replaceAll(check,`CHECK(environment='${environment}')`).replace(seed,`SELECT 1,'${environment}' WHERE NOT EXISTS(SELECT 1 FROM database_environment)`).replaceAll(' IF NOT EXISTS','');
}
/** D1 batch is the provisioning rollback boundary. CREATE collisions reject nonempty targets. */
export function environmentStatements(environment:unknown):string[]{
 const sql=environmentSchema(environment).replace(/--[^\n]*/g,'');
 const statements=sql.match(/\s*CREATE TRIGGER\b[\s\S]*?\bEND;|[^;]+;/g)??[];
 if(statements.join('').replace(/\s/g,'')!==sql.replace(/\s/g,''))throw new Error('Incomplete schema parse');
 return statements.map(s=>s.trim()).filter(s=>!s.startsWith('PRAGMA '));
}

// Output-only offline CLI; never opens a database or invokes a provider/tool.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{if(process.argv.length!==3)throw new Error('One environment required');process.stdout.write(environmentSchema(process.argv[2]));}
 catch{process.stderr.write('Explicit development or staging environment required\n');process.exitCode=1;}
}
