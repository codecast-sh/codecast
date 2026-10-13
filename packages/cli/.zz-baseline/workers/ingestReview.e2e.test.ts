import {test,expect} from 'bun:test';
import {loadScaledMs} from '../test-helpers/machineLoad.js';
import {productionHome,runProduction,resultRow,releaseProductionHome} from './fixtures/productionRun.js';

const reviews:[name:string,mode:string,review:object][]=[
  ['production TaskCreate custody','task-review',{backend:true,unknownBefore:true,lostResponse:true,nativeReplacement:true,legacyUpdate:true,numericUpdate:true,mappingFence:true,oneShotReplay:true,permissionEpoch:true}],
  ['production scheduled transcript recovery','scheduled-review',{formats:8,scheduled:true,zeroManaged:true,unchanged:true,burstExhausted:true,authPause:true,stopped:true}],
  ['production receipt and generation custody','custody-review',{lateAcceptance:6,readGeneration:6,countMapping:true,legacyFreshAppend:true,mismatchCold:true,evictedReplacement:true,countReplacement:true,receiptCapacity:2048,healthyProgress:true,oversizedPendingBypass:true,scheduledOccurrences:2500,continuationWake:true}],
  ['production scheduled disappearance cleanup','disappearance-review',{scheduledMissingSource:true,logicalSessionRemoved:true,otherLogicalReceiptPreserved:true,stopped:true}],
];

for(const [name,mode,review] of reviews)for(const enabled of [false,true])test(`${name} worker=${enabled}`,async()=>{
  const home=productionHome('f3-review-');
  try{
    const result=await runProduction(home,[String(enabled),mode]);
    console.log(result.stderr);
    const row=resultRow(result.stdout);
    expect(row.review).toEqual(review);
    if(enabled){expect(row.parentParses).toBe(0);expect(row.workerPid).toBeGreaterThan(0);}
    console.log(JSON.stringify(row));
  }finally{await releaseProductionHome(home.root);}
},loadScaledMs(70_000));
