// Conversation comments read from review_comments (the `comments_from_review`
// preference, lib/commentSource) must render exactly what the comments table
// renders, and with the preference off nothing may change at all.
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Query names and args each feeder subscribes with, in call order.
const subscribed: Array<{ ref: string; args: unknown }> = [];
const noThrow = await import("../../hooks/useQueryNoThrow");
mock.module("../../hooks/useQueryNoThrow", () => ({
  ...noThrow,
  useQueryNoThrow: (ref: unknown, args: unknown) => {
    subscribed.push({ ref: named(ref), args });
    return { data: undefined, error: undefined, retry: () => {} };
  },
}));
const identity = await import("../../hooks/useLiveIdentityRow");
mock.module("../../hooks/useLiveIdentityRow", () => ({ ...identity, useConversationSpeaker: () => ({ name: "Claude", row: null }) }));
mock.module("./CommentAvatar", () => ({ CommentAvatar: ({ name }: { name?: string }) => <i data-avatar>{name}</i> }));
mock.module("./CommentMarkdown", () => ({ CommentMarkdown: ({ content }: { content: string }) => <p>{content}</p> }));

const { api } = await import("@codecast/convex/convex/_generated/api");
const { getFunctionName } = await import("convex/server");
const named = (ref: unknown) => getFunctionName(ref as any);
const { makeFakeDb } = await import("@codecast/convex/convex/testDb");
const comments = await import("@codecast/convex/convex/comments");
const { conversationComments } = await import("@codecast/convex/convex/commentTwins");
const { CommentThread } = await import("./CommentThread");
const { groupComments } = await import("../../lib/commentThread");
const { buildConversationMessageMetadata } = await import("../../hooks/useConversationMessageMetadata");
const { useConversationCommentSummary } = await import("../../hooks/useConversationCommentsSync");
const { useThreadUnreadSync } = await import("../../hooks/useThreadsSync");
const { useInboxStore } = await import("../../store/inboxStore");

const OWNER = "user_owner";
const MEMBER = "user_member";
const CONV = "conv_1";
const FORK = "conv_fork";
const MSG = "msg_1";
const TEAM = "team_1";

function serverCtx(user: string) {
  const db = makeFakeDb({
    users: [
      { _id: OWNER, name: "Owner", github_username: "owner", github_avatar_url: "https://a/o" },
      { _id: MEMBER, name: "Member" },
    ],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, visibility: "summary" },
      { _id: "m2", user_id: MEMBER, team_id: TEAM, visibility: "summary" },
    ],
    conversations: [
      { _id: CONV, user_id: OWNER, team_id: TEAM, is_private: false, team_visibility: "full", status: "active", updated_at: 1 },
      { _id: FORK, user_id: OWNER, is_private: true, status: "active", updated_at: 1 },
    ],
    messages: [{ _id: MSG, conversation_id: CONV, role: "assistant", content: "Plan: rewrite the sync layer.", timestamp: 1 }],
    pull_requests: [],
    pull_request_sessions: [],
    comments: [],
    review_comments: [],
    thread_reads: [],
    local_view_heads: [],
    local_command_receipts: [],
    pending_messages: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    managed_sessions: [],
  });
  const ctx: any = {
    db,
    auth: { async getUserIdentity() { return { subject: `${user}|session` }; } },
    async runMutation() { return { conversation_id: FORK }; },
    scheduler: { async runAfter() {} },
  };
  return ctx;
}

const as = (ctx: any, user: string) => ({ ...ctx, auth: { async getUserIdentity() { return { subject: `${user}|session` }; } } });
let n = 0;
async function add(ctx: any, over: Record<string, unknown> = {}) {
  n++;
  const result = await (comments.addCommentV2 as any)._handler(ctx, {
    command_id: `cmd-${n}`, conversation_id: CONV, content: `comment ${n}`, client_id: `client-${n}`, ...over,
  });
  return result.result.commentId as string;
}

/** A conversation with every kind of row a thread draws: message threads with
 *  a reply and a resolve, a code-line thread with an agent answer, a global
 *  thread, and a reply whose parent was deleted. */
async function seed() {
  const ctx = serverCtx(OWNER);
  const root = await add(ctx, { message_id: MSG, content: "Why rewrite it?" });
  await add(as(ctx, MEMBER), { message_id: MSG, parent_comment_id: root, content: "It **drops** writes." });
  await (comments.resolveThread as any)._handler(ctx, { conversation_id: CONV, message_id: MSG, resolved: true });
  await add(ctx, { file_path: "src/sync.ts", line_number: 42, anchor_lines: { before: ["a"], lines: ["b"], after: ["c"] }, content: "This loop never ends" });
  await (comments.askAgentInThreadV2 as any)._handler(ctx, { command_id: "ask", conversation_id: CONV, file_path: "src/sync.ts", line_number: 42, client_id: "ask" });
  const agent = ctx.db._tables.comments.find((c: any) => c.author_kind === "agent");
  ctx.db._tables.messages.push({ _id: "msg_reply", conversation_id: FORK, role: "assistant", content: "Fixed: it breaks on EOF.", timestamp: Date.now() + 5 });
  await (comments.mirrorAgentReply as any)._handler(ctx, { fork_conversation_id: agent.fork_conversation_id });
  const doomed = await add(as(ctx, MEMBER), { content: "global note" });
  await add(ctx, { parent_comment_id: doomed, content: "reply to a deleted note" });
  await add(ctx, { content: "still here" });
  await (comments.deleteCommentV2 as any)._handler(as(ctx, MEMBER), { command_id: "del", conversation_id: CONV, comment_id: doomed });
  return ctx;
}

let root: Root;
beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  subscribed.length = 0;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

async function renderThreads(rows: any[], viewer: string): Promise<string> {
  const { global, anchored, files } = groupComments(rows);
  await act(async () => root.render(
    <div>
      {[global, ...anchored, ...files].map((thread) => (
        <CommentThread
          key={thread.key}
          thread={thread}
          conversationId={CONV}
          variant={thread.key === "global" ? "global" : "anchored"}
          authed
          canWrite={false}
          currentUserId={viewer}
          onAdd={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onAskAgent={() => {}}
        />
      ))}
    </div>,
  ));
  return document.getElementById("root")!.innerHTML;
}

describe("flag on: the same rows render identically from review_comments", () => {
  test("every thread, card, reply label, agent answer and resolved state, for the author and a teammate", async () => {
    const ctx = await seed();
    for (const viewer of [OWNER, MEMBER]) {
      const fromComments = await (comments.getConversationCommentSummary as any)._handler(as(ctx, viewer), { conversation_id: CONV });
      const fromTwins = await (conversationComments as any)._handler(as(ctx, viewer), { conversation_id: CONV });
      expect(fromTwins.length).toBe(fromComments.length);
      expect(fromComments.length).toBe(6);

      const htmlComments = await renderThreads(fromComments, viewer);
      const htmlTwins = await renderThreads(fromTwins, viewer);
      expect(htmlComments).toContain("It **drops** writes.");
      expect(htmlComments).toContain("Fixed: it breaks on EOF.");
      expect(htmlComments).toContain("reply to a deleted note");
      expect(htmlTwins).toBe(htmlComments);

      // The per-message counts the conversation and the phone draw.
      expect(buildConversationMessageMetadata({ commentSummary: fromTwins }))
        .toEqual(buildConversationMessageMetadata({ commentSummary: fromComments }));
    }
  });
});

function Probe({ id }: { id: string }) {
  useConversationCommentSummary(id);
  useThreadUnreadSync();
  return null;
}

async function withUi(ui: Record<string, unknown>) {
  const cs = useInboxStore.getState().clientState as any;
  useInboxStore.setState({ clientState: { ...cs, ui: { ...(cs?.ui ?? {}), active_team_id: undefined, comments_from_review: undefined, ...ui } } } as any);
  await act(async () => root.render(<Probe id="jd7abcdefghijklmnopqrstuvwx12345" />));
  return [...subscribed];
}

describe("the flag", () => {
  test("false subscribes to getConversationCommentSummary and the badge with its old args", async () => {
    const calls = await withUi({ comments_from_review: false });
    expect(calls.some((c) => c.ref === named(api.comments.getConversationCommentSummary))).toBe(true);
    expect(calls.some((c) => c.ref === named(api.commentTwins.conversationComments))).toBe(false);
    const badge = calls.filter((c) => c.ref === named(api.threads.unreadCount));
    expect(badge.length).toBeGreaterThan(0);
    for (const call of badge) expect(call.args).toEqual({});
  });

  test("unset or true, the feeder reads the twins and the Threads reads ask for them", async () => {
    for (const ui of [{}, { comments_from_review: true }]) {
      subscribed.length = 0;
      const calls = await withUi(ui);
      expect(calls.some((c) => c.ref === named(api.commentTwins.conversationComments))).toBe(true);
      expect(calls.some((c) => c.ref === named(api.comments.getConversationCommentSummary))).toBe(false);
      for (const call of calls.filter((c) => c.ref === named(api.threads.unreadCount))) {
        expect(call.args).toEqual({ comments_from_review: true });
      }
    }
  });
});
