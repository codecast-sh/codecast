import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile),sha=(value:string)=>createHash('sha256').update(value).digest('hex');
for(const scenario of [{mutant:false,kind:undefined},{mutant:true,kind:'direct'},{mutant:true,kind:'pending'}])for(const enabled of [false,true])test(`real service sub-batch custody worker=${enabled} mutant=${scenario.mutant} path=${scenario.kind??'all'}`,async()=>{
  const {mutant,kind}=scenario,root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-sub-batch-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  let servicePath:string|undefined,productionSha256:string|undefined,scratchSha256:string|undefined;
  try{
    if(mutant){
      const original=fs.readFileSync(path.resolve(import.meta.dir,'../syncService.ts'),'utf8'),needle='if (onBatchAccepted) onBatchAccepted(batch.map(message => preparedIndexes!.get(message)!));';
      expect(original.split(needle).length).toBe(2);let scratch=original.replace(needle,'');
      for(const imp of new Bun.Transpiler({loader:'ts'}).scan(scratch).imports)if(!imp.path.startsWith('node:')&&!imp.path.startsWith('bun:')){
        const absolute=Bun.resolveSync(imp.path,path.resolve(import.meta.dir,'..'));
        for(const quote of ['"',"'"])scratch=scratch.replaceAll(quote+imp.path+quote,quote+absolute+quote);
      }
      servicePath=path.join(root,'syncService-no-sub-batch-receipt.ts');fs.writeFileSync(servicePath,scratch);productionSha256=sha(original);scratchSha256=sha(scratch);
    }
    const outcome=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'sub-batch-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test',F3_FIXTURE_SYNC_SERVICE:servicePath,F3_FIXTURE_SUB_BATCH_PATH:kind},timeout:30_000,maxBuffer:2*1024*1024}).then(output=>({ok:true,code:0,...output}),error=>({ok:false,code:error.code,stdout:error.stdout??'',stderr:error.stderr??'',error:String(error)}));
    const workerSources=fs.readdirSync(root).filter(name=>/^worker-source-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));
    console.log(JSON.stringify({enabled,mutant,kind,productionSha256,scratchSha256,outcome,workerSources}));
    expect(outcome.stderr).toContain('F3_DAEMON_SOURCE ');expect(outcome.stderr).toContain('F3_SERVICE_INVOKE ');
    if(mutant){
      expect(outcome.ok).toBe(false);expect(outcome.stderr).toContain('known accepted sub-batch must not resend UUID-less rows');
      expect(outcome.stderr).toContain('55 !== 30');
      const invocation=JSON.parse(outcome.stderr.split('\n').find((line:string)=>line.startsWith('F3_SERVICE_INVOKE '))!.slice('F3_SERVICE_INVOKE '.length));
      expect(invocation.sha256).toBe(scratchSha256);expect(invocation.servicePath).toBe(servicePath);
    }else{
      expect(outcome.ok).toBe(true);const row=JSON.parse(outcome.stdout.trim().split('\n').at(-1)!);
      expect(row.review).toEqual({realService:true,directPending:true,acceptedSubset:25,lateFences:3,accounting:true,reconcileIndexes:true,unknownNoReceipt:true,callbackCaptured:true,timeoutNoReceipt:true,byteSplit:true,oversizedSingleton:true,zeroInserted:true,allReconciled:true});
      if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    }
    expect(workerSources.length).toBe(enabled?1:0);
  }finally{
    const owned=fs.readdirSync(root).filter(name=>/^fixture-process-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).pid as number);
    const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
    const end=Date.now()+2000;while(owned.some(alive)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    const remaining=owned.filter(alive);console.log(JSON.stringify({enabled,mutant,ownedPids:owned,remaining}));expect(remaining).toEqual([]);if(!remaining.length)fs.rmSync(root,{recursive:true,force:true});
  }
},40_000);
