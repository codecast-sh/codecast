import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureStableHookForLaunch,
  installStableHookCodex,
  installStableHookCursor,
  installStableHookOpencode,
  recordStableContext,
  removeStableHook,
  removeStableHookCodex,
  removeStableHookCursor,
  removeStableHookOpencode,
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

  test("leaves stable off unless config or explicit prefs enable it", () => {
    let installs = 0;
    const install = () => { installs++; };

    expect(ensureStableHookForLaunch("claude", undefined, {}, install)).toBe(false);
    expect(ensureStableHookForLaunch("claude", "team", { stable_mode: "off" }, install)).toBe(false);
    expect(ensureStableHookForLaunch("codex", undefined, {}, install)).toBe(false);
    // Clients without a hook mechanism never install, even when enabled.
    expect(ensureStableHookForLaunch("gemini", undefined, { stable_mode: "team" }, install)).toBe(false);
    expect(ensureStableHookForLaunch("pi", "team", {}, install)).toBe(false);
    expect(installs).toBe(0);

    expect(ensureStableHookForLaunch("claude", "solo", {}, install)).toBe(true);
    expect(ensureStableHookForLaunch("codex", undefined, { stable_mode: "team" }, install)).toBe(true);
    expect(ensureStableHookForLaunch("cursor", "team", {}, install)).toBe(true);
    expect(ensureStableHookForLaunch("opencode", "solo", {}, install)).toBe(true);
    expect(installs).toBe(4);
  });
});

describe("per-client stable hook installers", () => {
  function freshHome(): string {
    scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-stable-clients-"));
    process.env.HOME = scratchHome;
    delete process.env.XDG_CONFIG_HOME;
    return scratchHome;
  }

  test("codex: merges into hooks.json, is idempotent, and removal preserves foreign hooks", () => {
    const home = freshHome();
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "/tmp/keep-me.sh" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "/tmp/other.sh" }] }],
      },
    }));

    installStableHookCodex();
    installStableHookCodex();

    const scriptPath = path.join(home, ".codecast", "hooks", "stable-feed-codex.sh");
    expect(fs.statSync(scriptPath).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(scriptPath, "utf-8")).toContain("stable-context --client codex");

    let config = JSON.parse(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf-8"));
    const commands = config.hooks.SessionStart.flatMap((m: any) => (m.hooks ?? []).map((h: any) => h.command));
    expect(commands.filter((c: string) => c === scriptPath)).toHaveLength(1);
    expect(commands).toContain("/tmp/keep-me.sh");
    const entry = config.hooks.SessionStart.flatMap((m: any) => m.hooks ?? []).find((h: any) => h.command === scriptPath);
    expect(entry.additionalContextLimit).toBe(0);

    removeStableHookCodex();
    expect(fs.existsSync(scriptPath)).toBe(false);
    config = JSON.parse(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf-8"));
    expect(config.hooks.SessionStart).toEqual([{ hooks: [{ type: "command", command: "/tmp/keep-me.sh" }] }]);
    expect(config.hooks.PreToolUse).toEqual([{ hooks: [{ type: "command", command: "/tmp/other.sh" }] }]);
  });

  test("cursor: merges into hooks.json alongside another product's hooks", () => {
    const home = freshHome();
    const cursorDir = path.join(home, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "/other/product.sh Start" }],
        sessionStart: [{ command: "/other/product-session.sh" }],
      },
    }));

    installStableHookCursor();
    installStableHookCursor();

    const scriptPath = path.join(home, ".codecast", "hooks", "stable-feed-cursor.sh");
    expect(fs.readFileSync(scriptPath, "utf-8")).toContain("stable-context --client cursor");

    let config = JSON.parse(fs.readFileSync(path.join(cursorDir, "hooks.json"), "utf-8"));
    expect(config.version).toBe(1);
    expect(config.hooks.sessionStart.filter((h: any) => h.command === scriptPath)).toHaveLength(1);
    expect(config.hooks.sessionStart.map((h: any) => h.command)).toContain("/other/product-session.sh");
    expect(config.hooks.beforeSubmitPrompt).toEqual([{ command: "/other/product.sh Start" }]);

    removeStableHookCursor();
    config = JSON.parse(fs.readFileSync(path.join(cursorDir, "hooks.json"), "utf-8"));
    expect(config.hooks.sessionStart).toEqual([{ command: "/other/product-session.sh" }]);
  });

  test("opencode: drops a plugin that shells the gated script; removal deletes both", () => {
    const home = freshHome();
    const ocDir = path.join(home, ".config", "opencode");
    fs.mkdirSync(ocDir, { recursive: true });

    installStableHookOpencode();

    const scriptPath = path.join(home, ".codecast", "hooks", "stable-feed-opencode.sh");
    const pluginPath = path.join(ocDir, "plugins", "codecast-stable.js");
    const plugin = fs.readFileSync(pluginPath, "utf-8");
    expect(plugin).toContain("experimental.chat.system.transform");
    expect(plugin).toContain(JSON.stringify(scriptPath));
    expect(fs.readFileSync(scriptPath, "utf-8")).toContain("stable-context --client opencode");

    removeStableHookOpencode();
    expect(fs.existsSync(pluginPath)).toBe(false);
    expect(fs.existsSync(scriptPath)).toBe(false);
  });

  test("installers are no-ops for clients not present on the machine", () => {
    const home = freshHome();
    installStableHookCodex();
    installStableHookCursor();
    installStableHookOpencode();
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".config", "opencode"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codecast", "hooks"))).toBe(false);
  });
});
