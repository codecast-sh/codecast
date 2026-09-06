import { describe, expect, test } from "bun:test";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { GrokAcpClient, defaultPermissionChoice } from "./grokAcp.js";

// A fake `grok agent stdio`: captures what the client writes, lets the test
// answer as grok would. Framing and dispatch are the contract under test; the
// live protocol (initialize → loadSession, session/load replay with isReplay,
// session/prompt → stopReason) was verified against grok 1.0.13 on 2026-09-06.
function fakeAgent() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: Array<Record<string, any>> = [];
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) written.push(JSON.parse(line));
  });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null as number | null, kill: () => { child.exitCode = 0; child.emit("exit", 0); } });
  const spawnFn = (() => child) as any;
  const reply = (obj: object) => stdout.write(JSON.stringify(obj) + "\n");
  const waitFor = async (pred: (m: Record<string, any>) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const hit = written.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("no matching request written: " + JSON.stringify(written));
  };
  return { child, spawnFn, reply, written, waitFor };
}

describe("GrokAcpClient", () => {
  test("initialize on start, then new → prompt streams text and resolves on the turn end", async () => {
    const f = fakeAgent();
    const client = new GrokAcpClient({ log: () => {}, spawnFn: f.spawnFn, agentArgs: ["--always-approve"] });
    const started = client.start();
    const init = await f.waitFor((m) => m.method === "initialize");
    expect(init.params.protocolVersion).toBe(1);
    f.reply({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    await started;
    expect(client.running).toBe(true);
    expect(client.agentCapabilities.loadSession).toBe(true);

    const created = client.sessionNew({ cwd: "/tmp/p" });
    const req = await f.waitFor((m) => m.method === "session/new");
    expect(req.params).toEqual({ cwd: "/tmp/p", mcpServers: [] });
    f.reply({ jsonrpc: "2.0", id: req.id, result: { sessionId: "sess-1" } });
    expect((await created).sessionId).toBe("sess-1");

    const updates: string[] = [];
    client.on("update", (u) => updates.push(`${u.sessionUpdate}${u.isReplay ? ":replay" : ""}`));
    const turn = client.prompt({ sessionId: "sess-1", text: "Reply with PONG" });
    const p = await f.waitFor((m) => m.method === "session/prompt");
    expect(p.params.prompt).toEqual([{ type: "text", text: "Reply with PONG" }]);
    f.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "PO" } } } });
    f.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NG" } } } });
    f.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-1", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } }, _meta: { isReplay: true } } });
    f.reply({ jsonrpc: "2.0", id: p.id, result: { stopReason: "end_turn" } });
    const result = await turn;
    expect(result).toEqual({ stopReason: "end_turn", text: "PONG" });
    expect(updates).toEqual(["agent_message_chunk", "agent_message_chunk", "user_message_chunk:replay"]);
    client.stop();
  });

  test("answers a permission request with the first allow option and declines unknown requests", async () => {
    const f = fakeAgent();
    const client = new GrokAcpClient({ log: () => {}, spawnFn: f.spawnFn });
    const started = client.start();
    const init = await f.waitFor((m) => m.method === "initialize");
    f.reply({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: 1 } });
    await started;
    const seen: string[] = [];
    client.on("permission", (r) => seen.push(r.sessionId));
    f.reply({ jsonrpc: "2.0", id: "srv-1", method: "session/request_permission", params: { sessionId: "sess-1", toolCall: { title: "bash" }, options: [
      { optionId: "reject", kind: "reject_once" }, { optionId: "allow-always", kind: "allow_always" }, { optionId: "allow", kind: "allow_once" },
    ] } });
    const answer = await f.waitFor((m) => m.id === "srv-1");
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(seen).toEqual(["sess-1"]);
    f.reply({ jsonrpc: "2.0", id: "srv-2", method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    const declined = await f.waitFor((m) => m.id === "srv-2");
    expect(declined.error.code).toBe(-32601);
    client.stop();
  });

  test("a custom permission handler wins; an agent error rejects the pending request", async () => {
    const f = fakeAgent();
    const client = new GrokAcpClient({ log: () => {}, spawnFn: f.spawnFn, onPermission: async () => "reject" });
    const started = client.start();
    const init = await f.waitFor((m) => m.method === "initialize");
    f.reply({ jsonrpc: "2.0", id: init.id, result: {} });
    await started;
    f.reply({ jsonrpc: "2.0", id: 9, method: "session/request_permission", params: { sessionId: "s", options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "reject", kind: "reject_once" }] } });
    const answer = await f.waitFor((m) => m.id === 9);
    expect(answer.result.outcome.optionId).toBe("reject");
    const load = client.sessionLoad({ sessionId: "missing", cwd: "/tmp/p" });
    const req = await f.waitFor((m) => m.method === "session/load");
    f.reply({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "session not found" } });
    await expect(load).rejects.toThrow(/session not found/);
    client.stop();
  });

  test("defaultPermissionChoice prefers allow_once, then any allow, then the first option", () => {
    expect(defaultPermissionChoice([{ optionId: "a", kind: "allow_always" }, { optionId: "o", kind: "allow_once" }])).toBe("o");
    expect(defaultPermissionChoice([{ optionId: "r", kind: "reject_once" }, { optionId: "a", kind: "allow_always" }])).toBe("a");
    expect(defaultPermissionChoice([{ optionId: "r", kind: "reject_once" }])).toBe("r");
    expect(defaultPermissionChoice([])).toBeNull();
  });
});
