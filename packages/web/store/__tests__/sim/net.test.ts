import { describe, expect, test } from "bun:test";
import { makeRng } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { HIDDEN_OVERRIDE_SETTLE_MS } from "../../inboxOverlays";
import { DEFAULT_DRAIN_HORIZON_MS, Net, SimNetError, formatOrder, parseOrder, type NetMode } from "./net";

// A world small enough to read: a virtual clock, a write counter and a log of
// what ran, in order.
function rig(opts: { seed?: number; maxDeliveries?: number; maxWrites?: number; onOnline?: (w: string) => void; rng?: () => number } = {}) {
  let t = 1_000;
  let writes = 0;
  const log: string[] = [];
  const net = new Net({
    rng: opts.rng ?? makeRng(opts.seed ?? 1),
    maxDeliveries: opts.maxDeliveries,
    maxWrites: opts.maxWrites,
    writes: () => writes,
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    onOnline: opts.onOnline,
  });
  const put = (channel: string, label: string, extra: { due?: number; producer?: string; run?: () => void | Promise<void> } = {}) =>
    net.enqueue(channel, {
      label,
      due: extra.due,
      producer: extra.producer ?? channel,
      run: async () => {
        log.push(label);
        await extra.run?.();
      },
    });
  return { net, log, put, now: () => t, write: (n = 1) => (writes += n) };
}

// Three channels, three deliveries each, and a delivery that enqueues more
// work when it runs, so the replay covers dynamically produced events too.
function populate(r: ReturnType<typeof rig>): void {
  for (const ch of ["conn:a", "conn:b", "actor:ada"]) {
    for (let i = 1; i <= 3; i++) {
      r.put(ch, `${ch}#${i}`, {
        run: i === 2 ? () => void r.put("repl:a>b", `${ch}->repl`) : undefined,
      });
    }
  }
}

const perChannel = (log: string[], ch: string) => log.filter((l) => l.startsWith(`${ch}#`));

describe("sim net", () => {
  test("a channel is FIFO in every mode", async () => {
    for (const mode of ["scripted", "interleave"] as NetMode[]) {
      for (let seed = 1; seed <= 10; seed++) {
        const r = rig({ seed });
        r.net.mode = mode;
        populate(r);
        await r.net.drain();
        for (const ch of ["conn:a", "conn:b", "actor:ada"]) {
          expect(perChannel(r.log, ch)).toEqual([`${ch}#1`, `${ch}#2`, `${ch}#3`]);
        }
      }
    }
  });

  test("scripted runs the lexicographically first ready channel", async () => {
    const r = rig();
    r.put("conn:b", "b1");
    r.put("actor:ada", "x1");
    r.put("conn:a", "a1");
    r.put("conn:a", "a2");
    await r.net.drain();
    expect(r.log).toEqual(["x1", "a1", "a2", "b1"]);
  });

  test("interleave permutes only across channels, reproducibly per seed", async () => {
    const orders = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const runs: string[][] = [];
      for (let k = 0; k < 2; k++) {
        const r = rig({ seed });
        r.net.mode = "interleave";
        populate(r);
        await r.net.drain();
        for (const ch of ["conn:a", "conn:b", "actor:ada"]) expect(perChannel(r.log, ch)).toHaveLength(3);
        runs.push(r.log);
      }
      expect(runs[1]).toEqual(runs[0]);
      orders.add(runs[0].join(","));
    }
    expect(orders.size).toBeGreaterThan(5);
  });

  test("an order replay reproduces an interleave run exactly and draws no randomness", async () => {
    const rec = rig({ seed: 7 });
    rec.net.mode = "interleave";
    populate(rec);
    await rec.net.drain();
    const line = formatOrder(rec.net.orderSoFar());
    expect(parseOrder(line)).toEqual(rec.net.orderSoFar());

    const replay = rig({
      rng: () => {
        throw new Error("order replay must not draw from the rng");
      },
    });
    replay.net.mode = { order: parseOrder(line) };
    populate(replay);
    await replay.net.drain();
    expect(replay.log).toEqual(rec.log);
    expect(replay.net.orderSoFar()).toEqual(rec.net.orderSoFar());
  });

  test("an order replay names the step where the run diverges", async () => {
    const r = rig();
    r.net.mode = { order: ["conn:b", "conn:c"] };
    r.put("conn:a", "a1");
    r.put("conn:b", "b1");
    r.put("conn:c", "c1", { due: r.now() + 1_000 });
    await r.net.step();
    const err = await r.net.step().catch((e) => e);
    expect(err).toBeInstanceOf(SimNetError);
    expect(err.code).toBe("order-mismatch");
    expect(err.message).toBe('sim net: order replay diverged at delivery 2 (order entry 2): expected "conn:c" but it is not ready; ready: conn:a');
  });

  test("an order replay continues as scripted once its list is used up", async () => {
    const r = rig();
    r.net.mode = { order: ["conn:b"] };
    r.put("conn:a", "a1");
    r.put("conn:b", "b1");
    r.put("conn:c", "c1");
    await r.net.drain();
    expect(r.log).toEqual(["b1", "a1", "c1"]);
  });

  test("a lagged channel delivers nothing until released", async () => {
    const r = rig();
    r.net.lag("live:a:messages");
    r.put("live:a:messages", "tail");
    r.put("conn:a", "req");
    await r.net.drain();
    expect(r.log).toEqual(["req"]);
    r.net.release("live:a:messages");
    await r.net.drain();
    expect(r.log).toEqual(["req", "tail"]);
  });

  test("an offline window holds its conn: and live: events, and online() hands the window back", async () => {
    const onlined: string[] = [];
    const r = rig({ onOnline: (w) => onlined.push(w) });
    r.net.offline("a");
    r.put("conn:a", "a-req");
    r.put("live:a:inbox", "a-push");
    r.put("conn:ab", "ab-req");
    r.put("repl:a>b", "repl");
    r.put("timer:a", "timer");
    await r.net.drain();
    expect(r.log).toEqual(["ab-req", "repl", "timer"]);
    r.net.online("b");
    expect(onlined).toEqual([]);
    r.net.online("a");
    expect(onlined).toEqual(["a"]);
    await r.net.drain();
    expect(r.log).toEqual(["ab-req", "repl", "timer", "a-req", "a-push"]);
  });

  test("a dirty live channel coalesces to one pending delivery that recomputes when delivered", async () => {
    const r = rig();
    let version = 0;
    const seen: number[] = [];
    r.net.mountLive("live:a:inbox", { run: () => void seen.push(version) });
    r.net.markDirty("live:a:inbox");
    version = 1;
    r.net.markDirty("live:a:inbox");
    version = 2;
    r.net.markDirty("live:a:inbox");
    await r.net.drain();
    expect(seen).toEqual([2]);
    expect(r.net.deliveries).toBe(1);

    // A delivery that writes marks every mounted live channel dirty once.
    r.net.mountLive("live:b:inbox", { run: () => void seen.push(-version) });
    r.put("conn:a", "mutation", { run: () => void r.write(3) });
    await r.net.drain();
    expect(seen).toEqual([2, 2, -2]);
    // A write made outside any delivery (a test seeding the server) is noticed too.
    r.write();
    await r.net.drain();
    expect(seen).toEqual([2, 2, -2, 2, -2]);
    expect(r.net.writesSpent).toBe(3);

    r.net.markDirty("live:b:inbox");
    r.net.unmountLive("live:b:inbox");
    await r.net.drain();
    expect(seen).toEqual([2, 2, -2, 2, -2]);
    expect(() => r.net.markDirty("live:b:inbox")).toThrow(/no mounted live query/);
  });

  test("drain moves the clock to the next due event and stops at the horizon", async () => {
    const r = rig();
    const t0 = r.now();
    r.put("timer:a", "late", { due: t0 + 10_000 });
    r.put("timer:a", "soon", { due: t0 + 1_000 });
    r.put("sched", "job", { due: t0 + 4_000 });
    r.put("conn:a", "now");
    await r.net.drain({ horizonMs: 5_000 });
    expect(r.log).toEqual(["now", "soon", "job"]);
    expect(r.now()).toBe(t0 + 4_000);
    // Each drain's horizon starts from its own start: 4s + 5s still falls short of 10s.
    await r.net.drain({ horizonMs: 5_000 });
    expect(r.log).toEqual(["now", "soon", "job"]);
    expect(r.now()).toBe(t0 + 4_000);
    await r.net.drain({ horizonMs: 6_000 });
    expect(r.log).toEqual(["now", "soon", "job", "late"]);
    expect(r.now()).toBe(t0 + 10_000);
    expect(DEFAULT_DRAIN_HORIZON_MS).toBe(2 * HIDDEN_OVERRIDE_SETTLE_MS);
  });

  test("a lagged or offline event never pulls the clock forward", async () => {
    const r = rig();
    const t0 = r.now();
    r.net.lag("timer:a");
    r.net.offline("b");
    r.put("timer:a", "lagged", { due: t0 + 1_000 });
    r.put("conn:b", "held", { due: t0 + 2_000 });
    await r.net.drain();
    expect(r.log).toEqual([]);
    expect(r.now()).toBe(t0);
  });

  test("cancel removes a queued delivery, as clearTimeout does", async () => {
    const r = rig();
    const seq = r.put("timer:a", "cleared", { due: r.now() + 100 });
    r.put("timer:a", "kept", { due: r.now() + 200 });
    expect(r.net.cancel(seq)).toBe(true);
    expect(r.net.cancel(seq)).toBe(false);
    await r.net.drain();
    expect(r.log).toEqual(["kept"]);
  });

  test("a run that never quiesces fails naming the top producers", async () => {
    const r = rig({ maxDeliveries: 50 });
    // Two agents mentioning each other forever, plus one unrelated delivery.
    const pong = (who: string, other: string) => {
      r.put(`actor:${who}`, who, { producer: `${who}-pong`, run: () => void pong(other, who) });
    };
    pong("ada", "bo");
    r.put("a:once", "once", { producer: "once" });
    const err = await r.net.drain().catch((e) => e);
    expect(err).toBeInstanceOf(SimNetError);
    expect(err.code).toBe("no-quiescence");
    expect(err.message).toBe("sim net: did not quiesce after 50 deliveries; top producers: ada-pong (25), bo-pong (24), once (1)");
    expect(r.net.producers().get("ada-pong")).toBe(25);
  });

  test("the write budget fails at the delivery that crosses it", async () => {
    const r = rig({ maxWrites: 10 });
    r.write(500); // genesis: writes outside a delivery are not budgeted
    for (let i = 1; i <= 4; i++) r.put("actor:ada", `w${i}`, { producer: "ada", run: () => void r.write(3) });
    const err = await r.net.drain().catch((e) => e);
    expect(err).toBeInstanceOf(SimNetError);
    expect(err.code).toBe("write-budget");
    expect(err.message).toBe('sim net: 12 server writes exceeded the budget of 10 at delivery 4 ("w4" on actor:ada); top writers: ada (12)');
  });

  test("the ring keeps the last 64 deliveries", async () => {
    const r = rig();
    for (let i = 1; i <= 70; i++) r.put("conn:a", `d${i}`);
    await r.net.drain();
    expect(r.net.ring).toHaveLength(64);
    expect(r.net.ring[0].label).toBe("d7");
    expect(r.net.ring[63].label).toBe("d70");
    expect(r.net.orderSoFar()).toHaveLength(70);
  });

  test("enqueue refuses a delivery addressed to another channel", () => {
    const r = rig();
    expect(() => r.net.enqueue("conn:a", { channel: "conn:b", label: "x", producer: "x", run: () => {} })).toThrow(/given a delivery for "conn:b"/);
  });
});
