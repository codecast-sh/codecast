import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

setDefaultTimeout(300_000);
import { _resetChildAuqProbeCacheForTests } from "@codecast/convex/convex/conversations";
import type { SplitCache } from "@codecast/shared/contracts/inboxSplit";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { LIST_INBOX_SESSIONS_ARGS } from "../../hooks/useLiveInboxSessions";
import { rebuildSplitPayload, seedSplitCache, type SplitKind } from "../../hooks/useSplitQuery";
import { GEN_MIN, SERVER_EVENTS, SimServer, advance, installSim, makeRng, seededWorld, uninstallSim } from "./inboxSimHarness";

// The split wire form against the real handlers: at every step of a randomized
// world, the result a replica rebuilds from split pushes must equal the whole
// result the same query returns unsplit. Also the point of the form, measured:
// the bytes a push carries, and how often a replica has to fetch the whole.

beforeEach(() => {
  installSim();
  _resetChildAuqProbeCacheForTests();
});
afterEach(() => uninstallSim());

const bytes = (v: unknown) => JSON.stringify(v).length;
// What the WebSocket does to a result: the server encodes it, the client decodes it.
const wire = (v: any) => jsonToConvex(convexToJson(v as Value)) as any;

describe("inbox split wire form", () => {
  it("rebuilds exactly the whole result, and ships a fraction of it", async () => {
    const feeds: Array<{ kind: SplitKind; name: string; args: Record<string, unknown> }> = [
      { kind: "list", name: "conversations:listInboxSessions", args: LIST_INBOX_SESSIONS_ARGS },
      { kind: "liveness", name: "conversations:sessionsLiveness", args: {} },
    ];
    for (const seed of [41, 42, 43, 44]) {
      installSim();
      _resetChildAuqProbeCacheForTests();
      const server = new SimServer(seededWorld(seed));
      const client = server.clientAs("me");
      const rng = makeRng(seed * 13);
      const events = Object.keys(SERVER_EVENTS);
      const caches = new Map(feeds.map((f) => [f.kind, new Map() as SplitCache<any>]));
      const tally = new Map(feeds.map((f) => [f.kind, { splitBytes: 0, wholeBytes: 0, fetches: 0, steps: 0 }]));
      for (let step = 0; step < 50; step++) {
        const roll = rng();
        if (roll < 0.6) await SERVER_EVENTS[events[Math.floor(rng() * events.length)]](server, rng, step);
        else advance(Math.floor(rng() * 6 * GEN_MIN));
        await server.flush();
        for (const f of feeds) {
          // The server hashed its in-memory rows; the replica holds decoded ones.
          const split = wire(await client.query(f.name, { ...f.args, split: true }));
          const whole = wire(await client.query(f.name, f.args));
          const cache = caches.get(f.kind)!;
          const t = tally.get(f.kind)!;
          let rebuilt = rebuildSplitPayload(f.kind, split, cache);
          if (!rebuilt) {
            t.fetches++;
            seedSplitCache(f.kind, whole, cache);
            rebuilt = rebuildSplitPayload(f.kind, split, cache);
          }
          expect(rebuilt).toEqual(whole);
          t.steps++;
          t.splitBytes += bytes(split);
          t.wholeBytes += bytes(whole);
        }
      }
      for (const [kind, t] of tally) {
        console.log(`seed ${seed} ${kind}: split ${(t.splitBytes / t.wholeBytes * 100).toFixed(0)}% of whole bytes, whole fetched ${t.fetches}/${t.steps} steps`);
        expect(t.splitBytes).toBeLessThan(t.wholeBytes);
      }
      uninstallSim();
    }
  });
});
