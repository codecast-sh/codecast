import { describe, expect, test } from "bun:test";
import { strictStub } from "../test-helpers/strictStub.js";
import { GONE_STRIKES_TO_END, Relay, isControlMessage, wrapForHandoff, type PendingRow, type RelayClient } from "./relay.js";
import type { DeliverResult, DeliveryTarget, Liveness, TargetAdapter } from "./targets.js";

const HERDR: DeliveryTarget = { kind: "herdr", socket: "/s", pane: "w1:p1" };
const PASEO: DeliveryTarget = { kind: "paseo", agent_id: "a1" };
const PLANNED = new Set(["pendingMessages:updateMessageStatus", "registeredSessions:markEnded", "registeredSessions:relayHeartbeat"]);

function row(id: string, over: Partial<PendingRow> = {}): PendingRow {
  return { _id: id, content: `body-${id}`, session_id: `sess-${id}`, delivery_target: HERDR, ...over };
}

function setup(opts: { deliver?: (t: DeliveryTarget, text: string) => DeliverResult; probe?: (t: DeliveryTarget) => Liveness; mutation?: (name: string, args: any) => any; registered?: any[] } = {}) {
  const delivered: Array<{ target: DeliveryTarget; text: string }> = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const logs: string[] = [];
  const adapter: TargetAdapter = {
    deliver: async (target, text) => {
      delivered.push({ target, text });
      return opts.deliver ? opts.deliver(target, text) : { kind: "ok" };
    },
    probe: async (target) => (opts.probe ? opts.probe(target) : { kind: "alive" }),
    identify: async () => undefined,
  };
  const client = strictStub<RelayClient>("convex", {
    mutation: async (name: string, args: any) => {
      if (!PLANNED.has(name)) throw new Error(`unplanned mutation ${name}`);
      mutations.push({ name, args });
      return opts.mutation ? opts.mutation(name, args) : { success: true, skipped: false };
    },
    query: async (name: string) => {
      if (name !== "registeredSessions:registeredForDevice") throw new Error(`unplanned query ${name}`);
      return opts.registered ?? [];
    },
  });
  const relay = new Relay({ client, adapter, apiToken: "tok", deviceId: "dev", log: (l) => logs.push(l), now: () => 1234 });
  const statusCalls = () => mutations.filter((m) => m.name === "pendingMessages:updateMessageStatus");
  const statuses = () => statusCalls().map((c) => `${c.args.message_id}:${c.args.status}`);
  const ended = () => mutations.filter((m) => m.name === "registeredSessions:markEnded");
  return { relay, delivered, mutations, logs, statusCalls, statuses, ended };
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

  test("the same pushed result is never handed off twice, however many ticks run", async () => {
    const s = setup();
    await s.relay.onRows([row("m1")]);
    await s.relay.tick();
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(1);
  });

  test("a failed ack is retried without a second hand-off", async () => {
    let fail = true;
    const s = setup({ mutation: (name) => { if (name.endsWith("updateMessageStatus") && fail) throw new Error("network"); return { success: true, skipped: false }; } });
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(1);
    fail = false;
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(2);
    await s.relay.tick();
    expect(s.statusCalls()).toHaveLength(2);
  });

  test("a failed ack survives a fresh push that still lists the row: still no second hand-off", async () => {
    let fail = true;
    const s = setup({ mutation: (name) => { if (name.endsWith("updateMessageStatus") && fail) throw new Error("network"); return { success: true, skipped: false }; } });
    await s.relay.onRows([row("m1")]);
    fail = false;
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statuses()).toEqual(["m1:delivered", "m1:delivered"]);
  });

  test("a skipped ack is settled and the relay stops touching that row", async () => {
    const s = setup({ mutation: () => ({ success: true, skipped: true }) });
    await s.relay.onRows([row("m1")]);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toHaveLength(1);
    expect(s.logs.join("\n")).toContain("already settled");
  });

  test("a delivered row that a person's retry re-pends is delivered again", async () => {
    const s = setup();
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(1);
    await s.relay.onRows([]);
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(2);
    expect(s.statuses()).toEqual(["m1:delivered", "m1:delivered"]);
  });

  test("a re-pend that arrives as the very next push, with no empty push between, is delivered again", async () => {
    const s = setup();
    await s.relay.onRows([row("m1")]);
    await s.relay.onRows([row("m1")]);
    expect(s.delivered).toHaveLength(2);
  });

  test("images are noted inside the wrapper and logged", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { content: "see", image_storage_id: "img" }), row("m2", { content: "two", image_storage_ids: ["a", "b"], session_id: "other" })]);
    expect(s.delivered.map((d) => d.text).sort()).toEqual(["<<<<<<\nsee\n[1 image(s) not delivered]\n>>>>>>", "<<<<<<\ntwo\n[2 image(s) not delivered]\n>>>>>>"].sort());
    expect(s.logs.join("\n")).toContain("image(s) skipped");
  });

  test("a row whose session has no delivery target is left pending", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { delivery_target: undefined })]);
    expect(s.delivered).toEqual([]);
    expect(s.statusCalls()).toEqual([]);
  });
});

describe("blocked, transient and uncertain", () => {
  test("blocked leaves the row pending and a tick retries it until it lands", async () => {
    let blocked = true;
    const s = setup({ deliver: () => (blocked ? { kind: "blocked", reason: "dialog" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1")]);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(2);
    expect(s.statusCalls()).toEqual([]);
    blocked = false;
    await s.relay.tick();
    expect(s.statuses()).toEqual(["m1:delivered"]);
    await s.relay.tick();
    expect(s.delivered).toHaveLength(3);
  });

  test("a transient failure is retried on the next tick", async () => {
    let n = 0;
    const s = setup({ deliver: () => (n++ === 0 ? { kind: "transient", reason: "unreachable" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1")]);
    expect(s.statusCalls()).toEqual([]);
    await s.relay.tick();
    expect(s.statuses()).toEqual(["m1:delivered"]);
  });

  test("an uncertain result settles the row failed and is never resent, on ticks or on a push that still lists it", async () => {
    const s = setup({ deliver: () => ({ kind: "uncertain", reason: "timeout" }) });
    await s.relay.onRows([row("m1")]);
    expect(s.statuses()).toEqual(["m1:failed"]);
    expect(s.statusCalls()[0].args.delivered_at).toBeUndefined();
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
  });

  test("an uncertain row whose failed settle did not go through is settled later without a resend", async () => {
    let fail = true;
    const s = setup({
      deliver: () => ({ kind: "uncertain", reason: "timeout" }),
      mutation: (name) => { if (name.endsWith("updateMessageStatus") && fail) throw new Error("net"); return { success: true, skipped: false }; },
    });
    await s.relay.onRows([row("m1")]);
    fail = false;
    await s.relay.tick();
    expect(s.delivered).toHaveLength(1);
    expect(s.statuses()).toEqual(["m1:failed", "m1:failed"]);
  });

  test("a failed row that a person's retry re-pends is delivered afresh", async () => {
    let uncertain = true;
    const s = setup({ deliver: () => (uncertain ? { kind: "uncertain", reason: "timeout" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1")]);
    uncertain = false;
    await s.relay.onRows([row("m1")]);
    expect(s.statuses()).toEqual(["m1:failed", "m1:delivered"]);
    expect(s.delivered).toHaveLength(2);
  });
});

describe("gone is a strike, and only the sweep ends a session", () => {
  const reg = (id: string, target: DeliveryTarget = HERDR) => ({ session_id: id, delivery_target: target, short_id: `s-${id}` });

  test("a delivery gone leaves the row pending and ends nothing, however often it repeats", async () => {
    const s = setup({ deliver: () => ({ kind: "gone", reason: "agent_not_found" }) });
    await s.relay.onRows([row("m1", { session_id: "sess-x" })]);
    for (let i = 0; i < 5; i++) await s.relay.tick();
    expect(s.ended()).toEqual([]);
    expect(s.statusCalls()).toEqual([]);
    expect(s.logs.join("\n")).toContain("left pending");
  });

  test("delivery strikes and a gone sweep reading together end the session, with the probed target", async () => {
    const s = setup({
      registered: [reg("sess-x")],
      deliver: () => ({ kind: "gone", reason: "agent_not_found" }),
      probe: () => ({ kind: "gone", reason: "pane closed" }),
    });
    await s.relay.onRows([row("m1", { session_id: "sess-x" })]);
    await s.relay.sweep();
    expect(s.ended().map((m) => m.args)).toEqual([{ session_id: "sess-x", delivery_target: HERDR, api_token: "tok" }]);
  });

  test("the sweep alone needs GONE_STRIKES_TO_END consecutive gone readings", async () => {
    expect(GONE_STRIKES_TO_END).toBe(2);
    const s = setup({ registered: [reg("a")], probe: () => ({ kind: "gone", reason: "pane closed" }) });
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
    await s.relay.sweep();
    expect(s.ended()).toHaveLength(1);
  });

  test("a delivered message clears the strikes", async () => {
    let gone = true;
    const s = setup({
      registered: [reg("sess-x")],
      deliver: () => (gone ? { kind: "gone", reason: "x" } : { kind: "ok" }),
      probe: () => ({ kind: "gone", reason: "x" }),
    });
    await s.relay.onRows([row("m1", { session_id: "sess-x" })]);
    gone = false;
    await s.relay.tick();
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });

  test("an alive or unknown reading in between resets the count", async () => {
    const readings: Liveness[] = [{ kind: "gone", reason: "x" }, { kind: "unknown", reason: "timeout" }, { kind: "gone", reason: "x" }, { kind: "alive" }, { kind: "gone", reason: "x" }];
    const s = setup({ registered: [reg("a")], probe: () => readings.shift()! });
    for (let i = 0; i < 5; i++) await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });

  test.each([
    ["unreachable socket or timeout", { kind: "unknown", reason: "herdr timeout" } as Liveness],
    ["alive", { kind: "alive" } as Liveness],
  ])("%s never ends a session", async (_n, reading) => {
    const s = setup({ registered: [reg("a")], probe: () => reading });
    for (let i = 0; i < 4; i++) await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });

  test("only the rows with evidence end", async () => {
    const s = setup({
      registered: [reg("dead"), reg("live", PASEO)],
      probe: (target) => (target.kind === "herdr" ? { kind: "gone", reason: "x" } : { kind: "alive" }),
    });
    await s.relay.sweep();
    await s.relay.sweep();
    expect(s.ended().map((m) => m.args.session_id)).toEqual(["dead"]);
  });

  test("a failed listing ends nothing and does not throw", async () => {
    const s = setup();
    (s.relay as any).deps.client = strictStub<RelayClient>("convex", { query: async () => { throw new Error("offline"); } });
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
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

  test("a control row that a person's retry re-pends is settled again instead of blocking the queue", async () => {
    const s = setup();
    await s.relay.onRows([row("c1", { content: control })]);
    await s.relay.onRows([row("c1", { content: control })]);
    expect(s.statuses()).toEqual(["c1:undeliverable", "c1:undeliverable"]);
    expect(s.delivered).toEqual([]);
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
    expect(s.statuses().sort()).toEqual(["c1:undeliverable", "m1:delivered"]);
  });
});

describe("idle", () => {
  test("waits for a delivery in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const s = setup({ deliver: () => ({ kind: "ok" }) });
    (s.relay as any).deps.adapter.deliver = async () => { await gate; return { kind: "ok" }; };
    const pushed = s.relay.onRows([row("m1")]);
    let idle = false;
    const waiting = s.relay.idle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    release();
    await waiting;
    await pushed;
    expect(s.statuses()).toEqual(["m1:delivered"]);
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
