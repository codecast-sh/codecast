// Atomic file writes: a reader never sees half a file. `sync` also fsyncs
// before the rename, for a write that must survive a power cut.

import * as fs from "node:fs";

export function writeFileAtomic(file: string, text: string, opts: { mode?: number; sync?: boolean } = {}): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", opts.mode ?? 0o600);
  try {
    fs.writeSync(fd, text);
    if (opts.sync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
