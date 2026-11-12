// `read_file`: one file from this machine for a browser on another one. A
// conversation's file link names a path that exists only where the session
// ran; the Files page asks that machine for it through the command queue.
//
// The answer is written to a daemon_commands row, so the fence is narrow: a
// regular file inside a project root this daemon tracks, outside `.git`, never
// a key or credentials file, never more than READ_FILE_MAX_BYTES, never binary.
import fs from "node:fs";
import path from "node:path";
import { READ_FILE_MAX_BYTES, type ReadFileResult } from "@codecast/shared/contracts";
import { realTargetOf } from "./configFence.js";
import { isSecretFile } from "./folderSync.js";

export type ReadFileOutcome = { result: ReadFileResult } | { error: string };

function canonical(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** The canonical path when the fence admits `p`, else the reason it does not. */
export function admitReadPath(p: string, roots: readonly string[]): { target: string } | { error: string } {
  if (!path.isAbsolute(p)) return { error: "read_file: path must be absolute" };
  const target = realTargetOf(p, { followFile: true });
  if (!target) return { error: "read_file: path does not resolve" };
  const root = roots.map(canonical).find((r) => target.startsWith(r + path.sep));
  if (!root) return { error: "Path not allowed" };
  if (path.relative(root, target).split(path.sep).includes(".git")) return { error: "Path not allowed" };
  const name = path.basename(target);
  if (isSecretFile(name) || isSecretFile(name.replace(/^\.+/, ""))) return { error: "Path not allowed" };
  return { target };
}

export function readFileForWeb(p: string, roots: readonly string[]): ReadFileOutcome {
  const admitted = admitReadPath(p, roots);
  if ("error" in admitted) return admitted;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(admitted.target);
  } catch {
    return { result: { exists: false } };
  }
  if (!stat.isFile()) return { error: "read_file: not a file" };
  const fd = fs.openSync(admitted.target, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, READ_FILE_MAX_BYTES));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, n);
    if (bytes.includes(0)) return { error: "read_file: binary file" };
    return {
      result: {
        exists: true,
        content: bytes.toString("utf8"),
        size: stat.size,
        mtime: stat.mtimeMs,
        truncated: stat.size > n,
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}
