import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getFunctionName } from "convex/server";
import { makeFakeDb } from "./testDb";
import { pushContext, pushEdit, pushMessage } from "./slackSync";
import { postMessage, resolvePostContext, slackMayCarryContentFor } from "./slack";
import { linkOnlyText, slackMayCarryContent } from "./lib/slackSend";

// Regulated health data (plan pl-990, ct-87104): a regulated team's Slack posts
// carry a neutral line and a link until an admin records a BAA for its Slack plan.
const ALICE = "user-alice" as any;
const TEAM = "team-main" as any;
const CHANNEL = "chat_channels_1" as any;
const INSTALL = "slack_installations_1" as any;
const LINK = "slack_channel_links_1" as any;
const SECRET = "patient Jane Doe, MRN 4471, lab results attached";

function context(policy: Record<string, unknown> | undefined) {
  const db = makeFakeDb({
    users: [{ _id: ALICE, name: "Alice", email: "alice@example.test", image: "https://img.test/a.png" }],
    teams: [{ _id: TEAM, name: "Clinic", invite_code: "C", created_at: 1, policy }],
    team_memberships: [{ _id: "m-alice", user_id: ALICE, team_id: TEAM, role: "admin" }],
    chat_channels: [{ _id: CHANNEL, team_id: TEAM, name: "general", created_by: ALICE, created_at: 1, updated_at: 1 }],
    chat_messages: [],
    slack_installations: [{
      _id: INSTALL, workspace_id: "T0CLINIC", workspace_name: "Clinic", bot_user_id: "UBOT", bot_token: "xoxb-test", app_id: "A0",
      team_id: TEAM, installed_by_user_id: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_channel_links: [{
      _id: LINK, team_id: TEAM, installation_id: INSTALL, workspace_id: "T0CLINIC", slack_channel_id: "C0GEN", slack_channel_name: "general",
      chat_channel_id: CHANNEL, direction: "both",
      options: { threads: true, reactions: true, edits: true, files: true, bot_messages: false, system_messages: false, agent_lines: true, match_people_by_email: true },
      created_by: ALICE, created_at: 1, updated_at: 1,
    }],
    slack_users: [],
    slack_user_tokens: [],
    anchors: [{ _id: "anchors_1", team_id: TEAM, bot_user_id: "user-bot", host_user_id: ALICE, status: "active" }],
    anchor_channels: [{ _id: "anchor_channels_1", anchor_id: "anchors_1", surface: "slack", channel_key: "C0ANCHOR", workspace_key: "T0CLINIC" }],
  });
  const ctx: any = {
    db,
    auth: { async getUserIdentity() { return { subject: `${ALICE}|session` }; } },
    async runQuery(ref: unknown, args: any) {
      const name = getFunctionName(ref as any);
      if (name.endsWith("slackMayCarryContentFor")) return call(slackMayCarryContentFor, ctx, args);
      if (name.endsWith("resolvePostContext")) return call(resolvePostContext, ctx, args);
      return call(pushContext, ctx, args);
    },
    async runMutation() { return undefined; },
    scheduler: { async runAfter() {} },
  };
  return ctx;
}
const call = (fn: any, ctx: any, args: any) => (fn as any)._handler(ctx, args);

async function sentTo(run: () => Promise<unknown>) {
  const sent: Array<{ method: string; body: any }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const method = String(url).split("/").pop()!;
    const body = init.headers["Content-Type"].startsWith("application/json") ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, ts: "9000.000001", permalink: "https://slack.test/p" }));
  }) as any;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent.filter((s) => s.method === "chat.postMessage" || s.method === "chat.update");
}

async function mirrorLine(policy: Record<string, unknown> | undefined) {
  const ctx = context(policy);
  const message = await ctx.db.insert("chat_messages", {
    channel_id: CHANNEL, user_id: ALICE, content: SECRET, created_at: 5_000, updated_at: 5_000,
    origin: "agent", origin_session_title: "Review Jane Doe's chart",
  } as any);
  const sent = await sentTo(() => call(pushMessage, ctx, { message_id: message }));
  return { ctx, message, sent };
}

describe("Slack posts for a regulated team", () => {
  test("without the BAA acknowledgement a mirrored line goes out as a link only", async () => {
    const { message, sent } = await mirrorLine({ regulated_data: true });
    expect(sent).toHaveLength(1);
    const body = sent[0].body;
    expect(body.text).toBe(linkOnlyText(`https://codecast.sh/chat/${CHANNEL}?m=${message}`));
    expect(JSON.stringify(body)).not.toContain("Jane");
    expect(body.username).toBeUndefined();
    expect(body.blocks).toBeUndefined();
    expect(body.unfurl_links).toBe(false);
    expect(body.channel).toBe("C0GEN");
  });
  test("with the acknowledgement the full line goes out", async () => {
    const { sent } = await mirrorLine({ regulated_data: true, slack_baa_confirmed: true });
    expect(sent[0].body.text).toContain("MRN 4471");
    expect(sent[0].body.username).toContain("Review Jane Doe's chart");
  });
  test("a team that is not regulated is unchanged", async () => {
    const plain = await mirrorLine(undefined);
    const acked = await mirrorLine({ slack_baa_confirmed: true });
    expect(plain.sent[0].body.text).toContain("MRN 4471");
    expect(acked.sent[0].body).toEqual(plain.sent[0].body);
  });
  test("an edit of a mirrored line is replaced the same way", async () => {
    const ctx = context({ regulated_data: true });
    const message = await ctx.db.insert("chat_messages", {
      channel_id: CHANNEL, user_id: ALICE, content: SECRET, created_at: 5_000, updated_at: 5_000,
      external: { provider: "slack", direction: "outbound", workspace: "T0CLINIC", channel: "C0GEN", ts: "5000.000001", synced_at: 5_000 },
    } as any);
    const sent = await sentTo(() => call(pushEdit, ctx, { message_id: message }));
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("chat.update");
    expect(sent[0].body).toEqual({ channel: "C0GEN", ts: "5000.000001", text: linkOnlyText(`https://codecast.sh/chat/${CHANNEL}?m=${message}`), blocks: [] });
  });
  test("an @anchor reply in Slack carries only the link", async () => {
    const ctx = context({ regulated_data: true });
    // The caller is the anchor's host; channelRow resolves the linked channel.
    const sent = await sentTo(() => call(postMessage, ctx, { channel: "C0ANCHOR", thread_ts: "1.2", text: SECRET }));
    expect(sent.map((s) => s.body)).toEqual([{ channel: "C0ANCHOR", thread_ts: "1.2", text: linkOnlyText("https://codecast.sh/anchor"), unfurl_links: false, unfurl_media: false }]);
  });
  test("the rule reads only the two policy flags", () => {
    expect(slackMayCarryContent(null)).toBe(true);
    expect(slackMayCarryContent({ regulated_data: false })).toBe(true);
    expect(slackMayCarryContent({ regulated_data: true })).toBe(false);
    expect(slackMayCarryContent({ regulated_data: true, slack_baa_confirmed: false })).toBe(false);
    expect(slackMayCarryContent({ regulated_data: true, slack_baa_confirmed: true })).toBe(true);
  });
});

// The rule holds only while every content write goes through lib/slackSend.
describe("Slack content writes", () => {
  const ROOT = import.meta.dir;
  const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "_generated" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.ts$/.test(name) && !/\.(test|testkit)\.ts$/.test(name) ? [path] : [];
  });
  test("go through slackSend, never slackApi or a raw fetch", () => {
    const bypass: string[] = [];
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === "lib/slackSend.ts" || rel === "lib/slackApi.ts") continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/slackApi\([^)]*?["'](chat\.(?:postMessage|update|postEphemeral|scheduleMessage|unfurl))["']/g)) bypass.push(`${rel}: slackApi ${m[1]}`);
      for (const m of src.matchAll(/slack\.com\/api\/(chat\.[a-zA-Z]+)/g)) bypass.push(`${rel}: fetch ${m[1]}`);
    }
    expect(bypass).toEqual([]);
  }, 60_000);
});
