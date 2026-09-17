import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_AUTH_SOURCES, AGENT_AUTH_WATCH_FILES, agentAuthHostKey, agentAuthWatchDirs, assertNoLaptopPaths, bundleHash, codexAuthHealth,
  collectAgentAuthBundle, describeBundle, filterProviderAuthMap, geminiAuthHealth, grokAuthHealth, jwtPayload, mirrorEnvSkipReason,
  parseClientVersion, planAgentAuthPush, readClaudeSettingsEnvForMirror, readInstalledClientVersions, trustOnlyBundle, type AgentAuthBundle,
} from "./agentAuth";
import { parseAgentAuthReceiverOutput, type RemoteHost } from "./session-move";

const NOW = Date.parse("2026-09-07T12:00:00Z");

function jwt(claims: Record<string, unknown>): string {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  return `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify(claims))}.sig`;
}

/** The host's real ChatGPT-mode blob shape: OPENAI_API_KEY null BESIDE tokens. */
function codexBlob(exp: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: { id_token: jwt({ email: "a@b.c" }), access_token: jwt({ exp }), refresh_token: "rt", account_id: "acc" },
    last_refresh: "2026-09-05T01:20:00.123456Z",
    ...extra,
  });
}

let dir: string, home: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-test-"));
  home = path.join(dir, "home");
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

describe("codexAuthHealth — the live-JWT gate", () => {
  test("a live access token ships, with last_refresh for the host-fresher rule", () => {
    const r = codexAuthHealth(codexBlob(NOW / 1000 + 10 * 86400), NOW);
    expect(r.ship).not.toBeNull();
    expect(r.lastRefresh).toBe(Date.parse("2026-09-05T01:20:00.123456Z"));
  });
  test("an expired access token is 'access token expired' (codex's refresh rotates the refresh token)", () => {
    const r = codexAuthHealth(codexBlob(NOW / 1000 - 60), NOW);
    expect(r.ship).toBeNull();
    expect(r.reason).toBe("access token expired");
  });
  test("an API-key login (no tokens, OPENAI_API_KEY a string) ships", () => {
    const r = codexAuthHealth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x", tokens: null, last_refresh: null }), NOW);
    expect(r.ship).not.toBeNull();
  });
  test("the host-shaped blob (OPENAI_API_KEY null beside tokens) is classified by the JWT, not the key", () => {
    expect(codexAuthHealth(codexBlob(NOW / 1000 + 100), NOW).ship).not.toBeNull();
    expect(codexAuthHealth(codexBlob(NOW / 1000 - 100), NOW).reason).toBe("access token expired");
  });
  test("empty tokens + null key is a logged-out stub; malformed JSON is not pushable", () => {
    expect(codexAuthHealth(JSON.stringify({ OPENAI_API_KEY: null, tokens: {} }), NOW)).toEqual({ ship: null, reason: "logged-out stub" });
    expect(codexAuthHealth("{not json", NOW).ship).toBeNull();
    expect(codexAuthHealth("[]", NOW).reason).toBe("malformed");
    expect(codexAuthHealth(null, NOW).ship).toBeNull();
  });
  test("tokens present but the access token is not a JWT with exp → malformed, never shipped", () => {
    expect(codexAuthHealth(JSON.stringify({ tokens: { access_token: "opaque", refresh_token: "r" } }), NOW).reason).toBe("malformed");
  });
  test("jwtPayload pads base64url like decodeCodexAuth", () => {
    expect(jwtPayload(jwt({ exp: 1, a: "b" }))).toEqual({ exp: 1, a: "b" });
    expect(jwtPayload("nope")).toBeUndefined();
    expect(jwtPayload(42)).toBeUndefined();
  });
});

describe("geminiAuthHealth — refresh_token is the whole test", () => {
  test("ships with a past expiry_date when a refresh_token is present", () => {
    expect(geminiAuthHealth(JSON.stringify({ access_token: "a", refresh_token: "r", expiry_date: NOW - 3600_000 })).ship).not.toBeNull();
  });
  test("refuses without one, and on malformed input", () => {
    expect(geminiAuthHealth(JSON.stringify({ access_token: "a", expiry_date: NOW + 3600_000 })).reason).toBe("no refresh token");
    expect(geminiAuthHealth(JSON.stringify({ refresh_token: "" })).ship).toBeNull();
    expect(geminiAuthHealth("x").reason).toBe("malformed");
  });
});

describe("grokAuthHealth — a scope-keyed map with no expiry", () => {
  test("ships xAI's documented shape", () => {
    expect(grokAuthHealth(JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "t" } }), NOW).ship).not.toBeNull();
  });
  test("refuses {} and empty keys", () => {
    expect(grokAuthHealth("{}", NOW).reason).toBe("no key");
    expect(grokAuthHealth(JSON.stringify({ a: { key: "" } }), NOW).ship).toBeNull();
    expect(grokAuthHealth(JSON.stringify({ a: "t" }), NOW).ship).toBeNull();
  });
  test("honors expires_at / expires in seconds or ms when an entry carries one", () => {
    expect(grokAuthHealth(JSON.stringify({ a: { key: "t", expires_at: NOW / 1000 - 1 } }), NOW).reason).toBe("every key expired");
    expect(grokAuthHealth(JSON.stringify({ a: { key: "t", expires_at: NOW - 1 } }), NOW).ship).toBeNull();
    expect(grokAuthHealth(JSON.stringify({ a: { key: "t", expires: NOW / 1000 + 100 } }), NOW).ship).not.toBeNull();
    expect(grokAuthHealth(JSON.stringify({ a: { key: "t", expires: NOW + 100 } }), NOW).ship).not.toBeNull();
    // One expired scope beside a live one: still ships (the live scope carries the file).
    expect(grokAuthHealth(JSON.stringify({ a: { key: "t", expires: NOW - 1 }, b: { key: "u" } }), NOW).ship).not.toBeNull();
  });
});

describe("filterProviderAuthMap — opencode / pi", () => {
  test("drops expired oauth entries, keeps api/api_key/wellknown, returns null when nothing remains", () => {
    const raw = JSON.stringify({
      anthropic: { type: "oauth", refresh: "r", access: "a", expires: NOW - 1 },
      openai: { type: "api", key: "sk" },
      google: { type: "api_key", key: "k" },
      corp: { type: "wellknown", key: "w", token: "t" },
      github: { type: "oauth", refresh: "r", access: "a", expires: NOW + 1000 },
    });
    const r = filterProviderAuthMap(raw, NOW);
    const kept = JSON.parse(r.ship!);
    expect(Object.keys(kept).sort()).toEqual(["corp", "github", "google", "openai"]);
    expect(filterProviderAuthMap(JSON.stringify({ a: { type: "oauth", expires: NOW - 1 } }), NOW)).toEqual({ ship: null, reason: "every entry expired" });
    expect(filterProviderAuthMap("{}", NOW).ship).toBeNull();
    expect(filterProviderAuthMap("nope", NOW).reason).toBe("malformed");
  });
});

describe("readClaudeSettingsEnvForMirror — the provider-key allow-list", () => {
  test("provider keys pass; auth routing, proxies, config dirs, codecast vars and bad values are skipped with reasons", () => {
    write(".claude/settings.json", JSON.stringify({
      env: {
        OPENROUTER_API_KEY: "sk-or-1", GEMINI_API_KEY: "AIza", XAI_API_KEY: "xai-1", CUSTOM_API_KEY: "c",
        ANTHROPIC_API_KEY: "sk-ant", ANTHROPIC_BASE_URL: "https://x", HTTPS_PROXY: "http://p", CLAUDE_CONFIG_DIR: "/x",
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1",
        LOCAL_API_KEY: "http://localhost:1", LOOP_API_KEY: "http://127.0.0.1:1", PATHY_API_KEY: "/usr/x", HOMEY_API_KEY: `${home}/k`,
        MAX_THINKING_TOKENS: "1", NUM_API_KEY: 5 as unknown as string,
      },
      hooks: {},
    }));
    const r = readClaudeSettingsEnvForMirror(home);
    expect(r.env).toEqual({ OPENROUTER_API_KEY: "sk-or-1", GEMINI_API_KEY: "AIza", XAI_API_KEY: "xai-1", CUSTOM_API_KEY: "c" });
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.key, s.reason]));
    expect(reasons.ANTHROPIC_API_KEY).toMatch(/never mirrored/);
    expect(reasons.ANTHROPIC_BASE_URL).toBe("routing");
    expect(reasons.HTTPS_PROXY).toBe("proxy");
    expect(reasons.CLAUDE_CONFIG_DIR).toBe("laptop path");
    expect(reasons.CLAUDE_CODE_FORCE_SESSION_PERSISTENCE).toBe("codecast-owned");
    expect(reasons.CLAUDECODE).toBe("codecast-owned");
    expect(reasons.CLAUDE_CODE_CHILD_SESSION).toBe("codecast-owned");
    expect(reasons.LOCAL_API_KEY).toBe("loopback");
    expect(reasons.LOOP_API_KEY).toBe("loopback");
    expect(reasons.PATHY_API_KEY).toBe("a path");
    expect(reasons.HOMEY_API_KEY).toBe("contains the laptop home");
    expect(reasons.MAX_THINKING_TOKENS).toBe("not a provider key");
    expect(reasons.NUM_API_KEY).toBe("not a string");
  });
  test("{} for an absent or unparseable settings.json, or one without env", () => {
    expect(readClaudeSettingsEnvForMirror(home)).toEqual({ env: {}, skipped: [] });
    write(".claude/settings.json", "{broken");
    expect(readClaudeSettingsEnvForMirror(home)).toEqual({ env: {}, skipped: [] });
    write(".claude/settings.json", JSON.stringify({ hooks: {} }));
    expect(readClaudeSettingsEnvForMirror(home)).toEqual({ env: {}, skipped: [] });
  });
  test("mirrorEnvSkipReason: ANTHROPIC_API_KEY is refused before any value check, a proxy under any spelling too", () => {
    expect(mirrorEnvSkipReason("ANTHROPIC_API_KEY", "x", home)).toMatch(/never/);
    expect(mirrorEnvSkipReason("http_proxy_API_KEY", "x", home)).toBe("proxy");
    expect(mirrorEnvSkipReason("OPENAI_API_KEY", "sk-1", home)).toBeNull();
  });
});

describe("collectAgentAuthBundle — a fake HOME", () => {
  const live = () => codexBlob(NOW / 1000 + 86400);
  test("missing sources land in absent; present-and-live in files with mode 0o600 and ~/-relative paths; gated ones are skipped", () => {
    write(".codex/auth.json", live());
    write(".grok/auth.json", JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "t" } }));
    write(".gemini/oauth_creds.json", JSON.stringify({ access_token: "a" })); // no refresh token → skipped
    write(".gemini/google_accounts.json", JSON.stringify({ active: "a@b.c" }));
    write(".claude/settings.json", JSON.stringify({ env: { OPENROUTER_API_KEY: "sk-or", ANTHROPIC_API_KEY: "no" } }));
    const { bundle, skipped, envSkipped } = collectAgentAuthBundle({ home, env: {}, now: NOW, userId: "u1", deviceId: "d1", codexTrustPaths: ["/home/ubuntu/work/r"] });
    expect(bundle.files.map((f) => f.path).sort()).toEqual(["~/.codex/auth.json", "~/.grok/auth.json"]);
    expect(bundle.files.every((f) => f.mode === 0o600)).toBe(true);
    expect(bundle.files.find((f) => f.path === "~/.codex/auth.json")?.last_refresh).toBe(Date.parse("2026-09-05T01:20:00.123456Z"));
    expect(bundle.absent.sort()).toEqual(["~/.local/share/opencode/auth.json", "~/.pi/agent/auth.json"]);
    expect(skipped).toEqual([{ id: "gemini", reason: "no refresh token" }, { id: "gemini-accounts", reason: "gemini not shipped" }]);
    expect(bundle.claudeEnv).toEqual({ OPENROUTER_API_KEY: "sk-or" });
    expect(envSkipped.map((e) => e.key)).toEqual(["ANTHROPIC_API_KEY"]);
    expect(bundle.codexTrustPaths).toEqual(["/home/ubuntu/work/r"]);
    expect(bundle.origin).toEqual({ user_id: "u1", device_id: "d1", pushed_at: new Date(NOW).toISOString() });
    expect(describeBundle(bundle)).toBe("codex, grok, 1 env key, trust 1");
  });
  test("google_accounts.json rides along only with live gemini creds", () => {
    write(".gemini/oauth_creds.json", JSON.stringify({ refresh_token: "r", expiry_date: 1 }));
    write(".gemini/google_accounts.json", "{}");
    const { bundle } = collectAgentAuthBundle({ home, env: {}, now: NOW, userId: "u", deviceId: "d" });
    expect(bundle.files.map((f) => f.path).sort()).toEqual(["~/.gemini/google_accounts.json", "~/.gemini/oauth_creds.json"]);
  });
  test("opencode resolves XDG_DATA_HOME locally but maps to ~/.local/share/opencode/auth.json remotely; CODEX_HOME likewise", () => {
    const xdg = path.join(dir, "xdg");
    fs.mkdirSync(path.join(xdg, "opencode"), { recursive: true });
    fs.writeFileSync(path.join(xdg, "opencode", "auth.json"), JSON.stringify({ openai: { type: "api", key: "k" } }));
    const codexHome = path.join(dir, "codex-elsewhere");
    fs.mkdirSync(codexHome);
    fs.writeFileSync(path.join(codexHome, "auth.json"), live());
    const { bundle } = collectAgentAuthBundle({ home, env: { XDG_DATA_HOME: xdg, CODEX_HOME: codexHome }, now: NOW, userId: "u", deviceId: "d" });
    expect(bundle.files.map((f) => f.path).sort()).toEqual(["~/.codex/auth.json", "~/.local/share/opencode/auth.json"]);
    expect(JSON.parse(bundle.files.find((f) => f.path.endsWith("opencode/auth.json"))!.content)).toEqual({ openai: { type: "api", key: "k" } });
  });
  test("a symlinked source is read through (dotfile-managed logins); a non-regular one is skipped, never absent", () => {
    fs.mkdirSync(path.join(home, ".grok"));
    fs.writeFileSync(path.join(dir, "grok-auth.json"), JSON.stringify({ "https://api.x.ai": { key: "k" } }));
    fs.symlinkSync(path.join(dir, "grok-auth.json"), path.join(home, ".grok", "auth.json"));
    fs.mkdirSync(path.join(home, ".gemini", "oauth_creds.json"), { recursive: true });
    const { bundle, skipped } = collectAgentAuthBundle({ home, env: {}, now: NOW, userId: "u", deviceId: "d" });
    expect(bundle.files.map((f) => f.path)).toContain("~/.grok/auth.json");
    expect(bundle.absent).not.toContain("~/.gemini/oauth_creds.json");
    expect(skipped).toContainEqual({ id: "gemini", reason: "not a regular file" });
  });
  test("a trust-only bundle has no claudeEnv key", () => {
    const b = trustOnlyBundle({ userId: "u", deviceId: "d" }, ["/home/ubuntu/work/x"], NOW);
    expect("claudeEnv" in b).toBe(false);
    expect(b.files).toEqual([]);
    expect(b.codexTrustPaths).toEqual(["/home/ubuntu/work/x"]);
    expect(collectAgentAuthBundle({ home, env: {}, now: NOW, userId: "u", deviceId: "d", withClaudeEnv: false }).bundle.claudeEnv).toBeUndefined();
  });
});

describe("bundleHash and assertNoLaptopPaths", () => {
  const base = (): AgentAuthBundle => ({
    origin: { user_id: "u", device_id: "d", pushed_at: "2026-01-01T00:00:00Z" },
    files: [{ path: "~/.codex/auth.json", content: "{}", mode: 0o600, last_refresh: 1 }],
    absent: ["~/.pi/agent/auth.json"],
    claudeEnv: { A_API_KEY: "1" },
    codexTrustPaths: ["/home/ubuntu/work/r"],
  });
  test("stable across pushed_at and ordering; changes on any content or on codex last_refresh", () => {
    const a = base();
    const b = { ...base(), origin: { ...base().origin, pushed_at: "2027-01-01T00:00:00Z" } };
    expect(bundleHash(a)).toBe(bundleHash(b));
    const c = base(); c.files[0].content = "{ }";
    expect(bundleHash(c)).not.toBe(bundleHash(a));
    const d = base(); d.files[0].last_refresh = 2;
    expect(bundleHash(d)).not.toBe(bundleHash(a));
    const e = base(); e.claudeEnv = { A_API_KEY: "2" };
    expect(bundleHash(e)).not.toBe(bundleHash(a));
    const f = base(); f.codexTrustPaths = ["/home/ubuntu/work/other"];
    expect(bundleHash(f)).not.toBe(bundleHash(a));
    const g = base(); g.absent = [];
    expect(bundleHash(g)).not.toBe(bundleHash(a));
  });
  test("assertNoLaptopPaths throws on an env value or a file body containing HOME, not on a host trust path", () => {
    const a = base();
    expect(() => assertNoLaptopPaths(a, "/Users/alice")).not.toThrow();
    a.claudeEnv = { A_API_KEY: "/Users/alice/key" };
    expect(() => assertNoLaptopPaths(a, "/Users/alice")).toThrow(/A_API_KEY/);
    const b = base(); b.files[0].content = '{"dir":"/Users/alice/.codex"}';
    expect(() => assertNoLaptopPaths(b, "/Users/alice")).toThrow(/auth\.json/);
    // A Linux laptop sharing the host's home layout: the trust path is a host path.
    const c = base();
    expect(() => assertNoLaptopPaths(c, "/home/ubuntu")).not.toThrow();
  });
});

describe("planAgentAuthPush — per-host hash gate", () => {
  const h = (address: string): RemoteHost => ({ address, user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work" });
  test("onlyIfChanged selects only hosts whose recorded hash differs; a host absent from the map is selected", () => {
    const last = new Map([["ubuntu@1.1.1.1", "h1"], ["ubuntu@2.2.2.2", "h0"]]);
    const picked = planAgentAuthPush([h("1.1.1.1"), h("2.2.2.2"), h("3.3.3.3")], "h1", last, { onlyIfChanged: true });
    expect(picked.map((x) => x.address)).toEqual(["2.2.2.2", "3.3.3.3"]);
  });
  test("a periodic (unconditional) call selects all", () => {
    const last = new Map([["ubuntu@1.1.1.1", "h1"]]);
    expect(planAgentAuthPush([h("1.1.1.1"), h("2.2.2.2")], "h1", last).map((x) => x.address)).toEqual(["1.1.1.1", "2.2.2.2"]);
  });
  test("keyed by user@address, so a host back on a new address is pushed", () => {
    const last = new Map([["ubuntu@1.1.1.1", "h1"]]);
    expect(planAgentAuthPush([h("9.9.9.9")], "h1", last, { onlyIfChanged: true })).toHaveLength(1);
    expect(agentAuthHostKey(h("9.9.9.9"))).toBe("ubuntu@9.9.9.9");
  });
});

describe("watch set", () => {
  test("every source directory plus ~/.claude, filtered to the exact filenames", () => {
    const dirs = agentAuthWatchDirs("/Users/a", { XDG_DATA_HOME: "/Users/a/xdg" });
    expect(dirs).toContain("/Users/a/.codex");
    expect(dirs).toContain("/Users/a/.grok");
    expect(dirs).toContain("/Users/a/.gemini");
    expect(dirs).toContain("/Users/a/.pi/agent");
    expect(dirs).toContain("/Users/a/xdg/opencode");
    expect(dirs).toContain("/Users/a/.claude");
    expect([...AGENT_AUTH_WATCH_FILES].sort()).toEqual(["auth.json", "google_accounts.json", "oauth_creds.json", "settings.json"]);
    expect(AGENT_AUTH_SOURCES.map((s) => s.id)).toEqual(["codex", "grok", "gemini", "gemini-accounts", "opencode", "pi"]);
  });
});

describe("readInstalledClientVersions — a fake PATH of stubs", () => {
  test("parses '2.1.263 (Claude Code)' and 'codex-cli 0.153.4'; a binary not on PATH is undefined", () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho '2.1.263 (Claude Code)'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho 'codex-cli 0.153.4'\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "grok"), "#!/bin/sh\necho 'no version here'\n", { mode: 0o755 });
    const v = readInstalledClientVersions({ path: `${bin}:/usr/bin:/bin` });
    expect(v).toEqual({ claude: "2.1.263", codex: "0.153.4" });
    expect(v.gemini).toBeUndefined();
    expect(parseClientVersion("gemini 0.58.0\n")).toBe("0.58.0");
    expect(parseClientVersion("")).toBeUndefined();
  });
});

describe("parseAgentAuthReceiverOutput — the wire contract", () => {
  test("the applied line, with kept tokens de-spaced on the wire", () => {
    const r = parseAgentAuthReceiverOutput("error:~/.pi/agent/auth.json:unsafe destination file\napplied files=2 kept=codex:host-fresher deleted=1 env=OPENROUTER_API_KEY,XAI_API_KEY trust=1\n", 0);
    expect(r).toEqual({ pushed: true, kept: ["codex host-fresher"], files: 2, deleted: 1, env: ["OPENROUTER_API_KEY", "XAI_API_KEY"], trust: 1, errors: ["~/.pi/agent/auth.json:unsafe destination file"] });
    expect(parseAgentAuthReceiverOutput("applied files=0 kept= deleted=0 env= trust=0\n", 0)).toEqual({ pushed: true, kept: [], files: 0, deleted: 0, env: [], trust: 0 });
  });
  test("exit 3 is the other-user refusal; other failures carry the last stderr line; a missing python3 is named", () => {
    expect(parseAgentAuthReceiverOutput("refused:other-user\n", 3).reason).toBe("host holds another user's logins");
    expect(parseAgentAuthReceiverOutput("", 1, "Traceback\nKeyError: x\n").reason).toBe("receiver exited 1: KeyError: x");
    expect(parseAgentAuthReceiverOutput("", 127, "bash: python3: command not found\n").reason).toBe("python3 missing on the host");
    expect(parseAgentAuthReceiverOutput("applied files=0 kept= deleted=0 env= trust=0\nsettings:unparseable\n", 0).unparseableSettings).toBe(true);
  });
});
