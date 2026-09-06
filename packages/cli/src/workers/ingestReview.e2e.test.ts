import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
async function cleanup(root:string) {
  const owned=fs.readdirSync(root).filter(name=>/^fixture-process-\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8')).pid as number);
  const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
  const end=Date.now()+2000;while(owned.some(alive)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
  const remaining=owned.filter(alive);console.log(JSON.stringify({fixtureRoot:root,ownedPids:owned,remaining}));
  expect(remaining).toEqual([]);if(!remaining.length)fs.rmSync(root,{recursive:true,force:true});
}
for(const enabled of [false,true]) test(`production TaskCreate custody worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'task-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    console.log(result.stderr);
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({backend:true,unknownBefore:true,lostResponse:true,nativeReplacement:true,legacyUpdate:true,numericUpdate:true,mappingFence:true,oneShotReplay:true,permissionEpoch:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{await cleanup(root);}
},40_000);

for(const enabled of [false,true]) test(`production scheduled transcript recovery worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'scheduled-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    console.log(result.stderr);
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({formats:8,scheduled:true,zeroManaged:true,unchanged:true,burstExhausted:true,authPause:true,stopped:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{await cleanup(root);}
},40_000);

for(const enabled of [false,true]) test(`production receipt and generation custody worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'custody-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    console.log(result.stderr);
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({lateAcceptance:6,readGeneration:6,countMapping:true,legacyFreshAppend:true,mismatchCold:true,evictedReplacement:true,countReplacement:true,receiptCapacity:2048,healthyProgress:true,oversizedPendingBypass:true,scheduledOccurrences:2500,continuationWake:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{await cleanup(root);}
},40_000);

for(const enabled of [false,true]) test(`production scheduled disappearance cleanup worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'disappearance-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    console.log(result.stderr);
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.review).toEqual({scheduledMissingSource:true,logicalSessionRemoved:true,otherLogicalReceiptPreserved:true,stopped:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}console.log(JSON.stringify(row));
  }finally{await cleanup(root);}
},40_000);
