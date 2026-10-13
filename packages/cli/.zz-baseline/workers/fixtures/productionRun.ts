import {expect} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from '../../proc.js';
import {promisify} from 'node:util';
import {loadScaledMs} from '../../test-helpers/machineLoad.js';
import {pollUntil} from '../../test-helpers/pollUntil.js';

// The test side of fixtures/ingestProduction.ts: every e2e test that runs it
// gets its scratch HOME, its run and its cleanup here. Each wall-clock bound
// stretches with the machine's load (loadScaledMs), and so must the test's own
// timeout: pass it through loadScaledMs too.
const execFileAsync=promisify(execFile);
const FIXTURE=path.join(import.meta.dir,'ingestProduction.ts');

export type ProductionHome={root:string;env:NodeJS.ProcessEnv};
export type ProductionOutcome={ok:boolean;code?:unknown;signal?:unknown;stdout:string;stderr:string;error?:string};

/** A scratch HOME for one run: tmux, ps, lsof and every agent CLI on its PATH
 *  exit 1, so the run reaches nothing of this machine's. */
export function productionHome(prefix:string):ProductionHome {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),prefix)),bin=path.join(root,'bin'),tmp=path.join(root,'tmux');
  fs.mkdirSync(bin);fs.mkdirSync(tmp);
  for(const name of ['tmux','ps','lsof','claude','codex','gemini','opencode','pi','grok'])fs.writeFileSync(path.join(bin,name),'#!/bin/sh\nexit 1\n',{mode:0o755});
  return {root,env:{...process.env,HOME:root,TMUX_TMPDIR:tmp,TMUX:'',PATH:bin+path.delimiter+process.env.PATH,NODE_ENV:'test'}};
}

/** Runs the fixture with `args` (the worker flag, then the mode) in `home`. It
 *  rejects as execFile does; `settled` turns either end into an outcome. */
export function runProduction(home:ProductionHome,args:string[],{env={},timeoutMs=60_000,maxBuffer=2*1024*1024}:{env?:NodeJS.ProcessEnv;timeoutMs?:number;maxBuffer?:number}={}) {
  return execFileAsync(process.execPath,[FIXTURE,...args],{env:{...home.env,...env},timeout:loadScaledMs(timeoutMs),maxBuffer});
}

export function settled(run:ReturnType<typeof runProduction>):Promise<ProductionOutcome> {
  return run.then(output=>({ok:true,code:0,...output}),(error:any)=>({ok:false,code:error.code,signal:error.signal,stdout:error.stdout??'',stderr:error.stderr??'',error:String(error)}));
}

/** The fixture's result: the last line it printed. */
export const resultRow=(stdout:string)=>JSON.parse(stdout.trim().split('\n').at(-1)!);

/** The JSON records the run left in `root` under names matching `pattern`:
 *  one per file, or one per line with `lines`. */
export function records(root:string,pattern:RegExp,{lines=false}={}):any[] {
  return fs.readdirSync(root).filter(name=>pattern.test(name)).flatMap(name=>{
    const text=fs.readFileSync(path.join(root,name),'utf8');
    return lines?text.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[JSON.parse(text)];
  });
}

const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};

/** Waits for the processes the run recorded (by default every fixture process)
 *  to exit and expects none left. The scratch HOME is removed only then, so a
 *  leak leaves it behind for inspection. */
export async function releaseProductionHome(root:string,owned:number[]=records(root,/^fixture-process-\d+\.json$/).map(row=>row.pid)):Promise<void> {
  // A timeout is not the failure here: the expect below names the survivors.
  await pollUntil(()=>!owned.some(alive),'fixture processes exit',{ms:2000,every:10}).catch(()=>{});
  const remaining=owned.filter(alive);
  console.log(JSON.stringify({fixtureRoot:root,ownedPids:owned,remaining}));
  expect(remaining).toEqual([]);
  fs.rmSync(root,{recursive:true,force:true});
}

export const sha256=(text:string)=>createHash('sha256').update(text).digest('hex');

/** A mutant of the module at `originalPath`: `needle`, which must occur once,
 *  replaced by `replacement`, written into `root` as `name` with every import
 *  made absolute so it runs from there. The hashes prove which copy ran. */
export function mutantCopy(root:string,originalPath:string,needle:string,replacement:string,name:string) {
  const original=fs.readFileSync(originalPath,'utf8');
  expect(original.split(needle).length).toBe(2);
  let scratch=original.replace(needle,()=>replacement);
  for(const imp of new Bun.Transpiler({loader:'ts'}).scan(scratch).imports)if(!imp.path.startsWith('node:')&&!imp.path.startsWith('bun:')){
    const absolute=Bun.resolveSync(imp.path,path.dirname(originalPath));
    for(const quote of ['"',"'"])scratch=scratch.replaceAll(quote+imp.path+quote,quote+absolute+quote);
  }
  const file=path.join(root,name);fs.writeFileSync(file,scratch);
  return {originalPath,originalSha256:sha256(original),file,scratchSha256:sha256(scratch)};
}
