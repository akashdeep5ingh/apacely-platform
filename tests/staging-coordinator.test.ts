import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {build} from 'esbuild';

test('normal browser artifact is sealed and distinct bootstrap artifact contains first-birth capability',async()=>{
 for(const name of ['staging-worker','staging-bootstrap-worker'])assert.equal(existsSync(`src/${name}.ts`),true,`${name} must exist`);
 const normal=await build({entryPoints:['src/staging-worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers'],metafile:true});
 const text=normal.outputFiles[0].text;
 assert.equal(text.includes('initializeFreshAdmission'),false);
 assert.equal(text.includes('bootstrapAdmission'),false);
 assert.equal(text.includes('extends DurableObject'),true);
 assert.equal(Object.keys(normal.metafile!.inputs).some(path=>path.includes('better-sqlite3')),false);
 const bootstrap=await build({entryPoints:['src/staging-bootstrap-worker.ts'],bundle:true,write:false,format:'esm',platform:'browser',external:['cloudflare:workers']});
 assert.equal(bootstrap.outputFiles[0].text.includes('initializeFreshAdmission'),true);
});
