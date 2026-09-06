import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {Database} from 'bun:sqlite';
const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('retained work scheduled condition timed out');await new Promise(resolve=>setTimeout(resolve,2));}};

export async function coreScheduled({d,home,getPosition,AuthExpiredError}:any) {
  const core=d.fixtureCore,owner=d.fixtureCustody.transcriptRetryOwners,source=fs.readFileSync(path.resolve(import.meta.dir,'../../daemon.ts'),'utf8');
  const cache:any={},pending:any={},registered:any[]=[],rows:any[]=[],deleteCalls:any[]=[],operations:any[]=[];
  let failure='',now=Date.now(),attempts=0,taskCalls=0,failDelete=false;
  owner.options.now=()=>now;
  const create=owner.create.bind(owner);
  owner.create=(map:any,key:string,descriptor:any,run:any,options:any)=>{
    const sync=create(map,key,descriptor,run,{...options,debounceMs:0,maxWaitMs:0,maxRetries:1});registered.push({sync,descriptor});return sync;
  };
  const syncService:any=new Proxy({
    offloadImages:async()=>{},
    createConversation:async(p:any)=>{if(failure==='create')throw new Error('create pending');if(failure==='create-auth')throw new AuthExpiredError();return 'conv-'+p.sessionId;},
    syncTaskFromPlanMode:async()=>{taskCalls++;if(failure==='task')throw new AuthExpiredError();return 'ct-fixture';},
    addMessages:async(p:any,options:any)=>{
      attempts++;if(failure==='direct'||failure==='pending')throw new AuthExpiredError();
      options?.beforeBatch?.();rows.push(...p.messages.map((row:any)=>({...row,conversationId:p.conversationId})));options?.onBatchAccepted?.(p.messages.map((_:any,i:number)=>i));
      return {ids:p.messages.map((_:any,i:number)=>String(i))};
    },
    deleteMessagesByUuid:async(conv:string,ids:string[])=>{deleteCalls.push({conv,ids,failed:failDelete});if(failDelete)throw new Error('orphan delete outage');return ids.length;},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={hasPendingConversation:()=>false,getPendingOperations:()=>operations,add:(type:string,params:any)=>{operations.push({type,params});return 'memory';}};
  const context:any={transcriptRetryOwners:owner,fs,path,MESSAGE_SYNC_DEBOUNCE:{debounceMs:0},config:{user_id:'fixture'},conversationCache:cache,retryQueue:queue,pendingMessages:pending,titleCache:{},updateState:()=>{},syncService,processSessionFile:d.processSessionFile};
  const instantiate=(file:string,id:string)=>{
    const a=source.indexOf('sync = transcriptRetryOwners.create(',source.indexOf('  const fileSyncs =')),b=source.indexOf('}, MESSAGE_SYNC_DEBOUNCE);',a);assert.ok(a>0&&b>a);
    const scope={...context,fileSyncs:new Map(),filePath:file,event:{sessionId:id},projectPath:home};
    return new Function(...Object.keys(scope),new Bun.Transpiler({loader:'ts'}).transformSync('let sync;'+source.slice(a,b+'}, MESSAGE_SYNC_DEBOUNCE);'.length)+'return sync;'))(...Object.values(scope));
  };
  const heartbeat=source.match(/setInterval\(\(\) => \{ transcriptRetryOwners\.drain\(\); sendHeartbeat\(\)\.catch\(\(\) => \{\}\); \}, 30_000\);/);assert.ok(heartbeat);
  let timer:ReturnType<typeof setInterval>|undefined,beats=0;
  const startTicks=()=>new Function('setInterval','transcriptRetryOwners','sendHeartbeat',heartbeat[0])((callback:()=>void)=>{timer=setInterval(()=>{now+=30_001;callback();},5);},owner,async()=>{beats++;});
  try{
    for(const kind of ['direct','pending','task','create-auth']){
      const id='cold-auth-'+kind,file=path.join(home,id+'.jsonl'),content=kind==='task'?[{type:'tool_use',id:'native-tool-'+id,name:'TaskCreate',input:{subject:'task'}}]:'ordinary message';
      fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'native-'+id,timestamp:'2026-09-05T12:00:00Z',message:{content}})+'\n');
      core.saveDaemonState({authExpired:false,authFailureCount:0});failure=kind;
      if(kind!=='pending'&&kind!=='create-auth')cache[id]='conv-'+id;
      if(kind==='pending'){
        failure='create';await assert.rejects(d.processSessionFile(file,id,home,syncService,'fixture',undefined,cache,queue,pending,{},()=>{}));
        assert.equal(pending[id].length,1);failure=kind;cache[id]='conv-'+id;
      }
      if(kind==='direct'||kind==='create-auth')core.saveDaemonState({authExpired:false,authFailureCount:99});
      const sync=instantiate(file,id);assert.equal(owner.drain(),0);await sync.invalidateAndAwait();
      assert.equal(getPosition(file),0);const stat=fs.statSync(file),beforeAttempts=attempts,beforeTask=taskCalls;
      console.error('F3_CORE_AUTH_FIRST '+JSON.stringify({kind,file,attempts,taskCalls,position:getPosition(file)}));
      process.env.CODECAST_PAUSED='1';failure='';startTicks();const beforeBeats=beats;await until(()=>beats>=beforeBeats+2);
      assert.equal(attempts,beforeAttempts);assert.equal(taskCalls,beforeTask);
      delete process.env.CODECAST_PAUSED;core.saveDaemonState({authExpired:true});const authBeats=beats;await until(()=>beats>=authBeats+2);assert.equal(getPosition(file),0);
      core.saveDaemonState({authExpired:false,authFailureCount:0});await until(()=>getPosition(file)===stat.size);
      assert.equal(fs.statSync(file).mtimeMs,stat.mtimeMs);assert.equal(rows.filter(row=>row.conversationId===cache[id]).length,1);
      clearInterval(timer);timer=undefined;sync.stop();
    }
    for(const client of ['claude-stat','claude-read','cursorDb'])for(const code of ['EACCES','EPERM']){
      const id='cold-permission-'+client+'-'+code,file=path.join(home,id+(client==='cursorDb'?'.db':'.jsonl'));
      if(client==='cursorDb'){
        const db=new Database(file);
        try{db.exec('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs:[{bubbles:[{type:'ai',id:'native-'+id,rawText:'permission retry',contextCacheTimestamp:1}]}]})]);}finally{db.close();}
      }else fs.writeFileSync(file,JSON.stringify({type:'assistant',uuid:'native-'+id,timestamp:'2026-09-05T12:00:00Z',message:{content:'permission retry'}})+'\n');
      cache[id]='conv-'+id;failure='';core.saveDaemonState({authExpired:false,authFailureCount:0});
      let sync:any;
      if(client==='cursorDb'){
        const a=source.indexOf('sync = transcriptRetryOwners.create(cursorSyncs,'),b=source.indexOf('}, MESSAGE_SYNC_DEBOUNCE);',a);assert.ok(a>0&&b>a);
        const scope={...context,cursorSyncs:new Map(),dbPath:file,event:{sessionId:id,workspacePath:home},processCursorSession:d.processCursorSession};
        sync=new Function(...Object.keys(scope),new Bun.Transpiler({loader:'ts'}).transformSync('let sync;'+source.slice(a,b+'}, MESSAGE_SYNC_DEBOUNCE);'.length)+'return sync;'))(...Object.values(scope));
      }else sync=instantiate(file,id);
      assert.equal(owner.drain(),0);assert.equal(getPosition(file),0);
      const before=fs.statSync(file),beforeAttempts=attempts,stat=fs.promises.stat.bind(fs.promises),boundaries:string[]=[];
      let fired=false;
      fs.promises.stat=(async(...args:Parameters<typeof stat>)=>{
        if(String(args[0])===file){
          const stack=new Error().stack??'';boundaries.push(stack);
          if(!fired&&stack.includes(client==='claude-stat'?'ingestStat':'readTranscriptIngest')){fired=true;throw Object.assign(new Error('fixture read permission refusal'),{code});}
        }
        return stat(...args);
      }) as typeof fs.promises.stat;
      try{await sync.invalidateAndAwait();}finally{fs.promises.stat=stat;}
      console.error('F3_CORE_PERMISSION_FIRST '+JSON.stringify({client,code,fired,boundaries,position:getPosition(file)}));
      assert.equal(fired,true,'owned Pass read permission boundary must fire');assert.equal(attempts,beforeAttempts);assert.equal(getPosition(file),0);
      const expected=client==='cursorDb'?1:before.size;
      startTicks();await until(()=>getPosition(file)===expected);await sync.awaitQueue();
      clearInterval(timer);timer=undefined;sync.stop();
      assert.equal(rows.filter(row=>row.conversationId===cache[id]).length,1);assert.equal(fs.statSync(file).mtimeMs,before.mtimeMs);
    }
    const dirA=source.indexOf('  const registerJsonlDirWatcher ='),dirB=source.indexOf('\n  registerJsonlDirWatcher(',dirA);assert.ok(dirA>0&&dirB>dirA);
    const scope={...context,dirEventWatchers:[],readDaemonState:()=>({authExpired:false}),isSyncPaused:()=>false,log:()=>{},logError:()=>{},opencodeDbPath:()=>''};
    const register=new Function(...Object.keys(scope),new Bun.Transpiler({loader:'ts'}).transformSync(source.slice(dirA,dirB)+'\nreturn registerJsonlDirWatcher;'))(...Object.values(scope));
    class Watcher extends EventEmitter{start(){}}
    for(const client of ['pi','grok']){
      const id='orphan-'+client,file=path.join(home,id+'.jsonl'),fixture=fs.readFileSync(path.resolve(import.meta.dir,`../../__fixtures__/${client}/${client==='pi'?'branch':'thinking-rewind'}.jsonl`),'utf8').trim().split('\n');
      const split=fixture.findIndex(line=>line.includes(client==='pi'?'branch_summary':'rewind_marker'));assert.ok(split>0);
      fs.writeFileSync(file,fixture.slice(0,split).join('\n')+'\n');cache[id]='conv-'+id;
      const run=()=>d.processTranscriptDeltaSession(client,file,id,syncService,'fixture',undefined,cache,queue,pending,{},()=>{});
      await run();const before=new Map(core.piSyncedSigs.get(file));assert.ok(before.size>2);
      fs.appendFileSync(file,fixture[split]+'\n');const watcher=new Watcher();register(watcher,client,run);failDelete=true;
      watcher.emit('session',{filePath:file,sessionId:id});await until(()=>deleteCalls.some(row=>row.conv===cache[id]&&row.failed));
      const active=registered.at(-1).sync;await active.awaitQueue();const stat=fs.statSync(file);assert.ok(core.piSyncedSigs.get(file).size>=before.size);
      failDelete=false;startTicks();await until(()=>deleteCalls.some(row=>row.conv===cache[id]&&!row.failed));await active.awaitQueue();
      assert.ok(core.piSyncedSigs.get(file).size<before.size);assert.equal(fs.statSync(file).mtimeMs,stat.mtimeMs);clearInterval(timer);timer=undefined;active.stop();
    }
    const count=attempts+taskCalls+deleteCalls.length;owner.stop();startTicks();const at=beats;await until(()=>beats>=at+2);assert.equal(attempts+taskCalls+deleteCalls.length,count);
    console.error('F3_CORE_SCHEDULED '+JSON.stringify({authFirst:4,permissionFirst:6,orphanClients:2,beats,unchanged:true,stopped:true}));
  }finally{if(timer)clearInterval(timer);owner.stop();owner.create=create;delete process.env.CODECAST_PAUSED;core.saveDaemonState({authExpired:false,authFailureCount:0});}
}
