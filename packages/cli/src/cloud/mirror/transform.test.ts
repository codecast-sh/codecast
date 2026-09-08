import { describe, expect, test } from "bun:test";
import { REFERENCES_SNIPPET, SNIPPET_CATALOG } from "@codecast/shared/contracts";
import { findOwnedSections } from "@platform/snippets";
import {
  credentialContentReason, gitconfigKeyAllowed, ownedSectionSpecs, parseGitConfigList, parseJsonLoose, remapHome, renderGitconfig, scrubSecrets,
  splitTomlTables, joinTomlTables, stripOwnedSections, transformByKind, transformClaudeSettings, transformCodexToml, transformForHost,
  transformGeminiSettings, transformGrokToml, transformHooksJson, transformOpencodeJson, transformTomlRemap,
} from "./transform";

const ctx = { fromHome: "/Users/ashot", toHome: "/home/ubuntu" };

test("credential tripwire distinguishes runtime references from literal credentials without a minimum password length", () => {
  for (const source of ['apiKey: env.API_KEY', 'apiKey: ctx.env.OPENAI_API_KEY', 'api_key = os.environ["OPENAI_API_KEY"]', 'token = process.env.TOKEN', '{"apiKey":"env.API_KEY"}', '{"password":"YOUR_PASSWORD"}']) {
    expect(credentialContentReason(Buffer.from(source))).toBeNull();
  }
  expect(credentialContentReason(Buffer.from('{"password":"s3cret!"}'))).toBe("credential-bearing config excluded");
  expect(credentialContentReason(Buffer.from('{"password":"x"}'))).toBe("credential-bearing config excluded");
  expect(credentialContentReason(Buffer.from('{"password":".hidden-value"}'))).toBe("credential-bearing config excluded");
  expect(credentialContentReason(Buffer.from('{"accessToken":"/opaque-base64-value"}'))).toBe("credential-bearing config excluded");
  expect(credentialContentReason(Buffer.from('{"credentialFile":"~/.config/tool/credentials"}'))).toBeNull();
  expect(credentialContentReason(Buffer.from('AIza' + 'A1b2C'.repeat(7)))).toBe("credential material excluded");
});

test("Claude MCP projection remaps project keys and refuses raw auth or history state", () => {
  const input = { mcpServers: { local: { command: "/Users/ashot/scripts/run" } }, projects: { "/Users/ashot/src/repo": { mcpServers: { project: { command: "/Users/ashot/src/repo/mcp" } } } } };
  const result = JSON.parse(transformByKind("claude-mcp", Buffer.from(JSON.stringify(input)), { ...ctx, pathMappings: [{ from: "/Users/ashot/src/repo", to: "/home/ubuntu/work/repo" }] }).bytes.toString());
  expect(result.projects["/home/ubuntu/work/repo"].mcpServers.project.command).toBe("/home/ubuntu/work/repo/mcp");
  expect(result.mcpServers.local.command).toBe("/home/ubuntu/scripts/run");
  expect(() => transformByKind("claude-mcp", Buffer.from('{"oauthAccount":{"token":"private"}}'), ctx)).toThrow("invalid Claude MCP projection");
  expect(() => transformByKind("claude-mcp", Buffer.from('{"projects":{"/home/u":{"mcpServers":{},"history":[]}}}'), ctx)).toThrow("invalid Claude MCP projection");
});

/** A laptop CLAUDE.md: user text, every real catalog section, more user text. */
export function laptopClaudeMd(): string {
  const sections = SNIPPET_CATALOG.filter((d) => d.section).map((d) => d.section!.body);
  return `# My rules\n\nAlways run the tests.\n${sections.join("")}${REFERENCES_SNIPPET}\n## Memory\n\nMy own memory notes, no end marker.\n`;
}

describe("remapHome", () => {
  test("replaces the laptop home when followed by /, a quote, whitespace or the end — not /Users/ashot2", () => {
    const text = `a=/Users/ashot/x b="/Users/ashot" c='/Users/ashot' d=/Users/ashot2/y e=/Users/ashot`;
    expect(remapHome(text, ctx.fromHome, ctx.toHome))
      .toBe(`a=/home/ubuntu/x b="/home/ubuntu" c='/home/ubuntu' d=/Users/ashot2/y e=/home/ubuntu`);
  });
  test("identical homes are a no-op", () => {
    expect(remapHome("/home/ubuntu/x", "/home/ubuntu", "/home/ubuntu")).toBe("/home/ubuntu/x");
  });
});

describe("stripOwnedSections", () => {
  test("removes every catalog section plus Referencing objects, keeps a user ## Memory with no end marker, idempotent", () => {
    const md = laptopClaudeMd();
    const owned = ownedSectionSpecs().reduce((n, spec) => n + findOwnedSections(md, spec).length, 0);
    expect(owned).toBeGreaterThan(10);
    const stripped = stripOwnedSections(md);
    expect(stripped).toContain("# My rules\n\nAlways run the tests.");
    expect(stripped).toContain("## Memory\n\nMy own memory notes, no end marker.");
    expect(stripped).not.toContain("<!-- /codecast-");
    expect(stripped).not.toContain("## Visual Canvas");
    expect(stripped).not.toContain("## Referencing objects");
    expect(ownedSectionSpecs().reduce((n, spec) => n + findOwnedSections(stripped, spec).length, 0)).toBe(0);
    expect(stripOwnedSections(stripped)).toBe(stripped);
    expect(stripped).not.toMatch(/\n{3,}/);
  });

  test("the user's text ships byte for byte: blank runs inside a fenced block survive, only the cut seams are tidied; no section → identity", () => {
    const fence = "# Mine\n\n```txt\nline\n\n\n\nkept apart\n```\n";
    expect(stripOwnedSections(fence)).toBe(fence);
    const section = SNIPPET_CATALOG.find((d) => d.section)!.section!.body;
    const withSection = `${fence}\n\n\n${section}\n## After\n\nmore\n`;
    const stripped = stripOwnedSections(withSection);
    expect(stripped).toContain("line\n\n\n\nkept apart");
    expect(stripped).toBe(`${fence}\n## After\n\nmore\n`);
    // A section that ends the file leaves one trailing newline.
    expect(stripOwnedSections(`${fence}\n\n${section}`)).toBe(fence);
  });
});

describe("scrubSecrets", () => {
  test("drops secret-named keys at any depth and token-looking values, reporting both", () => {
    const { value, scrubbed } = scrubSecrets<unknown>({
      keep: "x",
      apiKey: "abc",
      nested: { authToken: "t", ok: 1, headers: { Authorization: "Bearer abc" } },
      list: ["fine", "ghp_abcdef", { password: "p" }],
      url: "https://user:pw@example.com",
    });
    expect(value).toEqual({ keep: "x", nested: { ok: 1, headers: {} }, list: ["fine", {}] });
    expect(scrubbed).toEqual(["apiKey", "nested.authToken", "nested.headers.Authorization", "list[1]", "list[2].password", "url"]);
  });

  test("token LIMITS and `author` are not secrets; auth, auth_*, authorization, authentication are", () => {
    const { value, scrubbed } = scrubSecrets<unknown>({
      env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", MAX_THINKING_TOKENS: "8000", model_max_output_tokens: "1", GITHUB_TOKEN: "x", API_TOKEN_2: "y" },
      author: "me", authored_by: "me",
      auth: { a: 1 }, auth_header: "h", Authorization: "z", authentication: "w", authToken: "t",
    });
    expect(value).toEqual({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", MAX_THINKING_TOKENS: "8000", model_max_output_tokens: "1" }, author: "me", authored_by: "me" });
    expect(scrubbed).toEqual(["env.GITHUB_TOKEN", "env.API_TOKEN_2", "auth", "auth_header", "Authorization", "authentication", "authToken"]);
    const { settings } = transformClaudeSettings({ env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", MAX_THINKING_TOKENS: "8000", BASH_DEFAULT_TIMEOUT_MS: "1" } }, ctx);
    expect(settings.env).toEqual({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", MAX_THINKING_TOKENS: "8000", BASH_DEFAULT_TIMEOUT_MS: "1" });
    expect(transformCodexToml('model_max_output_tokens = 100000\napi_token = "x"\n', ctx)).toEqual({ text: "model_max_output_tokens = 100000\n", scrubbed: ["api_token"] });
  });
});

describe("transformClaudeSettings", () => {
  const laptop = {
    apiKeyHelper: "/Users/ashot/bin/key.sh", awsAuthRefresh: "x", awsCredentialExport: "y", otelHeadersHelper: "z",
    forceLoginMethod: "console", forceLoginOrgUUID: "u", sandbox: { enabled: true },
    enableAllProjectMcpServers: true, enabledMcpjsonServers: ["a"], disabledMcpjsonServers: ["b"],
    includeCoAuthoredBy: false,
    model: "opus",
    enabledPlugins: { "x@y": true },
    permissions: {
      allow: ["Bash(git *)"], deny: ["Read(/Users/ashot/.ssh/**)"],
      additionalDirectories: ["/Users/ashot/notes"], disableBypassPermissionsMode: "disable",
    },
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://proxy", AWS_PROFILE: "p", CLAUDE_CONFIG_DIR: "/Users/ashot/.cc",
      HTTPS_PROXY: "http://p", ANTHROPIC_API_KEY: "sk-ant-x", GITHUB_TOKEN: "ghp_x", CLAUDE_CODE_SKIP_LOGIN: "1",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer x", MY_URL: "https://u:p@h", MY_VAR: "/Users/ashot/data",
      CLAUDECODE: "1", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1",
    },
    statusLine: { type: "command", command: "/Users/ashot/.claude/statusline.sh --short" },
    hooks: {
      SessionStart: [{ matcher: "", hooks: [
        { type: "command", command: "/Users/ashot/.claude/hooks/stable-feed.sh", timeout: 30 },
        { type: "command", command: "/Users/ashot/.claude/hooks/session-register.sh" },
        { type: "command", command: "/Users/ashot/.claude/hooks/my-hook.sh" },
      ] }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "/Users/ashot/.claude/hooks/thread-state.sh" }] }],
      UserPromptSubmit: [{ matcher: "", hooks: [
        { type: "command", command: "/Users/ashot/.claude/hooks/codecast-status.sh" },
        { type: "command", command: "/Users/ashot/.claude/hooks/task-pulse.sh" },
        { type: "command", command: "/Users/ashot/.codecast/hooks/stable-feed-codex.sh" },
      ] }],
      SubagentStop: [{ matcher: "implementer|reviewer|critic", hooks: [{ type: "command", command: "~/.codecast/orchestration/scripts/agent-complete.sh" }] }],
    },
  };

  test("drops auth/routing keys, bypass disabler, denied and secret env; keeps and remaps the rest; drops codecast hooks only", () => {
    const { settings, referencedFiles, scrubbed } = transformClaudeSettings(laptop, ctx);
    for (const k of ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "forceLoginMethod", "forceLoginOrgUUID", "sandbox"]) {
      expect(settings).not.toHaveProperty(k);
    }
    const perms = settings.permissions as Record<string, unknown>;
    expect(perms.disableBypassPermissionsMode).toBeUndefined();
    expect(perms.allow).toEqual(["Bash(git *)"]);
    expect(perms.deny).toEqual(["Read(/home/ubuntu/.ssh/**)"]);
    expect(perms.additionalDirectories).toEqual(["/home/ubuntu/notes"]);
    expect(settings.includeCoAuthoredBy).toBe(false);
    expect(settings.enabledPlugins).toEqual({ "x@y": true });
    expect(settings.model).toBe("opus");
    expect(settings.env).toEqual({ MY_VAR: "/home/ubuntu/data", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" });
    expect(settings.statusLine).toEqual({ type: "command", command: "/home/ubuntu/.claude/statusline.sh --short" });
    expect(referencedFiles).toEqual([".claude/statusline.sh"]);
    expect(settings.hooks).toEqual({
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/home/ubuntu/.claude/hooks/my-hook.sh" }] }],
    });
    expect(scrubbed).toContain("env.CLAUDE_CODE_USE_BEDROCK");
    expect(scrubbed).toContain("env.ANTHROPIC_API_KEY");
    expect(scrubbed).toContain("env.OTEL_EXPORTER_OTLP_HEADERS");
    expect(scrubbed).toContain("env.GITHUB_TOKEN");
    expect(scrubbed).toContain("env.MY_URL");
    expect(scrubbed).toContain("permissions.disableBypassPermissionsMode");
    expect(JSON.stringify(settings)).not.toContain("/Users/ashot");
  });

  test("a laptop with Bedrock env and disableBypassPermissionsMode yields settings that still launch in bypass mode", () => {
    const { settings } = transformClaudeSettings({ env: { CLAUDE_CODE_USE_BEDROCK: "1" }, permissions: { disableBypassPermissionsMode: "disable" } }, ctx);
    expect(settings).toEqual({ env: {}, permissions: {} });
  });
});

describe("TOML", () => {
  const codex = `model = "gpt-5"
api_key = "secret"

[projects."/Users/ashot/src/app"]
trust_level = "trusted"

[mcp_servers.linear]
command = "npx"
args = ["linear-mcp"]

[mcp_servers.linear.env]
LINEAR_API_KEY = "lin_x"

[model_providers.mine]
base_url = "https://api.example.com"
extra_headers = { Authorization = "Bearer abc" }

[model_providers.mine.http_headers]
Authorization = "Bearer abc"
X-Trace = "on"

[features]
hooks = true

[notify]
command = "/Users/ashot/bin/notify.sh"
`;

  test("splitTomlTables round-trips byte for byte", () => {
    expect(joinTomlTables(splitTomlTables(codex))).toBe(codex);
  });

  test("transformCodexToml drops host-owned [projects.*], retains MCP definitions, scrubs secrets, remaps, keeps unknown tables", () => {
    const { text, scrubbed } = transformCodexToml(codex, ctx);
    expect(text).not.toContain("[projects.");
    expect(text).toContain("mcp_servers");
    expect(text).not.toContain("LINEAR_API_KEY");
    expect(text).not.toContain("api_key");
    expect(text).not.toContain("Bearer");
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('base_url = "https://api.example.com"');
    expect(text).toContain('X-Trace = "on"');
    expect(text).toContain("[features]\nhooks = true");
    expect(text).toContain('command = "/home/ubuntu/bin/notify.sh"');
    expect(scrubbed).toContain('[projects."/Users/ashot/src/app"]');
    expect(scrubbed).not.toContain("[mcp_servers.linear]");
    expect(scrubbed).toContain("mcp_servers.linear.env.LINEAR_API_KEY");
    expect(scrubbed).toContain("api_key");
    expect(transformGrokToml).toBe(transformCodexToml);
  });

  test("transformTomlRemap keeps every table and scrubs inside them", () => {
    const { text } = transformTomlRemap(codex, ctx);
    expect(text).toContain("[projects.");
    expect(text).toContain("mcp_servers");
    expect(text).not.toContain("Bearer");
  });
});

describe("JSON kinds", () => {
  test("transformGeminiSettings retains mcpServers and scrubs a nested authToken", () => {
    const { value, scrubbed } = transformGeminiSettings({ theme: "dark", mcpServers: { a: {} }, x: { authToken: "t", path: "/Users/ashot/p" } }, ctx);
    expect(value).toEqual({ theme: "dark", mcpServers: { a: {} }, x: { path: "/home/ubuntu/p" } });
    expect(scrubbed).toEqual(["x.authToken"]);
  });
  test("transformOpencodeJson retains mcp; parseJsonLoose reads JSONC", () => {
    const parsed = parseJsonLoose('{\n  // comment\n  "model": "x", /* c */ "mcp": {"a": 1},\n}');
    const { value } = transformOpencodeJson(parsed, ctx);
    expect(value).toEqual({ model: "x", mcp: { a: 1 } });
  });
  test("transformHooksJson drops codecast entries and remaps the rest", () => {
    const { value } = transformHooksJson({ hooks: { SessionStart: [{ hooks: [
      { type: "command", command: "/Users/ashot/.codecast/hooks/stable-feed-codex.sh" },
      { type: "command", command: "/Users/ashot/bin/mine.sh" },
    ] }] } }, ctx);
    expect(value).toEqual({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "/home/ubuntu/bin/mine.sh" }] }] } });
  });
});

describe("renderGitconfig", () => {
  const pairs = [
    { key: "user.name", value: "Ashot" }, { key: "user.email", value: "a@b.c" }, { key: "user.signingkey", value: "K" },
    { key: "alias.st", value: "status" }, { key: "alias.lg", value: "log --oneline # x" },
    { key: "core.excludesfile", value: "~/.gitignore_global" }, { key: "core.sshcommand", value: "ssh -i k" },
    { key: "pull.rebase", value: "true" }, { key: "push.default", value: "current" }, { key: "push.autosetupremote", value: "true" },
    { key: "init.defaultbranch", value: "main" }, { key: "rerere.enabled", value: "true" },
    { key: "credential.helper", value: "osxkeychain" }, { key: "gpg.format", value: "ssh" }, { key: "commit.gpgsign", value: "true" },
    { key: "url.git@github.com:.insteadof", value: "https://github.com/" }, { key: "include.path", value: "~/.gitconfig.local" },
    { key: "filter.lfs.clean", value: "git-lfs clean -- %f" }, { key: "color.branch.current", value: "yellow" },
  ];
  test("keeps the allowlist, drops identity/credential/gpg/url/include/ssh/lfs, remaps, deterministic", () => {
    const a = renderGitconfig(pairs, ctx);
    const b = renderGitconfig([...pairs].reverse(), ctx);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe([
      "[alias]", '\tlg = "log --oneline # x"', "\tst = status",
      '[color "branch"]', "\tcurrent = yellow",
      "[core]", "\texcludesfile = /home/ubuntu/.gitignore_global",
      "[init]", "\tdefaultbranch = main",
      "[pull]", "\trebase = true",
      "[push]", "\tdefault = current",
      "[rerere]", "\tenabled = true", "",
    ].join("\n"));
    expect(a.referencedFiles).toEqual([".gitignore_global"]);
    for (const k of ["user.name", "user.email", "user.signingkey", "core.sshcommand", "push.autosetupremote", "credential.helper", "gpg.format", "commit.gpgsign", "url.git@github.com:.insteadof", "include.path", "filter.lfs.clean"]) {
      expect(a.dropped).toContain(k);
      expect(gitconfigKeyAllowed(k)).toBe(false);
    }
  });
  test("parseGitConfigList reads the -z --show-origin format", () => {
    expect(parseGitConfigList("file:/h/.gitconfig\0user.name\nA B\0file:/h/.gitconfig\0alias.st\nstatus\0")).toEqual([
      { origin: "file:/h/.gitconfig", key: "user.name", value: "A B" },
      { origin: "file:/h/.gitconfig", key: "alias.st", value: "status" },
    ]);
  });
});

describe("transformByKind: instruction files", () => {
  test("claude-md / agents-md are section-stripped AND home-remapped; portable text kinds are home-remapped too", () => {
    const md = Buffer.from(`# Mine\n\nNotes live in /Users/ashot/notes, never /Users/ashot2.\n${laptopClaudeMd().slice("# My rules\n\nAlways run the tests.\n".length)}`);
    const out = transformByKind("claude-md", md, ctx).bytes.toString();
    expect(out).toContain("Notes live in /home/ubuntu/notes, never /Users/ashot2.");
    expect(out).not.toContain("<!-- /codecast-");
    expect(transformByKind("agents-md", Buffer.from("see /Users/ashot/x\n"), ctx).bytes.toString()).toBe("see /home/ubuntu/x\n");
    expect(transformByKind("verbatim", Buffer.from("see /Users/ashot/x\n"), ctx).bytes.toString()).toBe("see /home/ubuntu/x\n");
  });
});

describe("transformForHost (workspace staging)", () => {
  test("settings get the scrub/remap, codex config the table rules, portable support text remapped, unparseable → null", () => {
    const settings = Buffer.from(JSON.stringify({ env: { ANTHROPIC_API_KEY: "x", P: "/Users/ashot/p" } }));
    expect(JSON.parse(transformForHost(".claude/settings.local.json", settings, ctx)!.toString())).toEqual({ env: { P: "/home/ubuntu/p" } });
    expect(transformForHost(".codex/config.toml", Buffer.from('[mcp_servers.a]\nx = 1\n[features]\nhooks = true\n'), ctx)!.toString()).toBe("[mcp_servers.a]\nx = 1\n[features]\nhooks = true\n");
    const md = Buffer.from("# /Users/ashot stays\n");
    expect(transformForHost("CLAUDE.local.md", md, ctx)!.toString()).toBe("# /home/ubuntu stays\n");
    expect(transformForHost(".claude/settings.json", Buffer.from("{nope"), ctx)).toBeNull();
  });
});
