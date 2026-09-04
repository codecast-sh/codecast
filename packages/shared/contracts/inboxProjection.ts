// The inbox projection: ONE pure placement function, one bucket alphabet and one
// digest, shared by the Convex overlay (sessionsLiveness / teamSessionsLiveness),
// the CLI inbox (inboxForCLI) and every client that renders or verifies the
// inbox. See docs/architecture/sync-convergence.md (C3, C8).
//
// PURE isomorphic code: no Node or DOM APIs, no BigInt, so the Convex runtime,
// the daemon, the browser and React Native all run the same bytes.
import { ACTIVE_AGENT_STATUSES, AGENT_IDLE_GRACE_MS, HEARTBEAT_ALIVE_MS, STATUS_TRUST_TTL_MS, trustedAgentStatus } from "./agentStatus";
import { isMachineDeliveredMessage } from "./machineMessages";
import { isLoopFresh, LOOP_OVERDUE_GRACE_MS, type LoopState } from "./loopState";
import { openTasksVouchForWaiting, OPEN_TASKS_FRESH_MS } from "./openTasks";
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

// Bumped on ANY behavior change to the shared computation (membership, fold,
// placement, digest). The golden fixtures assert their hash against it, and a
// client compares only when the payload's `v` equals its own constant — a
// deploy skew window becomes silence plus a metric, never a heal storm (C6).
// v2: digest over (id, bucket, below_fold) triples; the shared working-set
// selection and fold; `as_of` removed from the envelope.
// v3: an agent-team teammate rides its present lead's bucket and fold
// (rideLeadPlacements), so the team files as one group everywhere.
export const INBOX_PROJECTION_VERSION = 4 as const;

export type InboxProjection = {
  v: typeof INBOX_PROJECTION_VERSION;
  // The projection's clock — the ONLY time term in the envelope. No raw
  // execution timestamp may join it: two executions inside one minute over the
  // same data must be byte identical so Convex suppresses the push (C2).
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
  /** The session sleeps on a live harness /loop wakeup (loop_state armed, not overdue — see dormancy.isArmedLoopHome). Same standing strength as armedTriggerHome: the machine owns the next move. */
  armedLoopHome?: boolean;
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
    if (declaredDormant || input.armedTriggerHome || input.armedLoopHome || input.userDormant) return "dormant";
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

  // Dead or unresponsive with output → a human needs to read/restart it. A
  // dead daemon cannot deliver a wake, so no rest verdict survives this arm —
  // except "done", which trustedAgentStatus never coerces to dead in the first
  // place. Unresponsive (a hanging user message or queued work on a daemon
  // that is gone) is the same hard block whatever is_idle says: the server
  // keeps is_idle false while work is queued, which used to drop such a row
  // into the "work in flight" arm below and file it WORKING forever (found by
  // the two-replica simulation, 2026-09-01).
  if (dead || isUnresponsive) return hasMsgs ? "needs_input" : "idle";

  // Settled with content: who acts next? A rest verdict names a machine (dormant)
  // or nobody (done); otherwise the ball is in the user's court — the web inbox
  // files that under NEEDS INPUT, so the CLI matches.
  if (isIdle) return hasMsgs ? restState() : "idle";

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
  // A killed row is triaged: its prompt or pending decide has nobody to answer
  // it, so it never files as a question (the replica's asking derivation and
  // the web decision queue already skip killed rows; the two-replica
  // simulation caught the server stamping a killed pinned row `questions`).
  else if (input.asking && !input.killed) bucket = "questions";
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
export const FNV1A32_OFFSET = 0x811c9dc5;

// One step of the hash: fold `s` into a running state `h`. Callers that hash a
// stream of tags (the store's deadline signature) use this instead of
// concatenating a whole-set string.
export function fnv1a32Update(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fnv1a32(s: string): number {
  return fnv1a32Update(FNV1A32_OFFSET, s);
}

function hex8(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

// Order-independent digest over (id, bucket, below_fold) triples: per entry
// h = fnv1a32(`id:bucket:fold`), folded into two 32-bit lanes (a plain sum and
// a sum of imul(h, h|1)), rendered as 16 lowercase hex characters. No sorting,
// no BigInt, no whole-set string. Fold is in the digest on purpose: with show
// old off the headline count is the shown tally, so two replicas that agree on
// every bucket but cut the fold differently are diverged, and the digest must
// say so.
export function digestProjection(entries: Iterable<readonly [string, string, boolean]>): string {
  let laneA = 0;
  let laneB = 0;
  for (const [id, bucket, fold] of entries) {
    const h = fnv1a32(`${id}:${bucket}:${fold ? "1" : "0"}`);
    laneA = (laneA + h) >>> 0;
    laneB = (laneB + Math.imul(h, h | 1)) >>> 0;
  }
  return hex8(laneA) + hex8(laneB);
}

// ── Membership: the visibility rule ─────────────────────────────────────────

// Lifted from convex/inboxFilters.ts so the server scan and every replica run
// ONE implementation (design C4); convex re-exports these back.
export const NOISE_TITLE_PREFIXES = ["[Using:", "[Request", "[SUGGESTION MODE:"] as const;

export function isNoiseTitle(title: string | null | undefined): boolean {
  const t = title?.trim() || "";
  if (!t) return false;
  if (t.toLowerCase() === "warmup") return true;
  return NOISE_TITLE_PREFIXES.some((p) => t.startsWith(p));
}

// A row that can never be its own projection member: subagents, workflow subs,
// and rows with a parent pointer but no parent message (orphans). Their state
// surfaces only on the parent (asking rollup, producing grace).
export interface InboxRowIdentity {
  is_subagent?: boolean | null;
  is_workflow_sub?: boolean | null;
  parent_conversation_id?: unknown;
  parent_message_uuid?: string | null;
}

export function isOrphanOrSubagent(conv: InboxRowIdentity): boolean {
  if (conv.is_subagent === true) return true;
  if (conv.is_workflow_sub === true) return true;
  if (conv.parent_conversation_id && !conv.parent_message_uuid) return true;
  return false;
}

// The parent a child's state rolls up to (its open ask lifts the parent into
// QUESTIONS; its producing status keeps the parent working). ONE rule for the
// server pool grouping (groupPoolChildren) and the replica's asking
// derivation, so a parent can never be lifted on one side only:
//   - a row that is never its own member (isOrphanOrSubagent) rolls up to its
//     parent_conversation_id;
//   - a plan handoff (parent pointer + parent message, not a subagent) is its
//     own member and speaks for itself — no rollup;
//   - an agent-team teammate (spawned_by + agent_team_name, no parent pointer)
//     is its own member AND rolls up to its lead: the lead card is where the
//     team's asks surface.
export interface RollupRow extends InboxRowIdentity {
  spawned_by_conversation_id?: unknown;
  agent_team_name?: string | null;
  agent_name?: string | null;
}

export function rollupParentIdOf(row: RollupRow): string | null {
  if (row.parent_conversation_id) {
    return isOrphanOrSubagent(row) ? String(row.parent_conversation_id) : null;
  }
  if (row.agent_team_name && row.agent_name !== "team-lead" && row.spawned_by_conversation_id) return String(row.spawned_by_conversation_id);
  return null;
}

// ── Riding the lead ─────────────────────────────────────────────────────────
//
// A member whose state rolls up to another member (rollupParentIdOf: an
// agent-team teammate under its lead) never stands alone in the inbox. It
// stays a member — it holds its seat, it lists, and its own verdict is what an
// orchestrator watches to see a worker finish — but it takes its lead's BUCKET
// and FOLD, so the team files as one group under the lead card on every
// replica and on the server, and a section's count is the rows nested inside
// it. The lead is who acts on a teammate; a finished worker under a working
// lead is the lead's to collect, not a card for the human to answer.
//
// Riding stops at a deliberate act on the row itself: a teammate the viewer
// pinned, stashed or dismissed on its own keeps that place (RIDE_KEEPS_OWN),
// and a fold-exempt row (a pin, a stash, queued work) never folds through its
// lead. Chains ride to their root; a cycle rides nowhere. A rider whose lead is
// not present keeps its own placement and renders where it stands.
//
// `settleRiders` is the one traversal: it visits every rider after its lead
// has settled, so a caller reads the lead's FINAL state. Callers hand it the
// rows to decide presence and the ride step to apply.
export function settleRiders(
  ids: Iterable<string>,
  rowOf: (id: string) => RollupRow | undefined,
  ride: (riderId: string, leadId: string) => void,
  keepsOwn: (id: string) => boolean = () => false,
): void {
  const settled = new Set<string>();
  // Settles `id` and everything above it; false when the chain above closes
  // on itself, in which case nothing on it rides.
  const settle = (id: string, trail: Set<string>): boolean => {
    if (settled.has(id)) return true;
    if (trail.has(id)) return false;
    const row = rowOf(id);
    const leadId = row && !keepsOwn(id) ? rollupParentIdOf(row) : null;
    if (leadId && leadId !== id && rowOf(leadId)) {
      trail.add(id);
      const acyclic = settle(leadId, trail);
      trail.delete(id);
      if (!acyclic) return false;
      ride(id, leadId);
    }
    settled.add(id);
    return true;
  };
  for (const id of ids) settle(id, new Set());
}

export const RIDE_KEEPS_OWN: ReadonlySet<InboxBucket> = new Set<InboxBucket>(["dismissed", "stashed", "pinned"]);

// The bucket ride over an id → placement map, in place: a rider takes its
// present lead's bucket. The fold rides inside computeFold (the one fold
// computation every channel reads), never by copying a flag — an exempt rider
// must stay above the fold whatever its lead does. Shared by projectInbox, the
// server overlay, the CLI stamping and the web chokepoint, so a teammate can
// never nest on one side and float on another. `copy` lets a caller carry more
// of the lead's stamp (the server's time-flip fields) with the bucket.
export function rideLeadPlacements<P extends { bucket: InboxBucket }>(
  placements: Map<string, P>,
  rowOf: (id: string) => RollupRow | undefined,
  copy: (rider: P, lead: P) => void = () => {},
): void {
  settleRiders(
    placements.keys(),
    (id) => (placements.has(id) ? rowOf(id) : undefined),
    (riderId, leadId) => {
      const rider = placements.get(riderId)!;
      const lead = placements.get(leadId)!;
      rider.bucket = lead.bucket;
      copy(rider, lead);
    },
    (id) => RIDE_KEEPS_OWN.has(placements.get(id)!.bucket),
  );
}

export interface InboxVisibilityRow extends InboxRowIdentity {
  status?: string;
  message_count?: number | null;
  title?: string | null;
  inbox_killed_at?: number | null;
  inbox_pinned_at?: number | null;
}

// A stash that survives machine wakes ("stash and hide"). A plain stash is
// cleared by any send into the session, a trigger wake included — the user
// wants to see the row when something happens to it. A hidden stash keeps the
// agent working out of sight; only an ask (blocked declaration, needs-attention
// run, a stall) brings it back. The flag is honored only while the stash stamp
// is set, so a stale `true` on an unstashed row means nothing.
export function isStashHidden(
  row: { inbox_stashed_at?: number | null; inbox_stash_hidden?: boolean | null },
): boolean {
  return !!row.inbox_stashed_at && !!row.inbox_stash_hidden;
}

// `inbox_dismissed_at` is an absolute flag: a truthy value means dismissed until
// a user action clears it. Never compare it against `updated_at`. Dismissed
// conversations are still part of the inbox — they place in their own bucket.
// Drops subagent/orphan rows, completed rows with zero messages, noise titles,
// and killed rows unless pinned.
export function shouldShowInInbox(conv: InboxVisibilityRow): boolean {
  if (isOrphanOrSubagent(conv)) return false;
  if (conv.status === "completed" && (conv.message_count ?? 0) === 0) return false;
  if (isNoiseTitle(conv.title)) return false;
  if (conv.inbox_killed_at && !conv.inbox_pinned_at) return false;
  return true;
}

// ── Stamp currency (dormant gesture, settle verdict) ────────────────────────

// The user's "dormant" gesture is a stamp that any later activity silently
// expires: honored while newer than the row's last activity, dead the moment a
// wake, a message, or a new turn bumps updated_at. No write un-parks; the row
// simply moves on.
export function isUserDormant(
  conv: { inbox_dormant_at?: number | null; updated_at: number },
): boolean {
  return !!conv.inbox_dormant_at && conv.inbox_dormant_at >= conv.updated_at;
}

// The settle classifier writes its verdict AFTER the settle it describes, so a
// current verdict is always newer than the row's last activity. The next turn
// bumps updated_at past it and the verdict is stale until the next settle —
// during which the active arms of classifyWorkState win anyway. Same contract
// as isUserDormant, deliberately.
export function isSettleVerdictCurrent(
  conv: { settle_verdict_at?: number | null; updated_at: number },
): boolean {
  return !!conv.settle_verdict_at && conv.settle_verdict_at >= conv.updated_at;
}

// ── The working set (design C4) ─────────────────────────────────────────────

// The five capped windows the server scan reads and an honest replica must
// select identically. Single source: convex derives INBOX_WINDOW_CAP and
// INBOX_PINNED_CAP from this map.
export const INBOX_WINDOW_CAPS = {
  recent: 200,
  pinned: 100,
  dismissed: 200,
  stashed: 200,
  owned: 200,
} as const;

export type WorkingSetWindow = keyof typeof INBOX_WINDOW_CAPS;

export const WORKING_SET_WINDOWS = Object.keys(INBOX_WINDOW_CAPS) as readonly WorkingSetWindow[];

// Is this truncation flag one of the five windows (as opposed to a member or
// scan cap)? The compare drops a row whose every window overflowed.
export function isWorkingSetWindow(t: InboxTruncation): t is WorkingSetWindow {
  return (WORKING_SET_WINDOWS as readonly string[]).includes(t);
}

// How far back a row's stamp may be and still hold its window seat.
export const WORKING_SET_RECENCY_MS = 30 * 24 * 60 * 60 * 1000;
// The fold: a clean gap this wide in the recent members' activity hides
// everything older behind the show-old toggle.
export const INBOX_FOLD_GAP_MS = 12 * 60 * 60 * 1000;

// The row fields membership and fold read. Facts (updated_at) ride the
// overlay, so the selection input is fresh for every covered row.
export interface WorkingSetRow extends InboxVisibilityRow, RollupRow {
  _id: string | { toString(): string };
  updated_at: number;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  has_pending_messages?: boolean | null;
  /** Membership in the viewer's session_owners set, stamped by the caller. */
  owned_by_me?: boolean | null;
}

// Window eligibility BEFORE caps ([] = nonmember). Top-level rows only, after
// shouldShowInInbox — both checks live here so a caller cannot forget them.
export function inWorkingSet(row: WorkingSetRow, epoch: number): WorkingSetWindow[] {
  if (!shouldShowInInbox(row)) return [];
  const windows: WorkingSetWindow[] = [];
  const horizon = epoch - WORKING_SET_RECENCY_MS;
  const recentEligible =
    (row.status === "active" || row.status === "completed") && row.updated_at >= horizon;
  if (recentEligible) windows.push("recent");
  if (row.inbox_pinned_at) windows.push("pinned");
  if (!row.inbox_killed_at) {
    if (row.inbox_dismissed_at && row.inbox_dismissed_at >= horizon) windows.push("dismissed");
    if (row.inbox_stashed_at && row.inbox_stashed_at >= horizon) windows.push("stashed");
  }
  if (row.owned_by_me && recentEligible) windows.push("owned");
  return windows;
}

const WINDOW_SORT_KEY: Record<Exclude<WorkingSetWindow, "owned">, (row: WorkingSetRow) => number> = {
  recent: (r) => r.updated_at,
  pinned: (r) => r.inbox_pinned_at ?? 0,
  dismissed: (r) => r.inbox_dismissed_at ?? 0,
  stashed: (r) => r.inbox_stashed_at ?? 0,
};

export type WorkingSetMember<Row extends WorkingSetRow = WorkingSetRow> = {
  row: Row;
  /** ELIGIBILITY windows (before caps): what the row's own stamps claim. */
  windows: WorkingSetWindow[];
};

// The shared selection, caps included: the union of the per-window top K over
// eligible rows. When a window overflows it names itself in `truncated` and the
// compare drops that window's rows on both sides — a capped window is dark to
// the proof. The owned window has no replicated order (server owner-row order),
// so under overflow it keeps an arbitrary K and relies on the flag.
export function selectWorkingSet<Row extends WorkingSetRow>(
  rows: Iterable<Row>,
  epoch: number,
): { members: Map<string, WorkingSetMember<Row>>; truncated: InboxTruncation[] } {
  const eligible: Array<{ id: string; member: WorkingSetMember<Row> }> = [];
  for (const row of rows) {
    const windows = inWorkingSet(row, epoch);
    if (windows.length === 0) continue;
    eligible.push({ id: String(row._id), member: { row, windows } });
  }
  const truncated = new Set<InboxTruncation>();
  const members = new Map<string, WorkingSetMember<Row>>();
  for (const w of WORKING_SET_WINDOWS) {
    const cap = INBOX_WINDOW_CAPS[w];
    let inWindow = eligible.filter((e) => e.member.windows.includes(w));
    if (inWindow.length > cap) {
      truncated.add(w);
      if (w !== "owned") {
        const key = WINDOW_SORT_KEY[w];
        inWindow = [...inWindow].sort((a, b) => key(b.member.row) - key(a.member.row));
      }
      inWindow = inWindow.slice(0, cap);
    }
    for (const e of inWindow) if (!members.has(e.id)) members.set(e.id, e.member);
  }
  return { members, truncated: INBOX_TRUNCATION_KINDS.filter((k) => truncated.has(k)) };
}

// ── The fold (design C4) ────────────────────────────────────────────────────

// A row someone filed on purpose is never fold material: a pin, a dismiss or a
// stash STAMP (the same stamps placement reads — a dismissed row sits in the
// dismissed bucket whether or not its stamp still holds a window seat), or an
// owner seat. ONE rule for the shared fold and the server's per-row flag
// (convex belowFoldFor); a parallel predicate keyed on window membership
// instead of the stamp diverged exactly at the 30-day stamp horizon (found by
// the generated-world property test, 2026-09-01).
export function isFoldExempt(row: WorkingSetRow): boolean {
  if (row.inbox_pinned_at || row.inbox_dismissed_at || row.inbox_stashed_at) return true;
  return !!row.owned_by_me;
}

// The per-row half of the fold, given the cut: exempt rows never fold, queued
// work (has_pending_messages) is about to move so it never folds either, and
// everything else folds when its activity is under the cut. A cutoff of 0
// means no fold. The shared loop below and the server's per-row flag
// (convex belowFoldFor) both call this, so the two cannot diverge.
export function isBelowFoldAt(row: WorkingSetRow, cutoff: number): boolean {
  if (cutoff <= 0) return false;
  if (isFoldExempt(row)) return false;
  if (row.has_pending_messages) return false;
  return row.updated_at < cutoff;
}

// Deterministic 12h gap cut by updated_at over members NOT filed on purpose
// (isFoldExempt): pinned, dismissed, stashed and owned rows are someone's
// explicit act and never fold (nor bridge a gap that should hide the caller's
// cruft). Rows outside the selection (CLI label extras, foreign channels) are
// fold exempt on every channel — they are simply not in `members`. Queued work
// (has_pending_messages) is about to move, so it never folds either, though
// it still counts toward the gap. Fold never changes membership; it splits
// the tally and the default rendering.
export function computeFold(
  members: ReadonlyMap<string, WorkingSetMember>,
): { belowFold: Set<string>; cutoff: number } {
  const candidates: Array<{ id: string; row: WorkingSetRow }> = [];
  for (const [id, m] of members) {
    if (isFoldExempt(m.row)) continue;
    candidates.push({ id, row: m.row });
  }
  candidates.sort((a, b) => b.row.updated_at - a.row.updated_at);
  let cutoff = 0;
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i - 1].row.updated_at - candidates[i].row.updated_at > INBOX_FOLD_GAP_MS) {
      cutoff = candidates[i].row.updated_at;
      break;
    }
  }
  const belowFold = new Set<string>();
  for (const c of candidates) {
    if (isBelowFoldAt(c.row, cutoff)) belowFold.add(c.id);
  }
  // A candidate folds with its present lead (see settleRiders): a finished
  // teammate older than the cut stays visible under a lead above it, and one
  // fresher than the cut folds away with a lead below it. Exempt rows are not
  // candidates and never fold, so a rider under a pinned lead stays shown.
  const candidateIds = new Set(candidates.map((c) => c.id));
  settleRiders(
    candidateIds,
    (id) => members.get(id)?.row,
    (riderId, leadId) => {
      if (belowFold.has(leadId)) belowFold.add(riderId);
      else belowFold.delete(riderId);
    },
    (id) => !candidateIds.has(id),
  );
  return { belowFold, cutoff };
}

// ── Row placement from replicated fields (design C3/C5) ─────────────────────

// Everything projectInbox needs on a row: the conversation's own semantic
// fields plus the overlay-owned facts. All optional except updated_at — a
// classifier must read an absent fact as unknown and fall back honestly.
export interface ProjectableInboxRow extends WorkingSetRow {
  inbox_dormant_at?: number | null;
  anchor_id?: unknown;
  armed_trigger_kind?: string | null;
  // The pull request this session shepherds (prShepherd.refreshConversationPrStatus).
  // Presentation only: no bucket or work-state rule reads it.
  pr_status?: {
    pr_id: string;
    repository: string;
    number: number;
    title?: string;
    state: string;
    at: number;
  } | null;
  loop_state?: Pick<LoopState, "status" | "wakeup_at" | "fired_at" | "event_at"> | null;
  settle_verdict?: string | null;
  settle_verdict_at?: number | null;
  thread_state_status?: string | null;
  pending_api_error?: boolean | null;
  /** The last USER message (conversations.last_message_preview / last_user_message). */
  last_message_preview?: string | null;
  last_user_message?: string | null;
  // Overlay-owned facts (INBOX_FACT_FIELDS).
  agent_status?: string | null;
  is_idle?: boolean | null;
  is_unresponsive?: boolean | null;
  awaiting_input?: boolean | null;
  last_turn_allows_park?: boolean | null;
  agent_status_updated_at?: number | null;
  last_heartbeat?: number | null;
  last_role_is_user?: boolean | null;
  auq_open?: boolean | null;
  daemon_alive_until?: number | null;
  producing_until?: number | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
}

// ── Live facts (design C1/C2) ────────────────────────────────────────────────
// The server derives a row's is_idle from inputs a replica never held: when
// the daemon last changed status, whether the newest message is a user turn,
// when the daemon's liveness lapses, and until when a child keeps the parent
// producing. Those now replicate as facts, and THIS function is the one idle
// rule: the overlay runs it at its epoch to stamp the row, the replica runs it
// at its own clock to render, and the time flip (computeBucketStale) runs it
// at each deadline on both sides. Every term is monotone in `t` for fixed
// facts (a grace passes, a heartbeat lapses, a status decays, production
// ends), so re-running it over an already-coerced shipped status is
// idempotent and only ever moves a row toward settled — never back.

export interface SessionIdleInput {
  /** managed_sessions.agent_status, coerced for heartbeat staleness by the caller. */
  agentStatus?: string;
  /** managed_sessions.agent_status_updated_at — when the daemon last *changed* the status. */
  agentStatusUpdatedAt?: number;
  hasPending: boolean;
  /** Last message (by sync order) is a non-interrupt user turn. */
  lastRoleIsUser: boolean;
  /** (now - conv.updated_at) < AGENT_IDLE_GRACE_MS. */
  recentlyUpdated: boolean;
  daemonAlive: boolean;
  now: number;
}

// Whether a top-level session is idle (agent finished its turn, ball in the
// user's court). The subtle part is the grace window that avoids flickering to
// "needs input" the instant an assistant turn ends.
//
// When the daemon reports a definite status, the grace is measured from
// `agentStatusUpdatedAt` (the moment the Stop hook flipped the agent to
// idle/stopped) — NOT from `conv.updated_at`. The conversation's updated_at is
// bumped by every synced message, so a large message backlog draining in after
// a turn ends keeps `recentlyUpdated` true for minutes and would otherwise pin a
// finished agent in "working" long past the grace. Once the status has settled
// past the grace, the agent is genuinely waiting on the user, so we ignore both
// the updated_at churn and a lagging last_message_role (the final assistant turn
// may not have synced yet). When the status timestamp is absent (legacy
// sessions), fall back to the conv.updated_at recency gate.
export function isSessionIdle(input: SessionIdleInput): boolean {
  const {
    agentStatus,
    agentStatusUpdatedAt,
    hasPending,
    lastRoleIsUser,
    recentlyUpdated,
    daemonAlive,
    now,
  } = input;

  if (agentStatus) {
    if (ACTIVE_AGENT_STATUSES.has(agentStatus)) return false;
    if (hasPending) return false; // queued work — agent isn't waiting on the user
    const settled =
      agentStatusUpdatedAt !== undefined &&
      now - agentStatusUpdatedAt >= AGENT_IDLE_GRACE_MS;
    if (settled) return true;
    // Within the grace (or no status timestamp): stay conservative.
    return !lastRoleIsUser && !recentlyUpdated;
  }

  // No daemon status: fall back to liveness + recency heuristics.
  return daemonAlive
    ? !hasPending && !lastRoleIsUser && !recentlyUpdated
    : !recentlyUpdated;
}

export interface LiveFactsRow {
  status?: string | null;
  updated_at: number;
  message_count?: number | null;
  has_pending_messages?: boolean | null;
  inbox_dismissed_at?: number | null;
  inbox_stashed_at?: number | null;
  agent_status?: string | null;
  agent_status_updated_at?: number | null;
  last_heartbeat?: number | null;
  daemon_alive_until?: number | null;
  producing_until?: number | null;
  last_role_is_user?: boolean | null;
  auq_open?: boolean | null;
  awaiting_input?: boolean | null;
  open_tasks?: unknown[] | null;
  open_tasks_at?: number | null;
  loop_state?: Pick<LoopState, "status" | "wakeup_at"> | null;
}

export type LiveFacts = {
  agent_status: string | null;
  is_idle: boolean;
  is_unresponsive: boolean;
  awaiting_input: boolean;
  daemon_alive: boolean;
};

export function deriveLiveAt(row: LiveFactsRow, t: number): LiveFacts {
  const msgs = row.message_count ?? 0;
  const hasPending = !!row.has_pending_messages;
  // isLiveAt: the row's own heartbeat inside the window (the liveness set and
  // the heartbeat map are populated together, so this IS membership).
  const heartbeatAlive = row.last_heartbeat != null && t - row.last_heartbeat < HEARTBEAT_ALIVE_MS;
  const verifiedWaiting = openTasksVouchForWaiting(row.open_tasks_at, row.open_tasks?.length ?? 0, t);
  const agentStatus = trustedAgentStatus(row.agent_status ?? undefined, row.updated_at, t, heartbeatAlive, verifiedWaiting);
  // A stopped agent is never connected, whatever the user's other daemons say.
  const daemonAlive = agentStatus !== "stopped" && row.daemon_alive_until != null && t < row.daemon_alive_until;
  const recentlyUpdated = t - row.updated_at < AGENT_IDLE_GRACE_MS;
  const lastRoleIsUser = !!row.last_role_is_user;
  const isUnresponsive = (row.status ?? "active") === "active" && !daemonAlive && (
    (lastRoleIsUser && !recentlyUpdated) || (hasPending && !recentlyUpdated)
  );
  let isIdle = isSessionIdle({
    agentStatus,
    agentStatusUpdatedAt: row.agent_status_updated_at ?? undefined,
    hasPending,
    lastRoleIsUser,
    recentlyUpdated,
    daemonAlive,
    now: t,
  });
  // An open AskUserQuestion poll is the agent blocking on the user: needs
  // input, never working. The poll fact is the probe's answer; a row from an
  // older channel carries only the epoch's awaiting_input, which is the same
  // answer already gated on not-idle.
  let awaitingInput = false;
  if (!isIdle && msgs > 0 && (row.auq_open ?? row.awaiting_input ?? false)) {
    awaitingInput = true;
    isIdle = true;
  }
  // An idle parent stays working while a child is genuinely producing; never
  // for dismissed or stashed rows.
  if (isIdle && !row.inbox_dismissed_at && !row.inbox_stashed_at && msgs > 0 && row.producing_until != null && t < row.producing_until) {
    isIdle = false;
  }
  return { agent_status: agentStatus ?? null, is_idle: isIdle, is_unresponsive: isUnresponsive, awaiting_input: awaitingInput, daemon_alive: daemonAlive };
}

// Every instant at which one of the row's time terms crosses its threshold
// (design C2): the idle grace on activity and on the status change, the
// heartbeat window, the trust TTL, the daemon and production deadlines, the
// open-task freshness, and an armed loop going overdue. The server's time flip
// and the replica's recompute scheduler both read this list, so a deadline
// cannot exist on one side only.
export function rowLiveDeadlines(row: LiveFactsRow): Array<number | null> {
  const u = row.updated_at;
  return [
    u + AGENT_IDLE_GRACE_MS,
    u + HEARTBEAT_ALIVE_MS,
    u + STATUS_TRUST_TTL_MS,
    row.agent_status_updated_at != null ? row.agent_status_updated_at + AGENT_IDLE_GRACE_MS : null,
    row.last_heartbeat != null ? row.last_heartbeat + HEARTBEAT_ALIVE_MS : null,
    row.daemon_alive_until ?? null,
    row.producing_until ?? null,
    row.open_tasks_at != null ? row.open_tasks_at + OPEN_TASKS_FRESH_MS : null,
    row.loop_state?.status === "armed" ? row.loop_state.wakeup_at + LOOP_OVERDUE_GRACE_MS : null,
  ];
}

// The machine-delivered-last-turn rule behind every structural park: an armed
// trigger/loop home parks only while the machine delivered the last user turn
// (or there is none) — a human who spoke last is triaging the session. Prefers
// the replicated `last_turn_allows_park` fact (the server computed it from the
// newest message, including the probed fallback the preview lacks); falls back
// to the preview fields for rows the overlay has not covered.
export function rowLastTurnAllowsPark(row: Pick<ProjectableInboxRow, "last_turn_allows_park" | "last_message_preview" | "last_user_message">): boolean {
  if (typeof row.last_turn_allows_park === "boolean") return row.last_turn_allows_park;
  const preview = row.last_message_preview ?? row.last_user_message ?? null;
  return !preview || isMachineDeliveredMessage(preview);
}

// The one row → placement adapter: builds the InboxPlacementInput from
// replicated fields and runs the shared placeInboxRow. The server's
// placeConversationRow and every replica surface delegate here, so a rule can
// never exist on one side only.
export function placeProjectableRow(
  row: ProjectableInboxRow,
  asking: boolean,
  epoch: number,
): InboxPlacement {
  const park = rowLastTurnAllowsPark(row);
  const loop = row.loop_state;
  return placeInboxRow({
    agentStatus: row.agent_status ?? undefined,
    isIdle: !!row.is_idle,
    awaitingInput: !!row.awaiting_input,
    hasPending: !!row.has_pending_messages,
    isUnresponsive: !!row.is_unresponsive,
    messageCount: row.message_count ?? 0,
    killed: !!row.inbox_killed_at,
    userDormant: isUserDormant(row as { inbox_dormant_at?: number | null; updated_at: number }),
    armedTriggerHome: (row.armed_trigger_kind ?? "none") === "standing" && park,
    armedLoopHome: !!loop && loop.status === "armed" && isLoopFresh(loop, epoch) && park,
    armedOnceTriggerHome: (row.armed_trigger_kind ?? "none") === "once" && park,
    settleVerdict: isSettleVerdictCurrent(row as { settle_verdict_at?: number | null; updated_at: number }) ? (row.settle_verdict ?? null) : null,
    declaredStatus: row.thread_state_status ?? null,
    pendingApiError: row.pending_api_error === true,
    dismissed: !!row.inbox_dismissed_at,
    stashed: !!row.inbox_stashed_at,
    pinned: !!row.inbox_pinned_at,
    isAnchor: !!row.anchor_id,
    asking,
  });
}

// ── The whole projection in one call (design C5/C6) ─────────────────────────

// Inputs a replica derives outside the row (never stored on it): the asking
// flag — own open prompt, pending `cast decide`, or a child's open ask.
export type InboxProjectionInputs = {
  asking?: (id: string) => boolean;
};

// Membership, fold, placement, tallies and digest over a replica's rows at one
// epoch. The show-old view key does not enter the computation — it names which
// tally is the headline (`shown` vs `shown + folded`); both are always
// returned so a toggle costs no recompute. Hidden-bucket rows enter `entries`
// and the digest but never the tallies.
export function projectInbox<Row extends ProjectableInboxRow>(
  rows: Iterable<Row>,
  epoch: number,
  overlays?: InboxProjectionInputs,
): {
  entries: Array<readonly [string, InboxBucket, boolean]>;
  placements: Map<string, InboxPlacement & { below_fold: boolean }>;
  tally: { shown: InboxTally; folded: InboxTally };
  set_digest: string;
  truncated: InboxTruncation[];
  /** Each member's windows — the compare drops a member whose every window
   *  overflowed (C6), so it needs the selection's view of the row. */
  windows: Map<string, WorkingSetWindow[]>;
} {
  const { members, truncated } = selectWorkingSet(rows, epoch);
  const { belowFold } = computeFold(members);
  const entries: Array<readonly [string, InboxBucket, boolean]> = [];
  const placements = new Map<string, InboxPlacement & { below_fold: boolean }>();
  const windows = new Map<string, WorkingSetWindow[]>();
  const tally = { shown: emptyInboxTally(), folded: emptyInboxTally() };
  for (const [id, m] of members) {
    const asking = overlays?.asking?.(id) ?? false;
    placements.set(id, { ...placeProjectableRow(m.row as ProjectableInboxRow, asking, epoch), below_fold: belowFold.has(id) });
    windows.set(id, m.windows);
  }
  // Every member placed on its own facts first, then riders take their lead's
  // place (rideLeadPlacements); the entries and the tally read the final map.
  rideLeadPlacements(placements, (id) => members.get(id)?.row);
  for (const [id, p] of placements) {
    entries.push([id, p.bucket, p.below_fold]);
    if (p.bucket !== "hidden") (p.below_fold ? tally.folded : tally.shown)[p.bucket]++;
  }
  return { entries, placements, tally, set_digest: digestProjection(entries), truncated, windows };
}

// ── Field ownership (design C1) ─────────────────────────────────────────────

// The overlay-owned FACT fields: one writer (sessionsLiveness / its team twin).
// The server strip list (every other sessions channel nulls these) and the
// client preserve list both derive from this constant, with a signature test,
// so no channel can write a torn or stale fact over a fresher one.
export const INBOX_FACT_FIELDS = [
  "agent_status",
  "is_idle",
  "is_unresponsive",
  "awaiting_input",
  "is_connected",
  "tmux_session",
  "permission_mode",
  "agent_started_at",
  "open_tasks",
  "open_tasks_at",
  "message_count",
  "updated_at",
  "last_turn_allows_park",
  // The is_idle inputs (ct-47609): everything deriveLiveAt needs to re-run the
  // server's idle, responsiveness and status trust rules at ANY instant, so
  // the +45s settle, the heartbeat lapse and the trust decay flip on the
  // replica's own clock instead of waiting for a server re-execution.
  "agent_status_updated_at",
  "last_heartbeat",
  "last_role_is_user",
  "auq_open",
  "daemon_alive_until",
  "producing_until",
] as const;

export type InboxFactField = (typeof INBOX_FACT_FIELDS)[number];

// The projection STAMP fields — checking data, never render sources on a
// replica: stripped from every row channel, stored only in the client's
// per-scope sessionsProjection buffer, and never merged onto session rows.
// `bucket_stale_at` is a client recompute scheduling hint and payload
// staleness signal; `stale_bucket` is never rendered.
export const INBOX_PROJECTION_FIELDS = [
  "bucket",
  "work_state",
  "asking",
  "below_fold",
  "bucket_stale_at",
  "stale_bucket",
] as const;

export type InboxProjectionField = (typeof INBOX_PROJECTION_FIELDS)[number];
