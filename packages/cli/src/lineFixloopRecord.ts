// `cast line fixloop --record` (docs/architecture/regret.md R2): the nightly
// trace that stores what landed on a repository's main and which earlier
// changes each fix repaired, on the server (convex landedChanges.record).
//
// It never reads a working checkout's branch or files: a checkout only names
// the repository (its origin), and the history comes from this machine's own
// bare mirror of origin, fetched fresh each run. A shared checkout can be
// behind main or hold other sessions' edits; the mirror is main as it is.

import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { execFile } from "./proc.js";
import { extractRepoFromRemoteUrl } from "@codecast/shared/contracts";
import { readSessionTrailers } from "./blame.js";
import { parseLog, selectFixCommits, traceFixes } from "./lineFixloop.js";

const run = promisify(execFile);
const git = async (args: string[], cwd: string) => (await run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 })).stdout;

/** On a first run, how far back the history is read. */
export const BACKFILL_DAYS = 60;
/** Later runs start this far before the newest recorded change, so a fix landed out of order is still traced. */
const OVERLAP_DAYS = 3;
const BATCH = 100;

export type Post = (urlPath: string, body: Record<string, unknown>) => Promise<any>;

/** origin's url and its owner/name, for a checkout that exists. */
export async function originOf(dir: string): Promise<{ url: string; repository: string } | null> {
  if (!fs.existsSync(dir)) return null;
  const url = (await git(["remote", "get-url", "origin"], dir).catch(() => "")).trim();
  const repository = url ? extractRepoFromRemoteUrl(url) : null;
  return url && repository ? { url, repository: repository.toLowerCase() } : null;
}

/** This machine's bare mirror of the repository's default branch, fetched now. Returns its path and the branch. */
export async function freshMirror(url: string, repository: string, home = os.homedir()): Promise<{ dir: string; branch: string }> {
  const dir = path.join(home, ".codecast", "mirrors", `${repository.replace("/", "__")}.git`);
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    fs.mkdirSync(dir, { recursive: true });
    await git(["init", "-q", "--bare"], dir);
    await git(["remote", "add", "origin", url], dir);
  }
  const head = await git(["ls-remote", "--symref", "origin", "HEAD"], dir);
  const branch = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head)?.[1] ?? "main";
  await git(["fetch", "-q", "--no-tags", "origin", `+refs/heads/${branch}:refs/heads/${branch}`], dir);
  return { dir, branch };
}

/** Trace one repository from its mirror and send it, in batches. */
export async function recordRepository(o: { dir: string; branch: string; repository: string; teamId: string; post: Post; now?: number; backfillDays?: number }): Promise<{ changes: number; fixes: number; links: number; inserted: number; since: string }> {
  const cursor = await o.post("/cli/line/fixloop/cursor", { team_id: o.teamId, repository: o.repository });
  const now = o.now ?? Date.now();
  const fromMs = o.backfillDays !== undefined ? now - o.backfillDays * 86_400_000
    : cursor?.landed_at ? cursor.landed_at - OVERLAP_DAYS * 86_400_000 : now - BACKFILL_DAYS * 86_400_000;
  const since = new Date(fromMs).toISOString();
  const rev = `refs/heads/${o.branch}`;
  // %ct, not %at: a rebased or squashed change reaches main at its commit time.
  const log = parseLog(await git(["log", rev, `--since=${since}`, "--no-merges", "--format=%H%x00%s%x00%ct"], o.dir));
  const fixes = new Map(selectFixCommits(log).map((f) => [f.sha, f.reason]));
  const traces = await traceFixes({ cwd: o.dir, rev, since, config: {}, resolve: async () => ({ bySha: new Map(), byLine: new Map() }) });
  // Every change a fix traced to needs a row too, even one older than the window.
  const known = new Set(log.map((c) => c.sha));
  const older = [...new Set(traces.flatMap((t) => t.introduced.map((i) => i.sha)))].filter((s) => !known.has(s));
  const olderLog = older.length ? parseLog(await git(["show", "-s", "--format=%H%x00%s%x00%ct", ...older], o.dir)) : [];
  const all = [...olderLog, ...log];
  const trailers = await readSessionTrailers(all.map((c) => c.sha), o.dir);
  const changes = all.map((c) => ({
    sha: c.sha, subject: c.subject, committed_at: c.authorTime,
    ...(trailers.get(c.sha) ? { session: trailers.get(c.sha) } : {}),
    ...(fixes.get(c.sha) ? { fix_reason: fixes.get(c.sha) } : {}),
  }));
  let inserted = 0, links = 0;
  for (let i = 0; i < changes.length; i += BATCH) {
    const r = await o.post("/cli/line/fixloop/record", { team_id: o.teamId, repository: o.repository, changes: changes.slice(i, i + BATCH), fixes: [] });
    inserted += r?.inserted ?? 0;
  }
  const fixRows = traces.filter((t) => t.introduced.length).map((t) => ({ sha: t.fix.sha, at: t.fix.authorTime, introduced: t.introduced.map((x) => ({ sha: x.sha, lines: x.lines })) }));
  for (let i = 0; i < fixRows.length; i += BATCH) {
    const r = await o.post("/cli/line/fixloop/record", { team_id: o.teamId, repository: o.repository, changes: [], fixes: fixRows.slice(i, i + BATCH) });
    links += r?.linked ?? 0;
  }
  return { changes: changes.length, fixes: fixRows.length, links, inserted, since };
}

/** Every distinct repository the checkouts name, each traced from its own mirror. */
export async function recordFixloop(o: { roots: string[]; teamId: string; post: Post; log?: (s: string) => void; backfillDays?: number }): Promise<Array<{ repository: string; changes: number; fixes: number; links: number; inserted: number; since: string } | { root: string; error: string }>> {
  const log = o.log ?? (() => {});
  const seen = new Set<string>();
  const out: any[] = [];
  for (const root of o.roots) {
    const origin = await originOf(root);
    if (!origin) { out.push({ root, error: "no checkout with a GitHub origin here" }); continue; }
    if (seen.has(origin.repository)) continue;
    seen.add(origin.repository);
    try {
      const mirror = await freshMirror(origin.url, origin.repository);
      const r = await recordRepository({ ...mirror, repository: origin.repository, teamId: o.teamId, post: o.post, backfillDays: o.backfillDays });
      log(`${origin.repository}: ${r.changes} changes since ${r.since.slice(0, 10)}, ${r.inserted} new, ${r.fixes} fixes traced, ${r.links} new links`);
      out.push({ repository: origin.repository, ...r });
    } catch (err) {
      out.push({ root, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
