import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RetryQueue} from '../../retryQueue.js';
import {ackInjectedForDaemon} from '../../../../convex/convex/pendingMessages.js';
import {makeFakeDb} from '../../../../convex/convex/testDb.js';
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
export async function ackCustody(f:any) {
  const {d,home,getPosition,claudeLine}=f;
  const tables:any={conversations:[],pending_messages:[],messages:[]},db=makeFakeDb(tables);
  const cache:any={},pending:any={},acks:Promise<unknown>[]=[],calls:any[]=[],rows=new Map<string,any>();
  let failed=false,duringSend:(()=>void)|undefined;
  const sync:any=new Proxy({
    offloadImages:async()=>{},createConversation:async()=>{throw new Error('fixture uses existing conversations');},
    addMessages:async(p:any)=>{
      if(failed)throw new Error('ACK fixture outage');
      const ids=p.messages.map((m:any)=>{const key=p.conversationId+':'+m.messageUuid;let row=rows.get(key);if(!row){row={_id:key,conversation_id:p.conversationId,role:m.role==='human'?'user':m.role,content:m.content,timestamp:m.timestamp};rows.set(key,row);tables.messages.push(row);}return row._id;});
      duringSend?.();duringSend=undefined;return {ids};
    },
    ackInjectedMessages:(...args:any[])=>{calls.push(args);const result=ackInjectedForDaemon({db} as any,args[0],args[1],args[2]);acks.push(result);return result;},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue=new RetryQueue({persistPath:path.join(home,'ack-retry.json'),initialDelayMs:1,maxDelayMs:1});
  const source=fs.readFileSync(path.resolve(import.meta.dir,'../../daemon.ts'),'utf8');
  const start=source.indexOf('    if (op.type === "addMessages") {',source.indexOf('retryQueue.setExecutor'));
  const end=source.indexOf('    if (op.type === "addMessage") {',start);
  assert.ok(start>0&&end>start);
  const body=new Bun.Transpiler({loader:'ts'}).transformSync('async function execute(op:any){'+source.slice(start,end)+'}');
  const executor=new Function('syncService','retryQueue','updateState','log',body+';return execute;')(sync,queue,()=>{},()=>{});
  queue.setExecutor(executor);
  const setup=(id:string)=>{cache[id]='conv-'+id;tables.conversations.push({_id:cache[id],user_id:'fixture-owner',has_pending_messages:true});const p=path.join(home,id+'.jsonl');fs.writeFileSync(p,claudeLine(id+'-baseline','baseline'));return p;};
  const paste=(id:string,suffix:string)=>{const pendingId=id+'-'+suffix;tables.pending_messages.push({_id:pendingId,conversation_id:cache[id],from_user_id:'fixture-owner',client_id:pendingId+'-client',content:'prompt '+suffix,created_at:Date.now(),retry_count:0,status:'injected'});d.fixtureAck.injectedMessageTs.set(pendingId,{conversationId:cache[id],ts:Date.now(),confirmed:true});return pendingId;};
  const run=(p:string,id:string)=>d.processSessionFile(p,id,home,sync,'user',undefined,cache,queue,pending,{},()=>{});
  const status=(id:string)=>tables.pending_messages.find((p:any)=>p._id===id)?.status;
  try {
    const id='ack-queued',p=setup(id);failed=true;await assert.rejects(run(p,id),/retains unread data/);assert.equal(getPosition(p),0);assert.equal(queue.getQueueSize(),1);
    failed=false;queue.start();queue.notifyConnectionRestored();const deadline=Date.now()+3000;
    while(queue.getQueueSize()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(queue.getQueueSize(),0);queue.stop();
    const newer=paste(id,'newer-not-echoed');
    fs.writeFileSync(path.join(home,'ack-restart.json'),JSON.stringify({file:p,id,conversationId:cache[id],pending:tables.pending_messages.find((row:any)=>row._id===newer),row:rows.get(cache[id]+':'+id+'-baseline')}));
    const restarted=await promisify(execFile)(process.execPath,[path.join(import.meta.dir,'ingestProduction.ts'),String(f.enabled),'ack-restart'],{env:process.env,timeout:15_000,maxBuffer:1024*1024});
    assert.ok(restarted.stdout.includes('"coldAckSuppressed":true'));
    await run(p,id);await Promise.all(acks);
    assert.equal(status(newer),'injected','queued reread must not ACK a newer prompt');assert.equal(rows.get(cache[id]+':'+id+'-baseline').client_id,undefined);assert.equal(calls.length,0);
    const positive='ack-fresh',fresh=setup(positive);await run(fresh,positive);const healthy=paste(positive,'healthy');fs.appendFileSync(fresh,claudeLine('healthy-echo','prompt healthy'));await run(fresh,positive);await Promise.all(acks);
    assert.equal(status(healthy),'delivered');assert.equal(rows.get(cache[positive]+':healthy-echo').client_id,healthy+'-client');
    const checks=['queued reread uses real queue executor and backend ACK handler','healthy known append positive','actual daemon-import subprocess restart'];
    for(const kind of ['unknown','replacement','mixed','during-await','replace-during-await','harness','pending']) {
      const id='ack-'+kind,p=setup(id);
      if(!['unknown','pending'].includes(kind))await run(p,id);
      const target=paste(id,'unconfirmed');const before=calls.length;
      if(kind==='replacement'){fs.writeFileSync(p+'.new',claudeLine('replaced-row','historical replacement'));fs.renameSync(p+'.new',p);}
      else if(kind==='mixed'){
        fs.appendFileSync(p,claudeLine('old-mixed','failed older echo'));failed=true;await assert.rejects(run(p,id),/retains unread data/);failed=false;
        queue.clear();fs.appendFileSync(p,claudeLine('new-mixed','new native row'));
      } else if(kind==='during-await'){
        fs.appendFileSync(p,claudeLine('await-echo','first prompt echo'));duringSend=()=>{paste(id,'arrived-during-send');};
      } else if(kind==='replace-during-await') {
        fs.appendFileSync(p,claudeLine('replace-await-echo','native echo before replacement'));
        duringSend=()=>{fs.writeFileSync(p+'.next',claudeLine('replacement-await','new source'));fs.renameSync(p+'.next',p);};
      } else if(kind==='harness')fs.appendFileSync(p,claudeLine('harness-row','<task-notification>background job</task-notification>'));
      else if(kind==='pending') {
        const {readTranscriptIngest}=await import('../ingestClient.js');const result=await readTranscriptIngest({client:'claude',file:p,sessionId:id,offset:0});
        await d.retainPendingTranscript(pending,id,result.messages,p,fs.statSync(p).size);
      }
      if(kind==='replace-during-await')await assert.rejects(run(p,id),/source changed before position commit/);else await run(p,id);await Promise.all(acks);assert.equal(status(target),'injected',kind+' must not acknowledge unrelated paste');assert.equal(calls.length,before,kind+' must suppress entire positional ACK block');checks.push(kind);
    }
    return {checks,backendPositive:true,queueExecutor:true};
  } finally {queue.stop();d.fixtureAck.injectedMessageTs.clear();}
}

export async function restartAckCustody(f:any) {
  const {d,home,getPosition}=f,receipt=JSON.parse(fs.readFileSync(path.join(home,'ack-restart.json'),'utf8'));
  const tables:any={conversations:[{_id:receipt.conversationId,user_id:'fixture-owner',has_pending_messages:true}],pending_messages:[receipt.pending],messages:[receipt.row]},db=makeFakeDb(tables);
  const cache:any={[receipt.id]:receipt.conversationId},acks:Promise<unknown>[]=[];
  d.fixtureAck.injectedMessageTs.set(receipt.pending._id,{conversationId:receipt.conversationId,ts:Date.now(),confirmed:true});
  const sync:any=new Proxy({offloadImages:async()=>{},addMessages:async()=>({ids:[receipt.row._id]}),ackInjectedMessages:(...args:any[])=>{const promise=ackInjectedForDaemon({db} as any,args[0],args[1],args[2]);acks.push(promise);return promise;}},{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={hasPendingConversation:()=>false,getPendingOperations:()=>[],add:()=>{throw new Error('restart cannot enqueue');}};
  await d.processSessionFile(receipt.file,receipt.id,home,sync,'user',undefined,cache,queue,{}, {},()=>{});await Promise.all(acks);
  assert.equal(acks.length,0,'cold daemon must not vouch historical echoes');assert.equal(receipt.pending.status,'injected');assert.equal(receipt.row.client_id,undefined);assert.equal(getPosition(receipt.file),fs.statSync(receipt.file).size);
  return {coldAckSuppressed:true,pid:process.pid};
}
