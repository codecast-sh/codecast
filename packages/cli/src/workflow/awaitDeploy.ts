// The Deploy stage of a change flow (docs/architecture/flows.md FL4): after Land,
// the run waits for the deploy that carries the landed commit on every target
// the change touches, and says when it is live (dp-N) or that it failed. It
// reads the repository's deploy targets as `cast line deploy targets --json`
// prints them (deploys.md DP10 to DP13) and decides which deploy carries the
// change with git ancestry in the change's own checkout, so it needs nothing
// from the server beyond what every target already records. The station that
// runs it parks: while it waits the run holds no slot and no session.
import { git, gitTry } from "../wipSnapshot.js";

/** One deploy of a target, as the targets read lists its history. */
export type TargetDeploy = { short_id: string; status: string; sha?: string | null; created_at?: number; live_at?: number | null; finished_at?: number | null; note?: string | null };
export type DeployTargetRow = { name: string; paths?: string[]; runs?: string; live?: TargetDeploy | null; open?: TargetDeploy | null; history?: TargetDeploy[] };

export type TargetState =
  | { target: string; state: "live"; deploy: TargetDeploy }
  | { target: string; state: "failed"; deploy: TargetDeploy }
  | { target: string; state: "deploying"; deploy: TargetDeploy }
  | { target: string; state: "waiting" };

/**
 * The commit on `base` that carries the change on `branch`: the branch itself
 * once main holds it, else the commit whose every file reads as the branch left
 * it (a squash). Null until it lands. `known` is the change's files when the run
 * knows them (`$change_files`); once main holds the branch nothing is left to
 * diff it against, so without them the tip commit's own files stand for it.
 */
export async function landedCommit(cwd: string, branch: string, base: string, known?: ReadonlyArray<string>): Promise<{ sha: string; files: string[] } | null> {
  await gitTry(cwd, ["fetch", "-q", "origin", base]);
  const upstream = `origin/${base}`;
  const tip = (await git(cwd, ["rev-parse", branch])).trim();
  const fork = (await git(cwd, ["merge-base", tip, upstream])).trim();
  const names = (from: string) => git(cwd, ["diff", "--name-only", "--no-renames", from, tip]).then((s) => s.split("\n").filter(Boolean));
  if (fork === tip) return { sha: tip, files: known?.length ? [...known] : await names(`${tip}~1`).catch(() => []) };
  const files = known?.length ? [...known] : await names(fork);
  if (!files.length) return null;
  const blob = (rev: string, f: string) => gitTry(cwd, ["rev-parse", "-q", "--verify", `${rev}:${f}`]).then((s) => s?.trim() ?? "");
  const want = await Promise.all(files.map((f) => blob(tip, f)));
  const candidates = (await git(cwd, ["log", "--reverse", "--format=%H", `${fork}..${upstream}`, "--", ...files])).split("\n").filter(Boolean);
  for (const c of candidates) {
    const got = await Promise.all(files.map((f) => blob(c, f)));
    if (got.every((g, i) => g === want[i])) return { sha: c, files };
  }
  // A change replayed onto a main that moved in the same files (the merge step replays a branch onto main) has no
  // commit reading as the branch left it. It landed at the first commit that already holds all of it: merging the
  // branch into that commit changes nothing.
  for (const c of candidates) {
    const merged = await gitTry(cwd, ["merge-tree", "--write-tree", c, tip]);
    if (merged && merged.split("\n")[0].trim() === (await git(cwd, ["rev-parse", `${c}^{tree}`])).trim()) return { sha: c, files };
  }
  return null;
}

/** Whether a target ships any of these files: its path globs, or every path when it names none. */
export function targetTouches(paths: ReadonlyArray<string> | undefined, files: ReadonlyArray<string>): boolean {
  if (!paths?.length) return true;
  const globs = paths.map((p) => new Bun.Glob(p));
  return files.some((f) => globs.some((g) => g.match(f)));
}

/**
 * Where the landed commit stands on one target: live once a live deploy's sha
 * holds it, failed when the newest deploy that would have carried it failed
 * and none since carries it, going out while an open deploy holds it, else
 * waiting for a deploy. `carries(sha)` says whether a deployed sha holds the
 * landed commit (git ancestry).
 */
export async function targetState(t: DeployTargetRow, carries: (sha: string) => Promise<boolean>): Promise<TargetState> {
  const rows = [...(t.history ?? []), ...(t.live ? [t.live] : []), ...(t.open ? [t.open] : [])]
    .filter((d, i, all) => d.sha && all.findIndex((x) => x.short_id === d.short_id) === i)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  const holding: TargetDeploy[] = [];
  for (const d of rows) if (await carries(d.sha!)) holding.push(d);
  // The first live deploy that carried it is the one that took it live.
  const live = holding.filter((d) => d.status === "live").sort((a, b) => (a.live_at ?? a.created_at ?? 0) - (b.live_at ?? b.created_at ?? 0))[0];
  if (live) return { target: t.name, state: "live", deploy: live };
  const newest = holding[0];
  if (newest?.status === "failed") return { target: t.name, state: "failed", deploy: newest };
  if (newest && (newest.status === "requested" || newest.status === "running")) return { target: t.name, state: "deploying", deploy: newest };
  return { target: t.name, state: "waiting" };
}

/** One line for where the change stands across its targets. */
export function deployWords(sha: string, states: ReadonlyArray<TargetState>): string {
  const short = sha.slice(0, 10);
  if (!states.length) return `${short} is on main; no deploy target ships these files, so nothing waits on a deploy.`;
  const failed = states.filter((s) => s.state === "failed") as Array<Extract<TargetState, { state: "failed" }>>;
  if (failed.length) return `The deploy that carried ${short} failed: ${failed.map((s) => `${s.target} ${s.deploy.short_id}${s.deploy.note ? ` (${s.deploy.note})` : ""}`).join(", ")}.`;
  const live = states.filter((s) => s.state === "live") as Array<Extract<TargetState, { state: "live" }>>;
  if (live.length === states.length) return `Live: ${short} on ${live.map((s) => `${s.target} ${s.deploy.short_id}`).join(", ")}.`;
  const rest = states.filter((s) => s.state !== "live").map((s) => (s.state === "deploying" ? `${s.target} (going out in ${s.deploy.short_id})` : s.target));
  return `${short} landed; ${live.length ? `live on ${live.map((s) => `${s.target} ${s.deploy.short_id}`).join(", ")}, ` : ""}waiting for ${rest.join(", ")}.`;
}

/** Whether `ancestor` is in the history of `sha`, read in `cwd` (a sha this checkout lacks holds nothing). */
export async function holds(cwd: string, ancestor: string, sha: string): Promise<boolean> {
  if (ancestor === sha) return true;
  if ((await gitTry(cwd, ["cat-file", "-e", `${sha}^{commit}`])) === null) return false;
  return (await gitTry(cwd, ["merge-base", "--is-ancestor", ancestor, sha])) !== null;
}
