import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
for(const mutant of ['none','c1','c2','c2-queue','c3','c4','c5'])for(const enabled of [false,true])test(`production repaired core custody matrix worker=${enabled} mutant=${mutant}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-core-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    let service:string|undefined,validator:string|undefined,mutationReceipt:object|undefined;
    if(mutant==='c2'||mutant==='c4'){
      const originalPath=path.resolve(import.meta.dir,mutant==='c2'?'../syncService.ts':'ingestValidation.ts'),original=fs.readFileSync(originalPath,'utf8');
      const needle=mutant==='c2'?'          beforeBatch?.();':"job.client === 'cursorDb' ? value.rawBubbleCount : ";
      expect(original.split(needle).length).toBe(2);let scratch=original.replace(needle,'');
      for(const imp of new Bun.Transpiler({loader:'ts'}).scan(scratch).imports)if(!imp.path.startsWith('node:')&&!imp.path.startsWith('bun:')){
        const absolute=Bun.resolveSync(imp.path,path.dirname(originalPath));for(const quote of ['"',"'"])scratch=scratch.replaceAll(quote+imp.path+quote,quote+absolute+quote);
      }
      const file=path.join(root,mutant==='c2'?'service-no-guard.ts':'validator-byte-ordinal.ts');fs.writeFileSync(file,scratch);
      if(mutant==='c2')service=file;else validator=file;
      mutationReceipt={originalPath,originalSha256:sha(original),file,scratchSha256:sha(scratch)};
    }
    const outcome=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'core-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test',F3_FIXTURE_CORE_MUTANT:mutant==='none'?undefined:mutant,F3_FIXTURE_CORE_CASE:mutant==='none'?undefined:mutant==='c2-queue'?'c2':mutant,F3_FIXTURE_SYNC_SERVICE:service,F3_FIXTURE_CORE_VALIDATOR:validator},timeout:60_000,maxBuffer:4*1024*1024}).then(output=>({ok:true,code:0,...output}),error=>({ok:false,code:error.code,stdout:error.stdout??'',stderr:error.stderr??'',error:String(error)}));
    const workerSources=fs.readdirSync(root).filter(name=>/^worker-source-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));
    console.log(JSON.stringify({enabled,mutant,mutationReceipt,outcome,workerSources}));
    expect(outcome.stderr).toContain('F3_DAEMON_SOURCE ');expect(outcome.stderr).toContain('F3_CORE_CASE ');
    if(mutant==='none'){
      expect(outcome.stderr).toContain('F3_CORE_SERVICE_INVOKE ');expect(outcome.ok).toBe(true);
      const row=JSON.parse(outcome.stdout.trim().split('\n').at(-1)!);
      expect(row.review).toEqual({partialCleanup:3,fenceCases:16,expiredWaits:3,networkQueue:true,walOrdinal:true,globalAdmission:true,scheduledRetained:true});
      if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    }else{
      expect(outcome.ok).toBe(false);
      const expected:Record<string,string>={c1:'pruned receipts must not resend known accepted pending objects',c2:'authority refusal must stop before second mutation','c2-queue':'local refusal must not enqueue unguarded work',c3:'retained work scheduled condition timed out',c4:'invalid ingest result schema',c5:'publication must refuse a stale global admission'};
      expect(outcome.stderr).toContain(expected[mutant]);
      if(mutant==='c1')expect(outcome.stderr).toContain('55 !== 30');
      if(mutant==='c3')expect(outcome.stderr).toContain('F3_CORE_AUTH_FIRST ');
      if(mutant==='c5')expect(outcome.stderr).toContain('F3_CORE_ADMISSION_PUBLICATION ');
      if(mutant==='c2'||mutant==='c4'){
        const marker=mutant==='c2'?'F3_CORE_SERVICE_INVOKE ':'F3_CORE_VALIDATOR_INVOKE ';
        const invocation=JSON.parse(outcome.stderr.split('\n').find((line:string)=>line.startsWith(marker))!.slice(marker.length));
        expect(invocation.sha256).toBe((mutationReceipt as {scratchSha256:string}).scratchSha256);
      }
    }
    expect(workerSources.length).toBe(enabled?1:0);
  }finally{
    const owned=fs.readdirSync(root).filter(name=>/^fixture-process-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).pid as number);
    const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
    const end=Date.now()+2000;while(owned.some(alive)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    const remaining=owned.filter(alive);console.log(JSON.stringify({enabled,mutant,root,ownedPids:owned,remaining}));expect(remaining).toEqual([]);if(!remaining.length)fs.rmSync(root,{recursive:true,force:true});
  }
},70_000);
