import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } from './bridge.js';
import { WorkerUnavailable } from './host.js';
import { readTranscriptIngest, serializeTranscript, IngestDeadlineExceeded, IngestCapacityError, ingestIdentity, retryOnIngestCapacity } from './ingestClient.js';
import { ingestTokens } from './ingestTransport.js';
import { checkTranscriptDeadline } from './ingestDeadline.js';
import { IngestCursors } from './ingestCursors.js';
import { MAX_QUEUE, MAX_INFLIGHT } from './protocol.js';

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
// 2026-11-05: a pass hung on a local file read for 2h56m kept its transcript's
// lock, so every later pass spent its budget waiting and failed with "ingest
// transaction deadline". The lock now ends with the pass's deadline; the hung
// work keeps its expired deadline, so whatever it does on waking cannot commit.
test('a pass hung past its deadline releases the lock, and cannot commit when it wakes',async()=>{
  let release!:()=>void,oldDone!:()=>void,position=0;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const oldSettled=new Promise<void>(resolve=>{oldDone=resolve;});
  const order:string[]=[];
  const first=serializeTranscript('held-session',()=>serializeTranscript('held-file',async()=>{
    try { await blocked;order.push('old resumed');checkTranscriptDeadline();position++; } finally { oldDone(); }
  }),{timeoutMs:50}).catch(error=>error);
  expect(await first).toBeInstanceOf(IngestDeadlineExceeded);
  const next=await serializeTranscript('held-session',()=>serializeTranscript('held-file',async()=>{order.push('new ran');position++;return 'synced';}));
  expect(next).toBe('synced');
  release();await oldSettled;
  expect(order).toEqual(['new ran','old resumed']);
  expect(position).toBe(1);
});
test('waiters that give up free their slots while the pass ahead is still hung',async()=>{
  let release!:()=>void,owning!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const owned=new Promise<void>(resolve=>{owning=resolve;});
  const holder=serializeTranscript('stuck-owner',async()=>{owning();await blocked;});
  await owned;
  const waiters=Array.from({length:MAX_QUEUE+MAX_INFLIGHT-1},()=>serializeTranscript('stuck-owner',async()=>'ran',{timeoutMs:30}).catch(error=>error));
  const gaveUp=await Promise.all(waiters);
  expect(gaveUp.every(error=>error instanceof IngestDeadlineExceeded)).toBe(true);
  await expect(serializeTranscript('unrelated-owner',async()=>42)).resolves.toBe(42);
  release();await holder;
  await expect(serializeTranscript('stuck-owner',async()=>'after')).resolves.toBe('after');
});
test('a sweep refused for capacity syncs its transcript once a reservation frees, instead of skipping it',async()=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const holders=Array.from({length:MAX_QUEUE+MAX_INFLIGHT},(_,i)=>serializeTranscript(`busy-${i}`,()=>blocked));
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
