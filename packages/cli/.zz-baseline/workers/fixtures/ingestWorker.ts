import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
if (!process.env.HOME?.includes('f3-')) throw new Error('owned fixture HOME required');
fs.writeFileSync(process.env.HOME+'/fixture-process-'+process.pid+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid}));
const sources=['../runtime.ts','../ingestJobs.ts','../ingestDatabase.ts','../../parser.ts','../../cursorChatParser.ts'].map(relative=>{
  const file=path.resolve(import.meta.dir,relative);
  return {file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
});
fs.writeFileSync(process.env.HOME+'/worker-source-'+process.pid+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid,sources}));
if (process.env.F3_FIXTURE_TITLE_DENIED === '1') {
  const open = fs.promises.open.bind(fs.promises);
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    const read = fd.read.bind(fd);
    const target = String(args[0]).endsWith('metadata.jsonl');
    fd.read = (async (...values: any[]) => {
      if (target && values[3] > 0) throw Object.assign(new Error('fixture title read denied'),{code:'EACCES'});
      return (read as any)(...values);
    }) as typeof fd.read;
    return fd;
  }) as typeof fs.promises.open;
}
if (process.env.F3_FIXTURE_PHYSICAL_TASKKEY === '1') await import('./ingestTaskKeyControl.js');
const { runWorker } = await import('../runtime.js');
runWorker('ingest');
