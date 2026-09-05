import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SyncService as SyncServiceType } from '../../syncService.js';
import { currentTranscriptDeadline } from '../ingestDeadline.js';

export async function subBatchReview(f:any) {
  const {d,home,getPosition}=f,internal=d.fixtureCustody;
  const servicePath=process.env.F3_FIXTURE_SYNC_SERVICE??path.resolve(import.meta.dir,'../../syncService.ts');
  assert.ok(!process.env.F3_FIXTURE_SYNC_SERVICE||servicePath.startsWith(home+path.sep));
  const sha256=createHash('sha256').update(fs.readFileSync(servicePath)).digest('hex');
  const {SyncService}=await import(servicePath);
  const sourceReceipt={pid:process.pid,servicePath,sha256};
  console.error('F3_SERVICE_SOURCE '+JSON.stringify(sourceReceipt));
  const cache:any={},pending:any={},operations:any[]=[],writes:any[]=[],stored:any[]=[],acceptedIndexes:number[][]=[];
  const service:any=new SyncService({convexUrl:'http://127.0.0.1:1',userId:'fixture-user',authToken:'fixture-token'});
  let failCreate=false,failSecond=false,call=0,afterWrite:undefined|((count:number)=>void),existing=new Set<string>();
  service.client={mutation:async(name:string,args:any,options:any)=>{
    assert.equal(name,'messages:addMessages');assert.deepEqual(options,{skipQueue:true});
    assert.deepEqual(Object.keys(args).sort(),['api_token','conversation_id','messages']);
    const number=++call;writes.push({conversationId:args.conversation_id,count:args.messages.length,number});
    if(failSecond&&number===2)throw new Error('network second sub-batch failure');
    const ids=args.messages.map((message:any)=>{stored.push({conversationId:args.conversation_id,...message});return 'row-'+stored.length;});
    afterWrite?.(number);return {inserted:args.messages.length,ids};
  },query:async(name:string)=>{
    assert.equal(name,'messages:existingMessageUuids');return [...existing];
  }};
  const realAdd=service.addMessages.bind(service);
  const sync:any=new Proxy({
    addMessages:(...args:Parameters<SyncServiceType['addMessages']>)=>{
      console.error('F3_SERVICE_INVOKE '+JSON.stringify({...sourceReceipt,count:args[0].messages.length,conversationId:args[0].conversationId}));
      const callback=args[1]?.onBatchAccepted;
      return realAdd(args[0],callback?{onBatchAccepted:(indexes:readonly number[])=>{acceptedIndexes.push([...indexes]);callback(indexes);}}:args[1]);
    },
    offloadImages:service.offloadImages.bind(service),
    createConversation:async(p:any)=>{if(failCreate)throw new Error('network create outage');return 'conv-'+p.sessionId;},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={getPendingOperations:()=>operations,hasPendingConversation:()=>false,add:(type:string,params:any)=>{operations.push({id:'q-'+operations.length,type,params});return operations.at(-1).id;}};
  const line=JSON.stringify({type:'assistant',timestamp:'2026-09-05T12:00:00Z',message:{content:'identical accepted occurrence'}})+'\n';
  const run=(file:string,id:string)=>d.processSessionFile(file,id,home,sync,'fixture-user',undefined,cache,queue,pending,{},()=>{});
  const receipts=(id:string)=>[...internal.acceptedPending.values()].flatMap((m:any)=>[...m.values()]).filter((row:any)=>row.sessionId===id);
  const source=(id:string)=>{const file=path.join(home,id+'.jsonl');fs.writeFileSync(file,line.repeat(30));return file;};
  for(const kind of process.env.F3_FIXTURE_SUB_BATCH_PATH?[process.env.F3_FIXTURE_SUB_BATCH_PATH]:['direct','pending']){
    const id='sub-batch-'+kind,file=source(id),conversationId='conv-'+id;
    call=0;afterWrite=undefined;failSecond=true;failCreate=kind==='pending';
    if(kind==='direct')cache[id]=conversationId;
    else {await assert.rejects(run(file,id));assert.equal(pending[id].length,30);failCreate=false;cache[id]=conversationId;}
    const beforeIndexes=acceptedIndexes.length;
    if(kind==='direct')await assert.rejects(run(file,id));
    else assert.equal(await d.flushPendingTranscript(pending,id,conversationId,cache,sync,queue),false);
    const owner={...internal.acceptedPendingOwners.get(id)},partialCount=receipts(id).length;
    console.error('F3_SUB_BATCH_PARTIAL '+JSON.stringify({kind,position:getPosition(file),owner,partialCount,writes:writes.filter(row=>row.conversationId===conversationId)}));
    assert.equal(getPosition(file),0);assert.equal(stored.filter(row=>row.conversationId===conversationId).length,25);
    failSecond=false;await run(file,id);
    assert.equal(stored.filter(row=>row.conversationId===conversationId).length,30,'known accepted sub-batch must not resend UUID-less rows');
    assert.equal(partialCount,25);assert.equal(owner.count,25);assert.equal(owner.reserved,0);assert.equal(owner.reservedBytes,0);assert.ok(owner.bytes>0);
    assert.deepEqual(acceptedIndexes[beforeIndexes],Array.from({length:25},(_,i)=>i));
    assert.equal(getPosition(file),fs.statSync(file).size);assert.equal(receipts(id).length,0);assert.equal(internal.acceptedPendingOwners.has(id),false);assert.equal(pending[id],undefined);
    assert.equal(operations.filter(row=>row.type==='addMessages').length,0);
  }
  for(const kind of ['mapping','deadline','source-stat']){
    const id='sub-batch-late-'+kind,file=source(id),conversationId='conv-'+id;cache[id]=conversationId;call=0;failSecond=false;
    const stat=fs.promises.stat.bind(fs.promises);
    afterWrite=number=>{
      if(number!==2)return;
      if(kind==='mapping')cache[id]='replacement-'+id;
      if(kind==='deadline')(currentTranscriptDeadline() as any).end=performance.now()-1;
      if(kind==='source-stat')fs.promises.stat=(async(...args:any[])=>{if(String(args[0])===file)throw Object.assign(new Error('source stat failed after accepted sub-batch'),{code:'EIO'});return (stat as any)(...args);}) as typeof fs.promises.stat;
    };
    try{await assert.rejects(run(file,id));}finally{fs.promises.stat=stat;afterWrite=undefined;}
    assert.equal(getPosition(file),0);assert.equal(receipts(id).length,30);assert.equal(internal.acceptedPendingOwners.get(id).reserved,0);
    cache[id]=conversationId;await run(file,id);assert.equal(stored.filter(row=>row.conversationId===conversationId).length,30);assert.equal(receipts(id).length,0);
  }
  const accounting=internal.receiptAccounting(),id='subset-accounting';
  const entries=[0,1,2].map(i=>({key:'key-'+i,signature:'signature-'+i,file:path.join(home,'accounting.jsonl'),identity:'owned',size:0}));
  const reserve=internal.reserveTranscriptReceipts(id,'conv-accounting',[entries[0],undefined,entries[1],entries[0],entries[2]]);assert.ok(reserve);
  const initial={...internal.acceptedPendingOwners.get(id)};assert.equal(initial.reserved,3);
  reserve.accept([]);assert.equal(internal.acceptedPendingOwners.get(id).count,0);
  reserve.accept([0,1,3,0]);const one={...internal.acceptedPendingOwners.get(id)};
  assert.equal(one.count,1);assert.equal(one.reserved,2);assert.equal(one.bytes+one.reservedBytes,initial.reservedBytes);
  reserve.accept([2]);const two={...internal.acceptedPendingOwners.get(id)};assert.equal(two.count,2);assert.equal(two.reserved,1);
  reserve.release();reserve.release();reserve.accept([4]);const released=internal.acceptedPendingOwners.get(id);
  assert.equal(released.count,2);assert.equal(released.reserved,0);assert.equal(released.reservedBytes,0);
  const after=internal.receiptAccounting();assert.equal(after.count-accounting.count,2);assert.equal(after.reserved,accounting.reserved);assert.equal(after.reservedBytes,accounting.reservedBytes);
  const messages=Array.from({length:30},(_,i)=>({messageUuid:i%3===0?'uuid-'+i:undefined,role:'assistant' as const,content:'index-'+i,timestamp:1}));
  existing=new Set(messages.flatMap(message=>message.messageUuid?[message.messageUuid]:[]));const batches:number[][]=[];call=0;
  await service.addMessages({conversationId:'index-gaps',messages,reconcileRemoteExisting:true},{onBatchAccepted:(indexes:readonly number[])=>batches.push([...indexes])});
  assert.deepEqual(batches,[Array.from({length:30},(_,i)=>i).filter(i=>i%3!==0)]);
  const empty:number[][]=[];await service.addMessages({conversationId:'index-empty',messages:[]},{onBatchAccepted:(indexes:readonly number[])=>empty.push([...indexes])});assert.deepEqual(empty,[]);
  const unknown:number[][]=[];service.client.mutation=async()=>{throw new Error('network response unknown');};
  await assert.rejects(service.addMessages({conversationId:'unknown',messages:[messages[1]]},{onBatchAccepted:(indexes:readonly number[])=>unknown.push([...indexes])}));assert.deepEqual(unknown,[]);
  return {realService:true,directPending:true,acceptedSubset:25,lateFences:3,accounting:true,reconcileIndexes:true,unknownNoReceipt:true};
}
