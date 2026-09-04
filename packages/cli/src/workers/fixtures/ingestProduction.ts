import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as localParsers from '../../parser.js';
import { configureDaemonWorkers, closeDaemonWorkers, ingestWorkerHost } from '../bridge.js';
const enabled = process.argv[2] === 'true', home = process.env.HOME!;
assert.ok(home.includes('f3-'));
assert.ok(process.env.TMUX_TMPDIR?.includes('f3-'));
const parse = localParsers.parseTranscriptFor, parseCodex = localParsers.parseCodexSessionFile, parseClaude = localParsers.parseSessionFile;
let parentParses = 0;
mock.module('../../parser.js',() => ({...localParsers,
  parseTranscriptFor:(...args:Parameters<typeof parse>) => { parentParses++; if (enabled) throw new Error('supervisor transcript parse'); return parse(...args); },
  parseCodexSessionFile:(...args:Parameters<typeof parseCodex>) => { parentParses++; if (enabled) throw new Error('supervisor Codex parse'); return parseCodex(...args); },
  parseSessionFile:(...args:Parameters<typeof parseClaude>) => { parentParses++; if (enabled) throw new Error('supervisor Claude parse'); return parseClaude(...args); },
}));
const d = await import('../../daemon.js');
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
const queue:any = {hasPendingConversation:()=>false,add:(type:string,params:any)=>{queued.push({type,params});fs.writeFileSync(path.join(home,'queue.json'),JSON.stringify(queued));return 'queued';}};
const pending:any = {}, cache:any = {}, titleCache:any = {};
const file = (id:string,content:string) => { const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,content);cache[id]='conv-'+id;return p; };
const claudeLine = (id:string,text:string) => JSON.stringify({type:'user',uuid:id,timestamp:'2026-09-05T12:00:00.000Z',message:{role:'user',content:text}})+'\n';
const claude = (p:string,id:string) => d.processSessionFile(p,id,home,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
const codex = (p:string,id:string) => d.processCodexSession(p,id,sync,'user',undefined,cache,queue,pending,titleCache,()=>{});
const cursor = (p:string,id:string) => d.processCursorTranscriptFile(p,id,sync,'user',undefined,cache,queue,pending,()=>{});
const normalize = (ms:any[]) => JSON.parse(JSON.stringify(ms.map(m=>({...m,timestamp:0}))));
try {
  const a=file('claude',claudeLine('a','hello emoji 🫠'));
  await Promise.all([claude(a,'claude'),claude(a,'claude')]);
  assert.equal(sends.length,1);assert.equal(getPosition(a),fs.statSync(a).size);assert.equal(rows.get('a').content,'hello emoji 🫠');
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
  db.close();
  const missing=file('create-fail',claudeLine('recover-create','retain bytes'));delete cache['create-fail'];createFailure=true;await claude(missing,'create-fail');assert.equal(getPosition(missing),0);createFailure=false;
  await claude(missing,'create-fail');assert.ok(rows.has('recover-create'),JSON.stringify({cache:cache['create-fail'],pending:pending['create-fail'],queued,created,position:getPosition(missing)}));
  const retry=file('retry',claudeLine('retry-data','durably queued'));sendFailure=true;await claude(retry,'retry');sendFailure=false;assert.equal(getPosition(retry),fs.statSync(retry).size);assert.ok(queued.some(q=>q.type==='addMessages' && q.params.messages.some((m:any)=>m.messageUuid==='retry-data')));
  const recreate=file('recreate',claudeLine('must-recreate','retry recreation'));recreateFailure=true;await claude(recreate,'recreate');assert.equal(getPosition(recreate),0);recreateFailure=false;await claude(recreate,'recreate');assert.ok(rows.has('must-recreate'));
  assert.equal(enabled ? parentParses : parentParses > 0,enabled ? 0 : true);
  const pid=ingestWorkerHost()?.state.pid ?? null;assert.equal(enabled ? typeof pid : pid,enabled ? 'number' : null);
  console.log(JSON.stringify({enabled,production:true,formats:7,parentParses,workerPid:pid,serialized:true,positions:true,queued:true}));
} finally {closeDaemonWorkers();}
process.exit(0);
