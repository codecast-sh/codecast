import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const enabled of [false,true])test.skipIf(process.platform==='win32')(`incomplete old/deep Codex evidence refuses an eligible owned pane worker=${enabled}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f2-safe-'));const id=crypto.randomUUID(),name='f2-owned-'+id;
 const env:NodeJS.ProcessEnv={...process.env,HOME:root,TMUX_TMPDIR:root,NODE_ENV:'test'};delete env.TMUX;
 try{
  const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/scanSafety.ts'),String(enabled),name,id],{env,timeout:10000,killSignal:'SIGKILL'});
  expect(JSON.parse(result.stdout.trim())).toEqual({eligibleBefore:true,refusedCached:true,refusedIncomplete:true,alive:true});
 }finally{
  spawnSync('tmux',['-S',path.join(root,`tmux-${process.getuid?.()}`,'default'),'kill-session','-t','='+name],{stdio:'ignore',timeout:2000,killSignal:'SIGKILL'});
  fs.rmSync(root,{recursive:true,force:true});
 }
},15000);
