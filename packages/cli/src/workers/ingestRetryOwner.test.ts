import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TranscriptRetryOwner} from './ingestRetryOwner.js';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('registered retry owners fairly recover past a wake slice and obey pause, disappearance and stop',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-retry-owner-'));
  let allowed=true,healthy=false,now=100,executed=0,missing=0,stopped=0;
  const owner=new TranscriptRetryOwner({allowed:()=>allowed,retryable:()=>true,now:()=>now,wakeDelayMs:1,onMissing:()=>{missing++;},onStop:()=>{stopped++;}});
  const maps=Array.from({length:3},()=>new Map()),syncs:any[]=[],counts=new Map<string,number>();
  const warn=console.warn;console.warn=()=>{};
  try{
    for(let i=0;i<24;i++){
      const file=path.join(root,String(i));fs.writeFileSync(file,'source');
      const sync=owner.create(maps[i%3],file,{file,sessionId:'full-'+i,client:'claude'},async()=>{counts.set(file,(counts.get(file)??0)+1);if(!healthy)throw new Error('outage');executed++;},{maxRetries:1});
      syncs.push(sync);await sync.invalidateAndAwait();
    }
    expect(executed).toBe(0);healthy=true;now++;
    allowed=false;expect(owner.drain()).toBe(0);allowed=true;
    const wakeCounts=[];
    for(let i=0;i<3;i++){wakeCounts.push(owner.drain());await Promise.all(syncs.map(s=>s.awaitQueue()));}
    expect(wakeCounts).toEqual([8,8,8]);expect(executed).toBe(24);expect([...counts.values()].every(n=>n===2)).toBe(true);expect(owner.drain()).toBe(0);
    healthy=false;await syncs[0].invalidateAndAwait();fs.unlinkSync(path.join(root,'0'));now++;
    owner.drain();await syncs[0].awaitQueue();expect(missing).toBe(1);
    fs.writeFileSync(path.join(root,'0'),'replaced');healthy=true;await syncs[0].invalidateAndAwait();expect(executed).toBe(25);
    healthy=false;await syncs[1].invalidateAndAwait();now++;owner.stop();healthy=true;expect(owner.drain()).toBe(0);syncs[1].invalidate();await turn();expect(executed).toBe(25);expect(stopped).toBe(24);
    expect(()=>owner.create(new Map(),'later',{client:'claude',file:'later',sessionId:'later'},async()=>{})).toThrow('stopped');
  }finally{console.warn=warn;owner.stop();fs.rmSync(root,{recursive:true,force:true});}
});

test('an active stopped instance cannot rearm on its late failure and unrelated sources retain admission',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-retry-late-')),file=path.join(root,'file');fs.writeFileSync(file,'source');
  let now=0,reject!:(error:Error)=>void,entered!:(value?:unknown)=>void;
  const active=new Promise<void>((_resolve,rejection)=>{reject=rejection;}),started=new Promise(resolve=>{entered=resolve;});
  const owner=new TranscriptRetryOwner({allowed:()=>true,retryable:()=>true,now:()=>now,wakeDelayMs:1});
  const map=new Map(),warn=console.warn;console.warn=()=>{};
  try{
    const sync=owner.create(map,file,{client:'claude',file,sessionId:'full'},async()=>{entered();await active;},{maxRetries:1});
    const pending=sync.invalidateAndAwait();await started;sync.stop();reject(new Error('late failure'));await pending;await turn();now=100;expect(owner.drain()).toBe(0);
    expect(()=>owner.create(map,file,{client:'claude',file,sessionId:'different-full'},async()=>{})).toThrow('mismatch');
    const other=owner.create(map,file+'other',{client:'claude',file,sessionId:'other-full'},async()=>{}, {maxRetries:1});await other.invalidateAndAwait();expect(owner.drain()).toBe(0);
  }finally{console.warn=warn;owner.stop();fs.rmSync(root,{recursive:true,force:true});}
});
