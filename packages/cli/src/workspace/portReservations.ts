import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile } from "../atomicWrite.js";
import { execFileSync } from "../proc.js";
import { listStates, type PersistedWorkspaceState } from "./contract.js";

export interface PortReservation {
  repoRoot: string;
  workspace: PersistedWorkspaceState;
}

/** A reservation whose worktree is gone, so its ports are free again. */
export interface ReclaimedReservation {
  reservation: PortReservation;
  reason: "worktree missing" | "branch gone";
}

/**
 * Split reservations into the ones a live worktree still backs and the ones
 * whose worktree is gone — the directory was removed, or its branch was
 * deleted. The second group's ports are reclaimed: a dead workspace must not
 * keep a port out of the pool.
 *
 * A workspace mid-creation or mid-destruction keeps its reservation. Its
 * directory may not exist yet, and another process is holding the port.
 */
export function partitionReservations(reservations: PortReservation[]): {
  live: PortReservation[];
  stale: ReclaimedReservation[];
} {
  const live: PortReservation[] = [];
  const stale: ReclaimedReservation[] = [];
  const branches = new Map<string, Set<string> | null>();
  for (const reservation of reservations) {
    const reason = staleReason(reservation, branches);
    if (reason) stale.push({ reservation, reason });
    else live.push(reservation);
  }
  return { live, stale };
}

function staleReason(
  reservation: PortReservation,
  branches: Map<string, Set<string> | null>,
): ReclaimedReservation["reason"] | undefined {
  const { workspace } = reservation;
  if (workspace.state === "creating" || workspace.state === "destroying") return undefined;
  if (!fs.existsSync(workspace.path)) return "worktree missing";
  const known = repoBranches(reservation.repoRoot, branches);
  if (known && workspace.branch && !known.has(workspace.branch)) return "branch gone";
  return undefined;
}

/** Branch names in a repo, or null when git cannot answer for it. */
function repoBranches(repoRoot: string, cache: Map<string, Set<string> | null>): Set<string> | null {
  const cached = cache.get(repoRoot);
  if (cached !== undefined) return cached;
  let branches: Set<string> | null = null;
  try {
    // execFileSync, not a shell: the format string's parentheses are shell
    // metacharacters and every branch would look deleted.
    const out = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    branches = new Set(out.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    branches = null;
  }
  cache.set(repoRoot, branches);
  return branches;
}

interface ReservationLockOwner {
  pid: number;
  token: string;
  acquired_at: string;
}

function readReservationLock(file: string): Partial<ReservationLockOwner> & { pid: number } | undefined {
  try {
    const owner = JSON.parse(fs.readFileSync(file, "utf8"));
    const validToken = typeof owner?.token === "string" && owner.token.length > 0;
    const legacy = owner?.token === undefined && typeof owner?.acquired_at === "string" && Number.isFinite(Date.parse(owner.acquired_at));
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0 && (validToken || legacy)) return owner;
  } catch {
    return undefined;
  }
}

function tryReservationLock(file: string, owner: ReservationLockOwner): boolean {
  const temp = `${file}.${owner.token}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(temp, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function withWorkspaceOperation<T>(repoRoot: string, name: string, fn: () => Promise<T>): Promise<T> {
  const root = fs.realpathSync(repoRoot);
  const key = createHash("sha256").update(JSON.stringify([root, name])).digest("hex");
  const directory = path.join(process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast"), "workspace-ports", "operations");
  const file = path.join(directory, `${key}.json`);
  const token = randomUUID();
  await withPortReservations(root, async () => {
    if (fs.existsSync(file)) {
      const holder = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(holder.pid) || holder.pid <= 0) throw new Error(`workspace '${name}' has an invalid operation owner`);
      let alive = true;
      try { process.kill(holder.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error(`workspace '${name}' has an operation in progress (pid ${holder.pid})`);
      throw new Error(`workspace '${name}' has an interrupted operation; inspect remaining child processes before removing ${file}`);
    }
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteFile(file, JSON.stringify({ pid: process.pid, token }));
  });
  try {
    return await fn();
  } finally {
    await withPortReservations(root, async () => {
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.unlinkSync(file);
    });
  }
}

export async function withPortReservations<T>(
  repoRoot: string,
  fn: (reservations: PortReservation[]) => Promise<T>,
): Promise<T> {
  const root = fs.realpathSync(repoRoot);
  const directory = path.join(process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast"), "workspace-ports");
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, ".codecast-capability.lock");
  const owner = { pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() };
  const deadline = Date.now() + 30_000;
  while (!tryReservationLock(lock, owner)) {
    const holder = readReservationLock(lock);
    if (holder) {
      try {
        process.kill(holder.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          throw new Error(`Workspace port reservations have an interrupted owner (pid ${holder.pid}); inspect remaining child processes before manually removing ${lock}`);
        }
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace port reservations (${holder ? `pid ${holder.pid}` : "unreadable owner"}); inspect ${lock} before manual recovery`);
    }
    await sleep(25);
  }

  try {
    const file = path.join(directory, "repositories.json");
    const known: string[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    const reservations = [...new Set([...known, root])].flatMap((repo) =>
      listStates(repo)
        .filter((workspace) => !workspace.manifest.backend || workspace.manifest.backend === "local")
        .map((workspace) => ({ repoRoot: repo, workspace })),
    );
    const roots = [...new Set([...reservations.map((reservation) => reservation.repoRoot), root])];
    atomicWriteFile(file, JSON.stringify(roots));
    const result = await fn(reservations);
    atomicWriteFile(file, JSON.stringify(roots.filter((repo) => listStates(repo).length > 0)));
    return result;
  } finally {
    if (readReservationLock(lock)?.token === owner.token) fs.unlinkSync(lock);
  }
}
