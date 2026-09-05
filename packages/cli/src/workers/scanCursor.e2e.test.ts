import {expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const run=promisify(execFile);
for(const enabled of [false,true])test.skipIf(process.platform==='win32')(`Cursor composer SQLite and actual hot callers worker=${enabled}`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'f2-cursor-'));
 try{
  const result=await run(process.execPath,[path.join(import.meta.dir,'fixtures/cursorWorkspace.ts'),String(enabled)],{env:{...process.env,HOME:root,NODE_ENV:'test'},timeout:15000,killSignal:'SIGKILL'});
  const row=JSON.parse(result.stdout.trim().split("\n").at(-1)!);expect(row).toEqual({enabled,polling:true,parentOpens:enabled?0:expect.any(Number),scopeParity:true,walRefresh:true,homeRefresh:true,lateRefused:true,unreadableDeleted:true,actualCallers:true});if(!enabled)expect(row.parentOpens).toBeGreaterThan(0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
},20000);
