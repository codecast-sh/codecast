import * as fs from "node:fs";

const PID_FILE_STALE_GRACE_MS = 2_000;

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPidFile(pidFile: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function tryAcquirePidFileLock(
  pidFile: string,
  pid: number,
  options: {
    nowMs?: number;
    staleGraceMs?: number;
    isProcessRunning?: (pid: number) => boolean;
  } = {},
): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const staleGraceMs = options.staleGraceMs ?? PID_FILE_STALE_GRACE_MS;
  const isPidRunning = options.isProcessRunning ?? isProcessRunning;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(pidFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${pid}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") return false;
    }

    const existingPid = readPidFile(pidFile);
    if (existingPid === pid) return true;
    if (existingPid && isPidRunning(existingPid)) return false;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(pidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return false;
    }

    if (nowMs - stat.mtimeMs < staleGraceMs) {
      return false;
    }

    try {
      fs.unlinkSync(pidFile);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      return false;
    }
  }

  return false;
}

export function releasePidFileIfOwned(pidFile: string, pid: number): boolean {
  if (readPidFile(pidFile) !== pid) return false;
  try {
    fs.unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}
