// "Is this pid still running?", with no other dependency.
//
// It lived in workspace/chrome.ts, which launches and stops Chrome and reaches
// workspace/ports.ts to do it. lockFile.ts needs only the predicate, to decide
// whether a lock holder is dead, so the whole Chrome launcher was arriving on
// the CLI's boot graph through a lock file (bench/bootGraph.guard.test.ts).
// chrome.ts re-exports it, so its own importers are unchanged.

/** Returns true if a process with `pid` is alive. Cheap; uses signal 0.
 *  EPERM means the pid exists but belongs to another user, which is alive. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM" || code === "EACCES") return true;
    throw err;
  }
}
