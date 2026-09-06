import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {Database} from 'bun:sqlite';
import {readTranscriptIngest,ingestRecord} from '../ingestClient.js';
import {withTranscriptDeadline,currentTranscriptDeadline} from '../ingestDeadline.js';
import {getSyncRecord,updateSyncRecord} from '../../syncLedger.js';
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const until=async(check:()=>boolean)=>{const end=Date.now()+8000;while(!check()){if(Date.now()>end)throw new Error('custody scheduled condition timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
export async function custodyReview(f:any) {
  const {d,home,getPosition,setPosition,claudeLine}=f,internal=d.fixtureCustody;
  const cache:any={},pending:any={},sent:any[]=[],acks:any[]=[],operations:any[]=[];
  let during:((p:any)=>void|Promise<void>)|undefined,failed=false,createFailed=false;
  const sync:any=new Proxy({offloadImages:async()=>{},createConversation:async(p:any)=>{if(createFailed)throw new Error('custody create outage');return 'conv-'+p.sessionId;},addMessages:async(p:any)=>{
    if(failed)throw new Error('custody network outage');sent.push(p);
    const callback=during;during=undefined;await callback?.(p);
    return {ids:p.messages.map((_:any,i:number)=>'row-'+sent.length+'-'+i)};
  },ackInjectedMessages:async(...args:any[])=>{acks.push(args);}}, {get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={hasPendingConversation:()=>false,getPendingOperations:()=>operations,add:(type:string,params:any)=>{operations.push({id:'q-'+operations.length,type,params});return operations.at(-1).id;}};
  const file=(id:string,text:string)=>{const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,text);cache[id]='conv-'+id;return p;};
  const cursor=(p:string,id:string)=>d.processCursorTranscriptFile(p,id,sync,'user',undefined,cache,queue,pending,()=>{});
  const claude=(p:string,id:string)=>d.processSessionFile(p,id,home,sync,'user',undefined,cache,queue,pending,{},()=>{});
  const gemini=(p:string,id:string)=>d.processGeminiSession(p,id,'hash',sync,'user',undefined,cache,queue,pending,{},()=>{});
  const receipts=(id:string)=>[...internal.acceptedPending.values()].flatMap((m:any)=>[...m.values()]).filter((r:any)=>r.sessionId===id);
  for(const kind of ['ack-throw','mapping-same','mapping-new','deadline','cancel','source-change']) {
    const id='late-'+kind,p=file(id,'assistant:\nbaseline\n');await cursor(p,id);const baseline=getPosition(p);
    fs.appendFileSync(p,'\nuser:\nidentical fresh occurrence\n\nassistant:\nidentical fresh occurrence\n');
    const before=sent.length,stat=fs.promises.stat.bind(fs.promises),controller=new AbortController();
    let expected=2;
    during=async()=>{
      if(kind==='ack-throw')fs.promises.stat=(async(...args:any[])=>{if(String(args[0])===p)throw Object.assign(new Error('ACK stat failed'),{code:'EIO'});return (stat as any)(...args);}) as typeof fs.promises.stat;
      if(kind.startsWith('mapping'))cache[id]='replacement-'+id;
      if(kind==='deadline'){(currentTranscriptDeadline() as any).end=performance.now()+10;await new Promise(resolve=>setTimeout(resolve,25));}
      if(kind==='cancel')controller.abort();
      if(kind==='source-change'){fs.writeFileSync(p+'.next','assistant:\nreplacement occurrence\n');fs.renameSync(p+'.next',p);expected=1;}
    };
    try {
      const run=()=>cursor(p,id);
      if(kind==='deadline')await assert.rejects(withTranscriptDeadline(run));
      else if(kind==='cancel')await assert.rejects(withTranscriptDeadline(run,{signal:controller.signal}));
      else await assert.rejects(run());
    } finally {fs.promises.stat=stat;}
    assert.equal(getPosition(p),baseline,kind+' late fence must keep byte position');
    assert.equal(sent.length,before+1,kind+' requires known server success');assert.equal(receipts(id).length,2,kind+' retains exact known acceptance');
    if(kind==='mapping-same')cache[id]='conv-'+id;
    await cursor(p,id);
    assert.equal(getPosition(p),fs.statSync(p).size,kind+' drains readable source');
    assert.equal(sent.length,before+(kind==='mapping-new'||kind==='source-change'?2:1),kind+' same destination cannot resend UUID-less rows');
    if(kind==='mapping-new')assert.equal(sent.at(-1).conversationId,'replacement-'+id);
    if(kind==='source-change')assert.equal(sent.at(-1).messages.length,expected);
    assert.equal(receipts(id).length,0,kind+' exact consumed receipts released');
  }
  for(const client of ['claude','cursor','codex']) for(const concurrent of [false,true]) {
    const id='read-generation-'+client+'-'+concurrent;
    const line=(key:string,text:string)=>client==='claude'?claudeLine(key,text):client==='cursor'?'user:\n'+text+'\n':JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00Z',payload:{id:key,type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
    const baseline=line('old-prefix','OLDprefix'),replacement=line('new-prefix','NEWprefix')+line('new-tailxx','new tail');assert.equal(Buffer.byteLength(baseline),Buffer.byteLength(line('new-prefix','NEWprefix')));
    const p=file(id,baseline),run=()=>client==='claude'?claude(p,id):client==='cursor'?cursor(p,id):d.processCodexSession(p,id,sync,'user',undefined,cache,queue,pending,{},()=>{});
    await run();fs.appendFileSync(p,line('old-tailxx','old tail'));const position=getPosition(p),before=sent.length,stat=fs.promises.stat.bind(fs.promises);let observations=0,fired=false;const boundaries:any[]=[];assert.ok(fs.statSync(p).size>position);
    fs.promises.stat=(async(...args:any[])=>{const result=await (stat as any)(...args);if(String(args[0])===p){boundaries.push({observation:++observations,ino:result.ino,size:result.size,position:getPosition(p)});}if(String(args[0])===p&&observations===2){fired=true;fs.writeFileSync(p+'.next',replacement);fs.renameSync(p+'.next',p);if(concurrent)setPosition(p,position+1);}return result;}) as typeof fs.promises.stat;
    let outcome:unknown;try{await run();}catch(error){outcome=error;}finally{fs.promises.stat=stat;console.error('F3_READ_GENERATION '+JSON.stringify({client,concurrent,fired,boundaries,outcome:String(outcome),position:getPosition(p)}));}
    assert.equal(fired,true,'replacement boundary must execute');assert.match(String(outcome),/generation changed after offset lookup/);
    assert.ok(position>0);assert.equal(getPosition(p),concurrent?position+1:0);assert.equal(sent.length,before);if(concurrent)continue;await run();assert.equal(getPosition(p),fs.statSync(p).size);assert.ok(sent.at(-1).messages.some((m:any)=>m.content==='NEWprefix'));
  }
  const countId='count-map-swap',countFile=file(countId,JSON.stringify({messages:[{type:'gemini',content:'count custody',timestamp:'2026-09-05T12:00:00Z'}]}));
  during=()=>{cache[countId]='new-count-conversation';};const countBefore=sent.length;
  await assert.rejects(gemini(countFile,countId));assert.equal(internal.geminiSyncedCounts.get(countFile)??0,0);assert.equal(receipts(countId).length,1);
  cache[countId]='conv-'+countId;await gemini(countFile,countId);assert.equal(sent.length,countBefore+1);assert.equal(internal.geminiSyncedCounts.get(countFile),1);
  const legacyId='legacy-cold',prefix=claudeLine('legacy-prefix','trusted numeric tail'),legacy=file(legacyId,prefix+claudeLine('legacy-tail','unproven old prefix'));
  setPosition(legacy,Buffer.byteLength(prefix));internal.injectedMessageTs.set('legacy-paste',{conversationId:cache[legacyId],ts:Date.now(),confirmed:true});
  const ackBefore=acks.length;await claude(legacy,legacyId);assert.equal(acks.length,ackBefore);assert.equal(getSyncRecord(legacy)?.sourceGeneration?.prefixProven,false);
  fs.appendFileSync(legacy,claudeLine('legacy-fresh','independently observed fresh append'));await claude(legacy,legacyId);assert.equal(acks.length,ackBefore+1);assert.equal(getSyncRecord(legacy)?.sourceGeneration?.prefixProven,false);
  const mismatchId='generation-mismatch',mismatch=file(mismatchId,prefix+claudeLine('mismatch-tail','keep legacy offset'));
  setPosition(mismatch,Buffer.byteLength(prefix));updateSyncRecord(mismatch,{lastSyncedPosition:1,sourceGeneration:{client:'claude',sessionId:mismatchId,dev:0,ino:0,birthtimeMs:0,unit:'bytes',watermark:1,prefixProven:true}});
  const mismatchBefore=sent.length;await claude(mismatch,mismatchId);assert.equal(sent[mismatchBefore].messages.length,1);assert.equal(getSyncRecord(mismatch)?.sourceGeneration?.prefixProven,false);
  const evictedId='generation-evicted',evicted=file(evictedId,claudeLine('before-eviction','accepted old generation'));await claude(evicted,evictedId);assert.equal(getSyncRecord(evicted)?.sourceGeneration?.prefixProven,true);
  for(let i=0;i<4096;i++){const p=path.join(home,'hint-'+i);fs.writeFileSync(p,'');await internal.observeTranscriptAckWindow('hint-'+i,p);}
  assert.equal(internal.transcriptAckObserved.size,4096);assert.equal(internal.transcriptAckObserved.has(evicted),false);
  fs.writeFileSync(evicted+'.next',claudeLine('after-eviction','replacement must start at zero')+'\n');fs.renameSync(evicted+'.next',evicted);const evictedBefore=sent.length;await claude(evicted,evictedId);assert.equal(sent[evictedBefore].messages[0].messageUuid,'after-eviction');
  const dbId='count-replacement',dbFile=path.join(home,'count-replacement.db');cache[dbId]='conv-'+dbId;
  const makeDb=(p:string,id:string)=>{const db=new Database(p);db.run('CREATE TABLE ItemTable(key TEXT,value TEXT)');db.run('INSERT INTO ItemTable VALUES(?,?)',['workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs:[{tabId:'tab',bubbles:[{type:'user',id,initText:id,contextCacheTimestamp:1000}]}]})]);db.close();};
  makeDb(dbFile,'old-row');const runDb=()=>d.processCursorSession(dbFile,dbId,home,sync,'user',undefined,cache,queue,pending,()=>{});await runDb();assert.equal(getPosition(dbFile),1);makeDb(dbFile+'.next','new-row');fs.renameSync(dbFile+'.next',dbFile);const dbBefore=sent.length;await runDb();assert.equal(getPosition(dbFile),1);assert.equal(sent[dbBefore].messages[0].messageUuid,'new-row');
  fs.writeFileSync(countFile+'.next',JSON.stringify({messages:[{type:'gemini',content:'new generation count',timestamp:'2026-09-05T12:00:00Z'}]}));fs.renameSync(countFile+'.next',countFile);const gemBefore=sent.length;await gemini(countFile,countId);assert.equal(sent[gemBefore].messages[0].content,'new generation count');
  const blockedId='receipt-blocked',blocked=file(blockedId,'assistant:\nblocked source remains\n');
  const parsed=await readTranscriptIngest({client:'cursor',file:blocked,sessionId:blockedId,offset:0}),record=ingestRecord(parsed.messages[0])!;
  const entries=Array.from({length:2048},(_,i)=>({key:record.key+'-'+i,signature:record.signature,file:blocked,identity:record.identity,size:record.sourceSize}));
  const reservation=internal.reserveTranscriptReceipts(blockedId,cache[blockedId],entries);assert.ok(reservation);reservation.accept();reservation.release();
  assert.equal(internal.reserveTranscriptReceipts(blockedId,cache[blockedId],[{...entries[0],key:'one-too-many'}]),null);assert.equal(receipts(blockedId).length,2048);
  const healthyId='receipt-healthy',healthy=file(healthyId,'assistant:\nunrelated owner drains\n');await cursor(healthy,healthyId);assert.equal(getPosition(healthy),fs.statSync(healthy).size);assert.equal(receipts(healthyId).length,0);assert.equal(receipts(blockedId).length,2048);assert.ok(fs.existsSync(blocked));
  const largeId='large-pending',large=file(largeId,'assistant:\n'+'a'.repeat(1_100_000)+'\n');delete cache[largeId];createFailed=true;await assert.rejects(cursor(large,largeId));assert.equal(pending[largeId],undefined);assert.equal(getPosition(large),0);createFailed=false;await cursor(large,largeId);assert.equal(getPosition(large),fs.statSync(large).size);
  const owner=internal.transcriptRetryOwners,map=new Map();let now=Date.now(),gaveUp=0;owner.options.now=()=>now;
  const manyId='many-count',many=file(manyId,JSON.stringify({messages:Array.from({length:2500},()=>({type:'gemini',content:'identical independent occurrence',timestamp:'2026-09-05T12:00:00Z'}))}));delete cache[manyId];createFailed=true;
  const scheduled=owner.create(map,many,{client:'gemini',file:many,sessionId:manyId},()=>gemini(many,manyId),{debounceMs:0,maxWaitMs:0,maxRetries:1,onGiveUp:()=>gaveUp++});
  scheduled.invalidate();await until(()=>gaveUp>0);assert.equal(internal.geminiSyncedCounts.get(many)??0,0);assert.ok((pending[manyId]?.length??0)<=512);
  const emptyId='continuation-exhaustion',empty=file(emptyId,'\n'.repeat(256*27)+claudeLine('after-exhaustion','after bounded empty windows'));let emptyExhausted=0;
  const emptyOwner=owner.create(map,empty,{client:'claude',file:empty,sessionId:emptyId},()=>claude(empty,emptyId),{debounceMs:0,maxWaitMs:0,maxRetries:1,onGiveUp:()=>emptyExhausted++});
  emptyOwner.invalidate();await until(()=>emptyExhausted>0);assert.equal(getPosition(empty),256*25);
  const manyBefore=sent.length,mtime=fs.statSync(many).mtimeMs;createFailed=false;
  const source=fs.readFileSync(path.resolve(import.meta.dir,'../../daemon.ts'),'utf8'),heartbeat=source.match(/setInterval\(\(\) => \{ transcriptRetryOwners\.drain\(\); sendHeartbeat\(\)\.catch\(\(\) => \{\}\); \}, 30_000\);/);assert.ok(heartbeat);
  let timer:ReturnType<typeof setInterval>|undefined;
  try{
    new Function('setInterval','transcriptRetryOwners','sendHeartbeat',heartbeat[0])((callback:()=>void)=>{timer=setInterval(()=>{now+=30_001;callback();},5);},owner,async()=>{});
    await until(()=>internal.geminiSyncedCounts.get(many)===2500&&getPosition(empty)===fs.statSync(empty).size);await tick();
    const manyRows=sent.slice(manyBefore).filter(p=>p.conversationId===cache[manyId]).flatMap(p=>p.messages);assert.equal(manyRows.length,2500);assert.ok(manyRows.every(m=>!m.messageUuid));assert.equal(receipts(manyId).length,0);assert.equal(pending[manyId],undefined);assert.equal(fs.statSync(many).mtimeMs,mtime);
  }finally{if(timer)clearInterval(timer);owner.stop();internal.injectedMessageTs.clear();}
  return {lateAcceptance:6,readGeneration:6,countMapping:true,legacyFreshAppend:true,mismatchCold:true,evictedReplacement:true,countReplacement:true,receiptCapacity:2048,healthyProgress:true,oversizedPendingBypass:true,scheduledOccurrences:2500,continuationWake:true};
}
