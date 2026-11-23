/**
 * Files a `cast` command wrote in a checkout for the agent session that ran it.
 *
 * attribute.ts credits a session with the files its transcript shows it
 * writing: an Edit or Write call, a shell command that names the path. A cast
 * command that writes files itself (`cast flow edit` writes the project's flow
 * and its prompt files) shows only as `cast flow edit ...` in the transcript,
 * which names none of them, so those files came back unattributed and `cast
 * flow run` found no change of the session's. Such a command records what it
 * wrote here, under the session its environment names (sessionIdentity.ts),
 * and attributeEdits reads it beside the transcripts. Run from a person's
 * shell, with no session in the environment, nothing is recorded.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";
import { sessionIdFromEnv } from "../sessionIdentity.js";

export type SessionWrite = { root: string; path: string; at: number; session: string; conversation?: string };

/** Entries older than this are dropped on the next write: attribution reads back far less (ATTRIBUTION_HORIZON_MS). */
const KEEP_MS = 14 * 24 * 3_600_000;
const PRUNE_AT_BYTES = 512 * 1024;

export const writeLedgerFile = () => path.join(defaultConfigDir(), "cache", "session-writes.jsonl");

const realOrSelf = (p: string) => {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
};

/**
 * Record that `session` (else the session in `env`) wrote (or deleted) `files`, absolute, inside the checkout at `root`. Returns the
 * entries written; none when no session is named or a file lies outside the checkout.
 */
export function recordSessionWrites(root: string, files: readonly string[], opts: { session?: string | null; env?: NodeJS.ProcessEnv; now?: number; file?: string } = {}): SessionWrite[] {
  const env = opts.env ?? process.env;
  // The session `cast flow run` will look for (its callingSession), else the one the environment names.
  const session = opts.session || sessionIdFromEnv(env);
  if (!session || !files.length) return [];
  const realRoot = realOrSelf(root);
  const at = opts.now ?? Date.now();
  const conversation = env.CODECAST_CONVERSATION_ID || (/^jx[a-z0-9]{7,}$/.test(session) ? session : undefined);
  const entries: SessionWrite[] = [];
  for (const f of files) {
    // A deleted file has no real path of its own: resolve its directory instead.
    const abs = fs.existsSync(f) ? realOrSelf(f) : path.join(realOrSelf(path.dirname(f)), path.basename(f));
    const rel = path.relative(realRoot, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    entries.push({ root: realRoot, path: rel.split(path.sep).join("/"), at, session, ...(conversation ? { conversation } : {}) });
  }
  if (!entries.length) return [];
  const ledger = opts.file ?? writeLedgerFile();
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  let size = 0;
  try { size = fs.statSync(ledger).size; } catch {}
  if (size > PRUNE_AT_BYTES) {
    const kept = readAll(ledger).filter((e) => at - e.at < KEEP_MS);
    fs.writeFileSync(ledger, kept.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
  fs.appendFileSync(ledger, entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return entries;
}

function readAll(file: string): SessionWrite[] {
  let text = "";
  try { text = fs.readFileSync(file, "utf-8"); } catch { return []; }
  const out: SessionWrite[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (typeof e?.root === "string" && typeof e.path === "string" && typeof e.at === "number" && typeof e.session === "string") out.push(e);
    } catch {}
  }
  return out;
}

/** The writes recorded in the checkout at `root` since `since`. */
export function readSessionWrites(root: string, since: number, file = writeLedgerFile()): SessionWrite[] {
  const realRoot = realOrSelf(root);
  return readAll(file).filter((e) => e.root === realRoot && e.at >= since);
}
