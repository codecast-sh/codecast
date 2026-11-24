import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import { HerdrError } from "../herdr.js";
import { createTargetAdapter, detectDeliveryTarget, type ExecResult, type TargetTransport } from "./targets.js";

const HERDR = { kind: "herdr" as const, socket: "/tmp/h.sock", pane: "w1:p2" };
const PASEO = { kind: "paseo" as const, agent_id: "agent-1" };

function fakeTransport(over: Partial<TargetTransport> = {}) {
  const calls = { herdr: [] as any[], exec: [] as any[], temps: [] as Array<{ file: string; content: string; mode: number; removed: boolean }> };
  const transport: TargetTransport = {
    herdr: async (socket, method, params, timeoutMs) => {
      calls.herdr.push({ socket, method, params, timeoutMs });
      return { type: "agent_prompted", agent: {} };
    },
    exec: async (file, args, timeoutMs) => {
      calls.exec.push({ file, args, timeoutMs });
      return { code: 0, stdout: "{}", stderr: "" };
    },
    writeTemp: (content) => {
      const file = `/tmp/fake-${calls.temps.length}.txt`;
      const rec = { file, content, mode: 0o600, removed: false };
      calls.temps.push(rec);
      return { file, remove: () => { rec.removed = true; } };
    },
    ...over,
  };
  return { transport, calls };
}

describe("detectDeliveryTarget", () => {
  test("paseo from PASEO_AGENT_ID", () => {
    expect(detectDeliveryTarget({ PASEO_AGENT_ID: "a1" })).toEqual({ kind: "paseo", agent_id: "a1" });
  });
  test("paseo carries its home when PASEO_HOME is set", () => {
    expect(detectDeliveryTarget({ PASEO_AGENT_ID: "a1", PASEO_HOME: "/p" })).toEqual({ kind: "paseo", agent_id: "a1", home: "/p" });
  });
  test("herdr from the pane and the socket herdr exports", () => {
    expect(detectDeliveryTarget({ HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s/herdr.sock" })).toEqual({ kind: "herdr", pane: "w1:p1", socket: "/s/herdr.sock" });
  });
  test("herdr falls back to the default socket when none is exported", () => {
    expect(detectDeliveryTarget({ HERDR_PANE_ID: "w1:p1" }, () => "/default.sock")).toEqual({ kind: "herdr", pane: "w1:p1", socket: "/default.sock" });
  });
  test("neither names no target", () => {
    expect(detectDeliveryTarget({ HOME: "/h" })).toBeNull();
  });
});

describe("herdr adapter", () => {
  test("prompts the pane with agent.prompt and the text", async () => {
    const { transport, calls } = fakeTransport();
    expect(await createTargetAdapter(transport).deliver(HERDR, "hello")).toEqual({ kind: "ok" });
    expect(calls.herdr).toHaveLength(1);
    expect(calls.herdr[0]).toMatchObject({ socket: "/tmp/h.sock", method: "agent.prompt", params: { target: "w1:p2", text: "hello" } });
    expect(calls.herdr[0].timeoutMs).toBeGreaterThan(0);
  });

  const failing = (code: string) => fakeTransport({ herdr: async () => { throw new HerdrError(code, `boom ${code}`); } }).transport;
  test.each([
    ["agent_blocked", "blocked"],
    ["agent_not_found", "gone"],
    ["pane_not_found", "gone"],
    ["agent_pane_not_found", "gone"],
    ["unreachable", "transient"],
    ["timeout", "uncertain"],
    ["agent_not_ready", "transient"],
    ["agent_prompt_failed", "transient"],
  ])("error %s maps to %s", async (code, kind) => {
    const res = await createTargetAdapter(failing(code)).deliver(HERDR, "x");
    expect(res.kind).toBe(kind as string as never);
  });

  test("a non-herdr throw is transient", async () => {
    const t = fakeTransport({ herdr: async () => { throw new Error("weird"); } }).transport;
    expect((await createTargetAdapter(t).deliver(HERDR, "x")).kind).toBe("transient");
  });

  test("probe: asks agent.get for the pane and a found agent is alive", async () => {
    const { transport, calls } = fakeTransport({ herdr: async (...args) => { calls.herdr.push(args); return { agent: {} }; } });
    expect((await createTargetAdapter(transport).probe(HERDR)).kind).toBe("alive");
    expect(calls.herdr[0][1]).toBe("agent.get");
    expect(calls.herdr[0][2]).toEqual({ target: "w1:p2" });
  });
  test("probe: an agent_session naming another session is not evidence", async () => {
    const t = fakeTransport({ herdr: async () => ({ agent: { agent_session: { kind: "id", value: "someone-else", agent: "claude", source: "x" } } }) }).transport;
    expect((await createTargetAdapter(t).probe(HERDR)).kind).toBe("alive");
  });
  test.each([
    ["agent_not_found", "gone"],
    ["pane_not_found", "gone"],
    ["unreachable", "unknown"],
    ["timeout", "unknown"],
  ])("probe error %s is %s", async (code, kind) => {
    expect((await createTargetAdapter(failing(code)).probe(HERDR)).kind).toBe(kind as string as never);
  });
});

describe("paseo adapter", () => {
  const exec = (res: Partial<ExecResult>) => async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", ...res });

  test("sends with steer, no-wait and a prompt file, then removes the file", async () => {
    const { transport, calls } = fakeTransport({ exec: async (file, args, timeoutMs) => { calls.exec.push({ file, args, timeoutMs }); return { code: 0, stdout: '{"ok":true}', stderr: "" }; } });
    expect(await createTargetAdapter(transport, {}).deliver(PASEO, "hi there")).toEqual({ kind: "ok" });
    expect(calls.exec[0].file).toBe("paseo");
    expect(calls.exec[0].args).toEqual(["send", "agent-1", "--behavior", "steer", "--no-wait", "--prompt-file", calls.temps[0].file, "--json"]);
    expect(calls.temps[0]).toMatchObject({ content: "hi there", mode: 0o600, removed: true });
  });

  test("AGENT_NOT_FOUND is gone and the file is still removed", async () => {
    const { transport, calls } = fakeTransport({ exec: exec({ code: 1, stdout: JSON.stringify({ error: { code: "AGENT_NOT_FOUND", message: "x" } }) }) });
    expect((await createTargetAdapter(transport).deliver(PASEO, "x")).kind).toBe("gone");
    expect(calls.temps[0].removed).toBe(true);
  });

  test("other failures are transient: a JSON error, a bare exit, a spawn that throws", async () => {
    for (const e of [
      exec({ code: 1, stdout: JSON.stringify({ error: { code: "DAEMON_UNREACHABLE", message: "x" } }) }),
      exec({ code: 1, stderr: "connection refused" }),
      async () => { throw new Error("spawn paseo ENOENT"); },
    ]) {
      const { transport, calls } = fakeTransport({ exec: e });
      expect((await createTargetAdapter(transport).deliver(PASEO, "x")).kind).toBe("transient");
      expect(calls.temps[0].removed).toBe(true);
    }
  });

  test("a temp file that cannot be written is transient", async () => {
    const { transport } = fakeTransport({ writeTemp: () => { throw new Error("EACCES"); } });
    expect((await createTargetAdapter(transport).deliver(PASEO, "x")).kind).toBe("transient");
  });

  test("probe: AGENT_NOT_FOUND and Archived are gone", async () => {
    expect((await createTargetAdapter(fakeTransport({ exec: exec({ code: 1, stdout: JSON.stringify({ error: { code: "AGENT_NOT_FOUND" } }) }) }).transport).probe(PASEO)).kind).toBe("gone");
    expect((await createTargetAdapter(fakeTransport({ exec: exec({ stdout: JSON.stringify({ Id: "a", Archived: true }) }) }).transport).probe(PASEO)).kind).toBe("gone");
  });

  test("probe: a live agent is alive and asked through inspect --json", async () => {
    const { transport, calls } = fakeTransport({ exec: async (f, a, t) => { calls.exec.push({ f, a, t }); return { code: 0, stdout: JSON.stringify({ Id: "a", Archived: false }), stderr: "" }; } });
    expect((await createTargetAdapter(transport).probe(PASEO)).kind).toBe("alive");
    expect(calls.exec[0].a).toEqual(["inspect", "agent-1", "--json"]);
  });

  test("probe: a down paseo daemon, garbage output or a spawn failure is not evidence", async () => {
    for (const e of [
      exec({ code: 1, stdout: JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "x" } }) }),
      exec({ code: 1, stderr: "cannot connect" }),
      exec({ stdout: "not json" }),
      async () => { throw new Error("spawn failed"); },
    ]) {
      expect((await createTargetAdapter(fakeTransport({ exec: e }).transport).probe(PASEO)).kind).toBe("unknown");
    }
  });
});

describe("paseo binary and home", () => {
  const withHome = { kind: "paseo" as const, agent_id: "agent-1", home: "/alt/home" };

  test("PASEO_CLI names the binary, and the default is paseo on PATH", async () => {
    const a = fakeTransport();
    await createTargetAdapter(a.transport, { PASEO_CLI: "/opt/Paseo/bin/paseo" }).deliver(PASEO, "x");
    await createTargetAdapter(a.transport, { PASEO_CLI: "/opt/Paseo/bin/paseo" }).probe(PASEO);
    expect(a.calls.exec.map((c) => c.file)).toEqual(["/opt/Paseo/bin/paseo", "/opt/Paseo/bin/paseo"]);
    const b = fakeTransport();
    await createTargetAdapter(b.transport, {}).probe(PASEO);
    expect(b.calls.exec[0].file).toBe("paseo");
  });

  test("a target's home goes to send and inspect as --home, and its absence adds nothing", async () => {
    const { transport, calls } = fakeTransport({ exec: async (file, args, timeoutMs) => { calls.exec.push({ file, args, timeoutMs }); return { code: 0, stdout: "{}", stderr: "" }; } });
    const adapter = createTargetAdapter(transport, {});
    await adapter.deliver(withHome, "x");
    await adapter.probe(withHome);
    await adapter.deliver(PASEO, "x");
    expect(calls.exec[0].args.slice(-2)).toEqual(["--home", "/alt/home"]);
    expect(calls.exec[1].args).toEqual(["inspect", "agent-1", "--json", "--home", "/alt/home"]);
    expect(calls.exec[2].args).not.toContain("--home");
  });
});

describe("a timeout after the request was written is uncertain, never retried as a send", () => {
  test("paseo send killed by its timeout", async () => {
    const { transport, calls } = fakeTransport({ exec: async () => ({ code: -1, stdout: "", stderr: "timed out", timedOut: true }) });
    expect((await createTargetAdapter(transport).deliver(PASEO, "x")).kind).toBe("uncertain");
    expect(calls.temps[0].removed).toBe(true);
  });
});

describe("identify", () => {
  test("herdr reports the detected agent name, and no agent or a failed lookup reports nothing", async () => {
    const ok = fakeTransport({ herdr: async () => ({ agent: { agent: "claude" } }) }).transport;
    expect(await createTargetAdapter(ok).identify(HERDR)).toBe("claude");
    const codex = fakeTransport({ herdr: async () => ({ agent: { agent: "codex" } }) }).transport;
    expect(await createTargetAdapter(codex).identify(HERDR)).toBe("codex");
    const none = fakeTransport({ herdr: async () => ({ agent: { agent: null } }) }).transport;
    expect(await createTargetAdapter(none).identify(HERDR)).toBeUndefined();
    const failed = fakeTransport({ herdr: async () => { throw new HerdrError("agent_not_found", "x"); } }).transport;
    expect(await createTargetAdapter(failed).identify(HERDR)).toBeUndefined();
  });

  test("herdr identify uses a short timeout", async () => {
    const { transport, calls } = fakeTransport();
    await createTargetAdapter(transport).identify(HERDR);
    expect(calls.herdr[0].timeoutMs).toBeLessThanOrEqual(3000);
  });

  test("paseo reports its Provider from inspect, and a failure or garbage reports nothing", async () => {
    const codex = fakeTransport({ exec: async () => ({ code: 0, stdout: JSON.stringify({ Provider: "codex" }), stderr: "" }) }).transport;
    expect(await createTargetAdapter(codex).identify(PASEO)).toBe("codex");
    const claude = fakeTransport({ exec: async () => ({ code: 0, stdout: JSON.stringify({ Provider: "claude" }), stderr: "" }) }).transport;
    expect(await createTargetAdapter(claude).identify(PASEO)).toBe("claude");
    for (const e of [async () => ({ code: 1, stdout: "", stderr: "down" }), async () => { throw new Error("spawn"); }, async () => ({ code: 0, stdout: "not json", stderr: "" })]) {
      expect(await createTargetAdapter(fakeTransport({ exec: e }).transport).identify(PASEO)).toBeUndefined();
    }
  });

  test("paseo identify uses a short timeout", async () => {
    const { transport, calls } = fakeTransport();
    await createTargetAdapter(transport).identify(PASEO);
    expect(calls.exec[0].timeoutMs).toBeLessThanOrEqual(3000);
  });
});

describe("the real transport runs from the home directory", () => {
  test("exec starts in $HOME even when the caller's cwd is elsewhere", async () => {
    const { realTransport } = await import("./targets.js");
    const before = process.cwd();
    process.chdir("/");
    try {
      const res = await realTransport.exec("pwd", [], 5000);
      expect(fs.realpathSync(res.stdout.trim())).toBe(fs.realpathSync(os.homedir()));
    } finally {
      process.chdir(before);
    }
  });

  test("a command killed by its timeout reports timedOut", async () => {
    const { realTransport } = await import("./targets.js");
    const res = await realTransport.exec("sleep", ["5"], 100);
    expect(res.timedOut).toBe(true);
  });
});

describe("the real temp file", () => {
  test("is written 0600 and removed", async () => {
    const { realTransport } = await import("./targets.js");
    const t = realTransport.writeTemp("secret");
    expect(fs.statSync(t.file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(t.file, "utf-8")).toBe("secret");
    t.remove();
    expect(fs.existsSync(t.file)).toBe(false);
  });
});
