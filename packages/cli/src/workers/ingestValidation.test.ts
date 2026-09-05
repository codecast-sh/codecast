import { expect, test } from 'bun:test';
import { IngestDeadline, IngestDeadlineExceeded, IngestCancelled } from './ingestDeadline.js';
import { validIngestPage, type IngestJob } from './ingestTypes.js';
import { validateIngestResult } from './ingestValidation.js';
import { IngestAssembler, ingestTokenPages } from './ingestTransport.js';

const job: IngestJob = {client:'claude',file:'/owned/source',sessionId:'full-session',generation:'generation',offset:0,identity:{dev:1,ino:2,birthtimeMs:3,ctimeMs:4,mtimeMs:5,size:100}};
const result = () => ({messages:[{role:'assistant' as const,content:'hello',timestamp:1}],bytesConsumed:100,fileSize:100,totalCount:1,maxRowId:0,signatures:['a'.repeat(64)],receiptSignatures:['b'.repeat(64)],receiptOccurrences:[0],messageTitles:[null],handoffParents:[null],metadata:{warnings:[]}});
test('one monotonic budget shrinks with every operation and refuses late completion',()=>{
  let now = 0;
  const deadline = new IngestDeadline(10,undefined,() => now);
  try {
    expect(deadline.remaining()).toBe(10);
    now=9; expect(deadline.remaining()).toBe(1);
    now=18; expect(()=>deadline.check()).toThrow(IngestDeadlineExceeded);
    expect(deadline.signal.aborted).toBe(true);
  } finally { deadline.dispose(); }
});
test('cancellation is distinct from expiry and empty final pages remain valid',()=>{
  const controller = new AbortController(), deadline = new IngestDeadline(100,controller.signal);
  try { controller.abort(); expect(()=>deadline.check()).toThrow(IngestCancelled); }
  finally { deadline.dispose(); }
  const page={cursor:'cursor',generation:'generation',sequence:0,tokens:[],done:false};
  expect(validIngestPage(page)).toBe(false);
  expect(validIngestPage({...page,done:true})).toBe(true);
});
test('shared schema enforces client counts, signatures, metadata and nested record types',async()=>{
  await expect(validateIngestResult(result(),job)).resolves.toEqual(result());
  for (const mutate of [
    (r:any)=>r.totalCount=0,
    (r:any)=>r.maxRowId=1,
    (r:any)=>r.signatures=[],
    (r:any)=>r.receiptSignatures=[],
    (r:any)=>r.receiptOccurrences=[],
    (r:any)=>r.receiptOccurrences=[100],
    (r:any)=>r.receiptOccurrences=[-1],
    (r:any)=>r.messages[0].uuid=17,
    (r:any)=>r.messages[0].toolCalls=[{id:'call',name:'tool',input:[]}],
    (r:any)=>r.messages[0].toolResults=[{toolUseId:'call',content:[]}],
    (r:any)=>r.messages[0].images=[{mediaType:'image/png',data:'a',localPath:'/both'}],
    (r:any)=>r.metadata.codex={source:{subagent:{thread_spawn:{depth:'invalid'}}}},
    (r:any)=>r.metadata.permissionPrompt={tool_name:'Bash'},
    (r:any)=>r.metadata.unexpected=true,
  ]) {
    const value=result(); mutate(value);
    await expect(validateIngestResult(value,job)).rejects.toThrow('schema');
  }
  const cursor={...result(),receiptOccurrences:[5],bytesConsumed:0,totalCount:3,maxRowId:9};
  await expect(validateIngestResult(cursor,{...job,client:'cursorDb',offset:2})).resolves.toEqual(cursor);
  await expect(validateIngestResult(cursor,{...job,client:'cursorDb',offset:1})).rejects.toThrow('schema');
  await expect(validateIngestResult({...cursor,receiptOccurrences:undefined},{...job,client:'cursorDb',offset:2})).rejects.toThrow('schema');
  await expect(validateIngestResult({...cursor,receiptOccurrences:[100]},{...job,client:'cursorDb',offset:2})).rejects.toThrow('schema');
});
test('local validation and transported validation refuse the same excessive nesting',async()=>{
  const value:any=result();
  let input:any={};
  for(let i=0;i<130;i++) input={nested:input};
  value.messages[0].toolCalls=[{id:'call',name:'tool',input}];
  await expect(validateIngestResult(value,job)).rejects.toThrow('nesting');
  const assembler=new IngestAssembler();
  await expect((async()=>{for await(const page of ingestTokenPages(value)) assembler.push(page);return assembler.finish();})()).rejects.toThrow('nesting');
});
test('schema validation yields and refuses a deadline expiring during validation',async()=>{
  let now=0;
  const deadline=new IngestDeadline(10,undefined,()=>now);
  const value:any=result();value.messages[0].content='x'.repeat(8192*3);
  setImmediate(()=>{now=11;});
  try { await expect(validateIngestResult(value,job,()=>deadline.check())).rejects.toThrow(IngestDeadlineExceeded); }
  finally { deadline.dispose(); }
});
