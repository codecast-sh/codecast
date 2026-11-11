import { afterEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildStableContext,
  prepareLaunchStableContext,
  runStableContextServed,
  refreshStableCache,
  whereForNewSession,
  STABLE_CONTEXT_BUDGET,
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

  test("leads with where the session sits in the org, asked for by the session being started", async () => {
    const asked: Record<string, any> = {};
    const where = {
      workspace: { kind: "team", id: "t1", name: "Acme" },
      session: { short_id: "jx1", title: "Sitemap fix", person: "Ashot", lead: null },
      work: { task: null, plan: null, project: null },
      seat: { how: "none", handles: [] },
      card: null,
      chain: [],
      roles: [{ handle: "growth", name: "Growth lead", reports_to: "Ashot", scope: ["Growth"], whole_workspace: false, seat: false }],
      people: [{ name: "Ashot", role: "admin", is_me: true }],
    };
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      asked[url] = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(url.endsWith("/cli/org/where") ? where : { conversations: [] }), { status: 200 });
    }) as typeof fetch;

    const built = await buildStableContext({ auth_token: "secret", convex_url: "https://example.cloud" }, { mode: "team", global: false, cwd: "/repo", session: "conversations123" });

    expect(asked["https://example.site/cli/org/where"]).toEqual({ api_token: "secret", session: "conversations123" });
    // The org leads; the pool's one <flows> line (flows.md FL7) may sit between it and the feed.
    expect(built!.text).toMatch(/^<org-context workspace="Acme">[\s\S]*<\/org-context>\n\n(<flows>[^\n]*<\/flows>\n\n)?<stable-context mode="team">/);
    expect(built!.text).toContain("@growth Growth lead · reports to Ashot · looks after Growth");
  });

  test("leaves the org out when the workspace has none", async () => {
    globalThis.fetch = (async (input) =>
      new Response(String(input).endsWith("/cli/org/where") ? "null" : JSON.stringify({ conversations: [] }), { status: 200 })) as typeof fetch;
    const built = await buildStableContext({ auth_token: "secret", convex_url: "https://example.cloud" }, { mode: "solo", global: false, cwd: "/repo" });
    expect(built!.text.endsWith("</stable-context>")).toBe(true);
  });

  test("fits the hook budget by dropping the oldest feed cards, never the mods' instructions", async () => {
    const conversations = Array.from({ length: 15 }, (_, i) => ({
      id: `conversation${i}`, title: `Card ${i}`, updated_at: Date.now() - i * 60_000, message_count: 40,
      preview: Array.from({ length: 4 }, (_, j) => ({ line: j + 1, role: j % 2 ? "assistant" : "user", content: "x".repeat(300) })),
    }));
    const mods = [{ name: "union", title: "Union", agents: "Name Union rows by id. ".repeat(40), fences: [], objects: [{ prefix: "contact", title: "Contact", fields: [], external: true }] }];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/cli/mods/guide")) return new Response(JSON.stringify({ mods }), { status: 200 });
      if (url.endsWith("/cli/org/where")) return new Response("null", { status: 200 });
      return new Response(JSON.stringify({ conversations }), { status: 200 });
    }) as typeof fetch;
    const built = await buildStableContext({ auth_token: "secret", convex_url: "https://example.cloud" }, { mode: "team", global: false, cwd: "/repo" });
    expect(Buffer.byteLength(built!.text)).toBeLessThanOrEqual(STABLE_CONTEXT_BUDGET);
    expect(built!.text.startsWith("<mods>")).toBe(true);
    expect(built!.text).toContain("contact-<id>");
    expect(built!.data.items.length).toBeGreaterThan(0);
    expect(built!.data.items.length).toBeLessThan(15);
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

describe("stable-context at session start", () => {
  const config = { auth_token: "secret", convex_url: "https://example.cloud" };
  const where = {
    workspace: { kind: "team" as const, id: "t1", name: "Acme" },
    session: { short_id: "jx7aaaa", title: "Old session", person: "Ashot", lead: { short_id: "jx7bbbb", title: "Lead" } },
    work: { task: { short_id: "ct-1", title: "Task" }, plan: null, project: null },
    seat: { how: "owner" as const, handles: ["growth"] },
    card: null,
    chain: ["Ashot"],
    roles: [{ handle: "growth", name: "Growth lead", reports_to: "Ashot", scope: ["Growth"], whole_workspace: false, seat: true }],
    people: [{ name: "Ashot", role: "admin", is_me: true }],
  };
  const conversations = [{ id: "conversation1", title: "Prior work", updated_at: Date.now(), message_count: 3, preview: [] }];
  const serve = (fail: string[] = []) => (async (input: unknown) => {
    const url = String(input);
    if (fail.some((f) => url.endsWith(f))) return new Response("{}", { status: 500 });
    if (url.endsWith("/cli/org/where")) return new Response(JSON.stringify(where), { status: 200 });
    if (url.endsWith("/cli/mods/guide")) return new Response("{}", { status: 200 });
    if (url.endsWith("/cli/teams/projects")) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (url.endsWith("/cli/workflows/pool")) return new Response(JSON.stringify({ flows: [] }), { status: 200 });
    return new Response(JSON.stringify({ conversations }), { status: 200 });
  }) as typeof fetch;
  const scratch = () => (scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "stable-cache-")));

  test("a warm cache renders with no network call, the org filled in for the new session", async () => {
    const cacheDir = scratch();
    globalThis.fetch = serve();
    await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir });
    globalThis.fetch = (async () => { throw new Error("no network at session start"); }) as unknown as typeof fetch;
    const built = await buildStableContext(config, { mode: "team", global: false, cwd: "/repo", session: "jx7cccccccccccccccc", cacheDir, start: { budgetMs: 1500, source: "startup" } });
    expect(built!.stale).toBe(true);
    expect(built!.text).toContain("This session: jx7cccc, Ashot's session");
    expect(built!.text).toContain("Working on: no task or plan is bound to this session yet.");
    expect(built!.text).not.toContain("Spawned by");
    expect(built!.text).toContain("Prior work");
  });

  test("a session's own org read, made while it was starting, wins over the filled one", async () => {
    const cacheDir = scratch();
    globalThis.fetch = serve();
    await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir, session: "jx7aaaaaaaaaaaaaaaaa" });
    globalThis.fetch = (async () => { throw new Error("no network at session start"); }) as unknown as typeof fetch;
    const built = await buildStableContext(config, { mode: "team", global: false, cwd: "/repo", session: "jx7aaaaaaaaaaaaaaaaa", cacheDir, start: { budgetMs: 1500, source: "startup" } });
    expect(built!.text).toContain("Spawned by: jx7bbbb Lead");
  });

  test("a cold start prints the lead blocks when the feed fails", async () => {
    const cacheDir = scratch();
    globalThis.fetch = serve(["/cli/feed"]);
    const built = await buildStableContext(config, { mode: "team", global: false, cwd: "/repo", cacheDir, start: { budgetMs: 1500, source: "startup" } });
    expect(built!.text).toContain("<org-context");
    expect(built!.text).not.toContain("<stable-context");
    expect(built!.stale).toBe(true);
  });

  test("a failed read keeps the cached copy", async () => {
    const cacheDir = scratch();
    globalThis.fetch = serve();
    await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir });
    globalThis.fetch = serve(["/cli/feed"]);
    const reads = await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir });
    expect(reads!.feed.conversations[0].title).toBe("Prior work");
  });

  test("a launch's block is rendered ahead and the hook prints it once with no process to start", async () => {
    const home = scratch();
    const ccDir = path.join(home, ".codecast");
    const cacheDir = path.join(ccDir, "stable-cache");
    globalThis.fetch = serve();
    await prepareLaunchStableContext(config, { mode: "team", global: false, cwd: "/repo", session: "jx7dddddddddddddddd", cacheDir });
    const hook = path.join(home, "hook.sh");
    fs.writeFileSync(hook, STABLE_FEED_HOOK, { mode: 0o755 });
    // No codecast on PATH: only the rendered file can answer.
    const run = () => Bun.spawnSync(["/bin/bash", hook], { env: { HOME: home, CODECAST_DIR: ccDir, CODECAST_STABLE_MODE: "team", CODECAST_CONVERSATION_ID: "jx7dddddddddddddddd", PATH: "/usr/bin:/bin" } }).stdout.toString();
    const first = run();
    expect(first).toContain("Spawned by: jx7bbbb Lead");
    expect(first).toContain("Prior work");
    expect(run()).toBe("");
  });

  test("a terminal start prints its folder's block from the script; resumes and exclusions take the full path", async () => {
    const home = scratch();
    const ccDir = path.join(home, ".codecast");
    const cacheDir = path.join(ccDir, "stable-cache");
    fs.mkdirSync(ccDir, { recursive: true });
    fs.writeFileSync(path.join(ccDir, "config.json"), JSON.stringify({ stable_mode: "team", stable_global: false }, null, 2));
    globalThis.fetch = serve();
    await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir });
    const hook = path.join(home, "hook.sh");
    fs.writeFileSync(hook, STABLE_FEED_HOOK, { mode: 0o755 });
    const run = (payload: object, env: Record<string, string> = {}) => Bun.spawnSync(["/bin/bash", hook], {
      stdin: Buffer.from(JSON.stringify(payload)),
      // No codecast on PATH: only the folder's block can answer.
      env: { HOME: home, CODECAST_DIR: ccDir, PATH: "/usr/bin:/bin:/sbin", ...env },
    }).stdout.toString();
    const block = run({ session_id: "0b7e2f3c-1111-2222-3333-444455556666", cwd: "/repo", source: "startup" });
    expect(block).toContain("<org-context workspace=\"Acme\">");
    expect(block).toContain("Prior work");
    expect(block).not.toContain("This session:");
    expect(run({ session_id: "0b7e2f3c-1111-2222-3333-444455556666", cwd: "/repo", source: "startup" })).toBe(block);
    expect(run({ session_id: "s1", cwd: "/repo", source: "resume" })).toBe("");
    expect(run({ session_id: "s1", cwd: "/repo", source: "startup" }, { CODECAST_STABLE_EXCLUDE: "conversation1" })).toBe("");
    expect(run({ session_id: "s1", cwd: "/elsewhere", source: "startup" })).toBe("");
  });

  test("a served folder block is recorded against the session that got it", async () => {
    const cacheDir = scratch();
    globalThis.fetch = serve();
    await refreshStableCache(config, { mode: "team", global: false, cwd: "/repo", cacheDir });
    const key = fs.readdirSync(cacheDir).find((n) => n.startsWith("rendered-dir-") && n.endsWith(".json"))!.slice("rendered-dir-".length, -".json".length);
    const recorded: any[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith("/cli/stable-context")) recorded.push(JSON.parse(String(init?.body)));
      return serve()(input as any, init);
    }) as typeof fetch;
    await runStableContextServed(config, key, "0b7e2f3c-1111-2222-3333-444455556666", cacheDir);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].session_id).toBe("0b7e2f3c-1111-2222-3333-444455556666");
    expect(JSON.parse(recorded[0].data).items[0].title).toBe("Prior work");
  });

  test("the filled org keeps the workspace and drops what belonged to the other session", () => {
    const filled = whereForNewSession(where, "a1b2c3d4-0000-0000-0000-000000000000");
    expect(filled.session).toBeNull();
    expect(filled.seat).toEqual({ how: "none", handles: [] });
    expect(filled.roles[0].seat).toBe(false);
    expect(filled.people).toEqual(where.people);
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

  test("codex: enables the hooks feature flag but respects an explicit opt-out", () => {
    const home = freshHome();
    const codexDir = path.join(home, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });

    // No config.toml at all → created with the flag.
    installStableHookCodex();
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8")).toBe("[features]\nhooks = true\n");

    // Existing [features] table → flag inserted, other keys preserved.
    fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "gpt-5"\n\n[features]\nmulti_agent = true\n');
    installStableHookCodex();
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8")).toBe(
      'model = "gpt-5"\n\n[features]\nhooks = true\nmulti_agent = true\n',
    );

    // Explicit hooks = false → untouched.
    const optOut = "[features]\nhooks = false\n";
    fs.writeFileSync(path.join(codexDir, "config.toml"), optOut);
    installStableHookCodex();
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf-8")).toBe(optOut);
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
