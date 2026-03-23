import { afterEach, describe, expect, test } from "bun:test";
import { buildCodexStableContext } from "./daemon.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("buildCodexStableContext", () => {
  test("returns undefined when stable mode is disabled", async () => {
    const context = await buildCodexStableContext({
      auth_token: "token",
      convex_url: "https://example.cloud",
    } as any, "/tmp/project");

    expect(context).toBeUndefined();
  });

  test("builds solo stable context scoped to the current project", async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        conversations: [{
          id: "conv-1234567890",
          title: "Fix auth flow",
          updated_at: "2026-03-23T10:00:00.000Z",
          message_count: 3,
          project_path: "/tmp/project",
          preview: [{ line: 1, role: "user", content: "fix auth" }],
        }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const context = await buildCodexStableContext({
      stable_mode: "solo",
      stable_global: false,
      auth_token: "token",
      convex_url: "https://example.cloud",
    } as any, "/tmp/project");

    expect(requestBody).toMatchObject({
      api_token: "token",
      limit: 10,
      offset: 0,
      project_path: "/tmp/project",
    });
    expect(typeof requestBody?.start_time).toBe("number");
    expect(context).toContain('<stable-context mode="solo">');
    expect(context).toContain("This gives you bigger-picture visibility on what you have been and are currently working on.");
    expect(context).toContain("<FEED>");
    expect(context).toContain("Fix auth flow");
    expect(context).not.toContain("\u001b[");
  });

  test("builds team stable context across all projects when global mode is enabled", async () => {
    let requestBody: Record<string, unknown> | undefined;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body || "{}"));
      return new Response(JSON.stringify({
        conversations: [],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const context = await buildCodexStableContext({
      stable_mode: "team",
      stable_global: true,
      auth_token: "token",
      convex_url: "https://example.cloud",
    } as any, "/tmp/project");

    expect(requestBody).toMatchObject({
      api_token: "token",
      limit: 15,
      offset: 0,
    });
    expect(requestBody?.project_path).toBeUndefined();
    expect(context).toContain('<stable-context mode="team">');
    expect(context).toContain("This gives you bigger-picture visibility on what has been and is being worked on by the team.");
    expect(context).toContain("No conversations found.");
  });
});
