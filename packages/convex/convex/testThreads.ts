// The world threads.test.ts runs in: one team of three people and a bot, a
// channel, two conversations and a task, with helpers to call a handler as
// someone and read the thread_reads rows it leaves.
import { makeFakeDb } from "./testDb";
import { hashToken } from "./apiTokens";
import { listMine } from "./threads";

export const ALICE = "user-alice" as any;
export const BOB = "user-bob" as any;
export const CAROL = "user-carol" as any;
export const BOT = "user-bot" as any;
export const TEAM = "team-main" as any;
export const CHANNEL = "chat_channels_1" as any;
export const CONVERSATION = "conversation-main" as any;
export const PERSONAL_CONVERSATION = "conversation-personal" as any;
export const TASK = "tasks_1" as any;
export const TOKEN = "cast-token-alice";


export function users() {
  return [
    { _id: ALICE, name: "Alice", email: "alice@example.test", github_username: "alice" },
    { _id: BOB, name: "Bob", email: "bob@example.test", github_username: "bob" },
    { _id: CAROL, name: "Carol", email: "carol@example.test", github_username: "carol" },
    { _id: BOT, name: "Anchor", is_bot: true, bot_kind: "anchor" },
  ];
}

export function conversation(_id: string, extra: Record<string, unknown> = {}) {
  return { _id, user_id: ALICE, is_private: false, team_id: TEAM, status: "active", ...extra };
}

export async function context(authenticatedUser: string | null, seed: Record<string, any[]> = {}) {
  const db = makeFakeDb({
    users: users(),
    teams: [{ _id: TEAM, name: "Main", invite_code: "MAIN", created_at: 1, features: { chat: true } }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "member" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "admin" },
      { _id: "m-carol", user_id: CAROL, team_id: TEAM, role: "member" },
      { _id: "m-bot", user_id: BOT, team_id: TEAM, role: "member" },
    ],
    api_tokens: [
      { _id: "tok-alice", user_id: ALICE, token_hash: await hashToken(TOKEN), name: "cli", created_at: 1, last_used_at: 1 },
    ],
    chat_channels: [
      { _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1_000, updated_at: 1_000 },
    ],
    chat_messages: [],
    chat_reads: [],
    chat_channel_members: [],
    thread_reads: [],
    rate_limits: [],
    notifications: [],
    push_outbox: [],
    entity_subscriptions: [],
    user_presence: [],
    anchors: [],
    anchor_channels: [],
    pending_messages: [],
    conversations: [conversation(CONVERSATION), conversation(PERSONAL_CONVERSATION, { team_id: undefined, session_id: "sess-personal" })],
    comments: [],
    messages: [],
    pull_requests: [],
    local_view_heads: [],
    local_command_receipts: [],
    conversation_execution_heads: [],
    execution_bindings: [],
    tasks: [{
      _id: TASK,
      short_id: "ct-1",
      title: "Ship threads",
      status: "open",
      user_id: ALICE,
      assignee: BOB,
      team_id: TEAM,
      workspace: `team:${TEAM}`,
      created_at: 1,
      updated_at: 1,
    }],
    task_comments: [],
    task_history: [],
    change_log: [],
    ...seed,
  });
  const emitted: Array<{ reference: unknown; args: any }> = [];
  const scheduled: Array<{ delay: number; reference: unknown; args: any }> = [];
  return {
    db,
    auth: {
      async getUserIdentity() {
        return authenticatedUser ? { subject: `${authenticatedUser}|session` } : null;
      },
    },
    async runMutation(reference: unknown, args: any) {
      emitted.push({ reference, args });
      return undefined;
    },
    scheduler: {
      async runAfter(delay: number, reference: unknown, args: any) {
        scheduled.push({ delay, reference, args });
      },
    },
    _emitted: emitted,
    _scheduled: scheduled,
  } as any;
}

export const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);
export const as = (ctx: any, userId: string) => ({
  ...ctx,
  auth: { async getUserIdentity() { return { subject: `${userId}|session` }; } },
});
export const rows = (ctx: any) => ctx.db._tables.thread_reads as any[];
export const rowOf = (ctx: any, userId: string, kind: string) =>
  rows(ctx).find((r) => r.user_id === userId && r.kind === kind);
export const inbox = (ctx: any, args: any = { team_id: TEAM }) => call(listMine, ctx, args);
