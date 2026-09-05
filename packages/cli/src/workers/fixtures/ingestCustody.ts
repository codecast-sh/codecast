import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  const queue:any={hasPendingConversation:()=>false,add:()=> 'memory-only'};
  const write=(id:string,text:string)=>{const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,text);return p;};
  const run=(p:string,id:string,q=queue)=>d.processSessionFile(p,id,home,sync,'user',undefined,cache,q,pending,titles,()=>{});
  const params=(sessionId:string)=>({sessionId,userId:'user',agentType:'claude_code'});
  const p=write('custody-create',claudeLine('custody-create-row','once after recovery'));
  createFailed=true;for(let i=0;i<3;i++)await run(p,'custody-create');assert.equal(getPosition(p),0);assert.equal(pending['custody-create'].length,1);
  createFailed=false;await run(p,'custody-create');assert.equal(getPosition(p),fs.statSync(p).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-create-row').length,1);
  const staleFile=write('custody-stale',claudeLine('custody-stale-row','retained stale flush'));
  createFailed=true;await run(staleFile,'custody-stale');createFailed=false;stale=true;
  await run(staleFile,'custody-stale');assert.equal(getPosition(staleFile),0);assert.equal(cache['custody-stale'],undefined);assert.equal(pending['custody-stale'].length,1);
  assert.equal(await d.retryCreateTranscriptConversation(params('custody-stale'),cache,pending,sync,queue,()=>{}),false);assert.equal(pending['custody-stale'].length,1);assert.equal(cache['custody-stale'],undefined);
  stale=false;conversation='resolved-conversation';assert.equal(await d.retryCreateTranscriptConversation(params('custody-stale'),cache,pending,sync,queue,()=>{}),true);assert.equal(getPosition(staleFile),0);
  await run(staleFile,'custody-stale');assert.equal(getPosition(staleFile),fs.statSync(staleFile).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-stale-row').length,1);
  const snapshotFile=write('custody-snapshot',claudeLine('snapshot-old','old accepted snapshot'));
  const parsed=await readTranscriptIngest({client:'claude',file:snapshotFile,sessionId:'custody-snapshot',offset:0});await d.retainPendingTranscript(pending,'custody-snapshot',parsed.messages,snapshotFile,fs.statSync(snapshotFile).size);cache['custody-snapshot']='snapshot-conversation';
  const entered=deferred(),release=deferred(),old=sync.addMessages;
  sync.addMessages=async(p:any)=>{entered.resolve();await release.promise;return old(p);};
  const flushing=d.flushPendingTranscript(pending,'custody-snapshot',cache['custody-snapshot'],cache,sync,queue);await entered.promise;
  const replacement={...pending['custody-snapshot'][0],content:'replacement during await'},appended={...replacement,uuid:'appended-during-flush'};
  pending['custody-snapshot']=[replacement,appended];release.resolve();assert.equal(await flushing,false);assert.deepEqual(pending['custody-snapshot'],[replacement,appended]);sync.addMessages=old;
  const newerEntered=deferred(),newerRelease=deferred();sync.addMessages=async()=>{newerEntered.resolve();await newerRelease.promise;throw new Error('Conversation not found');};
  const superseded=d.flushPendingTranscript(pending,'custody-snapshot','snapshot-conversation',cache,sync,queue);await newerEntered.promise;cache['custody-snapshot']='newer-conversation';newerRelease.resolve();assert.equal(await superseded,false);assert.equal(cache['custody-snapshot'],'newer-conversation');assert.equal(pending['custody-snapshot'].length,2);sync.addMessages=old;
  const raceFile=write('custody-race',claudeLine('custody-race-row','one callback and direct pass'));
  createFailed=true;await run(raceFile,'custody-race');createFailed=false;
  const createEntered=deferred(),createRelease=deferred(),oldCreate=sync.createConversation;
  sync.createConversation=async()=>{createEntered.resolve();await createRelease.promise;return oldCreate();};
  const retrying=d.retryCreateTranscriptConversation(params('custody-race'),cache,pending,sync,queue,()=>{});await createEntered.promise;
  const before=sent.length,direct=run(raceFile,'custody-race');await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,before);createRelease.resolve();assert.equal(await retrying,true);await direct;sync.createConversation=oldCreate;
  assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-race-row').length,1);assert.equal(getPosition(raceFile),fs.statSync(raceFile).size);
  const noUuid=write('custody-no-uuid',claudeLine('discard','distinct occurrence').replace(',"uuid":"discard"','').repeat(2));
  createFailed=true;for(let i=0;i<2;i++)await run(noUuid,'custody-no-uuid');createFailed=false;assert.equal(pending['custody-no-uuid'].length,2);
  const beforeNoUuid=sent.length;await run(noUuid,'custody-no-uuid');const occurrences=sent.slice(beforeNoUuid).flatMap(x=>x.messages);assert.equal(occurrences.length,2);assert.ok(occurrences.every(m=>m.messageUuid===undefined));
  const impossible=path.join(home,'queue-persistence-is-directory');fs.mkdirSync(impossible);const logs:string[]=[];
  const realQueue=new RetryQueue({persistPath:impossible,onLog:m=>logs.push(m),persistDebounceMs:60_000});
  const durableFile=write('custody-disk-failed',claudeLine('custody-disk-row','transcript retains custody'));cache['custody-disk-failed']='disk-conversation';sendFailed=true;
  await run(durableFile,'custody-disk-failed',realQueue);realQueue.persistNow({sync:true});assert.ok(logs.some(m=>m.includes('Failed to persist')));assert.equal(getPosition(durableFile),0);
  realQueue.stop();const restarted=new RetryQueue({persistPath:impossible,onLog:m=>logs.push(m),persistDebounceMs:60_000});assert.equal(restarted.getQueueSize(),0);sendFailed=false;
  await run(durableFile,'custody-disk-failed',restarted);assert.equal(getPosition(durableFile),fs.statSync(durableFile).size);assert.equal(sent.flatMap(x=>x.messages).filter(m=>m.messageUuid==='custody-disk-row').length,1);restarted.stop();
  const rejectedFile=write('custody-enqueue-failed',claudeLine('enqueue-row','keep bytes when enqueue throws'));cache['custody-enqueue-failed']='enqueue-conversation';sendFailed=true;
  await assert.rejects(run(rejectedFile,'custody-enqueue-failed',{hasPendingConversation:()=>false,add:()=>{throw new Error('fixture durable enqueue failed');}}));assert.equal(getPosition(rejectedFile),0);sendFailed=false;await run(rejectedFile,'custody-enqueue-failed');assert.equal(getPosition(rejectedFile),fs.statSync(rejectedFile).size);
  return {checks:9,createRetries:creates,stableSnapshot:true,callbackSerialized:true,uuidlessDistinct:true,failedPersistenceRetainsTranscript:true};
}
