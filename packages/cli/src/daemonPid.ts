import { existsSync, readFileSync } from "node:fs";

export function readDaemonPid(
  file: string,
  fallback: () => number | null,
  probe: (pid: number) => void = pid => { process.kill(pid, 0); },
): number | null {
  if (!existsSync(file)) return fallback();
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return fallback();
  try {
    probe(pid);
    return pid;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return pid;
    if (code === "ESRCH") return fallback();
    throw error;
  }
}
