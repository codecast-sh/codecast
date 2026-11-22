// Where each session's work is on its way to production, for its inbox card
// (flows.md FL4, deploys.md DP12): from the newest change run the session
// started (in review, your call, fixing, waiting to deploy, live, stopped) and
// from the team's deploy records (live in dp-N, deploy failed), so a session
// whose commits went out without a flow still says it made it out. Pure:
// hooks/useSessionShipState reads it over the store.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import type { DeployReach, ReachState } from "@codecast/shared/contracts/deployReach";
import { sessionsOf, type TeamDeployRow } from "../deploys/targets";
import { SENT_BACK, type TargetState } from "./journey";

export type ShipTone = "working" | "agent" | "session" | "you" | "ok" | "bad" | "wait";
export type SessionShip = { words: string; tone: ShipTone; deploy?: string | null; run?: string | null };

type Run = {
  _id: string;
  spawner_conversation_id?: string | null;
  status: string;
  current_node_id?: string | null;
  waiting_on_session?: { node_id: string } | null;
  fail_reason?: string | null;
  created_at?: number;
  updated_at?: number;
  merge?: { sha?: string | null } | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string }> | null;
};

/** Whether a finished run went through a Deploy station of its own, which passes only once the change is live. */
const deployedBy = (run: Run) => !!run.node_statuses?.some((n) => segmentTopOf(n.node_id) === "deploy" && n.status === "completed");

/** The commit a finished run landed on main and left for a deploy to take out: its flow has no Deploy station. */
export function landedSha(run: Run): string | null {
  return run.status === "completed" && !deployedBy(run) ? run.merge?.sha ?? null : null;
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
export function reachShip(reach: Pick<DeployReach, "state" | "targets">, run: string | null = null): SessionShip {
  const { words, tone } = REACH_WORDS[reach.state];
  const speaking = reach.targets.filter((t) => !t.dormant);
  const at = (speaking.length ? speaking : reach.targets).filter((t) => t.state === reach.state);
  const deploy = at.find((t) => t.deploy)?.deploy?.short_id ?? null;
  return { words: at.length ? `${words} · ${at.map((t) => t.target).join(", ")}` : words, tone, deploy, run };
}

/** A stage's name on a card, from the station a run stands at. */
const STAGE: Record<string, string> = { check: "Checking", review: "In review", decide: "Your call", ship: "Landing", deploy: "Waiting to deploy" };
const STOP_AT: Record<string, string> = { check: "Check", review: "Review", decide: "Decide", ship: "Land", deploy: "Deploy" };
const FIX: Record<string, string> = { fix_check: "Check", fix_review: "Review", revise: "Decide", fix_conflict: "Land" };

/** Where one run of a change flow stands, in a card's words, read from its node ids (no graph needed). */
export function runShip(run: Run): SessionShip | null {
  const at = run.current_node_id ?? "";
  const top = segmentTopOf(at);
  const live = run.status === "running" || run.status === "paused" || run.status === "pending";
  if (run.status === "pending") return { words: "Starting", tone: "working", run: run._id };
  if (live && (run.waiting_on_session || FIX[top])) return { words: `${SENT_BACK[FIX[segmentTopOf(run.waiting_on_session?.node_id ?? at)] ?? ""] ?? "Sent back"} · fixing`, tone: "session", run: run._id };
  if (live && (run.status === "paused" || top === "decide")) return { words: "Your call", tone: "you", run: run._id };
  if (live && top === "deploy") return { words: "Waiting to deploy", tone: "wait", run: run._id };
  if (live) return { words: STAGE[top] ?? "Shipping", tone: top === "review" ? "agent" : "working", run: run._id };
  // A run is live only past a Deploy station of its own; a flow that ends at Land leaves its change on main for a deploy.
  if (run.status === "completed") return { words: deployedBy(run) ? "Live" : "Landed", tone: "ok", run: run._id };
  if (/^Stopped: The deploy that carried/.test(run.fail_reason ?? "")) return { words: "Deploy failed", tone: "bad", run: run._id };
  if (run.status === "failed") {
    const where = STOP_AT[top] ?? STOP_AT[FIX[top] ? Object.keys(STOP_AT).find((k) => FIX[top] === STOP_AT[k]) ?? "" : ""];
    return { words: where ? `Stopped · ${where}` : "Stopped", tone: "bad", run: run._id };
  }
  return null;
}

/** How many landed commits one reach subscription asks about: the server answers the same many (deployReach.many). */
export const LANDED_REACH_MAX = 25;

/** The commits the sessions' newest runs landed and left for a deploy, whose reach their cards read: the newest few, sorted. */
export function landedShas(runs: ReadonlyArray<Run>): string[] {
  const newest = new Map<string, Run>();
  for (const r of runs) {
    const id = r.spawner_conversation_id ? String(r.spawner_conversation_id) : null;
    if (id && (r.created_at ?? 0) > (newest.get(id)?.created_at ?? -1)) newest.set(id, r);
  }
  const landed = [...newest.values()].filter((r) => landedSha(r)).sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  return [...new Set(landed.map((r) => landedSha(r)!))].slice(0, LANDED_REACH_MAX).sort();
}

/**
 * Every session's ship state from the newest change run it started and the deploys that carried its commits. A run
 * still in flight wins; past that, a deploy that carried the session says where its work went out (live in its newest
 * live deploy, or failed in a failed one newer than any live).
 */
export function sessionShips(runs: ReadonlyArray<Run>, deploys: ReadonlyArray<TeamDeployRow>, reach: Readonly<Record<string, Pick<DeployReach, "state" | "targets">>> = {}): Map<string, SessionShip> {
  const out = new Map<string, SessionShip>();
  const newestRun = new Map<string, Run>();
  for (const r of runs) {
    const id = r.spawner_conversation_id ? String(r.spawner_conversation_id) : null;
    if (!id) continue;
    const prev = newestRun.get(id);
    if (!prev || (r.created_at ?? 0) > (prev.created_at ?? 0)) newestRun.set(id, r);
  }
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
  // A landed commit is read only through its own reach ("Landed" until it answers): a deploy that carried some commit of
  // the session says nothing about this one. A run that landed without naming its commit can be overtaken only by a
  // deploy of the session's commits made after the run ended.
  const onlyReach = new Set<string>();
  const after = new Map<string, number>();
  for (const [id, r] of newestRun) {
    const sha = landedSha(r);
    if (sha) {
      onlyReach.add(id);
      const known = reach[sha];
      out.set(id, known?.targets?.length ? reachShip(known, r._id) : runShip(r)!);
      continue;
    }
    if (r.status === "completed" && !deployedBy(r)) after.set(id, r.updated_at ?? r.created_at ?? 0);
    const s = runShip(r);
    if (s) out.set(id, s);
  }
  for (const id of new Set([...live.keys(), ...failed.keys()])) {
    if (onlyReach.has(id)) continue;
    const cur = out.get(id);
    // A run in flight says more than an older deploy; a finished run is overtaken by where its commits went out.
    if (cur && cur.tone !== "ok" && !cur.words.startsWith("Stopped")) continue;
    const since = after.get(id) ?? 0;
    const l = [live.get(id)].find((d) => d && (d.live_at ?? d.created_at) >= since);
    const f = [failed.get(id)].find((d) => d && d.created_at >= since);
    if (f && (!l || f.created_at > (l.live_at ?? l.created_at))) out.set(id, { words: `Deploy failed · ${f.target}`, tone: "bad", deploy: f.short_id });
    else if (l) out.set(id, { words: `Live · ${l.target}`, tone: "ok", deploy: l.short_id });
  }
  return out;
}
