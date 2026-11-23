// What a link into /deploys points at, and which IDs the waiting queue shows.
// A chip clicked anywhere (a PR, a commit, a task, a session, a deploy) opens
// the page with that thing highlighted: on the target that has it, in the
// queue while it waits, or on the deploy in History that took it out. The
// IDs the queue shows and the filters both columns share ride the same
// address (show=, mine=, group=), so a link opens the page as its sender saw
// it.
import type { QueueCommit } from "@codecast/shared/contracts/deployTargets";
import type { DeployReach, ReachState } from "@codecast/shared/contracts/deployReach";
import { prNumberOf } from "@codecast/shared/changes";
import { deploysOf, type DeployTargetRow, type TeamDeployRow } from "./targets";
import { PICKABLE_GROUPS, type ChangeGroupId, type ChangeRow } from "../changes/rows";

export type DeployLabel = "pr" | "sha" | "task" | "session" | "branch";
export const DEPLOY_LABELS: ReadonlyArray<{ id: DeployLabel; word: string }> = [
  { id: "pr", word: "PR" },
  { id: "sha", word: "SHA" },
  { id: "task", word: "Task" },
  { id: "session", word: "Session" },
  { id: "branch", word: "Branch" },
];
const DEFAULT_LABELS: DeployLabel[] = ["pr", "sha"];

export type DeployFocus =
  | { kind: "pr"; pr: number }
  | { kind: "sha"; sha: string }
  | { kind: "task"; id: string }
  | { kind: "session"; id: string }
  | { kind: "branch"; name: string }
  | { kind: "deploy"; id: string };

/** Every kind of thing a link can point at, each read from the address param of its own name. One list, so the reader,
 *  the clear button and the page's remount key never disagree about what a link is made of. */
export const FOCUS_PARAMS = ["deploy", "pr", "sha", "task", "session", "branch"] as const satisfies ReadonlyArray<DeployFocus["kind"]>;

type Params = { get(name: string): string | null };

/** The one thing a link names, read from its address. A deploy wins, then a PR, a commit, a task, a session. */
export function focusOf(p: Params): DeployFocus | null {
  const deploy = p.get("deploy")?.trim();
  if (deploy) return { kind: "deploy", id: deploy };
  const pr = Number(p.get("pr")?.replace(/^#/, ""));
  if (Number.isInteger(pr) && pr > 0) return { kind: "pr", pr };
  const sha = p.get("sha")?.trim().toLowerCase();
  if (sha && /^[0-9a-f]{4,40}$/.test(sha)) return { kind: "sha", sha };
  const task = p.get("task")?.trim();
  if (task) return { kind: "task", id: task };
  const session = p.get("session")?.trim();
  if (session) return { kind: "session", id: session };
  const branch = p.get("branch")?.trim();
  if (branch) return { kind: "branch", name: branch };
  return null;
}

/** The IDs the queue shows: the address's own choice, else PR and SHA, plus whatever kind the link points at. */
export function labelsOf(p: Params, focus: DeployFocus | null): DeployLabel[] {
  const named = p.get("show");
  if (named !== null) {
    const asked = new Set(named.split(",").map((s) => s.trim()));
    return DEPLOY_LABELS.map((l) => l.id).filter((id) => asked.has(id));
  }
  const extra = focus && focus.kind !== "deploy" ? [focus.kind] : [];
  return DEPLOY_LABELS.map((l) => l.id).filter((id) => DEFAULT_LABELS.includes(id) || extra.includes(id));
}

/** What both columns are narrowed to: the viewer's own, and one group of what is on its way. */
export type DeployFilters = { mine: boolean; group: ChangeGroupId | null };

/** The filters an address names (`mine=1`, `group=you`); anything else reads as none. */
export function filtersOf(p: Params): DeployFilters {
  const group = p.get("group") as ChangeGroupId | null;
  return { mine: p.get("mine") === "1", group: group && PICKABLE_GROUPS.includes(group) ? group : null };
}

/** The filters as address params; a filter that is off drops its param. */
export const filterParams = (f: DeployFilters): Record<"mine" | "group", string | null> => ({ mine: f.mine ? "1" : null, group: f.group });

const sameSession = (s: { conversation_id: string; short_id?: string | null } | null | undefined, id: string) =>
  !!s && (s.conversation_id === id || (!!s.short_id && s.short_id === id));

/** Whether a waiting commit is the thing the link names. */
export function commitMatches(c: Pick<QueueCommit, "sha" | "subject" | "tasks" | "session" | "branch">, f: DeployFocus | null): boolean {
  if (!f) return false;
  switch (f.kind) {
    case "pr": return prNumberOf(c.subject) === f.pr;
    case "sha": return c.sha.toLowerCase().startsWith(f.sha);
    case "task": return c.tasks.some((t) => t.short_id === f.id || t.task_id === f.id);
    case "session": return sameSession(c.session, f.id);
    case "branch": return c.branch === f.name;
    case "deploy": return false;
  }
}

/**
 * Whether a change on its way is the thing the link names: its pull request, one of its commits, its branch, or a
 * session that wrote it (by its conversation id or the short id that is that id's first seven characters).
 */
export function changeMatches(r: Pick<ChangeRow, "refs" | "writers">, f: DeployFocus | null): boolean {
  if (!f) return false;
  const refs = r.refs;
  switch (f.kind) {
    case "pr": return refs?.pr === f.pr;
    case "sha": return !!refs?.shas.some((s) => s.toLowerCase().startsWith(f.sha));
    case "branch": return refs?.branch === f.name;
    case "session": {
      const id = f.id.toLowerCase();
      return !!r.writers?.some((w) => !!w.conversation_id && (w.conversation_id === f.id || (id.length >= 7 && w.conversation_id.toLowerCase().startsWith(id))));
    }
    default: return false;
  }
}

/** Whether a deploy is, or took out, the thing the link names. */
export function deployMatches(d: Pick<TeamDeployRow, "short_id" | "sha" | "commit_rows" | "tasks" | "sessions">, f: DeployFocus | null): boolean {
  if (!f) return false;
  const rows = d.commit_rows ?? [];
  switch (f.kind) {
    case "deploy": return d.short_id === f.id;
    case "pr": return rows.some((c) => prNumberOf(c.subject) === f.pr);
    case "sha": return (d.sha ?? "").toLowerCase().startsWith(f.sha) || rows.some((c) => c.sha.toLowerCase().startsWith(f.sha));
    case "task": return (d.tasks ?? []).some((t) => t.short_id === f.id) || rows.some((c) => c.tasks?.includes(f.id));
    case "session": return d.sessions.some((s) => sameSession(s, f.id)) || rows.some((c) => c.conversation_id === f.id);
    // A deploy's record does not keep the branches its commits came from.
    case "branch": return false;
  }
}

/** The server's reach ref for a PR or commit link (`owner/repo#N`, `owner/repo@sha`); a task, session or deploy has none. */
export function focusRef(f: DeployFocus | null, repository: string | null): string | null {
  if (!f || !repository) return null;
  return f.kind === "pr" ? `${repository}#${f.pr}` : f.kind === "sha" ? `${repository}@${f.sha}` : null;
}

/**
 * Whether the target a link opens is settled, so the page can pin it and stop following live data: the thing waits
 * on a target, or it is a kind reach does not cover, or its reach is in hand. A PR or commit that waits nowhere is
 * only guessed from deploy records (which list a deploy's newest commits) until its reach arrives.
 */
export function focusSettled(targets: ReadonlyArray<DeployTargetRow>, f: DeployFocus | null, reach: DeployReach | null | undefined): boolean {
  if (!f) return false;
  if (f.kind !== "pr" && f.kind !== "sha") return true;
  return !!reach || targets.some((t) => t.queue.groups.some((g) => g.commits.some((c) => commitMatches(c, f))));
}

/**
 * The target a page opens: by id (a rail press, a pinned link), else by `owner/repo#name` (a link that names its
 * repository, so two repositories' same-named targets stay apart), else by bare name, else the first.
 */
export function pickTarget<T extends Pick<DeployTargetRow, "_id" | "name" | "repository">>(ordered: ReadonlyArray<T>, want: string | null): T | null {
  if (want) {
    const hit = ordered.find((t) => t._id === want) ?? ordered.find((t) => `${t.repository}#${t.name}` === want) ?? ordered.find((t) => t.name === want);
    if (hit) return hit;
  }
  return ordered[0] ?? null;
}

/** How an address names its target: with its repository when it names one. */
export const targetKey = (target: string | null | undefined, repository: string | null | undefined): string | null =>
  target ? (repository ? `${repository}#${target}` : target) : null;

/** A reach ref (`owner/repo#N`, `owner/repo@sha`) read back as the repository and the thing a Deploys link points at. */
export function focusOfRef(ref: string): { repository: string; focus: DeployFocus } | null {
  const pr = /^([^#@\s]+\/[^#@\s]+)#(\d+)$/.exec(ref);
  if (pr) return { repository: pr[1]!, focus: { kind: "pr", pr: Number(pr[2]) } };
  const sha = /^([^#@\s]+\/[^#@\s]+)@([0-9a-f]{4,40})$/i.exec(ref);
  return sha ? { repository: sha[1]!, focus: { kind: "sha", sha: sha[2]!.toLowerCase() } } : null;
}

/** A deploy a change's reach names (any target's), so a link that names only its repository finds its team. */
export function reachAnyDeploy(reach: DeployReach | null | undefined): string | null {
  for (const t of reach?.targets ?? []) { const d = t.deploy ?? t.now; if (d?.short_id) return d.short_id; }
  return null;
}

/** The repository a link means: the one it names, else the one every target of the team deploys. */
export function focusRepository(named: string | null | undefined, targets: ReadonlyArray<Pick<DeployTargetRow, "repository">>): string | null {
  if (named) return named;
  const repos = new Set(targets.map((t) => t.repository).filter(Boolean));
  return repos.size === 1 ? [...repos][0]! : null;
}

/** Which target a reader of a change wants first: one still taking it, then one it waits on, then where it went wrong, then where it is live. */
const REACH_ORDER: ReachState[] = ["going_out", "queued", "waiting", "failed", "rolled_back", "live"];

/**
 * The target to open for a link: the first, in page order, still waiting on the thing; else, for a PR or commit, the
 * one its reach puts first (the newest deploy breaks a tie); else the one whose deploy took it out most recently.
 */
export function focusTarget(targets: ReadonlyArray<DeployTargetRow>, deploys: ReadonlyArray<TeamDeployRow>, f: DeployFocus | null, reach?: DeployReach | null): DeployTargetRow | null {
  if (!f || f.kind === "deploy") return null;
  const waiting = targets.find((t) => t.queue.groups.some((g) => g.commits.some((c) => commitMatches(c, f))));
  if (waiting) return waiting;
  if (reach?.targets.length) {
    const ranked = reach.targets
      .map((r) => ({ r, t: targets.find((t) => t.name === r.target) }))
      .filter((x): x is { r: (typeof reach.targets)[number]; t: DeployTargetRow } => !!x.t)
      .sort((a, b) => REACH_ORDER.indexOf(a.r.state) - REACH_ORDER.indexOf(b.r.state) || (b.r.deploy?.at ?? 0) - (a.r.deploy?.at ?? 0));
    if (ranked[0]) return ranked[0].t;
  }
  let best: { t: DeployTargetRow; at: number } | null = null;
  for (const t of targets) {
    const d = deploysOf(t, deploys).find((x) => deployMatches(x, f));
    if (d && (!best || d.created_at > best.at)) best = { t, at: d.created_at };
  }
  return best?.t ?? null;
}

/** The deploy on one target that holds a PR or commit, by its reach; null when reach says none does. */
export function reachDeployOn(reach: DeployReach | null | undefined, target: string): { short_id: string; state: ReachState } | null {
  const r = reach?.targets.find((x) => x.target === target);
  return r?.deploy ? { short_id: r.deploy.short_id, state: r.state } : null;
}

/** How the page names the thing a link points at, in its own chip. */
export function focusWord(f: DeployFocus): string {
  switch (f.kind) {
    case "pr": return `#${f.pr}`;
    case "sha": return f.sha.slice(0, 7);
    case "branch": return f.name;
    default: return f.id;
  }
}

/** A link into /deploys at one thing, on a team and target when the caller knows them. */
export function deploysFocusHref(o: { team?: string | null; repository?: string | null; target?: string | null; focus?: DeployFocus | null; show?: ReadonlyArray<DeployLabel> | null; filters?: DeployFilters | null }): string {
  const q = new URLSearchParams();
  if (o.team) q.set("team", o.team);
  if (o.repository) q.set("repo", o.repository);
  if (o.target) q.set("target", o.target);
  const f = o.focus;
  if (f) q.set(f.kind, f.kind === "pr" ? String(f.pr) : f.kind === "sha" ? f.sha : f.kind === "branch" ? f.name : f.id);
  if (o.show) q.set("show", o.show.join(","));
  if (o.filters) for (const [k, v] of Object.entries(filterParams(o.filters))) if (v) q.set(k, v);
  const s = q.toString();
  return `/deploys${s ? `?${s}` : ""}`;
}

/**
 * The Deploys page for a run's team, at the thing the run sent: the deploy its words name ("web dp-12", on that
 * target), else the commit it landed, else its session.
 */
export function deploysHref(run: any, words?: string | null): string {
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  const named = words?.match(/(?:\b([a-z][a-z0-9-]{0,31}) )?\b(dp-\d+)/);
  // "going out in dp-13" names a deploy but not its target; the page finds that from the deploy.
  const target = named?.[1] && named[1] !== "in" ? named[1] : null;
  return deploysFocusHref({ team, target, focus: named ? { kind: "deploy", id: named[2]! } : runFocus(run) });
}

/** What a run's change is on the Deploys page: the commit it landed on main, else the session that started it. */
export function runFocus(run: any): DeployFocus | null {
  const sha = run?.merge?.sha;
  if (typeof sha === "string" && sha) return { kind: "sha", sha: sha.toLowerCase() };
  return run?.spawner_conversation_id ? { kind: "session", id: String(run.spawner_conversation_id) } : null;
}
