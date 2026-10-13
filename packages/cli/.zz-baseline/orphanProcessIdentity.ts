import { argvSessionId } from "./sessionProcessMatcher.js";

export function parseOrphanProcessIdentity(output: string, sessionId: string, uid: number | undefined) {
  const match = output.trim().match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\d+)\s+(\d+)\s+([^\r\n]+)$/);
  if (!match || !Number.isSafeInteger(uid) || Number(match[2]) !== uid || match[3] !== "1") return null;
  const startSec = Date.parse(match[1]) / 1000;
  if (!Number.isFinite(startSec) || argvSessionId(match[4]) !== sessionId) return null;
  return { start: match[1], startSec, uid, command: match[4] };
}
