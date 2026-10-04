import * as fs from "node:fs/promises";
import { acquireFileLock } from "./lockFile.js";

export async function herdViewerAlive(socketPath: string): Promise<boolean> {
  const pid = Number(await fs.readFile(`${socketPath}.viewer`, "utf8").catch(() => ""));
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return Promise.resolve().then(() => process.kill(pid, 0)).then(() => true, () => false);
}

export async function claimHerdViewer(socketPath: string): Promise<() => Promise<void>> {
  const file = `${socketPath}.viewer`;
  const unlock = await acquireFileLock(`${file}.lock`, { waitMs: 1000, describe: "cast herd" });
  try {
    if (await herdViewerAlive(socketPath)) throw new Error("cast herd is already open");
    await fs.writeFile(file, String(process.pid), { mode: 0o600 });
  } finally {
    unlock();
  }
  return async () => {
    if (await fs.readFile(file, "utf8").catch(() => "") === String(process.pid)) await fs.rm(file, { force: true });
  };
}
