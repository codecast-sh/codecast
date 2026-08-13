// The viewer half of typing: how keystrokes are batched, ordered and reported.
//
// The relay's own guarantees are tested against a real daemon; what can only be
// pinned here is what the BROWSER does between a keypress and the mutation —
// which is where a dropped or transposed character would come from.

import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { connectRemotePane } from "../terminal/remotePane";
import { hexToBytes } from "@codecast/shared/contracts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Longer than the module's coalescing window, so a flush has certainly run. */
const flushed = () => sleep(90);

/** A convex stand-in that records calls and can be made to answer slowly, so
 *  ordering is tested under the condition that actually breaks it. */
function fakeConvex(opts: { delays?: number[]; reply?: any } = {}) {
  const sent: any[] = [];
  let n = 0;
  return {
    sent,
    client: {
      mutation: async (_fn: any, args: any) => {
        if (args.data !== undefined) {
          const wait = opts.delays?.[n] ?? 0;
          n++;
          if (wait) await sleep(wait);
          sent.push(args.data);
          return opts.reply ?? { ok: true };
        }
        return { ok: true, dispatched: false };
      },
      watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => null }),
    } as any,
  };
}

const errors: string[] = [];
const handlers = { onFrame: () => {}, onError: (m: string) => void errors.push(m) };
const src = (client: any) => ({ convex: client, deviceId: "dev1", target: "cc-x" });
/** Decode everything the fake received back into one byte string. */
const received = (sent: string[]) => sent.flatMap((h) => hexToBytes(h) ?? []);

beforeEach(() => {
  errors.length = 0;
});

let open: Array<{ close: () => void }> = [];
afterEach(() => {
  open.forEach((c) => c.close());
  open = [];
});
const connect = (client: any) => {
  const c = connectRemotePane(src(client), handlers);
  open.push(c);
  return c;
};

describe("remote pane input", () => {
  test("keystrokes in one burst cost a single write", async () => {
    // Typing "ls" must not be two round-trips. At 250ms polling on the far side
    // there is nothing to gain from sending each key on its own.
    const f = fakeConvex();
    const conn = connect(f.client);
    conn.write("l");
    conn.write("s");
    await flushed();
    expect(f.sent.length).toBe(1);
    expect(received(f.sent)).toEqual([0x6c, 0x73]);
  });

  test("order survives a slow first send", async () => {
    // The failure this prevents: two sends in flight at once, the first one
    // slow, and the person's characters arriving transposed. Sends are chained,
    // so the second waits.
    const f = fakeConvex({ delays: [60, 0] });
    const conn = connect(f.client);
    conn.write("A");
    await flushed();
    conn.write("B");
    await sleep(200);
    expect(received(f.sent)).toEqual([0x41, 0x42]);
  });

  test("bytes are encoded exactly, control characters included", async () => {
    const f = fakeConvex();
    const conn = connect(f.client);
    // Escape, Ctrl-C, and an arrow key — the sequences a key-name parser would
    // mangle.
    conn.write("\x1b\x03\x1b[A");
    await flushed();
    expect(received(f.sent)).toEqual([0x1b, 0x03, 0x1b, 0x5b, 0x41]);
  });

  test("nothing is sent when nothing was typed", async () => {
    const f = fakeConvex();
    const conn = connect(f.client);
    conn.write("");
    await flushed();
    expect(f.sent.length).toBe(0);
  });

  test("a refusal is reported, because the keystroke did not land", async () => {
    // Silence here would be the worst outcome: the person sees their character
    // never appear and has no idea whether to retype it.
    const f = fakeConvex({ reply: { ok: false, reason: "no-streamer" } });
    const conn = connect(f.client);
    conn.write("x");
    await flushed();
    expect(errors.some((e) => e.includes("nothing was typed"))).toBe(true);
  });

  test("a full buffer says the machine isn't keeping up", async () => {
    const f = fakeConvex({ reply: { ok: false, reason: "backlog" } });
    const conn = connect(f.client);
    conn.write("x");
    await flushed();
    expect(errors.some((e) => e.includes("keeping up"))).toBe(true);
  });

  test("closing stops further sends", async () => {
    const f = fakeConvex();
    const conn = connect(f.client);
    conn.close();
    conn.write("ignored");
    await flushed();
    expect(f.sent.length).toBe(0);
  });

  test("gaining focus renews at once rather than waiting out the timer", async () => {
    // Focus is what speeds the far loop up; a several-second delay before the
    // keyboard responds would read as the feature being broken.
    const calls: any[] = [];
    const client = {
      mutation: async (_fn: any, args: any) => {
        calls.push(args);
        return { ok: true };
      },
      watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => null }),
    } as any;
    const conn = connect(client);
    await sleep(10);
    const before = calls.length;
    conn.setInteractive(true);
    await sleep(10);
    expect(calls.length).toBe(before + 1);
    expect(calls[calls.length - 1].interactive).toBe(true);
  });

  test("losing focus does not spend a renewal", async () => {
    // Blur only needs to stop CLAIMING focus; the next scheduled renewal
    // carries that, and the far side's TTL expires on its own.
    const calls: any[] = [];
    const client = {
      mutation: async (_fn: any, args: any) => {
        calls.push(args);
        return { ok: true };
      },
      watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => null }),
    } as any;
    const conn = connect(client);
    conn.setInteractive(true);
    await sleep(10);
    const before = calls.length;
    conn.setInteractive(false);
    await sleep(10);
    expect(calls.length).toBe(before);
  });
});
