import {mock} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const producer=process.env.F3_FIXTURE_INGEST_PRODUCER,home=process.env.HOME!;
if(!home.includes('f3-review-control-')||!producer?.startsWith(home+path.sep))throw new Error('owned scratch producer required');
const source=fs.readFileSync(producer);
const receipt={pid:process.pid,ppid:process.ppid,producer,sha256:createHash('sha256').update(source).digest('hex')};
fs.writeFileSync(path.join(home,'producer-'+process.pid+'.json'),JSON.stringify(receipt));
const implementation=await import(producer);
mock.module('../ingestJobs.js',()=>({...implementation,readIngestJob:(...args:Parameters<typeof implementation.readIngestJob>)=>{
  fs.appendFileSync(path.join(home,'invocations-'+process.pid+'.jsonl'),JSON.stringify({...receipt,client:args[0].client,sessionId:args[0].sessionId,offset:args[0].offset})+'\n');
  return implementation.readIngestJob(...args);
}}));
console.error('F3_SOURCE_CONTROL '+JSON.stringify(receipt));
