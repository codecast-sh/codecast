import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { computeInboxSessions, computeSessionsLiveness, splitInboxList, splitInboxLiveness, compactInboxList } from "./conversations";
import { INBOX_WINDOW_CAPS, inboxEpoch } from "@codecast/shared/contracts";
import { cacheRows, rebuildRows, type SplitCache } from "@codecast/shared/contracts/inboxSplit";
import { expandNulls } from "@codecast/shared/contracts/inboxCompact";
import { makeFakeDb } from "./testDb";

// A full recent window lets the next row in at its oldest edge whenever a row
// leaves it (a stash, a kill). The client never held that row, so a cold-hash
// split could not be rebuilt and every client refetched the whole list
// (689KB on the rig) after every such mutation. The window's oldest rows now
// ship whole, so the push alone rebuilds.

const ME = "users_me";
const MIN = 60 * 1000;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const CAP = INBOX_WINDOW_CAPS.recent;

const conv = (i: number, overrides: Record<string, any> = {}) => ({
  _id: `conversations_${i}`, user_id: ME, status: "active", title: `Session ${i}`,
  updated_at: EPOCH - 60 * MIN - i * MIN, started_at: EPOCH - 120 * MIN - i * MIN,
  message_count: 4, last_message_role: "assistant", ...overrides,
});

function db(convs: any[]) {
  return makeFakeDb({ users: [{ _id: ME, name: "Me", email: "me@example.com" }], session_owners: [], managed_sessions: [], messages: [], session_decisions: [], conversations: convs });
}
const OPTS = { includeLiveness: false, fastFieldsInOverlay: true, splitHot: true } as const;

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { nowSpy.mockRestore(); });

describe("split inbox list at a full window's edge", () => {
  test("a row leaving a full window lets in a row the push already carries whole", async () => {
    const convs = Array.from({ length: CAP + 3 }, (_, i) => conv(i));
    const before = splitInboxList(await computeInboxSessions({ db: db(convs) } as any, ME as any, OPTS));
    const cache: SplitCache<any> = new Map();
    const firstWhole = await computeInboxSessions({ db: db(convs) } as any, ME as any, { includeLiveness: false, fastFieldsInOverlay: true });
    cacheRows(cache, firstWhole.sessions.map((r: any) => [r._id.toString(), r]));
    expect(rebuildRows({ ids: before.ids, hot: before.hot.map((r: any) => [r._id.toString(), r]), cold_hash: before.cold_hash }, cache)).not.toBeNull();

    // Session 0, the newest, is stashed: session CAP (never listed) enters.
    const after = splitInboxList(await computeInboxSessions({ db: db([conv(0, { inbox_stashed_at: EPOCH - MIN }), ...convs.slice(1)]) } as any, ME as any, OPTS));
    expect(after.ids).toContain(`conversations_${CAP}`);
    expect(after.hot.map((r: any) => r._id)).toContain(`conversations_${CAP}`);
    expect(rebuildRows({ ids: after.ids, hot: after.hot.map((r: any) => [r._id.toString(), r]), cold_hash: after.cold_hash }, cache)).not.toBeNull();
  });

  test("the liveness overlay's split rebuilds after a stash and at the window edge", async () => {
    const convs = Array.from({ length: CAP + 3 }, (_, i) => conv(i));
    const cache: SplitCache<any> = new Map();
    cacheRows(cache, Object.entries((await computeSessionsLiveness({ db: db(convs) } as any, ME as any)).liveness));
    const stashed = [conv(0, { inbox_stashed_at: EPOCH - MIN }), ...convs.slice(1)];
    const edge = new Set<string>();
    const after = splitInboxLiveness(await computeSessionsLiveness({ db: db(stashed) } as any, ME as any, undefined, edge), edge);
    if (after.ids.includes(`conversations_${CAP}`)) expect(Object.keys(after.hot)).toContain(`conversations_${CAP}`);
    expect(rebuildRows({ ids: after.ids, hot: Object.entries(after.hot), cold_hash: after.cold_hash }, cache)).not.toBeNull();
  });

  test("the compact form restores the rows the full form carries", async () => {
    const convs = Array.from({ length: 12 }, (_, i) => conv(i, i % 3 ? {} : { updated_at: EPOCH - MIN }));
    const full = splitInboxList(await computeInboxSessions({ db: db(convs) } as any, ME as any, OPTS));
    const compact = compactInboxList(splitInboxList(await computeInboxSessions({ db: db(convs) } as any, ME as any, OPTS)));
    expect(compact.null_keys.length).toBeGreaterThan(0);
    expect(expandNulls(compact.hot, compact.null_keys)).toEqual(JSON.parse(JSON.stringify(full.hot)));
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(full).length);
  });
});
