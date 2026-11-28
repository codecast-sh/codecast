// Where a session's change run stands, for the inbox's Shipping section (plan
// pl-1138), read the same way by the web rail, the phone and the server's
// `cast sessions`: which of a session's runs speaks for it, the ship stage its
// station belongs to, and the words a held step says. Pure and isomorphic.
import { segmentTopOf } from "./flowPool";
import type { ShipInput, ShipStage } from "./sessionActivity";

/** The library flows that take a session's change and land it. */
export const SHIPPING_FLOWS: ReadonlySet<string> = new Set(["change", "ship"]);
export const LIVE_RUN_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "paused"]);

/** The run facts this reads: a workflow_runs row (the server's, or the web store's enriched copy). */
export type ShipRunFacts = {
  status?: string;
  current_node_id?: string | null;
  current_node_label?: string | null;
  /** Stamped by the server's run feeds: the flow takes the session's change (flowPool sourceTakesSessionChange). */
  takes_change?: boolean;
  workflow_name?: string | null;
  created_at?: number;
  waiting_on_session?: { blocked?: boolean } | null;
  gate_decision_id?: string | null;
  gate_prompt?: string | null;
  gate_decision_status?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; result_preview?: string | null; started_at?: number }> | null;
  pr?: { repository?: string; number: number } | null;
};

/** A run that takes the session's change: the server's stamp, or a shipping flow by name (a project flow that only
 *  extends the library's change flow carries no stamp). */
export const runShipsChange = (run: ShipRunFacts): boolean => !!run.takes_change || SHIPPING_FLOWS.has(run.workflow_name ?? "");

/**
 * The run that speaks for a session: its newest live run that ships its change, else its newest live other run.
 * A live ship run beats a newer run that ships nothing, so a session never drops from Shipping to Working while its
 * change is on the way; an ended run never speaks.
 */
export function selectSessionRun<R extends ShipRunFacts>(runs: Iterable<R>): R | null {
  let ship: R | null = null;
  let other: R | null = null;
  for (const r of runs) {
    if (!r.status || !LIVE_RUN_STATUSES.has(r.status)) continue;
    const newer = (best: R | null) => !best || (r.created_at ?? 0) > (best.created_at ?? 0);
    if (runShipsChange(r)) { if (newer(ship)) ship = r; } else if (newer(other)) other = r;
  }
  return ship ?? other;
}

/**
 * The ship stage a change or ship flow's station belongs to: the library change flow (pr, local CI, CI and review,
 * verdicts, merge, deploy), the personal flow (round, check, review, land, deploy) and the deploy segment, whose
 * "Go live" wait (deploy__wait) is the Live step. Every station maps, so a row never leaves Shipping while its ship
 * run is live.
 */
export function shipStageOfNode(nodeId: string | null | undefined, label?: string | null): ShipStage {
  const id = nodeId ?? "";
  const top = segmentTopOf(id);
  const sub = id.slice(top.length + 2);
  if (/^go live$/i.test(label ?? "") || top === "live" || /verify/.test(top) || (/deploy/.test(top) && sub === "wait")) return "live";
  if (/deploy/.test(top) || top === "left" || top === "unverified") return "deploy";
  if (/^(merge|landed|land|moved|unshipped|rebase|ship|landcut|leftrun|after_fix|committed)$/.test(top) || (/conflict/.test(top) && !/(^|_)ci(_|$)/.test(top))) return "merge";
  if (/review|verdict|decide|^brief$|^joined$|_fix$|_revise$/.test(top) && !/(^|_)ci(_|$)/.test(top)) return "review";
  return "ci";
}

// ── Holds ───────────────────────────────────────────────────────────────────

/** Who may answer a run's approval card (a decisions row). */
export type GateDecision = {
  user_id?: string | null;
  holder?: { kind: "user" | "role"; id: string } | null;
  passed_to?: { kind: "user" | "role"; id: string } | null;
  asked_user_ids?: ReadonlyArray<string> | null;
};

/**
 * Whether the viewer may answer a decision: the person it was passed to, else its user holder and the people it was
 * asked of. A role's decision is the role's to answer. Unknown (no row, no viewer) is never yes.
 */
export function canAnswer(d: GateDecision | null | undefined, viewer: string | null | undefined): boolean {
  if (!d || !viewer) return false;
  const to = d.passed_to ?? d.holder ?? null;
  if (to?.kind === "role") return false;
  const people = d.passed_to ? [d.passed_to.id] : [...(to ? [to.id] : []), ...(d.asked_user_ids ?? (d.user_id ? [d.user_id] : []))];
  return people.some((p) => String(p) === viewer);
}

/** Whether a gate holds the run for an answer: paused on a card nobody has answered. */
export const gateOpen = (run: Pick<ShipRunFacts, "status" | "gate_decision_id" | "gate_prompt" | "gate_decision_status">) =>
  run.status === "paused" && !!(run.gate_decision_id || run.gate_prompt) && (run.gate_decision_status ?? "pending") === "pending";

/**
 * Where a landed change's Deploy stands, read from its line (`cast flow await-deploy`): going out, held on main's CI
 * that is red (the line's own "(red …)"), waiting on main's CI that is still running or not there yet, waiting for a
 * person or a named role to send it (`by`), or waiting on targets that go out by themselves.
 */
export type DeployHold = { kind: "out" | "red" | "ci" | "press" | "wait"; by: string | null };
/** A target's deploy going out, as its line says it (awaitDeploy deployingWords): sending, or waiting inside its send
 *  ("dp-3 waits for the CLI release in flight, then sends …"; older lines said "goes out after"). The deploy is sending
 *  by its record either way, as the Deploys page says. */
export const DEPLOY_GOING = /\b(dp-\d+) (?:sending|waits for|goes out after)\b/;
export function deployHold(line: string | null | undefined): DeployHold {
  const hold = (kind: DeployHold["kind"], by: string | null = null): DeployHold => ({ kind, by });
  if (!line) return hold("wait");
  if (DEPLOY_GOING.test(line) || /going out in dp-/.test(line)) return hold("out");
  if (/waiting on main CI at \w+ \(red\b/.test(line)) return hold("red");
  if (/waiting on main CI|once main CI is green|waiting for main CI/.test(line)) return hold("ci");
  const named = line.match(/waiting for (.+?) to send it/)?.[1];
  if (named) return hold("press", named);
  if (/waiting for (a press|a person)|on a press/.test(line)) return hold("press");
  return hold("wait");
}

/**
 * Who a handle is, as a person reads it: a role (`@handle`) by its title from the roster when the caller has it, the
 * Release Captain's (pl-1075 Words) when it does not; anyone else as named.
 */
export function whoWords(by: string | null | undefined, roles?: ReadonlyArray<{ handle?: string; name?: string }>): string | null {
  if (!by) return null;
  if (!by.startsWith("@")) return by;
  const title = roles?.find((r) => `@${r.handle}` === by)?.name;
  return title ?? (by === "@release" ? "Release Captain" : by);
}

/** A landed change's Deploy in a pill's words: "Deploying" only while a deploy carries it. */
export function holdWords(hold: DeployHold, roles?: ReadonlyArray<{ handle?: string; name?: string }>): { words: string; tone: "working" | "wait" } {
  if (hold.kind === "out") return { words: "Deploying", tone: "working" };
  if (hold.kind === "red") return { words: "Waiting for green main", tone: "wait" };
  if (hold.kind === "ci") return { words: "Waiting on main CI", tone: "wait" };
  if (hold.kind === "press") return { words: `Waiting for ${whoWords(hold.by, roles) ?? "a person"} to deploy`, tone: "wait" };
  return { words: "Waiting to deploy", tone: "wait" };
}

/** What the caller knows about who a held run waits on. */
export type RunViewerFacts = {
  /** The run's open approval card is one the viewer may answer (canAnswer). */
  gateIsViewers?: boolean;
  /** The session the run waits on (pinned blocked) asks the viewer: true; someone else, or a caller that cannot tell:
   *  false or absent; its card already answered, so the session is fixing: null. */
  askIsViewers?: boolean | null;
};

/**
 * Where a live change run stands, as sessionActivity reads it: its station's stage, the run's PR, and a step held
 * for a person in its own words, with who holds it. Sent back to its session to fix, the step failed. A deploy that
 * waits on main's CI or a person's press names the hold; one simply underway says its stage.
 */
export function shipOfLiveRun(run: ShipRunFacts, facts: RunViewerFacts = {}): ShipInput {
  const stage = shipStageOfNode(run.current_node_id, run.current_node_label);
  const base: ShipInput = { stage, ...(run.pr?.number ? { pr: `#${run.pr.number}` } : {}) };
  const wait = run.waiting_on_session;
  if (wait) {
    if (!wait.blocked || facts.askIsViewers === null) return { ...base, failed: true };
    return facts.askIsViewers ? { ...base, holder: "you", words: "Waiting on you" } : { ...base, holder: "other", words: "Waiting for a person" };
  }
  if (gateOpen(run)) return facts.gateIsViewers ? { ...base, holder: "you", words: "Your call" } : { ...base, holder: "other", words: "Waiting for approval" };
  if (segmentTopOf(run.current_node_id ?? "") === "deploy") {
    const line = [...(run.node_statuses ?? [])].filter((n) => segmentTopOf(n.node_id) === "deploy" && n.result_preview).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0]?.result_preview;
    const hold = deployHold(line);
    if (hold.kind !== "out" && hold.kind !== "wait") {
      const { words } = holdWords(hold);
      return { ...base, holder: /\byou\b/i.test(words) ? "you" : "other", words };
    }
  }
  return base;
}
