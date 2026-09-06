import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {configureDaemonWorkers,closeDaemonWorkers} from '../bridge.js';
import {ensureSessionFileIndex,resetSessionFileIndexForTests,inspectHibernationTarget,findSessionFile} from '../../daemon.js';
import {tmuxRun} from '../../tmux.js';
const [enabled,name,id]=process.argv.slice(2);
const root=process.env.HOME!;
const main=path.resolve(import.meta.dir,'../../main.ts');
configureDaemonWorkers(enabled==='true',{invocation:{command:process.execPath,args:[main,'_worker','probe']}},{invocation:{command:process.execPath,args:[main,'_worker','scan']}});
let denied:string|undefined;
try{
 const script=path.join(root,'claude');fs.writeFileSync(script,'#!/bin/bash\nwhile IFS= read -r line; do :; done\n',{mode:0o755});
 const transcript=path.join(root,'.claude/projects/p',id+'.jsonl');fs.mkdirSync(path.dirname(transcript),{recursive:true});fs.writeFileSync(transcript,'{"type":"assistant","message":{"content":[]}}\n');
 const registry=path.join(root,'registry');fs.mkdirSync(registry);
 assert.equal(tmuxRun(['new-session','-d','-s',name,'/bin/bash',script,'--session-id',id]).status,0);
 await new Promise(r=>setTimeout(r,100));
 const pid=Number(tmuxRun(['display-message','-p','-t','='+name+':','#{pane_pid}']).stdout.trim());assert.ok(pid>1);
 fs.writeFileSync(path.join(registry,id+'.json'),JSON.stringify({pid,ts:Date.now()/1000,term:'tmux'}));
 resetSessionFileIndexForTests();await ensureSessionFileIndex();assert.equal(findSessionFile(id,{staleOk:true})?.path,transcript);
 assert.ok(await inspectHibernationTarget(id,name,'fixture',registry));
 denied=path.join(root,'.codex/sessions/2020/01/01/deep/denied');fs.mkdirSync(denied,{recursive:true});fs.writeFileSync(path.join(denied,'rollout-'+id+'.jsonl'),'{}\n');fs.utimesSync(path.dirname(denied),1000,1000);fs.chmodSync(denied,0);
 assert.equal(await inspectHibernationTarget(id,name,'fixture',registry),null);
 resetSessionFileIndexForTests();await ensureSessionFileIndex();assert.equal(await inspectHibernationTarget(id,name,'fixture',registry),null);
 assert.equal(tmuxRun(['has-session','-t','='+name]).status,0);
 console.log(JSON.stringify({eligibleBefore:true,refusedCached:true,refusedIncomplete:true,alive:true}));
}finally{
 if(denied)fs.chmodSync(denied,0o755);
 tmuxRun(['kill-session','-t','='+name]);
 closeDaemonWorkers();
}
process.exit(0);
