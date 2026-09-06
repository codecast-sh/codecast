import {mock} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {validateIngestResult} from '../ingestValidation.js';
const file=process.env.F3_FIXTURE_CORE_VALIDATOR!,home=process.env.HOME!;
if(!home.includes('f3-core-')||!file.startsWith(home+path.sep))throw new Error('owned validator source required');
const implementation=await import(file),sha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
mock.module('../ingestValidation.js',()=>({...implementation,validateIngestResult:(...args:Parameters<typeof validateIngestResult>)=>{
  console.error('F3_CORE_VALIDATOR_INVOKE '+JSON.stringify({pid:process.pid,file,sha256,client:args[1].client,offset:args[1].offset}));
  return implementation.validateIngestResult(...args);
}}));
