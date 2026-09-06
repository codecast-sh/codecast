import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Database} from 'bun:sqlite';
import {currentTranscriptDeadline,withTranscriptDeadline} from '../ingestDeadline.js';
import {readTranscriptIngest} from '../ingestClient.js';

export async function coreReview(f:any) {
  const {d,home,getPosition}=f,internal=d.fixtureCustody,core=d.fixtureCore;
  const selected=process.env.F3_FIXTURE_CORE_CASE;
  console.error('F3_CORE_CASE '+JSON.stringify({pid:process.pid,selected:selected??'all'}));
  const servicePath=process.env.F3_FIXTURE_SYNC_SERVICE??path.resolve(import.meta.dir,'../../syncService.ts');
  assert.ok(!process.env.F3_FIXTURE_SYNC_SERVICE||servicePath.startsWith(home+path.sep));
  const {SyncService,AuthExpiredError}=await import(servicePath);
  const receipt={pid:process.pid,servicePath,sha256:createHash('sha256').update(fs.readFileSync(servicePath)).digest('hex')};
  console.error('F3_CORE_SERVICE_SOURCE '+JSON.stringify(receipt));
  const service:any=new SyncService({convexUrl:'http://127.0.0.1:1',userId:'fixture-user',authToken:'fixture-token'});
  const backendPath=path.resolve(import.meta.dir,'../../../../convex/convex/messages.ts'),dbPath=path.resolve(import.meta.dir,'../../../../convex/convex/testDb.ts');
  const {addMessages}=await import(backendPath),{makeFakeDb}=await import(dbPath);
  const backendReceipt={pid:process.pid,backendPath,backendSha256:createHash('sha256').update(fs.readFileSync(backendPath)).digest('hex'),dbPath,dbSha256:createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex')};
  const db=makeFakeDb({conversations:[],messages:[]}),ctx={db,auth:{getUserIdentity:async()=>({subject:'fixture-user|session'})},scheduler:{runAfter:async()=>{}}};

  const cache:any={},pending:any={},operations:any[]=[],writes:any[]=[],stored:any[]=[],accepted:number[][]=[];
  let failCreate=false,failSecond=false,call=0,afterWrite:undefined|((number:number)=>void|Promise<void>);
  service.client={mutation:async(name:string,args:any,options:any)=>{
    assert.equal(name,'messages:addMessages');assert.deepEqual(options,{skipQueue:true});
    assert.deepEqual(Object.keys(args).sort(),['api_token','conversation_id','messages']);
    const number=++call;writes.push({conversationId:args.conversation_id,count:args.messages.length});
    if(failSecond&&number===2)throw new Error('network second batch outage');
    if(!db._tables.conversations.some((row:any)=>row._id===args.conversation_id))db._tables.conversations.push({_id:args.conversation_id,user_id:'fixture-user',message_count:0,updated_at:0,is_private:true,title:'fixture'});
    console.error('F3_CORE_BACKEND_INVOKE '+JSON.stringify({...backendReceipt,conversationId:args.conversation_id,count:args.messages.length}));
    const result=await addMessages._handler(ctx,args);
    stored.splice(0,stored.length,...db._tables.messages.map((row:any)=>({...row,conversationId:row.conversation_id,id:row._id})));
    await afterWrite?.(number);return result;
  },query:async()=>[]};
  const realAdd=service.addMessages.bind(service);
  const sync:any=new Proxy({
    offloadImages:service.offloadImages.bind(service),
    addMessages:(params:any,options:any)=>{
      console.error('F3_CORE_SERVICE_INVOKE '+JSON.stringify({...receipt,conversationId:params.conversationId,count:params.messages.length}));
      const callback=options?.onBatchAccepted;
      return realAdd(params,{...options,onBatchAccepted:callback?(indexes:readonly number[])=>{accepted.push([...indexes]);callback(indexes);}:undefined});
    },
    createConversation:async(p:any)=>{if(failCreate)throw new Error('create outage');return 'conv-'+p.sessionId;},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={getPendingOperations:()=>operations,hasPendingConversation:()=>false,add:(type:string,params:any)=>{operations.push({id:'q-'+operations.length,type,params});return operations.at(-1).id;}};
  const line=(id?:string)=>JSON.stringify({type:'assistant',uuid:id,timestamp:'2026-09-05T12:00:00Z',message:{content:'same source occurrence text'}})+'\n';
  const source=(id:string,uuid=false)=>{const file=path.join(home,id+'.jsonl');fs.writeFileSync(file,Array.from({length:30},(_,i)=>line(uuid?id+'-'+i:undefined)).join(''));return file;};
  const run=(file:string,id:string)=>d.processSessionFile(file,id,home,sync,'fixture-user',undefined,cache,queue,pending,{},()=>{});
  const receipts=(id:string)=>[...internal.acceptedPending.values()].flatMap((rows:any)=>[...rows.values()]).filter((row:any)=>row.sessionId===id);
  if(!selected||selected==='c1')for(const change of ['delete','replace','pending-append-replace']){
    const id='core-partial-'+change,file=source(id),conv='conv-'+id;failCreate=true;call=0;failSecond=true;
    await assert.rejects(run(file,id));assert.equal(pending[id].length,30);failCreate=false;cache[id]=conv;
    const queued=operations.find(row=>row.type==='createConversation'&&row.params.sessionId===id);assert.ok(queued);
    let replacement:any,appended:any;
    afterWrite=number=>{
      if(number!==1||change!=='pending-append-replace')return;
      const current=pending[id];replacement={...current[0],uuid:'new-replacement',content:'new replacement pending',ingestKey:'replacement',ingestSignature:'new-replacement'};
      appended={...current[29],uuid:'new-appended',content:'new appended pending',ingestKey:'appended',ingestSignature:'new-appended'};
      core.publishPendingTranscript(pending,id,[replacement,...current.slice(1),appended]);
    };
    assert.equal(await d.flushPendingTranscript(pending,id,conv,cache,sync,queue),false);afterWrite=undefined;
    const partialPending=pending[id].length;assert.equal(receipts(id).length,25);assert.equal(internal.receiptAccounting().reserved,0);assert.equal(internal.receiptAccounting().reservedBytes,0);
    console.error('F3_CORE_PENDING_PARTIAL '+JSON.stringify({change,partialPending,receipts:receipts(id).length}));
    if(change==='pending-append-replace'){assert.ok(pending[id].includes(replacement));assert.ok(pending[id].includes(appended));}
    if(change==='replace'){fs.writeFileSync(file+'.next',line());fs.renameSync(file+'.next',file);}else fs.unlinkSync(file);
    await core.pruneAcceptedTranscript(file);assert.equal(receipts(id).length,0);failSecond=false;
    assert.equal(await d.retryCreateTranscriptConversation(queued.params,cache,pending,sync,queue,()=>{}),true);
    const rows=stored.filter(row=>row.conversationId===conv);assert.equal(rows.filter(row=>row.content==='same source occurrence text').length,30,'pruned receipts must not resend known accepted pending objects');
    assert.equal(partialPending,change==='pending-append-replace'?7:5,'accepted pending objects retire at subset acceptance');
    assert.equal(rows.length,change==='pending-append-replace'?32:30);assert.equal(pending[id],undefined);
    assert.equal(getPosition(file),0);await core.pruneAcceptedTranscript(file);
  }
  if(!selected||selected==='c2')for(const uuid of [false,true])for(const kind of ['deadline','cancel','mapping','new-destination'])for(const route of ['direct','pending']){
    const id=`core-fence-${uuid}-${kind}-${route}`,file=source(id,uuid),conv='conv-'+id;cache[id]=conv;call=0;failSecond=false;
    if(route==='pending'){delete cache[id];failCreate=true;await assert.rejects(run(file,id));failCreate=false;cache[id]=conv;}
    const abort=new AbortController(),queueBefore=operations.length,writeBefore=writes.length,indexBefore=accepted.length;
    afterWrite=number=>{if(number!==1)return;if(kind==='deadline')(currentTranscriptDeadline() as any).end=performance.now()-1;else if(kind==='cancel')abort.abort();else cache[id]='changed-'+id;};
    await assert.rejects(withTranscriptDeadline(async()=>{
      if(route==='direct')await run(file,id);
      else if(!await d.flushPendingTranscript(pending,id,conv,cache,sync,queue))throw new Error('pending guard refused');
    },{signal:abort.signal}));
    afterWrite=undefined;
    console.error('F3_CORE_FENCE '+JSON.stringify({uuid,kind,route,dispatched:writes.slice(writeBefore),queued:operations.length-queueBefore,position:getPosition(file),accounting:internal.receiptAccounting()}));
    assert.equal(internal.receiptAccounting().reserved,0);assert.equal(internal.receiptAccounting().reservedBytes,0);
    assert.equal(writes.length-writeBefore,1,'authority refusal must stop before second mutation');assert.equal(operations.length,queueBefore,'local refusal must not enqueue unguarded work');
    assert.deepEqual(accepted[indexBefore],Array.from({length:25},(_,i)=>i));assert.equal(getPosition(file),0);
    const beforeRetry=writes.length;
    if(kind!=='new-destination')cache[id]=conv;
    await run(file,id);
    console.error('F3_CORE_FENCE_RETRY '+JSON.stringify({uuid,kind,route,rereadDispatch:writes.slice(beforeRetry),destination:cache[id],stored:stored.filter(row=>row.conversationId===cache[id]).length}));
    assert.equal(stored.filter(row=>row.conversationId===cache[id]).length,30);
    if(kind==='new-destination')assert.equal(stored.filter(row=>row.conversationId===conv).length,25);
    else if(!uuid||route==='pending')assert.deepEqual(writes.slice(beforeRetry).map(row=>row.count),[5]);
    else assert.deepEqual(writes.slice(beforeRetry).map(row=>row.count),[25,5]);
    assert.equal(getPosition(file),fs.statSync(file).size);
  }
  if(!selected||selected==='c2')for(const kind of ['lock','throttle','backlog']){
    const id='core-wait-'+kind,file=source(id,true),conv='conv-'+id;cache[id]=conv;call=0;
    let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
    const lock=service.withConversationLock.bind(service),throttle=service.throttle.bind(service),offload=sync.offloadImages;
    const queueBefore=operations.length,writeBefore=writes.length;let deadline:any;
    if(kind==='lock'){service.conversationWriteChains.set(conv,gate);service.withConversationLock=(key:string,work:any)=>{deadline=currentTranscriptDeadline();entered();return lock(key,work);};}
    if(kind==='throttle'){service.throttleQueue=gate;service.throttle=()=>{deadline=currentTranscriptDeadline();entered();return throttle();};}
    if(kind==='backlog'){sync.offloadImages=async(p:any)=>{await offload(p);deadline=currentTranscriptDeadline();entered();await gate;};queue.hasPendingConversation=()=>true;}
    const active=run(file,id).then(()=>({error:undefined}), (error:unknown)=>({error}));
    await began;assert.ok(deadline);deadline.end=performance.now()-1;release();const outcome=await active;
    service.withConversationLock=lock;service.throttle=throttle;sync.offloadImages=offload;queue.hasPendingConversation=()=>false;
    assert.ok(outcome.error);assert.equal(writes.length,writeBefore);assert.equal(operations.length,queueBefore);assert.equal(getPosition(file),0);
    await run(file,id);assert.equal(getPosition(file),fs.statSync(file).size);
  }
  if(!selected||selected==='c2'){
  const capturedId='core-options-captured',capturedConv='conv-'+capturedId;
  let releaseOptions!:()=>void,originalGuardCalls=0;
  const optionsGate=new Promise<void>(resolve=>{releaseOptions=resolve;});service.conversationWriteChains.set(capturedConv,optionsGate);
  const mutableOptions={beforeBatch:()=>{originalGuardCalls++;}};
  const optionsWork=realAdd({conversationId:capturedConv,messages:[{role:'assistant',content:'captured beforeBatch',timestamp:1}]},mutableOptions).then((value:unknown)=>({value,error:undefined}),(error:unknown)=>({value:undefined,error}));
  mutableOptions.beforeBatch=()=>{throw new Error('redirected mutable options callback');};releaseOptions();
  const optionsOutcome=await optionsWork;assert.equal(optionsOutcome.error,undefined);assert.equal(originalGuardCalls,1);
  console.error('F3_CORE_OPTIONS_CAPTURE '+JSON.stringify({originalGuardCalls}));
  const networkId='core-network-uuid',network=source(networkId,true);cache[networkId]='conv-'+networkId;call=0;failSecond=true;
  const queueBefore=operations.length;await assert.rejects(run(network,networkId));assert.equal(operations.length,queueBefore+1);assert.equal(operations.at(-1).type,'addMessages');failSecond=false;
  }
  if(!selected||selected==='c4'){
  const dbFile=path.join(home,'core-cursor.db'),db=new Database(dbFile);
  try{
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable(key TEXT,value TEXT)');
    const first={type:'user',id:'native-first',initText:'first',contextCacheTimestamp:1};
    db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs:[{bubbles:[first]}]})]);
    const id='core-cursor',conv='conv-'+id;cache[id]=conv;
    const cursor=()=>d.processCursorSession(dbFile,id,home,sync,'fixture-user',undefined,cache,queue,pending,()=>{});
    await cursor();assert.equal(getPosition(dbFile),1);
    const mainSize=fs.statSync(dbFile).size,skipped=mainSize+32;
    db.run('UPDATE ItemTable SET value=?',[JSON.stringify({tabs:[{bubbles:[first,...Array.from({length:skipped},()=>({type:'ignored'})),{type:'ai',rawText:'late missing id'},{type:'user',initText:'late user'}]}]})]);
    assert.equal(fs.statSync(dbFile).size,mainSize);assert.ok(fs.statSync(dbFile+'-wal').size>mainSize);
    const tail=await readTranscriptIngest({client:'cursorDb',file:dbFile,sessionId:id,offset:1});
    assert.deepEqual(tail.receiptOccurrences,[skipped+1,skipped+2]);assert.equal(tail.rawBubbleCount,skipped+3);assert.ok(tail.receiptOccurrences![0]>mainSize);
    await cursor();assert.equal(getPosition(dbFile),3);assert.equal(stored.filter(row=>row.conversationId===conv).length,3);
    console.error('F3_CORE_WAL '+JSON.stringify({mainSize,skipped,rawBubbleCount:tail.rawBubbleCount,occurrences:tail.receiptOccurrences}));
  }finally{db.close();}
  }
  if(!selected||selected==='c5'){const {coreAdmission}=await import('./ingestCoreAdmission.js');await coreAdmission(f);}
  if(!selected||selected==='c3'){const {coreScheduled}=await import('./ingestCoreScheduled.js');await coreScheduled({...f,AuthExpiredError});}
  return {partialCleanup:3,fenceCases:16,expiredWaits:3,optionsCaptured:true,networkQueue:true,walOrdinal:true,globalAdmission:true,scheduledRetained:true};
}
