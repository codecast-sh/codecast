import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureDaemonWorkers, closeDaemonWorkers, scanWorkerHost } from './bridge.js';
import { collectScan, visitScan } from './scanClient.js';
import { SCAN_PAGE_BYTES, SCAN_PAGE_ROWS, validScanPayload, type ScanPolicy } from './scanTypes.js';
import { scanPredicates } from './scanPolicy.js';
import { walkFiles, walkEntryBatches, type WalkFile } from '../fsWalk.js';
import { readInventoryAsync, readInventoryAsyncLocal } from '../capabilities/inventory.js';
import { enumerateLocalRootsAsync } from '../projectRoots.js';
import { readInstalledPluginObservations, readInstalledPluginObservationsAsync } from '../capabilities/manifests.js';
const dirs: string[]=[];
const temp=()=> { const d=fs.mkdtempSync(path.join(os.tmpdir(),'f2-scan-')); dirs.push(d); return d; };
const write=(root:string,rel:string,text='{}\n')=> { const f=path.join(root,rel);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);return f; };
const start=()=> configureDaemonWorkers(true, {}, {invocation:{command:process.execPath,args:[path.resolve(import.meta.dir,'../main.ts'),'_worker','scan']}});
afterEach(()=> {closeDaemonWorkers();for(const d of dirs.splice(0)) fs.rmSync(d,{recursive:true,force:true});});
const id='12345678-1234-1234-1234-123456789abc';
test('named production policies match local traversal on actual layouts, pruning every ancestor and skipping symlinks',async()=> {
 const root=temp();
 for(const rel of ['top.jsonl',`slug/${id}.jsonl`,`slug/${id}/subagents/agent-a.jsonl`,`slug/${id}/subagents/workflows/wf_one/agent-b.jsonl`,`slug/${id}/tool-results/ignored.jsonl`,`slug/bad/subagents/agent-c.jsonl`,'hash/chats/session.json','hash/checkpoints/bad.json','2026/09/05/rollout-x.jsonl','scratch/09/05/bad.jsonl',`slug/${id}/updates.jsonl`,'p/agent-transcripts/a/a.txt','p/mcps/bad.txt','p/state.vscdb','p/state.vscdb-wal','node_modules/pkg/x.jsonl']) write(root,rel);
 fs.symlinkSync(path.join(root,'slug'),path.join(root,'linked-dir'));
 fs.symlinkSync(path.join(root,'top.jsonl'),path.join(root,'linked-file.jsonl'));
 const cases: Array<[ScanPolicy,number]>=[ [{dirs:'claudeWatch',files:'claudeWatch'},6],[{dirs:'claudeIndex',files:'claudeIndex'},6],[{files:'all'},4],[{dirs:'codexWatch',files:'jsonl'},4],[{dirs:'gemini',files:'geminiIndex'},3],[{dirs:'gemini',files:'geminiWatch'},3],[{files:'piIndex'},2],[{files:'grokIndex'},3],[{dirs:'grokWatch',files:'grokWatch'},3],[{dirs:'cursor',files:'cursor'},5],[{files:'cursorStale'},5],[{files:'cursorDb'},2],[{dirs:'claudeWatch',files:'reconciliation'},6],[{files:'plan'},2],[{dirs:'vault',files:'vault'},8] ];
 for(const [policy,maxDepth] of cases) {
   closeDaemonWorkers(); const opts={...scanPredicates(root,policy),policy,maxDepth};
   const local:WalkFile[]=[];await walkFiles(root,opts,f=>local.push(f));
   start(); const remote:WalkFile[]=[];await walkFiles(root,opts,f=>remote.push(f));
   const normalize=(files:WalkFile[])=>files.map(f=>[f.rel,f.depth,f.stat.mtimeMs,f.stat.size,f.stat.isFile()]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
   expect(normalize(remote)).toEqual(normalize(local));
   expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);
 }
 const missing:WalkFile[]=[];await walkFiles(path.join(root,'absent'),{policy:{}},f=>missing.push(f));expect(missing).toEqual([]);
});
test('large trees use bounded pages, apply batches with yielding, and parents precede descendants',async()=> {
 const root=temp();
 for(let i=0;i<2200;i++) write(root,`d/f${String(i).padStart(5,'0')}.jsonl`);
 write(root,'d/child/nested.jsonl');write(root,'root.jsonl');start();
 let count=0,pages=0,ticks=0;const timer=setInterval(()=>ticks++,1);
 try {
 await visitScan({name:'walk',root,policy:{files:'jsonl'},stats:true},rows=> {pages++;expect(rows.length).toBeLessThanOrEqual(SCAN_PAGE_ROWS);expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(SCAN_PAGE_BYTES);count+=rows.length;});
 expect(count).toBe(2202);expect(pages).toBeGreaterThan(10);expect(ticks).toBeGreaterThan(0);
 const entries:string[]=[];await walkEntryBatches(root,{policy:{files:'jsonl'}},batch=> {expect(batch.length).toBeLessThanOrEqual(128);entries.push(...batch.map(f=>f.rel));});
 expect(entries[0]).toBe('root.jsonl');expect(entries.indexOf('d/child/nested.jsonl')).toBeGreaterThan(entries.indexOf('d/f02199.jsonl'));
 } finally {clearInterval(timer);}
});
test('crash after a delivered scan page falls back without duplicate observations',async()=> {
 const root=temp();for(let i=0;i<500;i++)write(root,`${i}.jsonl`);start();let killed=false;const seen:string[]=[];
 await walkFiles(root,{policy:{files:'jsonl'},fileFilter:r=>r.endsWith('.jsonl')},f=> {seen.push(f.path);if(!killed){killed=true;process.kill(scanWorkerHost()!.state.pid!,'SIGKILL');}});
 expect(seen).toHaveLength(500);expect(new Set(seen).size).toBe(500);
});
test('cancellation after a page discards all later pages without fallback',async()=> {
 const root=temp();for(let i=0;i<350;i++)write(root,`${i}.jsonl`);start();const abort=new AbortController();let rows=0;
 await expect(visitScan({name:'walk',root,policy:{},stats:false},batch=> {rows+=batch.length;abort.abort();},abort.signal)).rejects.toThrow('stopped');
 expect(rows).toBe(128);expect(scanWorkerHost()!.state.pending).toBe(0);
});
test('inventory, plugin manifests and roots are real worker observations with local parity',async()=> {
 const home=temp();write(home,'.claude/skills/own/SKILL.md','---\nname: own\ndescription: own skill\n---\ntext');write(home,'.agents/skills/shared/SKILL.md','---\nname: shared\ndescription: shared skill\n---\ntext');fs.mkdirSync(path.join(home,'.codex'),{recursive:true});
 const project=path.join(home,'src','repo');fs.mkdirSync(project,{recursive:true});fs.symlinkSync(project,path.join(home,'src','linked'));write(home,'.claude/plugins/installed_plugins.json',JSON.stringify({version:2,plugins:{'fixture@market':[{scope:'user',version:'1'}]}}));write(home,'.claude/plugins/cache/market/fixture/1/.claude-plugin/plugin.json',JSON.stringify({name:'fixture'}));write(home,'.claude/plugins/cache/market/fixture/1/scripts/a.sh','true');
 const inv=await readInventoryAsyncLocal(home);const manifests=readInstalledPluginObservations(home);const roots=await enumerateLocalRootsAsync(home,[project]);start();
 expect(await readInventoryAsync(home)).toEqual(inv);expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);
 expect(await readInstalledPluginObservationsAsync(home)).toEqual(manifests);
 const rows=await collectScan({name:'roots',home,started:[project]});expect(rows.map(r=>r.type==='root'?r.path:null)).toEqual(roots);
});
test('scan protocol refuses callback code, unknown policies, oversized paths and mutation jobs',()=> {
 for(const job of [{name:'exec',root:'/tmp'},{name:'walk',root:'/tmp',stats:true,policy:{dirs:'eval',callback:'x'}},{name:'walk',root:'/tmp',stats:true,policy:{},callback:'x'},{name:'walk',root:'x'.repeat(5000),stats:true,policy:{}}])expect(validScanPayload({action:'open',job})).toBe(false);
});

test('missing, unreadable and deleted entries preserve local parity and policy-only crash fallback',async()=>{
 const root=temp();write(root,'ok/a.jsonl');write(root,'deny/a.jsonl');fs.chmodSync(path.join(root,'deny'),0);
 try{const off:WalkFile[]=[];await walkFiles(root,{policy:{files:'jsonl'}},f=>off.push(f));start();const on:WalkFile[]=[];await walkFiles(root,{policy:{files:'jsonl'}},f=>on.push(f));expect(on.map(f=>f.rel)).toEqual(off.map(f=>f.rel));expect(on.map(f=>f.rel)).toEqual(['ok/a.jsonl']);}finally{fs.chmodSync(path.join(root,'deny'),0o755);}
 closeDaemonWorkers();const large=temp();for(let i=0;i<500;i++)write(large,`${String(i).padStart(4,'0')}.jsonl`);write(large,'exclude.txt');start();let killed=false;const seen:string[]=[];
 await walkFiles(large,{policy:{files:'jsonl'}},f=>{seen.push(f.rel);if(!killed){killed=true;fs.unlinkSync(path.join(large,'0499.jsonl'));process.kill(scanWorkerHost()!.state.pid!,'SIGKILL');}});expect(seen).toHaveLength(499);expect(new Set(seen).size).toBe(499);expect(seen).not.toContain('exclude.txt');
});

test('old scan replies after runtime replacement are discarded and open cursors are bounded',async()=>{
 const root=temp();for(let i=0;i<300;i++)write(root,`${i}.jsonl`);start();const host=scanWorkerHost()!,request=host.request.bind(host);let release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>arrived=r);
 host.request=async(...args:Parameters<typeof host.request>)=>{const result=await request(...args);arrived();await gate;return result;};let applied=0;const old=visitScan({name:'walk',root,policy:{},stats:false},rows=>{applied+=rows.length;});const rejected=old.then(()=>null,error=>error);await started;closeDaemonWorkers();start();expect((await collectScan({name:'walk',root,policy:{},stats:false}))).toHaveLength(300);release();expect((await rejected)?.message).toContain('stopped');expect(applied).toBe(0);
 const current=scanWorkerHost()!;const pages:any[]=[];for(let i=0;i<4;i++)pages.push(await current.request('scan',{action:'open',job:{name:'walk',root,policy:{},stats:false}}));await expect(current.request('scan',{action:'open',job:{name:'walk',root,policy:{},stats:false}})).rejects.toThrow('busy');for(const page of pages)expect((await current.request('scan',{action:'close',cursor:page.cursor}) as any).done).toBe(true);expect(current.state.pending).toBe(0);
});
