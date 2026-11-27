// What follows a CLI release once it is live (.codecast/deploy.toml's cli
// target `finish`, ct-102483). Forcing every machine to update restarts every
// daemon, which is worth it only when the daemon's code changed, so the
// decision is computed, never judged: the daemon build id (daemonBuildIdCompute)
// at the release's commit against the one at the release live before it.
// When they differ the deploy's team floor is raised to the release, and the
// team's machines are watched until each online one runs it or the wait ends;
// either way the decision and the fleet are recorded on the deploy's note.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "./proc.js";
import { computeDaemonBuildId } from "./daemonBuildIdCompute.js";

/** Every path the daemon build id reads (daemonBuildIdCompute.ts). */
const BUILD_ID_PATHS = ["packages/cli/src", "packages/cli/package.json", "packages/shared", "platform/packages"];

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The daemon build id of the tree at `sha`: the paths it reads, extracted from git, hashed as a build hashes them. */
export function daemonBuildIdAt(root: string, sha: string): string {
  if (!git(root, ["cat-file", "-e", `${sha}^{commit}`]).ok) git(root, ["fetch", "--quiet", "origin", sha]);
  const paths = BUILD_ID_PATHS.filter((p) => git(root, ["cat-file", "-e", `${sha}:${p}`]).ok);
  const dir = mkdtempSync(join(tmpdir(), "cast-build-id-"));
  try {
    const tar = join(dir, "tree.tar");
    const archived = git(root, ["archive", "--format=tar", "-o", tar, sha, "--", ...paths]);
    if (!archived.ok) throw new Error(`git archive ${sha.slice(0, 10)} failed: ${archived.out}`);
    const x = spawnSync("tar", ["-xf", tar, "-C", dir], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    if (x.status !== 0) throw new Error(`tar failed: ${x.stderr}`);
    return computeDaemonBuildId(dir).id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type ForceDecision = { force: boolean; reason: string };

/** Force only when the daemon a machine would run changed between the two releases. */
export function decideForce(sha: string, previousSha: string | null, buildIdAt: (sha: string) => string): ForceDecision {
  if (!previousSha) return { force: true, reason: "no previous release is recorded on the deploy, so the daemon may have changed" };
  if (previousSha === sha) return { force: false, reason: "no force: same commit as the release before it" };
  const now = buildIdAt(sha);
  const before = buildIdAt(previousSha);
  return now === before
    ? { force: false, reason: `no force: daemon unchanged since ${previousSha.slice(0, 10)} (build ${now})` }
    : { force: true, reason: `daemon changed since ${previousSha.slice(0, 10)} (build ${before} -> ${now})` };
}

export type FleetDevice = { device_id: string; label: string; owner: string; cli_version: string | null; online: boolean; error: string | null };
/** teamCliFloor.fleet's answer: which of the team's machines run `version`. */
export type Fleet = { team: string; version: string; floor: string | null; took: FleetDevice[]; lagging: FleetDevice[]; offline: FleetDevice[]; cannot_update: FleetDevice[] };

/** Read the fleet until no online machine lags or the wait runs out; the last read. */
export async function waitForFleet(read: () => Promise<Fleet>, opts: { waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number }): Promise<Fleet> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.waitMs;
  for (;;) {
    const fleet = await read();
    if (!fleet.lagging.length || now() >= deadline) return fleet;
    await sleep(Math.min(opts.pollMs ?? 60_000, Math.max(0, deadline - now())));
  }
}

const named = (ds: FleetDevice[]) => ds.map((d) => `${d.label} (${d.owner}, ${d.cli_version ?? "?"}${d.error ? `: ${d.error}` : ""})`).join(", ");

/** The fleet as one note: who took it, and by name who lags, is offline or cannot update itself. */
export function fleetNote(f: Fleet): string {
  const lines = [`Fleet on ${f.version} (${f.team}): ${f.took.length} took it, ${f.lagging.length} lagging, ${f.offline.length} offline, ${f.cannot_update.length} cannot update themselves.`];
  if (f.lagging.length) lines.push(`Lagging: ${named(f.lagging)}`);
  if (f.offline.length) lines.push(`Offline: ${named(f.offline)}`);
  if (f.cannot_update.length) lines.push(`Cannot update: ${named(f.cannot_update)}`);
  return lines.join("\n");
}

export type FinishDeps = {
  root: string;
  deploy: string;
  version: string;
  waitMs: number;
  /** The authenticated CLI post (castApi.apiPost); throws on a refusal. */
  post: (path: string, body: Record<string, unknown>, opts?: { read?: boolean }) => Promise<any>;
  fromSession?: string;
  /** Raise the global floor; false when the caller is not platform staff (only staff may force every team's machines). */
  setGlobal?: (version: string) => Promise<boolean>;
  buildIdAt?: (sha: string) => string;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * The CLI target's finish. Returns the note it recorded on the deploy. A
 * deploy with no team (a personal workspace) has no fleet to force.
 */
export async function finishCliRelease(deps: FinishDeps): Promise<string> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const d = await deps.post("/cli/deploys/get", { ref: deps.deploy }, { read: true });
  if (!d) throw new Error(`No deploy ${deps.deploy} you can read`);
  if (!d.sha) throw new Error(`${deps.deploy} names no commit`);
  const decision = decideForce(d.sha, d.previous_sha ?? null, deps.buildIdAt ?? ((sha) => daemonBuildIdAt(deps.root, sha)));
  log(`Release ${deps.version}: ${decision.reason}`);
  const lines = [`Release ${deps.version}: ${decision.reason}`];
  // A daemon change reaches every team's machines (Union's included) when staff
  // run the finish; anyone else forces only the deploy's own team, and other
  // teams' Release Captains raise theirs.
  if (decision.force && deps.setGlobal && (await deps.setGlobal(deps.version))) {
    lines.push(`Forced everywhere: the global floor is now ${deps.version}.`);
    log(lines.at(-1)!);
  }
  if (decision.force && !d.team_id) lines.push("No team fleet to watch: the deploy belongs to no team.");
  if (decision.force && d.team_id) {
    const set = await deps.post("/cli/team-cli-floor/set", { team_id: d.team_id, version: deps.version, ...(deps.fromSession ? { from_session: deps.fromSession } : {}) });
    lines.push(set.changed ? `Forced: ${set.team}'s floor is now ${set.version}.` : `${set.team}'s floor already stands at ${set.version}.`);
    log(lines.at(-1)!);
    const read = () => deps.post("/cli/team-cli-floor/fleet", { team_id: d.team_id, version: deps.version, ...(deps.fromSession ? { from_session: deps.fromSession } : {}) }, { read: true }) as Promise<Fleet>;
    const fleet = await waitForFleet(read, { waitMs: deps.waitMs, sleep: deps.sleep, now: deps.now });
    lines.push(fleetNote(fleet));
    log(lines.at(-1)!);
  }
  const note = [d.note, lines.join("\n")].filter(Boolean).join("\n\n");
  await deps.post("/cli/line/deploy/report", { deploy: deps.deploy, status: "live", note });
  return note;
}
