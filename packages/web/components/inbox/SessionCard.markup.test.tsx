// The session card's markup, frozen across the container/view split
// (heroFly/ARCHITECTURE.md section 3 item 1). The snapshot was written against
// the card before SessionCardView existed; every case here must keep rendering
// the same bytes, so a later edit that changes the card on purpose updates the
// snapshot and says so in review.
//
// Times are offsets from now, rounded well inside a unit, so the relative
// labels ("5m", "2h") are stable from run to run.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { mockInboxStore } from "../__tests__/mockInboxStore";
import type { InboxSession } from "../../store/inboxStore";

const NOW = Date.now();
const MIN = 60_000;

const readState = mockInboxStore(() => ({
  machineRoster: [
    { device_id: "cloud-linux", is_remote: true, platform: "linux", online: false, last_seen: 1, label: "Cloud Linux" },
  ],
  machineRosterLive: true,
  currentUser: { _id: "me" },
  teamMembers: [
    { _id: "me", name: "Ashot Petrosian", email: "a@x.org" },
    { _id: "u-ann", name: "Ann Lee", email: "ann@x.org", avatar_url: null, presence_state: "active", viewing_conversation_id: "c-viewed" },
  ],
  clientState: { ui: { show_model_badge: true, show_agent_icon: true, show_branch_pill: true, personify_sessions: false } },
  drafts: { "c-draft": { draft_message: "try the retry budget again" } },
  pendingMessages: { "c-pending": [{ _id: "pm1", status: "pending", content: "go" }] },
  restartingSessions: {},
  blockedReviveRequestedAt: {},
  conversations: {},
  sessions: {
    "c-lead": { _id: "c-lead", title: "Webhook retry rewrite" },
  },
}), {
  useTrackedStore: () => readState(),
});

const { SessionCard } = await import("./SessionCard");

const convex = new ConvexReactClient("https://example.convex.cloud");

const base: InboxSession = {
  _id: "c1",
  session_id: "s1",
  agent_type: "claude_code",
  title: "Fix the auth race",
  message_count: 12,
  updated_at: NOW - 5.5 * MIN,
  started_at: NOW - 90 * MIN,
  is_idle: true,
  has_pending: false,
  project_path: "/Users/me/src/codecast",
  git_root: "/Users/me/src/codecast",
  user_id: "me",
  model: "claude-opus-4-1",
  last_user_message: "make the retry idempotent",
} as InboxSession;

type Props = Record<string, unknown>;
const noop = () => {};

function render(overrides: Partial<InboxSession>, props: Props = {}) {
  return renderToStaticMarkup(
    <ConvexProvider client={convex}>
      <SessionCard
        session={{ ...base, ...overrides } as InboxSession}
        isActive={false}
        globalIndex={0}
        onSelect={noop}
        onDismiss={noop}
        onStash={noop}
        onPin={noop}
        sessionLabel={null}
        isFavorite={false}
        {...props}
      />
    </ConvexProvider>,
  );
}

const CASES: Array<[string, Partial<InboxSession>, Props?]> = [
  ["working", { _id: "c-working", is_idle: false, updated_at: NOW - 0.5 * MIN }, { variant: "working" }],
  ["needs input", {
    _id: "c-blocked",
    thread_state: "Migrating the sync layer\nBlocked: needs a prod key",
    thread_state_status: "blocked",
    thread_state_at: NOW - 3.5 * MIN,
    thread_state_msg_count: 12,
  } as Partial<InboxSession>],
  ["done", {
    _id: "c-done",
    thread_state: "Shipped the retry fix, all four checks green",
    thread_state_status: "done",
    thread_state_at: NOW - 20.5 * MIN,
    thread_state_msg_count: 12,
  } as Partial<InboxSession>],
  ["idle, unread, favorite, labelled", { _id: "c-unread", agent_type: "codex" }, { isUnread: true, isFavorite: true, sessionLabel: "Payments" }],
  ["active", { _id: "c-active" }, { isActive: true }],
  ["pinned", { _id: "c-pinned", is_pinned: true }],
  ["subagent", { _id: "c-sub", is_subagent: true, parent_conversation_id: "c-lead", agent_type: "cursor" } as Partial<InboxSession>],
  ["subagent, active, working", { _id: "c-sub2", is_subagent: true, parent_conversation_id: "c-lead", is_idle: false, updated_at: NOW - 0.5 * MIN } as Partial<InboxSession>, { isActive: true, variant: "working" }],
  ["trigger sub row", { _id: "c-trig" }, { subRow: "trigger" }],
  ["stashed", { _id: "c-stashed" }, { variant: "stashed", onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined }],
  ["dismissed", { _id: "c-dismissed" }, { variant: "dismissed", onRestore: noop, onKill: noop, onDismiss: undefined, onStash: undefined, onPin: undefined }],
  ["snoozed", { _id: "c-snoozed", inbox_snoozed_until: Date.UTC(2031, 0, 2, 15, 0) } as Partial<InboxSession>, { variant: "snoozed", onRestore: noop }],
  ["cloud worktree", { _id: "c-cloud", worktree_name: "cloud-d03aaa", worktree_branch: "codecast/cloud-d03aaa", owner_device_id: "cloud-linux", agent_type: "gemini" } as Partial<InboxSession>],
  ["draft", { _id: "c-draft", _hasDraft: true, message_count: 0, last_user_message: undefined }],
  ["pending send", { _id: "c-pending", has_pending: true }],
  ["assigned ping", { _id: "c-ping", assigned_ping: { by_name: "Ann Lee", note: "Can you take the webhook half?", at: NOW - 7.5 * MIN } }],
  ["spawned by, fork, plan, task, comments", {
    _id: "c-spawned",
    spawned_by_conversation_id: "c-lead",
    forked_from: "c-lead",
    active_plan: { _id: "p1", title: "Webhook retry", short_id: "pl-88" },
    active_task: { _id: "t1", title: "Dashboard retry UI", short_id: "ct-4102" },
    open_comment_threads: 2,
    last_comment_author_id: "u-ann",
    last_comment_author: "Ann Lee",
    last_comment_excerpt: "Is this idempotent?",
    agent_type: "pi",
  } as Partial<InboxSession>, { forkColorKey: "c-lead" }],
  ["teammate's session, viewed", { _id: "c-viewed", user_id: "u-ann", author_name: "Ann Lee" } as Partial<InboxSession>],
  ["session error", { _id: "c-err", session_error: "Agent crashed" }],
  ["user rest", { _id: "c-rest", user_rest: "done" } as Partial<InboxSession>],
];

describe("SessionCard markup is stable across the view split", () => {
  for (const [name, overrides, props] of CASES) {
    test(name, () => {
      expect(render(overrides, props)).toMatchSnapshot();
    });
  }
});
