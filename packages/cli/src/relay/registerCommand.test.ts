import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { cleanServerError, isClaudeComm, parseHookInput, readStdinBounded, realAncestorComms, runRegister, runUnregister, type RegisterDeps } from "./registerCommand.js";

type Call = { name: string; args: any };

function deps(over: Partial<RegisterDeps> & { mutation?: (name: string, args: any) => Promise<any> } = {}) {
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const { mutation, ...rest } = over;
  const d: RegisterDeps = {
    config: { auth_token: "tok", convex_url: "https://x.convex.cloud" },
    env: { PASEO_AGENT_ID: "agent-7" },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    readStdin: async () => JSON.stringify({ session_id: "hook-sess", cwd: "/hook/cwd" }),
    ancestorComms: async () => ["sh", "claude", "Paseo Daemon"],
    gitRemote: async () => "git@github.com:a/b.git",
    deviceId: () => "dev-1",
    cwd: () => "/proc/cwd",
    makeClient: () => ({
      mutation: async (name, args) => {
        calls.push({ name, args });
        return mutation ? mutation(name, args) : { conversation_id: "c", short_id: "abc1234" };
      },
    }),
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    timeoutMs: 100,
    ...rest,
  };
  return { d, calls, out, err };
}

describe("target detection through register", () => {
  test("paseo registers its agent id", async () => {
    const { d, calls } = deps();
    expect(await runRegister({}, d)).toBe(0);
    expect(calls).toEqual([{ name: "registeredSessions:registerSession", args: {
      api_token: "tok", session_id: "hook-sess", cwd: "/hook/cwd", device_id: "dev-1",
      delivery_target: { kind: "paseo", agent_id: "agent-7" }, git_remote_url: "git@github.com:a/b.git",
    } }]);
  });

  test("herdr registers pane and socket", async () => {
    const { d, calls } = deps({ env: { HERDR_PANE_ID: "w1:p3", HERDR_SOCKET_PATH: "/s/herdr.sock" } });
    await runRegister({}, d);
    expect(calls[0].args.delivery_target).toEqual({ kind: "herdr", pane: "w1:p3", socket: "/s/herdr.sock" });
  });

  test("neither exits 0 without registering", async () => {
    const { d, calls, err } = deps({ env: {} });
    expect(await runRegister({}, d)).toBe(0);
    expect(calls).toEqual([]);
    expect(err).toEqual([]);
  });

  test("no git remote omits the field", async () => {
    const { d, calls } = deps({ gitRemote: async () => undefined });
    await runRegister({}, d);
    expect("git_remote_url" in calls[0].args).toBe(false);
  });
});

describe("nested-session guard", () => {
  test("exactly one claude ancestor registers", async () => {
    const { d, calls } = deps({ ancestorComms: async () => ["bash", "claude", "Paseo Daemon", "systemd"] });
    await runRegister({}, d);
    expect(calls).toHaveLength(1);
  });

  test("two claude ancestors skip, quietly", async () => {
    const { d, calls, err } = deps({ ancestorComms: async () => ["bash", "claude", "bash", "claude", "Paseo Daemon"] });
    expect(await runRegister({}, d)).toBe(0);
    expect(calls).toEqual([]);
    expect(err).toEqual([]);
  });

  test("no claude ancestor skips and says so", async () => {
    const { d, calls, err } = deps({ ancestorComms: async () => ["bash", "tmux"] });
    await runRegister({}, d);
    expect(calls).toEqual([]);
    expect(err).toHaveLength(1);
  });

  test("comm matching: claude, a path to it, a version-named binary; not claude-like names", () => {
    expect(isClaudeComm("claude")).toBe(true);
    expect(isClaudeComm("/home/u/.local/bin/claude")).toBe(true);
    expect(isClaudeComm("2.1.322")).toBe(true);
    expect(isClaudeComm("Paseo Daemon")).toBe(false);
    expect(isClaudeComm("claudectl")).toBe(false);
    expect(isClaudeComm("bash")).toBe(false);
  });

  test("the ps walk reads each ancestor's comm and excludes the process itself", async () => {
    const table: Record<string, string> = {
      "100": "  90 cast", "90": "  80 sh", "80": "  70 claude", "70": "  60 Paseo Daemon", "60": "   1 systemd",
    };
    const asked: string[] = [];
    const comms = await realAncestorComms(100, async (file, args) => {
      asked.push(`${file} ${args.join(" ")}`);
      return table[args[args.length - 1]] ?? "";
    });
    expect(comms).toEqual(["sh", "claude", "Paseo Daemon", "systemd"]);
    expect(asked[0]).toBe("ps -o ppid=,comm= -p 100");
  });

  test("the ps walk stops when ps fails", async () => {
    expect(await realAncestorComms(5, async () => { throw new Error("no ps"); })).toEqual([]);
  });
});

describe("hook input", () => {
  test("parses session_id and cwd from the payload, ignoring junk", () => {
    expect(parseHookInput('{"session_id":"s","cwd":"/c","extra":1}')).toEqual({ session_id: "s", cwd: "/c" });
    expect(parseHookInput("not json")).toEqual({});
    expect(parseHookInput('{"session_id":5}')).toEqual({ session_id: undefined, cwd: undefined });
  });

  test("flags override the payload, each independently", async () => {
    const { d, calls } = deps();
    await runRegister({ sessionId: "flag-sess" }, d);
    expect(calls[0].args).toMatchObject({ session_id: "flag-sess", cwd: "/hook/cwd" });
    const b = deps();
    await runRegister({ cwd: "/flag/cwd" }, b.d);
    expect(b.calls[0].args).toMatchObject({ session_id: "hook-sess", cwd: "/flag/cwd" });
  });

  test("a TTY stdin is never read, so a manual run needs the flags and falls back to the process cwd", async () => {
    let read = false;
    const { d, calls, err } = deps({ stdinIsTTY: true, readStdin: async () => { read = true; return ""; } });
    await runRegister({}, d);
    expect(read).toBe(false);
    expect(calls).toEqual([]);
    expect(err[0]).toContain("no session id");
    const b = deps({ stdinIsTTY: true });
    await runRegister({ sessionId: "s" }, b.d);
    expect(b.calls[0].args.cwd).toBe("/proc/cwd");
  });

  test("stdin is not read when both flags are given", async () => {
    let read = false;
    const { d } = deps({ readStdin: async () => { read = true; return ""; } });
    await runRegister({ sessionId: "s", cwd: "/c" }, d);
    expect(read).toBe(false);
  });

  test("readStdinBounded returns what arrived at end, and gives up on a stream that never ends", async () => {
    const done = new PassThrough();
    const p = readStdinBounded(done, 500);
    done.end('{"a":1}');
    expect(await p).toBe('{"a":1}');
    const open = new PassThrough();
    open.write("partial");
    expect(await readStdinBounded(open, 30)).toBe("partial");
  });
});

describe("hook safety: every failure is one stderr line and exit 0", () => {
  test("not logged in", async () => {
    for (const config of [null, { auth_token: "t" }, { convex_url: "u" }]) {
      const { d, calls, err } = deps({ config });
      expect(await runRegister({}, d)).toBe(0);
      expect(calls).toEqual([]);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain("cast auth");
    }
  });

  test("a network failure", async () => {
    const { d, err } = deps({ mutation: async () => { throw new Error("fetch failed"); } });
    expect(await runRegister({}, d)).toBe(0);
    expect(err).toEqual(["cast register: fetch failed"]);
  });

  test("a server refusal prints its message, not the stack", async () => {
    const { d, err } = deps({ mutation: async () => { throw new Error("[CONVEX M(registeredSessions:registerSession)] [Request ID: 1] Server Error\nUncaught Error: Session is registered from another device\n    at handler (../x.ts:1:1)"); } });
    expect(await runRegister({}, d)).toBe(0);
    expect(err).toEqual(["cast register: Session is registered from another device"]);
  });

  test("a hang is cut off", async () => {
    const { d, err } = deps({ mutation: () => new Promise(() => {}), timeoutMs: 20 });
    const start = Date.now();
    expect(await runRegister({}, d)).toBe(0);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(err[0]).toContain("timed out");
  });

  test("a throwing dependency", async () => {
    const { d, err } = deps({ ancestorComms: async () => { throw new Error("ps exploded"); } });
    expect(await runRegister({}, d)).toBe(0);
    expect(err).toHaveLength(1);
  });

  test("the short id prints only to a TTY", async () => {
    const tty = deps({ stdoutIsTTY: true });
    await runRegister({}, tty.d);
    expect(tty.out).toEqual(["abc1234"]);
    const pipe = deps();
    await runRegister({}, pipe.d);
    expect(pipe.out).toEqual([]);
  });

  test("cleanServerError keeps a plain message", () => {
    expect(cleanServerError(new Error("plain"))).toBe("plain");
  });
});

describe("unregister", () => {
  test("marks the hook's session ended with the token", async () => {
    const { d, calls } = deps({ env: {}, ancestorComms: async () => [] });
    expect(await runUnregister({}, d)).toBe(0);
    expect(calls).toEqual([{ name: "registeredSessions:markEnded", args: { api_token: "tok", session_id: "hook-sess" } }]);
  });

  test("the flag overrides the payload", async () => {
    const { d, calls } = deps();
    await runUnregister({ sessionId: "other" }, d);
    expect(calls[0].args.session_id).toBe("other");
  });

  test("no registered session is a quiet exit 0", async () => {
    const { d, err } = deps({ mutation: async () => { throw new Error("Uncaught Error: No registered session found for that session id"); } });
    expect(await runUnregister({}, d)).toBe(0);
    expect(err).toEqual([]);
  });

  test("other failures are one line and exit 0", async () => {
    const { d, err } = deps({ mutation: async () => { throw new Error("fetch failed"); } });
    expect(await runUnregister({}, d)).toBe(0);
    expect(err).toEqual(["cast unregister: fetch failed"]);
    const b = deps({ config: null });
    expect(await runUnregister({}, b.d)).toBe(0);
    expect(b.err).toHaveLength(1);
  });
});
