import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_AUTH_RECEIVER } from "./agentAuthReceiver.py";
import { parseAgentAuthReceiverOutput, shq } from "./session-move";
import type { AgentAuthBundle } from "./agentAuth";

const python3 = spawnSync("python3", ["--version"], { encoding: "utf-8" }).status === 0;
const d = python3 ? describe : describe.skip;

let dir: string, home: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-auth-receiver-")));
  home = path.join(dir, "home");
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function config(userId: string): void {
  fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ user_id: userId, auth_token: "t" }), { mode: 0o600 });
}

/** Run the receiver exactly as ssh would, against the temp HOME. */
function run(bundle: Partial<AgentAuthBundle> & Record<string, unknown>) {
  const full = { origin: { user_id: "U", device_id: "D", pushed_at: "2026-09-07T12:00:00Z" }, files: [], absent: [], codexTrustPaths: [], ...bundle };
  const r = spawnSync("/bin/sh", ["-c", "umask 077; python3 -c \"$0\"", AGENT_AUTH_RECEIVER], {
    input: JSON.stringify(full), encoding: "utf-8",
    env: { ...process.env, HOME: home, CAST_MIRROR_LOCK_WAIT: "2" },
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", outcome: parseAgentAuthReceiverOutput(r.stdout ?? "", r.status, r.stderr ?? "") };
}

function mode(rel: string): number {
  return fs.statSync(path.join(home, rel)).mode & 0o777;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(home, rel), "utf-8");
}

const file = (p: string, content: string, last_refresh?: number) => ({ path: p, content, mode: 0o600, ...(last_refresh !== undefined ? { last_refresh } : {}) });

d("agent auth receiver (python3) against a temp HOME", () => {
  test("files are created 0600 in 0700 dirs; the stamp is written; the last line reports counts", () => {
    config("U");
    const r = run({ files: [file("~/.codex/auth.json", '{"a":1}'), file("~/.local/share/opencode/auth.json", "{}")] });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.outcome).toMatchObject({ pushed: true, files: 2, deleted: 0, kept: [], trust: 0 });
    expect(read(".codex/auth.json")).toBe('{"a":1}');
    expect(mode(".codex/auth.json")).toBe(0o600);
    expect(mode(".codex")).toBe(0o700);
    expect(mode(".local/share/opencode")).toBe(0o700);
    expect(mode(".local/share/opencode/auth.json")).toBe(0o600);
    const stamp = JSON.parse(read(".codecast/agent-auth-origin.json"));
    expect(stamp).toEqual({ user_id: "U", device_id: "D", pushed_at: "2026-09-07T12:00:00Z", files: { "~/.codex/auth.json": "D", "~/.local/share/opencode/auth.json": "D" } });
    expect(mode(".codecast/agent-auth-origin.json")).toBe(0o600);
    expect(fs.existsSync(path.join(home, ".codecast", "mirror.lock"))).toBe(false);
  });

  test("a symlinked destination is refused (reported, the rest applied); an unsafe path too", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".grok"));
    fs.symlinkSync(path.join(dir, "elsewhere"), path.join(home, ".grok", "auth.json"));
    fs.mkdirSync(path.join(home, ".pi"));
    fs.symlinkSync(path.join(dir, "elsewhere-dir"), path.join(home, ".pi", "agent"));
    const r = run({ files: [file("~/.grok/auth.json", "x"), file("~/.pi/agent/auth.json", "y"), file("~/../escape", "z"), file("~/.codex/auth.json", "ok")] });
    expect(r.status).toBe(0);
    expect(r.outcome.files).toBe(1);
    expect(r.outcome.errors).toHaveLength(3);
    expect(r.outcome.errors!.some((e) => e.startsWith("~/.grok/auth.json:"))).toBe(true);
    expect(r.outcome.errors!.some((e) => e.startsWith("~/.pi/agent/auth.json:"))).toBe(true);
    expect(r.outcome.errors!.some((e) => e.startsWith("~/../escape:"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "elsewhere"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "elsewhere-dir"))).toBe(false);
    expect(read(".codex/auth.json")).toBe("ok");
  });

  test("absent removes only what this device pushed, plus the codex-accounts snapshots", () => {
    config("U");
    expect(run({ files: [file("~/.codex/auth.json", "mine", 5), file("~/.grok/auth.json", "{}")] }).outcome.files).toBe(2);
    fs.mkdirSync(path.join(home, ".codecast", "codex-accounts", "ashot"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codecast", "codex-accounts", "ashot", "auth.json"), "snap");
    fs.writeFileSync(path.join(home, ".codecast", "codex-accounts.json"), "{}");
    fs.writeFileSync(path.join(home, ".codecast", "codex-usage-accounts.json"), "{}");
    const r = run({ absent: ["~/.codex/auth.json", "~/.grok/auth.json", "~/.gemini/oauth_creds.json"] });
    expect(r.status).toBe(0);
    expect(r.outcome.deleted).toBe(2);
    expect(fs.existsSync(path.join(home, ".codex", "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".grok", "auth.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codecast", "codex-accounts"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codecast", "codex-accounts.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codecast", "codex-usage-accounts.json"))).toBe(false);
    expect(JSON.parse(read(".codecast/agent-auth-origin.json")).files).toEqual({});
  });

  test("a second device of the same user never deletes the first device's files, and a host-local login is never deleted", () => {
    config("U");
    // Device D pushes codex; a login made on the host itself (no stamp entry) sits beside it.
    expect(run({ files: [file("~/.codex/auth.json", "from-D", 5)] }).outcome.files).toBe(1);
    fs.mkdirSync(path.join(home, ".grok"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".grok", "auth.json"), "host-local");
    // Device E has neither: its push carries both as absent.
    const e = run({ origin: { user_id: "U", device_id: "E", pushed_at: "2026-09-07T13:00:00Z" }, files: [file("~/.gemini/oauth_creds.json", "from-E")], absent: ["~/.codex/auth.json", "~/.grok/auth.json"] });
    expect(e.status).toBe(0);
    expect(e.outcome.deleted).toBe(0);
    expect(read(".codex/auth.json")).toBe("from-D");
    expect(read(".grok/auth.json")).toBe("host-local");
    // The stamp keeps D's entry beside E's own.
    expect(JSON.parse(read(".codecast/agent-auth-origin.json"))).toMatchObject({ device_id: "E", files: { "~/.codex/auth.json": "D", "~/.gemini/oauth_creds.json": "E" } });
    // D's own logout (its file gone) removes D's copy; E's file stays.
    const d2 = run({ absent: ["~/.codex/auth.json", "~/.gemini/oauth_creds.json"] });
    expect(d2.outcome.deleted).toBe(1);
    expect(fs.existsSync(path.join(home, ".codex", "auth.json"))).toBe(false);
    expect(read(".gemini/oauth_creds.json")).toBe("from-E");
    // An older list-shaped stamp counts as owned by its device.
    fs.writeFileSync(path.join(home, ".codecast", "agent-auth-origin.json"), JSON.stringify({ user_id: "U", device_id: "D", files: ["~/.gemini/oauth_creds.json"] }));
    expect(run({ absent: ["~/.gemini/oauth_creds.json"] }).outcome.deleted).toBe(1);
  });

  test("the snapshots go when codex auth is carried too; other harnesses leave them alone", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".codecast", "codex-accounts"), { recursive: true });
    run({ files: [file("~/.grok/auth.json", "{}")] });
    expect(fs.existsSync(path.join(home, ".codecast", "codex-accounts"))).toBe(true);
    run({ files: [file("~/.codex/auth.json", "{}", 5)] });
    expect(fs.existsSync(path.join(home, ".codecast", "codex-accounts"))).toBe(false);
  });

  test("a host ~/.codex/auth.json with a NEWER last_refresh is kept and reported; an older one is replaced", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "host" }, last_refresh: "2026-09-07T10:00:00.500000Z" }));
    fs.mkdirSync(path.join(home, ".codecast", "codex-accounts"), { recursive: true });
    const older = run({ files: [file("~/.codex/auth.json", '{"laptop":1}', Date.parse("2026-09-07T09:00:00Z"))] });
    expect(older.outcome.kept).toEqual(["codex host-fresher"]);
    expect(older.outcome.files).toBe(0);
    expect(JSON.parse(read(".codex/auth.json")).tokens.access_token).toBe("host");
    // A kept blob is untouched, so its snapshots are too.
    expect(fs.existsSync(path.join(home, ".codecast", "codex-accounts"))).toBe(true);
    const newer = run({ files: [file("~/.codex/auth.json", '{"laptop":2}', Date.parse("2026-09-07T11:00:00Z"))] });
    expect(newer.outcome.kept).toEqual([]);
    expect(newer.outcome.files).toBe(1);
    expect(read(".codex/auth.json")).toBe('{"laptop":2}');
  });

  test("a host blob with an offset last_refresh compares in UTC; an unparseable one never wins", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
    // 12:00+02:00 = 10:00Z, older than the bundle's 11:00Z → replaced.
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ last_refresh: "2026-09-07T12:00:00+02:00" }));
    expect(run({ files: [file("~/.codex/auth.json", "new", Date.parse("2026-09-07T11:00:00Z"))] }).outcome.files).toBe(1);
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ last_refresh: "yesterday" }));
    expect(run({ files: [file("~/.codex/auth.json", "new2", 1)] }).outcome.files).toBe(1);
    expect(read(".codex/auth.json")).toBe("new2");
  });

  test("settings.json env merged: hooks preserved, indent preserved, chmod 0600, manifest written; a rerun with fewer keys removes only manifest keys", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".claude"));
    const settings = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "x" }] }] }, env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", MY_OWN_API_KEY: "mine" } }, null, 2) + "\n", { mode: 0o664 });
    const r1 = run({ claudeEnv: { OPENROUTER_API_KEY: "sk-or", XAI_API_KEY: "xai" } });
    expect(r1.status).toBe(0);
    expect(r1.outcome.env).toEqual(["OPENROUTER_API_KEY", "XAI_API_KEY"]);
    const text = read(".claude/settings.json");
    expect(text.startsWith('{\n  "hooks"')).toBe(true); // 2-space indent kept
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.hooks.PreToolUse[0].hooks[0].command).toBe("x");
    expect(parsed.env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", MY_OWN_API_KEY: "mine", OPENROUTER_API_KEY: "sk-or", XAI_API_KEY: "xai" });
    expect(mode(".claude/settings.json")).toBe(0o600);
    expect(JSON.parse(read(".codecast/mirrored-claude-env.json"))).toEqual(["OPENROUTER_API_KEY", "XAI_API_KEY"]);
    expect(mode(".codecast/mirrored-claude-env.json")).toBe(0o600);
    // Second run: XAI dropped on the laptop → removed here; the user's own key stays.
    const r2 = run({ claudeEnv: { OPENROUTER_API_KEY: "sk-or" } });
    expect(r2.outcome.env).toEqual(["OPENROUTER_API_KEY"]);
    expect(JSON.parse(read(".claude/settings.json")).env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", MY_OWN_API_KEY: "mine", OPENROUTER_API_KEY: "sk-or" });
    expect(JSON.parse(read(".codecast/mirrored-claude-env.json"))).toEqual(["OPENROUTER_API_KEY"]);
    // Third run: nothing mirrored → the manifest empties, the user key remains.
    const r3 = run({ claudeEnv: {} });
    expect(r3.outcome.env).toEqual([]);
    expect(JSON.parse(read(".claude/settings.json")).env).toEqual({ CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1", MY_OWN_API_KEY: "mine" });
    expect(JSON.parse(read(".codecast/mirrored-claude-env.json"))).toEqual([]);
  });

  test("a missing settings.json is created (4-space, like installStableHook); an unparseable one is left alone and reported", () => {
    config("U");
    const r = run({ claudeEnv: { OPENROUTER_API_KEY: "k" } });
    expect(r.outcome.env).toEqual(["OPENROUTER_API_KEY"]);
    expect(read(".claude/settings.json")).toBe('{\n    "env": {\n        "OPENROUTER_API_KEY": "k"\n    }\n}');
    expect(mode(".claude/settings.json")).toBe(0o600);
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{broken");
    const bad = run({ claudeEnv: { OPENROUTER_API_KEY: "k2" } });
    expect(bad.status).toBe(0);
    expect(bad.outcome.unparseableSettings).toBe(true);
    expect(read(".claude/settings.json")).toBe("{broken");
  });

  test("an empty claudeEnv with no settings.json and no manifest creates nothing", () => {
    config("U");
    run({ claudeEnv: {} });
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("config.toml gains exactly one trust table per path; a rerun adds none; quotes and backslashes are escaped", () => {
    config("U");
    const paths = ["/home/ubuntu/work/codecast", '/home/ubuntu/work/we"ird\\path'];
    const r1 = run({ codexTrustPaths: paths });
    expect(r1.outcome.trust).toBe(2);
    const toml = read(".codex/config.toml");
    expect(toml).toContain('[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n');
    expect(toml).toContain('[projects."/home/ubuntu/work/we\\"ird\\\\path"]\ntrust_level = "trusted"\n');
    expect(mode(".codex")).toBe(0o700);
    const r2 = run({ codexTrustPaths: paths });
    expect(r2.outcome.trust).toBe(0);
    expect(read(".codex/config.toml")).toBe(toml);
    // An existing config.toml without a trailing newline is appended to cleanly; a relative path is refused.
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5"\n[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"');
    const r3 = run({ codexTrustPaths: ["/home/ubuntu/work/codecast", "/home/ubuntu/work/other", "relative"] });
    expect(r3.outcome.trust).toBe(1);
    expect(r3.outcome.errors).toEqual(["trust:'relative':unsafe path"]);
    expect(read(".codex/config.toml")).toBe('model = "gpt-5"\n[projects."/home/ubuntu/work/codecast"]\ntrust_level = "trusted"\n\n[projects."/home/ubuntu/work/other"]\ntrust_level = "trusted"\n');
  });

  test("a trust-only bundle writes no stamp and does not touch settings.json", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"env":{"A":"1"}}');
    const r = run({ codexTrustPaths: ["/home/ubuntu/work/moved"] });
    expect(r.outcome.trust).toBe(1);
    expect(fs.existsSync(path.join(home, ".codecast", "agent-auth-origin.json"))).toBe(false);
    expect(read(".claude/settings.json")).toBe('{"env":{"A":"1"}}');
    expect(fs.existsSync(path.join(home, ".codecast", "mirrored-claude-env.json"))).toBe(false);
  });

  test("a bundle whose origin.user_id ≠ config.json user_id exits 3 and changes nothing", () => {
    config("SOMEONE-ELSE");
    const r = run({ files: [file("~/.codex/auth.json", "x")], claudeEnv: { OPENROUTER_API_KEY: "k" }, codexTrustPaths: ["/home/ubuntu/work/r"] });
    expect(r.status).toBe(3);
    expect(r.outcome).toEqual({ pushed: false, kept: [], reason: "host holds another user's logins" });
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codecast", "agent-auth-origin.json"))).toBe(false);
  });

  test("with no config.json user_id the stamp decides: the first pusher writes it, a different user is refused, the same user is not", () => {
    fs.writeFileSync(path.join(home, ".codecast", "config.json"), JSON.stringify({ auth_token: "t" }));
    expect(run({ files: [file("~/.codex/auth.json", "x")] }).status).toBe(0);
    expect(JSON.parse(read(".codecast/agent-auth-origin.json")).user_id).toBe("U");
    const other = run({ origin: { user_id: "V", device_id: "D2", pushed_at: "2026-09-07T13:00:00Z" }, files: [file("~/.codex/auth.json", "theirs")] });
    expect(other.status).toBe(3);
    expect(read(".codex/auth.json")).toBe("x");
    expect(run({ files: [file("~/.codex/auth.json", "y")] }).status).toBe(0);
    expect(read(".codex/auth.json")).toBe("y");
    // No config.json at all: same rule.
    fs.unlinkSync(path.join(home, ".codecast", "config.json"));
    expect(run({ origin: { user_id: "V", device_id: "D2", pushed_at: "z" }, files: [] }).status).toBe(3);
  });

  test("the mirror lock: a live holder makes the receiver wait and fail closed; a dead holder's lock is broken", () => {
    config("U");
    const lock = path.join(home, ".codecast", "mirror.lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "t", at: "now" }));
    const held = run({ files: [file("~/.codex/auth.json", "x")] });
    expect(held.status).toBe(1);
    expect(held.stdout).toContain("error:lock:");
    expect(fs.existsSync(path.join(home, ".codex", "auth.json"))).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483000, token: "t", at: "now" }));
    const broken = run({ files: [file("~/.codex/auth.json", "x")] });
    expect(broken.status).toBe(0);
    expect(read(".codex/auth.json")).toBe("x");
    expect(fs.existsSync(lock)).toBe(false);
  });

  test("a symlinked settings.json is refused in the env step: the files before it stay applied and the applied line is printed", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".claude"), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "real.json"), "{}");
    fs.symlinkSync(path.join(dir, "real.json"), path.join(home, ".claude", "settings.json"));
    const r = run({ files: [file("~/.grok/auth.json", "{}")], claudeEnv: { OPENAI_API_KEY: "k" } });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.outcome).toMatchObject({ pushed: true, files: 1, env: [] });
    expect(r.outcome.errors!.some((e) => e.startsWith("settings.json:"))).toBe(true);
    expect(read(".grok/auth.json")).toBe("{}");
    expect(fs.readFileSync(path.join(dir, "real.json"), "utf-8")).toBe("{}");
    expect(JSON.parse(read(".codecast/agent-auth-origin.json")).files).toEqual({ "~/.grok/auth.json": "D" });
  });

  test("a failure that escapes a step still prints the collected error lines and a receiver line, exit 1", () => {
    config("U");
    fs.mkdirSync(path.join(home, ".grok"));
    fs.symlinkSync(path.join(dir, "x"), path.join(home, ".grok", "auth.json"));
    const full = { origin: { user_id: "U", device_id: "D", pushed_at: "z" }, files: [file("~/.grok/auth.json", "{}")], absent: [], codexTrustPaths: [] };
    // An exception raised between the steps (outside every per-step try).
    const script = AGENT_AUTH_RECEIVER.replace("        # 5. trust\n", '        raise RuntimeError("boom")\n        # 5. trust\n');
    expect(script).not.toBe(AGENT_AUTH_RECEIVER);
    const r = spawnSync("/bin/sh", ["-c", "umask 077; python3 -c \"$0\"", script], {
      input: JSON.stringify(full), encoding: "utf-8", env: { ...process.env, HOME: home, CAST_MIRROR_LOCK_WAIT: "2" }, timeout: 30_000,
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error:~/.grok/auth.json:");
    expect(r.stdout).toContain("error:receiver:RuntimeError: boom");
    expect(parseAgentAuthReceiverOutput(r.stdout, r.status, r.stderr)).toMatchObject({ pushed: false, reason: "receiver exited 1: error:receiver:RuntimeError: boom" });
    expect(fs.existsSync(path.join(home, ".codecast", "mirror.lock"))).toBe(false);
  });

  test("the exact command line copyAgentAuthToRemote sends (`umask 077; python3 -c <shq(script)>`) runs the receiver", () => {
    config("U");
    const r = spawnSync("/bin/sh", ["-c", `umask 077; python3 -c ${shq(AGENT_AUTH_RECEIVER)}`], {
      input: JSON.stringify({ origin: { user_id: "U", device_id: "D", pushed_at: "z" }, files: [file("~/.grok/auth.json", "{}")], absent: [], codexTrustPaths: [] }),
      encoding: "utf-8", env: { ...process.env, HOME: home, CAST_MIRROR_LOCK_WAIT: "2" }, timeout: 30_000,
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(parseAgentAuthReceiverOutput(r.stdout, r.status, r.stderr)).toMatchObject({ pushed: true, files: 1 });
  });

  test("malformed input is an error, not a traceback", () => {
    config("U");
    const r = spawnSync("python3", ["-c", AGENT_AUTH_RECEIVER], { input: "not json", encoding: "utf-8", env: { ...process.env, HOME: home } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("error:bundle:invalid json");
    expect(r.stderr).toBe("");
  });
});
