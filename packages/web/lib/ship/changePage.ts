// A change run's page (flows.md, pl-1077): its headline, where the change stands and what it waits on, and the
// change's own facts as links: the pull request, its CI, its review, the commit it merged and the deploys that carry it.
// Everything here is read from structure, never from a station's free text: the journey the run card draws
// (journey.ts), the run's graph (stations by what they are, at any depth: Union's Change holds them inside its Land
// segment), the exit the run reached, and the verdicts, merge and deploys the run recorded. A reason in words stays in
// the bar under the track. Pure, with relative imports only: the phone's run page reads a run here too.
import { SEGMENT_SEP, takesSessionChange, type FlowEdgeIn, type FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { entityRoute } from "@codecast/shared/entities";
import { verdictOnHead } from "@codecast/shared/contracts/deployTargets";
import { awaySendsOf, deployStopOf, deployStopWords, failedDeploysOf } from "@codecast/shared/contracts/deployStop";
import { journeyOf, journeyStages, targetsFromLine, withRunDeploys, type Journey, type JourneyStage, type JourneyViewer, type TargetState } from "./journey";
import { gateWaitWords, holdWords, journeyWords, sentBackWords, stopTitle, type JourneyTone } from "./journeyWords";
import { landedSha } from "./runRecord";
import { HANDED_EXIT, handedRole, mergeOffIn, mergeOffRole } from "@codecast/shared/contracts/mergeOff";
import { deploysFocusHref, deploysHref as wordsHref, runDeploysHref, runTeam } from "../deploys/focus";

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
  /** Heads Merge only rebased onto main: a review on `from` holds on `to` (verdictOnHead). */
  station_rebases?: ReadonlyArray<{ from: string; to: string }> | null;
  /** `outside`: someone else merged the PR, the server recorded it (`by`: their GitHub login) and the run goes live. */
  merge?: { sha?: string | null; pr_url?: string | null; outside?: boolean; by?: string | null } | null;
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

/** The change's stations in its graph, each by the mark the station contract gives it at any depth, never by the graph's
 *  shape (a Lint beside CI in the fan-out is not CI): CI is the command named `ci` (Union's `land__ci`, its CI alone
 *  `land__ci_alone`) or labelled CI; Review the agent named `review`; Deploy every step of the Deploy stage. */
export type ChangeStations = { ci: Set<string>; review: Set<string>; deploy: Set<string> };
const leafOf = (id: string) => id.split(SEGMENT_SEP).pop()!;
export function changeStations(graph: ChangeGraph): ChangeStations {
  const deployStage = journeyStages(graph as any).find((s) => s.role === "deploy")?.id;
  const ids = (keep: (n: FlowNodeIn) => boolean) => new Set(graph.nodes.filter(keep).map((n) => n.id));
  return {
    ci: ids((n) => n.type === "command" && (["ci", "ci_alone"].includes(leafOf(n.id)) || n.label === "CI")),
    review: ids((n) => n.type === "agent" && leafOf(n.id) === "review"),
    deploy: deployStage ? ids((n) => n.id === deployStage || n.id.startsWith(`${deployStage}${SEGMENT_SEP}`)) : new Set(),
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

/** A verdict only while it is about the head the run is on: one read on an earlier head says nothing about this one.
 *  A review also holds on a head Merge only rebased it onto (`rebases`, verdictOnHead); CI does not, as it reruns there. */
function current<T extends { head_sha?: string | null }>(v: T | null | undefined, head: string | null, rebases?: ChangeRun["station_rebases"]): T | null {
  if (!v) return null;
  return !v.head_sha || !head || verdictOnHead(v.head_sha, head, rebases ?? []) ? v : null;
}

/** The Deploy stage's line that names targets ("Live: 31ccbb8 on web dp-12, cli dp-13."), newest first. */
export function deployLine(run: ChangeRun, stations: ChangeStations): string | null {
  const steps = [...(run.node_statuses ?? [])].filter((n) => stations.deploy.has(n.node_id) && n.result_preview).sort(byNewest);
  return steps.find((n) => targetsFromLine(n.result_preview).length)?.result_preview ?? null;
}

/** A step that only routes the run out of its segment (`{"exit": "changes"}`): its name is the outcome ("Changes asked"). */
const ROUTE_ONLY = /^\s*\{\s*"exit"\s*:/;

/** `words`: where the change stands; `waits`: what it waits on, or where and how it stopped, in a station and an outcome
 *  the graph names. State only: the objects are the chips under it, and the one action is in the bar under the track
 *  (changeAction), so the page says each fact once. */
export type ChangeHeadline = { words: string; waits: string | null; tone: JourneyTone };

/** "web, cli and mobile". */
const listWords = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** What CI and the review found on the head the run is on, else the name of the way out its segment took ("Changes asked"). */
function foundWords(run: ChangeRun, graph: ChangeGraph): string | null {
  const head = currentHead(run);
  const ci = current(run.ci_verdict, head);
  const review = current(run.review_verdict, head, run.station_rebases)?.verdict;
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

/** The merge station's refusal when a merge switch is off (convex lib/lineMerge.ts), as the run's reason carries it,
 *  or as the CLI's merge said it ("merge left to a person: …"): the one matcher every reader shares. */
export const mergeIsOff = (run: ChangeRun) => mergeOffIn(run.fail_reason);

/** A role hand's run whose Merge belongs to its role, and the role's merge is off: the run ends at its `handed` exit and
 *  its merge step says whose ("Merge is @release's: handed to it."). The role's handle, "" when no step names it. */
export function handedTo(run: ChangeRun): string | null {
  if (run.status !== "completed" || run.merge?.sha || leafOf(run.current_node_id ?? "") !== HANDED_EXIT) return null;
  return [...(run.node_statuses ?? [])].sort(byNewest).map((n) => handedRole(n.result_preview)).find(Boolean) ?? "";
}

/** The role that holds the change's merge, by handle, when its words name one: the role it was handed to, or the one
 *  whose merge is off ("@release's merge is off: …"). Null when they name none (the run's own role holds it then). */
export function mergeHolder(run: ChangeRun): string | null {
  return handedTo(run) || mergeOffRole(run.fail_reason) || null;
}

/** Whether the change is on main by the run's own record: a sha it landed, or a landing step that passed. */
const onMainByRun = (run: ChangeRun, j: Journey) => !!landedSha(run) || ((j.now.kind === "stopped" || j.now.kind === "failed") && !!j.now.landed);

/**
 * A change on main while its run stopped short of merging it: GitHub merged its PR (someone did, outside the run; its
 * merge switch was off, say), or the run's record holds a merge its stations never made (the server heals such runs).
 * The stop is moot: the merge reads done, the stages the run never entered before Deploy read skipped, and Deploy, Live
 * and the bar read from where the deploy records put the merge (`targets`), as a landed run's do. A stop the run itself
 * caused after landing (a Deploy stop, a landing step that passed) and a personal Ship keep their own reading.
 */
export function landedOutside(j: Journey, run: ChangeRun, graph: ChangeGraph, ctx: { pr?: PrState; targets?: ReadonlyArray<TargetState>; reading?: boolean; newerMerged?: string | null } = {}): Journey {
  const n = j.now;
  // A later run on the same task merged this pull request (the PR station reuses an open PR): the change went on there,
  // and this run says so (changeHeadline), never that someone else merged it.
  if (ctx.newerMerged && !run.merge?.outside) return j;
  // The server's record says so (it healed the run; a merge handed to a role heals the same way), else GitHub's PR does:
  // for a merge handed to its role, once GitHub merged it; otherwise when the run's stop came before its landing. A
  // healed run that reached Live reads as any live run.
  const said = (!!run.merge?.outside && !(run.status === "completed" && /^live$/i.test(exitReached(run, graph) ?? ""))) || (handedTo(run) !== null && !!ctx.pr?.merged);
  if (j.personal || (!said && n.kind !== "stopped" && n.kind !== "failed" && n.kind !== "unlanded")) return j;
  const stop = n.kind === "stopped" || n.kind === "failed" ? n : null;
  if (!said && stop && (stop.fix === "deploy" || stop.landed)) return j;
  const sha = landedSha(run) ?? (ctx.pr?.merged ? ctx.pr.merge_sha ?? "" : null);
  if (sha === null) return j;
  const deployAt = j.stages.findIndex((s) => s.role === "deploy");
  const stopAt = j.stages.findIndex((s) => s.state === "stopped");
  if (!said && n.kind !== "unlanded" && deployAt >= 0 && stopAt >= deployAt) return j;
  const targets = ctx.targets ?? [];
  const live = targets.length > 0 && targets.every((t) => t.state === "live");
  const going = targets.filter((t) => t.state === "deploying");
  const failed = targets.some((t) => t.state === "failed");
  // No targets once reach is read: the change touches none, so there is nothing to send.
  const none = !targets.length && !ctx.reading;
  const deploy: JourneyStage["state"] = live ? "done" : going.length ? "active" : failed ? "stopped" : none ? "nothing" : "waiting";
  // The merge itself happened, whoever made it: the station that merges and the stage that lands read done.
  const merges = (s: JourneyStage) => s.role === "land" || leafOf(s.id) === "merge";
  const stages = j.stages.map((s, i): JourneyStage => {
    if (s.role === "deploy") return { ...s, state: deploy };
    if (s.role === "live") return { ...s, state: live ? "done" : none ? "skipped" : "idle" };
    if (deployAt >= 0 && i > deployAt) return s;
    if (merges(s)) return { ...s, state: "done" };
    return stopAt >= 0 && i > stopAt ? { ...s, state: "skipped" } : s;
  });
  const now: Journey["now"] = live ? { kind: "live", targets: targets.map((t) => t.name), line: null }
    : going.length ? { kind: "deploying", targets: going.map((t) => t.name), line: null, waits: [] }
    : none ? { kind: "merged", sha, at: null }
    : { kind: "landed", sha, at: null, line: null, hold: { kind: "wait", by: null }, waits: [] };
  return { ...j, stages, now, outside: { sha } };
}

/** A change run's journey as its page reads it: the run's own (journey.ts), read as landed when someone else merged the
 *  change while the run stopped short of it (landedOutside). The web's run page and the phone's read it here. */
export function changeJourney(graph: ChangeGraph, run: ChangeRun, targets: ReadonlyArray<TargetState>, viewer: JourneyViewer | null, ctx: { pr?: PrState; reading?: boolean; newerMerged?: string | null } = {}): Journey {
  return landedOutside(journeyOf(graph as any, run as any, targets, viewer), run, graph, { ...ctx, targets });
}

/** A later run on the same task that merged this run's pull request (the PR station reuses an open PR): the newest such
 *  run's id. `others`: the task's other runs. */
export function newerMergedRun(
  run: ChangeRun & { created_at?: number },
  others: ReadonlyArray<ChangeRun & { _id: string; created_at?: number }>,
): string | null {
  const pr = changePr(run);
  if (!pr) return null;
  const same = (r: ChangeRun) => { const p = changePr(r); return !!p && p.number === pr.number && p.repository.toLowerCase() === pr.repository.toLowerCase(); };
  return [...others].filter((r) => (r.created_at ?? 0) > (run.created_at ?? 0) && same(r) && !!landedSha(r)).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]?._id ?? null;
}

/** Where a change someone else merged stands, from the deploy records: live, going out, failed or waiting per target. */
function outsideWords(targets: ReadonlyArray<TargetState>, reading = false): { waits: string; tone: JourneyTone } {
  // Reach not answered yet and nothing cached: a cached answer is the ordinary first paint, refreshed when it lands.
  if (reading && !targets.length) return { waits: "Reading where it is live", tone: "wait" };
  if (!targets.length) return { waits: "Nothing to deploy", tone: "ok" };
  const named = (state: TargetState["state"]) => targets.filter((t) => t.state === state);
  const live = named("live"), going = named("deploying"), failed = named("failed"), waiting = named("waiting");
  const parts = [
    live.length ? `live on ${listWords(live.map((t) => t.name))}` : null,
    ...going.map((t) => `going out to ${t.name}${t.deploy ? ` in ${t.deploy}` : ""}`),
    failed.length ? `${failed.map((t) => `${t.name}${t.deploy ? ` ${t.deploy}` : ""}`).join(", ")} failed` : null,
    waiting.length ? `waiting to deploy to ${listWords(waiting.map((t) => t.name))}` : null,
  ].filter(Boolean) as string[];
  return { waits: sentence(parts.join(" · ")), tone: failed.length ? "bad" : live.length === targets.length ? "ok" : "wait" };
}

/**
 * Where a stop happened, past the stage the bar names: the step inside a segment that failed doing its work ("PR" in
 * Land), then the outcome the graph names, the way out its segment took ("No pull request") or the exit it reached
 * ("Not merged"). Read from the run's last failures only: an earlier round's failure is not this stop. An outcome that
 * says there is no pull request is left off when the run recorded one; one that says Not merged is "Merge is off" when
 * the merge station's switch said so, and a change on main says it landed first.
 */
function stopDetail(run: ChangeRun, graph: ChangeGraph, title: string, landed: boolean): string | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const steps = [...(run.node_statuses ?? [])].filter((n) => byId.get(n.node_id) && byId.get(n.node_id)!.type !== "exit").sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  const failed: Status[] = [];
  for (let i = steps.length - 1; i >= 0 && steps[i].status === "failed"; i--) failed.unshift(steps[i]);
  const said = (label: string | null | undefined) => (label && !title.toLowerCase().includes(label.toLowerCase()) ? label : null);
  const work = failed.find((n) => !ROUTE_ONLY.test(n.result_preview ?? "") && n.node_id.includes(SEGMENT_SEP));
  const inner = said(work ? byId.get(work.node_id)!.label : null);
  const route = failed.find((n) => ROUTE_ONLY.test(n.result_preview ?? ""));
  let outcome = said(route ? byId.get(route.node_id)!.label : exitReached(run, graph));
  if (outcome && /pull request/i.test(outcome) && changePr(run)) outcome = null;
  if (mergeIsOff(run)) outcome = mergeHolder(run) ? `@${mergeHolder(run)}'s merge is off` : "Merge is off";
  const parts = [landed ? "Landed" : null, inner, outcome].filter(Boolean) as string[];
  return parts.length ? parts.map((p, i) => (i ? lower(p) : p)).join(" · ") : null;
}

/**
 * A change on main whose deploy failed: it is landed, and for each target that deploy failed on, where the change
 * stands there now from the deploy records (`targets`, deploy reach): live in a later deploy, going out in one, else
 * that deploy failed (or sent nothing) and the target's next deploy takes it live (it is on main, so any later deploy of
 * the target carries it). Without reach, the failed deploys the reason names. A stop that only says another person's
 * machine sends the target (awaySendsOf) failed nothing: `away` heads it as waiting for that machine to send, and as
 * live or deploying once a deploy took it there.
 */
function deployFailedWords(run: ChangeRun, targets: ReadonlyArray<TargetState>, reading = false): { words: string; notSent: boolean; away: { words: string; tone: JourneyTone } | null } | null {
  const reason = deployStopWords(run) ?? run.fail_reason;
  const sends = awaySendsOf(reason);
  const failed = sends.length ? sends.map((a) => ({ target: a.target, deploy: "", unsent: true })) : failedDeploysOf(reason);
  if (!failed.length) return null;
  // Reach not answered yet: what an earlier visit cached may say failed where a deploy since took it live.
  if (reading) return { words: "Landed · reading where it is live", notSent: false, away: null };
  const now = failed.map((f) => ({ ...f, at: targets.find((t) => t.name === f.target) }));
  // A target the stop does not name that is still sending the change holds it as much as a failed one.
  const sending = targets.filter((t) => t.state === "deploying" && !failed.some((f) => f.target === t.name));
  const live = now.filter((f) => f.at?.state === "live");
  const going = now.filter((f) => f.at?.state === "deploying");
  const waiting = now.filter((f) => f.at?.state !== "live" && f.at?.state !== "deploying");
  const parts = [
    ...live.map((f) => `live on ${f.target}${f.at!.deploy ? ` ${f.at!.deploy}` : ""}`),
    ...[...going.map((f) => ({ name: f.target, deploy: f.at!.deploy })), ...sending].map((t) => `going out to ${t.name}${t.deploy ? ` in ${t.deploy}` : ""}`),
    ...(["failed", "not sent"] as const).flatMap((word) => {
      const these = waiting.filter((f) => f.deploy && (word === "not sent") === f.unsent);
      return these.length ? [`${these.map((f) => `${f.target} ${f.deploy}`).join(", ")} ${word}`] : [];
    }),
    ...(waiting.length ? [`goes live with the next ${listWords(waiting.map((f) => f.target))} deploy${waiting.length > 1 ? "s" : ""}`] : []),
  ];
  const senders = [...new Set(sends.filter((a) => waiting.some((f) => f.target === a.target)).map((a) => a.sender))];
  const away = !sends.length ? null
    : waiting.length ? { words: `Waiting for ${listWords(senders)} to send ${listWords(waiting.map((f) => f.target))}`, tone: "wait" as const }
    : going.length || sending.length ? { words: `Deploying to ${listWords([...going.map((f) => f.target), ...sending.map((t) => t.name)])}`, tone: "wait" as const }
    : { words: `Live on ${listWords(live.map((f) => f.target))}`, tone: "ok" as const };
  // Not sent: every deploy it names stopped before sending anything, and none has taken it out since.
  return { words: ["Landed", ...parts].join(" · "), notSent: !live.length && !going.length && !sending.length && waiting.every((f) => f.unsent), away };
}

/** The page's headline for a change run: where the change stands now, and what it waits on. */
export function changeHeadline(j: Journey, run: ChangeRun, graph: ChangeGraph, ctx: { pr?: PrState; targets?: ReadonlyArray<TargetState>; reading?: boolean; newerMerged?: string | null } = {}): ChangeHeadline {
  const n = j.now;
  const { tone } = journeyWords(j);
  const head = (words: string, waits: string | null = null, t: JourneyTone = tone): ChangeHeadline => ({ words, waits, tone: t });
  const fixing = (round: number | null, max: number | null) => `Its session is fixing it${round && max ? ` · round ${round} of ${max}` : ""}`;
  // A later run merged it: where it stands now is that run's to say; the bar opens it (changeAction `newer`).
  if (ctx.newerMerged && !j.outside && run.status !== "running" && run.status !== "paused") return head("A newer run merged it", null, "ok");
  if (j.outside) {
    const said = outsideWords(ctx.targets ?? [], ctx.reading);
    return head(run.merge?.by ? `Merged by ${run.merge.by}` : "Merged by someone else", said.waits, said.tone);
  }
  // A finished run ended where its exit says: a pushed flow older than its journey's rules can read Live where it Landed.
  const ended = run.status === "completed" ? exitReached(run, graph) : null;
  // Handed to the role that holds its merge: nothing failed, and nothing is on main yet; the role merges it.
  const handed = handedTo(run);
  if (handed !== null) return head(handed ? `Handed to @${handed}` : ended ?? "Handed to its role", handed ? `Waiting for @${handed} to merge it` : null, "idle");
  if (ended) {
    if (/^live$/i.test(ended)) {
      const on = n.kind === "live" && n.targets.length ? n.targets : targetsFromLine(deployLine(run, changeStations(graph))).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live", null, "ok");
    }
    // A Deploy stop whose runner lost the exit's stop ended completed there: it reads as the stop it is.
    if (deployStopOf(run)) {
      const said = deployFailedWords(run, ctx.targets ?? [], ctx.reading);
      return said?.away ? head(said.away.words, said.words, said.away.tone) : head(said?.notSent ? "Not sent" : ended, said?.words ?? null, "bad");
    }
    return head(ended, null, "ok");
  }
  switch (n.kind) {
    case "idle": return head("Not started");
    case "starting": return head("Starting");
    case "working": {
      // A station the session itself works (its fix) is the session's fix, whatever the track calls the stage.
      const at = graph.nodes.find((x) => x.id === run.current_node_id);
      if (at?.backend === "subject") return head(foundWords(run, graph) ?? at.label, fixing(null, null), "session");
      // Back at a stage after a later one: why it runs again.
      return head(journeyWords(j).words, n.again ?? null);
    }
    case "session": {
      if (n.blocked) return head(n.ask?.mine ? "Waiting on your answer" : sentBackWords(n));
      const found = n.what ? null : foundWords(run, graph);
      return head(n.what ?? found ?? sentBackWords(n), fixing(n.round, n.max), found && /\b(red|rejected)\b/i.test(found) ? "bad" : tone);
    }
    case "gate": return head(n.mine ? "Waiting on your decision" : gateWaitWords(n.holder, n.who));
    case "landed": return head("Merged", holdWords(n.hold).words);
    case "deploying": {
      const going = n.targets.length ? n.targets : targetsFromLine(n.line).filter((t) => t.state !== "live").map((t) => t.name);
      return head(going.length ? `Deploying to ${listWords(going)}` : "Deploying");
    }
    case "live": {
      const on = n.targets.length ? n.targets : targetsFromLine(n.line).map((t) => t.name);
      return head(on.length ? `Live on ${listWords(on)}` : "Live");
    }
    case "merged": return head(n.end ?? "Merged");
    case "passed": return head("Done");
    // A PR GitHub merged outside the run is on main whatever the run's own exit says.
    case "unlanded": return head("Not merged", ctx.pr?.merged ? "PR merged on GitHub" : stopDetail(run, graph, "Not merged", false));
    case "stopped":
    case "failed": {
      const title = stopTitle(n);
      const onMain = onMainByRun(run, j);
      if (n.fix === "deploy" && onMain) {
        const said = deployFailedWords(run, ctx.targets ?? [], ctx.reading);
        if (said) return said.away ? head(said.away.words, said.words, said.away.tone) : head(said.notSent ? "Not sent" : title, said.words);
      }
      return head(title, ctx.pr?.merged && !onMain ? "PR merged on GitHub" : stopDetail(run, graph, title, onMain));
    }
  }
}

/** The one thing the person can do from where the change stands: drawn in the bar under the track on the run's page,
 *  and as the phone's button. `again` is Ship again; every other kind opens its `href`. */
export type ChangeAction = { kind: "newer" | "merge_switch" | "deploys" | "session" | "agent" | "again" | "card"; label: string; href: string | null };

/**
 * The way on from where the change stands. While it runs: someone else's card opens, the session fixing it or asking
 * opens, Deploys opens while it waits on a deploy (the target still waiting); the viewer's own card is answered in the
 * bar and needs no link. From a stop: a newer run on the same task is where the change went; a merge switched off opens
 * the role that holds its switch (`mergeRole`), else falls to the session; a stop at Deploy opens Deploys; one that
 * wants the session's fix opens it. Ship again only for an unplanned stop (fix "again") with nothing on main (the run
 * landed it, its PR was merged, or it may have). Otherwise the session that made the change, else the card the run asked.
 * `targets`: where the deploy records put the change; Deploys opens the first one not live from them, before any words.
 */
export function changeAction(j: Journey, run: ChangeRun, g: ChangeGraph, ctx: { newer?: string | null; pr?: PrState; mergeRole?: string | null; targets?: ReadonlyArray<TargetState> } = {}): ChangeAction | null {
  const n = j.now;
  const subject = run.spawner_conversation_id ?? null;
  // A merge handed to its role: the role's page, where its merge is held.
  const handed = j.outside ? null : handedTo(run);
  if (handed !== null && ctx.newer) return { kind: "newer", label: "Open the newer run", href: `/workflows/runs/${ctx.newer}` };
  if (handed !== null) return ctx.mergeRole ? { kind: "merge_switch", label: handed ? `Open @${handed}` : "Open its role", href: `/org/${ctx.mergeRole}` } : null;
  const pending = ctx.targets?.find((t) => t.state !== "live");
  const deploysHref = (words: string | null | undefined) => (pending ? runDeploysHref(run, pending.name, pending.deploy) : wordsHref(run, words));
  const openSession = (id: string | null | undefined): ChangeAction | null => (id ? { kind: "session", label: "Open session", href: `/conversation/${id}` } : null);
  // A Deploy stop its runner ended completed (deployStopOf) is a stop at Deploy all the same: Deploys is the way on.
  if (run.status === "completed" && !j.outside && deployStopOf(run)) return { kind: "deploys", label: "Open Deploys", href: deploysHref(deployStopWords(run)) };
  switch (n.kind) {
    case "gate": return !n.mine && n.decisionId ? { kind: "card", label: "Open the card", href: `/decisions/${run.gate_decision_short_id ?? n.decisionId}` } : null;
    case "session":
      if (n.blocked && n.ask?.mine) return null;
      if (n.blocked && n.ask) return { kind: "card", label: "Open the card", href: `/decisions/${n.ask.short_id ?? n.ask.id}` };
      return openSession(n.conversation ?? subject);
    case "working": {
      if (g.nodes.find((x) => x.id === run.current_node_id)?.backend === "subject") return openSession(run.waiting_on_session?.conversation_id ?? subject);
      return n.session ? { kind: n.who === "agent" ? "agent" : "session", label: n.who === "agent" ? "Open agent" : "Open session", href: `/conversation/${n.session.id}` } : null;
    }
    case "landed":
    case "deploying": return { kind: "deploys", label: "Open Deploys", href: deploysHref(n.line) };
    case "stopped":
    case "failed":
    case "unlanded": break;
    default: return null;
  }
  if (ctx.newer) return { kind: "newer", label: "Open the newer run", href: `/workflows/runs/${ctx.newer}` };
  const stop = n.kind === "unlanded" ? null : n;
  // Once GitHub merged the PR, merging is moot: the switch would change nothing for this change.
  if (mergeIsOff(run) && !ctx.pr?.merged && ctx.mergeRole) return { kind: "merge_switch", label: "Turn merge on", href: `/org/${ctx.mergeRole}` };
  if (stop?.fix === "deploy") return { kind: "deploys", label: "Open Deploys", href: deploysHref(stop.why) };
  const session = openSession(stop?.session ?? subject);
  if (stop?.fix === "session" && session) return session;
  // A deliberate stop (fix "run") repeats if run again: its session is the way on. Only an unplanned one runs again.
  const onMain = !!stop?.landed || !!stop?.mayHaveLanded || !!landedSha(run) || !!ctx.pr?.merged;
  // A stop that names its resume (the change is ready; one station goes again) offers that press (the bar's
  // ResumeAtPress), never Ship again beside it.
  if (!onMain && subject && !mergeIsOff(run) && !stop?.resume && !stop?.whole && (n.kind === "unlanded" || stop?.fix === "again")) return { kind: "again", label: "Ship again", href: null };
  if (session) return session;
  const card = run.gate_decision_short_id ?? run.gate_decision_id;
  return card ? { kind: "card", label: "Open the card", href: `/decisions/${card}` } : null;
}

/**
 * The track as the run ended: a run that finished at an exit short of Live (Landed with no deploy documented, Deployed
 * but unverified) never reached Live, and one that ended where it landed never deployed. An older flow's journey can
 * read those as done; the head says the exit, so the track does too.
 */
export function endedStages(j: Journey, run: ChangeRun, g: ChangeGraph): Journey["stages"] {
  // A change someone else merged reads from its deploy records (landedOutside), not the exit its run stopped at.
  const ended = run.status === "completed" && !j.outside ? exitReached(run, g) : null;
  if (!ended || /^live$/i.test(ended)) return j.stages;
  const landedOnly = /^(landed|merged)$/i.test(ended);
  return j.stages.map((s) => (s.role === "live" && s.state === "done" ? { ...s, state: "skipped" as const }
    : s.role === "deploy" && landedOnly && s.state === "done" ? { ...s, state: "nothing" as const }
    : s));
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
 * The run's own review verdict on a pull request's head, in words: read on that head, or on one the Merge station only
 * rebased onto main to give it (`station_rebases`). Null when the run's reviewer has not judged this head.
 */
export function reviewOnHead(
  run: { review_verdict?: { verdict: string; head_sha?: string | null } | null; station_rebases?: ReadonlyArray<{ from: string; to: string }> | null } | null | undefined,
  head: string | null | undefined,
): { label: string; tone: ChangeLink["tone"] } | null {
  const v = run?.review_verdict;
  const words = v ? REVIEW_WORDS[v.verdict] : undefined;
  if (!v?.head_sha || !head || !words) return null;
  return verdictOnHead(v.head_sha, head, run?.station_rebases) ? words : null;
}

/**
 * The run's reviewer judged an earlier head than the one the pull request is on now (a fix or a conflict resolve pushed
 * since, and no rebase carries the verdict over): which head, and the reviewer's session, so a reader sees the review
 * happened and on what, never "nobody reviewed". Null when it judged this head, or judged none.
 */
export function reviewEarlier(
  run: { review_verdict?: { verdict: string; head_sha?: string | null } | null; station_rebases?: ReadonlyArray<{ from: string; to: string }> | null; node_statuses?: ReadonlyArray<Status> | null } | null | undefined,
  head: string | null | undefined,
): { label: string; sha: string; session: string | null } | null {
  const v = run?.review_verdict;
  if (!v?.head_sha || !head || !REVIEW_WORDS[v.verdict] || verdictOnHead(v.head_sha, head, run?.station_rebases)) return null;
  const step = [...(run?.node_statuses ?? [])].filter((n) => leafOf(n.node_id) === "review" && n.session?._id).sort(byNewest)[0];
  const sha = v.head_sha.slice(0, 7);
  return { label: `Reviewed an earlier head (${sha})`, sha, session: step?.session?._id ? String(step.session._id) : null };
}

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
    const verdict = current(run.review_verdict, head, run.station_rebases)?.verdict ?? "";
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
  // Reach says each target's state; the run's own line names the deploy that first carried the change, when it saw one.
  const reach = targets.length ? withRunDeploys(targets, deployLine(run, stations)) : targetsFromLine(deployLine(run, stations));
  for (const t of reach) {
    out.push({
      kind: "deploy",
      label: t.deploy ? `${t.name} ${t.deploy}` : `${t.name} waiting`,
      // The Deploys page at the change on that target, its deploy open: where the change stands, not only the deploy.
      href: runDeploysHref(run, t.name, t.deploy),
      external: false,
      tone: t.state === "live" ? "ok" : t.state === "failed" ? "bad" : t.state === "deploying" ? "wait" : "default",
      title: t.state === "live" ? `Live on ${t.name}` : t.state === "deploying" ? `Going out to ${t.name}` : t.state === "failed" ? `Failed on ${t.name}` : `Not on ${t.name} yet`,
    });
  }
  return out;
}
