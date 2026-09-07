import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Database} from 'bun:sqlite';
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('scheduled production condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
export async function scheduledReview(f:any){
  const {d,home,getPosition,claudeLine}=f,owner=d.fixtureRetry.transcriptRetryOwners;
  const source=fs.readFileSync(path.resolve(import.meta.dir,'../../daemon.ts'),'utf8');
  const registered:any[]=[],givenUp=new Set<string>(),rows:any[]=[],attempts=new Map<string,number>(),cache:any={},pending:any={};
  let healthy=false,now=Date.now();
  owner.options.now=()=>now;
  const create=owner.create.bind(owner);
  owner.create=(map:any,key:string,descriptor:any,run:any,options:any)=>{
    const sync=create(map,key,descriptor,run,{...options,debounceMs:0,maxWaitMs:0,maxRetries:1,onGiveUp:(e:any)=>{givenUp.add(descriptor.sessionId);options.onGiveUp?.(e);}});
    registered.push({sync,descriptor,map,key});return sync;
  };
  const syncService:any=new Proxy({offloadImages:async()=>{},addMessages:async(p:any)=>{
    attempts.set(p.conversationId,(attempts.get(p.conversationId)??0)+1);
    if(!healthy)throw new Error('scheduled backend outage');
    rows.push(...p.messages.map((m:any)=>({...m,conversationId:p.conversationId})));return {ids:p.messages.map((_:any,i:number)=>String(i))};
  }},{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const retryQueue:any={hasPendingConversation:()=>false,getPendingOperations:()=>[],add:()=> 'memory-only'};
  const context:any={transcriptRetryOwners:owner,fs,path,opencodeDbPath:()=>path.join(home,'.local/share/opencode/opencode.db'),MESSAGE_SYNC_DEBOUNCE:{debounceMs:0},config:{user_id:'fixture'},conversationCache:cache,retryQueue,pendingMessages:pending,titleCache:{},updateState:()=>{},syncService,processSessionFile:d.processSessionFile,processCursorSession:d.processCursorSession,processCursorTranscriptFile:d.processCursorTranscriptFile};
  const instantiate=(anchor:string,key:string,locals:any)=>{
    const a=source.indexOf('sync = transcriptRetryOwners.create(',source.indexOf(anchor)),b=source.indexOf('}, MESSAGE_SYNC_DEBOUNCE);',a);
    assert.ok(a>0&&b>a);const body='let sync;'+source.slice(a,b+'}, MESSAGE_SYNC_DEBOUNCE);'.length)+'return sync;';
    const scope={...context,...locals};return new Function(...Object.keys(scope),new Bun.Transpiler({loader:'ts'}).transformSync(body))(...Object.values(scope));
  };
  const file=(id:string,text:string)=>{const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,text);cache[id]='conv-'+id;return p;};
  const claude=file('scheduled-claude',claudeLine('sc','scheduled Claude'));
  instantiate('  const fileSyncs =','claude',{fileSyncs:new Map(),filePath:claude,event:{sessionId:'scheduled-claude'},projectPath:home}).invalidate();
  const cursor=file('scheduled-cursor','user:\nhello scheduled Cursor\n\nassistant:\nreply scheduled Cursor\n');
  instantiate('  const cursorTranscriptSyncs =','cursor',{cursorTranscriptSyncs:new Map(),filePath:cursor,event:{sessionId:'scheduled-cursor'}}).invalidate();
  const dbPath=path.join(home,'scheduled-cursor.db'),db=new Database(dbPath);db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs:[{tabId:'tab',bubbles:[{type:'user',id:'scheduled-sqlite-row',initText:'scheduled SQLite',contextCacheTimestamp:1000}]}]})]);cache['scheduled-db']='conv-scheduled-db';
  instantiate('  const cursorSyncs =','cursorDb',{cursorSyncs:new Map(),dbPath,event:{sessionId:'scheduled-db',workspacePath:home}}).invalidate();
  const a=source.indexOf('  const registerJsonlDirWatcher ='),b=source.indexOf('\n  registerJsonlDirWatcher(',a);assert.ok(a>0&&b>a);
  const dirScope={...context,dirEventWatchers:[],readDaemonState:()=>({authExpired:false}),isSyncPaused:()=>false,log:()=>{},logError:()=>{}};
  const register=new Function(...Object.keys(dirScope),new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(a,b)+'\nreturn registerJsonlDirWatcher;'))(...Object.values(dirScope));
  class Watcher extends EventEmitter{start(){}}
  const dir=(client:string,label:string,text:string,pass:any)=>{
    const id='scheduled-'+client,p=file(id,text),watcher=new Watcher();
    register(watcher,label,(e:any)=>pass(e.filePath,e.sessionId));watcher.emit('session',{filePath:p,sessionId:id});return p;
  };
  dir('codex','Codex',JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'scheduled Codex'}]}})+'\n',(p:string,id:string)=>d.processCodexSession(p,id,syncService,'fixture',undefined,cache,retryQueue,pending,{},()=>{}));
  dir('gemini','Gemini',JSON.stringify({sessionId:'scheduled-gemini',messages:[{id:'sg',type:'user',timestamp:'2026-09-05T12:00:00Z',content:'scheduled Gemini'}]}),(p:string,id:string)=>d.processGeminiSession(p,id,'hash',syncService,'fixture',undefined,cache,retryQueue,pending,{},()=>{}));
  for(const client of ['pi','grok'])dir(client,client,fs.readFileSync(path.resolve(import.meta.dir,`../../__fixtures__/${client}/${client==='pi'?'linear-bash-tool':'linear-tools'}.jsonl`),'utf8'),(p:string,id:string)=>d.processTranscriptDeltaSession(client,p,id,syncService,'fixture',undefined,cache,retryQueue,pending,{},()=>{}));
  const opFile=context.opencodeDbPath();fs.mkdirSync(path.dirname(opFile),{recursive:true});const op=new Database(opFile);
  op.run('CREATE TABLE session(id TEXT,directory TEXT,title TEXT,version TEXT,project_id TEXT,slug TEXT,time_created INTEGER,time_updated INTEGER,parent_id TEXT,agent TEXT)');op.run('CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT)');op.run('CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,data TEXT)');
  const opId='ses_scheduled';cache[opId]='conv-'+opId;op.run('INSERT INTO session VALUES(?,?,?,?,?,?,?,?,?,?)',[opId,home,'scheduled OpenCode','1','project','slug',1000,2000,null,null]);
  op.run('INSERT INTO message VALUES(?,?,?,?)',['op-message',opId,1000,JSON.stringify({id:'op-message',sessionID:opId,role:'user',time:{created:1000}})]);
  op.run('INSERT INTO part VALUES(?,?,?,?)',['op-part','op-message',opId,JSON.stringify({id:'op-part',messageID:'op-message',sessionID:opId,type:'text',text:'scheduled OpenCode'})]);
  const watcher=new Watcher();register(watcher,'OpenCode',(e:any)=>d.processOpencodeSession(e.sessionId,syncService,'fixture',undefined,cache,retryQueue,pending,{},()=>{}));watcher.emit('session',{filePath:opId,sessionId:opId});
  let timer:ReturnType<typeof setInterval>|undefined;
  try{
    await until(()=>givenUp.size===8);assert.equal(rows.length,0);assert.equal(getPosition(claude),0);assert.equal(getPosition(cursor),0);assert.equal(getPosition(dbPath),0);
    const sourceStats=registered.map(r=>[r.descriptor.file,fs.statSync(r.descriptor.file).mtimeMs]);
    const heartbeat=source.match(/setInterval\(\(\) => \{ transcriptRetryOwners\.drain\(\); sendHeartbeat\(\)\.catch\(\(\) => \{\}\); \}, 30_000\);/);assert.ok(heartbeat);
    let beats=0;
    process.env.CODECAST_PAUSED='1';
    new Function('setInterval','transcriptRetryOwners','sendHeartbeat',heartbeat[0])((callback:()=>void,_ms:number)=>{timer=setInterval(()=>{now+=30_001;callback();},5);},owner,async()=>{beats++;});
    const attemptsBefore=new Map(attempts);
    healthy=true;now+=30_001;
    await until(()=>beats>=3);assert.deepEqual(attempts,attemptsBefore);assert.equal(rows.length,0);
    d.fixtureRetry.saveDaemonState({authExpired:true});delete process.env.CODECAST_PAUSED;
    const authBeat=beats;await until(()=>beats>=authBeat+3);assert.deepEqual(attempts,attemptsBefore);assert.equal(rows.length,0);
    d.fixtureRetry.saveDaemonState({authExpired:false});
    await until(()=>new Set(rows.map(r=>r.conversationId)).size===8);
    await until(()=>getPosition(claude)===fs.statSync(claude).size&&getPosition(cursor)===fs.statSync(cursor).size&&getPosition(dbPath)===1);
    assert.ok(beats>0);assert.equal(getPosition(claude),fs.statSync(claude).size);assert.equal(getPosition(cursor),fs.statSync(cursor).size);assert.equal(getPosition(dbPath),1);
    assert.deepEqual(registered.map(r=>[r.descriptor.file,fs.statSync(r.descriptor.file).mtimeMs]),sourceStats);
    assert.ok(registered.every(r=>attempts.get(cache[r.descriptor.sessionId])===(attemptsBefore.get(cache[r.descriptor.sessionId])??0)+1));
    owner.stop();const before=rows.length;now+=60_000;await new Promise(resolve=>setTimeout(resolve,25));assert.equal(rows.length,before);assert.equal(owner.drain(),0);
    return {formats:8,scheduled:true,zeroManaged:true,unchanged:true,burstExhausted:true,authPause:true,stopped:true};
  }finally{delete process.env.CODECAST_PAUSED;d.fixtureRetry.saveDaemonState({authExpired:false});if(timer)clearInterval(timer);owner.stop();db.close();op.close();}
}
