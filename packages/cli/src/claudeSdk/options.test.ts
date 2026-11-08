import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { parseClaudeArgs, sdkQueryOptions, sdkSessionEnv, SDK_SESSION_ENV } from "./options.js";
import { versionAtLeast } from "./session.js";
import { FIXTURE_DIR, scrub } from "./testing/recording.js";
import { buildLaunchArgs } from "../launchCommand.js";

describe("parseClaudeArgs", () => {
  test("reads the argv the tmux path builds", () => {
    const { binaryArgs } = buildLaunchArgs({
      agentType: "claude",
      configuredArgs: "--add-dir /tmp/x",
      permFlags: "--permission-mode bypassPermissions",
      defaultFlags: null,
      modelAlias: "opus",
      requestedEffort: "high",
      assignedClaudeSessionId: "11111111-1111-4111-8111-111111111111",
    });
    const parsed = parseClaudeArgs(binaryArgs);
    expect(parsed).toMatchObject({
      model: "opus",
      effort: "high",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      sessionId: "11111111-1111-4111-8111-111111111111",
      additionalDirectories: ["/tmp/x"],
    });
    expect(parsed.extraArgs).toEqual({});
  });

  test("the 'default' permission setting keeps Claude's own starting mode", () => {
    const parsed = parseClaudeArgs(["--allow-dangerously-skip-permissions"]);
    expect(parsed.permissionMode).toBeUndefined();
    expect(parsed.allowDangerouslySkipPermissions).toBe(true);
  });

  test("a prompt that opens with a dash is still the flag's value", () => {
    expect(parseClaudeArgs(["--append-system-prompt", "- be brief\n- be kind", "--model", "opus"])).toMatchObject({ appendSystemPrompt: "- be brief\n- be kind", model: "opus", extraArgs: {} });
  });

  test("tool policy lists and unknown flags", () => {
    const parsed = parseClaudeArgs(["--allowedTools", "Read,Grep", "--disallowedTools", "Edit", "Bash(rm:*)", "--chrome", "--foo=bar", "--name", "x"]);
    expect(parsed.allowedTools).toEqual(["Read", "Grep"]);
    expect(parsed.disallowedTools).toEqual(["Edit", "Bash(rm:*)"]);
    expect(parsed.extraArgs).toEqual({ chrome: null, foo: "bar", name: "x" });
  });
});

describe("sdkSessionEnv", () => {
  test("drops nested-session markers and MCP_TOOL_TIMEOUT, pins persistence, marks the backend", () => {
    const env = sdkSessionEnv(
      { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", MCP_TOOL_TIMEOUT: "60000", CLAUDE_CODE_EFFORT_LEVEL: "low", HOME: "/h", CAST_LAUNCHD_LABEL: "x" },
      { env: { CODECAST_LAUNCH_TOKEN: "t" } },
      { effortSet: true },
    );
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.MCP_TOOL_TIMEOUT).toBeUndefined();
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined();
    expect(env.CAST_LAUNCHD_LABEL).toBeUndefined();
    expect(env.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("1");
    expect(env[SDK_SESSION_ENV]).toBe("1");
    expect(env.CODECAST_LAUNCH_TOKEN).toBe("t");
    expect(env.HOME).toBe("/h");
  });

  test("keeps a shell effort level when codecast picks none", () => {
    expect(sdkSessionEnv({ CLAUDE_CODE_EFFORT_LEVEL: "low" }, { env: {} }, { effortSet: false }).CLAUDE_CODE_EFFORT_LEVEL).toBe("low");
  });
});

describe("sdkQueryOptions", () => {
  const spec = { conversationId: null, sessionId: "s1-aaaaaaaa", resume: false, cwd: "/w", executable: "/bin/claude", args: ["--model", "opus"], env: {} };
  test("keeps Claude Code's own setup: user's binary, all settings sources, the claude_code preset", () => {
    const o = sdkQueryOptions(spec, {});
    expect(o.pathToClaudeCodeExecutable).toBe("/bin/claude");
    expect(o.settingSources).toBeUndefined();
    expect(o.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
    expect(o.persistSession).toBe(true);
    expect(o.sessionId).toBe("s1-aaaaaaaa");
    expect(o.resume).toBeUndefined();
  });
  test("a resume names the saved session and no new id", () => {
    const o = sdkQueryOptions({ ...spec, resume: true }, {});
    expect(o.resume).toBe("s1-aaaaaaaa");
    expect(o.sessionId).toBeUndefined();
  });
  test("an appended system prompt rides the preset", () => {
    expect(sdkQueryOptions({ ...spec, appendSystemPrompt: "read only" }, {}).systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "read only" });
  });
});

test("versionAtLeast", () => {
  expect(versionAtLeast("2.1.319", "2.1.248")).toBe(true);
  expect(versionAtLeast("2.1.248", "2.1.248")).toBe(true);
  expect(versionAtLeast("2.1.100", "2.1.248")).toBe(false);
  expect(versionAtLeast("2.2.0-beta", "2.1.248")).toBe(true);
  expect(versionAtLeast("1.9.999", "2.1.248")).toBe(false);
});

describe("recording privacy", () => {
  test("checked-in recordings hold no thinking, no account identity and no home directory", () => {
    const names = fs.readdirSync(FIXTURE_DIR).filter((n) => n.endsWith(".jsonl"));
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      const text = fs.readFileSync(`${FIXTURE_DIR}/${name}`, "utf-8");
      const lines = text.trim().split("\n").slice(1);
      for (const line of lines) {
        // Booleans, so a failure cannot print the content it found.
        const unchanged = JSON.stringify(scrub(JSON.parse(line))) === JSON.stringify(JSON.parse(line));
        expect(unchanged, name).toBe(true);
      }
      expect(/"type":"(thinking|redacted_thinking|thinking_delta|signature_delta)"/.test(text), name).toBe(false);
    }
  });

  test("scrub drops thinking blocks and replaces identity", () => {
    const out = scrub({ content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "hi a@b.com /Users/me/x" }], organization: "Acme" }, "/Users/me");
    expect(out).toEqual({ content: [{ type: "text", text: "hi user@example.com /Users/user/x" }], organization: "Example Org" });
  });
});
