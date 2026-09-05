import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFile,spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
for(const enabled of [false,true])test.skipIf(process.platform==='win32')(`actual ownership and teardown authority fail closed worker=${enabled}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f2-ownership-'));const id=crypto.randomUUID(),name='f2-owned-'+id,keeper='f2-keeper-'+id;
 const env:NodeJS.ProcessEnv={...process.env,HOME:root,TMUX_TMPDIR:root,NODE_ENV:'test'};delete env.TMUX;
 const socket=path.join(root,`tmux-${process.getuid?.()}`,'default');
 try{
  expect(spawnSync('tmux',['new-session','-d','-s',keeper,'sleep','120'],{env,timeout:3000}).status).toBe(0);
  const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/ownershipSafety.ts'),String(enabled),name,id],{env,timeout:15000,killSignal:'SIGKILL'});
  expect(JSON.parse(result.stdout.trim())).toEqual({enabled,eligibleBefore:true,refusedUnreadable:true,refusedFailedRefresh:true,borrowedReadable:true,positiveOwned:true,homeAndCancellation:true,metricsNoSyncWalk:true,alive:true});
 }finally{
  for(const owned of [name,keeper])spawnSync('tmux',['-S',socket,'kill-session','-t','='+owned],{stdio:'ignore',timeout:2000,killSignal:'SIGKILL'});
  fs.rmSync(root,{recursive:true,force:true});
 }
},20000);
