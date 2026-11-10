// Atomic file writes: a reader never sees half a file. `sync` also fsyncs the
// file before the rename and its directory after, so the write survives a
// crash of the process or the OS. On macOS fsync does not flush the drive's
// own cache (that takes F_FULLFSYNC, which node does not expose), so a power
// cut can still lose the last write.
//
// The light one, for hot state files (turn claims, the Claude SDK host state):
// no fsync unless asked, and no dependency beyond two node builtins, so it
// stays out of the boot graph's way. Config and settings files go through
// atomicWrite.ts, which always fsyncs, resolves symlinks and sweeps stranded
// temp files.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function writeFileAtomic(file: string, text: string, opts: { mode?: number; sync?: boolean } = {}): void {
  // pid and a random suffix, opened exclusively: two writes of one file from
  // the same process (or a recycled pid) never share a temp file.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", opts.mode ?? 0o600);
    try {
      fs.writeSync(fd, text);
      if (opts.sync) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  if (opts.sync) {
    const dir = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(dir); } catch {} finally { fs.closeSync(dir); }
  }
}
