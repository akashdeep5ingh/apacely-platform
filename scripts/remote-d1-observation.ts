import {pathToFileURL} from 'node:url';
import {observationPlan} from '../src/remote-d1-observation.js';
export {observationPlan};

if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 try {process.stdout.write(JSON.stringify(observationPlan(process.argv.slice(2)),null,2)+'\n');}
 catch {process.stderr.write('Fixed offline observation plan refused.\n'); process.exitCode=1;}
}
