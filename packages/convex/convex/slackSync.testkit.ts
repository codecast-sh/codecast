// Fixtures the slackSync test files share: a team with one Slack-mirrored
// channel, and a fake mutation context over it.
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";

export const ALICE = "user-alice" as any;
export const BOB = "user-bob" as any;
export const TEAM = "team-main" as any;
export const CHANNEL = "chat_channels_1" as any;
export const OTHER_CHANNEL = "chat_channels_2" as any;
export const INSTALL = "slack_installations_old" as any;
export const LINK = "slack_channel_links_1" as any;
export const WS = "T0UNION";
export const SLACK_CH = "C0GENERAL";

export function seed(over: Record<string, any[]> = {}) {
  return {
    users: [
      { _id: ALICE, name: "Alice", email: "alice@example.test", emailVerificationTime: 1, github_username: "alice" },
      { _id: BOB, name: "Bob", email: "bob@example.test", emailVerificationTime: 1, github_username: "bob" },
    ],
    teams: [{ _id: TEAM, name: "Union", invite_code: "U", created_at: 1, features: { chat: true } }],
    team_memberships: [
      { _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "admin" },
      { _id: "m-bob", user_id: BOB, team_id: TEAM, role: "member" },
    ],
    chat_channels: [
      { _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1_000, updated_at: 1_000 },
      { _id: OTHER_CHANNEL, team_id: TEAM, name: "random", created_by: BOB, created_at: 1_000, updated_at: 1_000 },
    ],
    chat_messages: [],
    chat_reactions: [],
    chat_reads: [],
    chat_channel_members: [],
    rate_limits: [],
    notifications: [],
    push_outbox: [],
    entity_subscriptions: [],
    user_presence: [],
    anchors: [],
    anchor_channels: [],
    pending_messages: [],
    conversations: [],
    slack_installations: [{
      _id: INSTALL, workspace_id: WS, workspace_name: "Union", bot_user_id: "UBOT", bot_token: "xoxb-test", app_id: "A0CODECAST",
      team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_channel_links: [{
      _id: LINK, team_id: TEAM, installation_id: INSTALL, workspace_id: WS, slack_channel_id: SLACK_CH, slack_channel_name: "general",
      chat_channel_id: CHANNEL, direction: "both",
      options: { threads: true, reactions: true, edits: true, files: true, bot_messages: false, system_messages: false, agent_lines: true, match_people_by_email: true },
      since_ts: "1000.000000", created_by: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_events: [],
    slack_sync_events: [],
    slack_users: [],
    slack_user_tokens: [],
    ...over,
  };
}

export function context(user: string | null, over: Record<string, any[]> = {}) {
  const db = makeFakeDb(seed(over));
  const scheduled: Array<{ delay: number; name: string; args: any }> = [];
  const emitted: Array<{ reference: unknown; args: any }> = [];
  const ctx: any = {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
    async runQuery() { throw new Error("no runQuery in this test"); },
    async runMutation(reference: unknown, args: any) {
      emitted.push({ reference, args });
      return undefined;
    },
    scheduler: { async runAfter(delay: number, reference: unknown, args: any) { scheduled.push({ delay, name: getFunctionName(reference as any), args }); } },
    _scheduled: scheduled,
    _emitted: emitted,
  };
  return ctx;
}
export const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);
export const messages = (ctx: any) => ctx.db._tables.chat_messages as any[];
export const scheduledNames = (ctx: any) => ctx._scheduled.map((s: any) => s.name);
