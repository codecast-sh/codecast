// A private Slack channel is mirrored only by someone who is in it: the app
// being a member proves nothing about the teammate asking.
import { afterEach, describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { linkChannel } from "./slackSync";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Slack as two tokens see it: the bot is in the private channel; the person is or is not. */
function slack(personIsMember: boolean) {
  const calls: Array<{ method: string; token: string }> = [];
  globalThis.fetch = (async (url: unknown, init: any) => {
    const method = String(url).split("/api/")[1];
    const token = String(init.headers.Authorization).replace("Bearer ", "");
    calls.push({ method, token });
    const channel = { id: "CPRIV", name: "secret-plans", is_private: true, is_member: true };
    if (method === "conversations.info") {
      if (token === "xoxb-bot") return new Response(JSON.stringify({ ok: true, channel }));
      return new Response(JSON.stringify(personIsMember ? { ok: true, channel } : { ok: false, error: "channel_not_found" }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }) as unknown as typeof fetch;
  return calls;
}

function ctxFor(userToken: string | null) {
  const mutations: string[] = [];
  return {
    mutations,
    ctx: {
      async runQuery(ref: any) {
        const name = getFunctionName(ref);
        if (name.includes("resolveLinkAuth")) return { ok: true, user_id: "u1", team_id: "t1", bot_token: "xoxb-bot", bot_user_id: "UBOT", user_token: userToken, workspace_id: "T1", existing_link_id: null };
        return null;
      },
      async runMutation(ref: any) {
        mutations.push(getFunctionName(ref));
        return { link_id: "link_1", team_id: "t1", chat_channel_name: "plans", slack_channel_name: "secret-plans", actor_name: null };
      },
      scheduler: { async runAfter() {} },
    } as any,
  };
}

const args = { chat_channel_id: "chat_1", slack_channel_id: "CPRIV" };

describe("linking a private Slack channel the app is already in", () => {
  test("a teammate with no Slack account connected is refused, and nothing is linked", async () => {
    slack(false);
    const { ctx, mutations } = ctxFor(null);
    const out = await (linkChannel as any)._handler(ctx, args);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Connect your Slack account/);
    expect(mutations).toEqual([]);
  });

  test("a teammate who is not in the channel is refused", async () => {
    slack(false);
    const { ctx, mutations } = ctxFor("xoxp-person");
    const out = await (linkChannel as any)._handler(ctx, args);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/you are not in it/);
    expect(mutations).toEqual([]);
  });

  test("a member of the channel links it", async () => {
    slack(true);
    const { ctx, mutations } = ctxFor("xoxp-person");
    const out = await (linkChannel as any)._handler(ctx, args);
    expect(out).toMatchObject({ ok: true, link_id: "link_1" });
    expect(mutations.some((m) => m.includes("commitLink"))).toBe(true);
  });
});
