// Where each session's work is on its way to production, for its inbox card
// (flows.md FL4, deploys.md DP12): from the newest change run the session
// started (in review, your call, fixing, deploying, not landed, live, stopped) and
// from the team's deploy records (live in dp-N, deploy failed), so a session
// whose commits went out without a flow still says it made it out. Pure:
// hooks/useSessionShipState reads it over the store.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { DeployReach, ReachState } from "@codecast/shared/contracts/deployReach";
import { sessionsOf, type TeamDeployRow } from "../deploys/targets";
import { deploysFocusHref, runTeam } from "../deploys/focus";
import { entityRoute } from "@codecast/shared/entities";
import { canAnswer, deployHold, gateOpen, gateWaitWords, holderOf, holdWords, type GateDecision, type TargetState } from "./journey";
import { landedSha as mergedSha } from "./runRecord";

export type ShipTone = "working" | "agent" | "session" | "you" | "ok" | "bad" | "wait";
/** `sha`: the commit the run landed on main, and `team` the run's team, so a word about deploying it opens that team's Deploys page at the commit. */
export type SessionShip = { words: string; tone: ShipTone; deploy?: string | null; run?: string | null; sha?: string | null; team?: string | null };

/** Where a card's ship word opens: the deploy it names, else its team's Deploys page at the commit it landed (a personal run has none); otherwise it stays put. */
export function shipHref(ship: Pick<SessionShip, "deploy" | "sha" | "team">): string | null {
  if (ship.deploy) return entityRoute("deploy", ship.deploy);
  return ship.sha && ship.team ? deploysFocusHref({ team: ship.team, focus: { kind: "sha", sha: ship.sha.toLowerCase() } }) : null;
}

type Run = {
  _id: string;
  workspace?: string | null;
  spawner_conversation_id?: string | null;
  /** Stamped by the server: the run's flow takes a session's change and lands it. A session's other runs (a deploy, an eval) are not its ship. */
  takes_change?: boolean;
  status: string;
  user_id?: string | null;
  current_node_id?: string | null;
  current_node_label?: string | null;
  waiting_on_session?: { node_id: string; blocked?: boolean } | null;
  gate_decision_id?: string | null;
  gate_decision_status?: string | null;
  gate_prompt?: string | null;
  merge?: { sha?: string | null } | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status?: string; result_preview?: string | null; started_at?: number }> | null;
  fail_reason?: string | null;
  created_at?: number;
  updated_at?: number;
};

/** Whether a finished run went through a Deploy station of its own, which passes only once the change is live. */
const deployedBy = (run: Run) => !!run.node_statuses?.some((n) => segmentTopOf(n.node_id) === "deploy" && n.status === "completed");

/** The commit a finished run landed on main and left for a deploy to take out: its flow has no Deploy station. */
export function landedSha(run: Run): string | null {
  return run.status === "completed" && !deployedBy(run) ? mergedSha(run) : null;
}

const REACH_WORDS: Record<ReachState, { words: string; tone: ShipTone }> = {
  live: { words: "Live", tone: "ok" },
  going_out: { words: "Deploying", tone: "working" },
  queued: { words: "Deploy queued", tone: "working" },
  failed: { words: "Deploy failed", tone: "bad" },
  rolled_back: { words: "Rolled back", tone: "bad" },
  waiting: { words: "Not live yet", tone: "wait" },
};

/** A landed change's reach as the journey's targets: the ones still shipping, each live, going out, failed or waiting. */
export function reachTargets(reach: Pick<DeployReach, "targets"> | null | undefined): TargetState[] {
  const all = reach?.targets ?? [];
  const speaking = all.some((t) => !t.dormant) ? all.filter((t) => !t.dormant) : all;
  return speaking.map((t) => ({
    name: t.target,
    state: t.state === "live" ? "live" : t.state === "going_out" || t.state === "queued" ? "deploying" : t.state === "waiting" ? "waiting" : "failed",
    deploy: t.deploy?.short_id ?? null,
    at: t.deploy?.at ?? null,
  }));
}

/** Where a landed change is, from its deploy reach: the state that needs the eye most, and the targets in it. */
export function reachShip(reach: Pick<DeployReach, "state" | "targets">, run: string | null = null, sha: string | null = null, team: string | null = null): SessionShip {
  const { words, tone } = REACH_WORDS[reach.state];
  const speaking = reach.targets.filter((t) => !t.dormant);
  const at = (speaking.length ? speaking : reach.targets).filter((t) => t.state === reach.state);
  const deploy = at.find((t) => t.deploy)?.deploy?.short_id ?? null;
  return { words: at.length ? `${words} · ${at.map((t) => t.target).join(", ")}` : words, tone, deploy, run, sha, team };
}

/**
 * Where one run of a change flow stands, in a card's words, with no graph: the station's own label (the run row carries
 * it), "Fixing" while the run waits on the session ("Waiting for a person" while that session waits on one), "Your call" only for an open card the viewer may answer (its
 * decision, when the store holds it), landed only with a merged sha on the run (journey.ts landedSha), and not landed
 * only for a run that ended at Deploy without one.
 * The deploy segment and the run's end are the runner's own node ids.
 */
export function runShip(run: Run, viewer: string | null = null, decision: GateDecision | null = null): SessionShip | null {
  const top = segmentTopOf(run.current_node_id ?? "");
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  const sha = mergedSha(run);
  if (run.status === "pending") return { words: "Starting", tone: "working", run: run._id };
  if (live && run.waiting_on_session) return run.waiting_on_session.blocked ? { words: "Waiting for a person", tone: "wait", run: run._id } : { words: "Fixing", tone: "session", run: run._id };
  if (live && gateOpen(run)) return canAnswer(decision, viewer) ? { words: "Your call", tone: "you", run: run._id } : { words: gateWaitWords(holderOf(decision)), tone: "wait", run: run._id };
  if (live && top === "deploy") {
    // "Deploying" only while a deploy carries it; held on main CI or waiting for a person otherwise, as the Deploy line says.
    const line = (run.node_statuses ?? []).filter((n) => segmentTopOf(n.node_id) === "deploy" && n.result_preview).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]?.result_preview;
    return { ...holdWords(deployHold(line)), run: run._id, sha, team: runTeam(run) };
  }
  if (live) return { words: run.current_node_label ?? "Shipping", tone: "working", run: run._id };
  if (run.status === "completed") {
    // A run is live only past a Deploy station of its own; a flow that ends at Land leaves its change on main for a deploy.
    if (deployedBy(run)) return { words: "Live", tone: "ok", run: run._id };
    // A finished run with no merge on it (a merge nobody recorded) says it finished, never that it did not land.
    return sha ? { words: "Merged", tone: "ok", run: run._id, sha, team: runTeam(run) } : { words: "Done", tone: "ok", run: run._id };
  }
  if (/^Stopped: The deploy that carried/.test(run.fail_reason ?? "")) return { words: "Deploy failed", tone: "bad", run: run._id };
  // Not merged is said only of a run that ended at Deploy with no merge on it.
  if (run.status === "failed" && top === "deploy" && !sha) return { words: "Not merged", tone: "bad", run: run._id };
  if (run.status === "failed") return { words: run.current_node_label ? `Stopped · ${run.current_node_label}` : "Stopped", tone: "bad", run: run._id };
  return null;
}

/** How many landed commits one reach subscription asks about: the server answers the same many (deployReach.many). */
export const LANDED_REACH_MAX = 25;

/** Each session's newest change run, by the session that started it. */
function newestChangeRuns(runs: ReadonlyArray<Run>): Map<string, Run> {
  const newest = new Map<string, Run>();
  for (const r of runs) {
    const id = r.spawner_conversation_id ? String(r.spawner_conversation_id) : null;
    if (id && r.takes_change && (r.created_at ?? 0) > (newest.get(id)?.created_at ?? -1)) newest.set(id, r);
  }
  return newest;
}

/** The commits the sessions' newest runs landed and left for a deploy, whose reach their cards read: the newest few, sorted. */
export function landedShas(runs: ReadonlyArray<Run>): string[] {
  const landed = [...newestChangeRuns(runs).values()].filter((r) => landedSha(r)).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return [...new Set(landed.map((r) => landedSha(r)!))].slice(0, LANDED_REACH_MAX).sort();
}

/**
 * Every session's ship state from the newest change run it started and the deploys that carried its commits. A run
 * still in flight wins; past that, a deploy that carried the session says where its work went out (live in its newest
 * live deploy, or failed in a failed one newer than any live).
 */
export function sessionShips(runs: ReadonlyArray<Run>, deploys: ReadonlyArray<TeamDeployRow>, reach: Readonly<Record<string, Pick<DeployReach, "state" | "targets">>> = {}, viewer: string | null = null, decisions: Readonly<Record<string, GateDecision>> = {}): Map<string, SessionShip> {
  const out = new Map<string, SessionShip>();
  const newestRun = newestChangeRuns(runs);
  // Each session's newest live deploy and its newest failed one, from the records.
  const live = new Map<string, TeamDeployRow>();
  const failed = new Map<string, TeamDeployRow>();
  for (const d of deploys) {
    if (d.status !== "live" && d.status !== "failed") continue;
    const at = d.live_at ?? d.created_at;
    for (const s of sessionsOf(d)) {
      const map = d.status === "live" ? live : failed;
      const prev = map.get(s.conversation_id);
      if (!prev || at > (prev.live_at ?? prev.created_at)) map.set(s.conversation_id, d);
    }
  }
  // A landed commit is read only through its own reach ("Merged" until it answers): a deploy that carried some commit of
  // the session says nothing about this one. A run that landed without naming its commit can be overtaken only by a
  // deploy of the session's commits made after the run ended.
  const onlyReach = new Set<string>();
  const after = new Map<string, number>();
  for (const [id, r] of newestRun) {
    const s = runShip(r, viewer, r.gate_decision_id ? decisions[r.gate_decision_id] ?? null : null);
    const sha = landedSha(r);
    if (sha) {
      onlyReach.add(id);
      const known = reach[sha];
      out.set(id, known?.targets?.length ? reachShip(known, r._id, sha, runTeam(r)) : s!);
      continue;
    }
    if (r.status === "completed" && !deployedBy(r)) after.set(id, r.updated_at ?? r.created_at ?? 0);
    if (s) out.set(id, s);
  }
  for (const id of new Set([...live.keys(), ...failed.keys()])) {
    if (onlyReach.has(id)) continue;
    const cur = out.get(id);
    // A run in flight says more than an older deploy; a finished run is overtaken by where its commits went out.
    if (cur && cur.tone !== "ok" && !cur.words.startsWith("Stopped") && cur.words !== "Not merged") continue;
    const since = after.get(id) ?? 0;
    const l = [live.get(id)].find((d) => d && (d.live_at ?? d.created_at) >= since);
    const f = [failed.get(id)].find((d) => d && d.created_at >= since);
    if (f && (!l || f.created_at > (l.live_at ?? l.created_at))) out.set(id, { words: `Deploy failed · ${f.target}`, tone: "bad", deploy: f.short_id });
    else if (l) out.set(id, { words: `Live · ${l.target}`, tone: "ok", deploy: l.short_id });
  }
  return out;
}
