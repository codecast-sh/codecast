// Pure shared pieces for CC account switching — safe to import from schema.ts,
// the mutations (accountSwitch.ts), and tests. No server/_generated imports.

import { v } from "convex/values";

// Per-account usage snapshot the daemon probes from the OAuth usage API
// (percentages + reset times only — non-secret). Mirrors CcUsageSnapshot in
// cli/src/ccAccounts.ts.
const usageWindowValidator = v.object({
  percent: v.number(),
  resets_at: v.optional(v.number()),
  label: v.optional(v.string()),
});

// One usage shape serves both providers. The base windows are shared; the
// trailing optionals only appear on Codex accounts today (scoped: n
// model-scoped limit windows vs Claude's single worst weekly_scoped; models:
// the week's per-model token shares from rollout logs; credits/reset_credits:
// ChatGPT's balance and grantable full resets). All percentages and labels,
// never tokens.
export const ccUsageValidator = v.object({
  fetched_at: v.number(),
  session: v.optional(usageWindowValidator), // rolling short window (5h / sub-24h)
  weekly: v.optional(usageWindowValidator), // 7d, all models
  weekly_scoped: v.optional(usageWindowValidator), // 7d, model-scoped
  extra: v.optional(v.object({ percent: v.number(), enabled: v.boolean() })),
  scoped: v.optional(
    v.array(v.object({ label: v.string(), percent: v.number(), resets_at: v.optional(v.number()) })),
  ),
  credits: v.optional(
    v.object({
      has_credits: v.boolean(),
      unlimited: v.optional(v.boolean()),
      balance: v.optional(v.string()),
    }),
  ),
  reset_credits: v.optional(v.object({ available: v.number() })),
  models: v.optional(
    v.array(
      v.object({
        model: v.string(),
        label: v.string(),
        tokens: v.number(),
        share: v.number(),
      }),
    ),
  ),
});

export type CcUsage = {
  fetched_at: number;
  session?: { percent: number; resets_at?: number; label?: string };
  weekly?: { percent: number; resets_at?: number; label?: string };
  weekly_scoped?: { percent: number; resets_at?: number; label?: string };
  extra?: { percent: number; enabled: boolean };
  scoped?: { label: string; percent: number; resets_at?: number }[];
  credits?: { has_credits: boolean; unlimited?: boolean; balance?: string };
  reset_credits?: { available: number };
  models?: { model: string; label: string; tokens: number; share: number }[];
};

// Validator for the daemon-reported account inventory (names/emails/tiers
// only — never tokens). Stored per device row; consumed by the web switcher.
export const ccAccountsValidator = v.object({
  active_email: v.optional(v.string()),
  active_uuid: v.optional(v.string()),
  profiles: v.array(
    v.object({
      name: v.string(),
      email: v.optional(v.string()),
      tier: v.optional(v.string()),
      subscription: v.optional(v.string()),
      usage: v.optional(ccUsageValidator),
    }),
  ),
});

// Auto-switch bookkeeping, stored on the primary device row. `attempts` is the
// per-incident memory that stops the loop from re-trying an account that
// already parked sessions this window; `exhausted_at` is the UI's "every
// account is spent" signal; `next_check_at` dedupes scheduled re-checks.
export const ccAutoSwitchStateValidator = v.object({
  last_action_at: v.optional(v.number()),
  last_action: v.optional(v.string()), // "switch:<profile>" | "continue"
  attempts: v.optional(v.array(v.object({ profile: v.string(), at: v.number() }))),
  exhausted_at: v.optional(v.number()),
  next_check_at: v.optional(v.number()),
});

// The browser sign-in round trip, stored on the device row that runs it. The
// web writes "pending" (requestLoginFlow) when the user clicks the sign-in
// CTA; the daemon runs `claude auth login`, watches the keychain, and reports
// the outcome (completeLoginFlow). The web watches this field reactively via
// listAccountProfiles — it is the whole UI state channel for the flow.
export const ccLoginFlowValidator = v.object({
  status: v.union(v.literal("pending"), v.literal("confirmed"), v.literal("rejected")),
  // pending: the account we asked the user to sign into (pre-filled in the
  // browser). confirmed: the account that actually signed in.
  email: v.optional(v.string()),
  reason: v.optional(v.string()), // rejected: why (timeout, CLI error tail)
  started_at: v.number(),
  finished_at: v.optional(v.number()),
  // confirmed: how many auth-blocked sessions the server kicked off.
  revived: v.optional(v.number()),
});

// A pending flow older than this is dead weight — the daemon's own watcher
// times out well before (5 min), so a pending row this stale means the daemon
// died mid-flow. Both the web (render the CTA again) and requestLoginFlow
// (allow a fresh start) treat it as no-flow.
export const LOGIN_FLOW_STALE_MS = 6 * 60 * 1000;

/** A limit window whose reset time has already passed has ROLLED: the snapshot
 * describes a window that no longer exists. `resets_at` is absolute, so this
 * stays true however old the snapshot is — a 5h window read 17h ago rolled
 * long ago, and its percent is history, not a reading. A window with no known
 * reset time can never be proven rolled. */
export function isWindowRolled(w: { resets_at?: number } | undefined | null, now: number): boolean {
  return !!w && w.resets_at != null && w.resets_at <= now;
}

/** A window's utilization AS OF `now`: 0 once it has rolled, since a fresh
 * window starts empty. The one place display and decision logic agree on what
 * a stale snapshot still means. */
export function livePercent(w: { percent: number; resets_at?: number }, now: number): number {
  return isWindowRolled(w, now) ? 0 : w.percent;
}

function limitWindows(usage: CcUsage): { percent: number; resets_at?: number }[] {
  return [usage.session, usage.weekly, usage.weekly_scoped, ...(usage.scoped ?? [])].filter(
    (w): w is NonNullable<typeof w> => !!w,
  );
}

/** The worst (highest) utilization across an account's limit windows AS OF
 * `now` — what a single summary meter should show. Rolled windows count as 0,
 * so a dormant account stops reading "100%" forever. Null when no usage data
 * exists. */
export function worstUsagePercent(usage: CcUsage | undefined | null, now: number): number | null {
  if (!usage) return null;
  const windows = limitWindows(usage);
  return windows.length ? Math.max(...windows.map((w) => livePercent(w, now))) : null;
}

/** An account with no headroom RIGHT NOW: some window is pegged and its reset
 * is still in the future. A pegged window whose reset has passed doesn't count
 * — the snapshot is just stale, the window has rolled. */
export function isUsageExhausted(usage: CcUsage | undefined | null, now: number): boolean {
  if (!usage) return false;
  return limitWindows(usage).some((w) => livePercent(w, now) >= 100);
}

// ---------------------------------------------------------------------------
// Auto-switch decision — pure; accountSwitch.autoSwitchCheck supplies inputs
// and executes the outcome
// ---------------------------------------------------------------------------

// An account that parked sessions is spent for its rolling 5h window; after
// that it becomes a candidate again even without fresh usage data.
export const AUTO_SWITCH_SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;
// A usage snapshot can overrule an attempt's blackout only if it was fetched
// this long after the attempt: by then the switch has settled (kill + resume
// + continue takes a couple of minutes) and a limit the fleet hit right away
// would already show in the probe. In practice the override waits for the
// ~5-min usage refresh cadence on top of this.
export const AUTO_SWITCH_ATTEMPT_EVIDENCE_MS = 5 * 60 * 1000;
// The attempt-history key for a same-account "continue" (no profile involved).
export const AUTO_SWITCH_CONTINUE_KEY = "__continue__";

/** Does the "every account is spent" stamp still describe NOW? Only a re-check
 * clears it, and that re-check may never run — auto-switch turned off, a lost
 * scheduler wake-up, a machine that went away. So past the rolling session
 * window the stamp stands only while some account still shows a pegged window
 * that hasn't rolled. Inside the window it stands on its own: a single-account
 * machine can be spent with no usage snapshot to prove it. */
export function isExhaustionCurrent(
  exhaustedAt: number | undefined | null,
  profiles: { usage?: CcUsage | null }[],
  now: number,
): boolean {
  if (!exhaustedAt) return false;
  if (now - exhaustedAt < AUTO_SWITCH_SESSION_WINDOW_MS) return true;
  return profiles.some((p) => isUsageExhausted(p.usage, now));
}

export interface AutoSwitchProfile {
  name: string;
  email?: string;
  usage?: CcUsage;
}

export type AutoSwitchDecision =
  | { action: "continue" } // active account's window rolled — plain continue un-parks for free
  | { action: "switch"; profile: string }
  | { action: "exhausted"; retry_at: number }; // every account spent — when to look again

/**
 * Pick the cheapest recovery for limit-parked sessions:
 *  1. no switch — the active account's 5h session window reset AFTER the newest
 *     park (resets_at is an absolute timestamp, so even a stale snapshot stays
 *     truthful) and we haven't already tried a continue for this park;
 *  2. switch — the saved profile with the most usage headroom, skipping the
 *     active account, accounts with a pegged un-reset window, and accounts
 *     already tried this window (an attempt OLDER than the newest park means
 *     sessions parked again after we switched to it — it's spent until its
 *     window rolls). A usage snapshot fetched after the attempt settled and
 *     showing headroom overrules that blackout: attempts are inferred from
 *     park timestamps, and parks stamped by sessions still mid-recovery from
 *     the switch are indistinguishable from a real limit on the new account,
 *     so the account's own probe is the stronger signal. Unknown usage ranks
 *     after known headroom: eligible, just unproven.
 *  3. exhausted — retry at the earliest known window reset (hourly fallback).
 */
export function decideAutoSwitch(input: {
  now: number;
  parkedAt: number; // newest limit-park among the blocked conversations
  activeEmail?: string;
  profiles: AutoSwitchProfile[];
  attempts: Array<{ profile: string; at: number }>;
}): AutoSwitchDecision {
  const { now, parkedAt, activeEmail, profiles, attempts } = input;
  const lastAttemptAt = (profile: string): number | null =>
    attempts.reduce<number | null>(
      (max, a) => (a.profile === profile && a.at > (max ?? 0) ? a.at : max),
      null,
    );

  const active = profiles.find((p) => p.email && p.email === activeEmail);
  const sessionResetAt = active?.usage?.session?.resets_at;
  const lastContinue = lastAttemptAt(AUTO_SWITCH_CONTINUE_KEY);
  if (
    sessionResetAt &&
    sessionResetAt > parkedAt &&
    sessionResetAt <= now &&
    !isUsageExhausted(active?.usage, now) &&
    (!lastContinue || lastContinue < parkedAt)
  ) {
    return { action: "continue" };
  }

  const candidates = profiles.filter((p) => {
    if (!p.email || p.email === activeEmail) return false;
    if (isUsageExhausted(p.usage, now)) return false;
    const att = lastAttemptAt(p.name);
    if (att && att >= parkedAt) return false; // switch in flight — wait
    if (att && now - att < AUTO_SWITCH_SESSION_WINDOW_MS) {
      // Spent this window — unless a usage snapshot fetched after the attempt
      // settled proves otherwise (isUsageExhausted already cleared it above).
      // Each failed retry records a fresh attempt, pushing the required
      // evidence forward, so this can't flap faster than the probe cadence.
      const evidenceAt = p.usage?.fetched_at ?? 0;
      if (evidenceAt < att + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS) return false;
    }
    return true;
  });
  const score = (p: AutoSwitchProfile): number =>
    p.usage ? worstUsagePercent(p.usage, now) ?? 0 : 101;
  candidates.sort((a, b) => score(a) - score(b));
  if (candidates[0]) return { action: "switch", profile: candidates[0].name };

  const resets: number[] = [];
  for (const p of profiles) {
    for (const w of [p.usage?.session, p.usage?.weekly, p.usage?.weekly_scoped]) {
      if (w?.resets_at && w.resets_at > now) resets.push(w.resets_at);
    }
  }
  const retryAt = (resets.length ? Math.min(...resets) : now + 60 * 60 * 1000) + 2 * 60 * 1000;
  return { action: "exhausted", retry_at: retryAt };
}

// Profile names live in keychain service names and shell commands — keep them
// boring. Mirrors the CLI-side validation in cli/src/ccAccounts.ts.
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/i;

export function isValidProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name);
}

// A device is live if it heartbeated within this window (daemon beats ~30s).
export const DEVICE_ONLINE_MS = 2 * 60 * 1000;

export function isDeviceOnline(device: { last_seen: number }, now: number): boolean {
  return now - device.last_seen < DEVICE_ONLINE_MS;
}

// Selection predicate for the revive actions: a conversation parked on a
// LIMIT, AUTH, or CONNECTION banner — the states where the session won't heal
// itself and a switch/continue is the cure. kind "connection" (the provider
// never replied: "Connection closed mid-response", "Connection error.") means
// the turn died at the prompt — a plain continue resumes it, same as limit.
// kind "error" (statusful 529/500 provider failures) is deliberately OUT:
// the CLI retries those itself and they must not paint a mid-retry session
// as blocked (a mid-conversation 500 otherwise throws the active session
// into the fleet banner). Dismissed is an explicit user "go away" — never
// auto-revive.
export function isBlockedConversation(conv: {
  pending_api_error?: boolean;
  pending_api_error_kind?: string | null;
  agent_type?: string;
  inbox_dismissed_at?: number | null;
}): boolean {
  return (
    conv.pending_api_error === true &&
    (conv.pending_api_error_kind === "limit" ||
      conv.pending_api_error_kind === "auth" ||
      conv.pending_api_error_kind === "connection") &&
    conv.agent_type === "claude_code" &&
    !conv.inbox_dismissed_at
  );
}

/** Target of the post-credential-push recovery nudge: an auth-parked
 * conversation owned by a remote device (remotes run a pushed COPY of the
 * primary's credential — a fresh push is what makes their recovery possible,
 * so limit-kind and local owners are out of scope). Callers pre-filter with
 * isBlockedConversation, which carries the dismissed/agent-type gates. */
export function isRemoteAuthBlocked(
  conv: { pending_api_error_kind?: string | null; owner_device_id?: string | null },
  remoteDeviceIds: ReadonlySet<string>,
): boolean {
  return (
    conv.pending_api_error_kind === "auth" &&
    !!conv.owner_device_id &&
    remoteDeviceIds.has(conv.owner_device_id)
  );
}

// A subagent for REVIVE purposes: spawned by/for another session. These are
// excluded from the default revive — a worker whose parent moved on is work
// nobody is waiting for, and resuming it burns the fresh account's window.
// Deliberately narrower than the inbox's isSub (which also nests by
// worktree_name): a worktree session can be a first-class task of its own.
// Shared verbatim by the server selection and the web banner so the counts
// shown always match what the actions touch.
export function isSubagentConversation(conv: {
  is_subagent?: boolean;
  parent_conversation_id?: string | null;
}): boolean {
  return conv.is_subagent === true || !!conv.parent_conversation_id;
}

// The parent-link fields every inbox session row MUST carry so the client can
// tell a subagent from a top-level session and nest it under its parent. The
// client reads exactly these via isSubagentConversation; without them a row
// looks top-level. Both inbox emission paths spread this — the top-level scan
// (enrichInboxSessionRow) and the parent's child enumeration — so a subagent
// self-identifies no matter which path emitted it (the client dedups duplicate
// _id rows last-wins, and the child enumeration is capped, so the top-level row
// is sometimes the ONLY emission of a given subagent). Omitting it on the
// top-level path was the "subagent renders as a flat card" bug (ct-37439).
// Convex Ids stringify via toString(); a string passes through unchanged.
export function subagentLinkFields(conv: {
  is_subagent?: boolean;
  parent_conversation_id?: { toString(): string } | string | null;
}): { is_subagent: boolean; parent_conversation_id: string | null } {
  return {
    is_subagent: conv.is_subagent === true,
    parent_conversation_id: conv.parent_conversation_id?.toString() || null,
  };
}

// Which parent a session NESTS under in session lists — the single definition
// every nesting computation must share (inbox categorizer, hidden buckets,
// card styling, wake signature). Two sources, in priority order:
// - parent_conversation_id: a Task-tool subagent. Full subagent semantics —
//   hidden when its parent is absent, excluded from revive.
// - spawned_by_conversation_id + agent_team_name: an agent-team teammate. It
//   nests under its lead for DISPLAY only and keeps first-class semantics
//   everywhere else — when the lead is absent from a list it renders as a
//   normal top-level card, never hidden (it's a real session someone may need
//   to answer). The agent_team_name gate is what keeps this to teammates:
//   forks (forked_from) and cast-spawn sessions never nest.
export function nestParentIdOf(conv: {
  parent_conversation_id?: { toString(): string } | string | null;
  spawned_by_conversation_id?: { toString(): string } | string | null;
  agent_team_name?: string | null;
}): string | null {
  if (conv.parent_conversation_id) return conv.parent_conversation_id.toString();
  if (conv.agent_team_name && conv.spawned_by_conversation_id) {
    return conv.spawned_by_conversation_id.toString();
  }
  return null;
}

// Whether a conversation was spawned by an agent rather than started by a
// human. Gates the teammate "started coding" notification: agent fan-out
// (Task-tool subagents, workflow subs, agent-team teammates) must never ping
// the team. Broader than isSubagentConversation on purpose — spawned_by and
// agent identity mark sessions that stay first-class in the inbox but are
// still machine-initiated. The one session with agent identity a human DID
// start is the team lead (stamped agent_name "team-lead" by linkSpawnedBy).
// Forks and plan handoffs (parent link WITH parent_message_uuid) stay
// notifiable — those are human actions.
export function isAgentSpawnedConversation(conv: {
  is_subagent?: boolean;
  is_workflow_sub?: boolean;
  parent_conversation_id?: { toString(): string } | string | null;
  parent_message_uuid?: string | null;
  spawned_by_conversation_id?: { toString(): string } | string | null;
  agent_name?: string | null;
}): boolean {
  if (conv.is_subagent === true || conv.is_workflow_sub === true) return true;
  if (conv.spawned_by_conversation_id) return true;
  if (conv.agent_name && conv.agent_name !== "team-lead") return true;
  if (conv.parent_conversation_id && !conv.parent_message_uuid) return true;
  return false;
}

// Stale-flag sweep: past the revive window the flag stops meaning "current
// incident" and just pollutes badges/selection — clear it. New activity on a
// conversation bumps updated_at and supersedes the banner anyway, so for a
// parked conversation updated_at ≈ when it hit the limit.
export const STALE_FLAG_AFTER_MS = 48 * 60 * 60 * 1000;

export function shouldSweepStaleFlag(
  conv: { pending_api_error?: boolean; updated_at?: number },
  now: number,
): boolean {
  return conv.pending_api_error === true && (conv.updated_at ?? 0) < now - STALE_FLAG_AFTER_MS;
}
