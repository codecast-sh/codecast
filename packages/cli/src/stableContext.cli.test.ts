import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";

const scratchHomes: string[] = [];
const cliEntry = path.join(import.meta.dir, "index.ts");
const processEntry = path.join(import.meta.dir, "main.ts");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function scratchHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-stable-cli-"));
  scratchHomes.push(home);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "update-state.json"), JSON.stringify({
    lastCheck: new Date().toISOString(),
  }));
  return home;
}

function runCli(
  home: string,
  args: string[],
  stdin = "",
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processEntry, ...args], {
      env: {
        ...process.env,
        HOME: home,
        NO_COLOR: "1",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

afterEach(() => {
  for (const home of scratchHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("stable-context CLI isolation", () => {
  test("prints only the exact hook block and bypasses Commander preAction", async () => {
    const home = scratchHome();
    let recordCalls = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/cli/feed") {
        res.end(JSON.stringify({ conversations: [] }));
        return;
      }
      if (req.url === "/cli/stable-context") {
        recordCalls++;
        res.end("{}");
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({
        auth_token: "test-token",
        convex_url: `http://127.0.0.1:${address.port}`,
        stable_mode: "solo",
        auto_update: false,
      }));
      // A Commander-routed stable-context command would run preAction and emit
      // this debug line to stderr. The hidden protocol path must not.
      const result = await runCli(
        home,
        ["stable-context"],
        JSON.stringify({ session_id: "session-123", cwd: "/tmp/project" }),
        { DEBUG_CLI: "1", CODECAST_STABLE_MODE: "solo" },
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `<stable-context mode="solo">
This gives you bigger-picture visibility on what you have been and are currently working on.
This is a snapshot from session start — \`cast feed\` / \`cast sessions\` give the current picture. Before attributing work to a session or messaging it about its work, check its evidence: \`cast diff <id>\` shows the files it changed, \`cast read <id>\` its recent turns. A session's state says who is paying attention now, not who wrote what.

<FEED>
No conversations found.
Use --mine for only your sessions, -g for all teams.
</FEED>
</stable-context>
`,
      );
      expect(recordCalls).toBe(1);
      expect(fs.existsSync(path.join(home, ".codecast", "daemon.pid"))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => err ? reject(err) : resolve()),
      );
    }
  }, 20_000);

  test("per-client envelopes: codex and cursor wrap the block in their hook JSON; off is silent", async () => {
    const home = scratchHome();
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      res.end(req.url === "/cli/feed" ? JSON.stringify({ conversations: [] }) : "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server address");
      fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({
        auth_token: "test-token",
        convex_url: `http://127.0.0.1:${address.port}`,
        stable_mode: "solo",
        auto_update: false,
      }));

      const codex = await runCli(
        home,
        ["stable-context", "--client", "codex"],
        JSON.stringify({ session_id: "codex-thread-1", cwd: "/tmp/project" }),
      );
      expect(codex.code).toBe(0);
      const codexOut = JSON.parse(codex.stdout);
      expect(codexOut.hookSpecificOutput.hookEventName).toBe("SessionStart");
      expect(codexOut.hookSpecificOutput.additionalContext).toContain('<stable-context mode="solo">');

      // Cursor's payload has no cwd — workspace_roots[0] takes its place.
      const cursor = await runCli(
        home,
        ["stable-context", "--client", "cursor"],
        JSON.stringify({ session_id: "cursor-1", workspace_roots: ["/tmp/project"] }),
      );
      expect(cursor.code).toBe(0);
      const cursorOut = JSON.parse(cursor.stdout);
      expect(cursorOut.additional_context).toContain('<stable-context mode="solo">');

      // opencode consumes raw text (the plugin pushes stdout into the system prompt).
      const opencode = await runCli(
        home,
        ["stable-context", "--client", "opencode"],
        JSON.stringify({ session_id: "oc-1", cwd: "/tmp/project" }),
      );
      expect(opencode.code).toBe(0);
      expect(opencode.stdout).toStartWith('<stable-context mode="solo">');

      // Cursor imports Claude user hooks and runs them with its own payload
      // (marked by cursor_version). The Claude envelope must stay silent there
      // — Cursor's native sessionStart hook already injects the feed.
      const claudeUnderCursor = await runCli(
        home,
        ["stable-context"],
        JSON.stringify({ session_id: "cursor-1", cursor_version: "3.14.27", workspace_roots: [] }),
      );
      expect(claudeUnderCursor.code).toBe(0);
      expect(claudeUnderCursor.stdout).toBe("");

      // The daemon exports CODECAST_STABLE_MODE=off into the codex app-server
      // (threads there already get the feed via developerInstructions) — the
      // hook must print nothing so a thread is never injected twice.
      const suppressed = await runCli(
        home,
        ["stable-context", "--client", "codex"],
        JSON.stringify({ session_id: "codex-thread-2", cwd: "/tmp/project" }),
        { CODECAST_STABLE_MODE: "off" },
      );
      expect(suppressed.code).toBe(0);
      expect(suppressed.stdout).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => err ? reject(err) : resolve()),
      );
    }
  }, 20_000);

  test("source guard keeps update checks and global CLI effects out of the fast path", () => {
    // main.ts must claim the hot-path verbs BEFORE index.js loads: index.ts's
    // static imports are hoisted, so nothing inside it can be cheap.
    const main = fs.readFileSync(path.join(import.meta.dir, "main.ts"), "utf8");
    expect(main.indexOf("runFastPath(process.argv)")).toBeGreaterThan(0);
    expect(main.indexOf("runFastPath(process.argv)")).toBeLessThan(main.indexOf('import("./index.js")'));
    expect(main).not.toContain('from "./index.js"');

    // fastPath.ts reaches every module through a dynamic import(), so a verb
    // pays only for what it uses and the compiled bundle keeps index.js lazy.
    const fastPath = fs.readFileSync(path.join(import.meta.dir, "fastPath.ts"), "utf8");
    expect(fastPath.match(/^import .* from /gm)).toBeNull();
    expect(fastPath).toContain(
      "hook.runStableContextHook(\n          cfg.readAuthConfig(cfg.defaultConfigDir()),\n          hook.parseStableHookClient(argv[4]),",
    );
    for (const effect of ["ensureCastAlias()", "autoBindFromEnv()", "program.parse()", "checkForUpdates()"]) {
      expect(fastPath).not.toContain(effect);
    }

    // index.ts (older wrapper scripts still start here) keeps the same shape:
    // fast path claimed first, update check gated off it.
    const source = fs.readFileSync(cliEntry, "utf8");
    expect(source).toContain("if (!isStableContextFastPath) checkForUpdates()");
    const claimed = source.slice(source.indexOf("if (runFastPath(process.argv)) {"));
    const fallback = claimed.indexOf("} else if (process.argv[2] === \"__fugitive_blame@@\")");
    expect(fallback).toBeGreaterThan(0);
    for (const effect of ["ensureCastAlias()", "autoBindFromEnv()", "program.parse()"]) {
      expect(claimed.slice(0, fallback)).not.toContain(effect);
    }
  });
});

describe("cast install --disable", () => {
  test("also disables stable mode and removes only Codecast's SessionStart hook", async () => {
    const home = scratchHome();
    const codecastDir = path.join(home, ".codecast");
    const claudeDir = path.join(home, ".claude");
    const hookPath = path.join(claudeDir, "hooks", "stable-feed.sh");
    const settingsPath = path.join(claudeDir, "settings.json");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });

    const config: Record<string, unknown> = {
      stable_mode: "team",
      stable_global: true,
    };
    for (const snippet of SNIPPET_CATALOG) config[snippet.enabledKey] = true;
    fs.writeFileSync(path.join(codecastDir, "config.json"), JSON.stringify(config));
    fs.writeFileSync(hookPath, "#!/bin/bash\ncodecast stable-context\n", { mode: 0o755 });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{
          matcher: "",
          hooks: [
            { type: "command", command: hookPath, timeout: 30 },
            { type: "command", command: "/tmp/keep-unrelated-session-start.sh" },
          ],
        }],
      },
    }));

    const result = await runCli(home, ["install", "--disable"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("All snippets disabled.");
    const written = JSON.parse(fs.readFileSync(path.join(codecastDir, "config.json"), "utf8"));
    expect(written.stable_mode).toBeUndefined();
    expect(written.stable_global).toBeUndefined();
    for (const snippet of SNIPPET_CATALOG) {
      expect(written[snippet.enabledKey]).toBe(false);
    }
    expect(fs.existsSync(hookPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks.SessionStart).toEqual([{
      matcher: "",
      hooks: [{ type: "command", command: "/tmp/keep-unrelated-session-start.sh" }],
    }]);
  }, 20_000);
});
