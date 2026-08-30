// The inbox projection: ONE pure placement function, one bucket alphabet and one
// digest, shared by the Convex overlay (sessionsLiveness / teamSessionsLiveness),
// the CLI inbox (inboxForCLI) and every client that renders or verifies the
// inbox. See docs/architecture/sync-convergence.md (C3, C8).
//
// PURE isomorphic code: no Node or DOM APIs, no BigInt, so the Convex runtime,
// the daemon, the browser and React Native all run the same bytes.
import { ACTIVE_AGENT_STATUSES } from "./agentStatus";
import type { WorkState } from "./workState";

// ── Buckets ──────────────────────────────────────────────────────────────────

// The mutually exclusive placements. Order here is presentation order for a
// tally, not precedence — precedence is the rule list in placeInboxRow.
export const INBOX_BUCKETS = [
  "questions",
  "pinned",
  "new",
  "needs_input",
  "done",
  "dormant",
  "working",
  "idle",
  "stashed",
  "dismissed",
  "hidden",
] as const;

export type InboxBucket = (typeof INBOX_BUCKETS)[number];

export type InboxTally = Record<InboxBucket, number>;

export function emptyInboxTally(): InboxTally {
  const t = {} as InboxTally;
  for (const b of INBOX_BUCKETS) t[b] = 0;
  return t;
}

// Every cap the inbox scan can hit, named so a truncated payload says so
// instead of silently returning a smaller set (design C2).
export const INBOX_TRUNCATION_KINDS = [
  "recent",
  "pinned",
  "dismissed",
  "stashed",
  "owned",
  "members",
  "member_rows",
  "foreign_scan",
] as const;

export type InboxTruncation = (typeof INBOX_TRUNCATION_KINDS)[number];

export const INBOX_PROJECTION_VERSION = 1 as const;

export type InboxProjection = {
  v: typeof INBOX_PROJECTION_VERSION;
  as_of: number;
  epoch: number;
  user_id: string;
  scope: "mine" | "team";
  team_id: string | null;
  tally: { shown: InboxTally; folded: InboxTally };
  set_digest: string | null;
  truncated: InboxTruncation[];
};

// The projection's clock. Every time term in the server placement compares
// against this minute, never the raw Date.now(), so two executions inside one
// minute over the same data are byte identical (design C2).
export function inboxEpoch(asOf: number): number {
  return Math.floor(asOf / 60_000) * 60_000;
}

// ── Work state ───────────────────────────────────────────────────────────────

// A daemon-reported status that means the agent process is gone. A dead session
// with content still needs a human (to read the result / restart it), so the
// classifier routes it to needs-input rather than working.
export const DEAD_AGENT_STATUSES: ReadonlySet<string> = new Set<string>(["stopped"]);

export interface WorkStateInput {
  /** Heartbeat-fresh managed_sessions.agent_status, or undefined when stale/absent. */
  agentStatus?: string;
  isIdle: boolean;
  awaitingInput: boolean;
  hasPending: boolean;
  isUnresponsive: boolean;
  messageCount: number;
  /** conversations.inbox_killed_at — the user retired this row. Outranks everything below. */
  killed?: boolean;
  /** The user parked this row (inbox_dormant_at) and nothing has happened since — see isUserDormant. */
  userDormant?: boolean;
  /** The home of an armed recurring/event trigger that injects into it (and whose last run did not fail or flag attention). */
  armedTriggerHome?: boolean;
  /** The home of an armed ONCE inject trigger. Weaker than a standing loop: it only demotes a `done` rest to dormant, never needs_input (see dormancy.ArmedTriggerHomes). */
  armedOnceTriggerHome?: boolean;
  /** The settle classifier's verdict for THIS settle (settle_verdict, current per isSettleVerdictCurrent), when no declaration exists. Only "done" carries weight. */
  settleVerdict?: string | null;
  /** conversations.thread_state_status — the agent's declaration ON THE ROW, for rows with no daemon status at all (see the fallback in classifyWorkState). */
  declaredStatus?: string | null;
  /** conversations.pending_api_error — the latest turn is an unresolved auth / API-error banner; the CLI is parked on the user (or a limit reset). */
  pendingApiError?: boolean;
}

// A single, coarse "who acts next on this session" label for CLI discovery,
// the `cast monitor` dashboard, and the web inbox's sections. Collapses the
// inbox's many derived flags into the WORK_STATES buckets (see workState.ts
// for the meaning of each):
//   - "working":     the agent is actively producing, has deliverable queued
//                    work, or the user just sent a message it hasn't picked up.
//   - "needs_input": the ball is in the user's court to UNBLOCK — an open
//                    question / permission prompt, an unresolved API-error
//                    banner, a dead session with output, or a settled turn
//                    nobody classified.
//   - "done":        settled, and the agent (or the settle classifier) says the
//                    task is delivered.
//   - "dormant":     settled, and a machine wake owns the next move — the agent
//                    declared it, an open background task implies it, the home
//                    of an armed inject trigger, or the user parked it.
//   - "idle":        nothing to act on: blank sessions (no messages yet), and
//                    KILLED sessions — the user retired those, so they never
//                    read as working or needs-input again (see `killed` below).
//
// Precedence among the settled states is the safety order: a hard block (open
// question, permission, error banner, dead agent) beats every rest verdict,
// dormant beats done (a session that both delivered and parked itself is
// parked — its next move is still a machine's), and every rest verdict beats
// the "settled with content → needs input" fallthrough. An armed ONCE inject
// trigger applies the same "dormant beats done" only to the done verdict:
// delivered + a named wake = parked, but a once reminder never softens
// needs_input.
export function classifyWorkState(input: WorkStateInput): WorkState {
  const { agentStatus, isIdle, awaitingInput, hasPending, isUnresponsive, messageCount, killed } = input;
  const dead = !!agentStatus && DEAD_AGENT_STATUSES.has(agentStatus);
  const canDeliver = !isUnresponsive && !dead;
  const hasMsgs = messageCount > 0;
  // The rest verdicts, resolved once so both settled arms below agree. Sources
  // in trust order: the agent's own declaration (carried as the settle status),
  // structure (an open background task, an armed inject trigger), the user's
  // park gesture, and last the settle classifier — which only speaks when no
  // declaration exists, and only for THIS settle.
  const declaredDormant = agentStatus === "dormant" || agentStatus === "waiting";
  // The daemon carries a declaration as the settle status while the session is
  // live. When there is NO daemon status at all (the managed row aged out, the
  // machine is gone, the row predates the feature), the row's own pinned
  // thread_state_status is the best remaining evidence — a `done` there was
  // the agent's last word and nothing can have moved since without a daemon.
  // Only `done` rides this fallback: a `dormant` promise with no daemon has no
  // one to deliver its wake, so it stays needs_input (a human must look).
  const declaredDone = agentStatus === "done" || (!agentStatus && input.declaredStatus === "done");
  // A `done` rest with an armed once trigger into the session parks instead:
  // the follow-up names the next actor (the machine fires in N days), and
  // nothing is left for the human to unblock. Only `done` demotes — a once
  // trigger on a needs_input session is a reminder, and a reminder must never
  // hide an open ask.
  const doneRest = (): WorkState => (input.armedOnceTriggerHome ? "dormant" : "done");
  const restState = (): WorkState => {
    if (declaredDormant || input.armedTriggerHome || input.userDormant) return "dormant";
    if (declaredDone) return doneRest();
    if (agentStatus === "idle" || !agentStatus) {
      // A blocked PIN is the agent's explicit claim on the human — the same
      // claim that un-stashes (setThreadState) — so the classifier's soft
      // verdict never overrides it. Cleared by the agent's own next
      // declaration, never by a model.
      if (input.declaredStatus === "blocked") return "needs_input";
      // The classifier only ever files DONE: dormancy needs a wake the system
      // can verify, and prose cannot supply one (see idleSummary.SETTLE_VERDICTS).
      if (input.settleVerdict === "done") return doneRest();
    }
    return "needs_input";
  };

  // A KILLED row is triaged and outranks every signal below it: the user retired
  // it, so nothing about it is actionable and it must never read as "working".
  // Kill now cancels the messages queued before it, but a has_pending flag can
  // still be stale (an in-flight fenced row, an older kill), and an agent_status
  // can come from a worker a daemon bug revived — both used to park the dead row
  // back in the Working bucket. inbox_killed_at is the right signal precisely
  // because ANY new send clears it (pendingMessages.enqueue's wake-up rules), so
  // a genuinely revived session classifies normally again. `status: "completed"`
  // alone deliberately does NOT qualify — an ordinary finished session with a
  // queued message really is about to work on it.
  if (killed) return "idle";

  // An unresolved API-error banner ("Please run /login", a usage limit) parks
  // the CLI on the user or on a reset: the agent cannot proceed, whatever its
  // daemon status claims. Rule the web inbox had and the server lacked.
  if (input.pendingApiError && hasMsgs) return "needs_input";

  // Blocked on the user right now (open AskUserQuestion poll, or a tool-use
  // awaiting approve/deny) → needs input. A poll/permission on an empty session
  // is just startup noise, so gate on having real content.
  if (awaitingInput && hasMsgs) return "needs_input";
  if (agentStatus === "permission_blocked" && hasMsgs) return "needs_input";

  // Actively producing, or carrying deliverable queued work on a live daemon.
  if (agentStatus && ACTIVE_AGENT_STATUSES.has(agentStatus)) return "working";
  if (canDeliver && hasPending) return "working";

  // Dead with output → a human needs to read/restart it. A dead daemon cannot
  // deliver a wake, so no rest verdict survives this arm — except "done", which
  // trustedAgentStatus never coerces to dead in the first place.
  if (dead) return hasMsgs ? "needs_input" : "idle";

  // Settled with content: who acts next? A rest verdict names a machine (dormant)
  // or nobody (done); otherwise the ball is in the user's court — the web inbox
  // files that under NEEDS INPUT, so the CLI matches. This also covers
  // unresponsive sessions (a hanging user message on a dead daemon needs a human
  // to restart it) — a hard block, so no verdict or park stamp outranks it.
  if (isIdle) return hasMsgs ? (isUnresponsive ? "needs_input" : restState()) : "idle";

  // Not idle but no active status either: mid-grace right after a turn, or the
  // user just sent a message the agent hasn't picked up — work in flight.
  return hasMsgs ? "working" : "idle";
}

// ── Placement ────────────────────────────────────────────────────────────────

export interface InboxPlacementInput extends WorkStateInput {
  /** inbox_dismissed_at set. */
  dismissed: boolean;
  /** inbox_stashed_at set. */
  stashed: boolean;
  /** inbox_pinned_at set. */
  pinned: boolean;
  /** The row is an anchor (a standing agent member); hidden unless hard blocked. */
  isAnchor: boolean;
  /** Own open ask or permission prompt, a pending `cast decide`, or a child's open ask. */
  asking: boolean;
}

export type InboxPlacement = { bucket: InboxBucket; work_state: WorkState };

// The machine cannot proceed, or is gone: an open ask, a permission prompt, an
// unresolved API-error banner, a dead or unresponsive agent with output. The one
// condition that surfaces an anchor row out of `hidden`.
export function isHardBlocked(input: Pick<WorkStateInput, "awaitingInput" | "pendingApiError" | "agentStatus" | "messageCount" | "isUnresponsive">): boolean {
  const hasMsgs = input.messageCount > 0;
  if (input.awaitingInput) return true;
  if (input.pendingApiError && hasMsgs) return true;
  if (input.agentStatus === "permission_blocked") return true;
  if (!!input.agentStatus && DEAD_AGENT_STATUSES.has(input.agentStatus) && hasMsgs) return true;
  return input.isUnresponsive;
}

// The mutually exclusive bucket, first rule wins (design C3). `work_state` is
// still stamped on every row — a pinned row keeps its verdict so the CLI's
// `pinned` and `live` tallies sit next to unchanged work figures.
export function placeInboxRow(input: InboxPlacementInput): InboxPlacement {
  const work_state = classifyWorkState(input);
  let bucket: InboxBucket;
  if (input.dismissed) bucket = "dismissed";
  else if (input.stashed) bucket = "stashed";
  else if (input.isAnchor && !isHardBlocked(input)) bucket = "hidden";
  else if (input.asking) bucket = "questions";
  else if (input.pinned) bucket = "pinned";
  else if (input.messageCount === 0) bucket = "new";
  else bucket = work_state;
  return { bucket, work_state };
}

// ── Time flip ────────────────────────────────────────────────────────────────

export type InboxBucketStale = { bucket_stale_at: number | null; stale_bucket: InboxBucket | null };

// Convex re-executes a subscription only when a document in its read set
// changes, so a stamped bucket can outlive the thresholds it was computed with.
// Given the row's time-term deadlines (absolute ms: the trust TTL, the idle
// grace, the heartbeat windows, a child's producing grace…) and a pure
// `placeAt(now)` over identical inputs, find the earliest deadline after `from`
// (the clock the current placement used) whose passing changes the bucket. The
// client renders `stale_bucket` once its coarse clock passes the stamp; the
// overlay probe treats a passed stamp as staleness and fetches a fresh
// execution (design C2).
export function computeBucketStale(
  input: {
    deadlines: Iterable<number | null | undefined>;
    placeAt: (now: number) => InboxPlacement;
    current: InboxBucket;
  },
  from: number,
): InboxBucketStale {
  const seen = new Set<number>();
  const sorted: number[] = [];
  for (const d of input.deadlines) {
    if (typeof d !== "number" || !Number.isFinite(d) || d <= from || seen.has(d)) continue;
    seen.add(d);
    sorted.push(d);
  }
  sorted.sort((a, b) => a - b);
  for (const d of sorted) {
    const next = input.placeAt(d + 1).bucket;
    if (next !== input.current) return { bucket_stale_at: d, stale_bucket: next };
  }
  return { bucket_stale_at: null, stale_bucket: null };
}

// ── Digest ───────────────────────────────────────────────────────────────────

// FNV-1a 32 over the string's UTF-16 code units. Ids and bucket names are
// ASCII, so this equals the byte form; defined over code units so every runtime
// hashes identically without an encoder.
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

// Order-independent digest over (id, bucket) pairs: per pair h = fnv1a32(id:bucket),
// folded into two 32-bit lanes (a plain sum and a sum of imul(h, h|1)), rendered
// as 16 lowercase hex characters. No sorting, no BigInt, no whole-set string.
export function digestProjection(pairs: Iterable<readonly [string, string]>): string {
  let laneA = 0;
  let laneB = 0;
  for (const [id, bucket] of pairs) {
    const h = fnv1a32(`${id}:${bucket}`);
    laneA = (laneA + h) >>> 0;
    laneB = (laneB + Math.imul(h, h | 1)) >>> 0;
  }
  return hex8(laneA) + hex8(laneB);
}
