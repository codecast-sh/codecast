import {afterEach,expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {RecursiveWatcher} from '../recursiveWatcher.js';
import {transcriptDirWatcherConfig} from '../transcriptDirWatcher.js';
import {watchDirFilter,watchFilter} from '../syncScope.js';
import {scanPredicates} from './scanPolicy.js';
import {configureDaemonWorkers,closeDaemonWorkers,scanWorkerHost} from './bridge.js';
import type {ScanPolicy} from './scanTypes.js';
const dirs:string[]=[];const watchers:RecursiveWatcher[]=[];
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const root=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'f2-watch-'));dirs.push(d);return d;};
const write=(base:string,rel:string)=>{const p=path.join(base,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'{}\n');return p;};
const start=(enabled:boolean)=>configureDaemonWorkers(enabled,{}, {invocation:{command:process.execPath,args:[path.resolve(import.meta.dir,'../main.ts'),'_worker','scan']}});
async function until(f:()=>boolean){const until=Date.now()+5000;while(!f()){if(Date.now()>until)throw new Error('watcher event timeout');await pause(30);}}
afterEach(async()=>{for(const w of watchers.splice(0))w.stop();closeDaemonWorkers();await pause(40);for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const id='12345678-1234-1234-1234-123456789abc';
for(const mode of ['native','chokidar'] as const)for(const enabled of [false,true])test.skipIf(mode==='native'&&process.platform!=='darwin')(`${mode} worker=${enabled} primes sorted, observes real changes and preserves pruning across restart`,async()=>{
 const base=root();const cfg=transcriptDirWatcherConfig('gemini',base);write(base,'hash/chats/old.json');write(base,'hash/checkpoints/no.json');
 const seen:string[]=[];let primes=0,existing:string[]=[];
 start(enabled);
 const w=new RecursiveWatcher({path:base,mode,filter:cfg.watchFilter,dirFilter:cfg.dirFilter,scanPolicy:cfg.scanPolicy,maxDepth:cfg.maxDepth,debounceMs:30,rescanIntervalMs:150,onExisting:files=>{primes++;existing=files.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs).map(f=>f.rel);},callback:(f,event)=>seen.push(`${event}:${path.relative(base,f)}`)});watchers.push(w);
 w.start();await w.whenPrimed();expect(primes).toBe(1);expect(existing).toEqual(['hash/chats/old.json']);if(enabled)expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);
 await pause(250);seen.length=0;write(base,'hash/checkpoints/rejected.json');write(base,'hash/chats/new.json');await until(()=>seen.includes('add:hash/chats/new.json'));
 fs.appendFileSync(path.join(base,'hash/chats/old.json'),'changed\n');await until(()=>seen.includes('change:hash/chats/old.json'));
 expect(seen.some(e=>e.includes('checkpoints'))).toBe(false);
 w.stop();const before=seen.length;write(base,'hash/chats/stopped.json');await pause(250);expect(seen.length).toBe(before);
 await w.restart();await w.whenPrimed();expect(primes).toBe(2);expect(existing).toContain('hash/chats/stopped.json');
},15000);

test('both watcher backends discard delayed priming after stop; crash fallback publishes existing files once',async()=>{
 for(const mode of ['native','chokidar'] as const){
  if(mode==='native'&&process.platform!=='darwin')continue;
  const base=root();for(let i=0;i<350;i++)write(base,`p/${i}.jsonl`);start(true);
  let primes=0;let existing:string[]=[];const policy:ScanPolicy={files:'jsonl'};
  const w=new RecursiveWatcher({path:base,mode,...{filter:scanPredicates(base,policy).fileFilter},scanPolicy:policy,callback:()=>{},onExisting:files=>{primes++;existing=files.map(f=>f.path);},rescanIntervalMs:5000});watchers.push(w);
  w.start();w.stop();await w.whenPrimed();expect(primes).toBe(0);
  const host=scanWorkerHost()!;const request=host.request.bind(host);let killed=false;
  host.request=async(...args:Parameters<typeof host.request>)=>{const result:any=await request(...args);if(args[0]==='scan'&&result.rows.length&&!killed){killed=true;process.kill(host.state.pid!,'SIGKILL');}return result;};
  await w.restart();await w.whenPrimed();expect(primes).toBe(1);expect(existing).toHaveLength(350);expect(new Set(existing).size).toBe(350);w.stop();closeDaemonWorkers();
 }
},20000);

test('production Claude, Codex, Pi, Grok and vault policies prime actual watcher scans',async()=>{
 const layouts:Array<{policy:ScanPolicy,depth:number,good:string,bad:string}>= [
 {policy:{dirs:'claudeWatch',files:'claudeWatch'},depth:6,good:`p/${id}/subagents/agent-a.jsonl`,bad:`p/${id}/tool-results/x.jsonl`},
 {policy:transcriptDirWatcherConfig('codex').scanPolicy!,depth:4,good:'2026/09/05/a.jsonl',bad:'scratch/09/05/x.jsonl'},
 {policy:transcriptDirWatcherConfig('pi').scanPolicy!,depth:2,good:'slug/a.jsonl',bad:'slug/deeper/x.jsonl'},
 {policy:transcriptDirWatcherConfig('grok').scanPolicy!,depth:3,good:`slug/${id}/updates.jsonl`,bad:'slug/not-uuid/updates.jsonl'},
 {policy:{dirs:'vault',files:'vault'},depth:6,good:'notes/a.md',bad:'node_modules/a.md'},
 ];
 for(const layout of layouts){const base=root();write(base,layout.good);write(base,layout.bad);start(true);const predicates=scanPredicates(base,layout.policy);let rows:string[]=[];const w=new RecursiveWatcher({path:base,filter:predicates.fileFilter,dirFilter:predicates.dirFilter,scanPolicy:layout.policy,maxDepth:layout.depth,callback:()=>{},onExisting:files=>{rows=files.map(f=>f.rel);}});watchers.push(w);w.start();await w.whenPrimed();expect(rows).toEqual([layout.good]);expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);w.stop();closeDaemonWorkers();}
},15000);

test.skipIf(process.platform!=='darwin')('native idle cadence stays serial; rejected events cannot accelerate it; stop removes all work',async()=>{
 for(const enabled of [false,true]){
  const base=root();write(base,'hash/chats/a.json');write(base,'hash/checkpoints/a.json');start(enabled);
  const cfg=transcriptDirWatcherConfig('gemini',base);const w=new RecursiveWatcher({path:base,mode:'native',filter:cfg.watchFilter,dirFilter:cfg.dirFilter,scanPolicy:cfg.scanPolicy,maxDepth:cfg.maxDepth,callback:()=>{},rescanIntervalMs:180,debounceMs:10});watchers.push(w);
  const internals=w as any,walk=internals.walkTree.bind(w);let active=0,maxActive=0;const starts:number[]=[],ends:number[]=[];
  internals.walkTree=async(...args:any[])=>{starts.push(Date.now());active++;maxActive=Math.max(active,maxActive);try{await pause(35);await walk(...args);}finally{active--;ends.push(Date.now());}};
  w.start();await w.whenPrimed();
  for(let i=0;i<40;i++){fs.appendFileSync(path.join(base,'hash/checkpoints/a.json'),'x');internals.onNativeEvent('hash/checkpoints/a.json');await pause(20);}
  expect(starts.length).toBeGreaterThanOrEqual(3);expect(starts.length).toBeLessThanOrEqual(5);expect(maxActive).toBe(1);expect(internals.probeTimers.size).toBe(0);
  for(let i=1;i<starts.length;i++)expect(starts[i]-ends[i-1]).toBeGreaterThanOrEqual(165);
  w.stop();const count=starts.length;await pause(280);expect(starts.length).toBe(count);expect(internals.rescanTimer).toBeNull();expect(internals.probeTimers.size).toBe(0);expect(active).toBe(0);closeDaemonWorkers();
 }
},10000);

test('stop during restart delay cannot reopen a watcher',async()=>{
 const base=root();const w=new RecursiveWatcher({path:base,filter:()=>true,callback:()=>{}});watchers.push(w);w.start();await w.whenPrimed();const restarting=w.restart();w.stop();await restarting;expect(w.isWatching).toBe(false);
});
