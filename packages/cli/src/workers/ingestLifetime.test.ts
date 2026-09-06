import {expect,test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {WorkerHost} from './host.js';
import {ingestIdentity} from './ingestJobs.js';
const main=path.resolve(import.meta.dir,'../main.ts');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
test('actual parent death and stdin EOF release an ingest cursor process',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'f3-lifetime-')),file=path.join(root,'input.jsonl');
  fs.writeFileSync(file,JSON.stringify({type:'user',uuid:'owned',message:{role:'user',content:'a'.repeat(400_000)}})+'\n');
  let parent:ReturnType<typeof spawn>|undefined,worker:number|undefined,host:WorkerHost|undefined;
  const until=async(fn:()=>boolean)=>{const end=Date.now()+8000;while(!fn()){if(Date.now()>end)throw new Error('owned cleanup timeout');await delay(20);}};
  try {
    parent=spawn(process.execPath,[path.join(import.meta.dir,'fixtures/ingestParent.ts'),main,file],{env:{...process.env,HOME:root,TMUX_TMPDIR:root,TMUX:''},stdio:['ignore','pipe','pipe']});
    let output='',diagnostic='';parent.stdout!.on('data',b=>{output+=b;});parent.stderr!.on('data',b=>{diagnostic+=b;});
    await until(()=>output.includes('\n')||parent!.exitCode!==null);expect(diagnostic).toBe('');
    const row=JSON.parse(output);worker=row.workerPid;expect(row.pageTokens).toBeGreaterThan(0);expect(alive(worker!)).toBe(true);
    parent.kill('SIGKILL');await until(()=>!alive(worker!));expect(alive(worker!)).toBe(false);
    host=new WorkerHost('ingest',{invocation:{command:process.execPath,args:[main,'_worker','ingest']},env:{...process.env,HOME:root,TMUX_TMPDIR:root}});
    await host.request('ingest',{action:'open',job:{client:'claude',file,sessionId:'eof',generation:'eof-generation',identity:ingestIdentity(fs.statSync(file)),offset:0}});
    worker=host.state.pid!;(host as any).child.stdin.end();await until(()=>!alive(worker!));expect(host.state.pid).toBeNull();
    const files=fs.readdirSync(root,{recursive:true}).map(String);
    expect(files.filter(f=>f!== 'input.jsonl' && f!== 'Library' && f!== 'Library/Caches' && !f.startsWith('Library/Caches/bun'))).toEqual([]);
  } finally {host?.close();if(parent&&parent.exitCode===null)parent.kill('SIGKILL');if(worker&&alive(worker))process.kill(worker,'SIGKILL');fs.rmSync(root,{recursive:true,force:true});}
},20_000);
