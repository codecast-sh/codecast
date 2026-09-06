import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { WorkerUnavailable } from '../host.js';
import { ingestIdentity, readTranscriptIngest } from '../ingestClient.js';
import { ingestWorkerHost, closeDaemonWorkers } from '../bridge.js';
import { INGEST_PAGE_BYTES, INGEST_PAGE_TOKENS } from '../ingestTypes.js';
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
export async function adversarial(f:any) {
  const {file,claude,claudeLine,codex,rows,sends,getPosition,setPosition,parseClaude,parseCodex,reconfigure,allowFallback} = f;
  const receipt:any = {checks:[],maxPageBytes:0,maxPageTokens:0,maxLoopDelayMs:0};
  const measured = () => {
    const host=ingestWorkerHost()!,request=host.request.bind(host);
    host.request=(async (...args:Parameters<typeof request>)=>{
      const result:any=await request(...args);
      if (args[0]==='ingest') {
        receipt.maxPageBytes=Math.max(receipt.maxPageBytes,Buffer.byteLength(JSON.stringify(result)));
        receipt.maxPageTokens=Math.max(receipt.maxPageTokens,result.tokens.length);
      }
      return result;
    }) as typeof host.request;
    return host;
  };
  measured();
  const giant='A'.repeat(18*1024*1024),emoji='x'.repeat(8191)+'🫠'+ 'y'.repeat(8191)+'🧑‍💻';
  const largeText=JSON.stringify({type:'user',uuid:'f3-large-image',timestamp:'2026-09-05T12:00:00.000Z',message:{role:'user',content:[{type:'text',text:emoji},{type:'image',source:{type:'base64',media_type:'image/png',data:giant}}]}})+'\n';
  const large=file('large-image',largeText);
  let previous=performance.now();
  const tick=setInterval(()=>{const now=performance.now();receipt.maxLoopDelayMs=Math.max(receipt.maxLoopDelayMs,now-previous);previous=now;},2);
  try { await claude(large,'large-image'); await delay(5); } finally { clearInterval(tick); }
  assert.equal(rows.get('f3-large-image').images[0].data,giant);assert.equal(getPosition(large),Buffer.byteLength(largeText));
  assert.ok(receipt.maxLoopDelayMs<1000,JSON.stringify(receipt));
  const tools=JSON.stringify({type:'assistant',uuid:'nested-tool',timestamp:'2026-09-05T12:00:00.000Z',message:{role:'assistant',model:'fixture-model',content:[{type:'thinking',thinking:'reason'},{type:'tool_use',id:'nested-id',name:'fixture_tool',input:{nested:{emoji,payload:giant}}}]}})+'\n'+JSON.stringify({type:'user',uuid:'nested-result',timestamp:'2026-09-05T12:00:00.000Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'nested-id',content:[{type:'text',text:emoji}]}]}})+'\n';
  const toolFile=file('large-tools',tools),parsed=await readTranscriptIngest({client:'claude',file:toolFile,sessionId:'large-tools',offset:0});
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.messages)),JSON.parse(JSON.stringify(parseClaude(tools))));
  await claude(toolFile,'large-tools');assert.equal(rows.get('nested-tool').toolCalls[0].input.nested.payload,giant);
  assert.ok(receipt.maxPageBytes<=INGEST_PAGE_BYTES);assert.ok(receipt.maxPageTokens<=INGEST_PAGE_TOKENS);
  receipt.checks.push('18MiB image/tool records; emoji fragment splits; nested tool/result parity');
  const setup='<recommended_plugins>\nAvailable plugins\n</recommended_plugins>\n# AGENTS.md instructions for /repo\n<INSTRUCTIONS>Rules</INSTRUCTIONS>\n<environment_context>cwd</environment_context>';
  const entry=(text:string)=>JSON.stringify({type:'response_item',timestamp:'2026-09-05T00:55:01Z',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}})+'\n';
  const guardText=entry(setup)+entry('ordinary native user after imported context'),guardFile=file('agent-context-guard',guardText);
  const guarded=await readTranscriptIngest({client:'codex',file:guardFile,sessionId:'agent-context-guard',offset:0});assert.deepEqual(guarded.messages.map(m=>m.content),['ordinary native user after imported context']);await codex(guardFile,'agent-context-guard');
  const backupPrimary=JSON.stringify({type:'user',uuid:'backup-result',timestamp:'2026-09-05T12:00:00Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'backup-tool',content:'[result unavailable]'}]}})+'\n';
  const backup=file('backup-recovery',backupPrimary);
  fs.writeFileSync(backup+'.bak',JSON.stringify({type:'user',uuid:'backup-result',timestamp:'2026-09-05T12:00:00Z',message:{role:'user',content:[{type:'tool_result',tool_use_id:'backup-tool',content:[{type:'image',source:{type:'base64',media_type:'image/png',data:'QUJD'}}]}]}})+'\n');
  await claude(backup,'backup-recovery');assert.equal(rows.get('backup-result').images[0].data,'QUJD');receipt.checks.push('agent-context guard and backup image recovery in worker');

  const base=file('incomplete-large',claudeLine('complete-first','retained first'));
  const original=fs.statSync(base).size;
  fs.appendFileSync(base,largeText.slice(0,-1));await claude(base,'incomplete-large');assert.equal(getPosition(base),original);
  fs.appendFileSync(base,'\n');await claude(base,'incomplete-large');assert.equal(getPosition(base),fs.statSync(base).size);
  receipt.checks.push('oversized incomplete record remains unconsumed until newline');
  const meta=(id:string,model:string)=>JSON.stringify({type:'session_meta',payload:{id,cwd:f.home,originator:'codex_cli_rs',source:'cli'}})+'\n'+JSON.stringify({type:'turn_context',payload:{model}})+'\n';
  const answer=(text:string)=>JSON.stringify({type:'response_item',timestamp:'2026-09-05T12:00:00.000Z',payload:{type:'message',role:'assistant',content:[{type:'output_text',text}]}})+'\n';
  const id='sameprefix-01a06e04-full-unregistered',history=meta(id,'before-history')+answer('imported-history '+ 'i'.repeat(2*1024*1024))+JSON.stringify({type:'turn_context',payload:{model:'after-history'}})+'\n'+answer('new native TUI tail');
  const historyFile=file(id,history);await codex(historyFile,id);assert.equal(getPosition(historyFile),Buffer.byteLength(history));
  assert.ok([...rows.values()].some((m:any)=>m.content==='new native TUI tail'&&m.model==='after-history'));
  const offset=Buffer.byteLength(history);fs.appendFileSync(historyFile,answer('tail after worker restart'));reconfigure();measured();
  await codex(historyFile,id);assert.ok([...rows.values()].some((m:any)=>m.content==='tail after worker restart'&&m.model==='after-history'));
  const cold=await readTranscriptIngest({client:'codex',file:historyFile,sessionId:id,offset});assert.equal(cold.messages[0].model,'after-history');
  const sibling=file('sameprefix-other-full',meta('sameprefix-other-full','different-model')+answer('independent sibling'));
  await codex(sibling,'sameprefix-other-full');assert.ok([...rows.values()].some((m:any)=>m.content==='independent sibling'&&m.model==='different-model'));
  receipt.checks.push('unregistered full-ID TUI; large imported-like history; tail and model across passes/restart; prefix sibling');
  for (const fault of ['before','after','sequence','generation','replace','close'] as const) {
    reconfigure();const host=measured(),request=host.request.bind(host);
    const id='fault-'+fault,p=file(id,claudeLine(id,'z'.repeat(400*1024))),start=sends.length;
    let injected=false;
    host.request=(async (...args:Parameters<typeof request>)=>{
      if (args[0]!=='ingest'||injected) return request(...args);
      injected=true;
      if (fault==='before') {
        const pending=request(...args);const pid=host.state.pid;assert.ok(pid&&pid!==process.pid);process.kill(pid,'SIGKILL');return pending;
      }
      const page:any=await request(...args);
      if (fault==='after') {process.kill(host.state.pid!,'SIGKILL');throw new WorkerUnavailable('fixture owned worker died after page');}
      if (fault==='sequence') return {...page,sequence:page.sequence+1};
      if (fault==='generation') return {...page,generation:'unrelated-generation'};
      if (fault==='replace') {fs.writeFileSync(p+'.new',claudeLine(id,'successor content'));fs.renameSync(p+'.new',p);}
      if (fault==='close') closeDaemonWorkers();
      return page;
    }) as typeof host.request;
    await assert.rejects(claude(p,id));assert.equal(getPosition(p),0);assert.equal(sends.length,start);
    reconfigure();await claude(p,id);assert.equal(getPosition(p),fs.statSync(p).size);assert.equal(sends.length,start+1);
    receipt.checks.push('production retry '+fault);
  }
  reconfigure();const timeoutHost=measured();await timeoutHost.request('ping',null);
  const timeoutRequest=timeoutHost.request.bind(timeoutHost),timeoutFile=file('timeout',claudeLine('timeout','r'.repeat(400*1024)));
  timeoutHost.request=((op:any,payload:any,opts:any)=>timeoutRequest(op,payload,{...opts,timeoutMs:1})) as typeof timeoutHost.request;
  await assert.rejects(claude(timeoutFile,'timeout'));assert.equal(getPosition(timeoutFile),0);
  reconfigure();await claude(timeoutFile,'timeout');assert.equal(getPosition(timeoutFile),fs.statSync(timeoutFile).size);receipt.checks.push('production deadline then retry');
  reconfigure();const cancelHost=measured(),cancelRequest=cancelHost.request.bind(cancelHost),abort=new AbortController();let cancelled=false,closes=0;
  cancelHost.request=(async (...args:Parameters<typeof cancelRequest>)=>{
    const page:any=await cancelRequest(...args);
    if ((args[1] as any)?.action==='close') closes++;
    else if(args[0]==='ingest'&&!cancelled) {cancelled=true;abort.abort();}
    return page;
  }) as typeof cancelHost.request;
  await assert.rejects(readTranscriptIngest({client:'claude',file:large,sessionId:'cancel',offset:0},{signal:abort.signal}));assert.equal(closes,1);
  const cursors:any[]=[];
  try {
    for(let n=0;n<4;n++) cursors.push(await cancelHost.request('ingest',{action:'open',job:{client:'claude',file:timeoutFile,sessionId:'cursor-'+n,generation:'cursor-generation-'+n,identity:ingestIdentity(fs.statSync(timeoutFile)),offset:0}}));
    await assert.rejects(cancelHost.request('ingest',{action:'open',job:{client:'claude',file:timeoutFile,sessionId:'overflow',generation:'overflow-generation',identity:ingestIdentity(fs.statSync(timeoutFile)),offset:0}}));
  } finally { for(const c of cursors) await cancelHost.request('ingest',{action:'close',cursor:c.cursor,generation:c.generation,sequence:1}); }
  receipt.checks.push('cancel after page explicitly closes cursor; four cursor bound');
  reconfigure();const smallHost=measured(),smallRequest=smallHost.request.bind(smallHost),small=file('fallback-small',meta('fallback-small','fallback-model')+answer('bounded local fallback'));
  let killed=false;
  smallHost.request=(async (...args:Parameters<typeof smallRequest>)=>{
    const pending=smallRequest(...args);
    if(args[0]==='ingest'&&!killed) {killed=true;process.kill(smallHost.state.pid!,'SIGKILL');}
    return pending;
  }) as typeof smallHost.request;
  allowFallback(true);try {await codex(small,'fallback-small');} finally {allowFallback(false);}
  assert.equal(getPosition(small),fs.statSync(small).size);assert.ok([...rows.values()].some((m:any)=>m.content==='bounded local fallback'));receipt.checks.push('small transport failure bounded local fallback');
  reconfigure();
  const modelLine=JSON.stringify({type:'turn_context',payload:{model:'model-🫠-split'}})+'\n';
  const modelBytes=Buffer.from(modelLine),splitAt=modelBytes.indexOf(Buffer.from('🫠'))+1;
  const suffixBytes=65536-(modelBytes.length-splitAt);
  const modelPrefix=modelLine+' '.repeat(suffixBytes-1)+'\n';
  const modelFile=file('split-model',modelPrefix+answer('model split tail'));
  const modelResult=await readTranscriptIngest({client:'codex',file:modelFile,sessionId:'split-model',offset:Buffer.byteLength(modelPrefix)});
  assert.equal(modelResult.messages[0].model,'model-🫠-split');receipt.checks.push('restart model UTF-8 split before offset');
  const limited=file('resource-limit','');fs.truncateSync(limited,129*1024*1024);
  await assert.rejects(readTranscriptIngest({client:'gemini',file:limited,sessionId:'resource-limit',offset:0}));assert.equal(getPosition(limited),0);receipt.checks.push('explicit whole-source resource rejection leaves position unchanged');
  receipt.workerPid=ingestWorkerHost()!.state.pid;return receipt;
}
