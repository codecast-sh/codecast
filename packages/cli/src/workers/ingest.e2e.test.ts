import {test,expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for (const enabled of [false,true]) test(`actual production transcript ingestion worker=${enabled}`,async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-ingest-'));
  const bin=path.join(root,'bin'),tmp=path.join(root,'tmux');fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  try {
    const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ingestProduction.ts'),String(enabled)],{env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'},timeout:60_000,maxBuffer:2*1024*1024});
    const row=JSON.parse(result.stdout.trim().split('\n').at(-1)!);expect(row.production).toBe(true);expect(row.serialized).toBe(true);expect(row.positions).toBe(true);expect(row.queued).toBe(true);expect(row.formats).toBe(7);if(enabled)expect(row.parentParses).toBe(0);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
},70_000);
