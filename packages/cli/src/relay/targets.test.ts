import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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
    ["timeout", "transient"],
    ["agent_not_ready", "transient"],
    ["agent_prompt_failed", "transient"],
  ])("error %s maps to %s", async (code, kind) => {
    const res = await createTargetAdapter(failing(code)).deliver(HERDR, "x");
    expect(res.kind).toBe(kind);
  });

  test("a non-herdr throw is transient", async () => {
    const t = fakeTransport({ herdr: async () => { throw new Error("weird"); } }).transport;
    expect((await createTargetAdapter(t).deliver(HERDR, "x")).kind).toBe("transient");
  });

  const agent = (session: unknown) => fakeTransport({ herdr: async () => ({ type: "agent_info", agent: { agent_session: session } }) }).transport;
  test("probe: asks agent.get for the pane", async () => {
    const { transport, calls } = fakeTransport({ herdr: async (...a) => { calls.herdr.push(a); return { agent: {} }; } });
    await createTargetAdapter(transport).probe(HERDR, "s1");
    expect(calls.herdr[0][1]).toBe("agent.get");
    expect(calls.herdr[0][2]).toEqual({ target: "w1:p2" });
  });
  test("probe: matching id session is alive", async () => {
    expect((await createTargetAdapter(agent({ kind: "id", value: "s1", agent: "claude", source: "x" })).probe(HERDR, "s1")).kind).toBe("alive");
  });
  test("probe: a different id session is gone", async () => {
    expect((await createTargetAdapter(agent({ kind: "id", value: "other", agent: "claude", source: "x" })).probe(HERDR, "s1")).kind).toBe("gone");
  });
  test("probe: a missing or null session, or a non-id kind, is not evidence", async () => {
    for (const session of [undefined, null, { kind: "path", value: "/x/y", agent: "claude", source: "x" }, { kind: "id", value: "", agent: "claude", source: "x" }]) {
      expect((await createTargetAdapter(agent(session)).probe(HERDR, "s1")).kind).toBe("alive");
    }
  });
  test.each([
    ["agent_not_found", "gone"],
    ["pane_not_found", "gone"],
    ["unreachable", "unknown"],
    ["timeout", "unknown"],
  ])("probe error %s is %s", async (code, kind) => {
    expect((await createTargetAdapter(failing(code)).probe(HERDR, "s1")).kind).toBe(kind);
  });
});

describe("paseo adapter", () => {
  const exec = (res: Partial<ExecResult>) => async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", ...res });

  test("sends with steer, no-wait and a prompt file, then removes the file", async () => {
    const { transport, calls } = fakeTransport({ exec: async (file, args, timeoutMs) => { calls.exec.push({ file, args, timeoutMs }); return { code: 0, stdout: '{"ok":true}', stderr: "" }; } });
    expect(await createTargetAdapter(transport).deliver(PASEO, "hi there")).toEqual({ kind: "ok" });
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
    expect((await createTargetAdapter(fakeTransport({ exec: exec({ code: 1, stdout: JSON.stringify({ error: { code: "AGENT_NOT_FOUND" } }) }) }).transport).probe(PASEO, "s")).kind).toBe("gone");
    expect((await createTargetAdapter(fakeTransport({ exec: exec({ stdout: JSON.stringify({ Id: "a", Archived: true }) }) }).transport).probe(PASEO, "s")).kind).toBe("gone");
  });

  test("probe: a live agent is alive and asked through inspect --json", async () => {
    const { transport, calls } = fakeTransport({ exec: async (f, a, t) => { calls.exec.push({ f, a, t }); return { code: 0, stdout: JSON.stringify({ Id: "a", Archived: false }), stderr: "" }; } });
    expect((await createTargetAdapter(transport).probe(PASEO, "s")).kind).toBe("alive");
    expect(calls.exec[0].a).toEqual(["inspect", "agent-1", "--json"]);
  });

  test("probe: a down paseo daemon, garbage output or a spawn failure is not evidence", async () => {
    for (const e of [
      exec({ code: 1, stdout: JSON.stringify({ error: { code: "DAEMON_NOT_RUNNING", message: "x" } }) }),
      exec({ code: 1, stderr: "cannot connect" }),
      exec({ stdout: "not json" }),
      async () => { throw new Error("spawn failed"); },
    ]) {
      expect((await createTargetAdapter(fakeTransport({ exec: e }).transport).probe(PASEO, "s")).kind).toBe("unknown");
    }
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
