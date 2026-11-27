// A repository's deploy targets (docs/architecture/deploys.md DP10): the one
// declared list of the places its code goes live, each with how it is sent,
// where that runs, how codecast reads what is live there, how it rolls back,
// and who starts it.
//
// The list is the checkout's own config: the `[[target]]` tables of
// .codecast/deploy.toml (codecast's backend, web, CLI release, mobile OTA,
// desktop), and a line profile's `[line.deploy]` (Union) as one more. Both normalize here, so the CLI that
// runs a target, the server that records it and the Deploys page that shows
// it read the same shape.
import { parseDuration } from "../time";
import { parseRelease } from "../changes/classify";
import type { SessionPriorityRef } from "./priorities";

/** Where a target's command runs. */
export const DEPLOY_TARGET_RUNS = ["here", "push"] as const;
/**
 * - `here`: the machine that published the targets runs the command, in its checkout.
 * - `push`: the target deploys itself when main moves (Railway builds every push); there is no command to run.
 */
export type DeployTargetRuns = (typeof DEPLOY_TARGET_RUNS)[number];

/**
 * Who starts a target's deploy:
 * - `press` (the default): a person sends it by name (its Deploy button, `cast deploy <name>`).
 * - `release`: it goes out with every release of main (`cast deploy`, which /cast-deploy runs) and when a change flow
 *   lands a change that touches it (the Deploy segment with `send="release"`). A person may still send it by name.
 * - `auto`: the server sends it from its publishing machine once CI on main's head is green.
 */
export const DEPLOY_TARGET_POLICIES = ["press", "release", "auto"] as const;
export type DeployTargetPolicy = (typeof DEPLOY_TARGET_POLICIES)[number];

/**
 * How codecast learns what runs on a target, as a config string:
 *
 * - `marker`: the last deploy recorded live (the deploy path reports it: deploy.sh, a run's watch station).
 * - `github-status:<context>`: the commit status GitHub shows for a deploy on the default branch (Railway posts
 *   `codecast - web`), and GitHub deployments on the environment of the same name.
 * - `json:<url>#<sha field>[,<version field>]`: a document that names the commit it was built from
 *   (a release's latest.json `sourceCommit`, a web build's /version.json `sha`, an api's /health `gitSha`).
 */
export type DeployLiveReader =
  | { kind: "marker" }
  | { kind: "github-status"; context: string }
  | { kind: "json"; url: string; sha_field: string; version_field?: string };

export type DeployTarget = {
  /** The target's name, as deploys and markers name it: `backend`, `web`, `cli`. */
  name: string;
  /** What sends it, run from the checkout's root; `$sha`, `$deploy` and `$actor` expand. Absent for a `push` target. */
  command?: string;
  runs: DeployTargetRuns;
  live: DeployLiveReader;
  /** What puts the previous version back, when a redeploy of an earlier sha cannot. */
  rollback?: string;
  policy: DeployTargetPolicy;
  /** Repository paths whose change this target ships; empty means every path. */
  paths: string[];
  /**
   * Paths under `paths` that ship nothing here (tests, fixtures): a change whose files under `paths` are all among them
   * sends no deploy of this target, and goes out with its next one. The CLI's duties and the server's reach and queue
   * read it through the one matcher, fileShipsTo.
   */
  unless?: string[];
  /**
   * When `cast ship checkout` runs the command itself: before or after its push (a backend the pushed client calls
   * deploys before), or `press`, never at a ship: only a deploy from codecast or a release script sends it.
   */
  ship_stage?: "before_push" | "after_push" | "press";
  /** Targets that must be live with the same commit before this one is sent (a mobile update after the backend it calls). */
  after?: string[];
  /** Before the send: the deploy sha's verdict, as the line-deploy graph's CI station runs it (`cast line deploy ci`). */
  ci?: string;
  /** After the send: the gate's verdict on what went out (evals, a canary), e.g. `cast line deploy follow --jobs gate`. */
  gate?: string;
  /** After the gate: the rollout finishing, e.g. `cast line deploy follow --jobs deploy`. */
  rollout?: string;
  /** Once live: what follows a deploy (raising the fleet's minimum CLI to the version that went out). `$version` expands. */
  finish?: string;
  /** How long a change flow's Deploy stage waits for it to go live before calling the deploy stuck, in ms (deployDeadlineMs). */
  deadline?: number;
  /**
   * The GitHub Actions workflow file every deploy of this target runs as (`deploy.yml`), whoever starts it: each run
   * on the default branch is a deploy (running, then live, failed or cancelled), so one dispatched by hand shows too.
   */
  workflow?: string;
  /**
   * What a rollback adds to `sha` and `actor` when codecast dispatches `workflow` itself (`{ components = "backend-web" }`):
   * a rollback sends only what can go back to an earlier commit.
   */
  rollback_inputs?: Record<string, string>;
  /** The CI workflow file (`ci.yml`) whose pass on main makes a commit green: a rollback's pause lifts on it. */
  ci_workflow?: string;
};

/** The keys a target holds that only the CLI reads: the server stores the rest. */
export const CLI_ONLY_TARGET_KEYS = ["after", "ci", "gate", "rollout", "finish", "deadline"] as const;

/** A target as the server's publish takes it. */
export function publishableTarget(t: DeployTarget): Omit<DeployTarget, (typeof CLI_ONLY_TARGET_KEYS)[number]> {
  const { after: _a, ci: _c, gate: _g, rollout: _r, finish: _f, deadline: _d, ...rest } = t;
  return rest;
}

/** The longest `deadline` a target may set: a day, as long as a change waits for a person to send it. */
export const MAX_DEPLOY_DEADLINE_MS = 24 * 60 * 60_000;

/**
 * The longest a change flow's Deploy stage waits in all, whatever holds a target before its own deadline starts (red
 * main, an `after` target still going out): the longest deadline and an hour. The station parks, so the wait holds no
 * slot; the deploy segment's station times out 15 minutes after it.
 */
export const DEPLOY_WAIT_CAP_MS = MAX_DEPLOY_DEADLINE_MS + 60 * 60_000;

/**
 * How long a change flow's Deploy stage waits for a target to go live: its `deadline`, else a day for one a person or
 * a role sends (`others`: a press target, the line profile's own), an hour for one the stage sends (a release builds
 * and publishes) and half an hour for one that deploys itself (a push or auto deploy).
 */
export function deployDeadlineMs(t: Pick<DeployTarget, "deadline" | "policy" | "runs">, others = false): number {
  if (t.deadline) return t.deadline;
  if (others) return MAX_DEPLOY_DEADLINE_MS;
  return t.runs === "here" && t.policy === "release" ? 60 * 60_000 : 30 * 60_000;
}

export const DEPLOY_TARGET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class DeployTargetError extends Error {}

/**
 * What the server's refusal of a deploy request says when the machine that publishes the target is another person's
 * (deployTargetRequest.ts): a change run elsewhere reads it to say which machine sends the target.
 */
export const NOT_YOUR_MACHINE = "which is not yours";

/** A live reader from its config string; throws DeployTargetError on one it cannot read. */
export function parseLiveReader(raw: string | null | undefined): DeployLiveReader {
  const s = (raw ?? "").trim();
  if (!s || s === "marker") return { kind: "marker" };
  if (s.startsWith("github-status:")) {
    const context = s.slice("github-status:".length).trim();
    if (!context) throw new DeployTargetError(`live "${s}" names no status context`);
    return { kind: "github-status", context };
  }
  if (s.startsWith("json:")) {
    const rest = s.slice("json:".length).trim();
    const hash = rest.lastIndexOf("#");
    const url = hash > 0 ? rest.slice(0, hash) : rest;
    if (!/^https:\/\/\S+$/.test(url)) throw new DeployTargetError(`live "${s}" needs an https url`);
    const [sha_field, version_field] = (hash > 0 ? rest.slice(hash + 1) : "sha").split(",").map((f) => f.trim());
    if (!sha_field) throw new DeployTargetError(`live "${s}" names no sha field`);
    return { kind: "json", url, sha_field, ...(version_field ? { version_field } : {}) };
  }
  throw new DeployTargetError(`live "${s}" is not marker, github-status:<context> or json:<url>#<field>`);
}

export function formatLiveReader(r: DeployLiveReader): string {
  if (r.kind === "marker") return "marker";
  if (r.kind === "github-status") return `github-status:${r.context}`;
  return `json:${r.url}#${r.sha_field}${r.version_field ? `,${r.version_field}` : ""}`;
}

/** A field of a JSON document by dotted path (`build.sha`). */
export function readJsonField(doc: unknown, field: string): string | null {
  let at: any = doc;
  for (const k of field.split(".")) at = at && typeof at === "object" ? at[k] : undefined;
  return typeof at === "string" && at.trim() ? at.trim() : typeof at === "number" ? String(at) : null;
}

/** What a json live reader says runs: the commit, when it names a real one, and the version. */
export function readJsonLive(r: Extract<DeployLiveReader, { kind: "json" }>, doc: unknown): { sha: string | null; version: string | null } {
  const sha = readJsonField(doc, r.sha_field);
  return { sha: sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.toLowerCase() : null, version: r.version_field ? readJsonField(doc, r.version_field) : null };
}

/** A `[[ship.deploy]]` step of .codecast/workspace.toml, as far as a target needs it. */
export type ShipStepRef = { name: string; when: string[]; run: string; stage: "before_push" | "after_push" };

const TARGET_KEYS = ["name", "ship", "run", "when", "unless", "runs", "live", "rollback", "policy", "after", "ci", "gate", "rollout", "finish", "deadline", "workflow", "rollback_inputs", "ci_workflow"] as const;
/** The step commands a target may give its deploy (DP13), each run like `run`. */
const STEP_KEYS = ["ci", "gate", "rollout", "finish"] as const;

/** A workflow file's name as `.github/workflows/` holds it. */
export const DEPLOY_WORKFLOW_RE = /^[A-Za-z0-9_.-]+\.ya?ml$/;

/**
 * The `[[target]]` tables of .codecast/deploy.toml as targets. The file is the targets' own: workspace.toml keeps
 * the schema every released CLI reads, so a target never puts a key there that an older CLI refuses. A target that
 * the ship sends names its step (`ship = "convex"`) and takes that step's command, paths and stage; it may still
 * say `when` or `run` itself. Throws DeployTargetError naming the table on anything it cannot read.
 */
export function parseDeployTargets(raw: unknown, ship: readonly ShipStepRef[]): DeployTarget[] {
  return parseDeployTargetEntries(raw, ship).map((e) => e.target);
}

/** The same, each with the [[ship.deploy]] step that sends it at a ship. */
export function parseDeployTargetEntries(raw: unknown, ship: readonly ShipStepRef[]): Array<{ target: DeployTarget; ship_step?: string; unknown?: string[] }> {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new DeployTargetError("deploy.toml must be a TOML table");
  for (const key of Object.keys(raw)) if (key !== "target") throw new DeployTargetError(`unknown top-level key '${key}' (the file holds [[target]] tables)`);
  const list = (raw as Record<string, unknown>)["target"] ?? [];
  if (!Array.isArray(list)) throw new DeployTargetError("'target' must be an array of tables ([[target]])");
  const out: Array<{ target: DeployTarget; ship_step?: string; unknown?: string[] }> = [];
  list.forEach((entry, i) => {
    const at = `target[${i}]`;
    try {
      const t = targetFromEntry(entry, ship);
      // A key a newer CLI added is read past, never refused, so a file written for it still deploys here (DP10).
      const unknown = entry && typeof entry === "object" ? Object.keys(entry).filter((k) => !(TARGET_KEYS as readonly string[]).includes(k)) : [];
      if (out.some((o) => o.target.name === t.name)) throw new DeployTargetError(`target ${t.name} is declared twice`);
      const shared = t.workflow ? out.find((o) => o.target.workflow === t.workflow) : undefined;
      if (shared) throw new DeployTargetError(`target ${t.name}: workflow ${t.workflow} is already target ${shared.target.name}'s; a run of it is one deploy of one target`);
      const step = (entry as Record<string, unknown>)["ship"];
      out.push({ target: t, ...(typeof step === "string" ? { ship_step: step } : {}), ...(unknown.length ? { unknown } : {}) });
    } catch (err) {
      throw err instanceof DeployTargetError ? new DeployTargetError(`${at}: ${err.message}`) : err;
    }
  });
  releaseOrder(out.map((o) => o.target));
  return out;
}

/**
 * Targets in the order a release sends them: each after every target its `after` names. Throws DeployTargetError on a
 * name no target declares, and on a cycle.
 */
export function releaseOrder<T extends Pick<DeployTarget, "name" | "after">>(targets: readonly T[]): T[] {
  const byName = new Map(targets.map((t) => [t.name, t]));
  const out: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: T, path: string[]) => {
    if (state.get(t.name) === "done") return;
    if (state.get(t.name) === "visiting") throw new DeployTargetError(`targets wait on each other: ${[...path, t.name].join(" after ")}`);
    state.set(t.name, "visiting");
    for (const a of t.after ?? []) {
      const dep = byName.get(a);
      if (!dep) throw new DeployTargetError(`target ${t.name}: after names ${a}, which is not a target`);
      visit(dep, [...path, t.name]);
    }
    state.set(t.name, "done");
    out.push(t);
  };
  for (const t of targets) visit(t, []);
  return out;
}

function targetFromEntry(e: unknown, ship: readonly ShipStepRef[]): DeployTarget {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new DeployTargetError("must be a table");
  const r = e as Record<string, unknown>;
  for (const key of ["name", "ship", "run", "runs", "live", "rollback", "policy", ...STEP_KEYS, "deadline", "workflow", "ci_workflow"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") throw new DeployTargetError(`'${key}' must be a string`);
  }
  const name = String(r["name"] ?? "").trim().toLowerCase();
  if (!DEPLOY_TARGET_NAME_RE.test(name)) throw new DeployTargetError(`name "${r["name"] ?? ""}" is not a target name (lowercase letters, digits and dashes)`);
  const step = r["ship"] !== undefined ? ship.find((s) => s.name === r["ship"]) : undefined;
  if (r["ship"] !== undefined && !step) throw new DeployTargetError(`target ${name}: ship = "${r["ship"]}" names no [[ship.deploy]] step in workspace.toml`);
  const whenRaw = r["when"] ?? step?.when ?? [];
  const when = typeof whenRaw === "string" ? [whenRaw] : whenRaw;
  if (!Array.isArray(when) || when.some((w) => typeof w !== "string")) throw new DeployTargetError(`target ${name}: 'when' must be a string or a list of strings`);
  const unlessRaw = r["unless"] ?? [];
  const unless = typeof unlessRaw === "string" ? [unlessRaw] : unlessRaw;
  if (!Array.isArray(unless) || unless.some((w) => typeof w !== "string")) throw new DeployTargetError(`target ${name}: 'unless' must be a string or a list of strings`);
  // globMatch reads braces as themselves, so `packages/{web,cli}/**` would match nothing and miss every deploy.
  for (const [key, globs] of [["when", when], ["unless", unless]] as const) {
    const braced = (globs as string[]).find((g) => g.includes("{"));
    if (braced) throw new DeployTargetError(`target ${name}: '${key}' glob "${braced}" uses braces, which deploy paths do not expand: list each path on its own`);
  }
  const command = ((r["run"] as string | undefined) ?? step?.run ?? "").trim();
  const runs = (r["runs"] ?? "here") as DeployTargetRuns;
  if (!(DEPLOY_TARGET_RUNS as readonly string[]).includes(runs)) throw new DeployTargetError(`target ${name}: runs must be one of ${DEPLOY_TARGET_RUNS.join(", ")}`);
  if (runs === "here" && !command) throw new DeployTargetError(`target ${name}: runs = "here" needs run (or ship), the command that sends it`);
  const policy = (r["policy"] ?? "press") as DeployTargetPolicy;
  if (!(DEPLOY_TARGET_POLICIES as readonly string[]).includes(policy)) throw new DeployTargetError(`target ${name}: policy must be one of ${DEPLOY_TARGET_POLICIES.join(", ")}`);
  const afterRaw = r["after"] ?? [];
  const after = typeof afterRaw === "string" ? [afterRaw] : afterRaw;
  if (!Array.isArray(after) || after.some((a) => typeof a !== "string")) throw new DeployTargetError(`target ${name}: 'after' must be a target name or a list of them`);
  const steps = STEP_KEYS.filter((k) => typeof r[k] === "string" && (r[k] as string).trim());
  if (runs === "push" && steps.length) throw new DeployTargetError(`target ${name}: runs = "push" sends nothing, so it has no ${steps.join(" or ")} step`);
  let deadline: number | undefined;
  if (typeof r["deadline"] === "string") {
    try { deadline = parseDuration(r["deadline"]); } catch { throw new DeployTargetError(`target ${name}: deadline "${r["deadline"]}" is not a duration (30m, 1h30m)`); }
    if (deadline > MAX_DEPLOY_DEADLINE_MS) throw new DeployTargetError(`target ${name}: deadline "${r["deadline"]}" is over 24h; a deploy that takes longer is stuck`);
  }
  const workflow = typeof r["workflow"] === "string" ? r["workflow"].trim().replace(/^\.github\/workflows\//, "") : "";
  if (r["workflow"] !== undefined && !DEPLOY_WORKFLOW_RE.test(workflow)) throw new DeployTargetError(`target ${name}: workflow "${r["workflow"]}" is not a workflow file (deploy.yml)`);
  const ciWorkflow = typeof r["ci_workflow"] === "string" ? r["ci_workflow"].trim().replace(/^\.github\/workflows\//, "") : "";
  if (r["ci_workflow"] !== undefined && !DEPLOY_WORKFLOW_RE.test(ciWorkflow)) throw new DeployTargetError(`target ${name}: ci_workflow "${r["ci_workflow"]}" is not a workflow file (ci.yml)`);
  const rollbackInputs = r["rollback_inputs"];
  if (rollbackInputs !== undefined && (!rollbackInputs || typeof rollbackInputs !== "object" || Array.isArray(rollbackInputs) || Object.values(rollbackInputs).some((x) => typeof x !== "string"))) {
    throw new DeployTargetError(`target ${name}: rollback_inputs must be a table of strings ({ components = "backend-web" })`);
  }
  if (rollbackInputs !== undefined && !workflow) throw new DeployTargetError(`target ${name}: rollback_inputs are inputs of its workflow, and it names none`);
  return {
    name,
    ...(command ? { command } : {}),
    runs,
    live: parseLiveReader(r["live"] as string | undefined),
    ...(r["rollback"] ? { rollback: r["rollback"] as string } : {}),
    policy,
    paths: when as string[],
    ...(unless.length ? { unless: unless as string[] } : {}),
    ship_stage: step?.stage ?? "press",
    ...(after.length ? { after: (after as string[]).map((a) => a.trim().toLowerCase()) } : {}),
    ...Object.fromEntries(steps.map((k) => [k, (r[k] as string).trim()])),
    ...(deadline ? { deadline } : {}),
    ...(workflow ? { workflow } : {}),
    ...(rollbackInputs ? { rollback_inputs: { ...(rollbackInputs as Record<string, string>) } } : {}),
    ...(ciWorkflow ? { ci_workflow: ciWorkflow } : {}),
  };
}

/** A line profile's `[line.deploy]` as a target: the line's one deploy path. */
export function targetFromLineDeploy(d: { command?: string | null; target?: string | null; live?: string | null } | null | undefined): DeployTarget | null {
  if (!d?.command) return null;
  const name = (d.target ?? "deploy").trim().toLowerCase() || "deploy";
  return { name, command: d.command, runs: "here", live: { kind: "marker" }, policy: "press", paths: [] };
}

/** Whether a deploy of a given earlier sha can be sent: only a command that takes `$sha` sends anything but the tree it runs in. */
export function canRedeploySha(t: Pick<DeployTarget, "command">): boolean {
  return !!t.command && /\$sha\b/.test(t.command);
}

// ── paths ────────────────────────────────────────────────────────────────────

/** A glob over repository paths (`packages/convex/**`, `*.md`, `**\/*.test.ts`): `**\/` is any directories, none included. */
export function globMatch(pattern: string, file: string): boolean {
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(`^${re}$`).test(file);
}

/** A target's paths, as far as which files it ships. */
export type TargetPaths = { paths?: readonly string[]; unless?: readonly string[] };

/**
 * Whether one file ships to a target: under one of its paths (every path when it names none) and not among what its
 * `unless` exempts. A path as written matches itself before it is read as a glob (`app/task/[id].tsx`, ct-102468).
 */
export function fileShipsTo(t: TargetPaths, file: string): boolean {
  const hit = (globs: readonly string[]) => globs.some((g) => g === file || globMatch(g, file));
  return (!t.paths?.length || hit(t.paths)) && !(t.unless?.length && hit(t.unless));
}

/** Whether a commit ships to a target: it touches a file the target ships. A commit whose files are unknown counts. */
export function commitTouchesTarget(t: TargetPaths, files: readonly string[] | null | undefined): boolean {
  if ((!t.paths?.length && !t.unless?.length) || !files?.length) return true;
  return files.some((f) => fileShipsTo(t, f));
}

/**
 * A release target's own version bump for the version live there now: the release workflow commits it to main after
 * the cut it records (finalize-cli-release.yml's `chore(cli): bump version to X`, cut-desktop-release.yml's
 * `chore(electron): bump desktop to vX`), so it carries nothing the live deploy lacks. Precisely: its subject names that
 * version as a release, and every file it changes that ships to the target is a package.json (the version it bumps).
 */
export function isLiveVersionBump(t: TargetPaths, c: { subject: string; files: readonly string[] | null | undefined }, liveVersion: string | null | undefined): boolean {
  const live = liveVersion?.trim().replace(/^v/i, "");
  if (!live || !c.files?.length) return false;
  if (parseRelease(c.subject.split("\n")[0])?.version !== live) return false;
  const shipped = c.files.filter((f) => fileShipsTo(t, f));
  return shipped.length > 0 && shipped.every((f) => f === "package.json" || f.endsWith("/package.json"));
}

// ── CI per commit ────────────────────────────────────────────────────────────

export type CommitCiState = "passed" | "failed" | "running" | "none";

export type CommitCiRun = { name: string; status: string; conclusion?: string | null; url?: string | null; at: number };

/**
 * Whether a commit_ci row speaks in a deploy, rollback or red-main decision. Our own runner's rows (`kind: "runner"`,
 * ct-102083) run in shadow beside GitHub's and decide nothing until ct-102084 flips this one place.
 */
export function ciRowDecides(row: { kind: string }): boolean {
  return row.kind !== "runner";
}

const CI_PASS = new Set(["success", "neutral", "skipped"]);
const CI_SILENT = new Set(["cancelled", "stale", "action_required"]);

/**
 * One commit's CI from its runs (each workflow's newest run, each other app's suite): failed when any finished red,
 * running while any is going, passed when every one finished green, none with no run. A cancelled run (a newer
 * push superseded it) says nothing.
 */
export function commitCiState(runs: readonly CommitCiRun[]): CommitCiState {
  const newest = new Map<string, CommitCiRun>();
  for (const r of runs) {
    const prev = newest.get(r.name);
    if (!prev || r.at >= prev.at) newest.set(r.name, r);
  }
  const judged = [...newest.values()].filter((r) => !(r.status === "completed" && CI_SILENT.has(r.conclusion ?? "")));
  if (!judged.length) return "none";
  if (judged.some((r) => r.status === "completed" && !CI_PASS.has(r.conclusion ?? ""))) return "failed";
  if (judged.some((r) => r.status !== "completed")) return "running";
  return "passed";
}

/**
 * A targets view row's `dev_push`: uncommitted work prod runs on top of the target's live deploy, the dev watcher's
 * push saved last after that deploy went live. Null when none has since.
 */
export type TargetDevPush = {
  sha: string;
  machine: string | null;
  /** The pusher's name. */
  by: string | null;
  /** The last save. */
  at: number;
  dirty: number;
  adds_count: number;
  drops_count: number;
};

// ── the waiting queue ────────────────────────────────────────────────────────

export type QueueCommit = {
  sha: string;
  subject: string;
  at: number;
  author: string | null;
  /**
   * The session that wrote it: its Codecast-Session trailer, or (`via: "task"`) the newest session on the task it names.
   * `user_id`: the session's owner. `priority`: the priority it serves, for a team with priorities on and a viewer who may read it, else null.
   */
  session: { conversation_id: string; short_id: string | null; title: string | null; user_id?: string; priority?: SessionPriorityRef | null; via?: "task" } | null;
  tasks: Array<{ task_id: string; short_id: string | null; title: string | null }>;
  /** The branch the change came from: its pull request's head, else the branch its session worked on (never the default branch). */
  branch?: string | null;
  /** Lines added and removed, absent when nothing recorded them (deployTargetsState commitLines). */
  insertions?: number;
  deletions?: number;
  /** The pull request it came from: its own record, its linked pull request, else the "(#N)" its subject names. */
  pr_number?: number | null;
  /** Its place in main's order (commits.main_at): the queue's order, never committer time. */
  main_at: number;
  ci: CommitCiState;
  ci_url: string | null;
};

/** One Ship run still on its way to main, as the Deploys page's Shipping column reads it (workflow_runs.shippingRuns). */
export type ShippingRun = {
  _id: string;
  status: "running" | "paused" | "failed" | "pending";
  task_id: string | null;
  task_short_id: string | null;
  task_title: string | null;
  workflow_slug: string | null;
  workflow_label: string | null;
  current_node_id: string | null;
  current_node_label: string | null;
  node_statuses: Array<{ node_id: string; status: "pending" | "running" | "completed" | "failed" }>;
  pr: { repository: string; number: number; first_head_sha: string; head_sha: string; at: number } | null;
  fail_reason: string | null;
  /** The CI station's verdict and the reviewer's, as their stations reported them; the merge once it landed. */
  ci_verdict?: { green: boolean; head_sha: string; at: number } | null;
  /** `head_sha`: the head the reviewer read; a verdict binds to it (verdictOnHead). */
  review_verdict?: { verdict: string; at: number; head_sha?: string } | null;
  /** Heads the Merge station only rebased onto main (`from` the judged head, `to` the one it pushed): a verdict on `from` holds on `to`. */
  station_rebases?: ReadonlyArray<{ from: string; to: string }> | null;
  /** The personal flow's Check station's verdict (its check.json): pass or skipped is green, fail is not; null before it reports. */
  check_verdict?: { green: boolean; at: number } | null;
  /** How the run's flow lands a change, read from its graph: through a pull request (a `pr` station, or Union's `land` segment) or straight to main. */
  track?: "pr" | "direct";
  merge?: { sha: string; branch: string; into: string; at: number; pr_url?: string } | null;
  gate_prompt: string | null;
  /** The gate the run waits at, when it waits at one. */
  gate_node_id?: string | null;
  gate_decision_short_id: string | null;
  gate_decision_status: string | null;
  /** The spawner is a stand-in (the project lead's standing session), not the session that pressed Ship. */
  stand_in?: boolean;
  spawner_conversation_id: string | null;
  primary_conversation_id: string | null;
  project_path: string | null;
  user_id: string;
  created_at: number;
  updated_at: number;
};

/**
 * Who pressed Ship on a change run of the last 30 days, unmerged or merged in that window: the page credits a commit
 * on main to that session, by `merged_sha` exactly, else by its task. `user_id`: that session's owner, only for a
 * viewer who may read it (a stand-in's run: its runner); titles come from the page's own session pills. `stand_in`: no
 * session started the run, the spawner is the project lead's standing session.
 */
export type ShippingShipper = {
  run_id: string;
  task_short_id: string | null;
  merged_sha: string | null;
  spawner_conversation_id: string | null;
  user_id: string | null;
  stand_in: boolean;
  created_at: number;
};

export type ShippingRuns = { runs: ShippingRun[]; shippers: ShippingShipper[] };

export type QueueGroup = {
  /** "s:<conversation id>" for one session's commits, "none" for commits no session claims. */
  key: string;
  session: QueueCommit["session"];
  commits: QueueCommit[];
  ci: CommitCiState;
};

/** The worst CI state among commits: failed over running over none over passed. */
export function worstCi(states: readonly CommitCiState[]): CommitCiState {
  for (const s of ["failed", "running", "none"] as const) if (states.includes(s)) return s;
  return states.length ? "passed" : "none";
}

/** Commits waiting on a target, grouped by the session that wrote them, the group with the newest commit first. */
export function groupQueueBySession(commits: readonly QueueCommit[]): QueueGroup[] {
  const groups = new Map<string, QueueGroup>();
  for (const c of commits) {
    const key = c.session ? `s:${c.session.conversation_id}` : "none";
    const g = groups.get(key) ?? { key, session: c.session, commits: [], ci: "none" as CommitCiState };
    g.commits.push(c);
    groups.set(key, g);
  }
  const out = [...groups.values()].map((g) => ({ ...g, commits: [...g.commits].sort((a, b) => b.at - a.at), ci: worstCi(g.commits.map((c) => c.ci)) }));
  return out.sort((a, b) => (a.key === "none" ? 1 : 0) - (b.key === "none" ? 1 : 0) || b.commits[0].at - a.commits[0].at);
}

/**
 * Whether a verdict read on `judged` holds on `head`: the same head, or one the Merge station only rebased it onto
 * (`rebases`, followed in order). A review binds to the head it read, so a fix round's new head has none until a
 * reviewer reads it. The run page's Review link, a PR's header and its Shipping rail all judge by this.
 */
export function verdictOnHead(judged: string, head: string, rebases: ReadonlyArray<{ from: string; to: string }> | null | undefined = []): boolean {
  let at = judged;
  for (const r of rebases ?? []) if (r.from === at) at = r.to;
  return at === head || judged === head;
}

/**
 * A run as judged on its pull request's real head: GitHub's (the pullRequests row) when known, which a push the run
 * has not recorded yet (Resolve conflict's force-push) moves past the run's own `pr.head_sha`. The Shipping rail, the
 * Deploys cards and the run page read a run through this, so each judges its verdicts on the head the PR's header does.
 */
export function onPrHead<R extends { pr?: { head_sha?: string | null } | null }>(run: R, head: string | null | undefined): R {
  if (!head || !run.pr || run.pr.head_sha === head) return run;
  return { ...run, pr: { ...run.pr, head_sha: head } };
}
