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
