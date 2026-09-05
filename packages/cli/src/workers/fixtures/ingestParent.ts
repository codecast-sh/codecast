import {WorkerHost} from '../host.js';
import {ingestIdentity} from '../ingestJobs.js';
import fs from 'node:fs';
const [main,file]=process.argv.slice(2);
const host=new WorkerHost('ingest',{invocation:{command:process.execPath,args:[main,'_worker','ingest']}});
const page:any=await host.request('ingest',{action:'open',job:{client:'claude',file,sessionId:'owned-parent-death',generation:'owned-parent-generation',identity:ingestIdentity(fs.statSync(file)),offset:0}});
process.stdout.write(JSON.stringify({workerPid:host.state.pid,cursor:page.cursor,pageTokens:page.tokens.length})+'\n');
setInterval(()=>{},1000);
