import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
for(const enabled of [false,true])test(`physical TaskCreate occurrence mutation fails actual backend replacement control worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-control-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  const receipts=()=>fs.readdirSync(root).filter(name=>/^producer-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')));
  try{
    const original=fs.readFileSync(path.join(import.meta.dir,'ingestJobs.ts'),'utf8'),needle='const native = nativeIds.every';
    expect(original.split(needle).length).toBe(2);
    const scratch=original.replace(needle,'const native = false && nativeIds.every').replace(/((?:from\s+|import\()['"])([^'"]+)(['"])/g,(all,start,spec,end)=>spec.startsWith('.')?start+path.resolve(import.meta.dir,spec)+end:all);
    const producer=path.join(root,'ingestJobs-physical.ts');fs.writeFileSync(producer,scratch);
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'task-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test',F3_FIXTURE_PHYSICAL_TASKKEY:'1',F3_FIXTURE_INGEST_PRODUCER:producer},timeout:30_000,maxBuffer:2*1024*1024}).then(output=>({ok:true,code:0,...output}),error=>({ok:false,code:error.code,signal:error.signal,stdout:error.stdout??'',stderr:error.stderr??'',error:String(error)}));
    const controls=receipts(),invocations=fs.readdirSync(root).filter(name=>/^invocations-\d+\.jsonl$/.test(name)).flatMap(name=>fs.readFileSync(path.join(root,name),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));
    console.log(JSON.stringify({enabled,productionSha256:sha(original),scratchSha256:sha(scratch),outcome:result,controls,invocations}));
    expect(result.ok).toBe(false);expect(result.stderr).toContain('AssertionError');expect(result.stderr).toContain('5 !== 4');
    expect(invocations.length).toBeGreaterThan(0);expect(invocations.every(c=>c.sha256===sha(scratch)&&c.producer===producer)).toBe(true);
    const supervisor=controls.find(c=>c.ppid===process.pid),invoked=new Set(invocations.map(c=>c.pid));expect(supervisor).toBeDefined();
    expect(invoked.size).toBe(1);expect(invoked.has(supervisor.pid)).toBe(!enabled);
    expect(controls.length).toBe(enabled?2:1);expect(controls.every(c=>c.sha256===sha(scratch)&&c.producer===producer)).toBe(true);
    console.log(JSON.stringify({enabled,expectedFailure:'5 !== 4',productionSha256:sha(original),scratchSha256:sha(scratch),controls}));
  }finally{
    const owned=receipts().map(c=>c.pid),end=Date.now()+2000;
    while(owned.some(alive)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
    const remaining=owned.filter(alive);expect(remaining).toEqual([]);
    console.log(JSON.stringify({enabled,ownedProducerPids:owned,remaining}));
    if(!remaining.length)fs.rmSync(root,{recursive:true,force:true});
  }
},40_000);
