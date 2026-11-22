// A flow run placed on another of the user's machines (`cast flow run --device`,
// ct-98920). The whole run goes there: its runner, its worktree and every
// station, in that machine's checkout of the same repository (the server maps
// the folder: convex lib/runDevicePlace.ts). The change reaches it through git:
// the asking machine pushes the change's branch to origin, the run row carries
// the frozen change, and the target's `cast workflow run-daemon` fetches the
// branch, makes the run's worktree on it and leaves change.json where the
// runner reads it, as `cast flow run` does on the asking machine for a local run.
import * as fs from "node:fs";
import { spawnSync } from "../proc.js";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import type { FrozenChange } from "./flowChangeFile.js";

/** The words that keep a run on the asking machine, whatever default is set. */
const HERE = new Set(["here", "local", "this"]);

export type FlowDeviceConfig = { device?: string; devices?: Record<string, string> };

/**
 * The machine a flow run is placed on, as the person named it: `--device`, else this checkout's repository's default
 * (`flow.device.<owner>/<name>`), else the default for every repository (`flow.device`). Null keeps it on this machine.
 */
export function flowDeviceChoice(explicit: string | undefined, config: FlowDeviceConfig | undefined, origin: string | null): { name: string; from: string } | null {
  const pick = (name: string | undefined, from: string) => (name && !HERE.has(name.trim().toLowerCase()) ? { name: name.trim(), from } : null);
  if (explicit !== undefined) return pick(explicit, "--device");
  const repo = origin ? normalizeGitOrigin(origin) : null;
  const key = repo ? Object.keys(config?.devices ?? {}).find((k) => repoKeyMatches(k, repo)) : undefined;
  if (key) return pick(config!.devices![key], `flow.device.${key}`);
  return pick(config?.device, "flow.device");
}

/** Whether a configured repository key (`owner/name`, or a full origin) names `repo` (a normalized origin, host first). */
export function repoKeyMatches(key: string, repo: string): boolean {
  const k = key.trim().toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  return !!k && (repo === k || repo.endsWith(`/${k}`) || normalizeGitOrigin(key) === repo);
}

/** The checkout's origin URL, or null. */
export function originOf(dir: string): string | null {
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Put the change's branch on origin so the target machine can fetch it. Only a branch this run froze from a session's
 * edits is forced: it is the run's own, and each refreeze rewrites it. A branch the person named (or a task's) is
 * pushed as it is, so a copy here that is behind origin is refused rather than overwriting what was pushed there; a
 * pull request's is already on origin.
 */
export function pushChangeBranch(top: string, change: Pick<FrozenChange, "source" | "branch">): string | null {
  if (change.source === "pr") return null;
  const force = change.source === "session" ? "+" : "";
  const r = spawnSync("git", ["-C", top, "push", "--quiet", "origin", `${force}refs/heads/${change.branch}:refs/heads/${change.branch}`], { encoding: "utf-8" });
  if (r.status === 0) return null;
  const said = (r.stderr || r.stdout).trim();
  if (!force && /non-fast-forward|fetch first|rejected/i.test(said)) {
    return `origin's ${change.branch} has commits this copy lacks, so pushing it would lose them: pull them in (git fetch origin ${change.branch}, then rebase or merge), or name the pushed branch with --pr, then run this again`;
  }
  return `Could not push ${change.branch} to origin, so the other machine cannot fetch the change: ${said.split("\n").pop()}`;
}

export type CastRun = (args: string[], cwd: string) => Promise<{ code: number; out: string; err: string }>;

/**
 * On the run's machine, before the runner starts: the change's branch fetched from origin into this checkout, the
 * run's worktree made on it (or an earlier one moved to its tip), and change.json written to the run's directory.
 * Throws with why, which the run fails with.
 */
export async function preparePlacedChange(projectPath: string, runDir: string, placed: FrozenChange, cast: CastRun, runId?: string): Promise<FrozenChange> {
  if (!fs.existsSync(projectPath)) throw new Error(`The run's checkout ${projectPath} is not on this machine`);
  const { fetchBranch, UnpushedCommitsError } = await import("./flowChange.js");
  const { writeFrozenChange, acquireFailureWords } = await loadHelpers();
  // A worktree an earlier run of this change made, read before its branch moves: fetching moves the branch it has
  // checked out, and after that every difference between the old tip and the new one reads as uncommitted there.
  const earlierPath = (await cast(["ws", "path", placed.worktree], projectPath)).out.trim();
  const earlier = earlierPath && fs.existsSync(earlierPath) ? earlierPath : null;
  if (earlier) {
    const dirty = spawnSync("git", ["-C", earlier, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf-8" }).stdout.trim();
    if (dirty) throw new Error(`The run's worktree ${earlier} holds uncommitted work from an earlier run; finish or clear it before running this change again`);
  }
  let tip: string;
  try {
    tip = await fetchBranch(projectPath, placed.branch);
  } catch (err) {
    if (err instanceof UnpushedCommitsError) throw err;
    throw new Error(`Could not fetch ${placed.branch} from origin into ${projectPath}: ${err instanceof Error ? err.message.trim().split("\n").pop() : err}`);
  }
  const change: FrozenChange = { ...placed, tip, pushed: true, ...(runId ? { run: runId } : {}) };
  const ws = await cast(["ws", "acquire", change.worktree, "--branch", change.branch, "--skip-pool", "--json"], projectPath);
  if (ws.code !== 0) throw new Error(acquireFailureWords(change.worktree, ws.out, ws.err));
  if (earlier) spawnSync("git", ["-C", earlier, "reset", "--quiet", "--hard", tip]);
  writeFrozenChange(runDir, change);
  return change;
}

async function loadHelpers() {
  const { writeFrozenChange } = await import("./flowChangeFile.js");
  const { acquireFailureLine } = await import("../flowAcquire.js");
  return { writeFrozenChange, acquireFailureWords: acquireFailureLine };
}

/**
 * The one machine of the caller's that `name` names (a device id prefix, label or hostname), with whether it is
 * online; exits listing the candidates when it names none or several, and says so when it names a teammate's machine.
 */
export async function resolveOwnDevice(name: string, what = "--device"): Promise<{ device_id: string; name: string; online: boolean }> {
  const { convexClient } = await import("../remote/cli.js");
  const { pickOwnDevice } = await import("../migrate/pickDevice.js");
  const { client, token, api } = await convexClient();
  const devices: any[] = await client.query(api.devices.listDevices, { api_token: token });
  const d: any = await pickOwnDevice(devices, name, what, () => client.query(api.devices.listAgentBoxes, { api_token: token }));
  return { device_id: d.device_id, name: d.display_name || d.label || d.hostname || d.device_id.slice(0, 8), online: d.online !== false };
}

/**
 * `cast flow refreeze <run>`, run by the subject session in its own checkout: its edits frozen again onto the placed
 * run's branch, cut the way the run's change was cut (freezeSessionChange: a commit on the checkout's HEAD, with the
 * shared tree, its index and HEAD untouched), and the branch pushed for the run's machine to fetch.
 */
export async function refreezePlacedChange(top: string, placed: FrozenChange): Promise<FrozenChange> {
  if (placed.source !== "session") throw new Error(`This run's change is branch ${placed.branch}: commit the fix there and push it`);
  const { freezeSessionChange } = await import("./flowChange.js");
  const change = await freezeSessionChange(top, placed.conversation ?? placed.session!, { branch: placed.branch, worktree: placed.worktree, title: placed.title ?? null, only: placed.only ?? null });
  const refused = pushChangeBranch(top, change);
  if (refused) throw new Error(refused);
  return { ...change, pushed: true };
}

/**
 * The machine `cast flow run` places the run on, or null to run here: --device, else the configured default. Exits
 * with why when the machine is offline, or when --foreground (which runs here) meets a placement.
 */
export async function runDeviceFor(explicit: string | undefined, config: FlowDeviceConfig | undefined, top: string, foreground?: boolean): Promise<{ device_id: string; name: string; from: string } | null> {
  const choice = flowDeviceChoice(explicit, config, originOf(top));
  if (!choice) return null;
  const target = await resolveOwnDevice(choice.name, choice.from);
  const { deviceId } = await import("../remote/device.js");
  if (target.device_id === deviceId()) return null;
  if (foreground) { console.error(`--foreground runs here, and ${choice.from} places the run on ${target.name}: pass --device here to run it here`); process.exit(1); }
  if (!target.online) { console.error(`${target.name} is offline, so the run cannot start there (${choice.from}): bring its daemon back, or run with --device here`); process.exit(1); }
  return { device_id: target.device_id, name: target.name, from: choice.from };
}

/** The change sent to the run's machine: its branch pushed to origin, and the change left in a file `cast workflow run --change` reads. Exits with why a push is refused. */
export function handOffPlacedChange(top: string, runDir: string, change: FrozenChange): string {
  change.pushed = true;
  const refused = pushChangeBranch(top, change);
  if (refused) { console.error(refused); process.exit(1); }
  fs.mkdirSync(runDir, { recursive: true });
  const file = `${runDir}/placed-change.json`;
  fs.writeFileSync(file, JSON.stringify(change));
  return file;
}

/** `cast flow refreeze <run>`: this session's edits frozen again onto a placed run's branch and pushed (refreezePlacedChange). */
export async function refreezeRunCommand(runId: string, cwd: string, cliPost: (route: string, body: Record<string, any>) => Promise<any>): Promise<void> {
  const top = (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8" }).stdout ?? "").trim();
  if (!top) { console.error("cast flow refreeze works inside the git checkout the session's edits are in"); process.exit(1); }
  const got = await cliPost("/cli/workflow-runs/get", { run_id: runId }).catch((err: Error) => ({ error: err.message }));
  const placed = got?.run?.placed_change;
  if (!placed) { console.error(got?.error ? `Could not read run ${runId}: ${got.error}` : `Run ${runId} was not placed on another machine: it freezes the session's edits again on its own`); process.exit(1); }
  try {
    const change = await refreezePlacedChange(top, placed);
    console.log(`✓ ${change.paths.length} file${change.paths.length === 1 ? "" : "s"} frozen at ${change.tip.slice(0, 10)} on ${change.branch} and pushed; end your turn and the run fetches it`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
