import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as localParsers from '../../parser.js';
import { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } from '../bridge.js';
const enabled = process.argv[2] === 'true', home = process.env.HOME!;
console.error('F3_FIXTURE_PROCESS '+JSON.stringify({pid:process.pid,ppid:process.ppid,mode:process.argv[3],enabled}));
async function closeFixtureWorkers() {
  const pid=ingestWorkerHost()?.state.pid;
  closeDaemonWorkers();
  const alive=()=>{if(!pid)return false;try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
  const end=Date.now()+2000;
  while(alive()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
  const remaining=alive();console.error('F3_FIXTURE_CLEANUP '+JSON.stringify({pid:process.pid,workerPid:pid??null,remaining}));
  assert.equal(remaining,false,'owned worker must exit before fixture cleanup');
}

assert.ok(home.includes('f3-'));
assert.ok(process.env.TMUX_TMPDIR?.includes('f3-'));
fs.writeFileSync(path.join(home,'fixture-process-'+process.pid+'.json'),JSON.stringify({pid:process.pid,ppid:process.ppid}));
const parse = localParsers.parseTranscriptFor, parseCodex = localParsers.parseCodexSessionFile, parseClaude = localParsers.parseSessionFile;
let parentParses = 0, fallbackParses = 0, fallbackAllowed = false;
mock.module('../../parser.js',() => ({...localParsers,
  parseTranscriptFor:(...args:Parameters<typeof parse>) => { if(fallbackAllowed) fallbackParses++; else parentParses++; if (enabled && !fallbackAllowed) throw new Error('supervisor transcript parse'); return parse(...args); },
  parseCodexSessionFile:(...args:Parameters<typeof parseCodex>) => { if(fallbackAllowed) fallbackParses++; else parentParses++; if (enabled && !fallbackAllowed) throw new Error('supervisor Codex parse'); return parseCodex(...args); },
  parseSessionFile:(...args:Parameters<typeof parseClaude>) => { if(fallbackAllowed) fallbackParses++; else parentParses++; if (enabled && !fallbackAllowed) throw new Error('supervisor Claude parse'); return parseClaude(...args); },
}));
fs.mkdirSync(path.join(home,'.codecast'),{recursive:true});
process.env.F3_FIXTURE_TITLE_DENIED = '1';
if (!enabled) {
  const open = fs.promises.open.bind(fs.promises);
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const fd = await open(...args), read = fd.read.bind(fd);
    fd.read = (async (...values:any[]) => {
      if (String(args[0]).endsWith('metadata.jsonl') && values[2] === 4096 && values[3] > 0) throw Object.assign(new Error('fixture metadata failure'),{code:'EACCES'});
      return (read as any)(...values);
    }) as typeof fd.read;
    return fd;
  }) as typeof fs.promises.open;
}
let daemonFile = path.resolve(import.meta.dir,'../../daemon.ts');
if (['mutant','custody-mutant','custody','retry-mutant','ack','ack-mutant','ack-restart','registration','task-review','scheduled-review','custody-review','disappearance-review','emission-review'].includes(process.argv[3])) {
  let source = fs.readFileSync(daemonFile,'utf8');
  const originalDaemon=daemonFile,originalDaemonSha256=createHash('sha256').update(source).digest('hex');
  const marker = '    let messages = ingest.messages;';
  assert.equal(source.split(marker).length,2);
  if (['custody-review','disappearance-review','emission-review'].includes(process.argv[3])) source += '\nexport const fixtureCustody={acceptedPending,acceptedPendingOwners,transcriptAckObserved,injectedMessageTs,geminiSyncedCounts,opencodeSyncedCounts,transcriptRetryOwners,reserveTranscriptReceipts,ingestStat,observeTranscriptAckWindow};\n';
  else if (process.argv[3] === 'scheduled-review') source += '\nexport const fixtureRetry={transcriptRetryOwners,saveDaemonState};\n';
  else if (process.argv[3] === 'task-review') source += '\nexport const fixtureReview={planModeTaskMap,permissionJustResolved,bakImageRecoveryDone};\n';
  else if (process.argv[3] === 'registration') source += '\nexport const fixtureThreads={appServerThreads,persistedAppServerThreads,pendingAppServerForkParents};\n';
  else if (['ack','ack-mutant','ack-restart'].includes(process.argv[3])) {
    source+='\nexport const fixtureAck={injectedMessageTs,transcriptAckObserved};\n';
    if(process.argv[3]==='ack-mutant')source=source.replace('(ackEligible ? await ackEligible() : true) && messages.some','messages.some');
  }
  else if (process.argv[3] === 'custody') source += '\nexport const fixtureReceipts={acceptedPending,pruneAcceptedTranscript};\n';
  else if (process.argv[3] === 'retry-mutant') {
    const retry = 'if (transcriptRetries.has(sessionId)) throw new TranscriptIngestRetry(`Transcript ${sessionId} retains unread data`);';
    assert.ok(source.includes(retry)); source=source.replace(retry,'');
  }
  else if (process.argv[3] === 'custody-mutant') {
    assert.ok(source.includes('if (isStaleConversationError(errMsg)) return \"stale\";'));
    source=source.replace('if (isStaleConversationError(errMsg)) return \"stale\";','if (isStaleConversationError(errMsg)) return \"accepted\";');
  } else source = source.replace(marker,marker+"\n    if (metadata.warnings.some(w => w.startsWith('title:'))) { setPosition(filePath,lastPosition+bytesConsumed); return; }");
  for (const imp of new Bun.Transpiler({loader:'ts'}).scan(source).imports) if (!imp.path.startsWith('node:') && !imp.path.startsWith('bun:')) {
    const absolute = Bun.resolveSync(imp.path,path.dirname(daemonFile));
    for (const q of ['\"',"'"]) source = source.replaceAll(q+imp.path+q,q+absolute+q);
  }
  daemonFile = path.join(home,'daemon-mutant.ts'); fs.writeFileSync(daemonFile,source);
  console.error('F3_DAEMON_SOURCE '+JSON.stringify({pid:process.pid,originalDaemon,originalDaemonSha256,copiedDaemon:daemonFile,copiedDaemonSha256:createHash('sha256').update(source).digest('hex')}));
}
if (process.env.F3_FIXTURE_PHYSICAL_TASKKEY === '1') await import('./ingestTaskKeyControl.js');
const d = await import(daemonFile);
const {getPosition,setPosition} = await import('../../positionTracker.js');
const {readTranscriptIngest} = await import('../ingestClient.js');
const main = path.resolve(import.meta.dir,'../../main.ts');
const worker = path.resolve(import.meta.dir,'ingestWorker.ts');
const options = {invocation:{command:process.execPath,args:[worker]},backoffMs:[0,0,0]};
configureDaemonWorkers(enabled,{invocation:{command:process.execPath,args:[main,'_worker','probe']}},{invocation:{command:process.execPath,args:[main,'_worker','scan']}},options);
const rows = new Map<string,any>(), sends:any[] = [], queued:any[] = [], titles:string[] = [];
let createFailure = false, sendFailure = false, recreateFailure = false, created = 0;
const sync:any = new Proxy({
  createConversation:async () => { if (createFailure || recreateFailure) throw new Error('fixture create failed'); return `created-${++created}`; },
  offloadImages:async () => {},
  addMessages:async (p:any) => { if (recreateFailure) throw new Error('Conversation not found'); if (sendFailure) throw new Error('fixture send failed'); sends.push(p); for (const m of p.messages) rows.set(m.messageUuid ?? `${m.role}:${m.content}`,m); return {ids:p.messages.map((m:any,i:number)=>m.messageUuid ?? String(i))}; },
  updateTitle:async (_id:string,title:string) => {titles.push(title);},
  deleteMessagesByUuid:async (_id:string,ids:string[]) => {for (const id of ids) rows.delete(id);},
},{get:(target,key) => key in target ? (target as any)[key] : async () => true});
const queue:any = {getPendingOperations:()=>queued,hasPendingConversation:()=>false,add:(type:string,params:any)=>{queued.push({type,params});fs.writeFileSync(path.join(home,'queue.json'),JSON.stringify(queued));return 'queued';}};
const pending:any = {}, cache:any = {}, titleCache:any = {};
const file = (id:string,content:string) => { const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,content);cache[id]='conv-'+id;return p; };
const claudeLine = (id:string,text:string) => JSON.stringify({type:'user',uuid:id,timestamp:'2026-09-05T12:00:00.000Z',message:{role:'user',content:text}})+'\n';
const claude = (p:string,id:string) => d.processSessionFile(p,id,home,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
const codex = (p:string,id:string) => d.processCodexSession(p,id,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
const cursor = (p:string,id:string) => d.processCursorTranscriptFile(p,id,sync,'user',undefined,cache,queue,pending,()=>{});
const normalize = (ms:any[]) => JSON.parse(JSON.stringify(ms.map(m=>({...m,timestamp:0}))));
try {
  if (process.argv[3] === 'emission-review') {
    const {emissionReview}=await import('./ingestEmission.js');
    const review=await emissionReview({d,home,getPosition,setPosition});
    console.log(JSON.stringify({review,enabled,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'disappearance-review') {
    const {disappearanceReview}=await import('./ingestDisappearance.js');
    const review=await disappearanceReview({d,home,getPosition});
    console.log(JSON.stringify({review,enabled,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'custody-review') {
    const {custodyReview}=await import('./ingestCustodyReview.js');
    const review=await custodyReview({d,home,getPosition,setPosition,claudeLine});
    console.log(JSON.stringify({review,enabled,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'scheduled-review') {
    const {scheduledReview}=await import('./ingestScheduled.js');
    const review=await scheduledReview({d,home,getPosition,claudeLine});
    console.log(JSON.stringify({review,enabled,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'task-review') {
    const {taskReplay}=await import('./ingestReview.js');
    const review=await taskReplay({d,home,getPosition,claudeLine});
    console.log(JSON.stringify({review,enabled,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'custody') {
    const {custody}=await import('./ingestCustody.js');
    const result=await custody({d,home,getPosition,claudeLine});
    console.log(JSON.stringify({enabled,custody:result,parentParses,workerPid:ingestWorkerHost()?.state.pid}));
    await closeFixtureWorkers();process.exit(0);
  }
  if (['ack','ack-mutant','ack-restart'].includes(process.argv[3])) {
    const {ackCustody,restartAckCustody}=await import('./ingestAck.js');
    const ack=await (process.argv[3]==='ack-restart'?restartAckCustody:ackCustody)({d,home,getPosition,claudeLine,enabled});
    console.log(JSON.stringify({ack,enabled}));process.exitCode=0;
    await closeFixtureWorkers();process.exit(0);
  }
  if (process.argv[3] === 'retry-mutant') {
    const {scheduledCustody}=await import('./ingestCustody.js');
    await scheduledCustody({d,home,getPosition,claudeLine});
    throw new Error('retry mutation was not rejected');
  }
  if (process.argv[3] === 'custody-mutant') {
    cache.mutant='conv';pending.mutant=[{uuid:'kept',role:'human',content:'must remain',timestamp:1,filePath:'fixture',fileSize:1}];recreateFailure=true;
    assert.equal(await d.flushPendingTranscript(pending,'mutant','conv',cache,sync,queue),false,'old pending return contract dropped unresolved data');
    throw new Error('mutation was not rejected');
  }
  const metadataFile=file('metadata',claudeLine('metadata-primary','primary despite optional title failure '+ 'x'.repeat(6000)));
  const metadata=await readTranscriptIngest({client:'claude',file:metadataFile,sessionId:'metadata',offset:0});
  assert.ok(metadata.metadata.warnings.some(w=>w==='title: EACCES'));
  await claude(metadataFile,'metadata');
  assert.ok(rows.has('metadata-primary'),'metadata failure skipped primary messages');
  assert.equal(getPosition(metadataFile),fs.statSync(metadataFile).size);
  const baselineSends=sends.length;
  const a=file('claude',claudeLine('a','hello emoji 🫠'));
  await Promise.all([claude(a,'claude'),claude(a,'claude')]);
  assert.equal(sends.length,baselineSends+1);assert.equal(getPosition(a),fs.statSync(a).size);assert.equal(rows.get('a').content,'hello emoji 🫠');
  const before=getPosition(a);fs.appendFileSync(a,'{"type":"user"');await claude(a,'claude');assert.equal(getPosition(a),before);
  fs.writeFileSync(a,claudeLine('rotated','rotation'));await claude(a,'claude');assert.equal(rows.get('rotated').content,'rotation');
  fs.writeFileSync(a+'.new',claudeLine('replacement','same-path replaced with larger content'));fs.renameSync(a+'.new',a);await claude(a,'claude');assert.ok(rows.has('replacement'));
  const invalid=file('invalid',claudeLine('unsent','must not consume')+'{broken}\n');
  await assert.rejects(claude(invalid,'invalid'));assert.equal(getPosition(invalid),0);assert.ok(!rows.has('unsent'));
  fs.writeFileSync(invalid,claudeLine('unsent','must not consume'));await claude(invalid,'invalid');assert.ok(rows.has('unsent'));
  const c=file('cursor','user:\nhello cursor\n\nassistant:\nreply cursor\n');
  await cursor(c,'cursor');assert.equal(getPosition(c),fs.statSync(c).size);
  const codexText=JSON.stringify({type:'session_meta',payload:{id:'codex',cwd:home}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'model-before'}})+'\n'+JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00.000Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'codex answer'}]}})+'\n';
  const co=file('codex',codexText);await codex(co,'codex');assert.equal(getPosition(co),fs.statSync(co).size);assert.ok([...rows.values()].some(m=>m.content==='codex answer' && m.model==='model-before'));
  const historyLine=JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00.000Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'imported-like history '+ 'h'.repeat(2*1024*1024)}]}})+'\n';
  const tailLine=JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00.000Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'empty-window new TUI tail'}]}})+'\n';
  const backlogText=codexText.slice(0,codexText.indexOf('{"type":"response_item"'))+historyLine+tailLine;
  const backlog=file('full-native-unregistered-id',backlogText);await codex(backlog,'full-native-unregistered-id');assert.equal(getPosition(backlog),fs.statSync(backlog).size);assert.ok([...rows.values()].some(m=>m.content==='empty-window new TUI tail'));
  const exhaustion=file('empty-exhaustion',(' '.repeat(1024*1024-1)+'\n').repeat(27)+claudeLine('after-empty-exhaustion','eventual complete drain'));
  await assert.rejects(claude(exhaustion,'empty-exhaustion'),/continuation budget/);assert.equal(getPosition(exhaustion),25*1024*1024);assert.ok(!rows.has('after-empty-exhaustion'));
  await Promise.all([claude(exhaustion,'empty-exhaustion'),claude(exhaustion,'empty-exhaustion')]);assert.equal(getPosition(exhaustion),fs.statSync(exhaustion).size);assert.ok(rows.has('after-empty-exhaustion'));
  const actual = await readTranscriptIngest({client:'codex',file:co,sessionId:'codex',offset:0});
  assert.deepEqual(JSON.parse(JSON.stringify(actual.messages)),JSON.parse(JSON.stringify(parseCodex(codexText))));
  const geminiText=JSON.stringify({sessionId:'gemini',messages:[{id:'g1',type:'user',timestamp:'2026-09-05T12:00:00.000Z',content:'gemini hello'}]});
  const ge=file('gemini',geminiText);await d.processGeminiSession(ge,'gemini','hash',sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
  assert.ok([...rows.values()].some(m=>m.content==='gemini hello'));
  for (const client of ['pi','grok'] as const) {
    const text=fs.readFileSync(path.resolve(import.meta.dir,`../../__fixtures__/${client}/${client==='pi'?'linear-bash-tool':'linear-tools'}.jsonl`),'utf8');
    const p=file(client,text);
    const parsed=await readTranscriptIngest({client,file:p,sessionId:client,offset:0});assert.deepEqual(JSON.parse(JSON.stringify(parsed.messages)),JSON.parse(JSON.stringify(parse(client,text))));
    await d.processTranscriptDeltaSession(client,p,client,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
    const count:number=sends.length;await d.processTranscriptDeltaSession(client,p,client,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});assert.equal(sends.length,count);
  }
  const dbFile=path.join(home,'cursor.db'),db=new Database(dbFile);db.run('PRAGMA journal_mode=WAL');db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');
  const chat=(text:string)=>JSON.stringify({tabs:[{tabId:'tab',bubbles:[{type:'user',id:'cu1',initText:text,contextCacheTimestamp:1000},{type:'ai',id:'cu2',rawText:'SQLite reply'}]}]});
  db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',chat('SQLite hello')]);cache.sqlite='conv-sqlite';
  const {extractMessagesFromCursorDb}=await import('../../cursorProcessor.js');
  const sqliteResult=await readTranscriptIngest({client:'cursorDb',file:dbFile,sessionId:'sqlite',offset:0});assert.deepEqual(normalize(sqliteResult.messages),normalize(extractMessagesFromCursorDb(dbFile).messages));
  await d.processCursorSession(dbFile,'sqlite',home,sync,'user',undefined,cache,queue,pending,()=>{});assert.equal(getPosition(dbFile),2);
  db.run('UPDATE ItemTable SET value = ?',[JSON.stringify({tabs:[{tabId:'tab',bubbles:[{type:'user',id:'cu1',initText:'SQLite hello',contextCacheTimestamp:1000},{type:'ai',id:'cu2',rawText:'SQLite reply'},{type:'user',id:'cu3',initText:'WAL append',contextCacheTimestamp:2000}]}]})]);
  await d.processCursorSession(dbFile,'sqlite',home,sync,'user',undefined,cache,queue,pending,()=>{});assert.equal(getPosition(dbFile),3);assert.ok(rows.has('cu3'));
  db.run('UPDATE ItemTable SET value = ?',['{broken']);
  await assert.rejects(readTranscriptIngest({client:'cursorDb',file:dbFile,sessionId:'sqlite',offset:3}));
  await assert.rejects(d.processCursorSession(dbFile,'sqlite',home,sync,'user',undefined,cache,queue,pending,()=>{}));assert.equal(getPosition(dbFile),3);
  db.close();
  const opFile=path.join(home,'.local/share/opencode/opencode.db');fs.mkdirSync(path.dirname(opFile),{recursive:true});
  const op=new Database(opFile);op.run('PRAGMA journal_mode=WAL');
  op.run('CREATE TABLE session(id TEXT,directory TEXT,title TEXT,version TEXT,project_id TEXT,slug TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,agent TEXT)');
  op.run('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');
  op.run('CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)');
  const opId='ses_f3worker';cache[opId]='conv-opencode';
  op.run('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)',[opId,home,'op title','1','project','slug',1000,2000,'ses_parentfixture','explore']);
  const exported=JSON.parse(fs.readFileSync(path.resolve(import.meta.dir,'../../__fixtures__/opencode/session-tools.sanitized.json'),'utf8'));
  for (let i=0;i<exported.messages.length;i++) {
    const m=exported.messages[i];op.run('INSERT INTO message VALUES(?,?,?,?)',[m.info.id,opId,i,JSON.stringify(m.info)]);
    for(const part of m.parts) op.run('INSERT INTO part VALUES(?,?,?,?)',[part.id,m.info.id,opId,JSON.stringify(part)]);
  }
  const {assembleOpencodeSession}=await import('../../opencodeStorage.js');
  const opParsed=await readTranscriptIngest({client:'opencode',file:opFile,sessionId:opId,offset:0});
  assert.deepEqual(normalize(opParsed.messages),normalize(parse('opencode',assembleOpencodeSession(opId,opFile)!)));
  assert.equal(opParsed.metadata.parentSessionId,'ses_parentfixture');
  await d.processOpencodeSession(opId,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
  assert.ok(opParsed.messages.every(m=>rows.has(m.uuid!)));
  op.run('UPDATE part SET data = ? WHERE id = ?',['{broken',exported.messages[0].parts[0].id]);
  await assert.rejects(readTranscriptIngest({client:'opencode',file:opFile,sessionId:opId,offset:0}));op.close();
  const missing=file('create-fail',claudeLine('recover-create','retain bytes'));delete cache['create-fail'];createFailure=true;await assert.rejects(claude(missing,'create-fail'), /retains unread data/);assert.equal(getPosition(missing),0);createFailure=false;
  await claude(missing,'create-fail');assert.ok(rows.has('recover-create'),JSON.stringify({cache:cache['create-fail'],pending:pending['create-fail'],queued,created,position:getPosition(missing)}));
  const retry=file('retry',claudeLine('retry-data','durably queued'));sendFailure=true;await assert.rejects(claude(retry,'retry'), /retains unread data/);sendFailure=false;assert.equal(getPosition(retry),0);assert.ok(queued.some(q=>q.type==='addMessages' && q.params.messages.some((m:any)=>m.messageUuid==='retry-data')));
  await claude(retry,'retry');assert.equal(getPosition(retry),fs.statSync(retry).size);
  const recreate=file('recreate',claudeLine('must-recreate','retry recreation'));recreateFailure=true;await assert.rejects(claude(recreate,'recreate'), /retains unread data/);assert.equal(getPosition(recreate),0);recreateFailure=false;await claude(recreate,'recreate');assert.ok(rows.has('must-recreate'));
  let registrationReceipt;
  if (process.argv[3] === 'registration') {
    const maps=d.fixtureThreads;
    const nativeLine=(id:string,text:string,parent?:string)=>JSON.stringify({type:'session_meta',payload:{id,originator:'codex_cli_rs',source:'cli',forked_from_id:parent}})+'\n'+JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00Z',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
    const full='prefix-collision-registered-full-id',other='prefix-collision-unregistered-full-id';
    maps.appServerThreads.set(full,{threadId:full,conversationId:'live-conversation'});
    const registered=file(full,nativeLine(full,'must be skipped','lineage-parent'));
    const sentBefore=sends.length;await codex(registered,full);assert.equal(sends.length,sentBefore);assert.equal(cache['lineage-parent'],undefined);assert.equal(getPosition(registered),fs.statSync(registered).size);
    const unregistered=file(other,nativeLine(other,'must sync full sibling'));await codex(unregistered,other);assert.equal(sends.length,sentBefore+1);
    const persisted='persisted-complete-thread-id';maps.persistedAppServerThreads.set('fixture-conversation',{threadId:persisted,sandboxPolicy:{type:'workspaceWrite'},updatedAt:Date.now()});
    const persistedFile=file(persisted,nativeLine(persisted,'persisted skip'));await codex(persistedFile,persisted);assert.equal(sends.length,sentBefore+1);
    maps.pendingAppServerForkParents.add('pending-full-source-id');
    const fork=file('unregistered-fork',nativeLine('unregistered-fork','pending fork skip','pending-full-source-id'));await codex(fork,'unregistered-fork');assert.equal(sends.length,sentBefore+1);assert.equal(cache['pending-full-source-id'],undefined);
    registrationReceipt={live:true,persisted:true,pendingFork:true,fullIdSibling:true,lineageSuppressed:true};
  }
  let adversarialReceipt;
  if (process.argv[3] === 'adversarial') {
    const {adversarial}=await import('./ingestAdversarial.js');
    adversarialReceipt=await adversarial({file,claude,claudeLine,codex,rows,sends,getPosition,setPosition,home,parseClaude,parseCodex,reconfigure:()=>configureDaemonWorkers(true,undefined,undefined,options),allowFallback:(v:boolean)=>{fallbackAllowed=v;}});
  }
  assert.equal(enabled ? parentParses : parentParses > 0,enabled ? 0 : true);
  const pid=ingestWorkerHost()?.state.pid ?? null;assert.equal(enabled ? typeof pid : pid,enabled ? 'number' : null);
  console.log(JSON.stringify({enabled,production:true,formats:8,parentParses,workerPid:pid,serialized:true,positions:true,queued:true,fallbackParses,adversarial:adversarialReceipt,registration:registrationReceipt}));
} finally {await closeFixtureWorkers();}
process.exit(0);
