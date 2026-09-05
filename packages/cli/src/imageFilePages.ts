import { PayloadBudget } from './workers/payloadBudget.js';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

export class ImageFileRefused extends Error {}

export async function* imageFilePages(file: string, options: { budget: PayloadBudget; signal?: AbortSignal }): AsyncGenerator<Buffer> {
  const current = () => {
    if (options.signal?.aborted || options.budget.signal?.aborted || options.budget.remainingMs() <= 0) throw new ImageFileRefused('image read cancelled or expired');
  };
  current();
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    current();
    const before = await handle.stat();
    if (!before.isFile() || before.size > 5_000_000) throw new ImageFileRefused('image requires a regular file of at most 5000000 bytes');
    let offset = 0;
    for (;;) {
      current();
      const buffer = Buffer.alloc(Math.min(65_536, 5_000_001 - offset));
      const read = await handle.read(buffer, 0, buffer.length, offset);
      current();
      if (!read.bytesRead) break;
      offset += read.bytesRead;
      if (offset > 5_000_000) throw new ImageFileRefused('image grew beyond the read limit');
      yield buffer.subarray(0, read.bytesRead);
    }
    const after = await handle.stat();
    const path = await stat(file).catch(() => { throw new ImageFileRefused('image path disappeared during read'); });
    current();
    if (offset !== before.size || !path.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || before[key as keyof typeof before] !== path[key as keyof typeof path])) throw new ImageFileRefused('image changed during read');
  } finally { await handle.close(); }
}
