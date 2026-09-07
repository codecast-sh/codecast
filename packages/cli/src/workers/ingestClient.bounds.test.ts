import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } from './bridge.js';
import { WorkerUnavailable } from './host.js';
import { readTranscriptIngest, serializeTranscript, IngestDeadlineExceeded, ingestIdentity } from './ingestClient.js';
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
test('expired waiters retain their bounded barrier until the active owner settles',async()=>{
  let release!:()=>void;
  const blocked=new Promise<void>(resolve=>{release=resolve;});
  const results=[];
  for(let i=0;i<MAX_QUEUE+MAX_INFLIGHT;i++) results.push(serializeTranscript('capacity-owner',()=>serializeTranscript('capacity-file',async()=>{await blocked;checkTranscriptDeadline();}),{timeoutMs:5}).catch(error=>error));
  await new Promise(resolve=>setTimeout(resolve,20));
  await expect(serializeTranscript('unrelated-owner',async()=>{})).rejects.toThrow('capacity');
  release();const errors=await Promise.all(results);
  expect(errors.every(error=>error instanceof IngestDeadlineExceeded)).toBe(true);
  await new Promise(resolve=>setImmediate(resolve));
  await expect(serializeTranscript('unrelated-owner',async()=>42)).resolves.toBe(42);
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
