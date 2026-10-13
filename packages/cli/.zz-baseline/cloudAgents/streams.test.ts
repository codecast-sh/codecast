import { describe, expect, test } from "bun:test";
import { CLOUD_AGENT_PROVIDERS } from "@codecast/shared/contracts";
import { CloudAgentStreams, type CloudStreamSpec } from "./streams.js";
import type { CloudAgentHandle } from "./types.js";

type Log = { seen: number[] };

function fakeHandle(log: Log = { seen: [] }) {
  const counts = { save: 0, render: 0, follow: 0 };
  const lines: string[] = [];
  const handle: CloudAgentHandle<Log> = {
    agentId: "a1",
    data: () => log,
    save: () => { counts.save++; },
    notice: async () => undefined,
    scheduleRender: () => { counts.render++; },
    follow: async () => { counts.follow++; },
    log: (m) => lines.push(m),
  };
  return { handle, counts, lines, log };
}

async function* events(...xs: number[]): AsyncGenerator<number> {
  for (const x of xs) yield x;
}

const until = async (check: () => boolean) => {
  const end = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

const spec = (open: CloudStreamSpec<number, Log>["open"], extra: Partial<CloudStreamSpec<number, Log>> = {}): CloudStreamSpec<number, Log> => ({
  open,
  apply: (e, log) => { log.seen.push(e); return e < 0 ? "end" : undefined; },
  ...extra,
});

describe("cloud agent streams", () => {
  test("a stream its own events name (a create): the key resolves at the naming event, what came before lands on attach", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const key = await streams.start(spec(async () => (async function* () { yield 1; yield 7; await gate; yield -1; })()), (e) => (e === 7 ? "a7" : undefined));
    expect(key).toBe("a7");
    expect(streams.has("a7")).toBe(true);
    const { handle, counts, log } = fakeHandle();
    streams.attach("a7", handle);
    expect(log.seen).toEqual([1, 7]);
    release();
    await until(() => counts.follow === 1);
    expect(log.seen).toEqual([1, 7, -1]);
  });

  test("a stream that names nothing in time, says it failed, or ends first rejects the start and is not kept", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    const hang = spec(async (signal) => (async function* () { yield 1; await new Promise((r) => signal.addEventListener("abort", r)); })(), { openMs: 30 });
    await expect(streams.start(hang, () => undefined)).rejects.toThrow("did not start the agent within");
    await expect(streams.start(spec(async () => events(1, 2)), (e) => { if (e === 2) throw new Error("quota"); return undefined; })).rejects.toThrow("quota");
    await expect(streams.start(spec(async () => events(1)), () => undefined)).rejects.toThrow("created no agent");
    await expect(streams.start(spec(async () => { throw new Error("401 refused"); }), () => undefined)).rejects.toThrow("401 refused");
  });

  test("events wait for the mirror's handle; each re-renders, none saves the record on its own; the end re-mirrors", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s = streams.follow("a1", spec(async () => (async function* () { yield 0; yield 1; yield 2; await gate; yield 3; yield -1; yield 99; })()))!;
    await s.opened;
    await until(() => s.delivered === 3);
    const { handle, counts, log } = fakeHandle();
    expect(streams.attach("a1", handle)).toMatchObject({ first: true });
    expect(log.seen).toEqual([0, 1, 2]);
    expect(streams.attach("a1", handle).first).toBe(false);
    release();
    await until(() => counts.follow === 1);
    // Stopped at the event that ended the work; 99 never read.
    expect(log.seen).toEqual([0, 1, 2, 3, -1]);
    expect(counts.save).toBe(0);
    expect(counts.render).toBe(2);
    expect(streams.has("a1")).toBe(false);
  });

  test("a dropped stream reconnects until its work is finished; one that ends without a word holds the next follow off", async () => {
    let now = 1_000;
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.cursor }, { now: () => now });
    const { handle, counts, lines, log } = fakeHandle();
    let opens = 0;
    let finished = false;
    streams.follow("r1", spec(async (_signal, attempt) => {
      opens++;
      if (attempt === 0) return (async function* () { yield 1; throw new Error("socket hang up"); })();
      finished = true;
      return events(2);
    }, { reconnects: 3, finished: () => finished }), { handle });
    await until(() => counts.follow === 1);
    expect(opens).toBe(2);
    expect(log.seen).toEqual([1, 2]);
    expect(lines.some((l) => l.includes("r1 stream dropped: socket hang up"))).toBe(true);

    // A stream that says nothing: the next one for that key waits.
    streams.follow("r2", spec(async () => events()), { handle });
    await until(() => counts.follow === 2);
    expect(streams.follow("r2", spec(async () => events()), { handle })).toBeUndefined();
    now += 60_000;
    expect(streams.follow("r2", spec(async () => events(5)), { handle })).toBeDefined();
    streams.stop();
  });

  test("a turn that ended before the mirror attached ends the follow at attach, though the stream stays open", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    // The Agents API keeps an idle session's stream open with nothing more to say.
    const s = streams.follow("a1", spec((signal) => Promise.resolve((async function* () {
      yield 1;
      yield -1;
      await new Promise((r) => signal.addEventListener("abort", r));
    })()), { quietMs: 60_000 }))!;
    await until(() => s.delivered === 2);
    const { handle, counts, log } = fakeHandle();
    expect(streams.attach("a1", handle).first).toBe(true);
    expect(log.seen).toEqual([1, -1]);
    await until(() => counts.follow === 1);
    expect(s.ended).toBe(true);
    expect(streams.has("a1")).toBe(false);
  });

  test("a stream that never opens ends its follow, so a caller waiting for it to open is let go", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    const s = streams.follow("a1", spec((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }), { openMs: 20 }))!;
    await s.opened;
    await until(() => s.ended);
    const { handle, lines } = fakeHandle();
    // Ended before the mirror came: let go at attach, and nothing is re-mirrored.
    expect(streams.attach("a1", handle)).toEqual({ first: true });
    expect(streams.has("a1")).toBe(false);
    expect(lines).toEqual([]);
  });

  test("stop and drop close a follow without re-mirroring it", async () => {
    const streams = new CloudAgentStreams<number, Log>({ spec: CLOUD_AGENT_PROVIDERS.codex_api });
    const { handle, counts } = fakeHandle();
    const s = streams.follow("a1", spec((signal) => Promise.resolve((async function* () {
      yield 1;
      await new Promise((r) => signal.addEventListener("abort", r));
    })())), { handle })!;
    await until(() => s.delivered === 1);
    streams.drop("a1", s);
    await until(() => s.ended);
    expect(counts.follow).toBe(0);
    expect(streams.has("a1")).toBe(false);
  });
});
