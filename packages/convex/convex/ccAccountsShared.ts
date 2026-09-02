// Pure shared pieces for CC account switching — safe to import from schema.ts,
// the mutations (accountSwitch.ts), and tests. No server/_generated imports.

import { v } from "convex/values";
import {
  BLOCKED_BANNER_KINDS,
  fallbackProfiles,
  isUsageExhausted,
  isWindowRolled,
  livePercent,
  worstUsagePercent,
  type CcUsage,
} from "@codecast/shared/contracts";

// The usage snapshot type and its predicates live in @codecast/shared/contracts
// (the CLI reads them too); re-exported here so existing web/convex imports keep
// one path.
export { isWindowRolled, livePercent, worstUsagePercent, isUsageExhausted };
export type { CcUsage };

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
      // A `claude setup-token` on file for this profile (per-session launch
      // credential, see cli/ccAccounts.ts). Metadata only — never the token.
      token: v.optional(v.object({ stored_at: v.number(), expires_at: v.number() })),
    }),
  ),
});

// The setup-token mint round trip (web toggle / "mint now" → daemon runs
// `claude setup-token`, drives the browser approval, proves the token belongs
// to the machine's login, stores it → outcome). Same state-channel contract as
// cc_login_flow: the web watches this field reactively.
export const ccMintFlowValidator = v.object({
  status: v.union(v.literal("pending"), v.literal("confirmed"), v.literal("rejected")),
  profile: v.optional(v.string()), // the profile the token is for
  email: v.optional(v.string()),
  reason: v.optional(v.string()), // rejected: why
  started_at: v.number(),
  finished_at: v.optional(v.number()),
});
// A pending mint older than this means the daemon died mid-flow (its own
// watcher gives up at 5 min) — treat as no-flow, same as LOGIN_FLOW_STALE_MS.
export const MINT_FLOW_STALE_MS = 6 * 60 * 1000;

/** A profile's token is live when it exists and its one-year lifetime is not up. */
export function profileHasToken(
  profile: { token?: { expires_at: number } } | undefined | null,
  now: number,
): boolean {
  return !!profile?.token && profile.token.expires_at > now;
}

/** The device-local profile name a session should be PINNED to (its
 * `cc_account`): the account resolved on that device, only when that profile
 * has a live setup-token there. Undefined = don't pin; the session follows
 * the machine's keychain login. */
export function tokenBackedProfile(
  accounts: { profiles: Array<{ name: string; email?: string; token?: { expires_at: number } }> } | undefined | null,
  target: { profile?: string; email?: string },
  now: number,
): string | undefined {
  const name = resolveDeviceProfile(accounts, target);
  if (!name) return undefined;
  return profileHasToken(accounts?.profiles.find((p) => p.name === name), now) ? name : undefined;
}

/** The pin for a NEW session on a device with per-session tokens on: the
 * profile covering the machine's current login, if it has a live token. */
export function activeTokenProfile(
  accounts:
    | { active_email?: string; profiles: Array<{ name: string; email?: string; token?: { expires_at: number } }> }
    | undefined
    | null,
  now: number,
): string | undefined {
  return accounts?.active_email ? tokenBackedProfile(accounts, { email: accounts.active_email }, now) : undefined;
}

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
// Continue-only mode (auto-switch off) acts on limit parks no older than this:
// a full session window plus slack for the reset-plus-settle wake-up. Older
// parks sat through a reset already — abandoned, not waiting.
export const AUTO_CONTINUE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Auto-continue — resume limit-parked sessions on the SAME account once its
 * window resets, no switch — is on unless the user turned it off. Default-on
 * because a session parked by a rate limit is almost always waiting for
 * exactly that reset; the toggle exists for the user who wants parked
 * sessions to stay parked. (Auto-switch stays opt-in: it rotates the
 * machine's login, which is a bigger decision.) */
export function isAutoContinueEnabled(device: { cc_auto_continue?: boolean | null }): boolean {
  return device.cc_auto_continue !== false;
}

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

/** The words for a current exhaustion stamp. "ALL accounts are at their
 * limits" is only supportable when every account's own meter shows a pegged
 * window — the stamp also stands on attempt evidence alone (every switch or
 * continue re-parked while meters show headroom: enforcement leads the probe,
 * and a stale snapshot lags a burst). This banner renders next to those live
 * meters, so a claim any meter contradicts reads as a bug: make the strong
 * claim only when every meter backs it, otherwise say what actually
 * happened. */
export function exhaustionBannerCopy(
  profiles: { usage?: CcUsage | null }[],
  now: number,
): string {
  const allPegged =
    profiles.length > 0 && profiles.every((p) => isUsageExhausted(p.usage, now));
  return allPegged
    ? "All accounts are at their limits — auto-switch will retry at the next window reset."
    : "Auto-switch tried every account and sessions still hit limits — it will retry at the next window reset.";
}

export interface AutoSwitchProfile {
  name: string;
  email?: string;
  usage?: CcUsage;
}

// ---------------------------------------------------------------------------
// Per-device account resolution
// ---------------------------------------------------------------------------

// A profile NAME is a machine-local alias (a keychain snapshot saved under
// whatever name that machine chose); the account's EMAIL is its identity.
// Accounts are device-specific: an account exists on a device only if that
// device's reported inventory carries it. A cross-device switch therefore
// carries the identity and each executing device resolves its own alias —
// sending machine A's profile name to machine B's daemon fails there with
// "No saved profile", after the UI already claimed success.

/** The device's own name for the target account: email match first (the
 * identity), exact name as fallback (old daemons report no emails). Returns
 * undefined when the device does not have the account — the caller must treat
 * that device as unable to switch, not send the foreign name anyway. */
export function resolveDeviceProfile(
  accounts: { profiles: Array<{ name: string; email?: string }> } | undefined | null,
  target: { profile?: string; email?: string },
): string | undefined {
  const profiles = accounts?.profiles ?? [];
  if (target.email) {
    const byEmail = profiles.find((p) => p.email && p.email === target.email);
    if (byEmail) return byEmail.name;
  }
  if (target.profile) {
    const byName = profiles.find((p) => p.name === target.profile);
    if (byName) return byName.name;
  }
  return undefined;
}

/** The identity behind a caller-supplied target: an explicit email wins;
 * otherwise the email the resolving device's inventory records for the named
 * profile (the Settings page and auto-switch pass names local to the pinned /
 * primary device). Undefined when the name is unknown there too — resolution
 * then degrades to exact-name matching everywhere. */
export function targetAccountEmail(
  accounts: { profiles: Array<{ name: string; email?: string }> } | undefined | null,
  target: { profile?: string; email?: string },
): string | undefined {
  if (target.email) return target.email;
  if (!target.profile) return undefined;
  return (accounts?.profiles ?? []).find((p) => p.name === target.profile)?.email;
}

export type AutoSwitchDecision =
  | { action: "continue" } // active account's window rolled — plain continue un-parks for free
  | { action: "switch"; profile: string }
  | { action: "exhausted"; retry_at: number }; // every account spent — when to look again

/**
 * Pick the cheapest recovery for limit-parked sessions:
 *  1. no switch — the active account has headroom again and we haven't already
 *     tried a continue for this park. Two proofs, either suffices:
 *     (a) its 5h session window reset AFTER the newest park (resets_at is an
 *         absolute timestamp, so even a stale snapshot stays truthful);
 *     (b) a usage snapshot fetched after the park SETTLED (the same margin the
 *         attempt blackout uses — a probe seconds after the park can still be
 *         mid-burn) shows no pegged window. Needed because a rolled session
 *         window is re-probed as `{percent: 0}` with NO resets_at, so proof (a)
 *         only holds while the snapshot is still pre-roll; once the daemon's
 *         5-minute probe refreshes it, (b) is the only evidence left.
 *  2. switch — the saved profile with the most usage headroom, skipping the
 *     active account, accounts with a pegged un-reset window, and accounts
 *     already tried this window (an attempt OLDER than the newest park means
 *     sessions parked again after we switched to it — it's spent until its
 *     window rolls). A usage snapshot fetched after the attempt settled and
 *     showing headroom overrules that blackout: attempts are inferred from
 *     park timestamps, and parks stamped by sessions still mid-recovery from
 *     the switch are indistinguishable from a real limit on the new account,
 *     so the account's own probe is the stronger signal. Unknown usage ranks
 *     after known headroom: eligible, just unproven. Skipped entirely when
 *     `allowSwitch` is false (auto-switch off, auto-continue on): only the
 *     active account's own recovery counts.
 *  3. exhausted — retry at the earliest known window reset (hourly fallback).
 *     With switching off only the active account's windows are consulted —
 *     another account's reset can't help a session that will never move.
 */
export function decideAutoSwitch(input: {
  now: number;
  parkedAt: number; // newest limit-park among the blocked conversations
  activeEmail?: string;
  profiles: AutoSwitchProfile[];
  attempts: Array<{ profile: string; at: number }>;
  allowSwitch?: boolean; // default true
  // An auth park proves the active login is DEAD (refresh token revoked, not a
  // spent window), so "continue" can never un-park — a switch is the only cure.
  activeDead?: boolean;
}): AutoSwitchDecision {
  const { now, parkedAt, activeEmail, profiles, attempts } = input;
  const allowSwitch = input.allowSwitch !== false;
  const lastAttemptAt = (profile: string): number | null =>
    attempts.reduce<number | null>(
      (max, a) => (a.profile === profile && a.at > (max ?? 0) ? a.at : max),
      null,
    );

  const active = profiles.find((p) => p.email && p.email === activeEmail);
  const sessionResetAt = active?.usage?.session?.resets_at;
  const lastContinue = lastAttemptAt(AUTO_SWITCH_CONTINUE_KEY);
  const windowRolledSincePark = !!sessionResetAt && sessionResetAt > parkedAt && sessionResetAt <= now;
  const settledProbeShowsHeadroom =
    (active?.usage?.fetched_at ?? 0) >= parkedAt + AUTO_SWITCH_ATTEMPT_EVIDENCE_MS;
  if (
    !input.activeDead &&
    (windowRolledSincePark || settledProbeShowsHeadroom) &&
    !isUsageExhausted(active?.usage, now) &&
    (!lastContinue || lastContinue < parkedAt)
  ) {
    return { action: "continue" };
  }

  if (allowSwitch) {
    const candidates = fallbackProfiles(profiles, activeEmail, now).filter((p) => {
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
    if (candidates[0]) return { action: "switch", profile: candidates[0].name };
  }

  const resets: number[] = [];
  for (const p of allowSwitch ? profiles : active ? [active] : []) {
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
// LIMIT, AUTH, CONNECTION, or FATAL banner — the states where the session
// won't heal itself and a switch/continue is the cure. kind "connection" (the
// provider never replied: "Connection closed mid-response", "Connection
// error.") and kind "fatal" (a statusful failure the CLI won't retry, e.g. a
// 400) both mean the turn died at the prompt — a plain continue retries it,
// same as limit. kind "error" (statusful 429/5xx provider failures) is
// deliberately OUT: the CLI retries those itself and they must not paint a
// mid-retry session as blocked (a mid-conversation 500 otherwise throws the
// active session into the fleet banner). Dismissed is an explicit user "go
// away" — never auto-revive.
export function isBlockedConversation(conv: {
  pending_api_error?: boolean;
  pending_api_error_kind?: string | null;
  agent_type?: string;
  inbox_dismissed_at?: number | null;
}): boolean {
  return (
    conv.pending_api_error === true &&
    BLOCKED_BANNER_KINDS.has(conv.pending_api_error_kind ?? "") &&
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

// The rows a fleet revive acts on, top-level first. Subagent workers join
// ONLY on an explicit opt-in — never because they happen to be all that is
// blocked. A worker runs inside its parent's process, so a "continue" cannot
// reach it; the delivery rail resumes it as a standalone copy that runs its
// brief again with nobody collecting the result. Shared by the server
// selection and the web banner so the acted count is one number.
export function actedBlockedConversations<T extends {
  is_subagent?: boolean;
  parent_conversation_id?: string | null;
}>(blocked: T[], includeSubagents: boolean): T[] {
  const topLevel = blocked.filter((c) => !isSubagentConversation(c));
  return includeSubagents ? [...topLevel, ...blocked.filter(isSubagentConversation)] : topLevel;
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
