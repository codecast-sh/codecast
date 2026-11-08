// What leaves for Expo and Apple: a regulated team member's push names the
// event and the project and carries routing ids only; everyone else's push is
// sent exactly as built.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../schema";
import { internal } from "../_generated/api";
import { allModules } from "../testModules.testkit";
import { stripPushContent } from "./pushPrivacy";
import { stripLiveActivitySession } from "../liveActivity";

setDefaultTimeout(120_000);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Captures every message posted to Expo. */
function captureExpo(): any[] {
  const sent: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("exp.host")) sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ data: { status: "ok", id: `ticket-${sent.length}` } }));
  }) as any;
  return sent;
}

async function setup(regulated: boolean) {
  const t = convexTest(schema, allModules);
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Mo", email: "mo@clinic.dev", push_token: "ExponentPushToken[x]" } as any);
    const team = await ctx.db.insert("teams", {
      name: "Clinic",
      invite_code: "CLINIC12",
      created_at: 1,
      policy: regulated ? { regulated_data: true } : {},
    } as any);
    await ctx.db.insert("team_memberships", { user_id: user, team_id: team, role: "member", joined_at: 1 } as any);
    const conv = await ctx.db.insert("conversations", {
      user_id: user,
      agent_type: "claude_code",
      session_id: crypto.randomUUID(),
      started_at: 1,
      updated_at: 1,
      message_count: 3,
      status: "active",
      title: "Patient Jane Doe intake summary",
      project_path: "/Users/mo/src/intake-service/",
    } as any);
    return { user, conv };
  });
  return { t, ...ids };
}

const sessionPush = (user: any, conv: any) => ({
  push_token: "ExponentPushToken[x]",
  title: "Patient Jane Doe intake summary",
  subtitle: "#clinic",
  body: "Should I add the MRN 448812 to the record?",
  data: { type: "session_idle", conversationId: String(conv), preview: "MRN 448812", notificationKey: "e.1" },
  user_id: user,
});

describe("push payloads leaving for Expo", () => {
  test("a regulated team member's push names the event and project only", async () => {
    const sent = captureExpo();
    const { t, user, conv } = await setup(true);
    await t.action(internal.notifications.sendPushNotification, sessionPush(user, conv));
    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.title).toBe("Session waiting for input");
    expect(msg.body).toBe("In intake-service");
    expect(msg.subtitle).toBeUndefined();
    expect(msg.data).toEqual({ type: "session_idle", conversationId: String(conv), notificationKey: "e.1" });
    const wire = JSON.stringify(msg);
    for (const secret of ["Jane", "MRN", "448812", "#clinic"]) expect(wire).not.toContain(secret);
  });

  test("a push to someone in no regulated team goes out unchanged", async () => {
    const sent = captureExpo();
    const { t, user, conv } = await setup(false);
    const push = sessionPush(user, conv);
    await t.action(internal.notifications.sendPushNotification, push);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe(push.title);
    expect(sent[0].subtitle).toBe(push.subtitle);
    expect(sent[0].body).toBe(push.body);
    expect(sent[0].data).toEqual(push.data);
  });
});

describe("stripPushContent", () => {
  test("chat, calls and batches keep their routing but lose their words", () => {
    const chat = stripPushContent(
      {
        title: "Ada",
        subtitle: "thread · #ward-3",
        body: "Bed 4 labs are back: potassium 6.1",
        data: { type: "chat_reply", channelId: "c1", messageId: "m1", threadRootId: "r1", link: "/chat/c1?q=potassium" },
      },
      null,
    );
    expect(chat).toEqual({
      title: "Thread reply",
      body: "Open Codecast to see it",
      data: { type: "chat_reply", channelId: "c1", messageId: "m1", threadRootId: "r1" },
    });
    expect(stripPushContent({ title: "Ada wants to huddle", body: "Jane Doe follow-up", data: { type: "huddle_ring", room_key: "k" } }, null).title)
      .toBe("Huddle invite");
    expect(stripPushContent({ title: "3 notifications", body: "x", data: { type: "aggregate", count: 3 } }, null).title)
      .toBe("3 notifications");
    expect(stripPushContent({ title: "t", body: "b", data: { type: "something_new" } }, null).title).toBe("New notification");
  });
});

describe("Live Activity rows", () => {
  test("a stripped row shows the project and a status-only detail", () => {
    const row = {
      id: "a",
      title: "Patient Jane Doe intake summary",
      detail: "Should I add the MRN?",
      agent: "claude",
      project: "intake-service",
      status: "waiting" as const,
      startedAt: 1,
      updatedAt: 2,
    };
    expect(stripLiveActivitySession(row)).toEqual({ ...row, title: "intake-service", detail: "Waiting for your input" });
    expect(stripLiveActivitySession({ ...row, status: "working", project: null }).title).toBe("Session");
    expect(stripLiveActivitySession({ ...row, status: "working" }).detail).toBeNull();
  });
});
