// Where each session's work is on its way to production, for its inbox card
// (flows.md FL4, deploys.md DP12): from the newest change run the session
// started (in review, your call, fixing, waiting to deploy, live, stopped) and
// from the team's deploy records (live in dp-N, deploy failed), so a session
// whose commits went out without a flow still says it made it out. Pure:
// hooks/useSessionShipState reads it over the store.
import { segmentTopOf } from "@codecast/shared/contracts/flowPool";
import { sessionsOf, type TeamDeployRow } from "../deploys/targets";

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
};

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
  if (live && (run.waiting_on_session || FIX[top])) return { words: `Fixing · ${FIX[segmentTopOf(run.waiting_on_session?.node_id ?? at)] ?? "a finding"}`, tone: "session", run: run._id };
  if (live && (run.status === "paused" || top === "decide")) return { words: "Your call", tone: "you", run: run._id };
  if (live && top === "deploy") return { words: "Waiting to deploy", tone: "wait", run: run._id };
  if (live) return { words: STAGE[top] ?? "Shipping", tone: top === "review" ? "agent" : "working", run: run._id };
  if (run.status === "completed") return top === "exit" || top === "deploy" ? { words: "Live", tone: "ok", run: run._id } : { words: "Landed", tone: "ok", run: run._id };
  if (/^Stopped: The deploy that carried/.test(run.fail_reason ?? "")) return { words: "Deploy failed", tone: "bad", run: run._id };
  if (run.status === "failed") {
    const where = STOP_AT[top] ?? STOP_AT[FIX[top] ? Object.keys(STOP_AT).find((k) => FIX[top] === STOP_AT[k]) ?? "" : ""];
    return { words: where ? `Stopped · ${where}` : "Stopped", tone: "bad", run: run._id };
  }
  return null;
}

/**
 * Every session's ship state from the newest change run it started and the deploys that carried its commits. A run
 * still in flight wins; past that, a deploy that carried the session says where its work went out (live in its newest
 * live deploy, or failed in a failed one newer than any live).
 */
export function sessionShips(runs: ReadonlyArray<Run>, deploys: ReadonlyArray<TeamDeployRow>): Map<string, SessionShip> {
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
  for (const [id, r] of newestRun) {
    const s = runShip(r);
    if (s) out.set(id, s);
  }
  for (const id of new Set([...live.keys(), ...failed.keys()])) {
    const cur = out.get(id);
    // A run in flight says more than an older deploy; a finished run is overtaken by where its commits went out.
    if (cur && cur.tone !== "ok" && !cur.words.startsWith("Stopped")) continue;
    const l = live.get(id);
    const f = failed.get(id);
    if (f && (!l || f.created_at > (l.live_at ?? l.created_at))) out.set(id, { words: `Deploy failed · ${f.target}`, tone: "bad", deploy: f.short_id });
    else if (l) out.set(id, { words: `Live · ${l.short_id}`, tone: "ok", deploy: l.short_id });
  }
  return out;
}
