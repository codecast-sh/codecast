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

describe("gone: only sweep readings count, and only the sweep ends a session", () => {
  const reg = (id: string, target: DeliveryTarget = HERDR, registered_at?: number) => ({ session_id: id, delivery_target: target, short_id: `s-${id}`, ...(registered_at !== undefined ? { registered_at } : {}) });

  test("a delivery gone leaves the row pending and ends nothing, however often it repeats", async () => {
    const s = setup({ deliver: () => ({ kind: "gone", reason: "agent_not_found" }) });
    await s.relay.onRows([row("m1", { session_id: "sess-x" })]);
    for (let i = 0; i < 5; i++) await s.relay.tick();
    expect(s.ended()).toEqual([]);
    expect(s.statusCalls()).toEqual([]);
    expect(s.logs.join("\n")).toContain("left pending for the sweep to judge");
  });

  test("several delivery gones plus one sweep reading do not end the session; two consecutive sweep readings do", async () => {
    const s = setup({
      registered: [reg("sess-x")],
      deliver: () => ({ kind: "gone", reason: "agent_not_found" }),
      probe: () => ({ kind: "gone", reason: "pane closed" }),
    });
    await s.relay.onRows([row("m1", { session_id: "sess-x", created_at: 1 }), row("m2", { session_id: "sess-x", created_at: 2 })]);
    await s.relay.tick();
    await s.relay.tick();
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
    await s.relay.sweep();
    expect(s.ended().map((m) => m.args)).toEqual([{ session_id: "sess-x", delivery_target: HERDR, device_id: "dev", api_token: "tok" }]);
  });

  test("a delivered message clears the sweep's strike", async () => {
    const s = setup({ registered: [reg("sess-x")], probe: () => ({ kind: "gone", reason: "x" }) });
    await s.relay.sweep();
    await s.relay.onRows([row("m1", { session_id: "sess-x" })]);
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

  test("a herdr pane registered moments ago is never ended, however often it reads gone; a paseo agent and an old pane are", async () => {
    const now = 10_000_000;
    const s = setup({
      registered: [reg("fresh", HERDR, now - 60_000), reg("old", { ...HERDR, pane: "p2" }, now - 4 * 60_000), reg("fresh-paseo", PASEO, now - 60_000)],
      probe: () => ({ kind: "gone", reason: "x" }),
    });
    (s.relay as any).deps.now = () => now;
    for (let i = 0; i < 4; i++) await s.relay.sweep();
    expect([...new Set(s.ended().map((m) => m.args.session_id))].sort()).toEqual(["fresh-paseo", "old"]);
    expect(s.logs.join("\n")).toContain("registered moments ago");
  });

  test("a failed listing ends nothing and does not throw", async () => {
    const s = setup();
    (s.relay as any).deps.client = strictStub<RelayClient>("convex", { query: async () => { throw new Error("offline"); } });
    await s.relay.sweep();
    expect(s.ended()).toEqual([]);
  });
});

describe("order within a session", () => {
  test("rows for one session go in the server's oldest-first order, one at a time, whatever order the push lists them", async () => {
    const trace: string[] = [];
    let inflight = 0;
    let overlap = false;
    const s = setup();
    (s.relay as any).deps.adapter.deliver = async (_t: DeliveryTarget, text: string) => {
      const name = text.split("\n")[1];
      trace.push(`start ${name}`);
      if (++inflight > 1) overlap = true;
      await new Promise((r) => setTimeout(r, name === "one" ? 40 : 1));
      inflight--;
      trace.push(`end ${name}`);
      return { kind: "ok" };
    };
    await s.relay.onRows([row("m2", { content: "two", session_id: "s", created_at: 2 }), row("m1", { content: "one", session_id: "s", created_at: 1 })]);
    expect(trace).toEqual(["start one", "end one", "start two", "end two"]);
    expect(overlap).toBe(false);
    expect(s.statuses()).toEqual(["m1:delivered", "m2:delivered"]);
  });

  test("equal timestamps keep the server's own order", async () => {
    const s = setup();
    await s.relay.onRows([row("a", { content: "a", session_id: "s", created_at: 5 }), row("b", { content: "b", session_id: "s", created_at: 5 })]);
    expect(s.delivered.map((d) => d.text.split("\n")[1])).toEqual(["a", "b"]);
  });

  test("a blocked first row holds the second, and both go once it clears", async () => {
    let blocked = true;
    const s = setup({ deliver: (_t, text) => (blocked && text.includes("one") ? { kind: "blocked", reason: "dialog" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1", { content: "one", session_id: "s", created_at: 1 }), row("m2", { content: "two", session_id: "s", created_at: 2 })]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statusCalls()).toEqual([]);
    blocked = false;
    await s.relay.tick();
    expect(s.delivered.map((d) => d.text.split("\n")[1])).toEqual(["one", "one", "two"]);
    expect(s.statuses()).toEqual(["m1:delivered", "m2:delivered"]);
  });

  test("an uncertain first row also holds the second until a later pass", async () => {
    let uncertain = true;
    const s = setup({ deliver: (_t, text) => (uncertain && text.includes("one") ? { kind: "uncertain", reason: "timeout" } : { kind: "ok" }) });
    await s.relay.onRows([row("m1", { content: "one", session_id: "s", created_at: 1 }), row("m2", { content: "two", session_id: "s", created_at: 2 })]);
    expect(s.delivered).toHaveLength(1);
    expect(s.statuses()).toEqual(["m1:failed"]);
    uncertain = false;
    await s.relay.tick();
    expect(s.statuses()).toEqual(["m1:failed", "m2:delivered"]);
  });

  test("a control row ahead of a message settles and does not hold it", async () => {
    const control = JSON.stringify({ __cc_poll: true, keys: ["Enter"] });
    const s = setup();
    await s.relay.onRows([row("c", { content: control, session_id: "s", created_at: 1 }), row("m", { content: "go", session_id: "s", created_at: 2 })]);
    expect(s.statuses()).toEqual(["c:undeliverable", "m:delivered"]);
  });

  test("different sessions run in parallel", async () => {
    let inflight = 0;
    let peak = 0;
    const s = setup();
    (s.relay as any).deps.adapter.deliver = async () => {
      peak = Math.max(peak, ++inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return { kind: "ok" };
    };
    await s.relay.onRows([row("a", { session_id: "sa" }), row("b", { session_id: "sb" }), row("c", { session_id: "sc" })]);
    expect(peak).toBe(3);
  });

  test("a blocked session does not hold another", async () => {
    const s = setup({ deliver: (_t, text) => (text.includes("body-a") ? { kind: "blocked", reason: "dialog" } : { kind: "ok" }) });
    await s.relay.onRows([row("a", { session_id: "sa" }), row("b", { session_id: "sb" })]);
    expect(s.statuses()).toEqual(["b:delivered"]);
  });
});

describe("what reaches a herdr pane", () => {
  test("terminal escapes and control characters are stripped before the wrapper, newlines and tabs survive", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { content: "a\x1b[201~\nrm -rf\x1b[200~b\x07\tc\x7f\x00d\x1b[31mred" })]);
    expect(s.delivered[0].text).toBe("<<<<<<\na\nrm -rfb\tcd[31mred\n>>>>>>");
  });

  test("paseo gets the text as written", async () => {
    const s = setup();
    await s.relay.onRows([row("m1", { content: "a\x1b[201~b", delivery_target: PASEO })]);
    expect(s.delivered[0].text).toBe("<<<<<<\na\x1b[201~b\n>>>>>>");
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
