import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile } from "../atomicWrite.js";
import { acquireLock, releaseLock } from "../capabilities/lock.js";
import { listStates, type PersistedWorkspaceState } from "./contract.js";

interface PortReservation {
  repoRoot: string;
  workspace: PersistedWorkspaceState;
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
  const deadline = Date.now() + 30_000;
  while (!acquireLock(directory).acquired) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workspace port reservations");
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
    releaseLock(directory);
  }
}
