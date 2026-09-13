import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for (const enabled of [false,true]) test(`production transcript file attachments and plain messages worker=${enabled}`,async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-files-'));
  const bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'files'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(row.files).toBe(true);expect(row.messages).toBe(3);expect(row.positions).toBe(true);
    if(enabled)expect(row.parentParses).toBe(0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},70_000);
for (const enabled of [false,true]) test(`actual production transcript ingestion worker=${enabled}`,async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-ingest-'));
  const bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled)],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.production).toBe(true);expect(row.serialized).toBe(true);expect(row.positions).toBe(true);expect(row.queued).toBe(true);expect(row.formats).toBe(8);if(enabled)expect(row.parentParses).toBe(0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},70_000);

test('metadata failure control rejects the former consume-before-send behavior',async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-mutant-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const error=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),'true','mutant'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:30_000,maxBuffer:2*1024*1024}).then(()=>null,error=>error);
    expect(error).not.toBeNull();expect(error.stderr).toContain('metadata failure skipped primary messages');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},40_000);

test('actual production adversarial transport and failure retry controls',async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-adversarial-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),'true','adversarial'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:90_000,maxBuffer:3*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.adversarial.checks.length).toBeGreaterThanOrEqual(12);expect(row.parentParses).toBe(0);expect(row.fallbackParses).toBeGreaterThan(0);expect(row.adversarial.maxLoopDelayMs).toBeLessThan(1000);console.log(JSON.stringify(row));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},100_000);

for(const mode of ['custody','custody-mutant','retry-mutant']) test(`actual production pending custody ${mode}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-custody-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const runFixture=run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),'true',mode],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:3*1024*1024});
    if(mode!=='custody') {const error=await runFixture.then(()=>null,e=>e);expect(error).not.toBeNull();expect(error.stderr).toContain(mode==='custody-mutant'?'old pending return contract dropped unresolved data':'old return-success contract prevents unchanged-file retry');}
    else {const result=await runFixture,row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.custody.checks).toBe(14);expect(row.custody.failedPersistenceRetainsTranscript).toBe(true);expect(row.custody.uuidlessDistinct).toBe(true);console.log(JSON.stringify(row));}
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},70_000);

for(const enabled of [false,true]) test(`production full-ID app-server skip and lineage worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-registration-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),'registration'],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.registration).toEqual({live:true,persisted:true,pendingFork:true,fullIdSibling:true,lineageSuppressed:true});
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},70_000);

for(const enabled of [false,true]) for(const mode of ['ack','ack-mutant']) test(`actual production queued reread ACK ${mode} worker=${enabled}`,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-ack-')),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const fixture=run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled),mode],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:3*1024*1024});
    if(mode==='ack-mutant'){const error=await fixture.then(()=>null,e=>e);expect(error).not.toBeNull();expect(error.stderr).toContain('queued reread must not ACK a newer prompt');}
    else{const result=await fixture,row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.ack.backendPositive).toBe(true);expect(row.ack.queueExecutor).toBe(true);console.log(JSON.stringify(row));}
  } finally{fs.rmSync(root,{recursive:true,force:true});}
},70_000);
