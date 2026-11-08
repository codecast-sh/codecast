// Atomic file writes: a reader never sees half a file. `sync` also fsyncs the
// file before the rename and its directory after, so the write survives a
// crash of the process or the OS. On macOS fsync does not flush the drive's
// own cache (that takes F_FULLFSYNC, which node does not expose), so a power
// cut can still lose the last write.

import * as fs from "node:fs";
import * as path from "node:path";

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
  if (opts.sync) {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } catch {} finally { fs.closeSync(dir); }
  }
}
