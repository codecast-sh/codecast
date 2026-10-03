// integrations.ts is the CLI's door to every connect flow. What earns tests
// is the routing: a token app never mints a browser URL, a browser app never
// takes a pasted token, and the token path delegates to the one
// tokenConnectors.connectWithToken the web form runs.

import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { cliConnectToken, cliConnectUrl } from "./integrations";

function recordingCtx(answer: any = { ok: true, id: "ai_1", label: "Acme" }) {
  const actions: { name: string; args: any }[] = [];
  return {
    actions,
    ctx: {
      runAction: async (ref: any, args: any) => {
        actions.push({ name: getFunctionName(ref), args });
        return answer;
      },
    } as any,
  };
}

describe("cliConnectToken", () => {
  test("delegates a token app to connectWithToken with the caller's scope and token", async () => {
    const { ctx, actions } = recordingCtx();
    const res = await (cliConnectToken as any)._handler(ctx, {
      api_token: "t",
      provider: "Sentry",
      token: "sntrys_x",
      config: { org: "acme" },
      scope: "personal",
    });
    expect(res).toEqual({ ok: true, id: "ai_1", label: "Acme" });
    expect(actions).toEqual([
      {
        name: "tokenConnectors:connectWithToken",
        args: { provider: "sentry", token: "sntrys_x", config: { org: "acme" }, scope: "personal", api_token: "t" },
      },
    ]);
  });

  test("a browser-flow app is refused without calling anything", async () => {
    const { ctx, actions } = recordingCtx();
    const res = await (cliConnectToken as any)._handler(ctx, { api_token: "t", provider: "linear", token: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/browser/);
    expect(actions).toHaveLength(0);
  });

  test("an unknown provider names the catalog", async () => {
    const { ctx } = recordingCtx();
    const res = await (cliConnectToken as any)._handler(ctx, { api_token: "t", provider: "datadog", token: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("posthog");
  });
});

describe("cliConnectUrl", () => {
  test("a token app has no URL to open and says how to connect it", async () => {
    const { ctx, actions } = recordingCtx();
    for (const provider of ["sentry", "posthog", "app"]) {
      const res = await (cliConnectUrl as any)._handler(ctx, { api_token: "t", provider });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/token/);
    }
    expect(actions).toHaveLength(0);
  });
});
