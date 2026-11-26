// A change run's page (flows.md, pl-1077): its headline, where the change stands and what it waits on, read from the
// journey the run card draws (journey.ts), and the change's own facts as links: the pull request, its CI, its review,
// the commit it merged and the deploys that carry it, each read from what the run's stations recorded. Stations are
// found by what they are in the run's graph, at any depth (Union's Change holds them inside its Land segment), never by
// their ids. Pure, with relative imports only: the phone's run page reads a run here too.
import { SEGMENT_SEP, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { entityRoute } from "@codecast/shared/entities";
import { journeyStages, targetsFromLine, verdictsOf, type Journey, type TargetState } from "./journey";
import { gateWaitWords, holdWords, journeyWords, readableWhy, sentBackWords, stopWords, type JourneyTone } from "./journeyWords";
import { landedSha } from "./runRecord";
import { deploysFocusHref, deploysHref, runFocus, runTeam } from "../deploys/focus";

type Status = { node_id: string; status?: string; result_preview?: string | null; started_at?: number; session?: { _id: string; title?: string | null } | null };
export type ChangeGraph = { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> };

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
  gate_decision_short_id?: string | null;
  fail_reason?: string | null;
  node_statuses?: ReadonlyArray<Status> | null;
};

/** The change's stations in its graph, by what each is: CI and Review are the command and the agent a fan-out starts
 *  side by side (and CI any other step under CI's name), Deploy every step of the Deploy stage. */
export type ChangeStations = { ci: Set<string>; review: Set<string>; deploy: Set<string> };
export function changeStations(graph: ChangeGraph): ChangeStations {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const heads = graph.nodes.filter((n) => n.type === "parallel_fanout").flatMap((f) => graph.edges.filter((e) => e.from === f.id).map((e) => byId.get(e.to)).filter(Boolean) as FlowNodeIn[]);
  const ciHeads = heads.filter((n) => n.type === "command");
  const ciLabels = new Set(ciHeads.map((n) => n.label));
  const deployStage = journeyStages(graph as any).find((s) => s.role === "deploy")?.id;
  return {
    ci: new Set(graph.nodes.filter((n) => n.type === "command" && ciLabels.has(n.label)).map((n) => n.id)),
    review: new Set(heads.filter((n) => n.type === "agent").map((n) => n.id)),
    deploy: new Set(deployStage ? graph.nodes.filter((n) => n.id === deployStage || n.id.startsWith(`${deployStage}${SEGMENT_SEP}`)).map((n) => n.id) : []),
  };
}

/** The newest step among `ids`. */
const newestIn = (run: ChangeRun, ids: Set<string>): Status | undefined =>
  [...(run.node_statuses ?? [])].filter((n) => ids.has(n.node_id)).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];

/** A step that only routes the run out of its segment (`{"exit": "changes"}`): its name is the outcome ("Changes asked"). */
const ROUTE_ONLY = /^\s*\{\s*"exit"\s*:/;

/** `words`: where the change stands; `waits`: what it waits on or why it stopped, short, when something does; `href`:
 *  where to act on it (the session fixing it, the card someone else answers, the deploy it waits for). A card the viewer
 *  answers is on the page already, under the head. */
export type ChangeHeadline = { words: string; waits: string | null; href: string | null; tone: JourneyTone };

/** "web, cli and mobile". */
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What CI and the review found when they sent the change back: the verdicts the run recorded, else the name of the way
 *  out its segment took ("Changes asked"). */
function foundWords(run: ChangeRun, graph: ChangeGraph): string | null {
  const red = run.ci_verdict ? !run.ci_verdict.green : null;
  const review = run.review_verdict?.verdict;
  const said = [red ? "CI red" : null, review === "changes" ? "review asked for changes" : review === "rejected" ? "review rejected it" : null].filter(Boolean) as string[];
  if (said.length) return sentence(said.join(", "));
  const route = [...(run.node_statuses ?? [])].filter((n) => n.status === "failed" && ROUTE_ONLY.test(n.result_preview ?? "")).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
  return route ? graph.nodes.find((n) => n.id === route.node_id)?.label ?? null : null;
}

/**
 * Why a run stopped, short enough to read in the head: the clause before its detail (the reason's first ": ", or the
 * first " | " a joined error log breaks on), at most ~100 characters. The whole reason stays in the bar under the track.
 */
export function shortWhy(raw: string | null | undefined): string | null {
  const why = readableWhy(raw, true);
  if (!why) return null;
  const head = why.split(" | ")[0];
  const colon = head.indexOf(": ");
  let s = colon >= 8 ? head.slice(0, colon) : head;
  if (s.length > 100) s = s.slice(0, 100).replace(/\s+\S*$/, "") + "…";
  return s.replace(/[.:;,]\s*$/, "");
}

/** The station a stopped run stopped at, named as the graph names it: in the failures it ended on, the first step that
 *  failed doing its work, else the way out its segment took ("CI unread"), which names an outcome rather than a station. */
function stoppedAt(run: ChangeRun, graph: ChangeGraph): { label: string; outcome: boolean } | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = [...(run.node_statuses ?? [])].filter((n) => byId.get(n.node_id) && byId.get(n.node_id)!.type !== "exit").sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  // The run's last failures, back to the last step that did not fail: an earlier round's failure is not this stop.
  const failed: Status[] = [];
  for (let i = steps.length - 1; i >= 0 && steps[i].status === "failed"; i--) failed.unshift(steps[i]);
  const work = failed.find((n) => !ROUTE_ONLY.test(n.result_preview ?? ""));
  if (work) return { label: byId.get(work.node_id)!.label, outcome: false };
  return failed[0] ? { label: byId.get(failed[0].node_id)!.label, outcome: true } : null;
}

/** The page's headline for a change run: where the change stands now, and what it waits on. */
export function changeHeadline(j: Journey, run: ChangeRun, graph: ChangeGraph): ChangeHeadline {
  const n = j.now;
  const { tone } = journeyWords(j);
  const session = (id: string | null | undefined) => (id ? `/conversation/${id}` : null);
  const head = (words: string, waits: string | null = null, href: string | null = null, t: JourneyTone = tone): ChangeHeadline => ({ words, waits, href: waits ? href : null, tone: t });
  const fixing = (round: number | null, max: number | null) => `Waiting on its session's fix${round && max ? `, round ${round} of ${max}` : ""}`;
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
      if (n.blocked) return head(n.ask?.mine ? "Waiting on your answer" : sentBackWords(n), n.ask?.question ?? (n.note || null), n.ask ? (n.ask.mine ? null : `/decisions/${n.ask.short_id ?? n.ask.id}`) : fixer);
      const found = n.what ? null : foundWords(run, graph);
      return head(n.what ?? found ?? sentBackWords(n), fixing(n.round, n.max), fixer, found && /\b(red|rejected)\b/i.test(found) ? "bad" : tone);
    }
    // The viewer's own card is answered right under the head, its question its title.
    case "gate": return n.mine ? head("Waiting on your decision") : head(gateWaitWords(n.holder, n.who), n.prompt, n.decisionId ? `/decisions/${run.gate_decision_short_id ?? n.decisionId}` : null);
    case "landed": return head(`Merged ${n.sha.slice(0, 7)}`, holdWords(n.hold).words, deploysHref(run, n.line));
    case "deploying": {
      const going = n.targets.length ? n.targets : targetsFromLine(n.line).filter((t) => t.state !== "live").map((t) => t.name);
      return head(going.length ? `Deploying to ${listWords(going)}` : "Deploying");
    }
    case "live": {
      const on = n.targets.length ? n.targets : targetsFromLine(n.line).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live");
    }
    case "merged": return head(`${n.end ?? "Merged"} ${n.sha.slice(0, 7)}`, shortWhy(n.why));
    case "passed": return head("Done");
    case "unlanded": return head("Not merged", shortWhy(n.why));
    case "stopped":
    case "failed": {
      // The exit's own name when the run reached one off its main path; else the station, never the segment holding it.
      const where = n.end ? null : stoppedAt(run, graph);
      // A way out already named as an end ("Not merged: CI unread") says it whole.
      const words = where ? (where.outcome ? (/^(not merged|stopped|dropped|rejected)\b/i.test(where.label) ? where.label : stopWords({ stage: null, end: where.label })) :`${n.kind === "failed" ? "Failed" : "Stopped"} at ${where.label}`)
        : n.kind === "failed" && !n.end ? `Failed${n.stage ? ` at ${n.stage}` : ""}` : stopWords(n);
      return head(words, shortWhy(n.why ?? run.fail_reason), n.fix === "session" ? session(n.session) : n.fix === "deploy" ? deploysHref(run, n.why) : null);
    }
  }
}

export type ChangeLinkKind = "pr" | "ci" | "review" | "merged" | "deploy";
/** One fact about the change, as a link to where it lives. `tone`: ok (passed, live), bad (red, failed), wait (under way). */
export type ChangeLink = { kind: ChangeLinkKind; label: string; href: string; external: boolean; tone: "ok" | "bad" | "wait" | "default"; title: string };

const PR_URL = /https:\/\/github\.com\/([^/\s"]+\/[^/\s"]+)\/pull\/(\d+)/i;

/** The pull request the run opened: what it recorded on the run, else the newest step that reported one, else the merge's link. */
export function changePr(run: ChangeRun): { repository: string; number: number } | null {
  if (run.pr?.repository && run.pr.number) return { repository: run.pr.repository, number: run.pr.number };
  const said = [...(run.node_statuses ?? [])].sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0)).map((n) => PR_URL.exec(n.result_preview ?? "")).find(Boolean);
  const m = said ?? PR_URL.exec(run.merge?.pr_url ?? "");
  return m ? { repository: m[1], number: Number(m[2]) } : null;
}

/** The Deploy stage's line that names targets ("Live: 31ccbb8 on web dp-12, cli dp-13."), newest first. */
export function deployLine(run: ChangeRun, stations: ChangeStations): string | null {
  const steps = [...(run.node_statuses ?? [])].filter((n) => stations.deploy.has(n.node_id) && n.result_preview).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0));
  return steps.find((n) => targetsFromLine(n.result_preview).length)?.result_preview ?? null;
}

/** CI as the run knows it: under way while its station runs, else the verdict it recorded, else the verdicts step's word.
 *  A change to CI itself is green on its own say-so: shown, but not as a pass. */
function ciState(run: ChangeRun, stations: ChangeStations): { label: string; tone: ChangeLink["tone"]; title?: string } | null {
  const node = newestIn(run, stations.ci);
  if (node?.status === "running") return { label: "CI running", tone: "wait" };
  const said = [...(run.node_statuses ?? [])].reverse().map((n) => verdictsOf(n.result_preview)?.ci).find(Boolean);
  const changed = !!run.ci_verdict?.ci_changed || [...(run.node_statuses ?? [])].some((n) => /"ci_changed"\s*:\s*true/.test(n.result_preview ?? ""));
  const green = run.ci_verdict ? run.ci_verdict.green : said === "green" ? true : said === "red" ? false : null;
  if (green && changed) return { label: "CI green, not counted", tone: "default", title: "This change edits CI, so CI can't vouch for it" };
  if (green === true) return { label: "CI green", tone: "ok" };
  if (green === false) return { label: "CI red", tone: "bad" };
  if (said === "blocked_by_main") return { label: "CI red on main", tone: "bad" };
  if (said === "timed_out") return { label: "CI timed out", tone: "bad" };
  return node ? { label: "CI", tone: "default" } : null;
}

const REVIEW_WORDS: Record<string, { label: string; tone: ChangeLink["tone"] }> = {
  ship: { label: "Review passed", tone: "ok" },
  changes: { label: "Review asked for changes", tone: "wait" },
  rejected: { label: "Review rejected", tone: "bad" },
};

/**
 * The change's facts as links, in the order the change meets them: its pull request, the CI on it, its review (the
 * reviewer's session), the commit it merged, and each deploy that carries it (`targets`: where the deploy records put
 * the merged commit, else the Deploy stage's own line). Each appears once the run has it.
 */
export function changeLinks(run: ChangeRun, graph: ChangeGraph, targets: ReadonlyArray<TargetState> = []): ChangeLink[] {
  const out: ChangeLink[] = [];
  const stations = changeStations(graph);
  const pr = changePr(run);
  const prGithub = pr ? `https://github.com/${pr.repository}/pull/${pr.number}` : null;
  if (pr) out.push({ kind: "pr", label: `PR #${pr.number}`, href: entityRoute("pr", `${pr.repository}#${pr.number}`) ?? prGithub!, external: false, tone: "default", title: `${pr.repository}#${pr.number}` });
  const ci = ciState(run, stations);
  if (ci && prGithub) out.push({ kind: "ci", label: ci.label, tone: ci.tone, href: `${prGithub}/checks`, external: true, title: ci.title ?? "The checks on the pull request, on GitHub" });
  const review = newestIn(run, stations.review);
  if (review?.session?._id) {
    const words = review.status === "running" ? { label: "In review", tone: "wait" as const } : REVIEW_WORDS[run.review_verdict?.verdict ?? ""] ?? { label: "Review", tone: "default" as const };
    out.push({ kind: "review", ...words, href: `/conversation/${review.session._id}`, external: false, title: review.session.title ?? "The reviewer's session" });
  }
  const sha = landedSha(run);
  const team = runTeam(run);
  if (sha) {
    const repo = pr?.repository ?? null;
    out.push({ kind: "merged", label: `Merged ${sha.slice(0, 7)}`, href: (repo && entityRoute("commit", `${repo}@${sha}`)) || deploysFocusHref({ team, focus: { kind: "sha", sha: sha.toLowerCase() } }), external: false, tone: "ok", title: sha });
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
