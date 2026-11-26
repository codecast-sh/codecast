// A change run's page (flows.md, pl-1077): its headline, where the change stands and what it waits on, and the
// change's own facts as links: the pull request, its CI, its review, the commit it merged and the deploys that carry it.
// Everything here is read from structure, never from a station's free text: the journey the run card draws
// (journey.ts), the run's graph (stations by what they are, at any depth: Union's Change holds them inside its Land
// segment), the exit the run reached, and the verdicts, merge and deploys the run recorded. A reason in words stays in
// the bar under the track. Pure, with relative imports only: the phone's run page reads a run here too.
import { SEGMENT_SEP, takesSessionChange, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { entityRoute } from "@codecast/shared/entities";
import { journeyStages, targetsFromLine, type Journey, type TargetState } from "./journey";
import { gateWaitWords, holdWords, journeyWords, sentBackWords, stopTitle, type JourneyTone } from "./journeyWords";
import { landedSha } from "./runRecord";
import { deploysFocusHref, deploysHref, runFocus, runTeam } from "../deploys/focus";

type Status = { node_id: string; status?: string; result_preview?: string | null; started_at?: number; session?: { _id: string; title?: string | null } | null };
export type ChangeGraph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn>; kind?: string; takes?: ReadonlyArray<string> };

/** The run row's parts the page reads: what the PR, CI, review and merge stations recorded on it (convex workflow_runs). */
export type ChangeRun = {
  status?: string;
  workspace?: string | null;
  spawner_conversation_id?: string | null;
  pr?: { number: number; repository: string; head_sha?: string | null } | null;
  ci_verdict?: { green: boolean; ci_changed?: boolean; head_sha?: string | null } | null;
  review_verdict?: { verdict: string; head_sha?: string | null } | null;
  merge?: { sha?: string | null; pr_url?: string | null } | null;
  current_node_id?: string | null;
  waiting_on_session?: { node_id: string; conversation_id?: string | null } | null;
  gate_node_id?: string | null;
  gate_decision_id?: string | null;
  gate_decision_short_id?: string | null;
  fail_reason?: string | null;
  node_statuses?: ReadonlyArray<Status> | null;
};

/** The pull request as GitHub has it now (the store's pullRequests row), when the page has it. */
export type PrState = { merged: boolean; merge_sha: string | null } | null;

/**
 * Whether a run's page is the change's: a whole flow that takes a session's change and lands it (its journey plans a
 * land stage), as the run card's Ship flows do. A segment run (check, review, ship, deploy) keeps the run report.
 */
export function shipsChange(flow: ChangeGraph): boolean {
  return flow.kind === "line" && takesSessionChange({ takes: flow.takes ?? [] }) && journeyStages(flow as any).some((s) => s.role === "land");
}

/** The change's stations in its graph, by what each is: CI and Review are the command and the agent a fan-out starts
 *  side by side (and CI any other step under CI's name), Deploy every step of the Deploy stage. */
export type ChangeStations = { ci: Set<string>; review: Set<string>; deploy: Set<string> };
export function changeStations(graph: ChangeGraph): ChangeStations {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const heads = graph.nodes.filter((n) => n.type === "parallel_fanout").flatMap((f) => graph.edges.filter((e) => e.from === f.id).map((e) => byId.get(e.to)).filter(Boolean) as FlowNodeIn[]);
  const ciLabels = new Set(heads.filter((n) => n.type === "command").map((n) => n.label));
  const deployStage = journeyStages(graph as any).find((s) => s.role === "deploy")?.id;
  return {
    ci: new Set(graph.nodes.filter((n) => n.type === "command" && ciLabels.has(n.label)).map((n) => n.id)),
    review: new Set(heads.filter((n) => n.type === "agent").map((n) => n.id)),
    deploy: new Set(deployStage ? graph.nodes.filter((n) => n.id === deployStage || n.id.startsWith(`${deployStage}${SEGMENT_SEP}`)).map((n) => n.id) : []),
  };
}

const byNewest = (a: Status, b: Status) => (b.started_at ?? 0) - (a.started_at ?? 0);
const newestIn = (run: ChangeRun, ids: Set<string>): Status | undefined => [...(run.node_statuses ?? [])].filter((n) => ids.has(n.node_id)).sort(byNewest)[0];

const PR_URL = /https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/pull\/(\d+)/i;

/** The pull request the run opened: what it recorded on the run, else the newest step that reported one, else the merge's link. */
export function changePr(run: ChangeRun): { repository: string; number: number } | null {
  if (run.pr?.repository && run.pr.number) return { repository: run.pr.repository, number: run.pr.number };
  const said = [...(run.node_statuses ?? [])].sort(byNewest).map((n) => PR_URL.exec(n.result_preview ?? "")).find(Boolean);
  const m = said ?? PR_URL.exec(run.merge?.pr_url ?? "");
  return m ? { repository: m[1], number: Number(m[2]) } : null;
}

/** The head the run's pull request is on now: what the run recorded, else the newest step that reported the PR's head. */
export function currentHead(run: ChangeRun): string | null {
  if (run.pr?.head_sha) return run.pr.head_sha;
  for (const n of [...(run.node_statuses ?? [])].sort(byNewest)) {
    if (!PR_URL.test(n.result_preview ?? "")) continue;
    const m = (n.result_preview ?? "").match(/"head_sha"\s*:\s*"([0-9a-f]{7,40})"/);
    if (m) return m[1];
  }
  return null;
}

/** A verdict only while it is about the head the run is on: one read on an earlier head says nothing about this one. */
function current<T extends { head_sha?: string | null }>(v: T | null | undefined, head: string | null): T | null {
  if (!v) return null;
  return !v.head_sha || !head || v.head_sha === head ? v : null;
}

/** The Deploy stage's line that names targets ("Live: 31ccbb8 on web dp-12, cli dp-13."), newest first. */
export function deployLine(run: ChangeRun, stations: ChangeStations): string | null {
  const steps = [...(run.node_statuses ?? [])].filter((n) => stations.deploy.has(n.node_id) && n.result_preview).sort(byNewest);
  return steps.find((n) => targetsFromLine(n.result_preview).length)?.result_preview ?? null;
}

/** A step that only routes the run out of its segment (`{"exit": "changes"}`): its name is the outcome ("Changes asked"). */
const ROUTE_ONLY = /^\s*\{\s*"exit"\s*:/;

/** `words`: where the change stands; `waits`: what it waits on, or where and how it stopped, in a station and an outcome
 *  the graph names; `href`: where to act on what it waits on (the session fixing it, the card someone else answers, the
 *  deploy it waits for). A card the viewer answers is on the page already, in the bar under the track. */
export type ChangeHeadline = { words: string; waits: string | null; href: string | null; tone: JourneyTone };

/** "web, cli and mobile". */
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** What CI and the review found on the head the run is on, else the name of the way out its segment took ("Changes asked"). */
function foundWords(run: ChangeRun, graph: ChangeGraph): string | null {
  const head = currentHead(run);
  const ci = current(run.ci_verdict, head);
  const review = current(run.review_verdict, head)?.verdict;
  const said = [ci && !ci.green ? "CI red" : null, review === "changes" ? "review asked for changes" : review === "rejected" ? "review rejected it" : null].filter(Boolean) as string[];
  if (said.length) return sentence(said.join(", "));
  const route = [...(run.node_statuses ?? [])].filter((n) => n.status === "failed" && ROUTE_ONLY.test(n.result_preview ?? "")).sort(byNewest)[0];
  return route ? graph.nodes.find((n) => n.id === route.node_id)?.label ?? null : null;
}

/** The exit node a finished run ended at, by its label in the graph. */
function exitReached(run: ChangeRun, graph: ChangeGraph): string | null {
  const n = graph.nodes.find((x) => x.id === run.current_node_id);
  return n?.type === "exit" ? n.label : null;
}

/**
 * Where a stop happened, past the stage the bar names: the step inside a segment that failed doing its work ("PR" in
 * Land), then the outcome the graph names, the way out its segment took ("No pull request") or the exit it reached
 * ("Not merged"). Read from the run's last failures only: an earlier round's failure is not this stop.
 */
function stopDetail(run: ChangeRun, graph: ChangeGraph, title: string): string | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = [...(run.node_statuses ?? [])].filter((n) => byId.get(n.node_id) && byId.get(n.node_id)!.type !== "exit").sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  const failed: Status[] = [];
  for (let i = steps.length - 1; i >= 0 && steps[i].status === "failed"; i--) failed.unshift(steps[i]);
  const said = (label: string | null | undefined) => (label && !title.toLowerCase().includes(label.toLowerCase()) ? label : null);
  const work = failed.find((n) => !ROUTE_ONLY.test(n.result_preview ?? "") && n.node_id.includes(SEGMENT_SEP));
  const inner = said(work ? byId.get(work.node_id)!.label : null);
  const route = failed.find((n) => ROUTE_ONLY.test(n.result_preview ?? ""));
  const outcome = said(route ? byId.get(route.node_id)!.label : exitReached(run, graph));
  if (inner && outcome) return `${inner} · ${lower(outcome)}`;
  return inner ?? outcome;
}

/** The page's headline for a change run: where the change stands now, and what it waits on. */
export function changeHeadline(j: Journey, run: ChangeRun, graph: ChangeGraph, ctx: { pr?: PrState } = {}): ChangeHeadline {
  const n = j.now;
  const { tone } = journeyWords(j);
  const session = (id: string | null | undefined) => (id ? `/conversation/${id}` : null);
  const head = (words: string, waits: string | null = null, href: string | null = null, t: JourneyTone = tone): ChangeHeadline => ({ words, waits, href: waits ? href : null, tone: t });
  const fixing = (round: number | null, max: number | null) => `Its session is fixing it${round && max ? ` · round ${round} of ${max}` : ""}`;
  const card = n.kind === "gate" && n.decisionId ? `/decisions/${run.gate_decision_short_id ?? n.decisionId}` : null;
  const sha = landedSha(run);
  // A finished run ended where its exit says: a pushed flow older than its journey's rules can read Live where it Landed.
  const ended = run.status === "completed" ? exitReached(run, graph) : null;
  if (ended) {
    if (/^live$/i.test(ended)) {
      const on = n.kind === "live" && n.targets.length ? n.targets : targetsFromLine(deployLine(run, changeStations(graph))).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live", null, null, "ok");
    }
    return head(sha ? `${ended} ${sha.slice(0, 7)}` : ended, null, null, "ok");
  }
  switch (n.kind) {
    case "idle": return head("Not started");
    case "starting": return head("Starting");
    case "working": {
      // A station the session itself works (its fix) is the session's fix, whatever the track calls the stage.
      const at = graph.nodes.find((x) => x.id === run.current_node_id);
      if (at?.backend === "subject") return head(foundWords(run, graph) ?? at.label, fixing(null, null), session(run.waiting_on_session?.conversation_id ?? run.spawner_conversation_id), "session");
      return head(journeyWords(j).words);
    }
    case "session": {
      const fixer = session(n.conversation ?? run.spawner_conversation_id);
      if (n.blocked) {
        if (n.ask?.mine) return head("Waiting on your answer");
        return head(sentBackWords(n), n.ask ? "Open the card" : "Open its session", n.ask ? `/decisions/${n.ask.short_id ?? n.ask.id}` : fixer);
      }
      const found = n.what ? null : foundWords(run, graph);
      return head(n.what ?? found ?? sentBackWords(n), fixing(n.round, n.max), fixer, found && /\b(red|rejected)\b/i.test(found) ? "bad" : tone);
    }
    // The viewer's own card is answered in the bar under the track; someone else's opens, its question on the card.
    case "gate": return n.mine ? head("Waiting on your decision") : head(gateWaitWords(n.holder, n.who), "Open the card", card);
    case "landed": return head(`Merged ${n.sha.slice(0, 7)}`, holdWords(n.hold).words, deploysHref(run, n.line));
    case "deploying": {
      const going = n.targets.length ? n.targets : targetsFromLine(n.line).filter((t) => t.state !== "live").map((t) => t.name);
      return head(going.length ? `Deploying to ${listWords(going)}` : "Deploying");
    }
    case "live": {
      const on = n.targets.length ? n.targets : targetsFromLine(n.line).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live");
    }
    case "merged": return head(`${n.end ?? "Merged"} ${n.sha.slice(0, 7)}`);
    case "passed": return head("Done");
    // A PR GitHub merged outside the run is on main whatever the run's own exit says.
    case "unlanded": return head("Not merged", ctx.pr?.merged && !sha ? "PR merged on GitHub" : stopDetail(run, graph, "Not merged"));
    case "stopped":
    case "failed": {
      const title = stopTitle(n);
      return head(title, ctx.pr?.merged && !sha ? "PR merged on GitHub" : stopDetail(run, graph, title));
    }
  }
}

/** The one way on from a stop: what the run page offers beside it (the bar's place for its fix). */
export type StopAction = { kind: "newer" | "merge_switch" | "deploys" | "session" | "again" | "card"; label: string; href: string | null };

/** The merge station's refusal when the person's merge switch for the flow is off (convex lib/lineMerge.ts). */
const MERGE_OFF = /^(Stopped:\s*)?merge is off for this flow\b/;

/**
 * The way on from a stopped or unmerged change run. A newer run on the same task is where the change went; a merge
 * switched off is a person's switch; a stop at Deploy opens Deploys; one that wants the session's fix opens it. Ship
 * again only for an unplanned stop (fix "again") where another run can land something: never once the change is on
 * main (the run landed it, or its PR was merged) or may be. Otherwise the session that made the change, else the card
 * the run asked. Null for a run that is not stopped.
 */
export function stopAction(j: Journey, run: ChangeRun, ctx: { newer?: string | null; pr?: PrState } = {}): StopAction | null {
  const n = j.now;
  if (n.kind !== "stopped" && n.kind !== "failed" && n.kind !== "unlanded") return null;
  if (ctx.newer) return { kind: "newer", label: "Open the newer run", href: `/workflows/runs/${ctx.newer}` };
  const stop = n.kind === "unlanded" ? null : n;
  // Once GitHub merged the PR, merging is moot: the switch would change nothing for this change.
  if (MERGE_OFF.test(run.fail_reason ?? "") && !ctx.pr?.merged) return { kind: "merge_switch", label: "Turn merge on", href: "/org" };
  if (stop?.fix === "deploy") return { kind: "deploys", label: "Open Deploys", href: deploysHref(run, stop.why) };
  const subject = stop?.session ?? run.spawner_conversation_id ?? null;
  const session: StopAction | null = subject ? { kind: "session", label: "Open session", href: `/conversation/${subject}` } : null;
  if (stop?.fix === "session" && session) return session;
  // A deliberate stop (fix "run") repeats if run again: its session is the way on. Only an unplanned one runs again.
  const onMain = !!stop?.landed || !!stop?.mayHaveLanded || !!landedSha(run) || !!ctx.pr?.merged;
  if (!onMain && subject && (n.kind === "unlanded" || stop?.fix === "again")) return { kind: "again", label: "Ship again", href: null };
  if (session) return session;
  const card = run.gate_decision_short_id ?? run.gate_decision_id;
  return card ? { kind: "card", label: "Open the card", href: `/decisions/${card}` } : null;
}

export type ChangeLinkKind = "pr" | "ci" | "review" | "merged" | "deploy";
/** One fact about the change, as a link to where it lives. `tone`: ok (passed, live), bad (red, failed), wait (under way). */
export type ChangeLink = { kind: ChangeLinkKind; label: string; href: string; external: boolean; tone: "ok" | "bad" | "wait" | "default"; title: string };

const REVIEW_WORDS: Record<string, { label: string; tone: ChangeLink["tone"] }> = {
  ship: { label: "Review passed", tone: "ok" },
  changes: { label: "Review asked for changes", tone: "wait" },
  rejected: { label: "Review rejected", tone: "bad" },
};

/**
 * The change's facts as links, in the order the change meets them: its pull request, the CI on it, its review (the
 * reviewer's session), the commit it merged (the run's, else the one GitHub merged the PR as), and each deploy that
 * carries it (`targets`: where the deploy records put it, else the Deploy stage's own line). CI and review say a state
 * only from a verdict on the head the run is on, or while their station runs; with neither they are plain links.
 */
export function changeLinks(run: ChangeRun, graph: ChangeGraph, targets: ReadonlyArray<TargetState> = [], prState: PrState = null): ChangeLink[] {
  const out: ChangeLink[] = [];
  const stations = changeStations(graph);
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const head = currentHead(run);
  const pr = changePr(run);
  const prGithub = pr ? `https://github.com/${pr.repository}/pull/${pr.number}` : null;
  if (pr) out.push({ kind: "pr", label: `PR #${pr.number}`, href: entityRoute("pr", `${pr.repository}#${pr.number}`) ?? prGithub!, external: false, tone: "default", title: `${pr.repository}#${pr.number}` });
  const ciNode = newestIn(run, stations.ci);
  const ci = current(run.ci_verdict, head);
  const ciWords = live && ciNode?.status === "running" ? { label: "CI running", tone: "wait" as const }
    : ci ? (ci.green && ci.ci_changed ? { label: "CI green, not counted", tone: "default" as const, title: "This change edits CI, so CI can't vouch for it" } : ci.green ? { label: "CI green", tone: "ok" as const } : { label: "CI red", tone: "bad" as const })
    : ciNode ? { label: "CI", tone: "default" as const } : null;
  if (ciWords && prGithub) out.push({ kind: "ci", label: ciWords.label, tone: ciWords.tone, href: `${prGithub}/checks`, external: true, title: ("title" in ciWords && ciWords.title) || "The checks on the pull request, on GitHub" });
  const review = newestIn(run, stations.review);
  if (review?.session?._id) {
    const verdict = current(run.review_verdict, head)?.verdict ?? "";
    const words = live && review.status === "running" ? { label: "In review", tone: "wait" as const } : REVIEW_WORDS[verdict] ?? { label: "Review", tone: "default" as const };
    out.push({ kind: "review", ...words, href: `/conversation/${review.session._id}`, external: false, title: review.session.title ?? "The reviewer's session" });
  }
  const sha = landedSha(run) ?? (prState?.merged ? prState.merge_sha : null);
  const team = runTeam(run);
  if (sha) {
    const repo = pr?.repository ?? null;
    out.push({ kind: "merged", label: `Merged ${sha.slice(0, 7)}`, href: (repo && entityRoute("commit", `${repo}@${sha}`)) || deploysFocusHref({ team, focus: { kind: "sha", sha: sha.toLowerCase() } }), external: false, tone: "ok", title: sha });
  } else if (prState?.merged && pr) {
    out.push({ kind: "merged", label: "PR merged", href: entityRoute("pr", `${pr.repository}#${pr.number}`) ?? prGithub!, external: false, tone: "ok", title: "GitHub merged the pull request" });
  }
  const reach = targets.length ? targets : targetsFromLine(deployLine(run, stations));
  for (const t of reach) {
    const route = t.deploy ? entityRoute("deploy", t.deploy) : null;
    out.push({
      kind: "deploy",
      label: t.deploy ? `${t.name} ${t.deploy}` : `${t.name} waiting`,
      href: route ?? deploysFocusHref({ team, target: t.name, focus: runFocus(run) }),
      external: false,
      tone: t.state === "live" ? "ok" : t.state === "failed" ? "bad" : t.state === "deploying" ? "wait" : "default",
      title: t.state === "live" ? `Live on ${t.name}` : t.state === "deploying" ? `Going out to ${t.name}` : t.state === "failed" ? `Failed on ${t.name}` : `Not on ${t.name} yet`,
    });
  }
  return out;
}
