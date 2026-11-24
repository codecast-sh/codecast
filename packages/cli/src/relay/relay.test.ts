import { describe, expect, test } from "bun:test";
import { Relay, isControlMessage, wrapForHandoff, type PendingRow } from "./relay.js";
import type { DeliverResult, DeliveryTarget, Liveness, TargetAdapter } from "./targets.js";

const HERDR: DeliveryTarget = { kind: "herdr", socket: "/s", pane: "w1:p1" };
const PASEO: DeliveryTarget = { kind: "paseo", agent_id: "a1" };

function row(id: string, over: Partial<PendingRow> = {}): PendingRow {
  return { _id: id, content: `body-${id}`, session_id: `sess-${id}`, delivery_target: HERDR, ...over };
}

function setup(opts: { deliver?: (t: DeliveryTarget, text: string) => DeliverResult; probe?: (t: DeliveryTarget, s: string) => Liveness; mutation?: (name: string, args: any) => any; registered?: any[] } = {}) {
  const delivered: Array<{ target: DeliveryTarget; text: string }> = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const logs: string[] = [];
  const adapter: TargetAdapter = {
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return opts.deliver ? opts.deliver(target, text) : { kind: "ok" };
    },
    probe: async (target, sessionId) => (opts.probe ? opts.probe(target, sessionId) : { kind: "alive" }),
  };
  const client = {
    mutation: async (name: string, args: any) => {
      mutations.push({ name, args });
      return opts.mutation ? opts.mutation(name, args) : { success: true, skipped: false };
    },
    query: async (name: string) => (name === "registeredSessions:registeredForDevice" ? opts.registered ?? [] : []),
  };
  const relay = new Relay({ client, adapter, apiToken: "tok", deviceId: "dev", log: (l) => logs.push(l), now: () => 1234 });
  const statusCalls = () => mutations.filter((m) => m.name === "pendingMessages:updateMessageStatus");
  const ended = () => mutations.filter((m) => m.name === "registeredSessions:markEnded").map((m) => m.args.session_id);
  return { relay, delivered, mutations, logs, statusCalls, ended };
}

describe("hand-off and ack", () => {
  test("wraps the content, delivers, and acks delivered with the device and token", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { content: "ping" })]);
    expect(s.delivered).toEqual([{ target: HERDR, text: "<<<<<<\nping\n>>>>>>" }]);
    expect(wrapForHandoff("ping")).toBe("<<<<<<\nping\n>>>>>>");
    expect(s.statusCalls()).toEqual([{ name: "pendingMessages:updateMessageStatus", args: { message_id: "m1", status: "delivered", delivered_at: 1234, api_token: "tok", device_id: "dev" } }]);
  });

  test("delivers by the row's own target kind", async () => {
    const s = setup();
    await s.relay.onRows([row("a", { delivery_target: PASEO })]);
    expect(s.delivered[0].target).toEqual(PASEO);
  });

  test("never hands the same message off twice in one process, even when rows are pushed again", async () => {
    const s = setup();
    await s.relay.onRows([row("m1")]);
    await s.relay.onRows([row("m1")]);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
  });

  test("a failed ack is retried without a second hand-off", async () => {
    let fail = true;
    const s = setup({ mutation: (name) => { if (name.endsWith("updateMessageStatus") && fail) throw new Error("network"); return { success: true, skipped: false }; } });
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(1);
    fail = false;
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(2);
    await s.relay.tick();
    expect(s.statusCalls()).toHaveLength(2);
  });

  test("a skipped ack is settled: the relay stops touching that row", async () => {
    const s = setup({ mutation: () => ({ success: true, skipped: true }) });
    await s.relay.onRows([row("m1")]);
    await s.relay.tick();
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(1);
    expect(s.logs.join("\n")).toContain("already settled");
  });

  test("an image is skipped with a log line and the text still goes", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { image_storage_id: "img" })]);
    expect(s.delivered).toHaveLength(1);
    expect(s.logs.join("\n")).toContain("image skipped");
  });

  test("a row whose session has no delivery target is left pending", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { delivery_target: undefined })]);
    expect(s.delivered).toEqual([]);
    expect(s.statusCalls()).toEqual([]);
  });
});

describe("blocked, transient and gone", () => {
  test("blocked leaves the row pending and a tick retries it until it lands", async () => {
    let blocked = true;
    const s = setup({ deliver: () => (blocked ? { kind: "blocked", reason: "dialog" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1")]);
    expect(s.statusCalls()).toEqual([]);
    expect(s.delivered).toHaveLength(1);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(2);
    expect(s.statusCalls()).toEqual([]);
    blocked = false;
    await s.relay.tick();
    expect(s.delivered).toHaveLength(3);
    expect(s.statusCalls()).toHaveLength(1);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(3);
  });

  test("transient failure is retried on the next tick", async () => {
    let n = 0;
    const s = setup({ deliver: () => (n++ === 0 ? { kind: "transient", reason: "timeout" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1")]);
    expect(s.statusCalls()).toEqual([]);
    await s.relay.tick();
    expect(s.statusCalls()).toHaveLength(1);
  });

  test("gone ends the session and writes no delivery ack", async () => {
    const s = setup({ deliver: () => ({ kind: "gone", reason: "agent_not_found" }) });
    await s.relay.onRows([row("m1", { session_id: "sess-x" }), row("m2", { session_id: "sess-y" })]);
    expect(s.ended().sort()).toEqual(["sess-x", "sess-y"]);
    expect(s.mutations.find((m) => m.name === "registeredSessions:markEnded")!.args).toEqual({ session_id: expect.any(String), api_token: "tok" });
    expect(s.statusCalls()).toEqual([]);
    await s.relay.tick();
    expect(s.ended()).toHaveLength(2);
  });
});

describe("control rows", () => {
  const control = JSON.stringify({ __cc_poll: true, keys: ["Down", "Enter"] });

  test("the predicate matches the server's: strict true, with keys, steps or text", () => {
    expect(isControlMessage(control)).toBe(true);
    expect(isControlMessage(JSON.stringify({ __cc_poll: true, text: "hi" }))).toBe(true);
    expect(isControlMessage(JSON.stringify({ __cc_poll: true, steps: [] }))).toBe(true);
    expect(isControlMessage(JSON.stringify({ __cc_poll: true }))).toBe(false);
    expect(isControlMessage(JSON.stringify({ __cc_poll: "yes", keys: [] }))).toBe(false);
    expect(isControlMessage("plain text")).toBe(false);
  });

  test("a control row is settled undeliverable and never pasted", async () => {
    const s = setup();
    await s.relay.onRows([row("c1", { content: control })]);
    expect(s.delivered).toEqual([]);
    expect(s.statusCalls()).toEqual([{ name: "pendingMessages:updateMessageStatus", args: { message_id: "c1", status: "undeliverable", api_token: "tok", device_id: "dev" } }]);
    await s.relay.tick();
    expect(s.statusCalls()).toHaveLength(1);
  });

  test("a control row that fails to settle is retried and still never pasted", async () => {
    let fail = true;
    const s = setup({ mutation: () => { if (fail) throw new Error("net"); return { success: true, skipped: false }; } });
    await s.relay.onRows([row("c1", { content: control })]);
    fail = false;
    await s.relay.tick();
    expect(s.statusCalls()).toHaveLength(2);
    expect(s.delivered).toEqual([]);
  });

  test("a control row ahead of a message does not block the other conversations", async () => {
    const s = setup();
    await s.relay.onRows([row("c1", { content: control, session_id: "a" }), row("m1", { session_id: "b" })]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls().map((c) => c.args.status).sort()).toEqual(["delivered", "undeliverable"]);
  });
});

describe("dead-session sweep", () => {
  const reg = (id: string, target: DeliveryTarget = HERDR) => ({ session_id: id, delivery_target: target, short_id: `s-${id}` });

  test("a gone session is ended once it is gone on two consecutive sweeps", async () => {
    const s = setup({ registered: [reg("a")], probe: () => ({ kind: "gone", reason: "pane closed" }) });
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
    await s.relay.sweep();
    expect(s.ended()).toEqual(["a"]);
  });

  test("an alive or unknown reading in between resets the count", async () => {
    const readings: Liveness[] = [{ kind: "gone", reason: "x" }, { kind: "unknown", reason: "timeout" }, { kind: "gone", reason: "x" }, { kind: "alive" }, { kind: "gone", reason: "x" }];
    const s = setup({ registered: [reg("a")], probe: () => readings.shift()! });
    for (let i = 0; i < 5; i++) await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });

  test.each([
    ["unreachable socket / timeout", { kind: "unknown", reason: "herdr timeout" } as Liveness],
    ["alive", { kind: "alive" } as Liveness],
  ])("%s never ends a session", async (_n, reading) => {
    const s = setup({ registered: [reg("a")], probe: () => reading });
    for (let i = 0; i < 4; i++) await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });

  test("only the rows with evidence end", async () => {
    const s = setup({
      registered: [reg("dead"), reg("live", PASEO), reg("fuzzy")],
      probe: (_t, id) => (id === "dead" ? { kind: "gone", reason: "x" } : id === "live" ? { kind: "alive" } : { kind: "unknown", reason: "y" }),
    });
    await s.relay.sweep();
    await s.relay.sweep();
    expect(s.ended()).toEqual(["dead"]);
  });

  test("a failed listing ends nothing and does not throw", async () => {
    const s = setup();
    (s.relay as any).deps.client.query = async () => { throw new Error("offline"); };
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });
});

describe("heartbeat", () => {
  test("sends the relay heartbeat with the token and device, and survives a failure", async () => {
    const s = setup();
    await s.relay.heartbeat();
    expect(s.mutations[0]).toEqual({ name: "registeredSessions:relayHeartbeat", args: { api_token: "tok", device_id: "dev" } });
    const f = setup({ mutation: () => { throw new Error("net"); } });
    await f.relay.heartbeat();
    expect(f.logs.join("\n")).toContain("heartbeat failed");
  });
});
