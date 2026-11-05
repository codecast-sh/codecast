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

/** Where a target's command runs. */
export const DEPLOY_TARGET_RUNS = ["here", "push"] as const;
/**
 * - `here`: the machine that published the targets runs the command, in its checkout.
 * - `push`: the target deploys itself when main moves (Railway builds every push); there is no command to run.
 */
export type DeployTargetRuns = (typeof DEPLOY_TARGET_RUNS)[number];

/** Who starts a target's deploy: a person's press (the default), or CI on main going green. */
export const DEPLOY_TARGET_POLICIES = ["press", "auto"] as const;
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
   * When `cast ship checkout` runs the command itself: before or after its push (a backend the pushed client calls
   * deploys before), or `press`, never at a ship: only a deploy from codecast or a release script sends it.
   */
  ship_stage?: "before_push" | "after_push" | "press";
};

export const DEPLOY_TARGET_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export class DeployTargetError extends Error {}

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

const TARGET_KEYS = ["name", "ship", "run", "when", "runs", "live", "rollback", "policy"] as const;

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
export function parseDeployTargetEntries(raw: unknown, ship: readonly ShipStepRef[]): Array<{ target: DeployTarget; ship_step?: string }> {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object" || Array.isArray(raw)) throw new DeployTargetError("deploy.toml must be a TOML table");
  for (const key of Object.keys(raw)) if (key !== "target") throw new DeployTargetError(`unknown top-level key '${key}' (the file holds [[target]] tables)`);
  const list = (raw as Record<string, unknown>)["target"] ?? [];
  if (!Array.isArray(list)) throw new DeployTargetError("'target' must be an array of tables ([[target]])");
  const out: Array<{ target: DeployTarget; ship_step?: string }> = [];
  list.forEach((entry, i) => {
    const at = `target[${i}]`;
    try {
      const t = targetFromEntry(entry, ship);
      if (out.some((o) => o.target.name === t.name)) throw new DeployTargetError(`target ${t.name} is declared twice`);
      const step = (entry as Record<string, unknown>)["ship"];
      out.push({ target: t, ...(typeof step === "string" ? { ship_step: step } : {}) });
    } catch (err) {
      throw err instanceof DeployTargetError ? new DeployTargetError(`${at}: ${err.message}`) : err;
    }
  });
  return out;
}

function targetFromEntry(e: unknown, ship: readonly ShipStepRef[]): DeployTarget {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new DeployTargetError("must be a table");
  const r = e as Record<string, unknown>;
  for (const key of Object.keys(r)) if (!(TARGET_KEYS as readonly string[]).includes(key)) throw new DeployTargetError(`unknown key '${key}'`);
  for (const key of ["name", "ship", "run", "runs", "live", "rollback", "policy"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") throw new DeployTargetError(`'${key}' must be a string`);
  }
  const name = String(r["name"] ?? "").trim().toLowerCase();
  if (!DEPLOY_TARGET_NAME_RE.test(name)) throw new DeployTargetError(`name "${r["name"] ?? ""}" is not a target name (lowercase letters, digits and dashes)`);
  const step = r["ship"] !== undefined ? ship.find((s) => s.name === r["ship"]) : undefined;
  if (r["ship"] !== undefined && !step) throw new DeployTargetError(`target ${name}: ship = "${r["ship"]}" names no [[ship.deploy]] step in workspace.toml`);
  const whenRaw = r["when"] ?? step?.when ?? [];
  const when = typeof whenRaw === "string" ? [whenRaw] : whenRaw;
  if (!Array.isArray(when) || when.some((w) => typeof w !== "string")) throw new DeployTargetError(`target ${name}: 'when' must be a string or a list of strings`);
  const command = ((r["run"] as string | undefined) ?? step?.run ?? "").trim();
  const runs = (r["runs"] ?? "here") as DeployTargetRuns;
  if (!(DEPLOY_TARGET_RUNS as readonly string[]).includes(runs)) throw new DeployTargetError(`target ${name}: runs must be one of ${DEPLOY_TARGET_RUNS.join(", ")}`);
  if (runs === "here" && !command) throw new DeployTargetError(`target ${name}: runs = "here" needs run (or ship), the command that sends it`);
  const policy = (r["policy"] ?? "press") as DeployTargetPolicy;
  if (!(DEPLOY_TARGET_POLICIES as readonly string[]).includes(policy)) throw new DeployTargetError(`target ${name}: policy must be one of ${DEPLOY_TARGET_POLICIES.join(", ")}`);
  return {
    name,
    ...(command ? { command } : {}),
    runs,
    live: parseLiveReader(r["live"] as string | undefined),
    ...(r["rollback"] ? { rollback: r["rollback"] as string } : {}),
    policy,
    paths: when as string[],
    ship_stage: step?.stage ?? "press",
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

/** A glob over repository paths (`packages/convex/**`, `*.md`). */
export function globMatch(pattern: string, file: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`);
  return re.test(file);
}

/** Whether a commit ships to a target: it touches one of the target's paths. A commit whose files are unknown counts. */
export function commitTouchesTarget(paths: readonly string[], files: readonly string[] | null | undefined): boolean {
  if (!paths.length || !files?.length) return true;
  return files.some((f) => paths.some((p) => globMatch(p, f)));
}

// ── CI per commit ────────────────────────────────────────────────────────────

export type CommitCiState = "passed" | "failed" | "running" | "none";

export type CommitCiRun = { name: string; status: string; conclusion?: string | null; url?: string | null; at: number };

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

// ── the waiting queue ────────────────────────────────────────────────────────

export type QueueCommit = {
  sha: string;
  subject: string;
  at: number;
  author: string | null;
  session: { conversation_id: string; short_id: string | null; title: string | null } | null;
  tasks: Array<{ task_id: string; short_id: string | null; title: string | null }>;
  ci: CommitCiState;
  ci_url: string | null;
};

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
