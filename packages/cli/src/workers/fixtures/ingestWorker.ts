import fs from 'node:fs';
if (!process.env.HOME?.includes('f3-')) throw new Error('owned fixture HOME required');
fs.writeFileSync(process.env.HOME+'/fixture-process-'+process.pid+'.json',JSON.stringify({pid:process.pid,ppid:process.ppid}));
if (process.env.F3_FIXTURE_TITLE_DENIED === '1') {
  const open = fs.promises.open.bind(fs.promises);
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    const read = fd.read.bind(fd);
    const target = String(args[0]).endsWith('metadata.jsonl');
    fd.read = (async (...values: any[]) => {
      if (target && values[2] === 4096 && values[3] > 0) throw Object.assign(new Error('fixture title read denied'),{code:'EACCES'});
      return (read as any)(...values);
    }) as typeof fd.read;
    return fd;
  }) as typeof fs.promises.open;
}
if (process.env.F3_FIXTURE_PHYSICAL_TASKKEY === '1') await import('./ingestTaskKeyControl.js');
const { runWorker } = await import('../runtime.js');
runWorker('ingest');
