// Pure shared pieces for CC account switching — safe to import from schema.ts,
// the mutations (accountSwitch.ts), and tests. No server/_generated imports.

import { v } from "convex/values";

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
    }),
  ),
});

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
// LIMIT or AUTH banner — the two states where the account is the problem and
// a switch/continue is the cure. kind "error" (transient 529/500 provider
// failures) is deliberately OUT: those retry fine on the next message and must
// not paint a session as "blocked on usage limits" (a mid-conversation 500
// otherwise throws the active session into the fleet banner). Dismissed is an
// explicit user "go away" — never auto-revive.
export function isBlockedConversation(conv: {
  pending_api_error?: boolean;
  pending_api_error_kind?: string | null;
  agent_type?: string;
  inbox_dismissed_at?: number | null;
}): boolean {
  return (
    conv.pending_api_error === true &&
    (conv.pending_api_error_kind === "limit" || conv.pending_api_error_kind === "auth") &&
    conv.agent_type === "claude_code" &&
    !conv.inbox_dismissed_at
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
