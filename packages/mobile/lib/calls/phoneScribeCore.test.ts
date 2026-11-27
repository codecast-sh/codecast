import { afterEach, describe, expect, test } from "bun:test";
import { createScribeEngine } from "@codecast/web/lib/calls/scribeEngine";
import { createPhoneScribe, type LiveView, type PhoneCallView } from "./phoneScribeCore";

const ME = "u_me";
const WEB = "u_web";

const engines: ReturnType<typeof createScribeEngine>[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop({ keepLive: true });
});

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

/** A phone scribe wired to fakes: the server, the call, the mic tap and the
 *  recognizer all write what happened, in order, to `log`. */
function harness(opts: {
  roomKey?: string;
  openTap?: () => Promise<any>;
  muted?: boolean;
  pacing?: (t: () => readonly string[]) => any;
  startGate?: Promise<void>;
  flush?: () => Promise<void>;
} = {}) {
  const log: string[] = [];
  let clock = 1_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const call: PhoneCallView = {
    phase: "connected",
    roomKey: opts.roomKey ?? "session:c1",
    muted: opts.muted ?? false,
    participants: [{ identity: ME, name: "Me", phone: true, isLocal: true }],
  };
  let onLive: ((l: LiveView | null | undefined) => void) | null = null;
  const sessions: any[] = [];
  const taps: any[] = [];
  const newTap = () => {
    const tap: any = {
      sink: null as any,
      closed: false,
      setSink(s: any) { tap.sink = s; },
      close() { tap.closed = true; log.push("tap closed"); },
      push(n = 480) { tap.sink?.(new Int16Array(n).fill(1000), 48_000); },
    };
    taps.push(tap);
    return tap;
  };
  const convex = {
    mutation: async (_fn: unknown, args: any) => {
      if (args.segments) log.push(`append ${args.segments.map((s: any) => s.text).join("|")}`);
      else if (args.room_key && args.auto) {
        log.push("start");
        await opts.startGate;
        return { transcript_id: "t1", role: "scribe", elapsed_ms: 0 };
      }
      return {};
    },
    action: async () => ({}),
  };
  const engine = createScribeEngine();
  engines.push(engine);
  const scribe = createPhoneScribe({
    engine,
    convex,
    call: () => call,
    meId: () => ME,
    roomFlags: () => undefined,
    watchLive: (_k, cb) => {
      onLive = cb;
      return () => { onLive = null; };
    },
    openTap: opts.openTap ?? (async () => ({ tap: newTap() })),
    openSession: (o) => {
      const s: any = {
        speaking: false,
        fed: [] as Int16Array[],
        events: o.events,
        feedInt16(samples: Int16Array) { s.fed.push(samples); },
        feedPcm16() {},
        async finish() {
          log.push("finish");
          o.events.onUtterance?.({ text: "last words", t0: 0, t1: 1 });
        },
        close() {},
      };
      sessions.push(s);
      return s;
    },
    flush: opts.flush ?? (async () => void log.push("flush")),
    release: async () => void log.push("release"),
    pacing: opts.pacing ?? (() => ({ busy: () => false, addressed: () => false })),
    now: () => clock,
    later: (fn, ms) => void timers.push({ at: clock + ms, fn }),
  });
  engine.subscribe(scribe.reconcile);
  return {
    log, call, sessions, taps, engine, scribe, newTap,
    live(l: LiveView | null) { onLive?.(l); },
    advance(ms: number) {
      clock += ms;
      for (const t of timers.splice(0)) (t.at <= clock ? t.fn() : timers.push(t));
    },
    join(identity: string, phone: boolean) {
      call.participants = [...call.participants, { identity, name: identity, phone, isLocal: false }];
      scribe.reconcile();
    },
  };
}

/** A phone alone in a session's room that has become its scribe. */
async function scribing(opts?: Parameters<typeof harness>[0]) {
  const h = harness(opts);
  h.scribe.reconcile();
  h.live(null);
  await settle();
  return h;
}

describe("phone scribe", () => {
  test("alone in a session's room, it scribes its own mic under its own name", async () => {
    const h = await scribing();
    expect(h.log).toContain("start");
    expect(h.engine.getStatus().trackCount).toBe(1);
    h.sessions[0].events.onUtterance({ text: "hello", t0: 0, t1: 500 });
    await settle();
    expect(h.log).toContain("append hello");
  });

  test("handing over to a web seat: last line, then flush, then release, then the mic closes", async () => {
    const h = await scribing();
    h.log.length = 0;
    h.join(WEB, false);
    // The engine emits during the graceful stop; nothing may cut it short.
    h.scribe.reconcile();
    h.scribe.reconcile();
    await settle();
    expect(h.log).toEqual(["finish", "append last words", "flush", "release", "tap closed"]);
  });

  test("hanging up commits and flushes the last line before the seat is given up", async () => {
    const h = await scribing();
    h.log.length = 0;
    h.call.phase = "idle";
    h.call.roomKey = null;
    h.scribe.reconcile();
    await h.scribe.finishForLeave();
    expect(h.log).toEqual(["finish", "append last words", "flush", "tap closed"]);
  });

  test("a reconnect (LiveKit connecting, same room) keeps the run and its mic", async () => {
    const h = await scribing();
    h.log.length = 0;
    h.call.phase = "connecting";
    h.scribe.reconcile();
    await settle();
    h.call.phase = "connected";
    h.scribe.reconcile();
    await settle();
    expect(h.log).toEqual([]);
    expect(h.engine.getStatus()).toMatchObject({ active: true, trackCount: 1 });
  });

  test("a mic that opens after the call ended is closed, never attached", async () => {
    let resolveTap: (t: any) => void = () => {};
    const h = harness({ openTap: () => new Promise((r) => (resolveTap = r)) });
    h.scribe.reconcile();
    h.live(null);
    await settle();
    h.call.phase = "idle";
    h.call.roomKey = null;
    h.scribe.reconcile();
    const tap = h.newTap();
    resolveTap({ tap });
    await settle();
    expect(tap.closed).toBe(true);
    expect(h.sessions).toHaveLength(0);
    expect(h.engine.getStatus().active).toBe(false);
  });

  test("a mic refused for a moment (backgrounded, interrupted) is asked for again", async () => {
    const answers: any[] = [{ unavailable: "transient" }];
    const h = harness({ openTap: async () => answers.shift() ?? { tap: h.newTap() } });
    h.scribe.reconcile();
    h.live(null);
    await settle();
    expect(h.engine.getStatus()).toMatchObject({ active: true, trackCount: 0 });
    h.advance(60_000);
    await settle();
    expect(h.engine.getStatus().trackCount).toBe(1);
  });

  test("a binary with no mic tap gives the seat back and never asks again", async () => {
    const h = harness({ openTap: async () => ({ unavailable: "permanent" }) });
    h.scribe.reconcile();
    h.live(null);
    await settle();
    expect(h.log).toEqual(["start", "release"]);
    h.live({ startedBy: null });
    h.advance(60_000);
    await settle();
    expect(h.log).toEqual(["start", "release"]);
  });

  test("a recognizer that fails is opened again on the same mic, waiting longer each time", async () => {
    const h = await scribing();
    h.sessions[0].events.onFailed("refused");
    await settle();
    expect(h.engine.getStatus().trackCount).toBe(0);
    h.advance(1_000);
    await settle();
    expect(h.sessions).toHaveLength(2);
    expect(h.taps).toHaveLength(1);
    h.sessions[1].events.onFailed("refused");
    await settle();
    h.advance(1_000);
    await settle();
    expect(h.sessions).toHaveLength(2);
    h.advance(1_000);
    await settle();
    expect(h.sessions).toHaveLength(3);
  });

  test("joined muted: the run is held but the mic stays closed until unmuted", async () => {
    const h = await scribing({ muted: true });
    expect(h.log).toContain("start");
    expect(h.taps).toHaveLength(0);
    h.call.muted = false;
    h.scribe.reconcile();
    await settle();
    expect(h.taps).toHaveLength(1);
    expect(h.engine.getStatus().trackCount).toBe(1);
  });

  test("muting closes the turn with a second of silence, then closes the mic", async () => {
    const h = await scribing();
    h.log.length = 0;
    h.call.muted = true;
    h.scribe.reconcile();
    h.taps[0].push();
    expect(h.sessions[0].fed.at(-1).every((x: number) => x === 0)).toBe(true);
    h.advance(1_000);
    await settle();
    expect(h.log).toEqual(["finish", "append last words", "tap closed"]);
    expect(h.engine.getStatus()).toMatchObject({ active: true, trackCount: 0 });
    h.advance(120_000);
    await settle();
    expect(h.taps).toHaveLength(1);
    h.call.muted = false;
    h.scribe.reconcile();
    await settle();
    expect(h.taps).toHaveLength(2);
    expect(h.engine.getStatus().trackCount).toBe(1);
  });

  test("unmuting within the silent second keeps the mic, and the next mute gets its own second", async () => {
    const h = await scribing();
    h.call.muted = true;
    h.scribe.reconcile();
    h.advance(500);
    h.call.muted = false;
    h.scribe.reconcile();
    h.advance(600);
    await settle();
    expect(h.taps[0].closed).toBe(false);
    h.call.muted = true;
    h.scribe.reconcile();
    await settle();
    expect(h.taps[0].closed).toBe(false);
  });

  test("the run is paced by the agents its routes feed, as web's is", async () => {
    let targets: (() => readonly string[]) | null = null;
    const h = harness({ pacing: (t) => ((targets = t), { busy: () => true, addressed: () => false }) });
    h.scribe.reconcile();
    h.live(null);
    await settle();
    h.live({ startedBy: ME, routes: [{ kind: "session", target: "c1" }, { kind: "doc", target: "d1" }] });
    expect(targets!()).toEqual(["c1"]);
  });

  // A dropped socket reopens a second later; a mute in that second closes the
  // mic. The reopen must not revive a recognizer on the closed mic, or the
  // unmute that follows finds a pipe and never opens the mic again.
  test("a drop, then a mute within the second: unmuting opens the mic again", async () => {
    const h = await scribing();
    h.sessions[0].events.onDropped();
    h.call.muted = true;
    h.scribe.reconcile();
    h.advance(1_000);
    await settle();
    expect(h.taps[0].closed).toBe(true);
    await new Promise((r) => setTimeout(r, 1_100));
    h.call.muted = false;
    h.scribe.reconcile();
    await settle();
    expect(h.taps).toHaveLength(2);
    expect(h.engine.getStatus().trackCount).toBe(1);
    h.taps[1].push();
    expect(h.sessions.at(-1).fed.length).toBeGreaterThan(0);
  });

  test("hanging up mid-start waits for the start and then for the stop it leads to", async () => {
    let open: () => void = () => {};
    const h = harness({
      startGate: new Promise<void>((r) => (open = r)),
      flush: () => new Promise<void>((r) => setTimeout(() => (h.log.push("flush"), r()), 20)),
    });
    h.scribe.reconcile();
    h.live(null);
    await settle();
    h.call.phase = "idle";
    h.call.roomKey = null;
    const leaving = h.scribe.finishForLeave();
    open();
    await leaving;
    expect(h.log).toContain("flush");
    expect(h.engine.getStatus().active).toBe(false);
  });

  test("an offline hang-up gives up on the flush after a few seconds, and the next call scribes", async () => {
    const h = await scribing({ flush: () => new Promise<void>(() => {}) });
    h.call.phase = "idle";
    h.call.roomKey = null;
    let left = false;
    const leaving = h.scribe.finishForLeave().then(() => (left = true));
    await settle();
    expect(left).toBe(false);
    h.advance(3_000);
    await leaving;
    h.log.length = 0;
    h.call.phase = "connected";
    h.call.roomKey = "session:c2";
    h.scribe.reconcile();
    h.live(null);
    await settle();
    expect(h.log).toContain("start");
  });

  test("a recognizer that ran a good while starts the wait over at a second", async () => {
    const h = await scribing();
    h.sessions[0].events.onFailed("refused");
    await settle();
    h.advance(1_000);
    await settle();
    h.sessions[1].events.onFailed("refused");
    await settle();
    h.advance(2_000);
    await settle();
    expect(h.sessions).toHaveLength(3);
    h.advance(61_000);
    h.sessions[2].events.onFailed("refused");
    await settle();
    h.advance(1_000);
    await settle();
    expect(h.sessions).toHaveLength(4);
  });
});
