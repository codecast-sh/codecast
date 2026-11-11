import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } from './bridge.js';
import { WorkerUnavailable } from './host.js';
import { readTranscriptIngest, serializeTranscript, IngestDeadlineExceeded, IngestCapacityError, ingestIdentity, retryOnIngestCapacity, awaitDeliveryEcho, ORDINARY_RESERVATIONS } from './ingestClient.js';
import { ingestTokens } from './ingestTransport.js';
import { checkTranscriptDeadline } from './ingestDeadline.js';
import { IngestCursors } from './ingestCursors.js';

test('actual ingest client applies one budget to pages, local reads, fallback and validation',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f3-client-bounds-'));
  const file=path.join(dir,'transcript.jsonl');
  fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'row',timestamp:'2026-09-05T00:00:00Z',message:{role:'assistant',content:'tiny'}})+'\n');
  const input={client:'claude' as const,file,sessionId:'full-id',offset:0};
  const result=await readTranscriptIngest(input);
  const original=Object.getOwnPropertyDescriptor(performance,'now');
  const nowMethod=performance.now;
  let now=0,closes=0,requests:number[]=[],pages=0;
  const setup=async ()=>{
    await configureDaemonWorkers(true);
    const host=ingestWorkerHost()!;
    Object.defineProperty(host,'state',{get:()=>({closed:false,generation:1,pid:123,pending:0})});
    return host;
  };
  try {
    Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
    let host=await setup();
    host.request=(async(_operation:any,payload:any,options:any)=>{
      if(payload.action==='close') {closes++;return {};}
      requests.push(options.timeoutMs);now+=9_000;
      return {cursor:'cursor',generation:payload.job?.generation ?? 'unused',sequence:pages++,tokens:[['s']],done:false};
    }) as typeof host.request;
    await expect(readTranscriptIngest(input,{timeoutMs:10_000})).rejects.toThrow(IngestDeadlineExceeded);
    expect(requests).toEqual([10_000,1_000]);expect(closes).toBe(1);
    now=0;host=await setup();
    host.request=(async(_operation:any,payload:any)=>{
      if(payload.action==='close') {closes++;return {};}
      return {cursor:'cursor',generation:payload.job.generation,sequence:0,tokens:[],done:false};
    }) as typeof host.request;
    await expect(readTranscriptIngest(input)).rejects.toThrow('no progress');
    now=0;host=await setup();
    host.request=(async()=>{now=11_000;throw new WorkerUnavailable('unavailable after budget');}) as typeof host.request;
    await expect(readTranscriptIngest(input,{timeoutMs:10_000})).rejects.toThrow(IngestDeadlineExceeded);
    now=0;host=await setup();
    host.request=(async(_operation:any,payload:any)=>{
      if(payload.action==='close')return {};
      const page={cursor:'cursor',generation:payload.job.generation,sequence:0,tokens:[...ingestTokens({...result,totalCount:0})],done:true};
      return page;
    }) as typeof host.request;
    await expect(readTranscriptIngest(input)).rejects.toThrow('schema');
    let nested:any={};for(let i=0;i<130;i++)nested={next:nested};
    fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'deep',timestamp:'2026-09-05T00:00:00Z',message:{role:'assistant',content:[{type:'tool_use',id:'tool',name:'tool',input:nested}]}})+'\n');
    closeDaemonWorkers();
    await expect(readTranscriptIngest(input)).rejects.toThrow('nesting');
    host=await setup();host.request=(async()=>{throw new WorkerUnavailable('small fallback');}) as typeof host.request;
    await expect(readTranscriptIngest(input)).rejects.toThrow('nesting');
  } finally {
    if(original)Object.defineProperty(performance,'now',original);
    else {delete (performance as any).now;expect(performance.now).toBe(nowMethod);}
    closeDaemonWorkers();fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('expired reservations never release a held continuation into successor state',async()=>{
  let release!:()=>void,settled=false,position=0;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const order:string[]=[];
  const first=serializeTranscript('held-session',()=>serializeTranscript('held-file',async()=>{
    await blocked;order.push('old resumed');checkTranscriptDeadline();position++;
  }),{timeoutMs:5}).then(()=>{settled=true;return null;},error=>{settled=true;return error;});
  const expired=serializeTranscript('held-session',async()=>{order.push('expired ran');},{timeoutMs:5}).catch(error=>error);
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(await expired).toBeInstanceOf(IngestDeadlineExceeded);
  expect(settled).toBe(false);
  let successorRan=false;
  const next=serializeTranscript('held-session',async()=>{successorRan=true;order.push('new ran');position++;});
  await new Promise(resolve=>setImmediate(resolve));expect(successorRan).toBe(false);
  release();expect(await first).toBeInstanceOf(IngestDeadlineExceeded);await next;
  expect(order).toEqual(['old resumed','new ran']);expect(position).toBe(1);
});
// 2026-11-05: a pass hung on a local file read for 2h56m. Its successors on
// the same transcript must still wait for it (above), but nothing else may:
// other transcripts run, and every waiter that gives up returns its slot, so
// one stuck pass cannot use up the daemon's transcript reservations.
test('an expired pass still holding its lock blocks its own transcript and no other',async()=>{
  let release!:()=>void,owning!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const owned=new Promise<void>(resolve=>{owning=resolve;});
  const stuck=serializeTranscript('stuck-session',async()=>{owning();await blocked;},{timeoutMs:20}).catch(error=>error);
  await owned;
  let successorRan=false;
  const successor=serializeTranscript('stuck-session',async()=>{successorRan=true;});
  await expect(serializeTranscript('other-session',async()=>'other synced')).resolves.toBe('other synced');
  // Long past the holder's deadline, and past any unwinding allowance a
  // bounded lock might give it: the successor still has not run.
  await new Promise(resolve=>setTimeout(resolve,1_500));
  expect(successorRan).toBe(false);
  release();
  expect(await stuck).toBeInstanceOf(IngestDeadlineExceeded);
  await successor;expect(successorRan).toBe(true);
});
test('waiters that give up free their slots while the pass ahead is still hung',async()=>{
  let release!:()=>void,owning!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const owned=new Promise<void>(resolve=>{owning=resolve;});
  const holder=serializeTranscript('stuck-owner',async()=>{owning();await blocked;});
  await owned;
  const waiters=Array.from({length:ORDINARY_RESERVATIONS-1},()=>serializeTranscript('stuck-owner',async()=>'ran',{timeoutMs:30}).catch(error=>error));
  const gaveUp=await Promise.all(waiters);
  expect(gaveUp.every(error=>error instanceof IngestDeadlineExceeded)).toBe(true);
  await expect(serializeTranscript('unrelated-owner',async()=>42)).resolves.toBe(42);
  release();await holder;
  await expect(serializeTranscript('stuck-owner',async()=>'after')).resolves.toBe('after');
});
test('a sweep refused for capacity syncs its transcript once a reservation frees, instead of skipping it',async()=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const holders=Array.from({length:ORDINARY_RESERVATIONS},(_,i)=>serializeTranscript(`busy-${i}`,()=>blocked));
  await expect(serializeTranscript('swept-file',async()=>{})).rejects.toBeInstanceOf(IngestCapacityError);
  let attempts=0,synced=false;
  const swept=retryOnIngestCapacity(()=>{attempts++;return serializeTranscript('swept-file',async()=>{synced=true;});},{waitMs:60_000});
  await new Promise(resolve=>setTimeout(resolve,20));
  expect(synced).toBe(false);
  release();await Promise.all(holders);
  await swept;
  expect(synced).toBe(true);
  expect(attempts).toBe(2);
  let other=0;
  await expect(retryOnIngestCapacity(async()=>{other++;throw new Error('parse');})).rejects.toThrow('parse');
  expect(other).toBe(1);
});
test('cursor absolute lifetime rejects an otherwise valid next page and closes resources',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'f3-cursor-budget-')),file=path.join(dir,'source.jsonl');
  fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'row',timestamp:'2026-09-05T00:00:00Z',message:{role:'assistant',content:'tiny'}})+'\n');
  const original=Object.getOwnPropertyDescriptor(performance,'now');let now=0;
  const cursors=new IngestCursors();
  try {
    Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
    const first=await cursors.request({action:'open',job:{client:'claude',file,sessionId:'full-id',generation:'generation',offset:0,identity:ingestIdentity(fs.statSync(file))}},'cursor');
    expect(first.done).toBe(false);expect(cursors.size).toBe(1);
    now=60_001;
    await expect(cursors.request({action:'next',cursor:first.cursor,generation:first.generation,sequence:1},'next')).rejects.toThrow(IngestDeadlineExceeded);
    expect(cursors.size).toBe(0);
  } finally {
    if(original)Object.defineProperty(performance,'now',original);else delete (performance as any).now;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('a session just typed into still syncs when ordinary passes hold every slot they may take',async()=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const holders=Array.from({length:ORDINARY_RESERVATIONS},(_,i)=>serializeTranscript(`ingest-session:flood-${i}`,()=>blocked));
  await expect(serializeTranscript('ingest-session:new-subagent',async()=>{})).rejects.toBeInstanceOf(IngestCapacityError);
  await expect(serializeTranscript('ingest-session:recipient',async()=>{})).rejects.toBeInstanceOf(IngestCapacityError);
  awaitDeliveryEcho('recipient');
  await expect(serializeTranscript('ingest-session:recipient',async()=>'echo synced')).resolves.toBe('echo synced');
  awaitDeliveryEcho('expired',Date.now()-6*60_000);
  await expect(serializeTranscript('ingest-session:expired',async()=>{})).rejects.toBeInstanceOf(IngestCapacityError);
  release();await Promise.all(holders);
});
