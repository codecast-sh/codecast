import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const enabled of [false,true]) test(`production TaskCreate custody worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'task-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({backend:true,unknownBefore:true,lostResponse:true,nativeReplacement:true,legacyUpdate:true,numericUpdate:true,mappingFence:true,oneShotReplay:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},40_000);

for(const enabled of [false,true]) test(`production scheduled transcript recovery worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'scheduled-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({formats:8,scheduled:true,zeroManaged:true,unchanged:true,burstExhausted:true,stopped:true});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},40_000);

for(const enabled of [false,true]) test(`production receipt and generation custody worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-review-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try{
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'custody-review'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.review).toEqual({lateAcceptance:6,countMapping:true,legacyFreshAppend:true,mismatchCold:true,evictedReplacement:true,countReplacement:true,receiptCapacity:2048,healthyProgress:true,oversizedPendingBypass:true,scheduledOccurrences:2500});
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
},40_000);
