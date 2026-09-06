import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readTranscriptIngest} from '../ingestClient.js';
import {ingestRetainedWeight} from '../ingestTransport.js';
const until=async(check:()=>boolean)=>{const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error('admission yield was not reached');await new Promise(resolve=>setTimeout(resolve,1));}};

export async function coreAdmission({d,home,getPosition}:any) {
  const core=d.fixtureCore,context=new AsyncLocalStorage<string>();
  for(const limit of ['rows','bytes'])for(const change of ['none','removal','replacement']){
    const pending:any={},ids=['admit-'+limit+'-'+change+'-a','admit-'+limit+'-'+change+'-b'];
    const jobs=await Promise.all(ids.map(async id=>{
      const file=path.join(home,id+'.jsonl');fs.writeFileSync(file,Array.from({length:16},(_,i)=>JSON.stringify({type:'assistant',uuid:id+'-'+i,timestamp:'2026-09-05T12:00:00Z',message:{content:'x'.repeat(1000)}})+'\n').join(''));
      return {id,file,result:await readTranscriptIngest({client:'claude',file,sessionId:id,offset:0})};
    }));
    const measure:any={};await d.retainPendingTranscript(measure,jobs[0].id,jobs[0].result.messages,jobs[0].file,fs.statSync(jobs[0].file).size);
    const candidateBytes=measure[jobs[0].id].reduce((n:number,row:object)=>n+core.retainedPendingWeights.get(row),0);
    const seed={role:'assistant',content:limit==='rows'?'seed':'s'.repeat(7600),timestamp:1,filePath:path.join(home,'seed'),fileSize:1};
    const seedWeight=await ingestRetainedWeight(seed),seedCount=limit==='rows'?8168:Math.floor((32*1024*1024-Math.ceil(candidateBytes*1.5))/seedWeight);
    assert.ok(limit==='rows'||seedCount*seedWeight+candidateBytes<=32*1024*1024&&seedCount*seedWeight+candidateBytes*2>32*1024*1024);
    for(let i=0;i<seedCount;i++){
      const owner='seed-'+Math.floor(i/128),row={...seed};core.retainedPendingWeights.set(row,seedWeight);
      (pending[owner]??=[]).push(row);
    }
    const originalImmediate=globalThis.setImmediate,held=new Map<string,()=>void>(),counts=new Map<string,number>(),target=Math.floor(seedCount/128);
    globalThis.setImmediate=((callback:any,...args:any[])=>{
      const id=context.getStore();
      if(id&&new Error().stack?.includes('retainPendingTranscript')){
        const count=(counts.get(id)??0)+1;counts.set(id,count);
        if(count===target){held.set(id,()=>callback(...args));return originalImmediate(()=>{}) as any;}
      }
      return originalImmediate(callback,...args);
    }) as typeof setImmediate;
    const work=jobs.map(job=>context.run(job.id,()=>d.retainPendingTranscript(pending,job.id,job.result.messages,job.file,fs.statSync(job.file).size)));
    try{
      await until(()=>held.size===2);
      if(change==='removal')core.publishPendingTranscript(pending,'seed-0',[]);
      if(change==='replacement')core.publishPendingTranscript(pending,'seed-0',pending['seed-0'].map((row:any)=>{const next={...row};core.retainedPendingWeights.set(next,seedWeight);return next;}));
      for(const resume of held.values())resume();held.clear();await Promise.all(work);
    }finally{globalThis.setImmediate=originalImmediate;for(const resume of held.values())resume();await Promise.allSettled(work);}
    const admitted=jobs.filter(job=>pending[job.id]);
    console.error('F3_CORE_ADMISSION_PUBLICATION '+JSON.stringify({limit,change,admitted:admitted.length,seedCount,counts:[...counts]}));
    assert.equal(admitted.length,change==='none'?1:0,'publication must refuse a stale global admission');
    const rows=Object.values(pending).flat() as object[],bytes=rows.reduce((n,row)=>n+core.retainedPendingWeights.get(row),0);
    assert.ok(rows.length<=8192);assert.ok(bytes<=32*1024*1024);for(const job of jobs)assert.equal(getPosition(job.file),0);
    if(change!=='none'){await d.retainPendingTranscript(pending,jobs[0].id,jobs[0].result.messages,jobs[0].file,fs.statSync(jobs[0].file).size);assert.equal(pending[jobs[0].id].length,16);}
    console.error('F3_CORE_ADMISSION '+JSON.stringify({limit,change,seedCount,seedWeight,candidateBytes,target,counts:[...counts],admitted:admitted.length,rows:rows.length,bytes}));
  }
}
