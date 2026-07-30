import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureStableHookForLaunch,
  recordStableContext,
  removeStableHook,
  STABLE_FEED_HOOK,
} from "./stableContext";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
let scratchHome: string | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (scratchHome) {
    fs.rmSync(scratchHome, { recursive: true, force: true });
    scratchHome = undefined;
  }
});

describe("stable-context recording", () => {
  test("posts the exact injected snapshot to the stable-context endpoint", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await recordStableContext({
      auth_token: "secret",
      convex_url: "https://example.cloud",
    }, {
      conversation_id: "conversations123",
      data: {
        mode: "solo",
        injected_at: 123,
        items: [{ id: "conversations456", title: "Prior work" }],
      },
    });

    expect(requestUrl).toBe("https://example.site/cli/stable-context");
    expect(requestBody).toEqual({
      api_token: "secret",
      conversation_id: "conversations123",
      data: JSON.stringify({
        mode: "solo",
        injected_at: 123,
        items: [{ id: "conversations456", title: "Prior work" }],
      }),
    });
  });

  test("does not make an unkeyed recording request", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await recordStableContext({
      auth_token: "secret",
      convex_url: "https://example.cloud",
    }, {
      data: { mode: "team", injected_at: 123, items: [] },
    });

    expect(calls).toBe(0);
  });
});

describe("stable-context SessionStart hook", () => {
  test("an explicit Claude Team/Solo opt-in installs a usable hook on an off-by-default machine", () => {
    scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-stable-context-"));
    process.env.HOME = scratchHome;
    const claudeDir = path.join(scratchHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "",
          hooks: [{ type: "command", command: "/tmp/keep-me.sh" }],
        }],
      },
    }));

    expect(ensureStableHookForLaunch("claude", undefined, { stable_mode: "team" })).toBe(true);
    fs.chmodSync(path.join(claudeDir, "hooks", "stable-feed.sh"), 0o600);
    expect(ensureStableHookForLaunch("claude", undefined, { stable_mode: "solo" })).toBe(true);

    const hookPath = path.join(claudeDir, "hooks", "stable-feed.sh");
    expect(fs.readFileSync(hookPath, "utf-8")).toBe(STABLE_FEED_HOOK);
    expect(fs.statSync(hookPath).mode & 0o777).toBe(0o755);
    let settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"));
    const commands = settings.hooks.SessionStart.flatMap(
      (matcher: { hooks?: Array<{ command?: string }> }) =>
        (matcher.hooks ?? []).map((hook) => hook.command),
    );
    expect(commands.filter((command: string) => command?.includes("stable-feed.sh"))).toHaveLength(1);
    expect(commands).toContain("/tmp/keep-me.sh");

    removeStableHook();

    expect(fs.existsSync(hookPath)).toBe(false);
    settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf-8"));
    expect(settings.hooks.SessionStart).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: "/tmp/keep-me.sh" }],
    }]);
  });

  test("leaves stable off unless config or explicit Claude prefs enable it", () => {
    let installs = 0;
    const install = () => { installs++; };

    expect(ensureStableHookForLaunch("claude", undefined, {}, install)).toBe(false);
    expect(ensureStableHookForLaunch("claude", "team", { stable_mode: "off" }, install)).toBe(false);
    expect(ensureStableHookForLaunch("codex", undefined, { stable_mode: "team" }, install)).toBe(false);
    expect(installs).toBe(0);

    expect(ensureStableHookForLaunch("claude", "solo", {}, install)).toBe(true);
    expect(installs).toBe(1);
  });
});
