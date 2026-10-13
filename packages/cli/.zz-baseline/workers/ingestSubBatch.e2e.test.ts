import { test, expect } from 'bun:test';
import path from 'node:path';
import { loadScaledMs } from '../test-helpers/machineLoad.js';
import { productionHome, runProduction, settled, resultRow, records, releaseProductionHome, mutantCopy } from './fixtures/productionRun.js';

for(const scenario of [{mutant:false,kind:undefined},{mutant:true,kind:'direct'},{mutant:true,kind:'pending'}])for(const enabled of [false,true])test(`real service sub-batch custody worker=${enabled} mutant=${scenario.mutant} path=${scenario.kind??'all'}`,async()=>{
  const {mutant,kind}=scenario,home=productionHome('f3-sub-batch-');
  try{
    const mutation=mutant?mutantCopy(home.root,path.resolve(import.meta.dir,'../syncService.ts'),'if (onBatchAccepted) onBatchAccepted(batch.map(message => preparedIndexes!.get(message)!));','','syncService-no-sub-batch-receipt.ts'):undefined;
    const servicePath=mutation?.file;
    const outcome=await settled(runProduction(home,[String(enabled),'sub-batch-review'],{env:{F3_FIXTURE_SYNC_SERVICE:servicePath,F3_FIXTURE_SUB_BATCH_PATH:kind},timeoutMs:30_000}));
    const workerSources=records(home.root,/^worker-source-\d+\.json$/);
    console.log(JSON.stringify({enabled,mutant,kind,productionSha256:mutation?.originalSha256,scratchSha256:mutation?.scratchSha256,outcome,workerSources}));
    expect(outcome.stderr).toContain('F3_DAEMON_SOURCE ');expect(outcome.stderr).toContain('F3_SERVICE_INVOKE ');
    if(mutation){
      expect(outcome.ok).toBe(false);expect(outcome.stderr).toContain('known accepted sub-batch must not resend UUID-less rows');
      expect(outcome.stderr).toContain('55 !== 30');
      const invocation=JSON.parse(outcome.stderr.split('\n').find((line:string)=>line.startsWith('F3_SERVICE_INVOKE '))!.slice('F3_SERVICE_INVOKE '.length));
      expect(invocation.sha256).toBe(mutation.scratchSha256);expect(invocation.servicePath).toBe(servicePath);
    }else{
      expect(outcome.ok).toBe(true);const row=resultRow(outcome.stdout);
      expect(row.review).toEqual({realService:true,directPending:true,acceptedSubset:25,lateFences:3,accounting:true,reconcileIndexes:true,unknownNoReceipt:true,callbackCaptured:true,timeoutNoReceipt:true,byteSplit:true,oversizedSingleton:true,zeroInserted:true,allReconciled:true});
      if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    }
    expect(workerSources.length).toBe(enabled?1:0);
  }finally{await releaseProductionHome(home.root);}
},loadScaledMs(40_000));
