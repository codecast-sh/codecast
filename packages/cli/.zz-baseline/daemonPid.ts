import { existsSync, readFileSync } from "node:fs";

export function probeDaemonPid(
  pid: number,
  probe: (pid: number) => void = pid => { process.kill(pid, 0); },
): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    probe(pid);
    return pid;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return pid;
    if (code === "ESRCH") return null;
    throw error;
  }
}

export function readDaemonPid(
  file: string,
  fallback: () => number | null,
  probe?: (pid: number) => void,
): number | null {
  if (!existsSync(file)) return fallback();
  return probeDaemonPid(Number(readFileSync(file, "utf8").trim()), probe) ?? fallback();
}
