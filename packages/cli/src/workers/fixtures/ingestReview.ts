import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {SyncService} from '../../syncService.js';
const backend=path.resolve(import.meta.dir,'../../../../convex/convex');
const {create}=await import(path.join(backend,'tasks.ts'));
const {makeFakeDb}=await import(path.join(backend,'testDb.ts'));
const {hashToken}=await import(path.join(backend,'apiTokens.ts'));
export async function taskReplay(f:any) {
  const {d,home,getPosition,claudeLine}=f;
  const tables:any={users:[{_id:'users_fixture'}],api_tokens:[{_id:'api_tokens_fixture',user_id:'users_fixture',token_hash:await hashToken('fixture-token')}],tasks:[],conversations:[],counters:[]};
  const ctx={db:makeFakeDb(tables),scheduler:{runAfter:async()=>null},runMutation:async()=>null};
  const calls:any[]=[],sent:any[]=[],updates:any[]=[],pending:any={},cache:any={};
  let taskFailure:'before'|'after'|undefined,primaryFailure=false,swapDuringTask=false;
  const taskService:any={apiToken:'fixture-token',throttle:async()=>{},guarded:async(run:()=>Promise<unknown>)=>run(),mutate:async(name:string,args:any)=>{
    assert.equal(name,'tasks:create');calls.push(args);
    if(taskFailure==='before')throw new Error('task before commit');
    const result=await create._handler(ctx,args);
    if(swapDuringTask){swapDuringTask=false;cache[args.conversation_id]='replacement-conversation';}
    if(taskFailure==='after')throw new Error('task response lost');
    return result;
  }};
  const sync:any=new Proxy({
    syncTaskFromPlanMode:(p:any)=>SyncService.prototype.syncTaskFromPlanMode.call(taskService,p),
    updateTaskStatus:async(...args:any[])=>{updates.push(args);},
    offloadImages:async()=>{},
    addMessages:async(p:any)=>{sent.push(p);if(primaryFailure)throw new Error('primary outage');return {ids:p.messages.map((_:any,i:number)=>String(i))};},
  },{get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={hasPendingConversation:()=>false,getPendingOperations:()=>[],add:()=> 'memory-only'};
  const setup=(id:string)=>{
    const p=path.join(home,id+'.jsonl');cache[id]='conversations_'+id;
    tables.conversations.push({_id:cache[id],session_id:id,user_id:'users_fixture',status:'active'});
    fs.writeFileSync(p,claudeLine(id+'-primary','task fixture primary')+JSON.stringify({type:'assistant',uuid:id+'-assistant',message:{role:'assistant',content:[{type:'tool_use',id:id+'-one',name:'TaskCreate',input:{subject:'Identical task'}},{type:'tool_use',id:id+'-two',name:'TaskCreate',input:{subject:'Identical task'}},{type:'tool_use',id:id+'-update',name:'TaskUpdate',input:{taskId:'2',status:'in_progress'}}]}})+'\n');
    return p;
  };
  const run=(p:string,id:string)=>d.processSessionFile(p,id,home,sync,'users_fixture',undefined,cache,queue,pending,{},()=>{});
  const a=setup('tasks-before');taskFailure='before';
  await assert.rejects(run(a,'tasks-before'),/unresolved TaskCreate/);
  await assert.rejects(run(a,'tasks-before'),/unresolved TaskCreate/);
  assert.equal(tables.tasks.length,0);assert.equal(getPosition(a),0);assert.equal(calls[0].client_key,calls[1].client_key);assert.equal(sent.length,0);
  taskFailure=undefined;primaryFailure=true;
  await assert.rejects(run(a,'tasks-before'),/retains unread/);
  const afterTasks=calls.length;
  await assert.rejects(run(a,'tasks-before'),/retains unread/);
  assert.equal(calls.length,afterTasks);assert.equal(tables.tasks.length,2);assert.equal(getPosition(a),0);
  assert.equal(updates.at(-1)[0],tables.tasks[1].short_id);
  primaryFailure=false;await run(a,'tasks-before');assert.equal(tables.tasks.length,2);assert.equal(getPosition(a),fs.statSync(a).size);
  const b=setup('tasks-lost');taskFailure='after';
  await assert.rejects(run(b,'tasks-lost'),/unresolved TaskCreate/);assert.equal(getPosition(b),0);assert.equal(tables.tasks.length,3);
  const lostKey=calls.at(-1).client_key,oldInode=fs.statSync(b).ino;
  fs.writeFileSync(b+'.replacement',fs.readFileSync(b));fs.renameSync(b+'.replacement',b);assert.notEqual(fs.statSync(b).ino,oldInode);
  taskFailure=undefined;await run(b,'tasks-lost');assert.equal(tables.tasks.length,4);assert.equal(getPosition(b),fs.statSync(b).size);
  const lostCalls=calls.filter(c=>c.conversation_id==='conversations_tasks-lost');
  assert.equal(lostCalls[1].client_key,lostKey);assert.notEqual(lostCalls[2].client_key,lostKey);
  assert.equal(updates.at(-1)[0],tables.tasks[3].short_id);
  const legacyId='tasks-legacy',legacy=path.join(home,legacyId+'.jsonl');cache[legacyId]='conversations_legacy';
  d.fixtureReview.planModeTaskMap.set(legacyId,{'1':'ct-existing-one','2':'ct-existing-two'});
  fs.writeFileSync(legacy,JSON.stringify({type:'assistant',uuid:'legacy-update',message:{role:'assistant',content:[{type:'tool_use',id:'legacy-tool',name:'TaskUpdate',input:{taskId:'2',status:'completed'}}]}})+'\n');
  const legacyCreates=calls.length;await run(legacy,legacyId);assert.equal(calls.length,legacyCreates);assert.equal(updates.at(-1)[0],'ct-existing-two');
  const c=setup('tasks-map-swap');swapDuringTask=true;
  await assert.rejects(run(c,'tasks-map-swap'),/conversation mapping changed/);assert.equal(getPosition(c),0);assert.equal(cache['tasks-map-swap'],'replacement-conversation');assert.equal(d.fixtureReview.planModeTaskMap.has('tasks-map-swap'),false);
  cache['tasks-map-swap']='conversations_tasks-map-swap';await run(c,'tasks-map-swap');assert.equal(tables.tasks.length,6);assert.equal(getPosition(c),fs.statSync(c).size);
  assert.ok(calls.every(call=>/^transcript-task:[a-f0-9]{64}$/.test(call.client_key)));
  const flags=path.join(home,'one-shot-flags.jsonl'),id='one-shot-flags';cache[id]='conversations_flags';
  fs.writeFileSync(flags,claudeLine('permission-answer','y')+JSON.stringify({type:'user',uuid:'image-result',timestamp:'2026-09-05T12:00:00Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'image-tool',content:'[result unavailable]'}]}})+'\n');
  fs.writeFileSync(flags+'.bak',JSON.stringify({type:'user',uuid:'image-result',message:{role:'user',content:[{type:'tool_result',tool_use_id:'image-tool',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'aW1hZ2U='}}]}]}})+'\n');
  d.fixtureReview.permissionJustResolved.add(id);primaryFailure=true;
  for(let i=0;i<2;i++){
    await assert.rejects(run(flags,id),/retains unread/);
    assert.equal(getPosition(flags),0);assert.equal(d.fixtureReview.permissionJustResolved.has(id),true);assert.equal(d.fixtureReview.bakImageRecoveryDone.has(flags),false);
    assert.ok(sent.at(-1).messages.some((m:any)=>m.images?.length===1));assert.ok(sent.at(-1).messages.every((m:any)=>m.content!=='y'));
  }
  primaryFailure=false;await run(flags,id);assert.equal(getPosition(flags),fs.statSync(flags).size);assert.equal(d.fixtureReview.permissionJustResolved.has(id),false);assert.equal(d.fixtureReview.bakImageRecoveryDone.has(flags),true);
  return {backend:true,unknownBefore:true,lostResponse:true,nativeReplacement:true,legacyUpdate:true,numericUpdate:true,mappingFence:true,oneShotReplay:true};
}
