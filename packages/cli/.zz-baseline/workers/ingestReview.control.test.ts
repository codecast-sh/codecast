import {test,expect} from 'bun:test';
import path from 'node:path';
import {loadScaledMs} from '../test-helpers/machineLoad.js';
import {productionHome,runProduction,settled,records,releaseProductionHome,mutantCopy} from './fixtures/productionRun.js';

for(const enabled of [false,true])test(`physical TaskCreate occurrence mutation fails actual backend replacement control worker=${enabled}`,async()=>{
  const home=productionHome('f3-review-control-');
  const receipts=()=>records(home.root,/^producer-\d+\.json$/);
  try{
    const mutation=mutantCopy(home.root,path.join(import.meta.dir,'ingestJobs.ts'),'const native = nativeIds.every','const native = false && nativeIds.every','ingestJobs-physical.ts');
    const producer=mutation.file,scratchSha256=mutation.scratchSha256;
    const result=await settled(runProduction(home,[String(enabled),'task-review'],{env:{F3_FIXTURE_PHYSICAL_TASKKEY:'1',F3_FIXTURE_INGEST_PRODUCER:producer},timeoutMs:30_000}));
    const controls=receipts(),invocations=records(home.root,/^invocations-\d+\.jsonl$/,{lines:true});
    console.log(JSON.stringify({enabled,productionSha256:mutation.originalSha256,scratchSha256,outcome:result,controls,invocations}));
    expect(result.ok).toBe(false);expect(result.stderr).toContain('AssertionError');expect(result.stderr).toContain('5 !== 4');
    expect(invocations.length).toBeGreaterThan(0);expect(invocations.every(c=>c.sha256===scratchSha256&&c.producer===producer)).toBe(true);
    const supervisor=controls.find(c=>c.ppid===process.pid),invoked=new Set(invocations.map(c=>c.pid));expect(supervisor).toBeDefined();
    expect(invoked.size).toBe(1);expect(invoked.has(supervisor.pid)).toBe(!enabled);
    expect(controls.length).toBe(enabled?2:1);expect(controls.every(c=>c.sha256===scratchSha256&&c.producer===producer)).toBe(true);
    console.log(JSON.stringify({enabled,expectedFailure:'5 !== 4',productionSha256:mutation.originalSha256,scratchSha256,controls}));
  }finally{await releaseProductionHome(home.root,receipts().map(c=>c.pid));}
},loadScaledMs(40_000));
