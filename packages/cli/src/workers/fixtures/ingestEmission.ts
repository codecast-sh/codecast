import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { readTranscriptIngest, ingestRecord } from '../ingestClient.js';

export async function emissionReview(f:any) {
  const {d,home,getPosition,setPosition}=f,cache:any={},pending:any={},sent:any[]=[],operations:any[]=[];
  let createFails=true;
  const sync:any=new Proxy({createConversation:async()=>{if(createFails)throw new Error('emission create outage');return 'created';},offloadImages:async()=>{},addMessages:async(p:any)=>{sent.push(p);return {ids:p.messages.map((_:any,i:number)=>String(i))};}}, {get:(target,key)=>key in target?(target as any)[key]:async()=>true});
  const queue:any={getPendingOperations:()=>operations,hasPendingConversation:()=>false,add:(type:string,params:any)=>{operations.push({id:'q-'+operations.length,type,params});return operations.at(-1).id;}};
  const run=(client:string,file:string,id:string)=>client==='claude'?d.processSessionFile(file,id,home,sync,'user',undefined,cache,queue,pending,{},()=>{}):d.processGeminiSession(file,id,'hash',sync,'user',undefined,cache,queue,pending,{},()=>{});
  for(const client of (process.env.F3_FIXTURE_EMISSION_CLIENT?[process.env.F3_FIXTURE_EMISSION_CLIENT]:['claude','gemini']).filter(client=>client!=='cursorDb'))for(const changed of [false,true]){
    const id='emission-'+client+'-'+changed,file=path.join(home,id+'.jsonl');createFails=true;
    const records:any[]=client==='claude'?[
      {type:'summary',summary:'ignored 🐈'},
      {type:'assistant',message:{content:'identical 🐈'}},
      {type:'assistant',isMeta:true,message:{content:'filtered'}},
      {type:'assistant',message:{content:'identical 🐈'}},
      {type:'assistant',timestamp:'2026-09-05T12:00:00+00:00',message:{content:'native time',model:'fixture-model'}},
      {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool',content:[{type:'text',text:'nested result'},{type:'image',source:{media_type:'image/png',data:'aW1hZ2U='}}]}]}},
    ]:[
      {type:'info',content:'ignored 🐈'},
      {type:'gemini',content:'identical 🐈'},
      {type:'gemini',content:''},
      {type:'gemini',content:'identical 🐈'},
      {type:'gemini',timestamp:'2026-09-05T12:00:00+00:00',content:'native time',model:'fixture-model'},
      {type:'gemini',toolCalls:[{id:'one',name:'tool',args:{nested:{emoji:'🐈'}},status:'success',result:{nested:'result'}},{id:'two',name:'tool',status:'error',result:'failed'}]},
    ];
    const write=()=>fs.writeFileSync(file,client==='claude'?'\n'+records.map(row=>JSON.stringify(row)).join('\n')+'\n':JSON.stringify({messages:records}));write();
    await assert.rejects(run(client,file,id));await assert.rejects(run(client,file,id));assert.equal(getPosition(file),0);assert.equal(pending[id].length,4);assert.equal(operations.filter(op=>op.type==='addMessages').length,0);
    const before=sent.length;cache[id]='conv-'+id;createFails=false;
    assert.equal(await d.flushPendingTranscript(pending,id,cache[id],cache,sync,queue),true);assert.equal(sent.length,before+1);assert.equal(sent.at(-1).messages.filter((m:any)=>m.content==='identical 🐈').length,2);
    if(changed){records[4].timestamp='2026-09-05T08:00:00-04:00';write();}
    await new Promise(resolve=>setTimeout(resolve,20));await run(client,file,id);
    assert.equal(sent.length,before+(changed?2:1),'known receipt must not resend generated timestamp occurrences');
    if(changed){assert.equal(sent.at(-1).messages.length,1);assert.equal(sent.at(-1).messages[0].content,'native time');}
    if(client==='claude')assert.equal(getPosition(file),fs.statSync(file).size);else assert.equal(d.fixtureCustody.geminiSyncedCounts.get(file),4);
  }
  if(!process.env.F3_FIXTURE_EMISSION_CLIENT||process.env.F3_FIXTURE_EMISSION_CLIENT==='cursorDb')for(const change of ['none','native','content','rawFact']){
    const id='cursor-emission-'+change,file=path.join(home,id+'.vscdb');
    const prefix={tabId:'prefix',bubbles:[{type:'user',id:id+'-prefix-user',initText:'prefix user'},{type:'ai',id:id+'-prefix-ai',rawText:'prefix assistant'}]};
    const user:any={type:'user',initText:'native user',contextCacheTimestamp:1_700_000_000_000};
    const fact:any={type:'ai',rawText:'native fact',contextCacheTimestamp:0};
    const duplicate:any={type:'ai',rawText:'identical 🐈'};
    const tabs:any[]=[prefix];
    const write=()=>{
      const db=new Database(file);
      try{db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY,value TEXT)');db.query('INSERT OR REPLACE INTO ItemTable (key,value) VALUES (?,?)').run('workbench.panel.aichat.view.aichat.chatdata',JSON.stringify({tabs}));}
      finally{db.close();}
    };
    const runCursor=()=>d.processCursorSession(file,id,home,sync,'user',undefined,cache,queue,pending,()=>{});
    createFails=false;cache[id]='conv-'+id;write();await runCursor();assert.equal(getPosition(file),2);
    delete cache[id];createFails=true;
    tabs.push({tabId:'ignored'},{tabId:'tail',bubbles:[{type:'ignored',rawText:'ignored'},{type:'user',initText:'generated user'},duplicate,{type:'ai',rawText:''},{...duplicate},user,{type:'ai',id:id+'-healthy-ai',rawText:'healthy ai'},fact]},{tabId:'invalid',bubbles:{}},{tabId:'last',bubbles:[{type:'user',initText:''},{type:'user',id:id+'-healthy-user',initText:'healthy user'}]});
    write();
    const full=await readTranscriptIngest({client:'cursorDb',file,sessionId:id,offset:0});
    await new Promise(resolve=>setTimeout(resolve,20));
    const tail=await readTranscriptIngest({client:'cursorDb',file,sessionId:id,offset:2});
    assert.equal(full.totalCount,9);assert.equal(tail.totalCount,9);assert.equal(full.maxRowId,tail.maxRowId);
    assert.deepEqual(tail.receiptOccurrences,[3,4,6,7,8,9,11]);
    assert.deepEqual(full.messages.slice(2).map(message=>ingestRecord(message)?.key),tail.messages.map(message=>ingestRecord(message)?.key));
    assert.notEqual(full.messages[2].timestamp,tail.messages[0].timestamp);
    assert.notEqual(ingestRecord(tail.messages[1])?.key,ingestRecord(tail.messages[2])?.key);
    assert.equal(tail.messages[4].uuid,id+'-healthy-ai');assert.equal(tail.messages[6].uuid,id+'-healthy-user');
    await assert.rejects(runCursor());await assert.rejects(runCursor());assert.equal(getPosition(file),2);assert.equal(pending[id].length,7);
    assert.equal(operations.filter(op=>op.type==='addMessages').length,0);
    cache[id]='conv-'+id;createFails=false;const before=sent.length;
    assert.equal(await d.flushPendingTranscript(pending,id,cache[id],cache,sync,queue),true);
    assert.equal(sent.at(-1).messages.filter((message:any)=>message.content==='identical 🐈').length,2);
    if(change==='native')user.contextCacheTimestamp++;
    if(change==='content')user.initText='changed native user';
    if(change==='rawFact')fact.contextCacheTimestamp='';
    if(change!=='none')write();
    await new Promise(resolve=>setTimeout(resolve,20));await runCursor();
    assert.equal(sent.length,before+(change==='none'?1:2),'known receipt must not resend generated timestamp occurrences');
    assert.deepEqual(full.messages.slice(2).map(message=>ingestRecord(message)?.signature),tail.messages.map(message=>ingestRecord(message)?.signature));
    if(change!=='none'){assert.equal(sent.at(-1).messages.length,1);assert.equal(sent.at(-1).messages[0].content,change==='rawFact'?'native fact':user.initText);}
    assert.equal(getPosition(file),9);assert.equal(pending[id],undefined);
  }
  const id='queued-window',file=path.join(home,id+'.jsonl');cache[id]='conv-'+id;
  const prefix=JSON.stringify({type:'assistant',timestamp:'2099-01-01T00:00:00Z',message:{content:'prior ordering 🐈'}})+'\n';
  const attachment=JSON.stringify({type:'attachment',attachment:{type:'queued_command',prompt:'identical attachment 🐈'}})+'\n';
  fs.writeFileSync(file,prefix+attachment+attachment);
  const full=await readTranscriptIngest({client:'claude',file,sessionId:id,offset:0}),start=Buffer.byteLength(prefix);
  const suffix=await readTranscriptIngest({client:'claude',file,sessionId:id,offset:start});
  assert.notEqual(full.messages[1].timestamp,suffix.messages[0].timestamp);
  assert.equal(ingestRecord(full.messages[1])?.key,ingestRecord(suffix.messages[0])?.key);
  assert.equal(ingestRecord(full.messages[1])?.signature,ingestRecord(suffix.messages[0])?.signature);
  assert.notEqual(ingestRecord(full.messages[1])?.key,ingestRecord(full.messages[2])?.key);
  const before=sent.length;await d.retainPendingTranscript(pending,id,full.messages,file,fs.statSync(file).size);
  assert.equal(await d.flushPendingTranscript(pending,id,cache[id],cache,sync,queue),true);assert.equal(sent.at(-1).messages.length,3);
  setPosition(file,start);await run('claude',file,id);assert.equal(getPosition(file),fs.statSync(file).size);assert.equal(sent.length,before+1,'known queued receipt must survive a shifted window');
  return {formats:3,clockReread:true,nativeTextChange:true,identicalOccurrences:true,filtered:true,toolsImages:true,queuedShiftedWindow:true,cursorDbCountWindow:true};
}
