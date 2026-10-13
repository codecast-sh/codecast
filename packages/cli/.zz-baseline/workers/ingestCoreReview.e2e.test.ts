import {test,expect} from 'bun:test';
import path from 'node:path';
import {loadScaledMs} from '../test-helpers/machineLoad.js';
import {productionHome,runProduction,settled,resultRow,records,releaseProductionHome,mutantCopy} from './fixtures/productionRun.js';

for(const mutant of ['none','c1','c2','c2-queue','c3','c4','c5'])for(const enabled of [false,true])test(`production repaired core custody matrix worker=${enabled} mutant=${mutant}`,async()=>{
  const home=productionHome('f3-core-');
  try{
    const mutation=mutant==='c2'?mutantCopy(home.root,path.resolve(import.meta.dir,'../syncService.ts'),'          beforeBatch?.();','','service-no-guard.ts')
      :mutant==='c4'?mutantCopy(home.root,path.resolve(import.meta.dir,'ingestValidation.ts'),"job.client === 'cursorDb' ? value.rawBubbleCount : ",'','validator-byte-ordinal.ts'):undefined;
    const outcome=await settled(runProduction(home,[String(enabled),'core-review'],{env:{F3_FIXTURE_CORE_MUTANT:mutant==='none'?undefined:mutant,F3_FIXTURE_CORE_CASE:mutant==='none'?undefined:mutant==='c2-queue'?'c2':mutant,F3_FIXTURE_SYNC_SERVICE:mutant==='c2'?mutation!.file:undefined,F3_FIXTURE_CORE_VALIDATOR:mutant==='c4'?mutation!.file:undefined},maxBuffer:4*1024*1024}));
    const workerSources=records(home.root,/^worker-source-\d+\.json$/);
    console.log(JSON.stringify({enabled,mutant,mutationReceipt:mutation,outcome,workerSources}));
    expect(outcome.stderr).toContain('F3_DAEMON_SOURCE ');expect(outcome.stderr).toContain('F3_CORE_CASE ');
    if(mutant==='none'){
      expect(outcome.stderr).toContain('F3_CORE_SERVICE_INVOKE ');expect(outcome.stderr).toContain('F3_CORE_BACKEND_INVOKE ');expect(outcome.ok).toBe(true);
      const row=resultRow(outcome.stdout);
      expect(row.review).toEqual({partialCleanup:3,fenceCases:16,expiredWaits:3,optionsCaptured:true,networkQueue:true,walOrdinal:true,globalAdmission:true,scheduledRetained:true});
      if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    }else{
      expect(outcome.ok).toBe(false);
      const expected:Record<string,string>={c1:'pruned receipts must not resend known accepted pending objects',c2:'authority refusal must stop before second mutation','c2-queue':'local refusal must not enqueue unguarded work',c3:'retained work scheduled condition timed out',c4:'invalid ingest result schema',c5:'publication must refuse a stale global admission'};
      expect(outcome.stderr).toContain(expected[mutant]);
      if(mutant==='c1')expect(outcome.stderr).toContain('55 !== 30');
      if(mutant==='c3')expect(outcome.stderr).toContain('F3_CORE_AUTH_FIRST ');
      if(mutant==='c5')expect(outcome.stderr).toContain('F3_CORE_ADMISSION_PUBLICATION ');
      if(mutation){
        const marker=mutant==='c2'?'F3_CORE_SERVICE_INVOKE ':'F3_CORE_VALIDATOR_INVOKE ';
        const invocation=JSON.parse(outcome.stderr.split('\n').find((line:string)=>line.startsWith(marker))!.slice(marker.length));
        expect(invocation.sha256).toBe(mutation.scratchSha256);
      }
    }
    expect(workerSources.length).toBe(enabled?1:0);
  }finally{await releaseProductionHome(home.root);}
},loadScaledMs(70_000));
