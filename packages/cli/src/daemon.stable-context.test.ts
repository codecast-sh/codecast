import { afterEach, describe, expect, test } from "bun:test";
import {
  buildCodexStableContext,
  startCodexThreadThenRecordStableContext,
} from "./daemon.js";

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
    expect(context?.text).toContain('<stable-context mode="solo">');
    expect(context?.text).toContain("This gives you bigger-picture visibility on what you have been and are currently working on.");
    expect(context?.text).toContain("<FEED>");
    expect(context?.text).toContain("Fix auth flow");
    expect(context?.text).not.toContain("\u001b[");
    // Structured record mirrors the injected feed.
    expect(context?.data.mode).toBe("solo");
    expect(context?.data.items).toEqual([
      expect.objectContaining({ id: "conv-1234567890", title: "Fix auth flow", message_count: 3 }),
    ]);
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
    expect(context?.text).toContain('<stable-context mode="team">');
    expect(context?.text).toContain("This gives you bigger-picture visibility on what has been and is being worked on by the team.");
    expect(context?.text).toContain("No conversations found.");
  });

  test("per-session prefs override config: off suppresses, mode swaps", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
    const config = {
      stable_mode: "team",
      auth_token: "token",
      convex_url: "https://example.cloud",
    } as any;

    expect(await buildCodexStableContext(config, "/tmp/p", { stable_mode: "off" })).toBeUndefined();

    const solo = await buildCodexStableContext(config, "/tmp/p", { stable_mode: "solo" });
    expect(solo?.text).toContain('<stable-context mode="solo">');

    // No configured mode at all + an explicit per-session mode still injects.
    const optIn = await buildCodexStableContext({ auth_token: "token", convex_url: "https://example.cloud" } as any, "/tmp/p", { stable_mode: "team" });
    expect(optIn?.text).toContain('<stable-context mode="team">');
  });

  test("excluded conversations are dropped from the feed and the record", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      conversations: [
        { id: "jx7aaaabbbbccccddddeeeeffffgggg00", title: "Keep me", updated_at: "2026-03-23T10:00:00.000Z", message_count: 2, project_path: null, preview: [] },
        { id: "jx7zzzzbbbbccccddddeeeeffffgggg00", title: "Drop me", updated_at: "2026-03-23T10:00:00.000Z", message_count: 5, project_path: null, preview: [] },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;

    const context = await buildCodexStableContext({
      stable_mode: "team",
      auth_token: "token",
      convex_url: "https://example.cloud",
    } as any, "/tmp/p", { stable_exclude: ["jx7zzzz"] });

    expect(context?.text).toContain("Keep me");
    expect(context?.text).not.toContain("Drop me");
    expect(context?.data.items.map((i) => i.title)).toEqual(["Keep me"]);
  });
});

describe("Codex stable-context recording order", () => {
  test("does not record when app-server threadStart fails and falls back", async () => {
    const calls: string[] = [];

    await expect(startCodexThreadThenRecordStableContext(
      async () => {
        calls.push("threadStart");
        throw new Error("app-server unavailable");
      },
      () => {
        calls.push("record");
      },
    )).rejects.toThrow("app-server unavailable");

    expect(calls).toEqual(["threadStart"]);
  });

  test("records only after a successful app-server threadStart", async () => {
    const calls: string[] = [];

    const response = await startCodexThreadThenRecordStableContext(
      async () => {
        calls.push("threadStart");
        return { thread: { id: "thread-123" } };
      },
      () => {
        calls.push("record");
      },
    );

    expect(response.thread.id).toBe("thread-123");
    expect(calls).toEqual(["threadStart", "record"]);
  });
});
