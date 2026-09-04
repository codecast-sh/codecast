import fs from 'node:fs';
import { runWorker } from '../runtime.js';
if (process.env.F3_FIXTURE_TITLE_DENIED === '1') {
  const open = fs.promises.open.bind(fs.promises);
  fs.promises.open = (async (...args: Parameters<typeof open>) => {
    const fd = await open(...args);
    const read = fd.read.bind(fd);
    fd.read = (async (...values: any[]) => {
      if (values[2] === 4096 && values[3] > 0) throw Object.assign(new Error('fixture title read denied'),{code:'EACCES'});
      return (read as any)(...values);
    }) as typeof fd.read;
    return fd;
  }) as typeof fs.promises.open;
}
runWorker('ingest');
