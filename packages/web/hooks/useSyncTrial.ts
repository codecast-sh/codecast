// Trial projects (convex lineTrial.ts) for the /trial page: the workspace's
// trial cards and projects, each feed the whole set of one workspace (several
// workspaces can be fed at once: the line's For you lists every one), and each
// trial's spend, one row per project.
import type { ProposalCard } from "@codecast/shared/contracts/proposalCard";
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { ChangeCard } from "@codecast/shared/contracts/changeCard";
import { useSyncCollection } from "./useSyncCollection";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useActiveWorkspaceKey, useWorkspacesCollection } from "./useWorkspaceCollection";
import type { WorkspaceKey } from "../lib/workspaceScope";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import { trialHref } from "../lib/trialHref";
import type { JudgeFixCard } from "@codecast/shared/contracts/judgeFix";
import { currentOnly, type Superseded } from "@codecast/shared/contracts/superseded";

const api = _api as any;

export type TrialCardRow = {
  _id: string;
  workspace: string;
  short_id: string;
  project_id: string;
  project_title: string;
  task_id: string;
  task_short_id: string;
  task_title: string;
  /** The problem's written list name (cause.named), else null: rows name it by problemListName. */
  task_name?: string | null;
  task_status: string;
  run_id: string;
  run_status: string;
  node_id: string;
  kind: "card" | "gate";
  question: string;
  context_md?: string;
  doc_md?: string;
  options: Array<{ key: string; label: string; description?: string }>;
  card?: ChangeCard;
  /** A proposal gate's card (shared/contracts/proposalCard), when its words node wrote one. */
  proposal?: ProposalCard;
  /** The judge route's card (shared/contracts/judgeFix): a measured fix to a judge, its extractor or an expectation, for the project's reviewer. */
  judge_fix?: JudgeFixCard;
  /** The session decision the card is, when its station posted one (lineTrial.cards): the page to answer it on, and the session to talk to. */
  decision?: {
    _id: string; short_id: string | null; status: string; report_slug: string | null; session: { _id: string; short_id: string | null; title: string | null } | null;
  } | null;
  /** The role the card belongs to and the people it waits on, when it is not the trial owner's: a judge fix goes to its route's decider, who holds it in the team's decision inbox. */
  audience?: { asked: string[]; role: { _id: string; short_id: string | null; name: string; handle: string | null } } | null;
  /** The problem's evidence now (convex lib/problemEvidence); a card on a problem left with no findings reads stale. */
  evidence?: TrialEvidence | null;
  /** Set when the fix is codecast's own review machinery (a judge or an extractor), not the product: its card is not the executive's. */
  tooling?: "judge" | "extractor" | null;
  /** The findings the card cites, as they stand now (convex lineTrial.CitedCase). */
  cited?: TrialCited[];
  /** The rule the cited finding breaks, as the project's expectations word it now. */
  rule?: { id: string; text: string; part?: string } | null;
  /** Eval suites the change owes, which the trial never runs. */
  evals_owed?: string[];
  /** A change card's live conversations: reached, read and left out, arrived since the card, and findings gone since. */
  coverage?: { covered: number; other: number; fresh: number; gone: number } | null;
  /** A change card's branch and the repository a checkout publishes it from (convex lineTrial.cardBranch): its diff reads against `base`. */
  branch?: { repository: string; name: string; base: string } | null;
  /** Other open cards whose fix touches the same code. */
  overlaps?: Array<{ card: string; task: string; title: string; where: string; on?: "code" | "rule" }>;
  /** Sent back to rebuild on main (a stale base), and its run is on the way to the next card: the station it is at. */
  rebuilding?: { since: number; node: string | null } | null;
  /** The run waits at a gate its line no longer has (lineTrial.gateGone): held, with no answer to give. */
  stale_gate?: boolean;
  status: "waiting" | "answered" | "closed";
  /** Its problem was merged into another: that problem's newest card answers for this one now (closed). */
  superseded_by?: { card?: string; task: string } | null;
  /** Who answered: by_name is the person; via the agent session that carried it, when one did. */
  answer?: { key: string; label: string; note?: string; at: number; by: string; by_name?: string | null; stand_in?: boolean; via?: string | null };
  /** Findings joined its problem after the card was written: a count the card carries predates them. */
  regrouped?: boolean;
  /** Why the card no longer stands and what replaced it (docs/architecture/line-versions.md LV1); null while current. */
  superseded?: Superseded;
  created_at: number;
  updated_at: number;
};

/** The decision a trial card is, when its station posted one. */
export type TrialDecision = NonNullable<TrialCardRow["decision"]>;

/** A finding that left an emptied problem and how (convex lib/problemEvidence.WithdrawnFinding): `to` is the open problem holding it now. */
export type TrialWithdrawn = { short_id: string; title: string; quote?: string; at: number; fate: "rejudged" | "duplicate" | "found_wrong" | "moved" | "history" | "coaching" | "closed" | "other"; to?: string };

/** A finding a card cites, as it stands now: on the card's problem, on another, or withdrawn. */
export type TrialCited = { signal: string; state: "live" | "elsewhere" | "withdrawn" | "missing"; to?: string; fate?: TrialWithdrawn["fate"]; claim?: string; subject?: string };

export type TrialEvidence = { findings: number; conversations: number; withdrawn: number; moved_to: string[]; gone?: TrialWithdrawn[] };

/** A trial problem's latest run (convex lineTrial.runs), keyed by the problem. */
export type TrialRunRow = {
  _id: string;
  workspace: string;
  project_id: string;
  task_short_id: string;
  task_title: string;
  /** The problem's written list name (cause.named), else null: rows name it by problemListName. */
  task_name?: string | null;
  task_status: string;
  run_id: string;
  status: "pending" | "running" | "paused" | "completed" | "failed";
  node_id: string | null;
  fail_reason: string | null;
  fresh_branch: boolean;
  /** Reached Exit through a failure station with the problem still open (convex lineTrial.stopOf): the station, its last words, the findings still on it. */
  stopped?: { station: string; words: string; findings: number } | null;
  /** Died waiting at its own card (convex lineTrial.gateLossOf): the gate, the card it left, and which kind; a rerun picks up there. */
  lost_at_gate?: { node: string; card: string; kind: "gate" | "card" } | null;
  /** Why the run no longer stands (line-versions.md LV1); null while current. */
  superseded?: Superseded;
  created_at: number;
  updated_at: number;
};

/** A trial's dispatcher (convex lineTrial.dispatchFacts): its caps and why its last pass held; null when it starts nothing on its own. */
export type TrialDispatch = { cap_usd: number; max_runs: number | null; held: string | null; at: number | null } | null;
export type TrialProjectRow = { _id: string; workspace: string; title: string; short_id?: string; since: number; dispatch?: TrialDispatch };

/** One subscription account a trial's runs use (convex lineTrial.trialQuota): its windows as its machine last reported them. */
export type TrialQuotaRow = { device: string; provider: "claude" | "codex"; account: string; percent: number | null; windows: Array<{ label: string; percent: number; resets_at?: number }>; fetched_at: number | null; resets_at: number | null };

/** A trial's spend (convex lineTrial.spend): billed money and subscription use, two kinds that never add. */
export type TrialSpendRow = {
  _id: string;
  since: number;
  runs: number;
  /** The dispatcher's cap, on billed money only; null when it starts nothing on its own. */
  cap_usd: number | null;
  billed: {
    usd: number;
    /** The trial's own model calls (charged to its project); `team_budget` is the workspace month they draw from. */
    model: { usd: number; calls: number; by_purpose: { judge: number; grouping: number; call: number }; team_budget: { cap_usd: number; month: string; spent_usd: number; refused: number } };
    /** Hand entries (`cast line trial spend add`) by the key that billed them. */
    keys: Array<{ billed_by: string; usd: number; entries: number }>;
    run_sessions: { sessions: number; tokens: number; usd: number };
  };
  subscription: { sessions: number; tokens: number; list_usd: number; unpriced_tokens: number; providers: string[]; devices: string[] };
  outside: Array<{ usd: number; what: string; billed_by: string; at: number }>;
  quota: TrialQuotaRow[];
  at: number;
};

function useTeamArgs(workspace?: string | null) {
  const { args } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  // The workspace is named outright: lineTrial's reads take the CLI's scope
  // args, where a bare team_id falls back to the personal workspace.
  return useMemo(() => (teamId === "skip" ? "skip" : teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }), [teamId]);
}

/** A feed is the complete set of its workspace's rows: rows of other workspaces fed beside it stay. */
const wholeWorkspace = (key: string | null) => (key ? { isDelta: true, pruneAbsentScope: (r: { workspace?: string }) => r.workspace === key } : undefined);

/** Feeder: a workspace's trial cards, projects and runs; the active one unless `workspace` names another. */
export function useSyncTrial(workspace?: string | null) {
  const args = useTeamArgs(workspace);
  const { key } = useFeederWorkspace(workspace);
  const opts = useMemo(() => ({ syncOpts: wholeWorkspace(key) }), [key]);
  const cards = useSyncCollection("trialCards", api.lineTrial.cards, args as any, opts);
  useSyncCollection("trialProjects", api.lineTrial.projects, args as any, opts);
  useSyncCollection("trialRuns", api.lineTrial.runs, args as any, opts);
  return cards;
}

/** The query answers one project's row; the collection takes a list. */
const SPEND_OPTS = { select: (row: TrialSpendRow | null) => (row ? [row] : []) };

/** Feeder: one trial project's spend. */
export function useSyncTrialSpend(projectId: string | null) {
  const args = useTeamArgs();
  const queryArgs = useMemo(() => (args === "skip" || !projectId ? "skip" : { ...args, project: projectId }), [args, projectId]);
  return useSyncCollection("trialSpend", api.lineTrial.spend, queryArgs as any, SPEND_OPTS);
}

const cardSig = (r: TrialCardRow) => `${r.superseded?.why ?? ""}|${r.status}|${r.superseded_by?.card ?? r.superseded_by?.task ?? ""}|${r.answer?.key ?? ""}|${r.run_status}|${r.task_status}|${r.task_title}|${r.task_name ?? ""}|${r.updated_at}|${r.evidence ? `${r.evidence.findings}/${r.evidence.conversations}/${r.evidence.moved_to.join(",")}/${r.evidence.gone?.length ?? 0}` : ""}|${r.audience?.asked.join(",") ?? ""}`;

/** The workspaces a trial reader lists: those named, else the active one. */
function useReadKeys(workspaces?: readonly WorkspaceKey[]): readonly (WorkspaceKey | null)[] {
  const active = useActiveWorkspaceKey();
  return useMemo(() => workspaces ?? [active], [workspaces, active]);
}

/** Reader: the active workspace's trial cards (or `workspaces`'), newest first. Superseded cards are left out unless `all` (history readers: a problem's attempts, a card's own page). */
export function useTrialCards(opts: { all?: boolean; workspaces?: readonly WorkspaceKey[] } = {}): TrialCardRow[] {
  const rows = useWorkspacesCollection<TrialCardRow>("trialCards", cardSig, useReadKeys(opts.workspaces));
  const all = !!opts.all;
  return useMemo(() => currentOnly(rows, all).sort((a, b) => b.created_at - a.created_at), [rows, all]);
}

const runSig = (r: TrialRunRow) => `${r.superseded?.why ?? ""}|${r.status}|${r.run_id}|${r.node_id}|${r.fail_reason}|${r.task_title}|${r.task_name ?? ""}|${r.updated_at}|${r.stopped?.findings ?? ""}|${r.stopped?.words ?? ""}`;

/** Reader: the active workspace's trial runs (or `workspaces`'), the latest per problem, newest first. Superseded runs are left out unless `all`. */
export function useTrialRuns(opts: { all?: boolean; workspaces?: readonly WorkspaceKey[] } = {}): TrialRunRow[] {
  const all = !!opts.all;
  const rows = useWorkspacesCollection<TrialRunRow>("trialRuns", runSig, useReadKeys(opts.workspaces));
  return useMemo(() => currentOnly(rows, all).sort((a, b) => b.updated_at - a.updated_at), [rows, all]);
}

/** Reader: the active workspace's trial projects (or `workspaces`'). */
export function useTrialProjects(workspaces?: readonly WorkspaceKey[]): TrialProjectRow[] {
  return useWorkspacesCollection<TrialProjectRow>("trialProjects", projectSig, useReadKeys(workspaces));
}
const projectSig = (r: TrialProjectRow) => `${r.title}|${r.since}|${r.dispatch === undefined ? "?" : r.dispatch ? `${r.dispatch.held ?? ""}|${r.dispatch.cap_usd}|${r.dispatch.max_runs ?? ""}` : "off"}`;

/** Reader: one trial project's spend. A row cached in an earlier shape reads as not there yet, until the server's arrives. */
export function useTrialSpend(projectId: string | null): TrialSpendRow | null {
  const s = useTrackedStore([(st) => (projectId ? (st as any).trialSpend?.[projectId]?.at : null)]);
  const row: TrialSpendRow | null = projectId ? ((s as any).trialSpend?.[projectId] ?? null) : null;
  return row?.billed?.model?.team_budget && row.subscription ? row : null;
}

/** /trial opened on one trial project, in the workspace it lives in (lib/trialHref), so the link lands on that trial
 *  whatever workspace the app sits on. The project row the store holds names both; without it, plain /trial. */
export function useTrialHref(projectId: string | null | undefined, card?: string | null, tab?: string | null): string {
  const row = useInboxStore((s) => {
    if (!projectId) return null;
    const p = (s.projects as Record<string, { short_id?: string; workspace?: string | null }> | undefined)?.[projectId]
      ?? ((s as { trialProjects?: Record<string, { short_id?: string; workspace?: string | null }> }).trialProjects?.[projectId]);
    return p ? `${p.workspace ?? ""}|${p.short_id ?? projectId}` : null;
  });
  // Pressed on /line, the trial page leads back to the very item (lib/trialHref `from`).
  const from = typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;
  if (!row) return trialHref({ card, tab, from });
  const [workspace, project] = row.split("|");
  return trialHref({ workspace: workspace || null, project, card, tab, from });
}
