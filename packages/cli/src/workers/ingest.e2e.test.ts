import {test,expect} from 'bun:test';
import {loadScaledMs} from '../test-helpers/machineLoad.js';
import {productionHome,runProduction,resultRow,releaseProductionHome} from './fixtures/productionRun.js';

// Runs the fixture with `args` in a scratch HOME of its own and hands `check`
// the run, then waits out the fixture's processes and removes the HOME.
async function production(prefix:string,args:string[],check:(run:ReturnType<typeof runProduction>)=>Promise<void>,opts?:Parameters<typeof runProduction>[2]) {
  const home=productionHome(prefix);
  try{await check(runProduction(home,args,opts));}
  finally{await releaseProductionHome(home.root);}
}
const failure=(run:ReturnType<typeof runProduction>)=>run.then(()=>null,error=>error);

for (const enabled of [false,true]) test(`production transcript file attachments and plain messages worker=${enabled}`,()=>production('f3-files-',[String(enabled),'files'],async run=>{
  const row=resultRow((await run).stdout);
  expect(row.files).toBe(true);expect(row.messages).toBe(3);expect(row.positions).toBe(true);
  if(enabled)expect(row.parentParses).toBe(0);
}),loadScaledMs(70_000));

for (const enabled of [false,true]) test(`actual production transcript ingestion worker=${enabled}`,()=>production('f3-ingest-',[String(enabled)],async run=>{
  const row=resultRow((await run).stdout);expect(row.production).toBe(true);expect(row.serialized).toBe(true);expect(row.positions).toBe(true);expect(row.queued).toBe(true);expect(row.formats).toBe(8);if(enabled)expect(row.parentParses).toBe(0);
}),loadScaledMs(70_000));

test('metadata failure control rejects the former consume-before-send behavior',()=>production('f3-mutant-',['true','mutant'],async run=>{
  const error=await failure(run);
  expect(error).not.toBeNull();expect(error.stderr).toContain('metadata failure skipped primary messages');
},{timeoutMs:30_000}),loadScaledMs(40_000));

test('actual production adversarial transport and failure retry controls',()=>production('f3-adversarial-',['true','adversarial'],async run=>{
  const row=resultRow((await run).stdout);expect(row.adversarial.checks.length).toBeGreaterThanOrEqual(12);expect(row.parentParses).toBe(0);expect(row.fallbackParses).toBeGreaterThan(0);expect(row.adversarial.maxLoopDelayMs).toBeLessThan(1000);console.log(JSON.stringify(row));
},{timeoutMs:90_000,maxBuffer:3*1024*1024}),loadScaledMs(100_000));

for(const mode of ['custody','custody-mutant','retry-mutant']) test(`actual production pending custody ${mode}`,()=>production('f3-custody-',['true',mode],async run=>{
  if(mode!=='custody') {const error=await failure(run);expect(error).not.toBeNull();expect(error.stderr).toContain(mode==='custody-mutant'?'old pending return contract dropped unresolved data':'old return-success contract prevents unchanged-file retry');}
  else {const row=resultRow((await run).stdout);expect(row.custody.checks).toBe(14);expect(row.custody.failedPersistenceRetainsTranscript).toBe(true);expect(row.custody.uuidlessDistinct).toBe(true);console.log(JSON.stringify(row));}
},{maxBuffer:3*1024*1024}),loadScaledMs(70_000));

for(const enabled of [false,true]) test(`production full-ID app-server skip and lineage worker=${enabled}`,()=>production('f3-registration-',[String(enabled),'registration'],async run=>{
  const row=resultRow((await run).stdout);expect(row.registration).toEqual({live:true,persisted:true,pendingFork:true,fullIdSibling:true,lineageSuppressed:true});
}),loadScaledMs(70_000));

for(const enabled of [false,true]) for(const mode of ['ack','ack-mutant']) test(`actual production queued reread ACK ${mode} worker=${enabled}`,()=>production('f3-ack-',[String(enabled),mode],async run=>{
  if(mode==='ack-mutant'){const error=await failure(run);expect(error).not.toBeNull();expect(error.stderr).toContain('queued reread must not ACK a newer prompt');}
  else{const row=resultRow((await run).stdout);expect(row.ack.backendPositive).toBe(true);expect(row.ack.queueExecutor).toBe(true);console.log(JSON.stringify(row));}
},{maxBuffer:3*1024*1024}),loadScaledMs(70_000));
