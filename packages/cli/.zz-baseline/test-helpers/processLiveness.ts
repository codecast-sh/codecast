// "Has this process gone away?", answered honestly under any pid 1.
//
// The obvious probe, `process.kill(pid, 0)`, only reports whether the pid SLOT
// is taken, and a zombie holds its slot until its parent reaps it. When pid 1
// never calls wait() — a plain `docker run` without `--init`, which is how a
// Linux repro of the real-tmux suites usually gets built — every process a
// teardown kills stays a zombie for the life of the container and reads back as
// alive. That made the reap and orphan-reaper suites look Linux-broken while the
// CI runner, whose init reaps, passed them both (ct-49907).
//
// A zombie has outlived nothing: it holds no memory, no files and no terminal,
// and it cannot run again. So "still there" means still RUNNING, and the process
// table is what distinguishes the two — `ps -o command=` renders a zombie as
// `<defunct>` on Linux and macOS alike.

import { execFileAsync } from "../proc.js";

/**
 * Does this pid have a slot at all?
 *
 * Only ESRCH means "no such process". EPERM means the opposite — the process
 * is there and belongs to somebody else — and treating every throw as absence
 * reports such a pid gone, which is the one answer a teardown check must never
 * give. (`process.kill(1, 0)` as an ordinary user is exactly this case.)
 */
function holdsPidSlot(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Which of these pids are still running, zombies excluded. Order preserved. */
export async function stillRunning(pids: number[]): Promise<number[]> {
  const holding = pids.filter(holdsPidSlot);
  if (holding.length === 0) return [];
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(
      "ps",
      ["-ww", "-p", holding.join(","), "-o", "pid=,command="],
      { encoding: "utf-8", timeout: 10_000 },
    ) as { stdout: string });
  } catch {
    // Every pid here already answered `kill(pid, 0)`, so `ps` failing is `ps`
    // failing, not an empty match. Report them running: a caller waiting for a
    // teardown should time out loudly rather than be told a leak went away.
    return holding;
  }
  const zombies = new Set<number>();
  for (const line of String(stdout).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2].trim().endsWith("<defunct>")) zombies.add(Number(m[1]));
  }
  return holding.filter((pid) => !zombies.has(pid));
}

/** Is this pid gone, counting an unreaped zombie as gone? */
export async function pidGone(pid: number): Promise<boolean> {
  return (await stillRunning([pid])).length === 0;
}
