import {afterEach,expect,test} from 'bun:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {configureDaemonWorkers,closeDaemonWorkers,scanWorkerHost} from './bridge.js';
import {findSessionFile,ensureSessionFileIndex,refreshSessionFileIndex,resetSessionFileIndexForTests,refreshRecentSessionFileForTests,sessionProcessOwnership,findStaleSessionFiles,findStaleCodexSessionFiles,findStaleCursorTranscriptFiles,computeLocalProjectRoots,refreshLocalProjectRoots,invalidateLocalProjectRoots,readAvailableSkills,resetSkillsScanMemoForTests} from '../daemon.js';
import {findUnsyncedFilesAsync} from '../syncLedger.js';
import {isTranscriptFileInSyncScope,performReconciliation} from '../reconciliation.js';
import {watchDirFilter} from '../syncScope.js';
import {setSlowSyncFsThresholdForTests,setSlowSyncSink} from '../slowSync.js';
const originalHome=process.env.HOME;const dirs:string[]=[];
const temp=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'f2-index-'));dirs.push(d);return d;};
const write=(home:string,rel:string,text='{}\n')=>{const p=path.join(home,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text);return p;};
const start=(enabled:boolean)=>configureDaemonWorkers(enabled,{}, {invocation:{command:process.execPath,args:[path.resolve(import.meta.dir,'../main.ts'),'_worker','scan']}});
afterEach(()=>{resetSessionFileIndexForTests();resetSkillsScanMemoForTests();invalidateLocalProjectRoots();closeDaemonWorkers();process.env.HOME=originalHome;setSlowSyncSink(null);setSlowSyncFsThresholdForTests(null);for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true});});
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555'];
for(const enabled of [false,true])test(`production index, recent lookup, stale and scope decisions agree with worker=${enabled}`,async()=>{
 const home=temp();process.env.HOME=home;resetSessionFileIndexForTests();start(enabled);
 const paths=[write(home,`.claude/projects/p/${ids[0]}.jsonl`),write(home,`.codex/sessions/2026/09/05/rollout-${ids[1]}.jsonl`),write(home,`.gemini/tmp/hash/chats/${ids[2]}.json`),write(home,`.pi/agent/sessions/slug/time_${ids[3]}.jsonl`),write(home,`.grok/sessions/slug/${ids[4]}/updates.jsonl`)];
 const reports:string[]=[];setSlowSyncFsThresholdForTests(0);setSlowSyncSink(s=>reports.push(s));
 if(enabled)expect(findSessionFile(ids[0],{staleOk:true})).toBeNull();
 await ensureSessionFileIndex();expect(ids.map(id=>findSessionFile(id,{staleOk:true})?.path)).toEqual(paths);
 if(enabled){expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);expect(reports.some(s=>s.includes('walkDirsSync'))).toBe(false);}
 const newId='66666666-6666-4666-8666-666666666666';const newFile=write(home,`.claude/projects/p/${newId}.jsonl`);
 if(enabled){expect(findSessionFile(newId)).toBeNull();await refreshRecentSessionFileForTests(newId);}
 expect(findSessionFile(newId)?.path).toBe(newFile);
 fs.unlinkSync(newFile);expect(findSessionFile(newId,{staleOk:true})).toBeNull();
 const managed=write(home,'.codex/sessions/2026/09/05/managed.jsonl',JSON.stringify({type:'session_meta',payload:{originator:'codecast',source:{custom:'codecast'}}})+'\n');
 write(home,'.cursor/projects/p/agent-transcripts/a.txt','text');
 expect((await findStaleSessionFiles()).sort()).toEqual([paths[0]]);
 expect((await findStaleCodexSessionFiles()).sort()).toEqual([paths[1]]);expect(await findStaleCodexSessionFiles()).not.toContain(managed);
 expect(await findStaleCursorTranscriptFiles()).toEqual([path.join(home,'.cursor/projects/p/agent-transcripts/a.txt')]);
 const allowed=path.join(home,'src','allowed');const denied=path.join(home,'src','denied');const extraId='77777777-7777-4777-8777-777777777777';const accepted=write(home,`.claude/projects/p/${extraId}.jsonl`,JSON.stringify({type:'user',cwd:allowed})+'\n');write(home,'.claude/projects/q/denied.jsonl',JSON.stringify({type:'user',cwd:denied})+'\n');
 const config:any={sync_mode:'selected',sync_projects:[allowed]};
 const unsynced=await findUnsyncedFilesAsync(path.join(home,'.claude/projects'),undefined,(f,obs)=>isTranscriptFileInSyncScope(f,config,obs?.cwd),watchDirFilter,{dirs:'claudeWatch',files:'jsonl'});
 expect(unsynced).toEqual([accepted]);let queried:string[]=[];
 await performReconciliation({getMessageCountsForReconciliation:async(s:string[])=>{queried=s;return []}} as any,()=>{}, {},50,config);
 expect(queried).toEqual([extraId]);
},15000);

test('an old HOME scan cannot install over a newer root or clear its inflight build',async()=>{
 const a=temp(),b=temp();for(let i=0;i<1400;i++)write(a,`.claude/projects/p/${i}.jsonl`);write(a,`.claude/projects/p/${ids[0]}.jsonl`);const target=write(b,`.claude/projects/p/${ids[0]}.jsonl`);
 start(true);process.env.HOME=a;resetSessionFileIndexForTests();const old=refreshSessionFileIndex();
 process.env.HOME=b;const current=refreshSessionFileIndex();expect(current).not.toBe(old);await Promise.all([old,current]);
 expect(findSessionFile(ids[0],{staleOk:true})?.path).toBe(target);
 resetSessionFileIndexForTests();expect(findSessionFile(ids[0],{staleOk:true})).toBeNull();await ensureSessionFileIndex();expect(findSessionFile(ids[0],{staleOk:true})?.path).toBe(target);
},15000);

test('unknown rollout ownership fails closed while worker scan is pending despite a Claude mirror',async()=>{
 const home=temp();process.env.HOME=home;start(true);resetSessionFileIndexForTests();const id='88888888-8888-4888-8888-888888888888';
 write(home,`.claude/projects/p/${id}.jsonl`);
 write(home,`.codex/sessions/2026/09/05/rollout-${id}.jsonl`,JSON.stringify({type:'session_meta',payload:{id,originator:'codex-tui',thread_source:'subagent',source:{subagent:{thread_spawn:{parent_thread_id:ids[0],depth:1}}}}})+'\n');
 expect(sessionProcessOwnership(id)).toBe('unknown');await ensureSessionFileIndex();await refreshRecentSessionFileForTests(id,true);
 expect(sessionProcessOwnership(id)).toBe('borrowed');
});

test('worker roots and skills retain honest HOME ownership and refresh without synchronous walks',async()=>{
 const a=temp(),b=temp();fs.mkdirSync(path.join(a,'src','one'),{recursive:true});fs.mkdirSync(path.join(b,'src','two'),{recursive:true});write(a,'.claude/skills/one/SKILL.md','---\nname: one\ndescription: first\n---');write(b,'.claude/skills/two/SKILL.md','---\nname: two\ndescription: second\n---');
 process.env.HOME=a;start(true);invalidateLocalProjectRoots();resetSkillsScanMemoForTests();expect(computeLocalProjectRoots()).toEqual([]);await refreshLocalProjectRoots();const first=computeLocalProjectRoots();expect(first).toContain(path.join(a,'src','one'));expect(computeLocalProjectRoots()).toBe(first);expect((await readAvailableSkills()).map(s=>s.name)).toContain('one');
 process.env.HOME=b;expect(computeLocalProjectRoots()).toEqual([]);await refreshLocalProjectRoots();expect(computeLocalProjectRoots()).toContain(path.join(b,'src','two'));const skills=await readAvailableSkills();expect(skills.map(s=>s.name)).toContain('two');expect(skills.map(s=>s.name)).not.toContain('one');
});

test('unreadable fresh rollout evidence cannot become owned and root outage retains last good',async()=>{
 const home=temp();process.env.HOME=home;start(true);resetSessionFileIndexForTests();const root=path.join(home,'.codex/sessions');fs.mkdirSync(root,{recursive:true});fs.mkdirSync(path.join(home,'src','good'),{recursive:true});
 await ensureSessionFileIndex();await refreshLocalProjectRoots();expect(computeLocalProjectRoots()).toContain(path.join(home,'src/good'));
 fs.chmodSync(root,0);fs.chmodSync(path.join(home,'src'),0);
 try{await expect(refreshRecentSessionFileForTests('99999999-9999-4999-8999-999999999999',true)).rejects.toThrow();expect(sessionProcessOwnership('99999999-9999-4999-8999-999999999999')).toBe('unknown');invalidateLocalProjectRoots();await refreshLocalProjectRoots();expect(computeLocalProjectRoots()).toContain(path.join(home,'src/good'));}
 finally{fs.chmodSync(root,0o755);fs.chmodSync(path.join(home,'src'),0o755);}
});

test('capability heartbeat discards delayed old-HOME and reset results',async()=>{
 const {ensureCapabilityInventoryFresh,pendingCapabilityPayload,resetCapabilityHeartbeatState}=await import('../capabilities/heartbeat.js');const a=temp(),b=temp();write(a,'.claude/skills/old/SKILL.md','---\nname: old\ndescription: first\n---');write(b,'.claude/skills/new/SKILL.md','---\nname: new\ndescription: next\n---');start(true);resetCapabilityHeartbeatState();
 const host=scanWorkerHost()!,request=host.request.bind(host);let release!:()=>void;const gate=new Promise<void>(r=>release=r);let arrived!:()=>void;const started=new Promise<void>(r=>arrived=r);
 host.request=async(...args:Parameters<typeof host.request>)=>{const result=await request(...args);const payload=args[1] as any;if(payload?.job?.name==='inventory'&&payload.job.home===a){arrived();await gate;}return result;};
 ensureCapabilityInventoryFresh(a);await started;ensureCapabilityInventoryFresh(b);const deadline=Date.now()+4000;while(!pendingCapabilityPayload()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));expect(pendingCapabilityPayload()?.items.some(i=>i.name==='new')).toBe(true);release();await new Promise(r=>setTimeout(r,80));expect(pendingCapabilityPayload()?.items.some(i=>i.name==='old')).toBe(false);resetCapabilityHeartbeatState();
});

test('Cursor workspace stale observations run in worker and preserve position comparison',async()=>{
 const {Database}=await import('bun:sqlite');const {findStaleCursorSessions}=await import('../daemon.js');const home=temp();process.env.HOME=home;const dir=process.platform==='darwin'?path.join(home,'Library/Application Support/Cursor/User/workspaceStorage/hash'):path.join(home,'.cursor/User/workspaceStorage/hash');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'state.vscdb');const db=new Database(file);db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run("INSERT INTO ItemTable VALUES('workbench.panel.aichat.view.aichat.chatdata','{}')");db.close();fs.writeFileSync(path.join(dir,'workspace.json'),JSON.stringify({folder:'file:///tmp/f2-project'}));start(true);const rows=await findStaleCursorSessions();expect(rows).toHaveLength(1);expect(rows[0].workspacePath).toBe('/tmp/f2-project');expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);expect((await findStaleCursorSessions())[0].dbPath).toBe(file);
});

test('hibernation retains the E1 refusal for old indexed Codex rollouts before any process probe',async()=>{
 const {inspectHibernationTarget}=await import('../daemon.js');const home=temp();process.env.HOME=home;const id='99999999-1111-4111-8111-111111111111';const file=write(home,`.codex/sessions/old/archive/deep/tree/rollout-${id}.jsonl`);fs.utimesSync(path.dirname(file),1000,1000);start(true);resetSessionFileIndexForTests();await ensureSessionFileIndex();expect(await inspectHibernationTarget(id,'f2-no-such-owned-fixture','fixture')).toBeNull();
});
