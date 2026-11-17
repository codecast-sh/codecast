/**
 * This machine's record of each `cast run`: what `cast run wait`, `show`,
 * `ls` and `cancel` read back.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { codecastPath } from "../codecastDir.js";

export interface RunRecord {
  id: string;
  host: { id: string; address: string; user: string; keyPath: string; homeDir?: string; proxyCommand?: string; local?: string };
  repo: string;
  seedCwd: string;
  cwdRel: string;
  argv: string[];
  job?: string;
  outputs: string[];
  sha: string;
  base: string;
  dirty: boolean;
  createdAt: number;
  timings: Record<string, number>;
  uploadBytes?: number;
  outputsApplied?: boolean;
  code?: number;
  reason?: string;
}

export const runsDir = () => process.env.CAST_RUN_LOCAL_DIR || codecastPath("runs");
const recordFile = (id: string) => path.join(runsDir(), `${id}.json`);

export function saveRecord(r: RunRecord): void {
  fs.mkdirSync(runsDir(), { recursive: true });
  const tmp = `${recordFile(r.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, recordFile(r.id));
}

export function dropRecord(id: string): void {
  fs.rmSync(recordFile(id), { force: true });
}

export function readRecord(id: string): RunRecord | undefined {
  if (!/^r[a-z0-9]{6,24}$/.test(id)) return undefined;
  try { return JSON.parse(fs.readFileSync(recordFile(id), "utf-8")) as RunRecord; } catch { return undefined; }
}

export function listRecords(): RunRecord[] {
  if (!fs.existsSync(runsDir())) return [];
  return fs.readdirSync(runsDir()).filter((f) => /^r[a-z0-9]+\.json$/.test(f))
    .map((f) => readRecord(f.slice(0, -5))).filter((r): r is RunRecord => !!r)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Keep this machine's newest 200 run records (and their diverted outputs); older ones go. */
export function pruneRecords(keep = 200): void {
  for (const r of listRecords().slice(keep)) {
    fs.rmSync(recordFile(r.id), { force: true });
    fs.rmSync(path.join(runsDir(), r.id), { recursive: true, force: true });
  }
}

export function newRunId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `r${Array.from(crypto.randomBytes(9), (b) => alphabet[b % 36]).join("")}`;
}
