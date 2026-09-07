import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {InvalidateSync} from '../../invalidateSync.js';
import {RetryQueue} from '../../retryQueue.js';
import {readTranscriptIngest} from '../ingestClient.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
export async function custody(f:any) {
  const {d,home,getPosition,claudeLine}=f,cache:any={},pending:any={},titles:any={},sent:any[]=[];
  let createFailed=false,sendFailed=false,stale=false,creates=0,conversation='custody-conversation';
  const sync:any=new Proxy({
    createConversation:async()=>{creates++;if(createFailed)throw new Error('fixture create failed');return conversation;},
    offloadImages:async()=>{},
    addMessages:async(p:any)=>{if(stale)throw new Error('Conversation not found');if(sendFailed)throw new Error('fixture network failed');sent.push(p);return {ids:p.messages.map((m:any,i:number)=>m.messageUuid??`uuidless-${sent.length}-${i}`)};},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const operations:any[]=[];
  const queue:any={getPendingOperations:()=>operations,hasPendingConversation:()=>false,add:(type:string,params:any)=>{operations.push({id:'memory-'+operations.length,type,params});return operations.at(-1).id;}};
  const write=(id:string,text:string)=>{const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,text);return p;};
  const run=(p:string,id:string,q=queue)=>d.processSessionFile(p,id,home,sync,'user',undefined,cache,q,pending,titles,()=>{});
  const params=(sessionId:string)=>({sessionId,userId:'user',agentType:'claude_code'});
  const p=write('custody-create',claudeLine('custody-create-row','once after recovery'));
  createFailed=true;for(let i=0;i<3;i++)await assert.rejects(run(p,'custody-create'),/retains unread data/);assert.equal(getPosition(p),0);assert.equal(pending['custody-create'].length,1);
  createFailed=false;await run(p,'custody-create');assert.equal(getPosition(p),fs.statSync(p).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-create-row').length,1);
  const staleFile=write('custody-stale',claudeLine('custody-stale-row','retained stale flush'));
  createFailed=true;await assert.rejects(run(staleFile,'custody-stale'),/retains unread data/);createFailed=false;stale=true;
  await assert.rejects(run(staleFile,'custody-stale'),/retains unread data/);assert.equal(getPosition(staleFile),0);assert.equal(cache['custody-stale'],undefined);assert.equal(pending['custody-stale'].length,1);
  assert.equal(await d.retryCreateTranscriptConversation(params('custody-stale'),cache,pending,sync,queue,()=>{}),false);assert.equal(pending['custody-stale'].length,1);assert.equal(cache['custody-stale'],undefined);
  stale=false;conversation='resolved-conversation';assert.equal(await d.retryCreateTranscriptConversation(params('custody-stale'),cache,pending,sync,queue,()=>{}),true);assert.equal(getPosition(staleFile),0);
  await run(staleFile,'custody-stale');assert.equal(getPosition(staleFile),fs.statSync(staleFile).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-stale-row').length,1);
  const snapshotFile=write('custody-snapshot',claudeLine('snapshot-old','old accepted snapshot'));
  const parsed=await readTranscriptIngest({client:'claude',file:snapshotFile,sessionId:'custody-snapshot',offset:0});await d.retainPendingTranscript(pending,'custody-snapshot',parsed.messages,snapshotFile,fs.statSync(snapshotFile).size);cache['custody-snapshot']='snapshot-conversation';
  const entered=deferred(),release=deferred(),old=sync.addMessages;
  sync.addMessages=async(p:any)=>{entered.resolve();await release.promise;return old(p);};
  const flushing=d.flushPendingTranscript(pending,'custody-snapshot',cache['custody-snapshot'],cache,sync,queue);await entered.promise;
  fs.writeFileSync(snapshotFile,claudeLine('snapshot-old','replacement during await')+claudeLine('appended-during-flush','appended during await'));
  const updated=await readTranscriptIngest({client:'claude',file:snapshotFile,sessionId:'custody-snapshot',offset:0});
  await d.retainPendingTranscript(pending,'custody-snapshot',updated.messages,snapshotFile,fs.statSync(snapshotFile).size);
  const [replacement,appended]=pending['custody-snapshot'];release.resolve();assert.equal(await flushing,false);assert.deepEqual(pending['custody-snapshot'],[replacement,appended]);sync.addMessages=old;
  const newerEntered=deferred(),newerRelease=deferred();sync.addMessages=async()=>{newerEntered.resolve();await newerRelease.promise;throw new Error('Conversation not found');};
  const superseded=d.flushPendingTranscript(pending,'custody-snapshot','snapshot-conversation',cache,sync,queue);await newerEntered.promise;cache['custody-snapshot']='newer-conversation';newerRelease.resolve();assert.equal(await superseded,false);assert.equal(cache['custody-snapshot'],'newer-conversation');assert.equal(pending['custody-snapshot'].length,2);sync.addMessages=old;
  const raceFile=write('custody-race',claudeLine('custody-race-row','one callback and direct pass'));
  createFailed=true;await assert.rejects(run(raceFile,'custody-race'),/retains unread data/);createFailed=false;
  const createEntered=deferred(),createRelease=deferred(),oldCreate=sync.createConversation;
  sync.createConversation=async()=>{createEntered.resolve();await createRelease.promise;return oldCreate();};
  const retrying=d.retryCreateTranscriptConversation(params('custody-race'),cache,pending,sync,queue,()=>{});await createEntered.promise;
  const before=sent.length,direct=run(raceFile,'custody-race');await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,before);createRelease.resolve();assert.equal(await retrying,true);await direct;sync.createConversation=oldCreate;
  assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-race-row').length,1);assert.equal(getPosition(raceFile),fs.statSync(raceFile).size);
  const noUuid=write('custody-no-uuid',claudeLine('discard','distinct occurrence').replace(',"uuid":"discard"','').repeat(2));
  createFailed=true;for(let i=0;i<2;i++)await assert.rejects(run(noUuid,'custody-no-uuid'),/retains unread data/);createFailed=false;assert.equal(pending['custody-no-uuid'].length,2);
  const beforeNoUuid=sent.length;await run(noUuid,'custody-no-uuid');const occurrences=sent.slice(beforeNoUuid).flatMap(x=>x.messages);assert.equal(occurrences.length,2);assert.ok(occurrences.every(m=>m.messageUuid===undefined));
  const impossible=path.join(home,'queue-persistence-is-directory');fs.mkdirSync(impossible);const logs:string[]=[];
  const realQueue=new RetryQueue({persistPath:impossible,onLog:m=>logs.push(m),persistDebounceMs:60_000});
  const durableFile=write('custody-disk-failed',claudeLine('custody-disk-row','transcript retains custody'));cache['custody-disk-failed']='disk-conversation';sendFailed=true;
  await assert.rejects(run(durableFile,'custody-disk-failed',realQueue),/retains unread data/);realQueue.persistNow({sync:true});assert.ok(logs.some(m=>m.includes('Failed to persist')));assert.equal(getPosition(durableFile),0);
  realQueue.stop();const restarted=new RetryQueue({persistPath:impossible,onLog:m=>logs.push(m),persistDebounceMs:60_000});assert.equal(restarted.getQueueSize(),0);sendFailed=false;
  await run(durableFile,'custody-disk-failed',restarted);assert.equal(getPosition(durableFile),fs.statSync(durableFile).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-disk-row').length,1);restarted.stop();
  const rejectedFile=write('custody-enqueue-failed',claudeLine('enqueue-row','keep bytes when enqueue throws'));cache['custody-enqueue-failed']='enqueue-conversation';sendFailed=true;
  await assert.rejects(run(rejectedFile,'custody-enqueue-failed',{hasPendingConversation:()=>false,add:()=>{throw new Error('fixture durable enqueue failed');}}));assert.equal(getPosition(rejectedFile),0);sendFailed=false;await run(rejectedFile,'custody-enqueue-failed');assert.equal(getPosition(rejectedFile),fs.statSync(rejectedFile).size);
  const cursorFile=path.join(home,'custody-cursor.txt'),cursorId='custody-cursor';
  fs.writeFileSync(cursorFile,'assistant:\nsame occurrence\n\nassistant:\nsame occurrence\n');
  const cursorRun=()=>d.processCursorTranscriptFile(cursorFile,cursorId,sync,'user',undefined,cache,queue,pending,()=>{});
  createFailed=true;await assert.rejects(cursorRun(),/retains unread data/);createFailed=false;
  assert.equal(pending[cursorId].length,2);const generatedAt=pending[cursorId][0].timestamp;
  const cursorBefore=sent.length;
  assert.equal(await d.retryCreateTranscriptConversation({...params(cursorId),agentType:'cursor'},cache,pending,sync,queue,()=>{}),true);
  await new Promise(resolve=>setTimeout(resolve,20));
  const clocked=await readTranscriptIngest({client:'cursor',file:cursorFile,sessionId:cursorId,offset:0});assert.ok(clocked.messages[0].timestamp>generatedAt);
  await cursorRun();assert.equal(getPosition(cursorFile),fs.statSync(cursorFile).size);
  assert.equal(sent.slice(cursorBefore).flatMap(x=>x.messages).length,2,'Cursor generated time must not duplicate an accepted pending snapshot');
  const timedFile=write('custody-timestamp',claudeLine('timestamp-row','same real timestamped row'));const timedId='custody-timestamp';
  createFailed=true;await assert.rejects(run(timedFile,timedId),/retains unread data/);createFailed=false;
  await d.retryCreateTranscriptConversation(params(timedId),cache,pending,sync,queue,()=>{});
  fs.writeFileSync(timedFile,fs.readFileSync(timedFile,'utf8').replace('12:00:00.000Z','12:00:01.000Z'));
  const timedBefore=sent.length;await run(timedFile,timedId);assert.equal(sent.length,timedBefore+1,'genuine timestamp change remains a changed row');
  for(const action of ['replace','delete']) {
    const id='receipt-'+action,p=write(id,claudeLine(id,'receipt cleanup'));
    createFailed=true;await assert.rejects(run(p,id),/retains unread data/);createFailed=false;
    await d.retryCreateTranscriptConversation(params(id),cache,pending,sync,queue,()=>{});
    const receiptMap=d.fixtureReceipts.acceptedPending.get(cache[id]);assert.ok([...receiptMap.values()].some((v:any)=>v.file===p));
    if(action==='delete')fs.unlinkSync(p);else{fs.writeFileSync(p+'.next',claudeLine(id,'replacement'));fs.renameSync(p+'.next',p);}
    await d.fixtureReceipts.pruneAcceptedTranscript();assert.ok(![...d.fixtureReceipts.acceptedPending.values()].some((m:any)=>[...m.values()].some((v:any)=>v.file===p)));
  }
  const scheduled=await scheduledCustody(f);
  return {checks:14,cursorGeneratedTime:true,receiptCleanup:true,scheduled,createRetries:creates,stableSnapshot:true,callbackSerialized:true,uuidlessDistinct:true,failedPersistenceRetainsTranscript:true};
}

export async function scheduledCustody(f:any) {
  const {d,home,getPosition,claudeLine}=f,cache:any={},pending:any={},operations:any[]=[],sent:any[]=[];
  const p=path.join(home,'scheduled-uuidless.jsonl'),id='scheduled-uuidless';
  const content=JSON.parse(claudeLine('omit','identical assistant occurrence'));delete content.uuid;content.type='assistant';content.message.role='assistant';
  fs.writeFileSync(p,(JSON.stringify(content)+'\n').repeat(2));cache[id]='scheduled-conversation';
  let attempts=0,createAttempts=0,gaveUp=0,queuePeak=0;
  const queue:any={getPendingOperations:()=>operations,hasPendingConversation:()=>attempts<=2,add:(type:string,params:any)=>{operations.push({id:'q'+operations.length,type,params});queuePeak=Math.max(queuePeak,operations.length);return operations.at(-1).id;}};
  const sync:any=new Proxy({
    createConversation:async()=>{createAttempts++;if(createAttempts<3)throw new Error('scheduled create outage');return 'scheduled-created';},
    offloadImages:async()=>{},addMessages:async(p:any)=>{if(attempts<5)throw new Error('scheduled send outage');sent.push(p);return {ids:p.messages.map((_:any,i:number)=>String(i))};},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const run=()=>d.processSessionFile(p,id,home,sync,'user',undefined,cache,queue,pending,{},()=>{});
  const random=Math.random;Math.random=()=>0;
  const invalidator=new InvalidateSync(async()=>{attempts++;try{await run();}finally{if(attempts<5)assert.equal(getPosition(p),0);}}, {maxRetries:6,onGiveUp:()=>gaveUp++});
  try {
    await invalidator.invalidateAndAwait();
    assert.equal(attempts,5,'old return-success contract prevents unchanged-file retry');
    assert.equal(gaveUp,0);assert.equal(operations.length,0,'UUID-less source must have no opaque queued copies');assert.equal(sent.flatMap(x=>x.messages).length,2);assert.equal(getPosition(p),fs.statSync(p).size);
  } finally {invalidator.stop();Math.random=random;}
  const createId='scheduled-create',createFile=path.join(home,createId+'.jsonl');fs.writeFileSync(createFile,(JSON.stringify(content)+'\n').repeat(2));
  Math.random=()=>0;
  const creator=new InvalidateSync(()=>d.processSessionFile(createFile,createId,home,sync,'user',undefined,cache,queue,pending,{},()=>{}),{maxRetries:4});
  try {await creator.invalidateAndAwait();assert.equal(createAttempts,3);assert.equal(queuePeak,1);assert.equal(operations.filter(op=>op.type==='createConversation').length,1);assert.equal(pending[createId],undefined);assert.equal(getPosition(createFile),fs.statSync(createFile).size);}
  finally{creator.stop();Math.random=random;}
  const exhaustedId='scheduled-exhausted',exhaustedFile=path.join(home,exhaustedId+'.jsonl');fs.writeFileSync(exhaustedFile,(JSON.stringify(content)+'\n').repeat(2));cache[exhaustedId]='exhausted-conversation';
  let outage=true,exhaustedAttempts=0,exhaustedGiveups=0;
  const send=sync.addMessages;sync.addMessages=async(p:any)=>{if(outage)throw new Error('exhaustion outage');return send(p);};
  const noQueue:any={getPendingOperations:()=>[],hasPendingConversation:()=>false,add:()=>{throw new Error('UUID-less retry enqueued');}};
  const exhausted=new InvalidateSync(async()=>{exhaustedAttempts++;await d.processSessionFile(exhaustedFile,exhaustedId,home,sync,'user',undefined,cache,noQueue,pending,{},()=>{});},{maxRetries:3,onGiveUp:()=>exhaustedGiveups++});
  Math.random=()=>0;
  try {
    await exhausted.invalidateAndAwait();assert.equal(exhaustedAttempts,3);assert.equal(exhaustedGiveups,1);assert.equal(getPosition(exhaustedFile),0);assert.equal(pending[exhaustedId],undefined);
    outage=false;await exhausted.invalidateAndAwait();assert.equal(exhaustedAttempts,4);assert.equal(getPosition(exhaustedFile),fs.statSync(exhaustedFile).size);
  } finally{exhausted.stop();Math.random=random;sync.addMessages=send;}
  const lostId='uuidless-lost-response',lostFile=path.join(home,lostId+'.jsonl');fs.writeFileSync(lostFile,JSON.stringify(content)+'\n');cache[lostId]='lost-response-conversation';
  let lostAttempts=0;const committed:any[]=[];
  sync.addMessages=async(p:any)=>{committed.push(...p.messages);if(++lostAttempts===1)throw new Error('response lost after commit');return {ids:['accepted']};};
  const lost=new InvalidateSync(()=>d.processSessionFile(lostFile,lostId,home,sync,'user',undefined,cache,noQueue,pending,{},()=>{}),{maxRetries:2});Math.random=()=>0;
  try{await lost.invalidateAndAwait();assert.equal(lostAttempts,2);assert.equal(committed.length,2,'UUID-less lost response retains the pre-existing at-least-once limitation');assert.equal(getPosition(lostFile),fs.statSync(lostFile).size);}
  finally{lost.stop();Math.random=random;sync.addMessages=send;}
  return {unchangedFileAttempts:attempts,queuePeak,distinctOccurrences:2,coalescedCreateAttempts:createAttempts,exhaustedAttempts,exhaustedGiveups,uuidlessLostResponseCopies:committed.length};
}
